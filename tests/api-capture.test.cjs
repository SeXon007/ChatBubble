const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { streamChat, context } = require('../dist/provider');
const { captureCapability } = require('../dist/api-capabilities');
const { ChatController } = require('../dist/chat');
const { initialState } = require('../dist/model');
const tick = () => new Promise(resolve => setImmediate(resolve));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const event = x => `data: ${JSON.stringify(x)}\n\n`;
const reply = () => new Response(event({ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
async function attachment(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatbubble-api-image-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'attachments'); await fs.mkdir(directory);
  const file = path.join(directory, 'screenshot.png'); await fs.writeFile(file, png);
  return { image: { file, capturedAt: '2026-10-27T01:00:00Z' }, directory, root };
}
const request = (settings, extra) => streamChat({ settings, key: 'fixture', messages: [{ role: 'user', content: '看这张图' }], signal: new AbortController().signal, onChunk: () => {}, ...extra });

test('capture capability follows the provider/model; custom compatible APIs can try image input', () => {
  for (const [baseUrl, model, expected] of [
    ['https://api.deepseek.com', 'deepseek-flash', true], ['https://api.deepseek.com', 'deepseek-v4-pro', false],
    ['https://api.moonshot.cn/v1', 'kimi-k3.1-pro', true], ['https://api.moonshot.cn/v1', 'kimi-k2', false],
    ['https://open.bigmodel.cn/api/paas/v4', 'glm-4.6v-flash', true], ['https://open.bigmodel.cn/api/paas/v4', 'glm-4.7-flash', false],
    ['https://example.test/v1', 'custom-vision', true], ['', '', false]
  ]) assert.equal(captureCapability({ provider: 'api', baseUrl, model }).available, expected, model);
  assert.equal(captureCapability({ provider: 'codex-cli' }).available, true);
  assert.equal(captureCapability({ provider: 'claude-cli' }).available, false);
});

test('each API receives real image bytes in multimodal content without leaking the local path', async t => {
  const { image, directory } = await attachment(t);
  for (const [baseUrl, model, bare] of [
    ['https://api.deepseek.com', 'deepseek-flash', false], ['https://api.moonshot.cn/v1', 'kimi-k3.1-pro', false],
    ['https://open.bigmodel.cn/api/paas/v4', 'glm-4.6v-flash', true], ['https://example.test/v1', 'vision', false]
  ]) await request({ baseUrl, model }, { image, attachmentDirectory: directory, fetcher: async (_url, init) => {
    const body = JSON.parse(init.body), parts = body.messages.at(-1).content;
    assert.ok(Array.isArray(parts)); assert.equal(parts[0].type, 'text'); assert.match(parts[0].text, /看这张图/);
    assert.equal(parts[1].type, 'image_url');
    assert.equal(parts[1].image_url.url, (bare ? '' : 'data:image/png;base64,') + png.toString('base64'));
    assert.ok(!init.body.includes(image.file)); return reply();
  } });
});

test('API manual image persists, retries reuse it, and later questions retain historical image context', async t => {
  const { image, directory } = await attachment(t), state = initialState();
  Object.assign(state.settings, { provider: 'api', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' });
  let captures = 0; const bodies = [];
  const chat = new ChatController(state, { save: async () => {} }, () => '', () => {}, undefined,
    options => streamChat({ ...options, attachmentDirectory: directory, fetcher: async (_url, init) => {
      bodies.push(JSON.parse(init.body)); if (bodies.length === 1) return new Response('', { status: 429 }); return reply();
    } }), async () => (++captures === 1 ? { image } : {}));
  await chat.send('图里是什么'); while (chat.busy) await tick();
  assert.equal(state.session.messages[0].image.file, image.file); assert.equal(state.session.messages[1].status, 'failed');
  await chat.send('retry', true); while (chat.busy) await tick();
  assert.deepEqual(bodies[0].messages, bodies[1].messages); assert.equal(captures, 1);
  await chat.send('刚才那张图呢'); while (chat.busy) await tick();
  assert.ok(Array.isArray(bodies[2].messages[1].content)); assert.equal(typeof bodies[2].messages.at(-1).content, 'string');
  assert.equal(captures, 2); assert.equal(state.session.messages[2].image, undefined);
  assert.ok(context(state.session.messages.slice(0, 2), '追问')[1].image);
});

test('unsupported models and unavailable/current invalid images fail before any network request', async t => {
  const { image, directory, root } = await attachment(t); let calls = 0;
  const extra = { image, attachmentDirectory: directory, fetcher: async () => { calls++; return reply(); } };
  await assert.rejects(request({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro' }, extra), /图片|识图/);
  const settings = { baseUrl: 'https://example.test', model: 'vision' };
  await fs.writeFile(image.file, 'not a PNG'); await assert.rejects(request(settings, extra), /截图|图片/);
  await fs.writeFile(path.join(root, 'outside.png'), png);
  await assert.rejects(request(settings, { ...extra, image: { ...image, file: path.join(root, 'outside.png') } }), /截图|图片/);
  await fs.rm(image.file); await assert.rejects(request(settings, extra), /截图|图片/);
  assert.equal(calls, 0);
});

test('missing old images and text-only model switches stay explicit and keep text chat usable', async t => {
  const { image, directory } = await attachment(t); await fs.rm(image.file);
  const messages = [{ role: 'system', content: 'instructions' }, { role: 'user', content: '旧问题', image }, { role: 'assistant', content: '旧回复' }, { role: 'user', content: '继续' }];
  for (const model of ['deepseek-flash', 'deepseek-v4-pro']) await request({ baseUrl: 'https://api.deepseek.com', model }, {
    messages, attachmentDirectory: directory, fetcher: async (_url, init) => {
      const body = JSON.parse(init.body); assert.equal(typeof body.messages[1].content, 'string');
      assert.match(body.messages[1].content, /历史截图.*未附/); assert.equal(body.messages.at(-1).content, '继续'); return reply();
    }
  });
});

test('API rejects image protocol errors with actionable feedback without a silent text-only retry', async t => {
  const { image, directory } = await attachment(t); let calls = 0;
  await assert.rejects(request({ baseUrl: 'https://example.test', model: 'vision' }, {
    image, attachmentDirectory: directory, fetcher: async () => { calls++; return new Response('private diagnostics', { status: 400 }); }
  }), /图片|识图/); assert.equal(calls, 1);
});

test('image budget prioritizes the current screenshot and bounds old images; oversized images never upload', async t => {
  const { image, directory } = await attachment(t), { apiMessages } = require('../dist/api-images');
  const settings = { baseUrl: 'https://example.test', model: 'vision' }, signal = new AbortController().signal;
  const bytes = Buffer.alloc(13_000_000); png.copy(bytes); await fs.writeFile(image.file, bytes);
  const messages = [{ role: 'user', content: 'old', image }, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'new' }];
  const wire = await apiMessages({ settings, messages, image, attachmentDirectory: directory, signal });
  assert.equal(typeof wire[0].content, 'string'); assert.match(wire[0].content, /历史截图本轮未附/);
  assert.ok(Array.isArray(wire[2].content));
  await fs.writeFile(image.file, Buffer.alloc(16_000_001));
  await assert.rejects(request(settings, { image, attachmentDirectory: directory, fetcher: () => assert.fail('no upload') }), /16 MB/);
});

test('migrated attachments use the copied asset and never read arbitrary files or symlinks', async t => {
  const { image, directory, root } = await attachment(t);
  await request({ baseUrl: 'https://example.test', model: 'vision' }, {
    image: { ...image, file: path.join(root, 'old-storage', 'attachments', 'screenshot.png') }, attachmentDirectory: directory,
    fetcher: async (_url, init) => { assert.match(init.body, /image_url/); return reply(); }
  });
  await fs.rm(image.file);
  try { await fs.symlink(path.join(root, 'outside.png'), image.file); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return; throw error; }
  await fs.writeFile(path.join(root, 'outside.png'), png);
  await assert.rejects(request({ baseUrl: 'https://example.test', model: 'vision' }, {
    image, attachmentDirectory: directory, fetcher: () => assert.fail('no symlink upload')
  }), /截图/);
});

test('production settings save clears attachments on model/source/scope changes, but retains them for appearance edits', async () => {
  const vm = require('node:vm'), ts = require('typescript');
  const source = ts.createSourceFile('main.ts', await fs.readFile(path.join(__dirname, '../src/main.ts'), 'utf8'), ts.ScriptTarget.ES2022, true);
  const state = initialState(); Object.assign(state.settings, { provider: 'api', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' });
  let clears = 0, closes = 0, handler;
  const env = { state, configuring: false, closing: false, flushingSettings: false, checking: false, smoke: true, restartMode: undefined,
    validate: () => {}, broadcast: () => {}, captureCapability, persistSettingsPatch: require('../dist/settings').persistSettingsPatch,
    chat: { busy: false, persist: async () => {} }, store: { archive: async () => {} },
    screenCapture: { clear: () => clears++ }, nativeCapture: { close: () => closes++ },
    ipcMain: { handle: (_key, value) => { handler = value; } } };
  vm.createContext(env);
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'ipcMain.handle' && node.arguments[0]?.text === 'settings:save')
      vm.runInContext(ts.transpileModule(node.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, env);
    ts.forEachChild(node, visit);
  } visit(source);
  assert.equal((await handler({}, { fontSize: 16 })).ok, true); assert.equal(clears, 0);
  assert.equal((await handler({}, { model: 'deepseek-flash' })).ok, true); assert.equal(clears, 0);
  assert.equal((await handler({}, { model: 'deepseek-v4-pro' })).ok, true); assert.ok(clears > 0); assert.equal(closes, 1);
  const before = clears; assert.equal((await handler({}, { captureScope: 'screen' })).ok, true); assert.ok(clears > before);
  assert.equal((await handler({}, { baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k3.1-pro' })).ok, true);
  assert.equal(state.session.messages.length, 0);
});

test('failed API image request survives a real store reload and retry does not recapture', async t => {
  const { image, directory, root } = await attachment(t), { ChatStorage } = require('../dist/chat-storage');
  const store = await ChatStorage.open(path.join(root, 'state')), state = initialState();
  Object.assign(state.settings, { provider: 'api', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' });
  const first = new ChatController(state, store, () => '', () => {}, undefined,
    options => streamChat({ ...options, attachmentDirectory: directory, fetcher: async () => new Response('', { status: 429 }) }), async () => ({ image }));
  await first.send('保存原图'); while (first.busy) await tick(); await first.persist();
  const saved = (await (await ChatStorage.open(path.join(root, 'state'))).load()).value;
  assert.equal(saved.session.messages[0].image.file, image.file); assert.ok(!JSON.stringify(saved).includes(png.toString('base64')));
  const second = new ChatController(saved, store, () => '', () => {}, undefined,
    options => streamChat({ ...options, attachmentDirectory: directory, fetcher: async (_url, init) => {
      assert.equal(JSON.parse(init.body).messages.at(-1).content[1].image_url.url, 'data:image/png;base64,' + png.toString('base64')); return reply();
    } }), () => assert.fail('retry must not recapture'));
  assert.equal((await second.send('retry', true)).ok, true); while (second.busy) await tick(); await second.persist();
  assert.equal(saved.session.messages.at(-1).status, 'complete');
});
