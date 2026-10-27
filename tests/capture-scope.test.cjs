const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),ts=require('typescript');
const {initialState,isState}=require('../dist/model'),{persistSettingsPatch,mergeSettings}=require('../dist/settings'),{ChatStorage}=require('../dist/chat-storage'),{ScreenCapture}=require('../dist/screen-capture');
test('capture scope defaults to the existing window mode, accepts legacy states and persists both choices',async t=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'chatbubble-scope-'));t.after(()=>fs.rm(folder,{recursive:true,force:true}));
 const store=await ChatStorage.open(folder),state=initialState();assert.equal(state.settings.captureScope,'window');
 delete state.settings.captureScope;assert.equal(isState(state),true);
 for(const scope of ['screen','window']){await persistSettingsPatch(state,{captureScope:scope},()=>store.save(state));assert.equal((await store.load()).value.settings.captureScope,scope)}
 for(const invalid of ['all',true,'','screen\n',null]){assert.throws(()=>mergeSettings(state.settings,{captureScope:invalid}));assert.equal(isState({...state,settings:{...state.settings,captureScope:invalid}}),false)}
});
async function fixture(t){
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'chatbubble-scope-routing-'));t.after(()=>fs.rm(folder,{recursive:true,force:true}));
 const source=ts.createSourceFile('main.ts',await fs.readFile(path.join(__dirname,'../src/main.ts'),'utf8'),ts.ScriptTarget.ES2022,true);
 let constructor,handler;function visit(n){if(ts.isBinaryExpression(n)&&n.left.getText(source)==='screenCapture'&&ts.isNewExpression(n.right))constructor=n;if(ts.isCallExpression(n)&&n.expression.getText(source)==='ipcMain.handle'&&n.arguments[0]?.text==='settings:save')handler=n;ts.forEachChild(n,visit)}visit(source);
 const state=initialState();state.settings.provider='codex-cli';const prepared=[],read=[];let settingsHandler;
 const c={state,ScreenCapture,store:{directory:folder},screenCapture:undefined,configuring:false,closing:false,flushingSettings:false,checking:false,smoke:true,restartMode:undefined,
  broadcast:()=>{},validate:()=>{},persistSettingsPatch,chat:{busy:false,persist:async()=>{}},ipcMain:{handle:(_name,fn)=>settingsHandler=fn},
  nativeCapture:{isClosed:false,capture:async()=>Buffer.alloc(100,1),captureMonitor:async()=>Buffer.alloc(100,2),prepareCapture:scope=>{prepared.push(scope);return async()=>{read.push(scope);return Buffer.alloc(100,scope==='screen'?2:1)}}}};
 vm.createContext(c);for(const n of [constructor,handler])vm.runInContext(ts.transpileModule(n.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,c);
 return {c,state,prepared,read,settingsHandler,folder};
}
test('main capture routing freezes the explicit request scope and never captures on settings changes',async t=>{
 const f=await fixture(t);assert.deepEqual(f.read,[]);await f.settingsHandler({}, {captureScope:'screen'});assert.deepEqual(f.read,[]);
 const job=f.c.screenCapture.request();f.state.settings.captureScope='window';const result=await job;
 assert.deepEqual(f.prepared,['screen']);assert.deepEqual(f.read,['screen']);assert.equal((await fs.readFile(result.image.file))[0],2);
 await f.c.screenCapture.request();assert.deepEqual(f.prepared,['screen','window']);assert.deepEqual(f.read,['screen','window']);
});
test('switching scope detaches a late old-scope image without deleting its saved file',async t=>{
 const f=await fixture(t);let release,started;
 const begun=new Promise(resolve=>started=resolve);f.c.nativeCapture.prepareCapture=()=>async()=>{started();return new Promise(resolve=>release=()=>resolve(Buffer.alloc(100,1)))};
 const job=f.c.screenCapture.request();await begun;await f.settingsHandler({}, {captureScope:'screen'});assert.equal(f.c.screenCapture.status,'empty');
 release();const result=await job;assert.equal(f.c.screenCapture.status,'empty');assert.deepEqual(await f.c.screenCapture.take(),{});assert.ok((await fs.stat(result.image.file)).isFile());
});
test('failed scope persistence keeps the previous setting and pending image',async t=>{
 const f=await fixture(t);await f.c.screenCapture.request();f.c.chat.persist=async()=>{throw Error('disk full')};
 const result=await f.settingsHandler({}, {captureScope:'screen'});assert.equal(result.ok,false);assert.equal(f.state.settings.captureScope,'window');assert.equal(f.c.screenCapture.status,'ready');
});
