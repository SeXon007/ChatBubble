// Real WGC captures with a generated full-screen cover and production ChatBubble UI.
// Verify the cover at 121 points. Evidence is cropped to the generated test region.
const { app, BrowserWindow, ipcMain, nativeImage, screen } = require('electron');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs/promises'), syncFs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm'), ts = require('typescript'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), version = require('../package.json').version, packaged = process.argv.includes('--packaged');
const runtime = process.env.CHATBUBBLE_EXCLUSION_RUNTIME || path.join(root, packaged ? `release/ChatBubble-${version}-win32-x64/resources/app/dist` : 'dist');
const output = process.env.CHATBUBBLE_EXCLUSION_OUTPUT || path.join(root, `docs/verification/capture-exclusion-${version}`), prefix = packaged ? 'packaged-' : 'source-';
app.setPath('userData', syncFs.mkdtempSync(path.join(os.tmpdir(), 'chatbubble-exclusion-')));
app.on('window-all-closed', () => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const handle = win => win.getNativeWindowHandle().readBigUInt64LE().toString();
const probe = (handles, cover, allowed) => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'capture-exclusion-probe.ps1'), '-Handles', handles.join(','), ...(cover ? ['-Cover', cover, '-Allowed', allowed.join(',')] : [])], { encoding: 'utf8', windowsHide: true }).trim());
app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  const checks = [], errors = [], snapshots = [], windows = []; let helper, child, info;
  const check = (name, value) => { assert.ok(value, name); checks.push(name); };
  const { WindowCapture } = require(path.join(runtime, 'windows-capture')), { initialState } = require(path.join(runtime, 'model'));
  try {
    helper = new WindowCapture(); await helper.ready;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chatbubble-exclusion-cover-')), env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(process.execPath, [path.join(__dirname, 'monitor-capture-fixture.cjs'), directory], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let lines = '', diagnostics = '';
    child.stdout.on('data', value => { lines += value; for (const line of lines.split('\n')) { try { const data = JSON.parse(line); if (data.ready) info = data; } catch {} } });
    child.stderr.on('data', value => { diagnostics = (diagnostics + value).slice(-1200); });
    for (let i = 0; i < 150 && !info; i++) await pause(100); assert.ok(info, 'fixture ready ' + diagnostics);
    const backgroundHandles = [info.cover, info.red, info.blue];
    const before = probe(backgroundHandles, info.cover, backgroundHandles);
    check('generated windows cover every sampled monitor point before reading pixels', before.allGridCovered);
    const monitor = { ...helper.monitor }; check('frozen monitor matches generated desktop', monitor.handle === before.monitor);
    const baseline = await helper.captureMonitor(monitor), clean = nativeImage.createFromBuffer(baseline);
    const { width: sw, height: sh } = clean.getSize();
    const evidence = async (name, image) => fs.writeFile(path.join(output, prefix + name + '.png'), nativeImage.createFromBuffer(image).crop({ x: Math.floor(sw*.1), y: Math.floor(sh*.15), width: Math.floor(sw*.78), height: Math.floor(sh*.75) }).toPNG());
    const diff = (a, b, rect) => {
      const aa = nativeImage.createFromBuffer(a).toBitmap(), bb = nativeImage.createFromBuffer(b).toBitmap(); let different = 0, count = 0;
      const x0 = Math.max(0, Math.floor(rect.x * sw)), x1 = Math.min(sw, Math.ceil((rect.x + rect.width) * sw));
      const y0 = Math.max(0, Math.floor(rect.y * sh)), y1 = Math.min(sh, Math.ceil((rect.y + rect.height) * sh));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * sw + x) * 4; count++; if (Math.max(Math.abs(aa[i]-bb[i]), Math.abs(aa[i+1]-bb[i+1]), Math.abs(aa[i+2]-bb[i+2])) > 8) different++; }
      return { different, count, fraction: different / Math.max(1, count) };
    };
    const state = initialState(); Object.assign(state.settings, { provider: 'codex-cli', petWidth: 320, messageHeight: 380 });
    state.session.source = 'codex-cli'; state.session.messages = [{ id: 'fixture', requestId: 'fixture', role: 'assistant', status: 'complete', time: '', content: 'ChatBubble 排除测试：这里是聊天消息。\n'.repeat(24) }];
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()), bounds = display.workArea;
    const source = ts.createSourceFile('main.js', await fs.readFile(path.join(runtime, 'main.js'), 'utf8'), ts.ScriptTarget.ES2022, true);
    let constructor; function visit(n) { if (ts.isBinaryExpression(n) && n.left.getText(source) === 'window' && ts.isNewExpression(n.right)) constructor = n; ts.forEachChild(n, visit); } visit(source);
    const c = { window: undefined, appIcon: path.join(runtime, 'assets/app.ico'), expandedBounds: bounds, __dirname: runtime, node_path_1: { default: path }, electron_1: { BrowserWindow } };
    vm.createContext(c); vm.runInContext(constructor.getText(source), c);
    const win = c.window; windows.push(win);
    const protection = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'secureWindow');
    vm.runInContext(protection.getText(source), c); c.secureWindow(win);
    win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
    const scene = { bounds, areas: [{ ...bounds, id: display.id }], mode: 'expanded', position: { x: bounds.x + bounds.width * .68, y: bounds.y + bounds.height * .82, side: null, displayId: display.id }, options: state.settings };
    const publicState = () => ({ ...state, busy: false, hasKey: false, warning: '', capture: { available: true, status: 'empty' }, storage: { directory: 'fixture', archiveDirectory: 'fixture', appDirectory: 'fixture' } });
    ipcMain.handle('chat:state', publicState); ipcMain.handle('chat:draft', () => {}); ipcMain.handle('desktop:scene', () => scene); ipcMain.handle('desktop:position', () => {});
    ipcMain.handle('desktop:shape', (_event, regions) => win.setShape(regions)); ipcMain.handle('window:mode', () => {});
    ipcMain.handle('cli:discover', () => []); ipcMain.handle('cli:models', () => ({ models: [], source: '', fetchedAt: '' }));
    ipcMain.handle('api:presets', () => require(path.join(runtime, 'api-models')).apiPresets);
    ipcMain.handle('app:version', () => ({ version })); ipcMain.handle('app:update:state', () => ({ phase: 'idle', message: '' })); ipcMain.handle('settings:resize', () => {});
    const js = code => win.webContents.executeJavaScript(code);
    await win.loadFile(path.join(runtime, 'ui/index.html'));
    win.setAlwaysOnTop(true, 'screen-saver'); win.showInactive(); win.moveTop();
    for (let i = 0; i < 200 && !await js('!!window.pet&&window.pet.inspect().morph>.995'); i++) await pause(25);
    check('production chat and input are rendered and visible', await js("!document.querySelector('#chat').hidden&&!document.querySelector('#composer').hidden&&document.querySelectorAll('.message').length===1"));
    const rects = await js("['chat','composer'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return {id,x:r.x,y:r.y,width:r.width,height:r.height}})");
    const toMonitor = rect => ({ x: (bounds.x-info.bounds.x+rect.x)/info.bounds.width, y: (bounds.y-info.bounds.y+rect.y)/info.bounds.height, width: rect.width/info.bounds.width, height: rect.height/info.bounds.height });
    const inspect = () => probe([handle(win)], info.cover, [...backgroundHandles, handle(win)]);
    const first = inspect(); snapshots.push(first);
    check('native main HWND has WDA_EXCLUDEFROMCAPTURE rather than black-mask affinity', first.windows[0].affinityRead && first.windows[0].affinity === 0x11);
    check('main UI stays physically visible and desktop stays covered', first.windows[0].visible && !first.windows[0].iconic && first.allGridCovered);
    const counters = { hide: 0, show: 0, focus: 0, blur: 0 }; for (const name of Object.keys(counters)) win.on(name, () => counters[name]++);
    const take = async (name, regions) => {
      const pre = inspect(), image = await helper.captureMonitor(monitor), post = inspect(); snapshots.push(post);
      check(name + ' does not change foreground or visibility', pre.foreground === post.foreground && post.windows[0].visible && !post.windows[0].iconic);
      for (const rect of regions) { const difference = diff(baseline, image, toMonitor(rect)); check(name + ' reveals original pixels under ' + rect.id, difference.fraction < .001); }
      await evidence(name, image); return image;
    };
    await take('expanded', rects);
    // Negative control: an unprotected, visibly identical UI must appear in WGC.
    win.setContentProtection(false); await pause(200);
    const unprotected = await helper.captureMonitor(monitor);
    check('negative control actually sees the unprotected input strip', diff(baseline, unprotected, toMonitor(rects.find(r => r.id === 'composer'))).fraction > .1);
    check('negative control actually sees the unprotected chat text', diff(baseline, unprotected, toMonitor(rects.find(r => r.id === 'chat'))).fraction > .005);
    await evidence('unprotected-control', unprotected);
    c.secureWindow(win); await pause(200); await take('protected-again', rects);
    win.setIgnoreMouseEvents(true, { forward: true }); win.setIgnoreMouseEvents(false); win.setFocusable(true); win.setFocusable(false);
    check('mouse-routing and focusability changes retain native exclusion', inspect().windows[0].affinity === 0x11);
    await js("window.pet.setMode('collapsed')"); await pause(650);
    const petRect = await js("(()=>{const r=document.querySelector('#cb-pet').getBoundingClientRect();return {id:'pet',x:r.x,y:r.y,width:r.width,height:r.height}})()");
    await take('collapsed-pet', [petRect]);
    const settings = new BrowserWindow({ x: bounds.x + 30, y: bounds.y + 100, width: 420, height: 430, show: false, focusable: false, autoHideMenuBar: true, webPreferences: { preload: path.join(runtime, 'preload.js'), sandbox: true, contextIsolation: true } }); windows.push(settings);
    c.secureWindow(settings); await settings.loadFile(path.join(runtime, 'ui/settings.html')); settings.setAlwaysOnTop(true, 'screen-saver'); settings.showInactive(); settings.moveTop(); await pause(250);
    const settingsProbe = probe([handle(settings)]); check('settings HWND is also visible and natively excluded', settingsProbe.windows[0].visible && settingsProbe.windows[0].affinity === 0x11);
    const settingsImage = await helper.captureMonitor(monitor), sb = settings.getBounds();
    check('settings reveals the original background without black or blank fill', diff(baseline, settingsImage, { x: (sb.x-info.bounds.x+15)/info.bounds.width, y: (sb.y-info.bounds.y+40)/info.bounds.height, width: (sb.width-30)/info.bounds.width, height: (sb.height-55)/info.bounds.height }).fraction < .001);
    const redTarget = { handle: info.red, pid: info.pid, width: 400, height: 300 };
    const selected = nativeImage.createFromBuffer(await helper.capture(redTarget)), pixels = selected.toBitmap(); let red = 0;
    for (let i = 0; i < pixels.length; i += 4) if (Math.max(Math.abs(pixels[i]-64), Math.abs(pixels[i+1]-75), Math.abs(pixels[i+2]-216)) <= 5) red++;
    check('window mode still captures only its external target under own overlays', red/(pixels.length/4) > .995);
    check('capture never hides, shows, focuses or blurs main UI', Object.values(counters).every(value => value === 0));
    check('no renderer errors', errors.length === 0);
    await fs.writeFile(path.join(output, prefix + 'report.json'), JSON.stringify({ version, packaged, checks, counters, errors, snapshots, size: clean.getSize(), windowsVersion: os.release(), limitations: ['Generated cover sampled at 121 points; pixel assertions cover fixture app regions and saved evidence is cropped', 'Other topmost overlays outside test regions are not asserted absent', 'Current Windows/DPI; other OS builds, GPU, remote sessions and physical perception not fully covered', 'Native exclusion also affects other capture tools that honor display affinity'] }, null, 2));
    console.log(JSON.stringify({ packaged, checks: checks.length, counters, errors }));
  } finally {
    for (const win of windows) if (!win.isDestroyed()) win.destroy(); helper?.close(); child?.stdin.write('quit\n'); await pause(300); child?.kill();
  }
  app.quit();
}).catch(async error => { await fs.mkdir(output, { recursive: true }); await fs.writeFile(path.join(output, prefix + 'error.txt'), String(error.stack)); console.error(error); app.exit(1); });
