const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('node:fs'), fsp = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), vm = require('node:vm'), ts = require('typescript'), assert = require('node:assert/strict'), { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..'), version = require('../package.json').version, packaged = process.argv.includes('--packaged');
const runtime = path.join(root, packaged ? `release/ChatBubble-${version}-win32-x64/resources/app/dist` : 'dist');
const output = path.join(root, 'docs/verification/github-update-0.14.0'), prefix = packaged ? 'packaged-' : 'source-';
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'chatbubble-update-ui-'))); app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  await fsp.mkdir(output, { recursive: true });
  const checks = [], errors = [], requests = [], { Updates } = require(path.join(runtime, 'updates')), { initialState } = require(path.join(runtime, 'model'));
  const state = initialState(); let fail = false, quits = 0;
  const bytes = Buffer.from('fixture download, no executable');
  const release = { tag_name: 'v0.15.0', draft: false, prerelease: false, assets: [{ name: 'ChatBubble-0.15.0-win32-x64.zip', state: 'uploaded', size: bytes.length, digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), browser_download_url: 'https://github.com/SeXon007/ChatBubble/releases/download/v0.15.0/ChatBubble-0.15.0-win32-x64.zip' }] };
  const win = new BrowserWindow({ width: 420, height: 430, useContentSize: true, show: false, focusable: false, webPreferences: { preload: path.join(runtime, 'preload.js'), sandbox: true, contextIsolation: true, offscreen: true, backgroundThrottling: false } });
  win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
  const updates = new Updates({ version, cache: path.join(app.getPath('userData'), 'updates'), changed: () => win.webContents.send('app:update:state', updates.state), prepare: async () => 'fixture-config.json', fetcher: async url => {
    requests.push(url); if (fail) return new Response('', { status: 403 }); return url.includes('api.github.com') ? Response.json(release) : new Response(bytes);
  } });
  const context = { settingsWindow: win, window: undefined, settingsPage: path.join(runtime, 'ui/settings.html'), page: path.join(runtime, 'ui/index.html'), settingsManuallySized: false,
    updates, pendingUpdateLaunch: undefined, closing: false, configuring: false, checking: false, chat: { busy: false }, process: { platform: 'win32' },
    node_url_1: require('node:url'), window_state_1: require(path.join(runtime, 'window-state')), electron_1: { ipcMain, screen, app: { isPackaged: true, getVersion: () => app.getVersion(), quit: () => quits++ } } };
  vm.createContext(context);
  const source = ts.createSourceFile('main.js', fs.readFileSync(path.join(runtime, 'main.js'), 'utf8'), ts.ScriptTarget.ES2022, true);
  const handlers = []; let validator;
  function visit(n) { if (ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(source) === 'validate')) validator = n;
    if (ts.isCallExpression(n) && /ipcMain.handle$/.test(n.expression.getText(source)) && (n.arguments[0]?.text.startsWith('app:') || n.arguments[0]?.text === 'settings:resize')) handlers.push(n); ts.forEachChild(n, visit); } visit(source);
  vm.runInContext(validator.getText(source), context); for (const n of handlers) vm.runInContext(n.getText(source), context);
  ipcMain.handle('chat:state', () => ({ ...state, busy: false, hasKey: false, warning: '', capture: { available: false, status: 'empty' }, storage: { directory: 'fixture', archiveDirectory: 'fixture', appDirectory: 'fixture' } }));
  ipcMain.handle('cli:discover', () => []); ipcMain.handle('cli:models', () => ({ models: [], source: '', fetchedAt: '' })); ipcMain.handle('api:presets', () => require(path.join(runtime, 'api-models')).apiPresets);
  const js = code => win.webContents.executeJavaScript(code), check = (name, value) => { assert.ok(value, name); checks.push(name); };
  async function until(predicate) { for (let i = 0; i < 160; i++) { if (await predicate()) return; await pause(25); } throw Error('update UI timeout'); }
  await win.loadFile(path.join(runtime, 'ui/settings.html')); await until(() => js('!document.querySelector("#provider").disabled'));
  await js('document.querySelector("#tab-version").click()'); await pause(120);
  check('real application version appears '+app.getVersion()+' / '+await js('document.querySelector("#current-version").textContent'), await js(`document.querySelector('#current-version').textContent===${JSON.stringify(version)}`));
  check('opening versions makes no network request and update starts disabled', requests.length === 0 && await js('document.querySelector("#open-update").disabled'));
  await js('document.querySelector("#check-update").click()'); await until(() => updates.state.phase === 'available'); await pause(60);
  check('check finds version and enables update', requests.length === 1 && await js('!document.querySelector("#open-update").disabled&&document.querySelector("#result").textContent.includes("0.15.0")'));
  fail = true; await js('document.querySelector("#check-update").click()'); await until(() => updates.state.phase === 'error'); await pause(60);
  check('network failure is explicit and retry stays available', await js('!document.querySelector("#check-update").disabled&&document.querySelector("#open-update").disabled&&document.querySelector("#result").dataset.error==="true"'));
  fail = false; await js('document.querySelector("#check-update").click()'); await until(() => updates.state.phase === 'available');
  await js('document.querySelector("#open-update").click()'); await until(() => updates.state.phase === 'ready'); await pause(100);
  check('download verifies and offers restart instead of opening a browser', await js('document.querySelector("#open-update").textContent==="重启并更新"&&!document.querySelector("#open-update").disabled'));
  context.chat.busy = true; await js('document.querySelector("#open-update").click()'); await pause(80);
  check('active conversation prevents restart', quits === 0 && await js('document.querySelector("#result").textContent.includes("等待")'));
  context.chat.busy = false; await js('document.querySelector("#open-update").click()'); await pause(80);
  check('restart uses the verified main-owned configuration', quits === 1 && context.pendingUpdateLaunch === 'fixture-config.json');
  await js('document.querySelector("#tab-appearance").click();document.querySelector("#tab-version").click()'); await pause(80);
  check('switching tabs retains update state', await js('document.querySelector("#open-update").textContent==="重启并更新"'));
  check('no page errors', errors.length === 0);
  await fsp.writeFile(path.join(output, prefix + 'update-ui.png'), (await win.webContents.capturePage()).toPNG());
  await fsp.writeFile(path.join(output, prefix + 'ui.json'), JSON.stringify({ version, packaged, checks, errors, requests, quits, limitations: ['Synthetic release/download, no external requests or actual app restart', 'Production compiled IPC, renderer, preload, and real update controller'] }, null, 2));
  console.log(JSON.stringify({ checks: checks.length, errors })); win.destroy(); app.quit();
}).catch(async error => { await fsp.mkdir(output, { recursive: true }); await fsp.writeFile(path.join(output, prefix + 'ui-error.txt'), String(error.stack || error)); console.error(error); app.exit(1); });
