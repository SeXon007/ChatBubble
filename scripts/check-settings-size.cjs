// Hidden native settings window + production compiled lifecycle/resize handlers.
// Synthetic state only; never launch the real ChatBubble application entry.
const { app, BrowserWindow, ipcMain, screen, nativeTheme } = require('electron');
const fs = require('node:fs'), fsp = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), vm = require('node:vm'), ts = require('typescript'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), packaged = process.argv.includes('--packaged');
const version = process.env.CHATBUBBLE_SETTINGS_RUNTIME ? require(path.join(process.env.CHATBUBBLE_SETTINGS_RUNTIME, '../package.json')).version : require('../package.json').version;
const runtime = process.env.CHATBUBBLE_SETTINGS_RUNTIME || path.join(root, packaged ? `release/ChatBubble-${version}-win32-x64/resources/app/dist` : 'dist');
const output = process.env.CHATBUBBLE_SETTINGS_OUTPUT || path.join(root, 'docs/verification/settings-size-0.13.1'), prefix = packaged ? 'packaged-' : 'source-';
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'chatbubble-settings-size-')));
app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  await fsp.mkdir(output, { recursive: true });
  const { initialState } = require(path.join(runtime, 'model')), state = initialState();
  Object.assign(state.settings, { provider: 'codex-cli' }); state.session.source = 'codex-cli';
  const checks = [], layouts = [], errors = [], requests = [], windows = [];
  const check = (name, value) => { assert.ok(value, name); checks.push(name); };
  function HiddenWindow(options) {
    const win = new BrowserWindow({ ...options, show: false, focusable: false, webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false } });
    win.show = () => {}; win.focus = () => {};
    win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => { if (/^https?:/.test(details.url)) { requests.push(details.url); callback({ cancel: true }); } else callback({}); });
    windows.push(win); return win;
  }
  const context = { settingsWindow: null, settingsWindowSize: undefined, settingsManuallySized: false, quitting: false,
    appIcon: path.join(runtime, 'assets/app.ico'), settingsPage: path.join(runtime, 'ui/settings.html'), __dirname: runtime,
    electron_1: { BrowserWindow: HiddenWindow, ipcMain, screen }, node_path_1: { default: path }, window_state_1: require(path.join(runtime, 'window-state')),
    secureWindow: () => {}, flushSettings: async () => true,
    validate: event => { assert.equal(event.sender, context.settingsWindow.webContents); assert.equal(event.senderFrame, context.settingsWindow.webContents.mainFrame); }
  };
  vm.createContext(context);
  const source = ts.createSourceFile('main.js', fs.readFileSync(path.join(runtime, 'main.js'), 'utf8'), ts.ScriptTarget.ES2022, true);
  const opener = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'openSettings');
  vm.runInContext(opener.getText(source), context);
  function visit(n) { if (ts.isCallExpression(n) && /ipcMain.handle$/.test(n.expression.getText(source)) && n.arguments[0]?.text === 'settings:resize') vm.runInContext(n.getText(source), context); ts.forEachChild(n, visit); } visit(source);
  const publicState = () => ({ ...state, busy: false, hasKey: false, warning: '', capture: { available: true, status: 'empty' }, storage: { directory: 'fixture', archiveDirectory: 'fixture', appDirectory: 'fixture' } });
  ipcMain.handle('chat:state', publicState); ipcMain.handle('cli:discover', () => []); ipcMain.handle('cli:models', () => ({ models: [], source: '', fetchedAt: '' }));
  ipcMain.handle('api:presets', () => require(path.join(runtime, 'api-models')).apiPresets);
  ipcMain.handle('settings:save', async (_event, patch) => { Object.assign(state.settings, patch); return { ok: true, error: '' }; });
  ipcMain.handle('app:version', () => ({ version, updateSourceConfigured: false }));
  ipcMain.handle('app:update:state', () => ({ phase: 'idle', message: '点击“检查更新”读取 GitHub 最新版本。' }));
  const js = code => context.settingsWindow.webContents.executeJavaScript(code);
  async function until(predicate, label) { for (let i = 0; i < 200; i++) { if (await predicate()) return; await pause(25); } throw Error('Timeout: ' + label); }
  async function open() { await context.openSettings(); await until(() => js('!!window.flushSettings&&!document.querySelector("#provider").disabled'), 'settings initialized'); await pause(180); }
  async function close() { const win = context.settingsWindow; win.close(); await until(() => win.isDestroyed(), 'settings closed'); }
  async function tab(id) { await js(`document.querySelector('#tab-${id}').click()`); await pause(220); }
  function enlarge() { const win = context.settingsWindow; win.emit('will-resize', {}, { width: 1000, height: 600 }); win.setContentSize(1000, 600); }
  await open(); check('new settings uses 420px default content width', context.settingsWindow.getContentSize()[0] === 420);
  enlarge(); await pause(150); check('manual resize remains usable on current tab', context.settingsWindow.getContentSize()[0] === 1000);
  await close(); await open();
  check('closing and reopening discards the previous large size', context.settingsWindow.getContentSize()[0] === 420);
  for (const theme of ['light', 'dark']) {
    nativeTheme.themeSource = theme;
    for (const id of ['connection', 'chat-options', 'appearance', 'pet-options', 'version']) {
      enlarge(); await pause(30); await tab(id);
      const win = context.settingsWindow, size = win.getContentSize(), area = screen.getDisplayMatching(win.getBounds()).workArea;
      const layout = await js('(()=>{const shell=document.querySelector("#settings-shell"),footer=document.querySelector("footer").getBoundingClientRect();return {width:innerWidth,height:innerHeight,shell:shell.getBoundingClientRect().height,scroll:document.documentElement.scrollWidth,footer:footer.bottom,active:[...document.querySelectorAll("[role=tabpanel]")].filter(e=>!e.hidden).map(e=>e.id)}})()');
      check(theme + ' ' + id + ' restores width and fits visible content', size[0] === 420 && layout.scroll <= layout.width && layout.active.length === 1 && Math.abs(size[1] - Math.max(240, Math.min(Math.ceil(layout.shell), area.height - 80))) <= 2);
      check(theme + ' ' + id + ' stays stable without automatic growth', (await pause(200), win.getContentSize()[0] === size[0] && win.getContentSize()[1] === size[1]));
      layouts.push({ theme, id, size, ...layout });
      await fsp.writeFile(path.join(output, prefix + theme + '-' + id + '.png'), (await win.webContents.capturePage()).toPNG());
    }
  }
  check('short and tall tabs use different suitable heights', new Set(layouts.map(x => x.size[1])).size >= 3);
  enlarge(); await pause(80); await context.openSettings(); await pause(220);
  check('opening an already open settings window also resets its size', context.settingsWindow.getContentSize()[0] === 420);
  const before = context.settingsWindow.getContentSize(); await js('window.desktop.resizeSettings(NaN).catch(()=>{})'); await pause(60);
  check('invalid height is rejected without changing the window', JSON.stringify(before) === JSON.stringify(context.settingsWindow.getContentSize()));
  Object.assign(state.settings, { provider: 'api', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' }); context.settingsWindow.webContents.send('chat:state', publicState());
  await tab('connection'); const apiSize = context.settingsWindow.getContentSize();
  check('API connection content also fits the default width', apiSize[0] === 420 && await js('document.documentElement.scrollWidth<=innerWidth'));
  check('no real network or page errors', requests.length === 0 && errors.length === 0);
  await close();
  await fsp.writeFile(path.join(output, prefix + 'report.json'), JSON.stringify({ version, packaged, checks, layouts, apiSize, errors, requests, limitations: ['Hidden native windows and synthetic state; no physical border dragging', 'Manual-resize event is injected, native dimensions are real', 'No user app or model requests'] }, null, 2));
  console.log(JSON.stringify({ packaged, checks: checks.length, sizes: layouts.map(x => ({ tab: x.id, size: x.size })), errors }));
  for (const win of windows) if (!win.isDestroyed()) win.destroy(); app.quit();
}).catch(async error => { await fsp.mkdir(output, { recursive: true }); await fsp.writeFile(path.join(output, prefix + 'error.txt'), String(error.stack || error)); console.error(error); app.exit(1); });
