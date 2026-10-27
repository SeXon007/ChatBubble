const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const ts = require('typescript');
const { initialState, isState } = require('../dist/model');
const { conversationSource, recordedSource, prepareConversation } = require('../dist/conversation-source');
const { persistSettingsPatch, mergeSettings } = require('../dist/settings');
const { ChatStorage } = require('../dist/chat-storage');
const { ChatController } = require('../dist/chat');
const { streamCli } = require('../dist/cli');

const codexId = '11111111-1111-4111-8111-111111111111';
function stateFor(provider = 'api', baseUrl = 'https://api.deepseek.com') {
  const state = initialState(); Object.assign(state.settings, { provider, baseUrl, model: 'fixture' });
  state.session.source = conversationSource(state.settings);
  state.session.draft = '保留草稿';
  state.session.messages.push({ id: 'user', role: 'user', content: '仅属于此来源', status: 'complete', requestId: 'r', time: '' });
  return state;
}
async function storageFor(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatbubble-source-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return ChatStorage.open(root);
}

test('source groups official service aliases and models, but isolates custom endpoints', () => {
  for (const baseUrl of ['https://api.deepseek.com', 'https://api.deepseek.com/v1/', 'https://api.deepseek.com/v1/chat/completions'])
    assert.equal(conversationSource({ provider: 'api', baseUrl }), 'api:deepseek');
  assert.equal(conversationSource({ provider: 'api', baseUrl: 'https://api.moonshot.cn/v1' }), 'api:kimi');
  assert.equal(conversationSource({ provider: 'api', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }), 'api:zhipu');
  assert.equal(conversationSource({ provider: 'codex-cli', baseUrl: 'https://api.deepseek.com' }), 'codex-cli');
  assert.equal(conversationSource({ baseUrl: 'https://custom.test/v1/chat/completions/' }), conversationSource({ baseUrl: 'https://CUSTOM.test/v1/' }));
  assert.notEqual(conversationSource({ baseUrl: 'https://custom.test/a' }), conversationSource({ baseUrl: 'https://custom.test/b' }));
  assert.notEqual(conversationSource({ baseUrl: 'https://api.deepseek.com.evil.test' }), 'api:deepseek');
});

test('switching services archives old settings, messages and draft before creating a fresh source-bound session', async t => {
  const storage = await storageFor(t), state = stateFor(), previous = structuredClone(state);
  await persistSettingsPatch(state, { baseUrl: 'https://api.moonshot.cn/v1' }, () => storage.save(state), undefined, snapshot => storage.archive(snapshot));
  assert.equal(state.session.source, 'api:kimi'); assert.notEqual(state.session.id, previous.session.id);
  assert.equal(state.session.messages.length, 0); assert.equal(state.session.draft, ''); assert.equal(state.session.codex, undefined);
  const list = await storage.list('api:deepseek'); assert.equal(list.items.length, 1);
  assert.deepEqual(await storage.readArchive(list.items[0].id, 'api:deepseek'), previous.session);
  assert.equal((await storage.list('api:kimi')).items.length, 0);
  assert.equal((await storage.load()).value.session.source, 'api:kimi');
  await assert.rejects(storage.readArchive(list.items[0].id, 'api:kimi'), /阻止混用/);
});

test('same service model, effort and endpoint spelling changes retain the conversation', async () => {
  const state = stateFor(), session = state.session; let archives = 0;
  await persistSettingsPatch(state, { model: 'another-model', baseUrl: 'https://api.deepseek.com/v1/' }, async () => {}, undefined, async () => { archives++; });
  assert.equal(state.session, session); assert.equal(archives, 0); assert.equal(state.session.draft, '保留草稿');
});

test('Codex to API and back creates independent sessions and never reuses a native binding', async t => {
  const storage = await storageFor(t), state = stateFor('codex-cli');
  state.session.codex = { threadId: codexId, home: storage.directory, cwd: storage.directory };
  const persist = patch => persistSettingsPatch(state, patch, () => storage.save(state), undefined, snapshot => storage.archive(snapshot));
  await persist({ provider: 'api' }); const apiSession = state.session;
  assert.equal(apiSession.source, 'api:deepseek'); assert.equal(apiSession.codex, undefined);
  state.session.draft = 'API新草稿';
  await persist({ provider: 'codex-cli' });
  assert.equal(state.session.source, 'codex-cli'); assert.notEqual(state.session.id, apiSession.id); assert.equal(state.session.codex, undefined);
  assert.equal((await storage.list('codex-cli')).items.length, 1); assert.equal((await storage.list('api:deepseek')).items.length, 1);
});

test('archive and final-save failures keep the old connection and session intact', async () => {
  const state = stateFor(), settings = state.settings, session = state.session;
  let writes = 0, archived;
  await assert.rejects(persistSettingsPatch(state, { provider: 'codex-cli' }, async () => { writes++; }, undefined, async () => { throw Error('archive failed'); }), /archive failed/);
  assert.equal(writes, 0); assert.equal(state.settings, settings); assert.equal(state.session, session);
  await assert.rejects(persistSettingsPatch(state, { provider: 'codex-cli' }, async () => { throw Error('save failed'); }, undefined, async snapshot => { archived = structuredClone(snapshot); }), /save failed/);
  assert.deepEqual(archived.session, session); assert.equal(state.settings, settings); assert.equal(state.session, session);
});

