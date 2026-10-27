// Deliver real IPC notifications in a controlled order. No window activation,
// native capture helper, user state, or screenshot files are involved.
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs/promises'),syncFs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),baseline=process.argv.includes('--baseline'),packaged=process.argv.includes('--packaged');
const runtime=path.join(root,packaged?`release/ChatBubble-${require('../package.json').version}-win32-x64/resources/app/dist`:'dist');
const output=path.join(root,baseline?'docs/verification/pet-expression-rollback':'docs/verification/manual-capture-0.9.0/mode-feedback');
app.setPath('userData',syncFs.mkdtempSync(path.join(os.tmpdir(),'chatbubble-mode-')));app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
  const {initialState}=require(path.join(runtime,'model')),{petDefaults}=require(path.join(runtime,'pet-state'));
  const shouldCaptureOnExpand=(before,next,provider,enabled)=>baseline&&enabled&&provider==='codex-cli'&&before!=='expanded'&&next==='expanded';
  const state=initialState();Object.assign(state.settings,{provider:'codex-cli',screenCaptureEnabled:true});
  const win=new BrowserWindow({width:800,height:600,show:false,focusable:false,webPreferences:{preload:path.join(runtime,'preload.js'),sandbox:true,contextIsolation:true,backgroundThrottling:false}});
  let page=path.join(runtime,'ui/index.html');
  if(baseline){const dir=path.join(output,'baseline-ui');await fs.cp(path.join(runtime,'ui'),dir,{recursive:true});await fs.copyFile(path.join(output,'pet-buggy.js'),path.join(dir,'pet.js'));const renderer=await fs.readFile(path.join(output,'renderer-before.ts'),'utf8');await fs.writeFile(path.join(dir,'renderer.js'),ts.transpileModule(renderer,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText);page=path.join(dir,'index.html');}
  const queue=[],calls=[];let captures=0,menuRequests=0,blurOnFocus=false,heldScene,releaseScene;
  ipcMain.handle('desktop:menu',()=>{menuRequests++;});
  const context={mode:'collapsed',modeApplied:false,state,smoke:false,restartMode:undefined,historyRefresh:undefined,shouldCaptureOnExpand,
    screenCapture:{expand:()=>captures++,clear:()=>{}},window:{setFocusable:()=>{},isVisible:()=>true,show:()=>{},hide:()=>{},showInactive:()=>{},focus:()=>{if(blurOnFocus)context.setMode('collapsed');},webContents:{send:(channel,payload)=>queue.push({channel,payload})}}};
  const mainFile=baseline?path.join(output,'main-before.ts'):path.join(root,'src/main.ts');const source=ts.createSourceFile('main.ts',await fs.readFile(mainFile,'utf8'),ts.ScriptTarget.ES2022,true);
  const transition=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='setMode');vm.createContext(context);vm.runInContext(ts.transpileModule(transition.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  ipcMain.handle('window:mode',(_event,next)=>{calls.push(next);if(calls.length>100)throw Error('bounded feedback test stopped');context.setMode(next);});
  const scene=mode=>({bounds:{x:0,y:0,width:800,height:600},areas:[{x:0,y:0,width:800,height:600,id:1}],mode,options:petDefaults,position:{x:400,y:300,side:null,displayId:1}});
  ipcMain.handle('desktop:scene',()=>heldScene?new Promise(resolve=>{releaseScene=()=>resolve(scene('expanded'));}):scene(context.mode));
  for(const name of ['desktop:shape','desktop:position','chat:draft'])ipcMain.handle(name,()=>{});
  ipcMain.handle('chat:state',()=>({...state,busy:false,hasKey:false,warning:'',storage:{directory:output,archiveDirectory:output,appDirectory:output}}));
  const js=code=>win.webContents.executeJavaScript(code),pause=ms=>new Promise(r=>setTimeout(r,ms));
  async function until(fn){for(let i=0;i<200;i++){if(await fn())return;await pause(10);}throw Error('mode fixture timeout');}
  async function load(){await win.loadFile(page);await until(()=>js('!!window.pet'));await js(`(()=>{const p=document.querySelector('#cb-pet');p.setPointerCapture=()=>{};p.hasPointerCapture=()=>false;window.clickPet=()=>{const s=window.pet.inspect();for(const type of ['pointerdown','pointerup'])p.dispatchEvent(new PointerEvent(type,{button:0,pointerId:1,clientX:s.x,clientY:s.y,bubbles:true}));};})()`);}
  async function drain(limit=24){let n=0;while(queue.length&&n<limit){const e=queue.shift();win.webContents.send(e.channel,e.payload);n++;await pause(12);}return {delivered:n,remaining:queue.length,calls:[...calls],captures,mode:context.mode,ui:await js('document.body.dataset.mode')};}
  await load();calls.length=0;queue.length=0;captures=0;
  let rightClick;
  if(!baseline){
    const prevented=await js(`(()=>{const p=document.querySelector('#cb-pet'),s=window.pet.inspect();for(const type of ['pointerdown','pointerup'])p.dispatchEvent(new PointerEvent(type,{button:2,pointerId:3,clientX:s.x,clientY:s.y,bubbles:true}));const e=new MouseEvent('contextmenu',{button:2,bubbles:true,cancelable:true});p.dispatchEvent(e);return e.defaultPrevented;})()`);
    await pause(40);rightClick={prevented,menuRequests,modeCalls:[...calls],captures};
    assert.equal(prevented,true);assert.equal(menuRequests,0);assert.deepEqual(calls,[]);assert.equal(captures,0);
    assert.equal(await js('typeof window.desktop.openPetMenu'),'undefined');
  }
  await js(`clickPet();document.querySelector('#cb-desktop').dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:2,clientX:5,clientY:5,bubbles:true}))`);
  await until(()=>Promise.resolve(calls.length>=2));const rapid=await drain();
  if(baseline){assert.ok(rapid.remaining>0&&rapid.captures>5,'baseline reproduces mode echo and repeated captures');}
  else{
    assert.equal(rapid.remaining,0);assert.deepEqual(rapid.calls,['expanded','collapsed']);assert.equal(rapid.captures,0);assert.equal(rapid.mode,'collapsed');
  }
  let blur,delayed;
  if(!baseline){
    queue.length=0;calls.length=0;captures=0;blurOnFocus=true;await js('clickPet()');await until(()=>Promise.resolve(calls.length>=1));blur=await drain();
    assert.equal(blur.remaining,0);assert.equal(blur.captures,0);assert.deepEqual(blur.calls,['expanded']);assert.equal(blur.mode,'collapsed');assert.equal(blur.ui,'collapsed');blurOnFocus=false;
    // Renderer receives the latest collapsed state before a stale scene resolves.
    heldScene=true;queue.length=0;calls.length=0;captures=0;context.mode='collapsed';
    await win.loadFile(page);await until(()=>Promise.resolve(!!releaseScene));win.webContents.send('window:mode','collapsed');await pause(30);releaseScene();await until(()=>js('!!window.pet'));await pause(50);delayed=await drain();
    assert.equal(delayed.remaining,0);assert.equal(delayed.captures,0);assert.deepEqual(delayed.calls,[]);assert.equal(delayed.ui,'collapsed');
  }
  const report={baseline,packaged,captureSpyOnly:true,rightClick,rapid,blur,delayed,userProcessesNotStarted:true};await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,baseline?'baseline-feedback.json':packaged?'packaged-feedback.json':'feedback.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));win.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1);});
