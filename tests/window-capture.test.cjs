const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { WindowCapture } = require('../dist/windows-capture');
const { ScreenCapture } = require('../dist/screen-capture');
const { captureNotice } = require('../dist/capture-errors');
const fs = require('node:fs/promises');
const os = require('node:os');
test('production capture must never ask another application to repaint', async () => {
  const native = await fs.readFile(path.join(__dirname, '../src/native/window-target.ps1'), 'utf8');
  const frames = await fs.readFile(path.join(__dirname, '../src/native/window-frame.cs'), 'utf8');
  assert.doesNotMatch(native + frames, /\b(?:PrintWindow|SendMessage|SendMessageTimeout)\s*\(/);
});
function fixture(t, mode) {
  const capture = new WindowCapture({ executable: process.execPath, args: [path.join(__dirname, 'fixtures/window-capture-helper.cjs'), mode], startupTimeoutMs: 3000, captureTimeoutMs: mode === 'hang' ? 100 : 1000 });
  t.after(() => capture.close()); return capture;
}
test('cold expansion waits for initial target instead of freezing an empty target', async t => {
  const capture = fixture(t, 'delayed');
  const take = capture.prepareCapture();
  assert.equal(capture.target, null);
  assert.equal((await take())[0], 101);
  assert.equal((await capture.capture())[0], 101);
});
test('warm expansion keeps the selected window even if foreground changes before capture', async t => {
  const capture = fixture(t, 'ready'); await capture.ready;
  const take = capture.prepareCapture(); capture.child.stdin.write('change\n');
  while (capture.target.handle !== '202') await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await take())[0], 101); assert.equal((await capture.capture())[0], 202);
});
test('blank images keep their specific failure reason rather than becoming generic failures', async t => {
  const capture = fixture(t, 'blank');
  await assert.rejects(capture.capture(), error => error.code === 'blank-image');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chatbubble-capture-error-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const screen = new ScreenCapture(() => directory, () => capture.capture());
  screen.request(); const result = await screen.take();
  assert.equal(result.image, undefined); assert.equal(result.error, captureNotice('blank-image')); await screen.close();
});
test('a blocked helper is closed by the deadline; a restarted helper can capture immediately', async t => {
  const blocked = fixture(t, 'hang');
  await assert.rejects(blocked.capture(), error => error.code === 'capture-timeout');
  assert.equal(blocked.isClosed, true);
  const restarted = fixture(t, 'delayed'); assert.equal((await restarted.prepareCapture()())[0], 101);
});
test('helper process exit is distinct from an unavailable or blank target', async t => {
  const capture = fixture(t, 'exit');
  await assert.rejects(capture.capture(), error => error.code === 'helper-closed');
});

test('cold screen request waits for the initial monitor identity without requiring a window target', async t => {
  const capture = fixture(t, 'delayed');
  const take = capture.prepareCapture('screen');
  assert.equal(capture.monitor, null);
  assert.equal((await take())[0], 301 % 256);
  capture.target = null;
  assert.equal((await capture.captureMonitor())[0], 301 % 256);
});

test('screen requests keep their selected monitor while later requests follow monitor changes', async t => {
  const capture = fixture(t, 'ready'); await capture.ready;
  const take = capture.prepareCapture('screen'); capture.child.stdin.write('change\n');
  while (capture.monitor.handle !== '302') await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await take())[0], 301 % 256);
  assert.equal((await capture.captureMonitor())[0], 302 % 256);
  assert.equal((await capture.prepareCapture('window')())[0], 202);
});

test('an invalid monitor fails without falling back to a window or another display', async t => {
  const capture = fixture(t, 'ready'); await capture.ready;
  for (const monitor of [null, {handle:'invalid',width:1920,height:1080}, {handle:'301',width:0,height:1080}]) {
    await assert.rejects(capture.captureMonitor(monitor), error => error.code === 'no-target');
  }
});

test('screen capture retains the existing helper deadline and recovery behavior', async t => {
  const capture = fixture(t, 'hang');
  await assert.rejects(capture.prepareCapture('screen')(), error => error.code === 'capture-timeout');
  assert.equal(capture.isClosed, true);
});
