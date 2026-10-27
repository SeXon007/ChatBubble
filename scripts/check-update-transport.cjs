// Real Electron request transport against an owned loopback HTTP service.
const { app } = require('electron');
const http = require('node:http'), path = require('node:path'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os');
const runtime = process.env.CHATBUBBLE_UPDATE_RUNTIME || path.resolve(__dirname, '../dist');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'chatbubble-transport-')));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const { updateFetch } = require(path.join(runtime, 'update-fetch')); let targets = 0;
  const server = http.createServer((request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { Location: '/target' }); response.end(); }
    else if (request.url === '/target') { targets++; response.end('target'); }
    else if (request.url === '/stream') { response.writeHead(200); response.write('first'); setTimeout(() => response.end('second'), 30); }
    else { request.on('close', () => response.destroy()); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const redirect = await updateFetch(base + '/redirect', { redirect: 'manual' });
    assert.equal(redirect.status, 302); assert.ok(redirect.headers.get('location').endsWith('/target')); assert.equal(targets, 0);
    const followed = await updateFetch(base + '/target'); assert.equal(await followed.text(), 'target'); assert.equal(targets, 1);
    const stream = await updateFetch(base + '/stream'); assert.equal(await stream.text(), 'firstsecond');
    const controller = new AbortController(), aborted = updateFetch(base + '/hang', { signal: controller.signal }); setTimeout(() => controller.abort(), 30);
    await assert.rejects(aborted, /aborted/);
    console.log(JSON.stringify({ checks: 4, result: 'passed', limitations: 'Owned HTTP service; no public requests' }));
  } finally { await new Promise(resolve => server.close(resolve)); }
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
