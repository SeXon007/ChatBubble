// Hidden production pages, real preload IPC, controlled animation clock.
// Capture is a counter; no user data, real screen content or model requests.
const {app,BrowserWindow,ipcMain,nativeTheme}=require('electron');
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),vm=require('node:vm'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),smoothVideo=process.argv.includes('--smooth-video'),fixtures=path.join(root,smoothVideo?'docs/verification/stretch-smooth-video':'docs/verification/right-interactions'),out=process.env.CHATBUBBLE_INTERACTION_OUTPUT||fixtures,packaged=process.argv.includes('--packaged');
const runtime=path.join(root,packaged?`release/ChatBubble-${require('../package.json').version}-win32-x64/resources/app/dist`:'dist');
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'chatbubble-right-')));app.disableHardwareAcceleration();app.commandLine.appendSwitch('force-device-scale-factor','1');app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
  const {initialState}=require(path.join(runtime,'model')),{petDefaults,shapeRegions}=require(path.join(runtime,'pet-state'));
  const shouldCaptureOnExpand=()=>false;
  const contexts=new Map(),errors=[],report={packaged,controlledClock:true,syntheticGestures:true,captureSpyOnly:true,baseline:[],approvedHop:[],hops:[],stretches:[],contactFaces:[],extremes:[],edgeCases:[],nativeRegions:{},errors};
  const originalUI=path.join(out,'original-ui'),approvedUI=path.join(out,'approved-ui');
  for(const dir of [originalUI,approvedUI])await fsp.cp(path.join(runtime,'ui'),dir,{recursive:true});
  await fsp.copyFile(path.join(fixtures,'pet-before.js'),path.join(originalUI,'pet.js'));
  // Compare the approved animation with the same current landing selection.
  // Random direction is now intentionally different from the centre-biased preview.
  const findTarget=text=>{const ast=ts.createSourceFile('pet.js',text,ts.ScriptTarget.ES2022,true,ts.ScriptKind.JS);let fn;function visit(n){if(ts.isFunctionDeclaration(n)&&n.name?.text==='rightTarget')fn=n;ts.forEachChild(n,visit)}visit(ast);assert.ok(fn);return {start:fn.getStart(ast),end:fn.end,text:fn.getText(ast)}};
  const approved=fs.readFileSync(path.join(fixtures,'approved-pet.js'),'utf8'),oldTarget=findTarget(approved),currentTarget=findTarget(fs.readFileSync(path.join(runtime,'ui/pet.js'),'utf8'));
  await fsp.writeFile(path.join(approvedUI,'pet.js'),"window.realPreviewHost={mode:()=> 'hop',tuning:{distance:126,height:46,softness:.24},status:()=>{},scene:()=>{},save:()=>{}};\n"+approved.slice(0,oldTarget.start)+currentTarget.text.replaceAll('rightTuning','previewHost.tuning')+approved.slice(oldTarget.end));
  const mainSource=ts.createSourceFile('main.ts',fs.readFileSync(path.join(root,'src/main.ts'),'utf8'),ts.ScriptTarget.ES2022,true);
  const updateNative=mainSource.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='updateNativeShape');
  const ctx=e=>{const c=contexts.get(e.sender.id);assert.ok(c,'isolated sender');return c;};
  ipcMain.handle('desktop:scene',e=>ctx(e).scene);
  ipcMain.handle('chat:state',e=>({...ctx(e).state,busy:false,hasKey:false,warning:'',storage:{directory:out,archiveDirectory:out,appDirectory:out}}));
  ipcMain.handle('chat:draft',()=>{});
  ipcMain.handle('desktop:position',(e,p)=>{ctx(e).positions.push(p);});
  ipcMain.handle('window:mode',(e,next)=>{const c=ctx(e);c.modeCalls.push(next);if(shouldCaptureOnExpand(c.mode,next,c.state.settings.provider,true))c.captures++;c.mode=next;c.win.webContents.send('window:mode',next);});
  ipcMain.handle('desktop:shape',(e,raw,dragging,paint=[])=>{const c=ctx(e);c.dragging=dragging;c.regions=raw;c.regionHistory.push(dragging);if(c.native){c.native.inputRegions=shapeRegions(raw,c.scene.bounds);c.native.nativePaintRegions=paint.length?shapeRegions(paint,c.scene.bounds):[];c.native.petDragging=dragging;c.native.updateNativeShape();}});
  const js=(c,code)=>c.win.webContents.executeJavaScript(code),pause=ms=>new Promise(r=>setTimeout(r,ms));
  async function make(){
    const win=new BrowserWindow({width:736,height:400,show:false,focusable:false,frame:false,transparent:true,webPreferences:{preload:path.join(runtime,'preload.js'),sandbox:true,contextIsolation:true,backgroundThrottling:false,offscreen:true}});
    win.webContents.startPainting();win.webContents.setFrameRate(60);win.webContents.on('console-message',(...args)=>{const e=typeof args[1]==='object'?args[1]:{level:args[1],message:args[2]};if(e.level==='error'||e.level===3)errors.push(e.message);});
    const state=initialState();Object.assign(state.settings,petDefaults,{petWidth:320,provider:'codex-cli',screenCaptureEnabled:true});
    const c={win,state,mode:'collapsed',captures:0,modeCalls:[],positions:[],regionHistory:[],dragging:false,regions:[]};contexts.set(win.webContents.id,c);
    await win.loadURL('about:blank');
    win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Page.enable');
    await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument',{source:`window.__clock=0;window.__frames=[];performance.now=()=>window.__clock;window.requestAnimationFrame=fn=>(window.__frames.push(fn),window.__frames.length);window.advancePet=ms=>{while(ms>0){const dt=Math.min(16,ms);ms-=dt;window.__clock+=dt;const batch=window.__frames.splice(0);for(const fn of batch)fn(window.__clock);}};`});
    return c;
  }
  async function load(c,page=path.join(runtime,'ui/index.html'),width=736,height=400,options={}){
    c.win.setContentSize(width,height);c.mode='collapsed';c.captures=0;c.modeCalls=[];c.positions=[];c.regionHistory=[];c.dragging=false;
    Object.assign(c.state.settings,petDefaults,{petWidth:320},options);
    c.scene={bounds:{x:0,y:0,width,height},areas:[{x:0,y:0,width,height,id:1}],position:{x:width/2,y:height*.58,side:null,displayId:1},options:{...c.state.settings},mode:'collapsed'};
    await c.win.loadFile(page);for(let i=0;i<200&&!await js(c,'!!window.pet');i++)await pause(10);assert.ok(await js(c,'!!window.pet'));
    await js(c,`(()=>{const p=document.querySelector('#cb-pet');let held=false;p.setPointerCapture=()=>{held=true;};p.hasPointerCapture=()=>held;p.releasePointerCapture=()=>{held=false;};window.gesture=(type,x,y,button=0,id=1)=>p.dispatchEvent(new PointerEvent(type,{button,pointerId:id,clientX:x,clientY:y,bubbles:true}));window.contextPet=()=>p.dispatchEvent(new MouseEvent('contextmenu',{button:2,bubbles:true,cancelable:true}));window.placeTest=(where)=>{const s=pet.inspect();const next=window.__scene;window.desktop.setMode('collapsed');};})();advancePet(1000);`);
  }
  async function place(c,where){
    const w=c.scene.bounds.width,h=c.scene.bounds.height,margin=69*c.state.settings.petSize/100+4;
    c.scene.position={x:['tl','bl'].includes(where)?margin:['tr','br'].includes(where)?w-margin:w/2,y:where.startsWith('t')?margin:where.startsWith('b')?h-margin:h*.58,side:['left','right','top','bottom'].includes(where)?where:null,displayId:1};
    c.win.webContents.send('desktop:scene',c.scene);await js(c,'advancePet(3000)');
  }
  const actual=await make(),old=await make();
  const snapshot=`(()=>({body:document.querySelector('#cb-body').getAttribute('d'),eyes:['cb-eye-left','cb-eye-right'].map(id=>{const e=document.getElementById(id);return ['x','y','width','height','rx','transform'].map(k=>e.getAttribute(k));}),state:pet.inspect(),hidden:document.querySelector('#composer').hidden}))()`;
  await load(actual);await load(old,path.join(originalUI,'index.html'));
  for(const [name,code]of [
    ['idle','advancePet(800)'],
    ['left-dock',`(()=>{const s=pet.inspect();gesture('pointerdown',s.x,s.y);gesture('pointermove',22,s.y);advancePet(220);gesture('pointerup',22,s.y);advancePet(2600);})()`],
    ['free-drag',`(()=>{const s=pet.inspect();gesture('pointerdown',s.x,s.y);gesture('pointermove',s.x+170,s.y-35);advancePet(320);gesture('pointerup',s.x+170,s.y-35);advancePet(2400);})()`],
    ['expand',`(()=>{const s=pet.inspect();gesture('pointerdown',s.x,s.y);gesture('pointerup',s.x,s.y);advancePet(1400);})()`],
    ['collapse',`desktop.setMode('collapsed');advancePet(1600)`],['sleep','advancePet(15000)']
  ]){await js(actual,code);await js(old,code);assert.deepEqual(await js(actual,snapshot),await js(old,snapshot),name);report.baseline.push(name);}
  for(const where of ['center','left','br']){
    await load(actual);await load(old,path.join(approvedUI,'index.html'));await place(actual,where);await place(old,where);
    const code=`(()=>{let seed=91;Math.random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);const s=pet.inspect();gesture('pointerdown',s.x,s.y,2);gesture('pointerup',s.x,s.y,2);contextPet();const samples=[];for(let i=0;i<150;i++){advancePet(16);samples.push({body:document.querySelector('#cb-body').getAttribute('d'),eyes:[...document.querySelectorAll('#cb-eye-left,#cb-eye-right')].map(e=>['x','y','width','height'].map(k=>e.getAttribute(k))),state:pet.inspect()});}return samples;})()`;
    assert.deepEqual(await js(actual,code),await js(old,code),'approved hop '+where);report.approvedHop.push({where,frames:150,identical:true,matchedTargetSelection:true});
  }
  old.win.destroy();
  const bounded=`const b=document.querySelector('#cb-body').getBBox();if(b.x< -2||b.y< -2||b.x+b.width>WIDTH+2||b.y+b.height>HEIGHT+2)bad.push({x:b.x,y:b.y,w:b.width,h:b.height});`;
  for(const width of [736,360,320]){
    nativeTheme.themeSource=width===360?'dark':'light';await load(actual,undefined,width);
    assert.equal(await js(actual,'document.documentElement.scrollWidth>innerWidth'),false);
    for(const where of ['center','left','right','top','bottom','tl','tr','bl','br']){
      await place(actual,where);cReset(actual);
      const hop=await js(actual,`(()=>{const s=pet.inspect();gesture('pointerdown',s.x,s.y,2);gesture('pointerup',s.x,s.y,2);contextPet();const bad=[];for(let i=0;i<150;i++){advancePet(16);${bounded.replaceAll('WIDTH',width).replaceAll('HEIGHT',400)}}const t=pet.inspect();return {bad,distance:Math.hypot(s.x-t.x,s.y-t.y),active:document.querySelector('#cb-pet').dataset.interaction};})()`);
      assert.deepEqual(hop.bad,[]);assert.ok(hop.distance>15);assert.equal(hop.active,'');assert.equal(actual.captures,0);assert.deepEqual(actual.modeCalls,[]);report.hops.push({width,where,...hop});
      for(const dir of [[220,0],[-220,0],[0,-220],[0,220]]){
        await place(actual,where);cReset(actual);
        const result=await js(actual,`(()=>{const s=pet.inspect();gesture('pointerdown',s.x,s.y,2);gesture('pointermove',s.x+${dir[0]},s.y+${dir[1]},2);const bad=[];for(let i=0;i<45;i++){advancePet(16);${bounded.replaceAll('WIDTH',width).replaceAll('HEIGHT',400)}}const held=document.querySelector('#cb-pet').dataset.rightHeld;gesture('pointerup',s.x+${dir[0]},s.y+${dir[1]},2);contextPet();for(let i=0;i<120;i++){advancePet(16);${bounded.replaceAll('WIDTH',width).replaceAll('HEIGHT',400)}}const t=pet.inspect();return {bad,held,displacement:Math.hypot(t.x-s.x,t.y-s.y),side:t.side,beforeSide:s.side,active:document.querySelector('#cb-pet').dataset.interaction};})()`);
        assert.deepEqual(result.bad,[]);assert.equal(result.held,'true');assert.ok(result.displacement<.5);assert.equal(result.side,result.beforeSide);assert.equal(result.active,'');assert.equal(actual.captures,0);assert.deepEqual(actual.modeCalls,[]);assert.equal(actual.dragging,false);report.stretches.push({width,where,dir,...result});
      }
    }
  }
  function cReset(c){c.captures=0;c.modeCalls=[];c.regionHistory=[];}
  if(smoothVideo){
    for(const width of [736,360,320]){
      await load(actual,undefined,width);
      for(const where of ['left','right','top','bottom'])for(const dir of [[160,120],[160,-120],[-160,120],[-160,-120]]){
        await place(actual,where);
        const result=await js(actual,`(()=>{const body=document.querySelector('#cb-body');function vertices(){const a=body.getAttribute('d').match(/[-+]?(?:\\d*\\.)?\\d+(?:e[-+]?\\d+)?/gi).map(Number),out=[[a[0],a[1]]];for(let i=2;i<a.length;i+=6)out.push([a[i+4],a[i+5]]);return out;}const before=vertices(),side=${JSON.stringify(where)},axis=side==='left'||side==='right'?0:1,plane=side==='right'?${width}:side==='bottom'?400:0,contact=before.map((p,i)=>Math.abs(p[axis]-plane)<.1?i:-1).filter(i=>i>=0),s=pet.inspect();gesture('pointerdown',s.x,s.y,2);gesture('pointermove',s.x+${dir[0]},s.y+${dir[1]},2);advancePet(750);const after=vertices(),maxShift=Math.max(0,...contact.map(i=>Math.hypot(after[i][0]-before[i][0],after[i][1]-before[i][1])));gesture('pointerup',s.x+${dir[0]},s.y+${dir[1]},2);advancePet(2200);return {contactPoints:contact.length,maxShift};})()`);
        assert.ok(result.contactPoints>5);assert.ok(result.maxShift<.1,'fixed contact '+where+' '+dir);report.contactFaces.push({width,where,dir,...result});
      }
    }
  }
  for(const size of [60,100]){
    await load(actual,undefined,736,400,{petSize:size,petEyeSize:140,petGaze:32,petLife:1.8});
    for(const where of ['center','left','right','top','bottom']){
      await place(actual,where);
      const result=await js(actual,`(()=>{const failures=[],body=document.querySelector('#cb-body'),s=pet.inspect();function check(){for(const e of document.querySelector('#cb-eyes').children){if(e.getAttribute('opacity')==='0')continue;const b=e.getBBox(),pad=e.tagName==='path'?Number(e.getAttribute('stroke-width'))/2:0,m=body.getCTM().inverse().multiply(e.getCTM());for(const [x,y]of [[b.x-pad,b.y-pad],[b.x+b.width+pad,b.y-pad],[b.x-pad,b.y+b.height+pad],[b.x+b.width+pad,b.y+b.height+pad]])if(!body.isPointInFill(new DOMPoint(x,y).matrixTransform(m))){failures.push({tag:e.tagName,x,y});break;}}}gesture('pointerdown',s.x,s.y,2);gesture('pointerup',s.x,s.y,2);for(let i=0;i<150;i++){advancePet(16);check();}const t=pet.inspect();gesture('pointerdown',t.x,t.y,2);gesture('pointermove',t.x+150,t.y-80,2);for(let i=0;i<45;i++){advancePet(16);check();}gesture('pointerup',t.x+150,t.y-80,2);advancePet(2400);return {failures};})()`);
      assert.deepEqual(result.failures,[],'eye contour at size '+size+' '+where);assert.equal(actual.captures,0);report.extremes.push({size,where,eyesInside:true});
    }
  }
  await load(actual);await place(actual,'center');
  for(const [name,steps]of [
    ['fast release without move',`gesture('pointerup',s.x+90,s.y,2)`],
    ['return to start',`gesture('pointermove',s.x+90,s.y,2);advancePet(100);gesture('pointerup',s.x,s.y,2)`],
    ['cancel',`gesture('pointercancel',s.x,s.y,2)`],
    ['capture loss',`gesture('lostpointercapture',s.x,s.y,2)`],
    ['blur',`window.dispatchEvent(new Event('blur'))`],
    ['hidden',`desktop.setMode('hidden')`]
  ]){await load(actual);cReset(actual);await js(actual,`(()=>{const s=pet.inspect();gesture('pointerdown',s.x,s.y,2);${steps}})()`);if(name==='hidden')await js(actual,"desktop.setMode('hidden')");assert.equal(actual.dragging,false,name+' releases without a frame');await js(actual,'advancePet(2500)');assert.equal(actual.captures,0);assert.ok(!actual.modeCalls.includes('expanded'));assert.equal(await js(actual,"document.querySelector('#cb-pet').dataset.interaction"),'');report.edgeCases.push(name);}
  await load(actual);await actual.win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await js(actual,`(()=>{const s=pet.inspect();gesture('pointerdown',s.x,s.y,2);gesture('pointerup',s.x,s.y,2);advancePet(1500);})()`);assert.equal(await js(actual,"document.querySelector('#cb-pet').dataset.interaction"),'');report.edgeCases.push('reduced motion suppresses automatic hop');
  await actual.win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await load(actual);
  let shapeCalls=0;actual.native={inputRegions:[],nativePaintRegions:[],expandedBounds:actual.scene.bounds,petDragging:false,nativeShape:'',window:{setShape:regions=>{shapeCalls++;actual.win.setShape(regions);}}};vm.createContext(actual.native);
  vm.runInContext(ts.transpileModule(updateNative.getText(mainSource),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,actual.native);
  await js(actual,`(()=>{const s=pet.inspect();gesture('pointerdown',s.x,s.y,2);gesture('pointermove',s.x+140,s.y-40,2);advancePet(500);})()`);
  const heldCalls=shapeCalls;assert.equal(actual.native.petDragging,true);await js(actual,'advancePet(300)');assert.equal(shapeCalls,heldCalls,'Native region is stable during capture');
  await js(actual,`(()=>{const s=pet.inspect();gesture('pointerup',s.x+140,s.y-40,2);})()`);assert.equal(actual.native.petDragging,false);assert.ok(actual.native.inputRegions.length>0);report.nativeRegions={stableDuringCapture:true,immediateRelease:true,shapeCalls};
  await js(actual,'advancePet(2200)');await pause(60);await fsp.writeFile(path.join(out,packaged?'packaged-stretch.png':'stretch.png'),(await actual.win.webContents.capturePage()).toPNG());
  actual.native=null;
  if(smoothVideo){
    const before=await make(),oldMain=ts.createSourceFile('main.ts',fs.readFileSync(path.join(fixtures,'main-before.ts'),'utf8'),ts.ScriptTarget.ES2022,true),oldUpdate=oldMain.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='updateNativeShape');
    async function measure(c,page,fn,button=2){
      await load(c,page,1920,1080);const calls=[];c.native={inputRegions:shapeRegions(c.regions,c.scene.bounds),nativePaintRegions:[],expandedBounds:c.scene.bounds,petDragging:false,nativeShape:'',window:{setShape:regions=>{calls.push(JSON.parse(JSON.stringify(regions)));c.win.setShape(regions);}}};vm.createContext(c.native);vm.runInContext(ts.transpileModule(fn.getText(fn===oldUpdate?oldMain:mainSource),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,c.native);c.native.updateNativeShape();
      await js(c,'desktop.setRegions('+JSON.stringify(c.regions)+',false)');calls.length=0;cReset(c);
      let releaseShapeCalls;
      if(button===2)await js(c,`(()=>{let seed=91;Math.random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);const s=pet.inspect();gesture('pointerdown',s.x,s.y,2);gesture('pointerup',s.x,s.y,2);contextPet();advancePet(2600);})()`);
      else{await js(c,`(()=>{const s=pet.inspect();window.__endPoint={x:s.x+260,y:s.y+80};gesture('pointerdown',s.x,s.y);gesture('pointermove',__endPoint.x,__endPoint.y);advancePet(400);})()`);const count=calls.length;await js(c,"gesture('pointerup',__endPoint.x,__endPoint.y)");releaseShapeCalls=calls.length-count;await js(c,'advancePet(2600)');}
      const result={setShapeCalls:calls.length,releaseShapeCalls,unrestrictedCalls:calls.filter(r=>!r.length).length,maxPaintArea:Math.max(0,...calls.filter(r=>r.length).map(r=>r.reduce((sum,x)=>sum+x.width*x.height,0))),desktopArea:1920*1080,captures:c.captures,modeCalls:c.modeCalls};c.native=null;return result;
    }
    report.shapePerformance={before:await measure(before,path.join(originalUI,'index.html'),oldUpdate),after:await measure(actual,path.join(runtime,'ui/index.html'),updateNative)};
    assert.ok(report.shapePerformance.before.unrestrictedCalls>=1);assert.equal(report.shapePerformance.after.unrestrictedCalls,0);assert.ok(report.shapePerformance.after.setShapeCalls<=4);assert.ok(report.shapePerformance.after.setShapeCalls<report.shapePerformance.before.setShapeCalls);assert.equal(report.shapePerformance.after.captures,0);assert.deepEqual(report.shapePerformance.after.modeCalls,[]);
    report.leftDragPerformance={before:await measure(before,path.join(originalUI,'index.html'),oldUpdate,0),after:await measure(actual,path.join(runtime,'ui/index.html'),updateNative,0)};
    assert.ok(report.leftDragPerformance.before.unrestrictedCalls>=1);assert.equal(report.leftDragPerformance.after.unrestrictedCalls,0);assert.equal(report.leftDragPerformance.after.releaseShapeCalls,0);assert.ok(report.leftDragPerformance.after.setShapeCalls<report.leftDragPerformance.before.setShapeCalls);assert.equal(report.leftDragPerformance.after.captures,0);
    for(const [c,label]of [[before,'before'],[actual,'after']]){await load(c,label==='before'?path.join(originalUI,'index.html'):path.join(runtime,'ui/index.html'),360,450);await place(c,'right');await js(c,`(()=>{document.body.style.background='#ffffff';const s=pet.inspect();gesture('pointerdown',s.x,s.y,2);gesture('pointermove',s.x-140,s.y+120,2);advancePet(700);})()`);await pause(50);await fsp.writeFile(path.join(out,(packaged?'packaged-':'')+label+'-rounded.png'),(await c.win.webContents.capturePage()).toPNG());await js(c,`(()=>{const s=pet.inspect();gesture('pointercancel',s.x,s.y,2);advancePet(2300);})()`);}
    before.win.destroy();
    await load(actual,undefined,800,600);const nativeCalls=[];actual.native={inputRegions:shapeRegions(actual.regions,actual.scene.bounds),nativePaintRegions:[],expandedBounds:actual.scene.bounds,petDragging:false,nativeShape:'',window:{setShape:r=>{nativeCalls.push(r);actual.win.setShape(r);}}};vm.createContext(actual.native);vm.runInContext(ts.transpileModule(updateNative.getText(mainSource),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,actual.native);actual.native.updateNativeShape();
    await js(actual,`(()=>{const p=document.querySelector('#cb-pet');delete p.setPointerCapture;delete p.hasPointerCapture;delete p.releasePointerCapture;window.__trustedPointers=[];for(const type of ['pointerdown','pointerup','lostpointercapture'])p.addEventListener(type,e=>__trustedPointers.push({type,id:e.pointerId,trusted:e.isTrusted}));})()`);actual.win.webContents.focus();
    const start=await js(actual,'pet.inspect()');actual.win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(start.x),y:Math.round(start.y)});actual.win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:Math.round(start.x),y:Math.round(start.y)});await pause(30);
    const initialInput=await js(actual,"(()=>{const e=__trustedPointers.find(e=>e.type==='pointerdown');return {events:__trustedPointers,state:pet.inspect(),capture:!!e&&document.querySelector('#cb-pet').hasPointerCapture(e.id)};})()");await fsp.writeFile(path.join(out,'native-input-debug.json'),JSON.stringify(initialInput,null,2));
    for(const [x,y]of [[start.x+100,start.y],[650,420]]){actual.win.webContents.sendInputEvent({type:'mouseMove',button:'left',modifiers:['leftButtonDown'],x:Math.round(x),y:Math.round(y)});await pause(30);await js(actual,'advancePet(300)');await pause(30);const input=await js(actual,"(()=>{const e=__trustedPointers.find(e=>e.type==='pointerdown');return {events:__trustedPointers,state:pet.inspect(),capture:!!e&&document.querySelector('#cb-pet').hasPointerCapture(e.id)};})()");await fsp.writeFile(path.join(out,'native-input-debug.json'),JSON.stringify({initialInput,input,errors},null,2));assert.equal(input.capture,true,'capture survives local region expansion');}
    actual.win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:650,y:420});await pause(30);await js(actual,'advancePet(2400)');report.nativeMouseCapture={events:await js(actual,'__trustedPointers'),unrestrictedCalls:nativeCalls.filter(r=>!r.length).length};assert.equal(report.nativeMouseCapture.unrestrictedCalls,0);assert.ok(report.nativeMouseCapture.events.some(e=>e.type==='pointerdown'&&e.trusted));actual.native=null;
  }
  await load(actual);await js(actual,`(()=>{const s=pet.inspect();gesture('pointerdown',s.x,s.y);gesture('pointerup',s.x,s.y);advancePet(1500);})()`);assert.equal(actual.captures,0);assert.equal(actual.mode,'expanded');report.leftClickCapture=0;
  assert.deepEqual(errors,[]);await fsp.writeFile(path.join(out,packaged?'packaged-report.json':'report.json'),JSON.stringify(report,null,2));await fsp.rm(path.join(out,packaged?'packaged-error.txt':'error.txt'),{force:true});console.log(JSON.stringify({packaged,baseline:report.baseline.length,approved:report.approvedHop.length,hops:report.hops.length,stretches:report.stretches.length,contactFaces:report.contactFaces.length,shapePerformance:report.shapePerformance,leftDragPerformance:report.leftDragPerformance,nativeMouseCapture:report.nativeMouseCapture,extremes:report.extremes.length,edges:report.edgeCases,native:report.nativeRegions,errors}));actual.win.destroy();app.quit();
}).catch(e=>{fs.writeFileSync(path.join(out,packaged?'packaged-error.txt':'error.txt'),String(e.stack));console.error(e);app.exit(1);});
