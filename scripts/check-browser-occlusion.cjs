// Real isolated Edge app with native occlusion enabled by its normal defaults.
// Only a generated animation is served over loopback; no real user page or input.
const {app,BrowserWindow,screen}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn,execFileSync}=require('node:child_process'),assert=require('node:assert/strict'),ts=require('typescript'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),out=path.join(root,'docs/verification/input-stall-0.9.0');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
app.setPath('userData',require('node:fs').mkdtempSync(path.join(os.tmpdir(),'chatbubble-browser-occlusion-')));
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
 const samples=[];let browser;
 const title='ChatBubble isolated video fixture '+require('node:crypto').randomUUID();
 const html=`<title>${title}</title><style>body{background:#243546;color:white}video{width:500px;height:280px}</style><h2>ChatBubble playback regression fixture</h2><video autoplay muted></video><script>
 const canvas=document.createElement('canvas');canvas.width=500;canvas.height=280;const ctx=canvas.getContext('2d'),v=document.querySelector('video');
 let frames=0,videoFrames=0,changes=[];v.srcObject=canvas.captureStream(60);v.play();
 function tick(t){frames++;ctx.fillStyle='#243546';ctx.fillRect(0,0,500,280);ctx.fillStyle='white';ctx.font='30px sans-serif';ctx.fillText('Frame '+frames,30,90);ctx.fillRect((t/4)%450,150,40,40);requestAnimationFrame(tick)}requestAnimationFrame(tick);
 function vf(){videoFrames++;v.requestVideoFrameCallback(vf)}v.requestVideoFrameCallback(vf);
 document.onvisibilitychange=()=>{changes.push({at:performance.now(),state:document.visibilityState});report()};
 function report(){fetch('/status',{method:'POST',body:JSON.stringify({at:performance.now(),frames,videoFrames,time:v.currentTime,visibility:document.visibilityState,focus:document.hasFocus(),changes,agent:navigator.userAgent})})}setInterval(report,200);report();
 </script>`;
 const server=http.createServer((req,res)=>{if(req.url==='/status'){let data='';req.on('data',c=>data+=c);req.on('end',()=>{samples.push(JSON.parse(data));res.end('ok')})}else{res.setHeader('Content-Type','text/html');res.end(html)}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'chatbubble-edge-fixture-'));
 const executable=process.argv.includes('--chrome')?'C:/Program Files/Google/Chrome/Application/chrome.exe':'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
 browser=spawn(executable,[`--user-data-dir=${directory}`,`--app=http://127.0.0.1:${server.address().port}/`,'--no-first-run','--no-default-browser-check','--disable-extensions','--disable-features=msEdgeSidebarV2','--window-position=100,100','--window-size=640,480'],{windowsHide:false,stdio:'ignore'});
 const results=[];
 const probe=w=>JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(out,'probe-window.ps1'),'-Handle',w.getNativeWindowHandle().readBigUInt64LE().toString()],{encoding:'utf8',windowsHide:true}).trim());
 try {
  for(let i=0;i<150&&!samples.length;i++)await pause(100);assert.ok(samples.length,'isolated browser started');
  const initialTarget=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(out,'probe-browser.ps1'),'-Title',title,'-Raise'],{encoding:'utf8',windowsHide:true}).trim());
  const initialNative=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(out,'probe-window.ps1'),'-Handle',initialTarget.handle],{encoding:'utf8',windowsHide:true}).trim());
  for(let i=0;i<150&&!(samples.at(-1)?.visibility==='visible'&&samples.at(-1)?.videoFrames>20);i++)await pause(100);
  await fs.writeFile(path.join(out,'browser-startup.json'),JSON.stringify({initialTarget,initialNative,samples},null,2));
  assert.ok(samples.at(-1)?.visibility==='visible'&&samples.at(-1)?.videoFrames>20,'isolated browser is presenting before overlay');
  const source=ts.createSourceFile('main.ts',await fs.readFile(path.join(root,'src/main.ts'),'utf8'),ts.ScriptTarget.ES2022,true);
  let optionsNode;function visit(n){if(ts.isBinaryExpression(n)&&n.left.getText(source)==='window'&&ts.isNewExpression(n.right)&&n.right.expression.getText(source)==='BrowserWindow')optionsNode=n.right.arguments[0];ts.forEachChild(n,visit)}visit(source);assert.ok(optionsNode);
  const options=vm.runInNewContext(ts.transpileModule('('+optionsNode.getText(source)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{appIcon:'',expandedBounds:screen.getPrimaryDisplay().bounds,path,__dirname:path.join(root,'dist')});
  for(const type of ['normal','production']) {
   const w=new BrowserWindow({...options,...(type==='normal'?{type:'normal'}:{})});
   const start=samples.length,before=samples.at(-1);
   try {
    await w.loadURL('data:text/html,<style>body{background:transparent}</style>');
    w.setShape([{x:192,y:192,width:96,height:96}]);w.setIgnoreMouseEvents(false);w.showInactive();
    const native=probe(w);await pause(1800);const stationary=samples.at(-1);
    w.setIgnoreMouseEvents(true,{forward:true});await pause(1200);const pass=samples.at(-1);
    w.setIgnoreMouseEvents(false);await pause(1800);const hover=samples.at(-1);
    let expanded,expandedNative,capture;
    if(type==='production') {
     w.setFocusable(true);await pause(700);expandedNative=probe(w);
     const target=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(out,'probe-browser.ps1'),'-Title',title,'-Raise'],{encoding:'utf8',windowsHide:true}).trim());
     await pause(700);
     assert.notEqual(target.handle,'0','capture only the isolated browser');
     const targetNative=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(out,'probe-window.ps1'),'-Handle',target.handle],{encoding:'utf8',windowsHide:true}).trim());
     await fs.writeFile(path.join(out,'capture-target-debug.json'),JSON.stringify({target,targetNative,owner:process.pid},null,2));
     const {WindowCapture}=require(path.join(root,'dist/windows-capture'));
     const helper=new WindowCapture();
     const captureBefore=samples.at(-1),captureStart=performance.now();
     try {const image=await helper.capture(target);capture={bytes:image.length,ms:performance.now()-captureStart};assert.ok(image.length>80)}finally{helper.close()}
     await pause(700);expanded=samples.at(-1);capture.before=captureBefore;capture.after=expanded;
     assert.equal(expanded.visibility,'visible');assert.ok(expanded.videoFrames-captureBefore.videoFrames>20,'video keeps presenting while capture is requested');
     assert.equal(expandedNative.toolWindow,true);assert.equal(expandedNative.noActivate,false);
     w.setFocusable(false);assert.equal(probe(w).toolWindow,true);
    }
    results.push({type,before,stationary,pass,hover,native,expanded,expandedNative,capture,samples:samples.slice(start)});
   }finally{w.destroy();await pause(1000)}
  }
  const report={executable,results};await fs.writeFile(path.join(out,process.argv.includes('--chrome')?'chrome-occlusion.json':'edge-occlusion.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(results.map(({type,before,stationary,pass,hover,native})=>({type,before,stationary,pass,hover,native}))));
  assert.equal(results[0].stationary.visibility,'hidden','old simple-region window reproduces browser occlusion');
  assert.equal(results[0].hover.videoFrames,results[0].stationary.videoFrames,'old video presentation stops');
  assert.equal(results[1].native.toolWindow,true,'production window carries native tool-window flag');
  assert.equal(results[1].stationary.visibility,'visible');assert.equal(results[1].hover.visibility,'visible');
  assert.ok(results[1].stationary.videoFrames-results[1].before.videoFrames>20,'video continues with toolbar overlay');
 } finally {
  // Terminate only the dedicated browser process tree launched above.
  if(browser?.pid)execFileSync('taskkill.exe',['/PID',String(browser.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
  await new Promise(r=>server.close(r));
 }
 app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
