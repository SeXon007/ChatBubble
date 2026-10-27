const { test } = require('node:test');
const assert = require('node:assert/strict');
const { apiPresets, apiPresetForUrl, modelsEndpoint, parseApiModels, listApiModels } = require('../dist/api-models');
const { initialState } = require('../dist/model');
const { mergeSettings } = require('../dist/settings');
const { apiModelMetadata } = require('../dist/api-models');

test('official names survive discovery and release metadata orders newest first', () => {
  const data = [
    { id: 'new-id', name: 'Official New', released_at: '2026-10-17' },
    { id: 'old-id', name: 'Official Old', created: 1000 },
    { id: 'unknown-v2', name: 'Official V2' },
    { id: 'unknown-v10', name: 'Official V10' }
  ];
  const result = apiModelMetadata({ data });
  assert.deepEqual(result.models, ['new-id', 'old-id', 'unknown-v10', 'unknown-v2']);
  assert.equal(result.names['new-id'], 'Official New');
  const deepseek = apiModelMetadata({ data: [
    { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
    { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' },
    { id: 'deepseek-v4-flash', name: 'retired alias' }
  ] }, apiPresets[0]);
  assert.deepEqual(deepseek.models, ['deepseek-flash', 'deepseek-v4-pro']);
  assert.equal(deepseek.names['deepseek-flash'], 'DeepSeek-V4.1-Flash');
});

test('only the three requested vendors are preset; aliases and full completion URLs match safely', () => {
  assert.deepEqual(apiPresets.map(p => p.id), ['deepseek', 'kimi', 'zhipu']);
  assert.equal(apiPresetForUrl('https://api.deepseek.com/v1/chat/completions').id, 'deepseek');
  assert.equal(modelsEndpoint('https://api.moonshot.cn/v1/'), 'https://api.moonshot.cn/v1/models');
  assert.equal(modelsEndpoint('https://example.test/custom/chat/completions'), 'https://example.test/custom/models');
  assert.equal(apiPresetForUrl('https://api.deepseek.com.evil.test'), undefined);
  for (const url of ['https://secret@example.test', 'https://example.test?key=secret', 'http://example.test', 'file:///tmp/models']) assert.throws(() => modelsEndpoint(url));
});
test('model metadata is deduplicated, bounded and safe to render as text', () => {
  assert.deepEqual(parseApiModels({ data: [{ id: 'first' }, { id: 'first' }, { id: 'second' }, { id: 'bad\nmodel' }, { id: 'audio', output_modalities: ['audio'] }, null] }), ['first', 'second']);
  assert.throws(() => parseApiModels({ error: 'reflected secret' }));
  assert.throws(() => parseApiModels({ data: [] }));
});
test('model discovery is a GET to the selected service, has no prompt, and never follows redirects', async () => {
  let request;
  const result = await listApiModels({ baseUrl: 'https://example.test/v1', key: 'fixture-key', fetcher: async (url, options) => {
    request = { url, options }; return Response.json({ data: [{ id: 'available-model' }] });
  } });
  assert.equal(result.source, 'service'); assert.deepEqual(result.models, ['available-model']);
  assert.equal(request.url, 'https://example.test/v1/models'); assert.equal(request.options.method, 'GET');
  assert.equal(request.options.headers.Authorization, 'Bearer fixture-key');
  assert.equal(request.options.redirect, 'error'); assert.equal(request.options.body, undefined);
});
test('missing credentials and the undocumented GLM catalog never invent an authenticated request', async () => {
  let calls = 0; const fetcher = async () => { calls++; throw new Error('must not run'); };
  const missing = await listApiModels({ baseUrl: apiPresets[0].baseUrl, key: '', fetcher });
  assert.equal(calls, 0); assert.equal(missing.source, 'preset'); assert.match(missing.error, /API Key/);
  const glm = await listApiModels({ baseUrl: apiPresets[2].baseUrl, key: 'fixture-key', fetcher });
  assert.equal(calls, 0); assert.equal(glm.source, 'preset'); assert.ok(glm.models.includes('glm-4.7-flash'));
});
test('bad responses, auth failures and timeouts preserve a usable fallback without exposing provider bodies', async () => {
  for (const response of [new Response('reflected-fixture-key', { status: 401 }), new Response('reflected-fixture-key', { status: 404 }), new Response('invalid-json'), new Response('x'.repeat(1024 * 1024 + 1))]) {
    const result = await listApiModels({ baseUrl: apiPresets[0].baseUrl, key: 'fixture-key', fetcher: async () => response });
    assert.equal(result.source, 'preset'); assert.ok(result.models.length); assert.ok(result.error);
    assert.doesNotMatch(JSON.stringify(result), /reflected-fixture-key/);
  }
  const result = await listApiModels({ baseUrl: apiPresets[1].baseUrl, key: 'fixture-key', timeoutMs: 20,
    fetcher: (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('private network details')))) });
  assert.match(result.error, /超时/); assert.doesNotMatch(result.error, /private network/);
});
test('local keyless services can list models; changing an API address can clear the old vendor model atomically', async () => {
  const catalog = await listApiModels({ baseUrl: 'http://127.0.0.1:1234/v1', key: '', fetcher: async (_url, options) => {
    assert.equal(options.headers.Authorization, undefined); return Response.json({ data: [{ id: 'local-model' }] });
  } });
  assert.deepEqual(catalog.models, ['local-model']);
  const settings = { ...initialState().settings, baseUrl: apiPresets[0].baseUrl, model: 'old-model' };
  assert.equal(mergeSettings(settings, { baseUrl: apiPresets[1].baseUrl, model: '' }).model, '');
  assert.throws(() => mergeSettings(settings, { model: '' }));
});
