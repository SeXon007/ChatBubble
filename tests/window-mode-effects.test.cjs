const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

test('production open/close never captures or clears a draft attachment; collapsed pet remains non-activating', () => {
  // Test the actual main-process function with window/capture spies.
  const source = ts.createSourceFile('main.ts', fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8'), ts.ScriptTarget.ES2022, true);
  const transition = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'setMode');
  assert.ok(transition);
  const events = [];
  const context = {
    mode: 'collapsed', modeApplied: false, state: { settings: { provider: 'codex-cli', screenCaptureEnabled: true }, session: {} },
    smoke: false, restartMode: undefined, historyRefresh: undefined,
    screenCapture: { expand: () => events.push('capture'), clear: () => events.push('clear') },
    window: {
      setFocusable: value => events.push(`focusable:${value}`),
      webContents: { send: (_channel, mode) => events.push(`mode:${mode}`) },
      show: () => events.push('show'), focus: () => events.push('focus'),
      hide: () => events.push('hide'), isVisible: () => true, showInactive: () => events.push('inactive')
    }
  };
  vm.createContext(context);
  vm.runInContext(ts.transpileModule(transition.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  context.setMode('collapsed');
  assert.deepEqual(events, ['focusable:false', 'mode:collapsed']);
  events.length = 0;
  context.setMode('expanded');
  assert.deepEqual(events, ['focusable:true', 'mode:expanded', 'show', 'focus']);
  events.length = 0;
  context.setMode('expanded'); assert.deepEqual(events, [], 'Already applied modes do not refocus, notify or capture again');
  context.setMode('collapsed'); context.state.settings.screenCaptureEnabled = false;
  events.length = 0; context.setMode('expanded');
  assert.ok(!events.includes('capture')); assert.ok(events.includes('focus'));
  events.length = 0; context.setMode('hidden');
  assert.deepEqual(events, ['focusable:false', 'mode:hidden', 'hide']);
});

test('manual capture validates provider/mode/operations and returns no attachment path to the renderer', async () => {
  const source = ts.createSourceFile('main.ts', fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8'), ts.ScriptTarget.ES2022, true);
  const request = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'requestScreenCapture');
  let calls = 0;
  const context = { captureCapability: require('../dist/api-capabilities').captureCapability, state: { settings: { provider: 'codex-cli', screenCaptureEnabled: false } }, mode: 'expanded', smoke: false, restartMode: undefined,
    configuring: false, closing: false, chat: { busy: false }, screenCapture: { status: 'empty', request: async () => { calls++; return { image: { file: 'private-path' } }; }, clear: () => {} } };
  vm.createContext(context); vm.runInContext(ts.transpileModule(request.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  assert.deepEqual(JSON.parse(JSON.stringify(await context.requestScreenCapture())), { ok: true, error: '' }); assert.equal(calls, 1);
  for (const provider of ['api', 'claude-cli']) { context.state.settings.provider = provider; assert.equal((await context.requestScreenCapture()).ok, false); }
  context.state.settings.provider = 'codex-cli';
  for (const key of ['configuring', 'closing', 'smoke']) { context[key] = true; assert.equal((await context.requestScreenCapture()).ok, false); context[key] = false; }
  context.chat.busy = true; assert.equal((await context.requestScreenCapture()).ok, false); context.chat.busy = false;
  context.screenCapture.status = 'capturing'; assert.equal((await context.requestScreenCapture()).ok, false); context.screenCapture.status = 'empty';
  for (const mode of ['collapsed', 'hidden']) { context.mode = mode; assert.equal((await context.requestScreenCapture()).ok, false); }
  assert.equal(calls, 1);
});
