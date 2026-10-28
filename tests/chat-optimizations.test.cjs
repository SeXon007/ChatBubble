const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), vm = require('node:vm'), ts = require('typescript');
const { initialState, isState } = require('../dist/model');
const { persistSettingsPatch, mergeSettings } = require('../dist/settings');
const { ChatStorage } = require('../dist/chat-storage');

test('message height accepts legacy files, persists on reopening and rolls back failed writes', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chatbubble-height-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await ChatStorage.open(directory), state = initialState(), session = state.session;
  assert.equal(state.settings.messageHeight, 380);
  delete state.settings.messageHeight; assert.equal(isState(state), true);
  for (const height of [120, 380, 800]) {
    await persistSettingsPatch(state, { messageHeight: height }, () => store.save(state));
    const reopened = await ChatStorage.open(directory);
    assert.equal((await reopened.load()).value.settings.messageHeight, height);
    assert.equal(state.session, session);
  }
  for (const height of [119, 801, 380.5, NaN, Infinity, '380', null, true]) {
    assert.throws(() => mergeSettings(state.settings, { messageHeight: height }));
    assert.equal(isState({ ...state, settings: { ...state.settings, messageHeight: height } }), false);
  }
  await assert.rejects(persistSettingsPatch(state, { messageHeight: 120 }, async () => { throw Error('disk full'); }));
  assert.equal(state.settings.messageHeight, 800);
});

async function captureFixture() {
  const source = ts.createSourceFile('main.js', await fs.readFile(path.join(__dirname, '../dist/main.js'), 'utf8'), ts.ScriptTarget.ES2022, true);
  const fn = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'requestScreenCapture');
  const writes = [], png = Buffer.from('synthetic image'), image = { isEmpty: () => false, toPNG: () => png };
  const context = { Blob, Uint8Array, state: initialState(), mode: 'expanded', smoke: false, restartMode: undefined, configuring: false, closing: false,
    chat: { busy: false }, api_capabilities_1: { captureCapability: () => ({ available: true }) },
    screenCapture: { status: 'empty', request: async () => { context.screenCapture.status = 'ready'; return { image: { file: 'fixture.png' } }; }, clear: () => { context.screenCapture.status = 'empty'; } },
    electron_1: { nativeImage: { createFromPath: file => { assert.equal(file, 'fixture.png'); return image; } }, ClipboardItem: class { constructor(data) { this.data = data; } }, clipboard: { write: async items => writes.push(items) } }
  };
  vm.createContext(context); vm.runInContext(fn.getText(source), context);
  return { context, writes, image, png };
}

test('successful manual captures and retakes copy the actual image, without copying on capture failure', async () => {
  const { context: c, writes, png } = await captureFixture();
  assert.equal((await c.requestScreenCapture()).ok, true);
  assert.deepEqual(Buffer.from(await writes[0][0].data['image/png'].arrayBuffer()), png);
  assert.equal((await c.requestScreenCapture()).ok, true); assert.equal(writes.length, 2);
  c.screenCapture.request = async () => { c.screenCapture.status = 'empty'; return { error: 'unavailable' }; };
  const failed = await c.requestScreenCapture(); assert.equal(failed.ok, false); assert.equal(writes.length, 2);
});

test('clipboard failures retain the ready attachment and return a specific nonfatal message', async () => {
  for (const failure of ['empty image', 'clipboard busy']) {
    const { context: c, image } = await captureFixture();
    if (failure === 'empty image') image.isEmpty = () => true;
    else c.electron_1.clipboard.write = async () => { throw Error('busy'); };
    const result = await c.requestScreenCapture();
    assert.equal(result.ok, true); assert.match(result.error, /未能复制到剪贴板/); assert.equal(c.screenCapture.status, 'ready');
  }
});

test('cancelled or late captures cannot overwrite the clipboard; blocked requests never copy', async () => {
  const { context: c, writes } = await captureFixture();
  c.screenCapture.request = async () => ({ image: { file: 'fixture.png' } });
  await c.requestScreenCapture(); assert.equal(writes.length, 0);
  c.chat.busy = true; assert.equal((await c.requestScreenCapture()).ok, false); assert.equal(writes.length, 0);
});
