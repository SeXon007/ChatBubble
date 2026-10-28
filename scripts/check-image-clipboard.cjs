// Real Windows clipboard round-trip through the production manual-capture handler.
// Materialize and restore the prior clipboard in memory; never log or save its contents.
const { app, clipboard, ClipboardItem, nativeImage } = require('electron');
const fs = require('node:fs/promises'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), version = require('../package.json').version, packaged = process.argv.includes('--packaged');
const runtime = path.join(root, packaged ? `release/ChatBubble-${version}-win32-x64/resources/app/dist` : 'dist');
const output = path.join(root, 'docs/verification/chat-optimizations-0.15.0');
app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  const { initialState } = require(path.join(runtime, 'model')), { ScreenCapture } = require(path.join(runtime, 'screen-capture'));
  const directory = await fs.mkdtemp(path.join(output, 'synthetic-capture-'));
  const png = nativeImage.createFromBitmap(Buffer.from([0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 255, 255, 255, 255]), { width: 2, height: 2 }).toPNG();
  const original = [];
  for (const item of await clipboard.read()) {
    const data = {};
    for (const type of item.types) data[type] = await item.getType(type);
    original.push(new ClipboardItem(data));
  }
  const manager = new ScreenCapture(() => directory, async () => png);
  const c = { Blob, Uint8Array, state: initialState(), mode: 'expanded', smoke: false, restartMode: undefined, configuring: false, closing: false, chat: { busy: false },
    screenCapture: manager, api_capabilities_1: { captureCapability: () => ({ available: true }) }, electron_1: { clipboard, ClipboardItem, nativeImage } };
  const source = ts.createSourceFile('main.js', await fs.readFile(path.join(runtime, 'main.js'), 'utf8'), ts.ScriptTarget.ES2022, true);
  const handler = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'requestScreenCapture');
  vm.createContext(c); vm.runInContext(handler.getText(source), c);
  let touched = false;
  try {
    touched = true;
    const result = await c.requestScreenCapture(); assert.equal(result.ok, true); assert.equal(result.error, '');
    assert.equal(await clipboard.has('image/png'), true);
    const items = await clipboard.read(), item = items.find(item => item.types.includes('image/png'));
    const copied = Buffer.from(await (await item.getType('image/png')).arrayBuffer());
    assert.deepEqual(nativeImage.createFromBuffer(copied).getSize(), { width: 2, height: 2 });
    assert.deepEqual(nativeImage.createFromBuffer(copied).toBitmap(), nativeImage.createFromBuffer(png).toBitmap());
    assert.equal(manager.status, 'ready');
    await fs.writeFile(path.join(output, (packaged ? 'packaged-' : 'source-') + 'clipboard.json'), JSON.stringify({ version, packaged, checks: ['production capture succeeds', 'OS clipboard advertises image/png', 'copied dimensions match', 'copied pixels match', 'attachment remains ready'], userClipboardContentsLogged: false }, null, 2));
  } finally {
    if (touched) { if (original.length) await clipboard.write(original); else clipboard.clear(); }
    await manager.close();
  }
  console.log(JSON.stringify({ packaged, checks: 5, clipboardRestored: true })); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
