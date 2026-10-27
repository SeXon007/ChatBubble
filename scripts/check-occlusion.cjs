// Two isolated Electron processes. No user data, mouse movement or user-window capture.
const {app,BrowserWindow,screen}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {spawn,execFileSync}=require('node:child_process');
const assert=require('node:assert/strict');
const ts=require('typescript'),vm=require('node:vm');
const out=path.resolve(__dirname,'../docs/verification/input-stall-0.9.0');
const root=path.resolve(__dirname,'..'),packaged=process.argv.includes('--packaged');
const runtime=path.join(root,packaged?'release/ChatBubble-0.9.0-win32-x64/resources/app/dist':'dist');
app.setPath('userData',require('node:fs').mkdtempSync(path.join(os.tmpdir(),'chatbubble-occlusion-')));
app.commandLine.appendSwitch('enable-features','CalculateNativeWinOcclusion');
app.on('window-all-closed',()=>{});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
  const bounds=screen.getPrimaryDisplay().workArea;
  if(process.argv.includes('--victim')) {
    const w=new BrowserWindow({x:bounds.x+100,y:bounds.y+100,width:640,height:400,show:false});
    await w.loadURL('data:text/html,<title>ChatBubble isolated playback fixture</title><canvas id="c" width="640" height="360"></canvas><script>window.framesRun=0;window.changes=[];document.onvisibilitychange=()=>changes.push({at:performance.now(),state:document.visibilityState});function tick(t){framesRun++;const x=document.querySelector("canvas").getContext("2d");x.fillStyle="%23253546";x.fillRect(0,0,640,360);x.fillStyle="%23fff";x.font="30px sans-serif";x.fillText("Playback fixture "+framesRun,30,90);requestAnimationFrame(tick)}requestAnimationFrame(tick)</script>');
    w.show(); w.focus();
    process.on('message',async m=>{
      if(m==='quit'){w.destroy();app.quit();return;}
      if(m==='focus')w.focus();
      process.send({id:m,...await w.webContents.executeJavaScript('({frames:framesRun,visibility:document.visibilityState,changes,focus:document.hasFocus()})')});
    });
    process.send({ready:true,hwnd:w.getNativeWindowHandle().readBigUInt64LE().toString()});return;
  }
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(process.execPath,[__filename,'--victim'],{env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  const ready=await new Promise((resolve,reject)=>{child.on('message',m=>{if(m.ready)resolve(m)});child.on('error',reject);setTimeout(()=>reject(Error('fixture startup timeout')),15000).unref()});
  const sample=id=>new Promise(resolve=>{const listener=m=>{if(m.id===id){child.off('message',listener);resolve(m)}};child.on('message',listener);child.send(id)});
  const probe=w=>JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(out,'probe-window.ps1'),'-Handle',w.getNativeWindowHandle().readBigUInt64LE().toString()],{encoding:'utf8',windowsHide:true}).trim());
  const results=[];
  try {
    const source=ts.createSourceFile('main.ts',await fs.readFile(path.join(root,packaged?'release/ChatBubble-0.9.0-win32-x64/resources/app/dist/main.js':'src/main.ts'),'utf8'),ts.ScriptTarget.ES2022,true);
    let optionsNode;function visit(n){if(ts.isBinaryExpression(n)&&n.left.getText(source)==='window'&&ts.isNewExpression(n.right)&&/^(?:electron_1\.)?BrowserWindow$/.test(n.right.expression.getText(source)))optionsNode=n.right.arguments[0];ts.forEachChild(n,visit)}visit(source);assert.ok(optionsNode);
    const options=vm.runInNewContext(ts.transpileModule('('+optionsNode.getText(source)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{appIcon:'',expandedBounds:bounds,path,node_path_1:{default:path},__dirname:runtime});
    for(const type of ['normal','production']) {
      await sample('focus'); await pause(250);
      const before=await sample(type+'-before');
      const w=new BrowserWindow({...options,...(type==='normal'?{type:'normal'}:{})});
      try {
        await w.loadURL('data:text/html,<style>body{margin:0;background:transparent}i{position:absolute;left:200px;top:200px;width:70px;height:70px;background:black;border-radius:50%}</style><i></i>');
        w.setShape([{x:192,y:192,width:96,height:96}]);w.setIgnoreMouseEvents(false);w.showInactive();
        await pause(1300);const held=await sample(type+'-held'),native=probe(w);
        w.setIgnoreMouseEvents(true,{forward:true}); await pause(800);const pass=await sample(type+'-pass');
        w.setIgnoreMouseEvents(false);await pause(1300);const stationary=await sample(type+'-stationary'),stationaryNative=probe(w);
        let expanded,collapsed;
        if(type==='production') {w.setFocusable(true);expanded=probe(w);assert.equal(expanded.toolWindow,true);assert.equal(expanded.noActivate,false);w.setFocusable(false);collapsed=probe(w);assert.equal(collapsed.toolWindow,true);assert.equal(collapsed.noActivate,true);}
        results.push({type,before,held,native,pass,stationary,stationaryNative,expanded,collapsed});
      }finally{w.destroy()}
    }
    await fs.writeFile(path.join(out,packaged?'packaged-native-window.json':'native-window.json'),JSON.stringify({packaged,electron:process.versions.electron,chromium:process.versions.chrome,results,limitations:['Electron fixture does not reproduce native browser throttling; this check verifies actual HWND styles, focusability and paint regions.']},null,2));
    console.log(JSON.stringify(results));
    assert.equal(results[0].native.toolWindow,false);
    assert.equal(results[0].native.simpleRegion,true);
    assert.equal(results[1].native.toolWindow,true);
    assert.equal(results[1].stationaryNative.toolWindow,true);
    assert.equal(results[1].held.visibility,'visible');
    assert.equal(results[1].stationary.visibility,'visible');
    assert.ok(results[1].held.frames-results[1].before.frames>20);
    assert.equal(results[1].native.noActivate,true);
    assert.equal(results[1].stationaryNative.foreground,results[1].native.foreground);
  } finally {child.send('quit')}
  app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
