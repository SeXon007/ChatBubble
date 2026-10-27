const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), { createHash } = require('node:crypto');
const { Updates, newerVersion, releaseCandidate } = require('../dist/updates');
const data = Buffer.from('synthetic portable ZIP transport fixture');
function release(version = '0.15.0') { return { tag_name: 'v' + version, draft: false, prerelease: false, assets: [{ name: `ChatBubble-${version}-win32-x64.zip`, state: 'uploaded', size: data.length, digest: 'sha256:' + createHash('sha256').update(data).digest('hex'), browser_download_url: `https://github.com/SeXon007/ChatBubble/releases/download/v${version}/ChatBubble-${version}-win32-x64.zip` }] }; }
async function setup(t, fetcher, prepare = async (_candidate, zip) => { assert.deepEqual(await fs.readFile(zip), data); return 'prepared-config'; }) {
  const cache = await fs.mkdtemp(path.join(os.tmpdir(), 'chatbubble-updates-')); t.after(() => fs.rm(cache, { recursive: true, force: true }));
  const states = []; const updater = new Updates({ version: '0.14.0', cache, fetcher, prepare, changed: () => states.push({ ...updater.state }) });
  return { updater, cache, states };
}
test('version comparison orders numeric components and rejects malformed or downgrade tags', () => {
  assert.ok(newerVersion('0.14.1', '0.14.0')); assert.ok(newerVersion('0.15.0', '0.14.9')); assert.ok(newerVersion('1.14.0', '0.99.99'));
  for (const version of ['0.13.9', '0.14.0', '0.14.1-beta', 'v0.15.0', '0.015.0', '0.15.0/../../x']) assert.equal(newerVersion(version, '0.14.0'), false);
});
test('release selection requires matching ZIP, correct repository, uploaded state, size and checksum', () => {
  assert.equal(releaseCandidate(release(), '0.14.0').version, '0.15.0'); assert.equal(releaseCandidate(release('0.14.0'), '0.14.0'), undefined);
  for (const mutate of [r => r.draft = true, r => r.prerelease = true, r => r.assets[0].digest = null, r => r.assets[0].size = 9999999999,
    r => r.assets[0].browser_download_url = r.assets[0].browser_download_url.replace('/SeXon007/', '/other/'), r => r.assets[0].state = 'new', r => r.assets[0].name = 'setup.exe']) {
    const value = release(); mutate(value); assert.throws(() => releaseCandidate(value, '0.14.0'));
  }
});
test('explicit check handles no release, current version and network failures without false success', async t => {
  for (const [response, phase] of [[new Response('', { status: 404 }), 'idle'], [Response.json(release('0.14.0')), 'current'], [new Response('private error', { status: 403 }), 'error']]) {
    const { updater } = await setup(t, async () => response); assert.equal((await updater.check()).phase, phase); assert.ok(!updater.state.message.includes('private error'));
  }
});
test('download streams bytes, checks SHA256, then prepares a side-by-side version', async t => {
  const requests = [], { updater, states } = await setup(t, async (url, init) => { requests.push({ url, init }); return url.includes('api.github.com') ? Response.json(release()) : new Response(data); });
  assert.equal((await updater.check()).phase, 'available'); assert.equal((await updater.download()).phase, 'ready'); assert.equal(updater.launchConfig, 'prepared-config');
  assert.ok(states.some(s => s.phase === 'downloading' && s.progress === 100)); assert.equal(requests.length, 2);
  assert.ok(requests.every(r => !r.init.headers.Authorization && r.init.redirect === 'manual'));
});
test('bad hashes, truncated and oversized downloads never prepare or restart', async t => {
  for (const body of [Buffer.from('wrong'), Buffer.alloc(data.length, 9), Buffer.alloc(data.length + 1)]) {
    let prepares = 0; const { updater } = await setup(t, async url => url.includes('api.github.com') ? Response.json(release()) : new Response(body), async () => { prepares++; });
    await updater.check(); assert.equal((await updater.download()).phase, 'error'); assert.equal(prepares, 0); assert.equal(updater.launchConfig, undefined);
  }
});
test('only HTTPS redirects to GitHub download hosts are followed', async t => {
  let external = 0;
  const { updater } = await setup(t, async url => {
    if (url.includes('api.github.com')) return Response.json(release());
    if (url.includes('github.com/')) return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
    external++; return new Response(data);
  });
  await updater.check(); assert.equal((await updater.download()).phase, 'error'); assert.equal(external, 0);
});
test('concurrent checks/downloads and cancellation cannot start duplicate installations', async t => {
  let resolve, prepares = 0, calls = 0;
  const { updater } = await setup(t, async (url, init) => {
    calls++; if (url.includes('api.github.com')) return Response.json(release());
    return new Promise((done, reject) => { resolve = done; init.signal.addEventListener('abort', () => reject(Error('abort'))); });
  }, async () => { prepares++; return 'never'; });
  await updater.check(); const pending = updater.download();
  while (!resolve) await new Promise(r => setImmediate(r));
  assert.equal((await updater.download()).phase, 'downloading'); await updater.check(); assert.equal(calls, 2);
  updater.cancel(); assert.equal((await pending).phase, 'error'); assert.equal(prepares, 0);
});
test('oversized release metadata is rejected without preparing an update', async t => {
  const { updater } = await setup(t, async () => new Response('x'.repeat(1024 * 1024 + 1)));
  assert.equal((await updater.check()).phase, 'error');
});

test('production update IPC enforces settings-frame validation and only uses main-owned launch configuration', async () => {
  const vm = require('node:vm'), ts = require('typescript');
  const source = ts.createSourceFile('main.js', await fs.readFile(path.join(__dirname, '../dist/main.js'), 'utf8'), ts.ScriptTarget.ES2022, true);
  const handlers = new Map(); let quits = 0, downloads = 0;
  const context = { validate: event => { if (event !== 'settings') throw Error('Invalid sender'); }, updates: { state: { phase: 'ready', message: 'fixture' }, launchConfig: 'main-owned.json',
    check: () => 'check', download: () => { downloads++; return 'download'; } }, pendingUpdateLaunch: undefined, closing: false, configuring: false, checking: false, chat: { busy: false }, process: { platform: 'win32' },
    electron_1: { app: { isPackaged: true, quit: () => quits++ }, ipcMain: { handle: (key, fn) => handlers.set(key, fn) } } };
  vm.createContext(context);
  function visit(n) { if (ts.isCallExpression(n) && /ipcMain.handle$/.test(n.expression.getText(source)) && n.arguments[0]?.text.startsWith('app:update:')) vm.runInContext(n.getText(source), context); ts.forEachChild(n, visit); } visit(source);
  for (const handler of handlers.values()) assert.throws(() => handler('foreign'), /Invalid sender/);
  context.chat.busy = true; handlers.get('app:update:restart')('settings', 'attacker.json'); assert.equal(quits, 0);
  context.chat.busy = false; handlers.get('app:update:restart')('settings', 'attacker.json'); assert.equal(quits, 1); assert.equal(context.pendingUpdateLaunch, 'main-owned.json');
  context.electron_1.app.isPackaged = false; handlers.get('app:update:download')('settings'); assert.equal(downloads, 0);
});
