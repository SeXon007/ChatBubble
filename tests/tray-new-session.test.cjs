const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { mkdtemp, readFile } = require('node:fs/promises');
const path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const ts = require('typescript');
const runtime = process.env.CHATBUBBLE_TEST_RUNTIME || path.resolve(__dirname, '../dist');
const { initialState, newSession } = require(path.join(runtime, 'model'));
const { ChatStorage } = require(path.join(runtime, 'chat-storage'));
const { ChatController } = require(path.join(runtime, 'chat'));
const conversation_source_1 = require(path.join(runtime, 'conversation-source'));
const source = ts.createSourceFile('main.js', fs.readFileSync(path.join(runtime, 'main.js'), 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);

function execute(context, name) {
  const fn = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(fn, name); vm.runInContext(fn.getText(source), context);
}

test('tray menu has new conversation/settings/quit and tray clicks only toggle pet visibility', () => {
  const callbacks = {}, menus = [], effects = [];
  let newConversations = 0;
  const context = vm.createContext({
    mode: 'collapsed',
    tray: { on: (event, fn) => { callbacks[event] = fn; }, setContextMenu: menu => menus.push(menu) },
    electron_1: { Menu: { buildFromTemplate: menu => menu }, app: { quit() {} } },
    setMode: next => { effects.push(next); context.mode = next; }, startNew: () => { newConversations++; }, openSettings: () => {}, app: { quit() {} }
  });
  function visit(node) {
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) &&
        ['tray.on', 'tray.setContextMenu'].includes(node.expression.expression.getText(source))) vm.runInContext(node.getText(source), context);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.deepEqual(Array.from(menus[0], item => item.label), ['开始新对话', '设置', '退出']);
  menus[0][0].click(); assert.equal(newConversations, 1); assert.deepEqual(effects, []);
  for (const current of ['collapsed', 'expanded', 'hidden']) {
    context.mode = current; callbacks.click();
    assert.equal(context.mode, current === 'hidden' ? 'collapsed' : 'hidden');
  }
  assert.ok(!effects.includes('expanded'), 'Tray cannot expand chat or trigger capture');
});

async function fixture(mode = 'collapsed') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'chatbubble-new-session-'));
  const state = initialState(), store = await ChatStorage.open(dir), dialogs = [], modes = [];
  state.session.draft = '未发送草稿';
  state.session.codex = { threadId: newSession().id, home: dir, cwd: dir };
  state.session.messages.push({ id: 'old', role: 'user', content: '需要保留的旧对话', status: 'complete', time: '', requestId: 'old' });
  let clears = 0;
  const chat = new ChatController(state, store, () => '', () => {});
  const dialog = { showMessageBox: async (_window, options) => { dialogs.push(options); return { response: 1 }; } };
  const context = vm.createContext({ state, store, chat, mode, configuring: false, checking: false, closing: false, model_1: { newSession }, conversation_source_1,
    window: {}, broadcast: () => {}, screenCapture: { clear: () => clears++ },
    setMode: next => { modes.push(next); context.mode = next; },
    electron_1: { dialog }
  });
  execute(context, 'startNew');
  await chat.persist();
  return { dir, state, store, chat, context, dialogs, modes, clears: () => clears };
}

test('new conversation archives the full previous session without confirmation or opening chat', async () => {
  for (const mode of ['collapsed', 'hidden', 'expanded']) {
    const f = await fixture(mode), previous = structuredClone(f.state.session), settings = structuredClone(f.state.settings);
    await f.context.startNew();
    assert.deepEqual(f.dialogs, [], 'Successful new conversation has no dialogs');
    assert.equal(f.context.mode, mode); assert.deepEqual(f.modes, []);
    assert.notEqual(f.state.session.id, previous.id);
    assert.equal(f.state.session.draft, ''); assert.equal(f.state.session.codex, undefined);
    assert.deepEqual(f.state.session.messages, []); assert.deepEqual(f.state.settings, settings);
    const archives = (await f.store.list()).items;
    assert.equal(archives.length, 1); assert.deepEqual(await f.store.readArchive(archives[0].id), previous);
    assert.deepEqual(JSON.parse(await readFile(path.join(f.dir, 'state.json'), 'utf8')).session, f.state.session);
    assert.equal(f.clears(), 1); assert.equal(f.context.configuring, false);
  }
});

test('new conversation stops an active response and ignores a duplicate click during the switch', async () => {
  const f = await fixture();
  Object.assign(f.state.settings, { provider: 'api', baseUrl: 'https://example.test', model: 'fixture' });
  f.state.session.source = conversation_source_1.conversationSource(f.state.settings);
  let started;
  const generating = new Promise(resolve => { started = resolve; });
  const chat = new ChatController(f.state, f.store, () => '', () => {}, undefined, async options => {
    options.onChunk('保留部分回复'); started();
    await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  f.context.chat = chat;
  await chat.send('中断测试'); await generating;
  const previousId = f.state.session.id;
  await Promise.all([f.context.startNew(), f.context.startNew()]);
  assert.equal(chat.busy, false); assert.deepEqual(f.dialogs, []);
  const archives = (await f.store.list()).items;
  assert.equal(archives.length, 1);
  const archived = await f.store.readArchive(archives[0].id);
  assert.equal(archived.id, previousId);
  assert.equal(archived.messages.at(-1).content, '保留部分回复');
  assert.equal(archived.messages.at(-1).status, 'cancelled');
});

test('failed archive/save preserves the previous conversation and never opens chat', async () => {
  for (const failure of ['archive', 'new-save']) {
    const f = await fixture(), previous = f.state.session;
    if (failure === 'archive') f.context.store = { archive: async () => { throw Error('disk'); } };
    else {
      const persist = f.chat.persist.bind(f.chat); let saves = 0;
      f.chat.persist = async () => { if (++saves === 2) throw Error('disk'); return persist(); };
    }
    await f.context.startNew();
    assert.equal(f.state.session, previous); assert.deepEqual(f.modes, []);
    assert.equal(f.dialogs.length, 1); assert.equal(f.dialogs[0].type, 'error');
    assert.equal(f.context.configuring, false);
  }
});
