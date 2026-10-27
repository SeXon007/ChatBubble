// Hidden production settings + real preload and app.getVersion, isolated storage.
// This batch intentionally has no update server or real network/model requests.
const {app,BrowserWindow,ipcMain,nativeTheme}=require('electron');
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),vm=require('node:vm'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),packaged=process.argv.includes('--packaged'),version=require('../package.json').version;
const runtime=path.join(root,packaged?`release/ChatBubble-${version}-win32-x64/resources/app/dist`:'dist');
const captureScope=process.argv.includes('--capture-scope'),output=path.join(root,captureScope?'docs/verification/capture-scope-0.11.0':'docs/verification/version-tab-0.10.0');
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'chatbubble-version-')));
app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const checks=[],layouts=[],errors=[],requests=[],opened=[];
 const check=(name,ok)=>{assert.ok(ok,name);checks.push(name)};
 const {initialState}=require(path.join(runtime,'model')),{petDefaults}=require(path.join(runtime,'pet-state'));
 const {ChatStorage}=require(path.join(runtime,'chat-storage')),{persistSettingsPatch}=require(path.join(runtime,'settings'));
 const state=initialState();Object.assign(state.settings,petDefaults,{provider:'codex-cli'});
 const store=await ChatStorage.open(app.getPath('userData'));await store.save(state);
 const win=new BrowserWindow({width:420,height:430,useContentSize:true,show:false,focusable:false,webPreferences:{preload:path.join(runtime,'preload.js'),sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 const pet=new BrowserWindow({width:100,height:100,show:false,webPreferences:{preload:path.join(runtime,'preload.js'),sandbox:true,contextIsolation:true}});
 win.webContents.on('console-message',(_e,details)=>{if(typeof details==='object'&&details.level==='error')errors.push(details.message)});
 win.webContents.session.webRequest.onBeforeRequest((details,callback)=>{if(/^https?:/.test(details.url)){requests.push(details.url);callback({cancel:true})}else callback({})});
 const publicState=()=>({...state,busy:false,hasKey:false,warning:'',capture:{available:true,status:'empty'},storage:{directory:store.directory,archiveDirectory:store.archiveDirectory,appDirectory:app.getPath('userData')}});
 const settingsPage=path.join(runtime,'ui/settings.html'),page=path.join(runtime,'ui/index.html');
 const source=ts.createSourceFile('main.ts',fs.readFileSync(packaged?path.join(runtime,'main.js'):path.join(root,'src/main.ts'),'utf8'),ts.ScriptTarget.ES2022,true);
 let validation,versionHandler,saveHandler;
 function visit(n){if(ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(source)==='validate'))validation=n;if(ts.isCallExpression(n)&&/(?:^|\.)ipcMain\.handle$/.test(n.expression.getText(source))){if(n.arguments[0]?.text==='app:version')versionHandler=n;if(n.arguments[0]?.text==='settings:save')saveHandler=n}ts.forEachChild(n,visit)}visit(source);
 check('version bridge uses guarded production handler',!!validation&&!!versionHandler);
 const context={window:pet,settingsWindow:win,page,settingsPage,pathToFileURL:require('node:url').pathToFileURL,node_url_1:require('node:url'),app,ipcMain,electron_1:{app,ipcMain}};
 vm.createContext(context);for(const n of [validation,versionHandler])vm.runInContext(ts.transpileModule(n.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
 ipcMain.handle('chat:state',publicState);ipcMain.handle('cli:discover',()=>[]);ipcMain.handle('cli:models',()=>({models:[],source:'',fetchedAt:''}));ipcMain.handle('api:presets',()=>require(path.join(runtime,'api-models')).apiPresets);
 ipcMain.handle('settings:resize',(_e,height)=>{const [width]=win.getContentSize();win.setContentSize(width,Math.max(240,Math.ceil(height)))});
 let clearCalls=0;
 if(captureScope){
  Object.assign(context,{state,persistSettingsPatch,settings_1:{persistSettingsPatch},chat:{busy:false,persist:()=>store.save(state)},screenCapture:{clear:()=>clearCalls++},configuring:false,closing:false,flushingSettings:false,checking:false,smoke:true,restartMode:undefined,nativeCapture:undefined,broadcast:()=>win.webContents.send('chat:state',publicState())});
  vm.runInContext(ts.transpileModule(saveHandler.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
 }else ipcMain.handle('settings:save',async(_e,patch)=>{await persistSettingsPatch(state,patch,()=>store.save(state));return {ok:true,error:''}});
 ipcMain.handle('settings:check',()=>{requests.push('model');return {ok:false,error:'not requested'}});
 ipcMain.handle('link:open',(_e,url)=>opened.push(url));
 const js=code=>win.webContents.executeJavaScript(code);
 await win.loadFile(settingsPage);
 for(let i=0;i<150&&!await js(`document.querySelector('#current-version').textContent===${JSON.stringify(version)}&&!document.querySelector('#provider').disabled`);i++)await pause(20);
 check('current version comes from real Electron package metadata',app.getVersion()===version&&await js(`document.querySelector('#current-version').textContent===${JSON.stringify(version)}`));
 check('all five tabs present',await js('document.querySelectorAll("[role=tab]").length===5'));
 await js("document.querySelector('#tab-version').click()");
 check('version tab initially shows unconfigured source',await js("document.querySelector('#result').textContent==='尚未配置更新来源'"));
 await js("document.querySelector('#check-update').click();document.querySelector('#check-update').click();document.querySelector('#open-update').click()");
 check('checking without a source never claims an update or the latest version',await js("document.querySelector('#result').textContent==='尚未配置更新来源'&&document.querySelector('#open-update').disabled"));
 check('version controls do not request a model or open a browser',requests.length===0&&opened.length===0);
 win.webContents.send('chat:state',publicState());await pause(40);
 check('state broadcasts do not replace version notice',await js("document.querySelector('#result').textContent==='尚未配置更新来源'"));
 await js("document.querySelector('#tab-version').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))");
 check('keyboard wraps from version to connection',await js("document.querySelector('#tab-connection').getAttribute('aria-selected')==='true'"));
 await js("document.querySelector('#tab-connection').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))");
 check('keyboard End reaches version',await js("document.querySelector('#tab-version').getAttribute('aria-selected')==='true'"));
 await js("document.querySelector('#tab-appearance').click();const e=document.querySelector('#fontSize');e.value='18';e.dispatchEvent(new Event('change'));document.querySelector('#tab-version').click();window.flushSettings()");
 check('existing autosave survives tab switches',state.settings.fontSize===18&&(await store.load()).value.settings.fontSize===18);
 check('autosave completion keeps version-specific notice',await js("document.querySelector('#result').textContent==='尚未配置更新来源'"));
 if(captureScope){
  await js("document.querySelector('#tab-chat-options').click()");
  check('capture scope offers both modes and preserves window default',await js("document.querySelector('#captureScope').value==='window'&&[...document.querySelector('#captureScope').options].map(e=>e.text).join('|')==='前台窗口|整个屏幕'"));
  for(const scope of ['screen','window']){
   await js(`document.querySelector('#captureScope').value=${JSON.stringify(scope)};document.querySelector('#captureScope').dispatchEvent(new Event('change'));window.flushSettings()`);
   check(scope+' capture scope persists without taking a screenshot',state.settings.captureScope===scope&&(await store.load()).value.settings.captureScope===scope&&requests.length===0);
  }
  check('changing scope clears old pending screenshot association',clearCalls===2);
  for(const width of [320,420]){win.setContentSize(width,500);await pause(60);check('scope selector fits '+width+'px',await js("document.documentElement.scrollWidth<=innerWidth&&document.querySelector('#captureScope').getBoundingClientRect().right<=innerWidth"));await fsp.writeFile(path.join(output,`${packaged?'packaged-':''}capture-setting-${width}.png`),(await win.webContents.capturePage()).toPNG())}
  await js("document.querySelector('#tab-version').click()");
 }
 for(const theme of ['light','dark']){
  nativeTheme.themeSource=theme;
  for(const width of [420,360,320,800]){
   win.setContentSize(width,650);await pause(90);
   const layout=await js(`(()=>{const tabs=[...document.querySelectorAll('[role=tab]')].map(e=>e.getBoundingClientRect().width),v=document.querySelector('#version'),rows=[...v.querySelectorAll('.row')],buttons=[...v.querySelectorAll('button')].map(e=>{const b=e.getBoundingClientRect(),r=e.parentElement.getBoundingClientRect();return {width:b.width,available:r.right-b.left,left:b.left,right:b.right}});return {width:innerWidth,scroll:document.documentElement.scrollWidth,tabs,buttons,version:document.querySelector('#current-version').textContent,panels:[...document.querySelectorAll('[role=tabpanel]')].filter(e=>!e.hidden).map(e=>e.id)}})()`);
   check(`${theme} ${width}px layout fits`,layout.scroll<=layout.width&&layout.panels.join()==='version'&&Math.max(...layout.tabs)-Math.min(...layout.tabs)<1);
   check(`${theme} ${width}px buttons use content width`,layout.buttons.every(b=>b.width<b.available*.8&&b.right<=width));
   layouts.push({theme,...layout});await fsp.writeFile(path.join(output,`${packaged?'packaged-':''}${theme}-${width}.png`),(await win.webContents.capturePage()).toPNG());
  }
 }
 await pet.loadURL('about:blank');
 check('pet sender cannot access settings-only version IPC',await pet.webContents.executeJavaScript('window.desktop.getAppVersion().then(()=>false,()=>true)'));
 vm.runInContext("globalThis.validateVersionSender=validate",context);
 check('subframes and unrelated URLs are rejected',(()=>{try{context.validateVersionSender({sender:win.webContents,senderFrame:{url:'file:///untrusted.html'}},true);return false}catch{return true}})());
 check('production renderer remains sandboxed',await js("typeof require==='undefined'&&typeof window.desktop.getAppVersion==='function'"));
 check('no network or browser actions',requests.length===0&&opened.length===0);
 check('no renderer errors',errors.length===0);
 await fsp.writeFile(path.join(output,packaged?'packaged-ui.json':'source-ui.json'),JSON.stringify({packaged,version,checks,layouts,requests,opened,errors,limitations:['Hidden production settings fixture, not a physical mouse or GitHub network test','Update source and network implementation intentionally deferred by user']},null,2));
 console.log(JSON.stringify({packaged,version,checks:checks.length,requests:requests.length,opened:opened.length,errors}));
 pet.destroy();win.destroy();app.quit();
}).catch(async e=>{await fsp.writeFile(path.join(output,packaged?'packaged-error.txt':'source-error.txt'),String(e.stack));console.error(e);app.exit(1)});
