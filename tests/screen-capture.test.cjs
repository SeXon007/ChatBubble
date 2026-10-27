const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, writeFile, readdir, rm } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ScreenCapture, migrateScreenshots } = require('../dist/screen-capture');
const { ChatStorage } = require('../dist/chat-storage');
const { initialState } = require('../dist/model');
const { ChatController } = require('../dist/chat');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function root(t) { const dir = await mkdtemp(path.join(os.tmpdir(), 'chatbubble-screen-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test('rapid expansions coalesce; stale capture cannot replace the latest, no parallel captures', async t => {
  const dir = await root(t); let finish, count = 0, active = 0, maxActive = 0;
  const screen = new ScreenCapture(() => dir, async () => { count++; maxActive = Math.max(maxActive, ++active); if (count === 1) await new Promise(resolve => { finish = resolve; }); active--; return Buffer.from(String(count)); });
  screen.request(); await tick(); screen.request(); screen.request(); finish();
  const result = await screen.take();
  assert.equal(count, 2); assert.equal(maxActive, 1); assert.equal(await readFile(result.image.file, 'utf8'), '2');
  assert.equal((await readdir(path.join(dir, 'attachments'))).length, 2);
  assert.deepEqual(await screen.take(), {}); await screen.close();
});
test('a request claims its own expansion even if another expansion occurs during capture', async t => {
  const dir = await root(t); let finish, count = 0;
  const screen = new ScreenCapture(() => dir, async () => { const id = ++count; if (id === 1) await new Promise(resolve => { finish = resolve; }); return Buffer.from(String(id)); });
  screen.request(); await tick(); const request = screen.take(); screen.request(); finish();
  const first = await request; const second = await screen.take();
  assert.equal(await readFile(first.image.file, 'utf8'), '1'); assert.equal(await readFile(second.image.file, 'utf8'), '2'); await screen.close();
});
test('captures are saved directly in attachments and survive clear, replacement and close', async t => {
  const dir = await root(t); const screen = new ScreenCapture(() => dir, async () => Buffer.from('image'));
  screen.request(); const image = (await screen.take()).image;
  assert.equal(path.dirname(image.file), path.join(dir, 'attachments'));
  screen.clear();
  await writeFile(path.join(dir, 'state.json'), 'history'); await writeFile(path.join(dir, 'attachments', 'user-note.txt'), 'keep');
  screen.request(); await tick(); await screen.close(); await migrateScreenshots(dir);
  assert.equal(await readFile(image.file, 'utf8'), 'image'); assert.equal(await readFile(path.join(dir, 'state.json'), 'utf8'), 'history');
  assert.equal((await readdir(path.join(dir, 'attachments'))).filter(file => file.endsWith('.png')).length, 2);
  assert.equal(await readFile(path.join(dir, 'attachments', 'user-note.txt'), 'utf8'), 'keep');
  await assert.rejects(readdir(path.join(dir, 'screenshot')), { code: 'ENOENT' });
});
test('closing during capture retains the returned image without making it a future attachment', async t => {
  const dir = await root(t); let finish;
  const screen = new ScreenCapture(() => dir, () => new Promise(resolve => { finish = resolve; }));
  screen.request(); await tick(); const closing = screen.close(); finish(Buffer.from('late image')); await closing;
  assert.deepEqual(await screen.take(), {});
  const files = await readdir(path.join(dir, 'attachments'));
  assert.equal(files.length, 1); assert.equal(await readFile(path.join(dir, 'attachments', files[0]), 'utf8'), 'late image');
});
test('legacy screenshots move into attachments without overwriting files or changing saved message paths', async t => {
  const dir = await root(t), legacy = path.join(dir, 'screenshot'), attachments = path.join(dir, 'attachments');
  await mkdir(legacy); await mkdir(attachments);
  await writeFile(path.join(legacy, 'same.png'), 'old pending image');
  await writeFile(path.join(legacy, 'note.txt'), 'user note');
  await writeFile(path.join(attachments, 'same.png'), 'existing history image');
  await writeFile(path.join(dir, 'state.json'), 'unchanged history');
  await migrateScreenshots(dir); await migrateScreenshots(dir);
  await assert.rejects(readdir(legacy), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(attachments, 'same.png'), 'utf8'), 'existing history image');
  assert.equal(await readFile(path.join(attachments, 'note.txt'), 'utf8'), 'user note');
  const contents = await Promise.all((await readdir(attachments)).map(file => readFile(path.join(attachments, file), 'utf8')));
  assert.deepEqual(contents.sort(), ['old pending image', 'existing history image', 'user note'].sort());
  assert.equal(await readFile(path.join(dir, 'state.json'), 'utf8'), 'unchanged history');
});
test('legacy migration never recursively deletes a user-created directory', async t => {
  const dir = await root(t), nested = path.join(dir, 'screenshot', 'my-folder');
  await mkdir(nested, { recursive: true }); await writeFile(path.join(nested, 'note.txt'), 'preserve');
  await migrateScreenshots(dir);
  assert.equal(await readFile(path.join(nested, 'note.txt'), 'utf8'), 'preserve');
});
test('capture failure uses text with a notice and retry does not take another screenshot', async () => {
  const state = initialState(); Object.assign(state.settings, { provider: 'codex-cli', cliPath: 'fixture', screenCaptureEnabled: true });
  let captures = 0, image, calls = 0;
  const chat = new ChatController(state, { save: async () => {} }, () => '', () => {}, undefined, async options => { image = options.image; if (++calls === 1) throw new Error('fixture'); options.onChunk('OK'); }, async () => { captures++; return { error: '本次未能读取目标窗口，已按文字发送。' }; });
  await chat.send('问题'); while (chat.busy) await tick();
  assert.equal(state.session.messages[0].notice.includes('未能读取'), true); assert.equal(image, undefined);
  await chat.send('问题', true); while (chat.busy) await tick(); assert.equal(captures, 1); assert.equal(calls, 2);
});
test('portable first run, legacy migration and custom directories preserve data', async t => {
  const dir = await root(t), base = path.join(dir, 'appdata'), portable = path.join(dir, 'ChatBubble', 'chat');
  const storage = await ChatStorage.open(base, portable); const state = initialState(); state.session.draft = 'portable';
  await storage.save(state); assert.equal(storage.directory, portable);
  assert.equal((await (await ChatStorage.open(base, portable)).load()).value.session.draft, 'portable');
  assert.equal((await ChatStorage.open(base, path.join(dir, 'new-version', 'chat'))).directory, portable);
  const legacyBase = path.join(dir, 'legacy'), legacyTarget = path.join(dir, 'new-chat');
  const legacy = await ChatStorage.open(legacyBase); state.session.draft = 'legacy'; await legacy.save(state); const id = await legacy.archive(state);
  await mkdir(path.join(legacyBase, 'attachments')); await writeFile(path.join(legacyBase, 'attachments', 'a.png'), 'retained');
  const migrated = await ChatStorage.open(legacyBase, legacyTarget);
  assert.equal(migrated.directory, await require('node:fs/promises').realpath(legacyTarget)); assert.equal((await migrated.readArchive(id)).draft, 'legacy');
  assert.equal(await readFile(path.join(legacyTarget, 'attachments', 'a.png'), 'utf8'), 'retained');
  assert.equal(JSON.parse(await readFile(path.join(legacyBase, 'state.json'))).session.draft, 'legacy');
  assert.equal((await ChatStorage.open(legacyBase, portable)).directory, migrated.directory);
});
test('text-only API models and removed Claude connections never claim a pending attachment', async () => {
  for (const provider of ['api', 'claude-cli']) {
    const state = initialState(); Object.assign(state.settings, { provider, cliPath: 'fixture', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro' });
    let captures = 0;
    const chat = new ChatController(state, { save: async () => {} }, () => '', () => {}, undefined, async options => { assert.equal(options.image, undefined); options.onChunk('OK'); }, async () => { captures++; return {}; });
    await chat.send('问题'); while (chat.busy) await tick(); assert.equal(captures, 0);
  }
});
test('manual screenshot works even when the legacy automatic capture setting was off', async () => {
  const state = initialState(); Object.assign(state.settings, { provider: 'codex-cli', cliPath: 'fixture', screenCaptureEnabled: false });
  let captures = 0;
  const chat = new ChatController(state, { save: async () => {} }, () => '', () => {}, undefined, async options => {
    assert.equal(options.image.file, 'manual-image.png'); assert.equal(options.screenNotice, undefined); options.onChunk('OK');
  }, async () => { captures++; return { image: { file: 'manual-image.png', capturedAt: '' } }; });
  await chat.send('文字问题'); while (chat.busy) await tick();
  assert.equal(captures, 1); assert.equal(state.session.messages[0].notice, undefined);
});

test('manual capture reports pending/ready/consumed state and clearing an in-flight request prevents reattachment', async t => {
  const dir = await root(t); let finish;
  const changes = [];
  const screen = new ScreenCapture(() => dir, () => new Promise(resolve => { finish = resolve; }), undefined, () => changes.push(screen.status));
  assert.equal(screen.status, 'empty');
  const request = screen.request(); assert.equal(screen.status, 'capturing'); await tick();
  screen.clear(); finish(Buffer.from('removed')); await request;
  assert.equal(screen.status, 'empty'); assert.deepEqual(await screen.take(), {});
  const next = screen.request(); await tick(); finish(Buffer.from('new')); await next;
  assert.equal(screen.status, 'ready'); assert.ok((await screen.take()).image); assert.equal(screen.status, 'empty');
  assert.deepEqual(changes, ['capturing','empty','capturing','ready','empty']); await screen.close();
});

test('failed manual recapture never reuses the previous image or marks later text-only sends as failed captures', async t => {
  const dir = await root(t); let fail = false;
  const screen = new ScreenCapture(() => dir, async () => { if (fail) throw Error('fixture'); return Buffer.from('old'); });
  await screen.request(); assert.equal(screen.status, 'ready');
  fail = true; assert.ok((await screen.request()).error);
  assert.equal(screen.status, 'empty'); assert.deepEqual(await screen.take(), {}); await screen.close();
});
test('capture defaults off for new users, migrates old users on, and persists an explicit choice', async t => {
  const dir = await root(t), storage = await ChatStorage.open(dir);
  const fresh = (await storage.load()).value;
  assert.equal(fresh.settings.screenCaptureEnabled, false);
  delete fresh.settings.screenCaptureEnabled; await storage.save(fresh);
  const migrated = (await (await ChatStorage.open(dir)).load()).value;
  assert.equal(migrated.settings.screenCaptureEnabled, true);
  const { persistSettingsPatch } = require('../dist/settings');
  const { isState } = require('../dist/model');
  assert.equal(isState({ ...migrated, settings: { ...migrated.settings, screenCaptureEnabled: 'yes' } }), false);
  await persistSettingsPatch(migrated, { screenCaptureEnabled: false }, () => storage.save(migrated));
  assert.equal((await (await ChatStorage.open(dir)).load()).value.settings.screenCaptureEnabled, false);
  const before = migrated.settings;
  await assert.rejects(persistSettingsPatch(migrated, { screenCaptureEnabled: true }, async () => { throw new Error('disk full'); }));
  assert.equal(migrated.settings, before); assert.equal(migrated.settings.screenCaptureEnabled, false);
  assert.throws(() => require('../dist/settings').mergeSettings(migrated.settings, { screenCaptureEnabled: 1 }));
});
