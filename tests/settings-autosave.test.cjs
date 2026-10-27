const { test } = require('node:test');
const assert = require('node:assert/strict');
const { initialState, isState } = require('../dist/model');
const { mergeSettings, persistSettingsPatch } = require('../dist/settings');

test('custom text color is validated, persisted and rolled back on failed save', async () => {
  const state = initialState();
  await persistSettingsPatch(state, { textColor: '#12AbEF' }, async () => {});
  assert.equal(state.settings.textColor, '#12AbEF'); assert.equal(isState(state), true);
  for (const textColor of ['red', '#fff', '#zzffff', 7, null]) {
    assert.throws(() => mergeSettings(state.settings, { textColor }));
    assert.equal(isState({ ...state, settings: { ...state.settings, textColor } }), false);
  }
  await assert.rejects(persistSettingsPatch(state, { textColor: '#ffffff' }, async () => { throw Error('disk'); }));
  assert.equal(state.settings.textColor, '#12AbEF');
});

test('API effort is independent from CLI effort and is reset when model/address changes', () => {
  const config = { ...initialState().settings, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', reasoningEffort: 'xhigh' };
  const chosen = mergeSettings(config, { apiReasoningEffort: 'max' });
  assert.equal(chosen.reasoningEffort, 'xhigh'); assert.equal(chosen.apiReasoningEffort, 'max');
  assert.equal(mergeSettings(chosen, { model: 'deepseek-v4-pro' }).apiReasoningEffort, '');
  assert.equal(mergeSettings(chosen, { baseUrl: 'https://other.test/v1' }).apiReasoningEffort, '');
  assert.throws(() => mergeSettings(chosen, { apiReasoningEffort: 'ultra' }));
});

test('individual appearance edits save even before a model connection is configured', async () => {
  const state = initialState(); let snapshot;
  await persistSettingsPatch(state, { fontSize: 18, textShadow: true }, async () => { snapshot = structuredClone(state); });
  assert.equal(snapshot.settings.fontSize, 18); assert.equal(snapshot.settings.textShadow, true);
  assert.equal(snapshot.settings.baseUrl, ''); assert.equal(isState(snapshot), true);
});
test('invalid address and malformed fields cannot overwrite the last valid configuration', () => {
  const config = { ...initialState().settings, baseUrl: 'https://example.test/v1', model: 'test' };
  for (const patch of [{ baseUrl: 'broken' }, { baseUrl: 'https://user:secret@example.test' }, { baseUrl: '' }, { fontSize: 99 }, { textShadow: 'yes' }, { reasoningEffort: 'invented' }, { model: 'x\nsecret' }, { contextBudget: 999 }, { key: 'secret' }]) assert.throws(() => mergeSettings(config, patch));
  assert.equal(config.baseUrl, 'https://example.test/v1');
});
test('switching providers starts a fresh session while preserving unrelated legacy settings', async () => {
  const state = initialState(), session = state.session;
  state.settings.contextBudget = 48000;
  state.settings.baseUrl = 'https://old.test/v1'; state.settings.model = 'old';
  await persistSettingsPatch(state, { provider: 'codex-cli', cliPath: '', cliModel: '', reasoningEffort: '' }, async () => {});
  assert.notEqual(state.session, session); assert.equal(state.session.source, 'codex-cli'); assert.equal(state.settings.contextBudget, 48000);
  assert.equal(state.settings.baseUrl, 'https://old.test/v1'); assert.equal(state.settings.model, 'old');
  await persistSettingsPatch(state, { fontSize: 16 }, async () => {});
  assert.equal(state.settings.provider, 'codex-cli');
});
test('file and supported effort validation occur before any write', async () => {
  const state = initialState(); let writes = 0;
  const deps = { inspectCli: async () => { throw new Error('missing CLI'); }, readModelCatalog: async () => ({ models: [{ id: 'limited', efforts: ['low'] }] }) };
  await assert.rejects(persistSettingsPatch(state, { provider: 'codex-cli', cliPath: 'C:/missing.exe' }, async () => { writes++; }, deps), /missing CLI/);
  state.settings.provider = 'codex-cli'; state.settings.cliModel = 'limited';
  await assert.rejects(persistSettingsPatch(state, { reasoningEffort: 'high' }, async () => { writes++; }, deps), /不支持/);
  assert.equal(writes, 0); assert.equal(state.settings.reasoningEffort, undefined);
});
test('disk failure rolls back the in-memory configuration and leaves it readable', async () => {
  const state = initialState(), previous = state.settings;
  await assert.rejects(persistSettingsPatch(state, { fontSize: 20 }, async () => { throw new Error('disk full'); }), /disk full/);
  assert.equal(state.settings, previous); assert.equal(state.settings.fontSize, 14); assert.equal(isState(state), true);
});
