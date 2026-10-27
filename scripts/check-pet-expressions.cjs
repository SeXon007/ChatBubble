// Render the real pet with a controlled animation clock in an invisible window.
// All screen capture requests are spies; capturePage reads only this fixture UI.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises'), syncFs = require('node:fs');
const os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const root=path.resolve(__dirname,'..'),packaged=process.argv.includes('--packaged');
const runtime=path.join(root,packaged?`release/ChatBubble-${require('../package.json').version}-win32-x64/resources/app/dist`:'dist');
const output=path.join(root,'docs/verification/pet-expression-rollback');
app.setPath('userData',syncFs.mkdtempSync(path.join(os.tmpdir(),'chatbubble-face-')));
app.disableHardwareAcceleration();app.commandLine.appendSwitch('force-device-scale-factor','1');
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
  const { initialState }=require(path.join(runtime,'model')),{petDefaults}=require(path.join(runtime,'pet-state'));
  const shouldCaptureOnExpand=()=>false;
  const state=initialState();Object.assign(state.settings,{provider:'codex-cli',screenCaptureEnabled:true});
  let mode='collapsed',captures=0,sceneOptions={...petDefaults},position={x:400,y:300,side:null,displayId:1};
  const win=new BrowserWindow({width:800,height:600,frame:false,transparent:true,show:false,focusable:false,webPreferences:{preload:path.join(runtime,'preload.js'),sandbox:true,contextIsolation:true,backgroundThrottling:false}});
  ipcMain.handle('desktop:scene',()=>({bounds:{x:0,y:0,width:800,height:600},areas:[{x:0,y:0,width:800,height:600,id:1}],mode,position,options:sceneOptions}));
  ipcMain.handle('desktop:shape',()=>{});ipcMain.handle('desktop:position',()=>{});ipcMain.handle('chat:draft',()=>{});
  ipcMain.handle('chat:state',()=>({...state,busy:false,hasKey:false,warning:'',storage:{directory:output,archiveDirectory:output,appDirectory:output}}));
  ipcMain.handle('window:mode',(_e,next)=>{if(shouldCaptureOnExpand(mode,next,state.settings.provider,state.settings.screenCaptureEnabled))captures++;mode=next;win.webContents.send('window:mode',next);});
  await win.loadURL('about:blank');
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Page.enable');
  await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.__faceClock=0;const frames=new Map();let frameId=0;
    performance.now=()=>window.__faceClock;
    window.requestAnimationFrame=fn=>{frames.set(++frameId,fn);return frameId;};
    window.cancelAnimationFrame=id=>frames.delete(id);
    window.advancePet=ms=>{while(ms>0){const dt=Math.min(ms,16);ms-=dt;window.__faceClock+=dt;const batch=[...frames.values()];frames.clear();for(const fn of batch)fn(window.__faceClock);}};
  `});
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  const js=code=>win.webContents.executeJavaScript(code),pause=ms=>new Promise(r=>setTimeout(r,ms));
  const samples=[],framesDir=path.join(output,packaged?'packaged-frames':'frames');await fs.mkdir(framesDir,{recursive:true});
  async function load(){mode='collapsed';captures=0;Object.assign(state.settings,sceneOptions);await win.loadFile(path.join(runtime,'ui/index.html'));
    for(let i=0;i<200&&!await js('!!window.pet');i++)await pause(10);assert.ok(await js('!!window.pet'));
    await js(`(()=>{const pet=document.querySelector('#cb-pet');let held=false;pet.setPointerCapture=()=>{held=true};pet.hasPointerCapture=()=>held;pet.releasePointerCapture=()=>{held=false};window.gesture=(type,x,y)=>pet.dispatchEvent(new PointerEvent(type,{button:0,pointerId:1,clientX:x,clientY:y,bubbles:true}));advancePet(160);})()`);
  }
  const advance=ms=>js(`advancePet(${ms})`);
  const armCuriosity=()=>js(`(()=>{const p=window.pet.inspect(),dx=p.x>600?-60:60,screen=document.querySelector('#cb-desktop');for(const x of [p.x+dx,p.x+dx*.8])screen.dispatchEvent(new PointerEvent('pointermove',{clientX:x,clientY:p.y,bubbles:true}));})()`);
  async function sample(name,capture=false){const sample=await js(`(()=>{const p=window.pet.inspect(),body=document.querySelector('#cb-body');
    const eyes=[...document.querySelectorAll('#cb-eye-left,#cb-eye-right')].map(e=>{const x=+e.getAttribute('x'),y=+e.getAttribute('y'),w=+e.getAttribute('width'),h=+e.getAttribute('height'),m=body.getCTM().inverse().multiply(e.getCTM());const corners=[[x,y],[x+w,y],[x,y+h],[x+w,y+h]];return {x,y,width:w,height:h,transform:e.getAttribute('transform'),inside:corners.every(([px,py])=>body.isPointInFill(new DOMPoint(px,py).matrixTransform(m)))};});return {clock:performance.now(),...p,eyes}})()`);
    assert.ok(sample.eyes.every(e=>e.inside),name+': rotated eye must remain within the silhouette');
    assert.ok(sample.eyes.every(e=>[e.x,e.y,e.width,e.height].every(Number.isFinite)),name+': finite geometry');
    samples.push({name,...sample});if(capture){const x=Math.max(0,Math.min(600,Math.round(sample.x-100))),y=Math.max(0,Math.min(400,Math.round(sample.y-100)));await fs.writeFile(path.join(framesDir,name+'.png'),(await win.webContents.capturePage({x,y,width:200,height:200})).toPNG());}return sample;
  }
  await load();await advance(60000);const rest=await sample('sleep',true);assert.equal(rest.expression,'rest');assert.equal(rest.faceAction,'');assert.ok(rest.eyes.every(e=>e.height<3));
  await armCuriosity();await advance(21000);
  for(let i=0;i<72;i++){await advance(80);await sample('curious-'+String(i).padStart(3,'0'),!packaged);}
  const curious=samples.filter(s=>s.faceAction==='curious');assert.ok(curious.length>10);
  const gazeX=s=>s.eyes.reduce((sum,e)=>sum+e.x+e.width/2,0)/2-s.x;
  const left=curious.find(s=>gazeX(s)<-3),right=curious.find(s=>gazeX(s)>3);assert.ok(left&&right);
  assert.ok(left.eyes[0].height<left.eyes[1].height,'left eye is shorter while looking left');assert.ok(right.eyes[1].height<right.eyes[0].height,'right eye is shorter while looking right');
  assert.ok(curious.some(s=>s.eyes.some(e=>e.height>8)));const asleep=await sample('sleep-again',true);assert.ok(asleep.eyes.every(e=>e.height<3));assert.equal(asleep.faceAction,'');
  await advance(150000);assert.equal((await sample('no-stationary-repeat')).faceAction,'');
  await load();await js(`(()=>{const p=window.pet.inspect();gesture('pointerdown',p.x,p.y);gesture('pointermove',p.x+70,p.y+12)})()`);
  for(let i=0;i<16;i++){await advance(64);await sample('drag-'+String(i).padStart(3,'0'),!packaged);}
  assert.ok(samples.some(s=>s.faceAction==='drag-recoil'&&s.eyes.some(e=>!e.transform.startsWith('rotate(0.00'))));assert.equal(captures,0);
  await js(`(()=>{const p=window.pet.inspect();gesture('pointerup',p.tx,p.ty)})()`);
  for(let i=0;i<20;i++){await advance(48);await sample('settle-'+String(i).padStart(3,'0'),!packaged);}
  assert.ok(samples.some(s=>s.faceAction==='settle-blink'&&s.eyes.some(e=>e.height<5)));assert.equal(captures,0);assert.equal(mode,'collapsed');
  const settleFrames=samples.filter(s=>s.name.startsWith('settle-'));
  assert.equal(settleFrames.filter((s,i)=>s.faceAction==='settle-blink'&&(i===0||settleFrames[i-1].faceAction!=='settle-blink')).length,2);
  // A real pointer movement interrupts curiosity and resumes the existing follow.
  await load();await armCuriosity();await advance(22800);assert.equal((await sample('before-wake')).faceAction,'curious');
  await js(`(()=>{const p=window.pet.inspect();document.querySelector('#cb-desktop').dispatchEvent(new PointerEvent('pointermove',{clientX:p.x+120,clientY:p.y,bubbles:true}));})()`);await advance(400);
  const awake=await sample('cursor-follow',true);assert.equal(awake.faceAction,'');assert.equal(awake.expression,'idle');assert.ok(awake.eyes[1].x>awake.x+8);
  // Repeat eye-containment checks at extreme eye/body sizes and all dock sides.
  for(const side of [null,'left','right','top','bottom']){
    sceneOptions={...petDefaults,petSize:60,petEyeSize:140};position={x:400,y:300,side,displayId:1};await load();await armCuriosity();await advance(22800);await sample('small-'+(side||'free'),true);
    const p=await js('window.pet.inspect()');await js(`gesture('pointerdown',${p.x},${p.y});gesture('pointermove',${400},${300})`);await advance(100);await sample('small-drag-'+(side||'free'));await js('gesture("pointercancel",400,300)');
  }
  // Respect the real media query and keep a click's expand/capture contract.
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  sceneOptions={...petDefaults};position={x:400,y:300,side:null,displayId:1};await load();await armCuriosity();await advance(22800);assert.equal((await sample('reduced-rest',true)).faceAction,'');
  await js(`(()=>{const p=window.pet.inspect();gesture('pointerdown',p.x,p.y);gesture('pointermove',p.x+60,p.y+15)})()`);await advance(100);assert.equal((await sample('reduced-drag')).faceAction,'');
  await js(`(()=>{const p=window.pet.inspect();gesture('pointerup',p.tx,p.ty)})()`);await advance(1000);assert.equal((await sample('reduced-settle')).faceAction,'');assert.equal(captures,0);
  await js(`(()=>{const p=window.pet.inspect();gesture('pointerdown',p.x,p.y);gesture('pointerup',p.x,p.y)})()`);await pause(30);await advance(2000);assert.equal(captures,1);assert.equal(mode,'expanded');assert.equal((await sample('expanded')).faceAction,'');
  const report={packaged,controlledProductionAnimation:true,allEyesInside:true,idlePeeksBothWaysAndSleepsAgain:true,directionalEyeSizeSwap:true,noStationaryRepeat:true,dragReaction:true,settleBlink:true,inputInterruptsIdle:true,
    reducedMotionDisablesAdditions:true,dragCaptures:0,clickCaptures:captures,samples,limitations:['Synthetic timing and mouse events in a hidden window','No user screen capture, model request or real application activation','Subjective animation feel requires restarting the app']};
  await fs.writeFile(path.join(output,packaged?'packaged-report.json':'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,samples:report.samples.length}));win.destroy();app.quit();
}).catch(error=>{console.error(error);app.exit(1);});
