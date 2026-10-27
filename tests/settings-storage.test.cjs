const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, mkdir, readdir, writeFile, rm } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ChatStorage } = require('../dist/chat-storage');
const { initialState, isState } = require('../dist/model');
const { parseModelCatalog } = require('../dist/cli-models');
const { cliArguments } = require('../dist/cli');
const { context, contextSummary } = require('../dist/provider');
const { ChatController } = require('../dist/chat');

test('model cache is metadata only, tolerates missing fields and filters unsupported efforts', () => {
  assert.deepEqual(parseModelCatalog({}), []);
  const models = parseModelCatalog({ models: [null, { slug: 'hidden', visibility: 'hide' },
    { slug: 'test-model', display_name: 'Example', context_window: 1000, default_reasoning_level: 'high', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'bad' }] }] });
  assert.equal(models.length, 1); assert.deepEqual(models[0].efforts, ['low', 'high']);
  assert.equal(models[0].defaultEffort, 'high'); assert.equal(models[0].contextWindow, 1000);
  const args = cliArguments('codex-cli', 'test-model', 'high');
  assert.ok(args.includes('model_reasoning_effort="high"'));
  assert.ok(!cliArguments('codex-cli', '').some(v => v.startsWith('model_reasoning_effort=')));
  assert.throws(() => cliArguments('codex-cli', '', 'high"; malicious'), /推理强度/);
  assert.ok(!cliArguments('claude-cli', 'test', 'high').some(v => v.startsWith('model_reasoning_effort=')));
});

test('context preview matches request selection and larger budgets retain more complete turns', () => {
  const messages = [];
  for (let i = 0; i < 4; i++) for (const role of ['user', 'assistant']) messages.push({ id: `${i}-${role}`, role, content: role + 'x'.repeat(5000), status: 'complete', requestId: String(i), time: '' });
  for (const budget of [24000, 48000, 96000]) {
    const preview = contextSummary(messages, '当前问题', budget);
    const sent = context(messages, '当前问题', budget);
    assert.equal(preview.used, sent.reduce((sum, m) => sum + m.content.length, 0));
    assert.equal(preview.includedTurns, (sent.length - 2) / 2);
    assert.equal(preview.omittedTurns, 4 - preview.includedTurns); assert.ok(preview.used <= budget);
  }
  assert.ok(contextSummary(messages, '', 24000).omittedTurns > 0);
  assert.equal(contextSummary(messages, '', 48000).omittedTurns, 0);
  assert.equal(contextSummary(messages, 'x'.repeat(12001)).inputTooLong, true);
  const state = initialState(); assert.equal(isState(state), true);
  state.settings.contextBudget = -1; assert.equal(isState(state), false);
});

test('chat requests use the saved context budget rather than the former fixed limit', async () => {
  const state = initialState(); state.settings.baseUrl = 'https://example.test'; state.settings.model = 'fixture'; state.settings.contextBudget = 48000;
  for (let i = 0; i < 4; i++) for (const role of ['user', 'assistant']) state.session.messages.push({ id: `${i}-${role}`, role, content: 'x'.repeat(5000), status: 'complete', requestId: String(i), time: '' });
  state.session.source = 'api:https://example.test';
  let sent;
  const chat = new ChatController(state, { save: async () => {} }, () => '', () => {}, undefined, async options => { sent = options.messages; options.onChunk('OK'); });
  assert.equal((await chat.send('新问题')).ok, true);
  while (chat.busy) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(sent.length, 10); assert.ok(sent.reduce((sum, m) => sum + m.content.length, 0) > 24000);
});

test('storage migration preserves archives, serializes concurrent saves and survives reopening', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chatbubble-storage-')); t.after(() => rm(root, { recursive: true, force: true }));
  const base = path.join(root, 'app'); const target = path.join(root, 'chat');
  const storage = await ChatStorage.open(base); const state = initialState(); state.session.draft = '旧草稿';
  await storage.save(state); const id = await storage.archive(state);
  const switching = storage.relocate(target, state);
  state.session.draft = '切换期间的新草稿'; const pending = storage.save(state);
  await Promise.all([switching, pending]);
  assert.equal(JSON.parse(await readFile(path.join(base, 'state.json'))).session.draft, '旧草稿');
  assert.equal(JSON.parse(await readFile(path.join(target, 'state.json'))).session.draft, '切换期间的新草稿');
  assert.equal((await storage.readArchive(id)).draft, '旧草稿');
  const reopened = await ChatStorage.open(base); assert.equal(reopened.directory, await require('node:fs/promises').realpath(target));
  assert.equal((await reopened.load()).value.session.draft, '切换期间的新草稿');
  assert.equal((await reopened.list()).items[0].id, id);
  assert.ok((await readdir(base)).includes('sessions'));
});

test('nonempty targets, invalid archive paths and unavailable storage never erase existing data', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chatbubble-storage-')); t.after(() => rm(root, { recursive: true, force: true }));
  const base = path.join(root, 'app'); const target = path.join(root, 'other');
  const storage = await ChatStorage.open(base); const state = initialState(); state.session.draft = '不能丢失'; await storage.save(state);
  await mkdir(target); await writeFile(path.join(target, 'existing.txt'), 'keep');
  await assert.rejects(storage.relocate(target, state), /必须为空/);
  assert.equal(storage.directory, base); assert.equal(await readFile(path.join(target, 'existing.txt'), 'utf8'), 'keep');
  await assert.rejects(storage.readArchive('../state.json'), /无效/);
  const id = await storage.archive(state); await writeFile(path.join(base, 'sessions', id), '{broken');
  assert.equal((await storage.list()).unreadable, 1);
  assert.equal(await readFile(path.join(base, 'sessions', id), 'utf8'), '{broken');
  await assert.rejects(storage.relocate(path.join(base, 'nested'), state), /之外/);
  const moved = path.join(root, 'moved'); await storage.relocate(moved, state);
  await rm(moved, { recursive: true });
  await assert.rejects(ChatStorage.open(base));
  assert.equal(JSON.parse(await readFile(path.join(base, 'state.json'))).session.draft, '不能丢失');
});

test('failed location-pointer save keeps original directory active and preserves copied files', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chatbubble-storage-')); t.after(() => rm(root, { recursive: true, force: true }));
  const base = path.join(root, 'app'); const target = path.join(root, 'target');
  const storage = await ChatStorage.open(base); const state = initialState(); state.session.draft = '迁移前';
  storage.locationStore.save = async () => { throw new Error('pointer write failed'); };
  await assert.rejects(storage.relocate(target, state), /pointer write failed/);
  assert.equal(storage.directory, base); assert.equal((await ChatStorage.open(base)).directory, base);
  state.session.draft = '继续保存'; await storage.save(state);
  assert.equal(JSON.parse(await readFile(path.join(base, 'state.json'))).session.draft, '继续保存');
  assert.equal(JSON.parse(await readFile(path.join(target, 'state.json'))).session.draft, '迁移前');
});
