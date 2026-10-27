// Hidden production UI + actual main-process handlers, with synthetic credentials
// and an in-memory model service. Never launch the user's application entry point.
const { app, BrowserWindow, ipcMain, nativeTheme, screen } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), packaged = process.argv.includes('--packaged');
const runtime = path.join(root, packaged ? 'release/ChatBubble-0.8.4-win32-x64/resources/app/dist' : 'dist');
const fixes = process.argv.includes('--fixes');
const output = path.join(root, fixes ? 'docs/verification/settings-drag-models' : 'docs/verification/api-settings');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'chatbubble-api-settings-')));
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const { initialState } = require(path.join(runtime, 'model'));
  const { ChatStorage } = require(path.join(runtime, 'chat-storage'));
  const { persistSettingsPatch } = require(path.join(runtime, 'settings'));
  const { endpoint } = require(path.join(runtime, 'provider'));
  const { apiPresets, listApiModels } = require(path.join(runtime, 'api-models'));
  const { clampBounds } = require(path.join(runtime, 'window-state'));
  const state = initialState(), storage = await ChatStorage.open(app.getPath('userData'));
  const vault = { value: '', endpoint: '', forEndpoint(url) { return url === this.endpoint ? this.value : ''; }, async save(key, url) { this.value = key; this.endpoint = url; } };
  const requests = []; let holdDeepseek = false, finishDeepseek, failModels = false, modelRows;
  const fetcher = async (url, options) => {
    requests.push({ url, key: options.headers.Authorization, method: options.method });
    if (holdDeepseek && url.includes('deepseek')) return new Promise(resolve => { finishDeepseek = () => resolve(Response.json({ data: [{ id: 'stale-model' }] })); });
    if (failModels) return new Response('never expose provider details', { status: 401 });
    const model = url.includes('deepseek') ? 'deepseek-fixture' : url.includes('moonshot') ? 'kimi-fixture' : 'local-fixture';
    return Response.json({ data: modelRows ?? [{ id: model }] });
  };
  const publicState = () => ({ ...state, busy: false, warning: '', hasKey: !!vault.forEndpoint(state.settings.baseUrl), storage: { directory: storage.directory, archiveDirectory: storage.archiveDirectory, appDirectory: app.getPath('userData') } });
  function HiddenWindow(options) {
    const target = new BrowserWindow({ ...options, focusable: false, webPreferences: { ...options.webPreferences, backgroundThrottling: false } });
    target.show = () => {}; target.focus = () => {}; return target;
  }
  const context = {
    BrowserWindow: HiddenWindow, path, __dirname: runtime, appIcon: path.join(runtime, 'assets/app.ico'), settingsPage: path.join(runtime, 'ui/settings.html'),
    settingsWindow: null, settingsWindowSize: undefined, settingsManuallySized: false, quitting: false,
    secureWindow: () => {}, flushSettings: async () => true, ipcMain, validate: () => {}, apiPresets, listApiModels, fetcher,
    state, vault, persistSettingsPatch, endpoint, configuring: false, closing: false, checking: false, flushingSettings: false,
    chat: { busy: false, persist: () => storage.save(state) }, screenCapture: { clear: () => {} }, nativeCapture: undefined,
    smoke: true, restartMode: undefined, screen, clampBounds,
    broadcast: () => { if (context.settingsWindow) context.settingsWindow.webContents.send('chat:state', publicState()); }
  };
  const source = ts.createSourceFile('main.ts', fs.readFileSync(path.join(root, 'src/main.ts'), 'utf8'), ts.ScriptTarget.ES2022, true);
  const opener = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'openSettings');
  const calls = new Map();
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'ipcMain.handle' && ts.isStringLiteral(node.arguments[0])) calls.set(node.arguments[0].text, node);
    ts.forEachChild(node, visit);
  }
  visit(source); vm.createContext(context);
  const run = code => vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  for (const channel of ['settings:resize', 'settings:save', 'api:presets', 'api:models']) { assert.ok(calls.has(channel)); run(calls.get(channel).getText(source)); }
  run(opener.getText(source));
  ipcMain.handle('chat:state', publicState); ipcMain.handle('cli:models', () => ({ models: [], source: '', fetchedAt: '' })); ipcMain.handle('cli:discover', () => []);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => context.settingsWindow.webContents.executeJavaScript(code);
  async function until(condition) { for (let i = 0; i < 200; i++) { if (await condition()) return; await pause(20); } throw new Error('API settings check timeout'); }
  async function open() { await context.openSettings(); await until(() => js('!!window.flushSettings && !document.querySelector("#provider").disabled')); }
  async function choose(id, value) { assert.equal(await js(`(async()=>{const e=document.getElementById(${JSON.stringify(id)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change'));return window.flushSettings()})()`), true); }
  async function key(value) { assert.equal(await js(`(async()=>{const e=document.querySelector('#key');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input'));e.dispatchEvent(new Event('blur'));return window.flushSettings()})()`), true); }
  await open();
  assert.equal(context.settingsWindow.isResizable(), true); assert.equal(context.settingsWindow.isMaximizable(), true);
  assert.equal(context.settingsWindow.getContentSize()[0], 420);
  assert.deepEqual(await js('[...document.querySelector("#api-service").options].map(o=>o.textContent)'), ['自定义', 'DeepSeek', 'Kimi', '智谱 GLM']);
  await choose('api-service', 'deepseek'); assert.equal(state.settings.baseUrl, apiPresets[0].baseUrl); assert.equal(requests.length, 0);
  await key('fixture-deepseek-key');
  await until(() => js('[...document.querySelector("#api-model-choice").options].some(o=>o.value==="deepseek-fixture")'));
  await choose('api-model-choice', 'deepseek-fixture'); assert.equal(state.settings.model, 'deepseek-fixture');
  assert.equal((await storage.load()).value.settings.model, 'deepseek-fixture');
  holdDeepseek = true; await js('document.querySelector("#api-model-refresh").click()'); await until(() => !!finishDeepseek);
  await choose('api-service', 'kimi'); assert.equal(state.settings.model, '');
  finishDeepseek(); holdDeepseek = false; await pause(100);
  assert.equal(await js('[...document.querySelector("#api-model-choice").options].some(o=>o.value==="stale-model")'), false);
  await key('fixture-kimi-key'); await until(() => js('[...document.querySelector("#api-model-choice").options].some(o=>o.value==="kimi-fixture")'));
  assert.ok(requests.filter(r => r.url.includes('moonshot')).every(r => r.key === 'Bearer fixture-kimi-key'));
  const beforeGlm = requests.length;
  await choose('api-service', 'zhipu'); await key('fixture-glm-key'); await pause(50);
  assert.equal(requests.length, beforeGlm); assert.match(await js('document.querySelector("#api-model-choice").title'), /候选/);
  await choose('api-service', 'custom');
  assert.equal(await js(`(async()=>{const e=document.querySelector('#baseUrl');e.value='http://127.0.0.1:1234/v1';e.dispatchEvent(new Event('input'));return window.flushSettings()})()`), true);
  await js('document.querySelector("#api-model-refresh").click()'); await until(() => js('[...document.querySelector("#api-model-choice").options].some(o=>o.value==="local-fixture")'));
  assert.equal(requests.at(-1).key, undefined);
  await choose('api-model-choice', '__custom__');
  assert.equal(await js(`(async()=>{const e=document.querySelector('#model');e.value='manual-fixture';e.dispatchEvent(new Event('input'));return window.flushSettings()})()`), true);
  failModels = true; await js('document.querySelector("#api-model-refresh").click()'); await pause(100);
  assert.equal(state.settings.model, 'manual-fixture'); assert.equal(await js('document.querySelector("#model").value'), 'manual-fixture');
  failModels = false;
  await assert.rejects(js('window.desktop.getApiModels("https://different.test/v1")'), /服务地址已改变/);
  assert.ok(requests.every(r => r.method === 'GET'));
  // Return to a clean, representative preset for visual checks, with no real key.
  await choose('api-service', 'deepseek'); await choose('api-model-choice', 'deepseek-flash');
  nativeTheme.themeSource = 'light'; await until(() => js('!matchMedia("(prefers-color-scheme:dark)").matches'));
  const frames = () => js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await frames(); await fsp.mkdir(output, { recursive: true });
  await fsp.writeFile(path.join(output, packaged ? 'packaged-api-default.png' : 'api-default.png'), (await context.settingsWindow.webContents.capturePage()).toPNG());
  context.settingsWindow.emit('will-resize'); context.settingsWindow.setContentSize(620, 500); await pause(80);
  await js('document.querySelector("#tab-pet-options").click()'); await frames();
  assert.deepEqual(context.settingsWindow.getContentSize(), [620, 500]);
  await js('document.querySelector("#tab-chat-options").click()'); await frames();
  assert.deepEqual(context.settingsWindow.getContentSize(), [620, 500]);
  await js('document.querySelector("#tab-connection").click()'); nativeTheme.themeSource = 'dark';
  await until(() => js('matchMedia("(prefers-color-scheme:dark)").matches')); await frames();
  await fsp.writeFile(path.join(output, packaged ? 'packaged-api-resized.png' : 'api-resized.png'), (await context.settingsWindow.webContents.capturePage()).toPNG());
  context.settingsWindow.destroy(); await until(() => context.settingsWindow === null); await open(); await frames();
  assert.deepEqual(context.settingsWindow.getContentSize(), [620, 500]);
  context.settingsWindow.emit('will-resize'); context.settingsWindow.setContentSize(360, 260); await frames();
  assert.equal(await js('document.documentElement.scrollWidth<=document.documentElement.clientWidth'), true);
  let fixesReport;
  if (fixes) {
    // Representative fallback shows the official dated release, but selection
    // saves the API ID; a live response must retain its own official name.
    await choose('api-service', 'deepseek'); await choose('api-model-choice', 'deepseek-flash');
    assert.match(await js('document.querySelector("#api-model-choice").selectedOptions[0].textContent'), /DeepSeek-V4.1-Flash-1017/);
    assert.deepEqual(await js('[...document.querySelector("#apiReasoningEffort").options].map(o=>o.value)'), ['', 'none', 'low', 'high', 'max']);
    await choose('apiReasoningEffort', 'max'); assert.equal(state.settings.apiReasoningEffort, 'max');
    assert.equal((await (await ChatStorage.open(app.getPath('userData'))).load()).value.settings.apiReasoningEffort, 'max');
    await choose('api-model-choice', 'deepseek-v4-pro'); assert.equal(state.settings.apiReasoningEffort, '');
    await js('document.querySelector("#tab-appearance").click()');
    assert.equal(await js(`(async()=>{const e=document.querySelector('#textColor');e.value='#5c38cc';e.dispatchEvent(new Event('input'));e.dispatchEvent(new Event('change'));return window.flushSettings()})()`), true);
    assert.equal(state.settings.textColor, '#5c38cc');
    assert.equal((await (await ChatStorage.open(app.getPath('userData'))).load()).value.settings.textColor, '#5c38cc');
    const layouts = [];
    for (const [width, height] of [[360,260],[620,500],[1600,960]]) {
      context.settingsWindow.setContentSize(width, height); await pause(80); await frames();
      for (const theme of ['light', 'dark']) {
        nativeTheme.themeSource = theme; await until(() => js(`matchMedia('(prefers-color-scheme:dark)').matches===${theme==='dark'}`));
        for (const panel of ['connection','chat-options','appearance','pet-options']) {
          await js(`document.querySelector('#tab-${panel}').click()`); await frames();
          const metrics = await js(`({font:parseFloat(getComputedStyle(document.documentElement).fontSize),control:document.querySelector('#fontSize').getBoundingClientRect().height,shell:document.querySelector('#settings-shell').getBoundingClientRect().width,fits:document.documentElement.scrollWidth<=document.documentElement.clientWidth})`);
          assert.equal(metrics.fits, true); layouts.push({ width, height, theme, panel, ...metrics });
          if (width === 1600 || (width === 360 && panel === 'appearance')) await fsp.writeFile(path.join(output, `${packaged?'packaged-':''}${theme}-${width}-${panel}.png`), (await context.settingsWindow.webContents.capturePage()).toPNG());
        }
      }
    }
    assert.ok(layouts.find(l=>l.width===1600&&l.panel==='appearance').control > layouts.find(l=>l.width===360&&l.panel==='appearance').control);
    await js('document.querySelector("#tab-appearance").click()');
    assert.equal(await js('document.querySelector("#textColor").value'), '#5c38cc');
    modelRows = Array.from({length:6},(_,i)=>({id:`release-${i}`,name:`厂商名称 ${i}`,created:1000+i}));
    vault.value='fixture-key';vault.endpoint=state.settings.baseUrl;
    context.broadcast();await js('document.querySelector("#tab-connection").click()');
    await until(()=>js('[...document.querySelector("#api-model-choice").options].some(o=>o.value==="release-5")'));
    assert.deepEqual(await js('[...document.querySelector("#api-model-choice").options].map(o=>o.value)'),['','release-5','release-4','release-3','release-2','deepseek-v4-pro','__custom__']);
    assert.equal(await js('document.querySelector("#api-model-choice").value'),'deepseek-v4-pro');
    await choose('api-model-choice','release-5');assert.equal(state.settings.model,'release-5');
    assert.equal(await js('document.querySelector("#api-model-choice").selectedOptions[0].textContent'),'厂商名称 5');
    modelRows.push({id:'new-published',name:'新发布模型',created:2000});
    await js('document.querySelector("#api-model-refresh").click()');await until(()=>js('document.querySelector("#api-model-choice").options[1].value==="new-published"'));
    assert.equal(state.settings.model,'release-5');
    fixesReport = { layouts, textColorSavedAndReloaded: true, apiEffortSavedAndReloaded: true, officialFallbackLabelKeepsApiId: true,
      chronologicalTopFour:true, currentSelectionPreserved:true, refreshFindsNewRelease:true, officialDisplayNameSavedAsApiId:true };
  }
  const report = { packagedUI: packaged, realMainFunctionsWithFixtureServices: true, presetCount: 3, automaticModelsAfterKey: true, staleModelsDiscarded: true,
    keyBoundToSelectedService: true, glmUsesExplicitCandidates: true, customAndManualFallback: true, metadataRequestsOnly: true,
    resizable: true, maximizable: true, defaultWidth: 420, manualSizeSurvivesTabAndReopen: [620, 500], minimumWidthFits: true, modelRequests: requests.length,
    fixesReport, limitations: ['No real service key or paid model request used', 'Fixture credentials are in memory; production vault encryption is unchanged', 'Window drag is represented by the real will-resize event, not physical mouse input'] };
  await fsp.writeFile(path.join(output, packaged ? 'packaged-report.json' : 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); context.settingsWindow.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
