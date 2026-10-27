const { test } = require('node:test');
const assert = require('node:assert/strict');
const { streamChat, context, endpoint } = require('../dist/provider');
const settings = { baseUrl: 'https://example.test/v1', model: 'test' };
const event = x => `data: ${JSON.stringify(x)}\r\n\r\n`;
const valid = event({ choices: [{ delta: { content: '你好' }, finish_reason: null }] }) + event({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\r\n\r\n';
function fetchStream(text, status = 200, split = false) {
  return async () => new Response(new ReadableStream({ start(controller) {
    const bytes = new TextEncoder().encode(text);
    if (split) for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); else controller.enqueue(bytes);
    controller.close();
  } }), { status, headers: { 'Content-Type': 'text/event-stream' } });
}
const run = (fetcher, extra = {}) => streamChat({ settings, key: '', messages: [], signal: new AbortController().signal, onChunk: () => {}, fetcher, ...extra });

test('API effort reaches the actual request with each vendor contract and default omits it', async () => {
  const cases = [
    ['https://api.deepseek.com', 'deepseek-flash', 'none', { thinking: { type: 'disabled' } }],
    ['https://api.deepseek.com', 'deepseek-v4-pro', 'max', { thinking: { type: 'enabled' }, reasoning_effort: 'max' }],
    ['https://api.moonshot.cn/v1', 'kimi-k3.1-pro', 'low', { reasoning_effort: 'low' }],
    ['https://open.bigmodel.cn/api/paas/v4', 'glm-5.3', 'high', { thinking: { type: 'enabled' }, reasoning_effort: 'high' }],
    ['https://unknown.test/v1', 'custom', '', {}]
  ];
  for (const [baseUrl, model, effort, expected] of cases) await run(async (_url, init) => {
    const body = JSON.parse(init.body); delete body.model; delete body.messages; delete body.stream;
    assert.deepEqual(body, expected); return fetchStream(valid)();
  }, { settings: { baseUrl, model, apiReasoningEffort: effort, reasoningEffort: 'xhigh' } });
  await assert.rejects(run(fetchStream(valid), { settings: { baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k3.1-pro', apiReasoningEffort: 'none' } }), /不支持/);
});
test('SSE handles Chinese UTF-8 and CRLF split at every byte', async () => {
  let output = ''; await run(fetchStream(valid, 200, true), { onChunk: s => { output += s; } }); assert.equal(output, '你好');
});
test('HTTP authentication/rate limiting errors do not expose provider body', async () => {
  await assert.rejects(run(fetchStream('secret-provider-body', 401)), /凭据错误/);
  await assert.rejects(run(fetchStream('secret-provider-body', 429)), /限流/);
});
test('partial EOF, invalid events and token-limit termination are failures', async () => {
  await assert.rejects(run(fetchStream(event({ choices: [{ delta: { content: 'partial' } }] }))), /提前结束/);
  await assert.rejects(run(fetchStream('data: invalid\n\n')), /无效/);
  await assert.rejects(run(fetchStream(event({ choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }] }))), /未完整结束/);
});
test('waiting for headers times out and cancellation aborts fetch', async () => {
  const hang = (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
  await assert.rejects(run(hang, { timeoutMs: 20 }), /超时/);
  const controller = new AbortController(); const task = run(hang, { signal: controller.signal }); controller.abort();
  await assert.rejects(task, /停止/);
});
test('context includes only complete recent turns and never truncates new input', () => {
  const messages = [
    { role: 'user', content: '旧问题', requestId: '1' }, { role: 'assistant', content: '不完整', status: 'failed', requestId: '1' },
    { role: 'user', content: '记住猫叫圆圆', requestId: '2' }, { role: 'assistant', content: '记住了', status: 'complete', requestId: '2' }
  ];
  assert.deepEqual(context(messages, '猫叫什么').slice(1), [{ role: 'user', content: '记住猫叫圆圆' }, { role: 'assistant', content: '记住了' }, { role: 'user', content: '猫叫什么' }]);
  assert.equal(context(messages, '猫叫什么', 1).length, 2);
  assert.throws(() => context([], 'a'.repeat(12001)), /12000/);
});
test('endpoint allows HTTPS and local HTTP only; rejects inline secrets and redirects are disabled', async () => {
  assert.equal(endpoint('https://example.test/v1/'), 'https://example.test/v1/chat/completions');
  assert.equal(endpoint('http://127.0.0.1:1234/v1'), 'http://127.0.0.1:1234/v1/chat/completions');
  assert.throws(() => endpoint('http://example.test'), /HTTPS/);
  assert.throws(() => endpoint('https://user:secret@example.test'), /凭据/);
  await run(async (url, init) => { assert.equal(init.redirect, 'error'); return fetchStream(valid)(); });
});
