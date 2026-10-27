const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const ts = require('typescript');
const clients = require('../dist/desktop-client');

test('API desktop entry follows the saved endpoint and cannot mistake retained Codex history for the active provider', () => {
  for (const [baseUrl, expected] of [
    ['https://api.deepseek.com/v1', 'deepseek'], ['https://api.moonshot.cn/v1', 'kimi'],
    ['https://open.bigmodel.cn/api/paas/v4', 'zhipu'], ['https://api.deepseek.com.evil.test', undefined]
  ]) assert.equal(clients.apiDesktopClient({ provider: 'api', baseUrl }), expected);
  assert.equal(clients.apiDesktopClient({ provider: 'codex-cli', baseUrl: 'https://api.deepseek.com' }), undefined);
});

test('client discovery ignores stale shortcuts and shell/script targets; launches no shortcut arguments', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatbubble-client-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'Kimi.exe'); await fs.writeFile(target, 'synthetic executable, never run');
  const roots = [path.join(root, 'first'), path.join(root, 'second')];
  const read = file => ({ target: file.startsWith(roots[0]) ? path.join(root, 'cmd.exe') : target, args: 'ignored fixture argument' });
  assert.equal(await clients.locateDesktopClient('kimi', roots, read), target);
  assert.equal(await clients.locateDesktopClient('kimi', roots, () => ({ target: path.join(root, 'missing/Kimi.exe') })), undefined);
  assert.equal(await clients.locateDesktopClient('kimi', roots, () => ({ target: 'Kimi.exe' })), undefined);
  await fs.mkdir(path.join(root, 'directory/Kimi.exe'), { recursive: true });
  assert.equal(await clients.locateDesktopClient('kimi', roots, () => ({ target: path.join(root, 'directory/Kimi.exe') })), undefined);
});

test('production launch handlers reject stale providers and open only the detected client without exporting history', async () => {
  const source = ts.createSourceFile('main.ts', await fs.readFile(path.join(__dirname, '../src/main.ts'), 'utf8'), ts.ScriptTarget.ES2022, true);
  const handlers = new Map();
  const state = { settings: { provider: 'api', baseUrl: 'https://api.deepseek.com' }, session: { codex: { threadId: 'old-native-id' } } };
  const opened = [], target = path.join(os.tmpdir(), 'DeepSeek Harness.exe'); let detect = async () => target;
  const context = { ...clients, state, desktopShortcutRoots: () => [], validate: () => {},
    locateDesktopClient: (...args) => detect(...args), configuring: false, closing: false, checking: false,
    chat: { stop: () => { throw Error('must not stop chat'); }, persist: () => { throw Error('must not write history'); } },
    shell: { readShortcutLink: () => {}, openPath: async file => { opened.push(file); return ''; }, openExternal: () => { throw Error('must not open Codex'); } },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) } };
  vm.createContext(context);
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'ipcMain.handle' && ['codex:open', 'client:status', 'client:open'].includes(node.arguments[0]?.text))
      vm.runInContext(ts.transpileModule(node.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal((await handlers.get('codex:open')({})).ok, false);
  assert.equal((await handlers.get('client:open')({}, 'https://api.moonshot.cn/v1')).ok, false);
  assert.equal((await handlers.get('client:open')({}, state.settings.baseUrl)).ok, true);
  assert.deepEqual(opened, [target]);
  detect = async () => undefined;
  assert.match((await handlers.get('client:status')({})).notice, /未检测到可用的 DeepSeek Harness/);
  assert.equal((await handlers.get('client:open')({}, state.settings.baseUrl)).ok, false);
  detect = async () => { state.settings.provider = 'codex-cli'; return target; };
  assert.equal((await handlers.get('client:open')({}, state.settings.baseUrl)).ok, false);
  assert.equal(opened.length, 1);
});