test('legacy ambiguous history is preserved and excluded; native-only legacy history is recognized read-only', async t => {
  const storage = await storageFor(t), legacy = stateFor(); delete legacy.session.source;
  const unknownId = await storage.archive(legacy), file = path.join(storage.archiveDirectory, unknownId), before = await fs.readFile(file);
  assert.equal(recordedSource(legacy.session, legacy.settings), undefined);
  const native = stateFor('codex-cli'); delete native.session.source;
  native.session.codex = { threadId: codexId, home: storage.directory, cwd: storage.directory };
  native.session.messages[0].codexTurnId = codexId;
  const nativeId = await storage.archive(native);
  assert.equal((await storage.list('codex-cli')).items[0].id, nativeId);
  assert.equal((await storage.list('api:deepseek')).unclassified, 1);
  await assert.rejects(storage.readArchive(unknownId, 'api:deepseek'), /阻止混用/);
  assert.deepEqual(await fs.readFile(file), before);
  native.session.messages.push({ ...native.session.messages[0], id: 'unattributed', codexTurnId: undefined });
  assert.equal(recordedSource(native.session, native.settings), undefined);
});

test('startup separates ambiguous active history once and preserves it across restarts', async t => {
  const storage = await storageFor(t), state = stateFor(); delete state.session.source;
  const old = structuredClone(state.session);
  assert.match(await prepareConversation(state, snapshot => storage.archive(snapshot), () => storage.save(state)), /保留归档/);
  assert.equal(state.session.source, 'api:deepseek'); assert.equal(state.session.messages.length, 0);
  const list = await storage.list(); assert.equal(list.items.length, 1); assert.deepEqual(await storage.readArchive(list.items[0].id), old);
  const reopened = (await storage.load()).value;
  assert.equal(await prepareConversation(reopened, () => { throw Error('must not archive twice'); }, async () => {}), '');
});

test('Claude is absent from selectable providers and cannot execute; legacy configuration is retained safely as an archive', async t => {
  assert.throws(() => mergeSettings(initialState().settings, { provider: 'claude-cli' }), /Codex CLI 或 API/);
  await assert.rejects(streamCli({ settings: { provider: 'claude-cli' } }), /Claude CLI 已移除/);
  const storage = await storageFor(t), state = stateFor('claude-cli');
  assert.equal(isState(state), true); // Old files remain readable.
  assert.match(await prepareConversation(state, snapshot => storage.archive(snapshot), () => storage.save(state)), /Claude CLI 已移除/);
  assert.equal(state.settings.provider, 'api'); assert.equal(state.settings.cliPath, ''); assert.equal(state.session.messages.length, 0);
  assert.equal((await storage.list('claude-cli')).items.length, 1);
  assert.doesNotMatch(await fs.readFile(path.join(__dirname, '../src/ui/settings.html'), 'utf8'), /option value="claude-cli"/);
});

test('send and retry refuse foreign or unclassified context before reading a key or contacting a model', async () => {
  for (const source of ['codex-cli', undefined]) {
    const state = stateFor(); state.session.source = source; const before = JSON.stringify(state);
    const forbidden = () => { throw Error('must not call'); };
    const chat = new ChatController(state, { save: forbidden }, forbidden, forbidden, forbidden, forbidden);
    assert.equal((await chat.send('新问题')).ok, false); assert.equal((await chat.send('重试', true)).ok, false);
    assert.equal(JSON.stringify(state), before);
  }
});

test('late draft and submit IPC from the previous session cannot reach the new session', async () => {
  const source = ts.createSourceFile('main.ts', await fs.readFile(path.join(__dirname, '../src/main.ts'), 'utf8'), ts.ScriptTarget.ES2022, true);
  const handlers = new Map(), state = stateFor(); let calls = 0;
  const context = { state, validate: () => {}, configuring: false, closing: false, canSubmit: () => true, screenCapture: { status: 'empty' },
    settingsWindow: undefined, scheduleSave: () => { calls++; }, chat: { send: () => { calls++; } }, ipcMain: { handle: (key, value) => handlers.set(key, value) } };
  vm.createContext(context);
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'ipcMain.handle' && ['chat:draft', 'chat:submit'].includes(node.arguments[0]?.text))
      vm.runInContext(ts.transpileModule(node.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    ts.forEachChild(node, visit);
  }
  visit(source);
  handlers.get('chat:draft')({}, '不能混入的新草稿', 'old-session');
  assert.equal(handlers.get('chat:submit')({}, '不能转发的问题', 'old-session').ok, false);
  assert.equal(state.session.draft, '保留草稿'); assert.equal(calls, 0);
});
