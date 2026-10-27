const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, writeFile, readdir } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { JsonStore } = require('../dist/storage');
const { initialState, isState } = require('../dist/model');
const { ChatController } = require('../dist/chat');
const temp = () => mkdtemp(path.join(os.tmpdir(), 'chatbubble-test-'));
test('queued snapshots retain order and restore valid backup while preserving corrupt original', async () => {
  const dir = await temp(); const file = path.join(dir, 'state.json'); const store = new JsonStore(file, isState); const state = initialState();
  state.session.draft = 'first'; const first = store.save(state); state.session.draft = 'second'; const second = store.save(state); await Promise.all([first, second]);
  assert.equal(JSON.parse(await readFile(file)).session.draft, 'second');
  await writeFile(file, '{broken');
  const loaded = await store.load(initialState); assert.equal(loaded.recovered, true); assert.equal(loaded.value.session.draft, 'first');
  assert.ok((await readdir(dir)).some(name => name.includes('.corrupt-')));
  await store.save(loaded.value); assert.equal(JSON.parse(await readFile(file)).session.draft, 'first');
});
test('unrecoverable data cannot be replaced by empty fallback', async () => {
  const dir = await temp(); const file = path.join(dir, 'state.json'); await writeFile(file, 'broken');
  await assert.rejects(new JsonStore(file, isState).load(initialState), /保留原文件/); assert.equal(await readFile(file, 'utf8'), 'broken');
});
test('duplicate sends rejected, cancelled partial retained, retry reuses original user message', async () => {
  const state = initialState(); state.settings = { ...state.settings, baseUrl: 'https://example.test', model: 'test' };
  const store = new JsonStore(path.join(await temp(), 'state.json'), isState);
  let request = 0; let resolveChunk; const firstChunk = new Promise(r => { resolveChunk = r; });
  const fetcher = async (_url, options) => {
    request++;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"部分文字"}}]}\n\n'));
      if (request === 1) options.signal.addEventListener('abort', () => controller.error(new Error('aborted')));
      else { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')); controller.close(); }
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const chat = new ChatController(state, store, () => '', () => { if (state.session.messages.at(-1)?.content) resolveChunk(); }, fetcher);
  assert.equal((await chat.send('问题')).ok, true); assert.equal((await chat.send('重复')).ok, false);
  await firstChunk; await chat.stop(); assert.equal(state.session.messages.at(-1).status, 'cancelled');
  assert.equal(state.session.messages.at(-1).content, '部分文字');
  assert.equal((await chat.send('问题', true)).ok, true);
  while (chat.busy) await new Promise(r => setTimeout(r, 5)); await store.flush();
  assert.equal(state.session.messages.length, 2); assert.equal(state.session.messages.at(-1).status, 'complete');
  assert.equal(state.session.messages.at(-1).previousAttempts[0].content, '部分文字');
});
test('save failure prevents model request and preserves user text', async () => {
  const state = initialState(); state.settings.baseUrl = 'https://example.test'; state.settings.model = 'test'; let called = false;
  const chat = new ChatController(state, { save: async () => { throw new Error('disk'); } }, () => '', () => {}, async () => { called = true; });
  await chat.send('不能丢'); while (chat.busy) await new Promise(r => setTimeout(r, 5));
  assert.equal(called, false); assert.equal(state.session.messages[0].content, '不能丢'); assert.equal(state.session.messages[1].status, 'failed');
});
