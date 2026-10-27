// Hidden production settings + real main handlers. Client launch is a spy.
const { app, BrowserWindow, ipcMain, shell, nativeTheme } = require('electron');
const fs = require('node:fs'), fsp = require('node:fs/promises');
const path = require('node:path'), os = require('node:os'), vm = require('node:vm'), ts = require('typescript');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), packaged = process.argv.includes('--packaged');
const version = require('../package.json').version;
const runtime = path.join(root, packaged ? `release/ChatBubble-${version}-win32-x64/resources/app/dist` : 'dist');
const output = path.join(root, 'docs/verification/cli-history-0.11.1');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'chatbubble-history-')));
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const { initialState } = require(path.join(runtime, 'model'));
  const { ChatStorage } = require(path.join(runtime, 'chat-storage'));
  const { persistSettingsPatch } = require(path.join(runtime, 'settings'));
  const clients = require(path.join(runtime, 'desktop-client'));
  const { apiPresets } = require(path.join(runtime, 'api-models'));
  const state = initialState(), storage = await ChatStorage.open(app.getPath('userData'));
  state.settings.provider='api';state.settings.baseUrl=apiPresets[0].baseUrl;
  state.session.codex={threadId:'11111111-1111-4111-8111-111111111111',home:app.getPath('userData'),cwd:app.getPath('userData')};
  state.session.messages.push({id:'local',role:'user',requestId:'local',content:'本地合成聊天，不发送给任何客户端',time:'',status:'complete'});
  const originalSession=JSON.stringify(state.session), launches=[], codexUrls=[];let nativeStops=0,nativePersists=0;
  let missing=false, hold=false, finishOld;
  const targets={deepseek:path.join(app.getPath('userData'),'DeepSeek Harness.exe'),kimi:path.join(app.getPath('userData'),'Kimi.exe'),zhipu:path.join(app.getPath('userData'),'ZCode.exe')};
  for(const target of Object.values(targets))await fsp.writeFile(target,'fixture, never executed');
  const roots=[app.getPath('desktop'),path.join(app.getPath('appData'),'Microsoft/Windows/Start Menu/Programs')];
  const realInstalled={};
  for(const id of ['deepseek','kimi','zhipu'])realInstalled[id]=!!await clients.locateDesktopClient(id,roots,file=>shell.readShortcutLink(file));
  function HiddenWindow(options){const w=new BrowserWindow({...options,focusable:false,webPreferences:{...options.webPreferences,backgroundThrottling:false}});w.show=()=>{};w.focus=()=>{};return w;}
  const publicState=()=>({...state,busy:false,warning:'',hasKey:false,storage:{directory:storage.directory,archiveDirectory:storage.archiveDirectory,appDirectory:app.getPath('userData')}});
  const context={...clients,app,path,__dirname:runtime,appIcon:path.join(runtime,'assets/app.ico'),settingsPage:path.join(runtime,'ui/settings.html'),BrowserWindow:HiddenWindow,
    settingsWindow:null,settingsWindowSize:undefined,settingsManuallySized:false,quitting:false,secureWindow:()=>{},flushSettings:async()=>true,
    state,store:storage,ipcMain,configuring:false,closing:false,checking:false,flushingSettings:false,smoke:true,restartMode:undefined,
    nativeCapture:undefined,screenCapture:{clear:()=>{}},persistSettingsPatch,
    chat:{busy:false,stop:async()=>{nativeStops++;},persist:()=>{nativePersists++;return storage.save(state);}},
    shell:{readShortcutLink:file=>{if(missing)throw Error('fixture missing');const name=path.basename(file,'.lnk');return {target:Object.values(targets).find(t=>path.basename(t,'.exe')===name)||'',args:'ignored'};},openPath:async file=>{launches.push(file);return '';},openExternal:async url=>{codexUrls.push(url);}},
    desktopShortcutRoots:()=>[app.getPath('userData')],
    locateDesktopClient:async(...args)=>{if(hold&&args[0]==='deepseek')return new Promise(resolve=>{finishOld=async()=>resolve(await clients.locateDesktopClient(...args));});return clients.locateDesktopClient(...args);},
    validate:event=>{if(event.sender!==context.settingsWindow?.webContents)throw Error('Invalid sender');},
    broadcast:()=>context.settingsWindow?.webContents.send('chat:state',publicState())};
  vm.createContext(context);
  Object.assign(context,{settings_1:{persistSettingsPatch},desktop_client_1:{...clients,locateDesktopClient:context.locateDesktopClient},node_path_1:{default:path},electron_1:{app,BrowserWindow:HiddenWindow,ipcMain,shell:context.shell}});
  const source=ts.createSourceFile('main.js',fs.readFileSync(path.join(runtime,'main.js'),'utf8'),ts.ScriptTarget.ES2022,true);
  const run=code=>vm.runInContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  const wanted=['settings:save','codex:open','client:status','client:open'];
  function visit(n){if(ts.isCallExpression(n)&&n.expression.getText(source)==='electron_1.ipcMain.handle'&&wanted.includes(n.arguments[0]?.text))run(n.getText(source));ts.forEachChild(n,visit);}visit(source);
  run(source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='openSettings').getText(source));
  ipcMain.handle('chat:state',publicState);ipcMain.handle('cli:models',()=>({models:[],source:'',fetchedAt:''}));ipcMain.handle('cli:discover',()=>[]);
  ipcMain.handle('app:version',()=>version);
  ipcMain.handle('api:presets',()=>apiPresets);ipcMain.handle('settings:resize',()=>{});ipcMain.handle('archives:list',()=>storage.list());
  ipcMain.handle('archives:read',(_event,id)=>storage.readArchive(id));
  const pause=ms=>new Promise(r=>setTimeout(r,ms)),js=code=>context.settingsWindow.webContents.executeJavaScript(code);
  async function until(fn){for(let i=0;i<200;i++){if(await fn())return;await pause(20);}throw Error('history check timeout');}
  await context.openSettings();await until(()=>js('!!window.flushSettings&&!document.querySelector("#provider").disabled'));
  context.settingsWindow.emit('will-resize');context.settingsWindow.setContentSize(560,560);
  nativeTheme.themeSource='dark';
  async function choose(id,value){assert.equal(await js(`(async()=>{const e=document.getElementById(${JSON.stringify(id)});e.value=${JSON.stringify(value)};if(e.tagName!=='SELECT')e.dispatchEvent(new Event('input'));e.dispatchEvent(new Event('change'));return window.flushSettings()})()`),true);}
  async function close(){await js('document.querySelector("#close-history").click()');}
  async function show(){await js('document.querySelector("#tab-chat-options").click();document.querySelector("#history").click()');}
  async function image(name){await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await fsp.writeFile(path.join(output,`${packaged?'packaged-':''}${name}.png`),(await context.settingsWindow.webContents.capturePage()).toPNG());}
  await fsp.mkdir(output,{recursive:true});
  for(const [id,name]of [['deepseek','DeepSeek Harness'],['kimi','Kimi'],['zhipu','ZCode']]){
    await js('document.querySelector("#tab-connection").click()');await choose('api-service',id);await show();
    await until(()=>js(`document.querySelector('#open-client').textContent===${JSON.stringify('打开 '+name)}`));
    assert.equal(await js('document.querySelector("#open-codex").hidden'),true);
    assert.match(await js('document.querySelector("#client-history-notice").textContent'),/保存在 ChatBubble/);
    await image(id);
    await js('document.querySelector("#open-client").click()');await until(()=>Promise.resolve(launches.includes(targets[id])));
    assert.equal(codexUrls.length,0);assert.equal(JSON.stringify(state.session),originalSession);await close();
  }
  // Re-detect each time: uninstall/moved target yields an actionable message.
  missing=true;await show();await until(()=>js('document.querySelector("#client-history-notice").textContent.includes("未检测到可用的 ZCode")'));
  const launched=launches.length;await js('document.querySelector("#open-client").click()');await pause(100);assert.equal(launches.length,launched);await image('missing-client');await close();missing=false;
  // A delayed DeepSeek lookup must not overwrite Kimi after switching services.
  await js('document.querySelector("#tab-connection").click()');await choose('api-service','deepseek');hold=true;await show();await until(()=>Promise.resolve(!!finishOld));await close();
  await js('document.querySelector("#tab-connection").click()');await choose('api-service','kimi');await show();await until(()=>js('document.querySelector("#open-client").textContent==="打开 Kimi"'));
  hold=false;await finishOld();await pause(80);assert.equal(await js('document.querySelector("#open-client").textContent'),'打开 Kimi');await close();
  // Retained native binding is only offered while the saved provider is Codex.
  await js('document.querySelector("#tab-connection").click()');await choose('provider','codex-cli');await show();
  assert.equal(await js('document.querySelector("#open-codex").hidden'),false);assert.equal(await js('document.querySelector("#open-client").hidden'),true);
  await js('document.querySelector("#open-codex").click()');await until(()=>Promise.resolve(codexUrls.length===1));
  assert.deepEqual(codexUrls,['codex://threads/'+state.session.codex.threadId]);await image('codex');await close();
  const binding=state.session.codex;
  const archiveId=await storage.archive(state);
  const plain=structuredClone(state);delete plain.session.codex;const plainId=await storage.archive(plain);
  delete state.session.codex;context.broadcast();await show();
  assert.equal(await js('document.querySelector("#open-codex").hidden'),false,'CLI entry must remain visible without a current native binding');
  assert.equal(await js('document.querySelector("#open-codex").disabled'),true);
  assert.match(await js('document.querySelector("#codex-history-notice").textContent'),/尚未创建/);await image('no-current-binding');
  assert.equal(await js('window.desktop.openCodex().then(r=>r.ok)'),false);
  await choose('archive-list',archiveId);await until(()=>js('!document.querySelector("#open-codex").disabled'));
  assert.match(await js('document.querySelector("#open-codex").textContent'),/所选对话/);
  const emptyCurrent=JSON.stringify(state.session),stopsBefore=nativeStops,persistsBefore=nativePersists;
  await js('document.querySelector("#open-codex").click()');await until(()=>Promise.resolve(codexUrls.length===2));
  assert.equal(nativeStops,stopsBefore);assert.equal(nativePersists,persistsBefore);
  assert.equal(codexUrls[1],'codex://threads/'+binding.threadId);assert.equal(JSON.stringify(state.session),emptyCurrent);await image('selected-archive');
  assert.equal(await js('window.desktop.openCodex("../state.json").then(r=>r.ok)'),false);assert.equal(codexUrls.length,2);
  await choose('archive-list',plainId);await until(()=>js('document.querySelector("#open-codex").disabled&&document.querySelector("#codex-history-notice").textContent.includes("没有 Codex 原生会话")'));
  assert.match(await js('document.querySelector("#codex-history-notice").textContent'),/没有 Codex 原生会话/);
  assert.equal(await js(`window.desktop.openCodex(${JSON.stringify(plainId)}).then(r=>r.ok)`),false);assert.equal(codexUrls.length,2);
  await choose('archive-list','');assert.equal(await js('document.querySelector("#open-codex").disabled'),true);await close();
  state.session.codex=binding;context.broadcast();
  await choose('provider','api');await show();assert.equal(await js('window.desktop.openCodex().then(r=>r.ok)'),false);
  assert.equal(await js(`window.desktop.openCodex(${JSON.stringify(archiveId)}).then(r=>r.ok)`),false);
  assert.equal(codexUrls.length,2);assert.equal(JSON.stringify(state.session),originalSession);await close();
  await choose('api-service','custom');await choose('baseUrl','https://custom.example.test/v1');await show();await until(()=>js('document.querySelector("#open-client").hidden'));
  assert.equal(await js('document.querySelector("#open-codex").hidden'),true);await close();
  // A second renderer cannot launch a client through the settings-only channel.
  const other=new BrowserWindow({show:false,focusable:false,webPreferences:{preload:path.join(runtime,'preload.js'),sandbox:true,contextIsolation:true}});
  await other.loadURL('about:blank');assert.equal(await other.webContents.executeJavaScript('window.desktop.openDesktopClient("https://api.deepseek.com").then(()=>false,()=>true)'),true);
  assert.equal(await other.webContents.executeJavaScript('window.desktop.openCodex().then(()=>false,()=>true)'),true);other.destroy();
  const report={packagedUI:packaged,realMainHandlers:true,retainedCodexBindingHiddenInApi:true,apiCannotOpenOldCodex:true,allThreeClientEntries:true,launchSpyOnly:true,
    missingClientMessage:true,staleStatusDiscarded:true,customEndpointHasNoAssumedClient:true,sessionUnchanged:true,settingsOnlyLaunch:true,
    cliEntryVisibleWithoutCurrentBinding:true,selectedArchiveOpensOwnedNativeId:true,archiveWithoutNativeBindingDisabled:true,invalidArchiveRejected:true,
    installedClientsReadOnly:realInstalled,launches:launches.map(file=>path.basename(file)),limitations:['Actual desktop clients were detected but never launched','No API requests or native conversation imports','No user credentials or chat history read']};
  await fsp.writeFile(path.join(output,packaged?'packaged-report.json':'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));context.settingsWindow.destroy();app.quit();
}).catch(error=>{console.error(error);app.exit(1);});
