// Hidden real settings/preload + compiled production IPC. No real models or clients.
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const fs = require('node:fs'), fsp = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const vm = require('node:vm'), ts = require('typescript'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), version = require('../package.json').version, packaged = process.argv.includes('--packaged');
const runtime = path.join(root, packaged ? `release/ChatBubble-${version}-win32-x64/resources/app/dist` : 'dist');
const output = process.env.CHATBUBBLE_HISTORY_OUTPUT || path.join(root, 'docs/verification/history-isolation-0.12.0'), prefix = packaged ? 'packaged-' : 'source-';
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'chatbubble-source-ui-')));
app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  await fsp.mkdir(output, { recursive: true });
  const model = require(path.join(runtime, 'model')), sources = require(path.join(runtime, 'conversation-source'));
  const { ChatStorage } = require(path.join(runtime, 'chat-storage')), { ChatController } = require(path.join(runtime, 'chat'));
  const settings = require(path.join(runtime, 'settings')), clients = require(path.join(runtime, 'desktop-client'));
  const presets = require(path.join(runtime, 'api-models')).apiPresets;
  const store = await ChatStorage.open(app.getPath('userData')), checks = [], errors = [], requests = [], launches = [], urls = [], dialogs = [];
  const id = '11111111-1111-4111-8111-111111111111';
  function seed(provider, baseUrl, text) {
    const s = model.initialState(); Object.assign(s.settings, { provider, baseUrl, model: 'fixture' });
    s.session.source = sources.conversationSource(s.settings);
    s.session.messages.push({ id: 'u', role: 'user', content: text, status: 'complete', requestId: 'r', time: '' },
      { id: 'a', role: 'assistant', content: '合成回答', status: 'complete', requestId: 'r', time: '' });
    if (provider === 'codex-cli') {
      s.session.codex = { threadId: id, home: store.directory, cwd: store.directory };
      for (const m of s.session.messages) m.codexTurnId = id;
    }
    return s;
  }
  const states = { codex: seed('codex-cli', '', 'CODEX ONLY'), deepseek: seed('api', presets[0].baseUrl, 'DEEPSEEK ONLY'),
    kimi: seed('api', presets[1].baseUrl, 'KIMI ONLY'), zhipu: seed('api', presets[2].baseUrl, 'ZHIPU ONLY'),
    custom: seed('api', 'https://custom.example.test/v1', 'CUSTOM ONLY') };
  const archiveIds = {};
  for (const [key, value] of Object.entries(states)) archiveIds[key] = await store.archive(value);
  const unknown = seed('api', presets[0].baseUrl, 'UNKNOWN LEGACY'); delete unknown.session.source; await store.archive(unknown);
  await store.archive(seed('claude-cli', '', 'REMOVED CLAUDE'));
  const state = structuredClone(states.codex); state.session.draft = 'CODEX UNSENT'; await store.save(state);
  const win = new BrowserWindow({ show: false, focusable: false, width: 560, height: 620, useContentSize: true,
    webPreferences: { preload: path.join(runtime, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const other = new BrowserWindow({ show: false, focusable: false, webPreferences: { preload: path.join(runtime, 'preload.js'), sandbox: true, contextIsolation: true } });
  win.webContents.on('console-message', (_event, details) => { if (details?.level === 'error') errors.push(details.message); });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => { if (/^https?:/.test(details.url)) { requests.push(details.url); callback({ cancel: true }); } else callback({}); });
  const publicState = () => ({ ...state, busy: chat.busy, warning: '', hasKey: false, capture: { available: state.settings.provider === 'codex-cli', status: 'empty' },
    storage: { directory: store.directory, archiveDirectory: store.archiveDirectory, appDirectory: app.getPath('userData') } });
  const broadcast = () => win.webContents.send('chat:state', publicState());
  const generated = [];
  const chat = new ChatController(state, store, () => '', broadcast, undefined, async options => {
    generated.push({ source: sources.conversationSource(options.settings), messages: options.messages }); options.onChunk('LOCAL FIXTURE ANSWER');
  });
  const context = { state, store, chat, settingsWindow: win, window: other, configuring: false, closing: false, checking: false,
    flushingSettings: false, smoke: true, restartMode: undefined, nativeCapture: undefined, broadcast, screenCapture: { status: 'empty', clear: () => {} },
    saveTimer: undefined, recoveryWarning: '', scheduleSave: () => {}, settingsPage: path.join(runtime, 'ui/settings.html'), page: path.join(runtime, 'ui/index.html'),
    desktopShortcutRoots: () => [], publicState, captureCapability: require(path.join(runtime, 'api-capabilities')).captureCapability,
    api_capabilities_1: require(path.join(runtime, 'api-capabilities')), settings_1: settings, model_1: model, conversation_source_1: sources,
    window_state_1: require(path.join(runtime, 'window-state')), node_url_1: require('node:url'),
    desktop_client_1: { ...clients, locateDesktopClient: async vendor => path.join(store.directory, clients.desktopClientName(vendor) + '.exe') },
    electron_1: { ipcMain, shell: { openExternal: async url => { urls.push(url); }, readShortcutLink: () => {}, openPath: async file => { launches.push(path.basename(file)); return ''; } },
      dialog: { showMessageBox: async (_window, options) => { dialogs.push(options.message); return { response: 1 }; } } } };
  vm.createContext(context);
  const source = ts.createSourceFile('main.js', fs.readFileSync(path.join(runtime, 'main.js'), 'utf8'), ts.ScriptTarget.ES2022, true);
  const wanted = ['settings:save', 'archives:list', 'archives:read', 'archives:restore', 'codex:open', 'client:status', 'client:open', 'chat:submit', 'chat:draft'];
  let validation;
  function visit(node) {
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(source) === 'validate')) validation = node;
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'electron_1.ipcMain.handle' && wanted.includes(node.arguments[0]?.text))
      vm.runInContext(node.getText(source), context);
    ts.forEachChild(node, visit);
  }
  visit(source); assert.ok(validation); vm.runInContext(validation.getText(source), context);
  ipcMain.handle('chat:state', publicState); ipcMain.handle('cli:discover', () => []); ipcMain.handle('cli:models', () => ({ models: [], source: '', fetchedAt: '' }));
  ipcMain.handle('api:presets', () => presets); ipcMain.handle('settings:resize', () => {}); ipcMain.handle('app:version', () => version);
  const js = code => win.webContents.executeJavaScript(code), check = (name, result) => { assert.ok(result, name); checks.push(name); };
  async function until(condition) { for (let i = 0; i < 250; i++) { if (await condition()) return; await pause(20); } throw Error('UI check timeout'); }
  async function choose(id, value) { assert.equal(await js(`(async()=>{const el=document.getElementById(${JSON.stringify(id)});el.value=${JSON.stringify(value)};if(el.tagName!=='SELECT')el.dispatchEvent(new Event('input'));el.dispatchEvent(new Event('change'));return window.flushSettings()})()`), true); }
  async function close() { await js('document.querySelector("#close-history").click()'); }
  async function show(expectedId) {
    await js('document.querySelector("#tab-chat-options").click();document.querySelector("#history").click()');
    await until(() => js(`Array.from(document.querySelector('#archive-list').options).some(o=>o.value===${JSON.stringify(expectedId)})`));
  }
  async function image(name) { await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await fsp.writeFile(path.join(output, prefix + name + '.png'), (await win.webContents.capturePage()).toPNG()); }
  await win.loadFile(context.settingsPage); await until(() => js('!!window.flushSettings&&!document.querySelector("#provider").disabled'));
  check('only Codex CLI and API are selectable', await js('JSON.stringify(Array.from(document.querySelector("#provider").options,o=>o.value))') === JSON.stringify(['codex-cli', 'api']));
  await show(archiveIds.codex);
  check('Codex list excludes API and removed-provider histories', await js('document.querySelector("#archive-list").options.length') === 2);
  check('ambiguous old history is preserved with a notice', await js('document.querySelector("#archive-status").textContent.includes("来源未分类")'));
  await js('document.querySelector("#open-codex").click()'); await until(() => Promise.resolve(urls.length === 1));
  check('current native conversation opens its owned Codex URL', urls[0] === 'codex://threads/' + id); await image('codex'); await close();
  const oldSessionId = state.session.id;
  await js('document.querySelector("#tab-connection").click()'); await choose('provider', 'api');
  // The first API selection is unconfigured; selecting a service sets its source.
  await choose('api-service', 'deepseek'); await show(archiveIds.deepseek);
  check('provider switch creates empty context and clears native binding and draft', state.session.id !== oldSessionId && !state.session.messages.length && !state.session.draft && !state.session.codex && state.session.source === 'api:deepseek');
  check('DeepSeek list shows only DeepSeek history', await js('document.querySelector("#archive-list").options.length') === 2);
  check('Codex draft was archived under Codex', (await store.list('codex-cli')).items.length === 2);
  check('foreign archive cannot be previewed through IPC', await js(`window.desktop.readArchive(${JSON.stringify(archiveIds.codex)}).then(()=>false,()=>true)`));
  const beforeForeign = state.session.id, dialogCount = dialogs.length;
  check('foreign archive restore is refused before confirmation', !await js(`window.desktop.restoreArchive(${JSON.stringify(archiveIds.codex)}).then(r=>r.ok)`) && state.session.id === beforeForeign && dialogs.length === dialogCount);
  check('API cannot open a Codex archive', !await js(`window.desktop.openCodex(${JSON.stringify(archiveIds.codex)}).then(r=>r.ok)`) && urls.length === 1);
  const currentId = state.session.id;
  check('late old-session submit is rejected', !await js(`window.desktop.submit('OLD QUESTION',${JSON.stringify(oldSessionId)}).then(r=>r.ok)`));
  await js(`window.desktop.saveDraft('OLD DRAFT',${JSON.stringify(oldSessionId)})`);
  check('late old-session draft is ignored', state.session.draft === '');
  await js('window.desktop.saveSettings({model:"fixture-other"})');
  check('same-service model change keeps the current session', state.session.id === currentId);
  check('new API question reaches only its own fresh context', await js(`window.desktop.submit('DEEPSEEK NEW QUESTION',${JSON.stringify(currentId)}).then(r=>r.ok)`));
  await until(() => Promise.resolve(!chat.busy));
  check('previous-provider text is absent from API request', generated.length === 1 && generated[0].source === 'api:deepseek' && !JSON.stringify(generated[0].messages).includes('CODEX'));
  await js(`window.desktop.saveDraft('DEEPSEEK UNSENT',${JSON.stringify(currentId)})`); await image('deepseek'); await close();
  for (const key of ['kimi', 'zhipu']) {
    await js('document.querySelector("#tab-connection").click()'); await choose('api-service', key); await show(archiveIds[key]);
    check(key + ' history is isolated', state.session.source === 'api:' + key && await js('document.querySelector("#archive-list").options.length') === 2);
    if (key === 'zhipu') check('GLM vision model is selectable without manual entry', await js('[...document.querySelector("#api-model-choice").options].some(o=>o.value==="glm-4.6v-flash"&&o.textContent.includes("识图"))'));
    await until(() => js('!!document.querySelector("#open-client").textContent'));
    await js('document.querySelector("#open-client").click()');
    await until(() => js('document.querySelector("#client-history-notice").textContent.includes("已打开")'));
    assert.match(await js('document.querySelector("#archive-status").textContent'), /来源未分类/);
    await image(key); await close();
  }
  check('service switch archives API messages and unsent draft', (await store.list('api:deepseek')).items.length === 2 &&
    (await Promise.all((await store.list('api:deepseek')).items.map(item => store.readArchive(item.id, 'api:deepseek')))).some(s => s.draft === 'DEEPSEEK UNSENT' && s.messages.some(m => m.content === 'DEEPSEEK NEW QUESTION')));
  await js('document.querySelector("#tab-connection").click()'); await choose('api-service', 'custom'); await choose('baseUrl', 'https://custom.example.test/v1'); await show(archiveIds.custom);
  check('custom endpoint history is separate from official providers', state.session.source === 'api:https://custom.example.test/v1' && await js('document.querySelector("#archive-list").options.length') === 2); await close();
  await js('document.querySelector("#tab-connection").click()'); await choose('api-service', 'kimi'); await show(archiveIds.kimi);
  await choose('archive-list', archiveIds.kimi); await until(() => js('!document.querySelector("#archive-preview").hidden'));
  await js('document.querySelector("#restore-archive").click()'); await until(() => Promise.resolve(state.session.messages.some(m => m.content === 'KIMI ONLY')));
  await until(async () => !context.configuring && await js('!document.querySelector("#history-dialog").open'));
  check('same-source restore preserves the source and does not import other providers', state.session.source === 'api:kimi' && !JSON.stringify(state.session).includes('DEEPSEEK'));
  // Delay a Codex list, then switch to DeepSeek: the late list must not leak back.
  const realList = store.list.bind(store); let finishList, holdList = true;
  store.list = sourceKey => sourceKey === 'codex-cli' && holdList ? new Promise(resolve => { finishList = async () => resolve(await realList(sourceKey)); }) : realList(sourceKey);
  await js('document.querySelector("#tab-connection").click()'); await choose('provider', 'codex-cli');
  await js('document.querySelector("#tab-chat-options").click();document.querySelector("#history").click()'); await until(() => Promise.resolve(!!finishList)); await close();
  await js('document.querySelector("#tab-connection").click()'); await choose('provider', 'api'); await choose('api-service', 'deepseek'); await show(archiveIds.deepseek);
  holdList = false; await finishList(); await pause(80);
  check('late foreign-source history list is discarded', await js(`!Array.from(document.querySelector('#archive-list').options).some(o=>o.value===${JSON.stringify(archiveIds.codex)})`));
  const realRead = store.readArchive.bind(store); let finishRead;
  store.readArchive = (archiveId, sourceKey) => archiveId === archiveIds.deepseek && sourceKey === 'api:deepseek' ? new Promise(resolve => { finishRead = async () => resolve(await realRead(archiveId, sourceKey)); }) : realRead(archiveId, sourceKey);
  await choose('archive-list', archiveIds.deepseek); await until(() => Promise.resolve(!!finishRead)); await close();
  await js('document.querySelector("#tab-connection").click()'); await choose('api-service', 'kimi'); await show(archiveIds.kimi);
  await finishRead(); await pause(80);
  check('late foreign-source preview is discarded', await js('document.querySelector("#archive-preview").hidden&&document.querySelector("#archive-list").value===""'));
  await image('late-preview'); await close();
  await other.loadURL('about:blank');
  check('history IPC rejects a different renderer', await other.webContents.executeJavaScript('window.desktop.listArchives().then(()=>false,()=>true)'));
  check('Claude save IPC is refused', !await js('window.desktop.saveSettings({provider:"claude-cli"}).then(r=>r.ok)'));
  check('no network or page errors', requests.length === 0 && errors.length === 0);
  const report = { packaged, checks, count: checks.length, networkRequests: requests, pageErrors: errors, generatedByLocalFixtureOnly: generated.length,
    launchSpies: launches, nativeUrlSpies: urls, limitations: ['No real models or client launches', 'Legacy unknown files are preserved, not inferred as a provider'] };
  await fsp.writeFile(path.join(output, prefix + 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  win.destroy(); other.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
