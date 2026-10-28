// Production DOM, preload, capture queue and chat controller with isolated data.
// No user windows are captured; the capture callback returns a synthetic PNG.
const {app,BrowserWindow,ipcMain,nativeTheme,nativeImage,ClipboardItem,net}=require('electron');
const fs=require('node:fs/promises'),syncFs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),packaged=process.argv.includes('--packaged'),version=require('../package.json').version;
const runtime=path.join(root,packaged?`release/ChatBubble-${version}-win32-x64/resources/app/dist`:'dist');
const apiMode=process.argv.includes('--api');
const output=process.env.CHATBUBBLE_MANUAL_OUTPUT||path.join(root,'docs/verification/manual-capture-0.9.0');
const directory=syncFs.mkdtempSync(path.join(os.tmpdir(),'chatbubble-manual-'));
app.setPath('userData',path.join(directory,'browser'));app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
app.whenReady().then(async()=>{
 await fs.mkdir(output,{recursive:true});
 const {initialState,newSession}=require(path.join(runtime,'model')),{petDefaults}=require(path.join(runtime,'pet-state'));
 const {ChatStorage}=require(path.join(runtime,'chat-storage')),{ChatController}=require(path.join(runtime,'chat')),{ScreenCapture}=require(path.join(runtime,'screen-capture'));
 const {captureCapability}=require(path.join(runtime,'api-capabilities'));
 const {streamChat}=require(path.join(runtime,'provider'));
 const store=await ChatStorage.open(path.join(directory,'data'));
 const state=initialState();Object.assign(state.settings,petDefaults,{provider:'codex-cli',cliPath:'fixture',screenCaptureEnabled:false,petWidth:320,petSize:82,petEyeSize:140,petColor:'#000000'});
 if(apiMode)Object.assign(state.settings,{provider:'api',baseUrl:'https://api.deepseek.com',model:'deepseek-flash'});
 state.session.source=require(path.join(runtime,'conversation-source')).conversationSource(state.settings);
 const checks=[],errors=[],samples=[],shapes=[],modelRequests=[],clipboardImages=[];let captureCalls=0,hold=false,release,fail=false,chat,manager;
 const win=new BrowserWindow({width:800,height:500,show:false,focusable:false,frame:false,transparent:true,webPreferences:{preload:path.join(runtime,'preload.js'),sandbox:true,contextIsolation:true,offscreen:true,backgroundThrottling:false}});
 win.webContents.on('console-message',(_event,level,message)=>{if(level===3)errors.push(message);});
 const snapshot=()=>({session:state.session,settings:state.settings,busy:chat.busy,hasKey:false,warning:'',capture:{...captureCapability(state.settings),status:manager.status},storage:{directory:store.directory,archiveDirectory:store.archiveDirectory,appDirectory:directory}});
 const broadcast=()=>win.webContents.send('chat:state',snapshot());
 const png=process.env.CHATBUBBLE_TEST_CAPTURE_PNG ? await fs.readFile(process.env.CHATBUBBLE_TEST_CAPTURE_PNG) : nativeImage.createFromBitmap(Buffer.alloc(32*32*4,255),{width:32,height:32}).toPNG();
 assert.ok(png.length>80,'synthetic capture fixture must be a valid PNG');
 manager=new ScreenCapture(()=>store.directory,async()=>{captureCalls++;if(hold)await new Promise(resolve=>{release=resolve;});if(fail)throw Error('synthetic unavailable');return png;},undefined,broadcast);
 const wireRequests=[];let server;
 if(apiMode){server=require('node:http').createServer((request,response)=>{let body='';request.on('data',chunk=>body+=chunk);request.on('end',()=>{wireRequests.push(JSON.parse(body));response.writeHead(200,{'Content-Type':'text/event-stream'});response.end('data: '+JSON.stringify({choices:[{delta:{content:'合成回复'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');});});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));}
 chat=new ChatController(state,store,()=>'',broadcast,undefined,async options=>{modelRequests.push({image:options.image,text:options.messages.at(-1).content});
  if(apiMode)return streamChat({...options,attachmentDirectory:path.join(store.directory,'attachments'),fetcher:(_url,init)=>net.fetch('http://127.0.0.1:'+server.address().port+'/v1/chat/completions',init)});
  options.onChunk('合成回复');},()=>manager.take());
 await chat.persist();
 const source=ts.createSourceFile('main.js',await fs.readFile(path.join(runtime,'main.js'),'utf8'),ts.ScriptTarget.ES2022,true);
 const context={Blob,Uint8Array,mode:'collapsed',modeApplied:false,state,chat,screenCapture:manager,api_capabilities_1:{captureCapability},electron_1:{nativeImage,ClipboardItem,clipboard:{write:async items=>{const blob=await items[0].getType('image/png');clipboardImages.push(nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer())).toBitmap());}}},smoke:false,restartMode:undefined,historyRefresh:undefined,configuring:false,closing:false,
  expandedBounds:{x:0,y:0,width:800,height:500},nativeShape:'',inputRegions:[],nativePaintRegions:[],petDragging:false,
  window:{setFocusable:()=>{},isVisible:()=>true,show:()=>{},focus:()=>{},hide:()=>{},showInactive:()=>{},webContents:win.webContents,setShape:regions=>{shapes.push(regions);win.setShape(regions);}}};
 vm.createContext(context);
 for(const name of ['setMode','requestScreenCapture','updateNativeShape']){
  const fn=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name);
  vm.runInContext(fn.getText(source),context);
 }
 const scene=()=>({bounds:{...context.expandedBounds},areas:[{...context.expandedBounds,id:1}],position:{x:Math.min(context.expandedBounds.width-52,context.expandedBounds.width/2+135),y:300,side:null,displayId:1},mode:context.mode,options:state.settings});
 const validate=event=>{assert.equal(event.sender,win.webContents);assert.equal(event.senderFrame,win.webContents.mainFrame);};
 ipcMain.handle('desktop:scene',scene);
 ipcMain.handle('desktop:position',()=>{});
 ipcMain.handle('desktop:shape',(event,regions,dragging,paint=[])=>{validate(event);context.inputRegions=regions;context.nativePaintRegions=paint;context.petDragging=dragging;context.updateNativeShape();});
 ipcMain.handle('window:mode',(event,next)=>{validate(event);context.setMode(next);});
 ipcMain.handle('chat:state',snapshot);
 ipcMain.handle('chat:draft',(event,text)=>{validate(event);state.session.draft=text;});
 ipcMain.handle('screen:capture',event=>{validate(event);return context.requestScreenCapture();});
 ipcMain.handle('screen:clear',event=>{validate(event);manager.clear();return {ok:true,error:''};});
 ipcMain.handle('chat:submit',(event,text)=>{validate(event);if(manager.status==='capturing')return {ok:false,error:'请等待截图完成后发送。'};return chat.send(text);});
 ipcMain.handle('chat:stop',()=>chat.stop());ipcMain.handle('chat:retry',()=>chat.send(state.session.messages.at(-2)?.content,true));
 const js=code=>win.webContents.executeJavaScript(code);
 const check=(value,label)=>{assert.ok(value,label);checks.push(label);};
 async function until(predicate,label){for(let i=0;i<300;i++){if(await predicate())return;await pause(20);}throw Error('Timeout: '+label+' '+JSON.stringify({busy:chat.busy,requests:modelRequests.length,wire:wireRequests.length,messages:state.session.messages.map(m=>({role:m.role,status:m.status,error:m.error})),errors}));}
 async function mode(next){context.setMode(next);await until(()=>js(`window.pet.inspect().morph ${next==='expanded'?'>.995':'<.005'}`),next);}
 async function captureButton(){await until(()=>js("!document.querySelector('#capture').disabled"),'capture button usable');await js("document.querySelector('#capture').click()");}
 await win.loadFile(path.join(runtime,'ui/index.html'));await until(()=>js('!!window.pet'),'pet loaded');
 await js(`(()=>{const p=document.querySelector('#cb-pet');p.setPointerCapture=()=>{};p.hasPointerCapture=()=>false;window.gesture=(type,x,y)=>p.dispatchEvent(new PointerEvent(type,{pointerId:1,button:0,clientX:x,clientY:y,bubbles:true}));})()`);
 for(const kind of ['quick drag','moving release','stationary hold']){
  await mode('collapsed');
  await js(`(async()=>{const p=window.pet.inspect();gesture('pointerdown',p.x,p.y);${kind==='stationary hold'?"await new Promise(r=>setTimeout(r,180));gesture('pointerup',p.x,p.y)":kind==='quick drag'?"gesture('pointerup',p.x+75,p.y+10)":"gesture('pointermove',p.x+75,p.y+10);gesture('pointerup',p.x+80,p.y+12)"}})()`);
  await pause(60);check(captureCalls===0,kind+' never captures');
 }
 await mode('expanded');
 check(captureCalls===0,'opening with legacy option off never captures');
 state.settings.screenCaptureEnabled=true;await mode('collapsed');await mode('expanded');check(captureCalls===0,'legacy option on cannot auto-capture');
 await captureButton();await until(()=>manager.status==='ready','manual capture ready');
 const first=(await fs.readdir(path.join(store.directory,'attachments')))[0];
 check(captureCalls===1,'manual button captures exactly once');
 await until(()=>clipboardImages.length===1,'image copied after capture');
 check(clipboardImages[0].equals(nativeImage.createFromBuffer(png).toBitmap()),'clipboard receives the captured image pixels, not a path');
 await mode('collapsed');await mode('expanded');check(manager.status==='ready'&&captureCalls===1,'draft screenshot survives close/open without recapture');
 await captureButton();await pause(70);
 const menu=await js("(()=>{const m=document.querySelector('#capture-menu'),b=m.getBoundingClientRect();return {hidden:m.hidden,text:m.textContent,rect:{x:b.x,y:b.y,width:b.width,height:b.height},buttons:[...m.querySelectorAll('button')].map(b=>({name:b.getAttribute('aria-label'),title:b.title}))}})()");
 check(!menu.hidden&&!menu.text.trim()&&menu.rect.width===78&&menu.buttons.every(b=>b.name&&b.title),'compact popup has only two labeled icons');
 const mx=menu.rect.x+menu.rect.width/2,my=menu.rect.y+menu.rect.height/2;
 check(context.inputRegions.some(r=>mx>=r.x&&mx<=r.x+r.width&&my>=r.y&&my<=r.y+r.height),'popup included in real pet mouse hit regions');
 check(shapes.at(-1).some(r=>mx>=r.x&&mx<=r.x+r.width&&my>=r.y&&my<=r.y+r.height),'native setShape includes popup');
 await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");check(await js("document.querySelector('#capture-menu').hidden")&&context.mode==='expanded','Escape dismisses popup before collapsing');
 await captureButton();await js("document.querySelector('#capture-remove').click()");await until(()=>manager.status==='empty','removed');
 check((await fs.readFile(path.join(store.directory,'attachments',first))).length>0,'remove unbinds screenshot without deleting stored file');
 hold=true;
 await captureButton();await until(()=>!!release,'capture held');
 await js("document.querySelector('#input').value='capturing';document.querySelector('#input').dispatchEvent(new Event('input'));document.querySelector('#composer').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}))");
 check(modelRequests.length===0&&!(await js("window.desktop.submit('in flight')")).ok,'pending capture blocks both UI and IPC sending');
 hold=false;release();await until(()=>manager.status==='ready','capture completes');await pause(40);
 await captureButton();await js("document.querySelector('#capture-retake').click()");await until(()=>captureCalls===3&&manager.status==='ready','retake completes');
 await until(()=>js("!document.querySelector('#capture').disabled"),'retake and clipboard copying finished');
 await until(()=>js("!document.querySelector('#send').disabled&&!document.querySelector('#composer').inert"),'send button ready after capture state render');
 await js("document.querySelector('#input').value='带图问题';document.querySelector('#input').dispatchEvent(new Event('input'));document.querySelector('#send').click()");
 await until(()=>modelRequests.length===1&&!chat.busy,'model fixture receives screenshot');
 check(manager.status==='empty'&&modelRequests[0].image&&state.session.messages[0].image.file===modelRequests[0].image.file,'send consumes and persists the exact captured attachment');
 check((await fs.readFile(modelRequests[0].image.file)).equals(png),'model receives the unchanged full-resolution PNG file');
 check(await js("!document.querySelector('#messages img')&&document.querySelector('#messages').textContent.includes('带图问题')"),'message log has text only');
 if(apiMode){check(wireRequests.length===1&&Array.isArray(wireRequests[0].messages.at(-1).content),'Electron net.fetch sends multimodal API request to loopback fixture');check(wireRequests[0].messages.at(-1).content[1].image_url.url==='data:image/png;base64,'+png.toString('base64'),'wire contains exact captured PNG bytes');}
 await captureButton();await until(()=>manager.status==='ready','capture before failure');
 fail=true;await captureButton();await js("document.querySelector('#capture-retake').click()");await until(()=>manager.status==='empty','recapture fails');await until(()=>js("document.querySelector('#status').textContent==='未能读取画面'"),'capture failure response');
 check(await js("document.querySelector('#status').textContent==='未能读取画面'"),'failure has short visible message');
 await js("document.querySelector('#input').value='失败后文字';document.querySelector('#input').dispatchEvent(new Event('input'));document.querySelector('#send').click()");await until(()=>modelRequests.length===2&&!chat.busy,'text-only send');
 check(!modelRequests[1].image&&!state.session.messages.at(-2).notice,'failed recapture cannot reuse old image or add a false capture notice');fail=false;
 if(apiMode)check(wireRequests.length===2&&Array.isArray(wireRequests[1].messages[1].content)&&typeof wireRequests[1].messages.at(-1).content==='string','follow-up carries historical image without pretending to have a new screenshot');
 hold=true;release=undefined;await captureButton();await until(()=>!!release,'old session capture held');
 manager.clear();state.session=newSession(require(path.join(runtime,'conversation-source')).conversationSource(state.settings));broadcast();hold=false;release();await pause(150);
 check(manager.status==='empty'&&await js("document.querySelector('#capture').dataset.state==='empty'"),'late capture cannot attach to a new conversation');
 for(const provider of ['api','claude-cli']){Object.assign(state.settings,{provider,baseUrl:'https://api.deepseek.com',model:'deepseek-v4-pro'});broadcast();await pause(30);const before=captureCalls;check(await js("document.querySelector('#capture').disabled")&&!(await js('window.desktop.captureWindow()')).ok&&captureCalls===before,provider+' text-only connection does not capture');}
 if(apiMode)for(const [baseUrl,model] of [['https://api.deepseek.com','deepseek-flash'],['https://api.moonshot.cn/v1','kimi-k3.1-pro'],['https://open.bigmodel.cn/api/paas/v4','glm-4.6v-flash'],['https://custom.example.test/v1','custom-vision']]){manager.clear();Object.assign(state.settings,{provider:'api',baseUrl,model});broadcast();await pause(30);const before=captureCalls;await captureButton();await until(()=>manager.status==='ready','API screenshot ready');check(captureCalls===before+1,'manual screenshot enabled for '+model);}
 state.settings.provider='codex-cli';broadcast();await pause(30);
 for(const scope of ['screen','window']){
  manager.clear();state.settings.captureScope=scope;const before=captureCalls;broadcast();await pause(35);
  check(captureCalls===before&&await js(`document.querySelector('#capture').getAttribute('aria-label')===${JSON.stringify('截取'+(scope==='screen'?'整个屏幕':'前台窗口'))}`),'scope '+scope+' only updates tooltip and does not capture');
  await captureButton();await until(()=>manager.status==='ready','explicit '+scope+' capture');
  check(captureCalls===before+1,'scope '+scope+' captures exactly once on click');
 }
 manager.clear();broadcast();await pause(30);
 await js("document.querySelector('#input').value='很长的一段文字，用来验证聊天框不会增高。'.repeat(25);document.querySelector('#input').dispatchEvent(new Event('input'))");
 await pause(30);check(await js("document.querySelector('#composer').getBoundingClientRect().height===42&&document.querySelector('#input').scrollHeight>24"),'long text keeps 42px strip and scrolls internally');
 await js("document.querySelector('#input').value='';document.querySelector('#input').dispatchEvent(new Event('input'))");await captureButton();await until(()=>manager.status==='ready','layout screenshot ready');await captureButton();
 for(const theme of ['light','dark'])for(const width of [800,360,320]){
  nativeTheme.themeSource=theme;win.setContentSize(width,500);context.expandedBounds.width=width;win.webContents.send('desktop:scene',scene());await pause(180);
  const sample=await js("(()=>{const f=document.querySelector('#composer').getBoundingClientRect(),i=document.querySelector('#input'),c=document.querySelector('#capture').getBoundingClientRect(),s=document.querySelector('#send').getBoundingClientRect(),m=document.querySelector('#capture-menu').getBoundingClientRect(),style=getComputedStyle(i);return {width:innerWidth,height:f.height,fit:f.x>=0&&f.right<=innerWidth&&m.x>=0&&m.right<=innerWidth&&m.y>=0,adjacent:Math.abs(c.y-s.y)<1&&s.x-c.right<=8,arrow:getComputedStyle(document.querySelector('#send svg')).width,border:style.borderTopWidth,outline:style.outlineWidth,resize:style.resize,scrollbar:style.scrollbarWidth}})()");
  check(sample.fit&&sample.height===42&&sample.adjacent&&sample.arrow==='22px'&&sample.border==='0px'&&sample.outline==='0px'&&sample.resize==='none'&&sample.scrollbar==='none','layout '+theme+' '+width);samples.push({theme,...sample});
  await fs.writeFile(path.join(output,`${packaged?'packaged-':''}manual-${theme}-${width}.png`),(await win.webContents.capturePage()).toPNG());
 }
 check(!(await fs.readFile(path.join(runtime,'ui/settings.html'),'utf8')).includes('id="screenCaptureEnabled"'),'obsolete automatic-capture setting removed');
 // Long messages prove this changes the visible message region, leaving the input strip alone.
 state.session=newSession('codex-cli');state.session.messages=[{id:'height-fixture',role:'assistant',status:'complete',requestId:'height',time:'',content:'这是消息区高度与滚动检查。\n'.repeat(120)}];
 const beforeHeightCapture=captureCalls;
 for(const [width,height,y,requested] of [[800,1100,960,120],[800,1100,960,800],[800,1100,960,380],[360,500,380,800],[320,500,380,120],[800,500,180,800]]){
  win.setContentSize(width,height);Object.assign(context.expandedBounds,{width,height});const next=scene();next.position.y=y;win.webContents.send('desktop:scene',next);
  state.settings.messageHeight=requested;broadcast();await pause(250);
  const layout=await js("(()=>{const m=document.querySelector('#messages'),r=m.getBoundingClientRect(),c=document.querySelector('#composer').getBoundingClientRect();m.scrollTop=50;return {top:r.top,bottom:r.bottom,height:r.height,max:parseFloat(m.style.maxHeight),scrolls:m.scrollTop>0,input:document.querySelector('#input').getBoundingClientRect().height,composer:c.height,composerTop:c.top}})()");
  check(layout.max<=requested&&layout.height===layout.max&&layout.scrolls&&layout.top>=0&&layout.bottom<layout.composerTop&&layout.composer===42&&layout.input===24,'message height '+requested+' fits '+width+'x'+height+' without resizing composer');
  if(height===1100)check(layout.height===requested,'unclipped message region reaches '+requested+'px');
  check(context.inputRegions.some(r=>r.y<=layout.top+2&&r.y+r.height>=layout.bottom-2),'resized message region stays in native mouse hit regions');
  samples.push({kind:'message-height',width,height,requested,...layout});
  await js("document.body.style.background='#fff'");
  await fs.writeFile(path.join(output,`${packaged?'packaged-':''}height-${width}-${height}-${requested}.png`),(await win.webContents.capturePage()).toPNG());
  await js("document.body.style.background='transparent'");
 }
 check(captureCalls===beforeHeightCapture,'height changes never trigger capture');
 check(errors.length===0,'no renderer errors');
 await manager.close();
 const report={packaged,apiMode,version,checks,samples,captureCalls,generatedFixtureRequests:modelRequests.length,loopbackRequests:wireRequests.length,errors,limitations:['Synthetic PNG capture callback and local model fixture only','DOM pointer event replay, not physical desktop FPS measurement','Native setShape and production hit-region reporting exercised']};
 await fs.writeFile(path.join(output,(packaged?'packaged-':'source-')+(apiMode?'api-':'')+'ui.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({checks:checks.length,captureCalls,loopbackRequests:wireRequests.length,errors}));win.destroy();if(server)await new Promise(resolve=>server.close(resolve));app.quit();
}).catch(async error=>{await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,packaged?'packaged-ui-error.txt':'source-ui-error.txt'),String(error.stack||error));console.error(error);app.exit(1);});
