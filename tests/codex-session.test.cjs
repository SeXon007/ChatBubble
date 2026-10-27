const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, writeFile, rm } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { streamCodex, codexArguments, readCodexUpdates } = require('../dist/codex');
const { initialState, isState } = require('../dist/model');
const { ChatController } = require('../dist/chat');
async function fixture(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'chatbubble-native-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const file = path.join(cwd, 'native-fixture.json');
  const read = async () => JSON.parse(await readFile(file));
  let binding, turn, text = '', userMessageId = randomUUID();
  const call = async (extra = {}) => {
    text = '';
    await streamCodex({ executable: process.execPath, args: [path.join(__dirname, 'fixtures/codex-server.cjs')], settings: { ...initialState().settings, cliModel: 'fixture', reasoningEffort: 'low' },
      question: '问题', workDir: cwd, signal: new AbortController().signal, timeoutMs: 2000, onChunk: s => { text += s; },
      conversation: { session: binding, userMessageId, retry: false, onSession: async s => { binding = s; }, onTurn: async id => { turn = id; }, ...extra.conversation }, ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'conversation')) });
  };
  return { cwd, file, read, call, get binding() { return binding; }, get turn() { return turn; }, get text() { return text; }, get userId() { return userMessageId; }, newUser() { userMessageId = randomUUID(); } };
}
test('native turns persist and resume after a new process, without replaying history', async t => {
  const f = await fixture(t); await f.call(); const id = f.binding.threadId;
  assert.equal(f.text, '你好'); f.newUser(); await f.call();
  assert.equal(f.binding.threadId, id);
  const data = await f.read(); assert.equal(data.starts, 2); assert.equal(Object.keys(data.threads).length, 1);
  assert.equal(data.requests.filter(q => q.method === 'thread/resume').length, 1);
  const turns = data.requests.filter(q => q.method === 'turn/start');
  assert.equal(turns[1].params.input.length, 1); assert.equal(turns[1].params.input[0].text, '问题');
  assert.equal(data.requests.find(q => q.method === 'thread/start').params.ephemeral, false);
});
test('failed native turn retries revert only that owned latest turn', async t => {
  const f = await fixture(t); await assert.rejects(f.call({ question: '[fail]' }), /会话请求失败/);
  const failed = f.turn; await f.call({ conversation: { retry: true, retryTurnId: failed } });
  const data = await f.read(); assert.equal(data.starts, 2); assert.equal(data.threads[f.binding.threadId].turns.length, 1);
  assert.equal(data.requests.find(q => q.method === 'thread/revert').params.beforeTurnId, failed);
});
test('acknowledgement lost after a completed native reply is recovered without another model call', async t => {
  const f = await fixture(t); await f.call();
  await f.call({ conversation: { retry: true } });
  assert.equal(f.text, '你好'); assert.equal((await f.read()).starts, 1);
});
test('external turns are never reverted or overwritten during retry', async t => {
  const f = await fixture(t); await assert.rejects(f.call({ question: '[fail]' }));
  const data = await f.read(); data.threads[f.binding.threadId].turns.push({ id: randomUUID(), status: 'completed', items: [{ type: 'userMessage', id: randomUUID() }] });
  await writeFile(f.file, JSON.stringify(data));
  await assert.rejects(f.call({ conversation: { retry: true, retryTurnId: f.turn } }), /其他窗口更新/);
  const next = await f.read(); assert.equal(next.starts, 1); assert.ok(!next.requests.some(q => q.method === 'thread/revert'));
});
test('new desktop turns are imported in order before continuing the same thread', async t => {
  const f = await fixture(t); await f.call(); const threadId = f.binding.threadId;
  const data = await f.read(); const external = [];
  for (let index = 0; index < 35; index++) {
    const turn = { id: randomUUID(), status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text: `桌面 ${index}` }, { type: 'image', url: 'data:image/png;base64,fixture' }] }, { type: 'agentMessage', text: `回答 ${index}` }] };
    external.push(turn); data.threads[threadId].turns.push(turn);
  }
  await writeFile(f.file, JSON.stringify(data)); let imported;
  f.newUser(); await f.call({ conversation: { onHistory: async turns => { imported = turns; } } });
  assert.equal(f.binding.threadId, threadId); assert.equal(imported.length, 35);
  assert.equal(imported[0].user, '桌面 0'); assert.equal(imported.at(-1).assistant, '回答 34');
  const final = await f.read(); assert.equal(final.starts, 2); assert.equal(final.threads[threadId].turns.length, 37);
  assert.ok(!final.requests.some(q => q.method === 'thread/revert'));
});
test('image is a native input, and retry keeps the image attached to its original user message', async t => {
  const f = await fixture(t), image = { file: path.join(f.cwd, 'image.png'), capturedAt: 'fixture' };
  await writeFile(image.file, 'synthetic image');
  await assert.rejects(f.call({ question: '[fail]', image }));
  await f.call({ image, conversation: { retry: true, retryTurnId: f.turn } });
  const requests = (await f.read()).requests.filter(q => q.method === 'turn/start');
  assert.deepEqual(requests.map(q => q.params.input[1]), [{ type: 'localImage', path: image.file }, { type: 'localImage', path: image.file }]);
});
test('ownership failures have a specific message and never start a duplicate turn', async t => {
  const f = await fixture(t); await f.call(); const data = await f.read(); data.locked = true; await writeFile(f.file, JSON.stringify(data));
  await assert.rejects(f.call(), /另一个应用占用/); assert.equal((await f.read()).starts, 1);
});
test('failed current-screen status reaches Codex without attaching an earlier image', async t => {
  const f = await fixture(t); await f.call({ screenNotice: '本次未能读取目标窗口（窗口捕获超时），已按文字发送。' });
  const request = (await f.read()).requests.find(q => q.method === 'turn/start');
  assert.equal(request.params.input.length, 1);
  assert.match(request.params.input[0].text, /本轮没有新截图/);
  assert.match(request.params.input[0].text, /窗口捕获超时/);
  assert.match(request.params.input[0].text, /不能据此判断当前界面/);
});
test('passive refresh reads desktop updates without resuming a thread or requesting a model', async t => {
  const f = await fixture(t); await f.call(); const data = await f.read();
  const externalId = randomUUID(); data.locked = true;
  data.threads[f.binding.threadId].turns.push({ id: externalId, status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text: '桌面消息' }] }, { type: 'agentMessage', text: '桌面回答' }] });
  const before = data.requests.length; await writeFile(f.file, JSON.stringify(data));
  const updates = await readCodexUpdates({ executable: process.execPath, args: [path.join(__dirname, 'fixtures/codex-server.cjs')], binding: f.binding });
  assert.equal(updates[0].id, externalId); assert.equal(updates[0].assistant, '桌面回答');
  const requests = (await f.read()).requests.slice(before);
  assert.ok(requests.some(q => q.method === 'thread/read')); assert.ok(!requests.some(q => ['thread/resume', 'turn/start', 'thread/revert'].includes(q.method)));
});
test('controller refresh imports completed desktop messages without duplicates and preserves draft', async () => {
  const state = initialState(); state.session.codex = { threadId: randomUUID(), home: 'fixture', cwd: 'fixture', lastTurnId: randomUUID() }; state.session.draft = '未发草稿';
  const turn = { id: randomUUID(), status: 'completed', user: '桌面问题', assistant: '桌面回复' }; let saved = 0;
  const chat = new ChatController(state, { save: async () => { saved++; } }, () => '', () => {});
  await chat.synchronize(async () => [turn]); await chat.synchronize(async () => [turn]);
  assert.equal(state.session.messages.length, 2); assert.equal(state.session.messages[1].content, '桌面回复');
  assert.equal(state.session.draft, '未发草稿'); assert.equal(state.session.codex.lastTurnId, turn.id); assert.ok(saved > 0);
});
test('controller drops a delayed history refresh after changing conversations', async () => {
  const state = initialState(); state.session.codex = { threadId: randomUUID(), home: 'fixture', cwd: 'fixture' };
  const chat = new ChatController(state, { save: async () => {} }, () => '', () => {}); let resolve;
  const refresh = chat.synchronize(() => new Promise(done => { resolve = done; }));
  state.session = initialState().session; resolve([{ id: randomUUID(), status: 'completed', user: '旧会话', assistant: '不可混入' }]); await refresh;
  assert.equal(state.session.messages.length, 0); assert.equal(state.session.codex, undefined);
});
test('cancellation interrupts our turn and permits a safe retry', async t => {
  const f = await fixture(t), abort = new AbortController();
  await assert.rejects(f.call({ question: '[hang]', signal: abort.signal, onChunk: () => abort.abort() }), /停止生成/);
  assert.equal((await f.read()).threads[f.binding.threadId].turns.at(-1).status, 'interrupted');
  await f.call({ conversation: { retry: true, retryTurnId: f.turn } }); assert.equal(f.text, '你好');
});
test('tool events, process crash, timeout and unknown thread fail without false success', async t => {
  for (const question of ['[tool]', '[crash]', '[hang]']) {
    const f = await fixture(t); await assert.rejects(f.call({ question, timeoutMs: 150 }), /工具|连接已关闭|超时/);
  }
  const f = await fixture(t); await f.call(); const missing = { ...f.binding, threadId: randomUUID() };
  await assert.rejects(f.call({ conversation: { session: missing } }), error => !error.message.includes('secret'));
  assert.equal((await f.read()).starts, 1);
});
test('saving the native ID must succeed before any model turn starts; changed data home is refused', async t => {
  const f = await fixture(t);
  await assert.rejects(f.call({ conversation: { onSession: async () => { throw new Error('disk full'); } } }), /disk full/);
  assert.equal((await f.read()).starts, 0);
  await f.call(); await assert.rejects(f.call({ conversation: { session: { ...f.binding, home: path.join(f.cwd, 'other') } } }), /数据目录已改变/);
});
test('native session metadata validates and no global config or credentials are changed by launch arguments', () => {
  const state = initialState(); state.session.codex = { threadId: randomUUID(), home: 'C:/test', cwd: 'C:/work', lastTurnId: randomUUID() };
  assert.equal(isState(state), true); state.session.codex.threadId = '../bad'; assert.equal(isState(state), false);
  const args = codexArguments(); assert.ok(!args.includes('--ephemeral')); assert.ok(args.includes('stdio://'));
  assert.ok(args.includes('shell_tool')); assert.ok(args.includes('sandbox_mode="read-only"'));
});
test('ChatController persists native identity and sends only new input, including input above the former 12k cap', async () => {
  const state = initialState(); state.settings.provider = 'codex-cli'; state.settings.cliPath = 'C:/codex.exe';
  let saved, sent;
  const chat = new ChatController(state, { save: async s => { saved = structuredClone(s); } }, () => '', () => {}, undefined, async options => {
    sent = options.messages;
    await options.codex.onSession({ threadId: randomUUID(), home: 'C:/test', cwd: 'C:/work' });
    await options.codex.onTurn(randomUUID()); options.onChunk('完成');
  });
  assert.equal((await chat.send('字'.repeat(16000))).ok, true);
  while (chat.busy) await new Promise(r => setTimeout(r, 5));
  assert.equal(sent.length, 1); assert.equal(sent[0].content.length, 16000);
  assert.ok(saved.session.codex.threadId); assert.ok(saved.session.messages.at(-1).codexTurnId); assert.equal(isState(saved), true);
});
test('configured MCP servers are individually disabled before thread creation; incompatible names fail closed', async t => {
  const f = await fixture(t); await f.call({ env: { ...process.env, CHATBUBBLE_FIXTURE_MCP: 'test_tools' } });
  const data = await f.read(); const configs = data.requests.filter(q => q.method === 'config/read');
  assert.equal(configs.length, 2); assert.equal(data.starts, 1);
  const bad = await fixture(t); await assert.rejects(bad.call({ env: { ...process.env, CHATBUBBLE_FIXTURE_MCP: 'invalid.name' } }), /工具名称不兼容/);
  assert.equal((await bad.read()).starts, 0);
});
test('failure before a new turn does not recover the preceding answer as the new answer', async t => {
  const f = await fixture(t); await f.call(); f.newUser();
  await f.call({ conversation: { retry: true } });
  assert.equal((await f.read()).starts, 2);
});
test('an empty thread lost before first native turn is recreated without losing the pending question', async t => {
  const f = await fixture(t); let empty;
  await assert.rejects(f.call({ conversation: { onSession: async s => { empty = s; throw new Error('interrupted save'); } } }));
  const data = await f.read(); data.threads = {}; await writeFile(f.file, JSON.stringify(data));
  await f.call({ conversation: { session: empty } });
  assert.notEqual(f.binding.threadId, empty.threadId); assert.equal((await f.read()).starts, 1); assert.equal(f.text, '你好');
});
