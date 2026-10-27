// Captures only a display fully covered by the generated fixture, never a user page.
const {app,nativeImage}=require('electron'),{spawn,execFileSync}=require('node:child_process');
const fs=require('node:fs/promises'),syncFs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),version=require('../package.json').version,packaged=process.argv.includes('--packaged');
const runtime=path.join(root,packaged?`release/ChatBubble-${version}-win32-x64/resources/app/dist`:'dist'),output=path.join(root,'docs/verification/capture-scope-0.11.0');
app.setPath('userData',syncFs.mkdtempSync(path.join(os.tmpdir(),'chatbubble-monitor-check-')));app.on('window-all-closed',()=>{});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 let helper,child;const checks=[];const check=(name,ok)=>{assert.ok(ok,name);checks.push(name)};
 try {
  const {WindowCapture}=require(path.join(runtime,'windows-capture')),{ScreenCapture}=require(path.join(runtime,'screen-capture'));
  helper=new WindowCapture();await helper.ready;
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'chatbubble-monitor-fixture-')),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  child=spawn(process.execPath,[path.join(__dirname,'monitor-capture-fixture.cjs'),directory],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let info,staticReady=false;let stdout='',stderr='';child.stdout.on('data',data=>{stdout+=data;for(const line of stdout.split('\n')){try{const v=JSON.parse(line);if(v.ready)info=v;if(v.static)staticReady=true}catch{}}});child.stderr.on('data',data=>stderr=(stderr+data).slice(-1200));
  for(let i=0;i<150&&!info;i++)await pause(100);assert.ok(info,'fixture startup '+stderr);
  const selected={...helper.monitor};check('native monitor identity available',!!selected.handle);
  const probe=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(output,'probe-cover.ps1'),'-Window',info.cover,'-Red',info.red,'-Blue',info.blue],{encoding:'utf8',windowsHide:true}).trim());
  await fs.writeFile(path.join(output,packaged?'packaged-cover-check.json':'cover-check.json'),JSON.stringify({info,selected,probe},null,2));
  check('fixture fully covers the selected monitor including taskbar',probe.monitor===selected.handle&&probe.coversMonitor&&probe.visible&&probe.allGridCovered&&!probe.iconic);
  // Freeze before any further async work, after checking the target is covered.
  check('screen selection still matches the covered display',helper.monitor.handle===selected.handle);
  const take=helper.prepareCapture('screen');await pause(350);
  const started=Date.now(),data=await take(),image=nativeImage.createFromBuffer(data),size=image.getSize(),bitmap=image.toBitmap();
  const colorAt=(x,y)=>{const i=(Math.floor(size.height*y)*size.width+Math.floor(size.width*x))*4;return [bitmap[i+2],bitmap[i+1],bitmap[i]]};
  const near=(a,b)=>a.every((v,i)=>Math.abs(v-b[i])<=5),background=[36,90,114],red=[216,75,64],blue=[66,105,200];
  await fs.writeFile(path.join(output,'pixel-check.json'),JSON.stringify({size,background:colorAt(.05,.05),red:colorAt(.27,.3),blue:colorAt(.75,.65),redWindow:JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(output,'probe-cover.ps1'),'-Window',info.red],{encoding:'utf8',windowsHide:true}).trim()),blueWindow:JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(output,'probe-cover.ps1'),'-Window',info.blue],{encoding:'utf8',windowsHide:true}).trim())},null,2));
  const ratio=Math.min(1,1920/Math.max(selected.width,selected.height));
  check('screen image covers the complete display aspect and dimensions',size.width===Math.max(1,Math.floor(selected.width*ratio))&&size.height===Math.max(1,Math.floor(selected.height*ratio)));
  check('screen includes desktop background and bottom-right edge',near(colorAt(.05,.05),background)&&near(colorAt(.95,.95),background));
  check('screen includes both overlapping windows',near(colorAt(.27,.3),red)&&near(colorAt(.75,.65),blue));
  let palette=0;for(let i=0;i<bitmap.length;i+=4){const c=[bitmap[i+2],bitmap[i+1],bitmap[i]];if(near(c,background)||near(c,red)||near(c,blue))palette++}
  check('monitor evidence contains only the generated fixture colors',palette/(size.width*size.height)>.995);
  await fs.writeFile(path.join(output,packaged?'packaged-monitor.png':'monitor.png'),data);
  const windowImage=nativeImage.createFromBuffer(await helper.capture({handle:info.red,pid:info.pid,width:400,height:300}));
  const wSize=windowImage.getSize(),wBytes=windowImage.toBitmap();let redCount=0;for(let i=0;i<wBytes.length;i+=4)if(near([wBytes[i+2],wBytes[i+1],wBytes[i]],red))redCount++;
  check('window mode still captures only the selected window',wSize.width<size.width&&redCount/(wSize.width*wSize.height)>.995);
  const manager=new ScreenCapture(()=>directory,()=>helper.captureMonitor(selected));
  await manager.request();const attachment=(await manager.take()).image;
  check('monitor capture uses the existing one-shot attachment path',!!attachment&&path.basename(path.dirname(attachment.file))==='attachments');await manager.close();
  await fs.writeFile(path.join(directory,'command.txt'),'static');for(let i=0;i<150&&!staticReady;i++)await pause(20);check('fixture animation stopped',staticReady);await pause(400);
  const still=nativeImage.createFromBuffer(await helper.captureMonitor(selected));check('static desktop also yields a fresh single frame',still.getSize().width===size.width&&still.getSize().height===size.height);
  await assert.rejects(helper.captureMonitor({handle:'1',width:1,height:1}));checks.push('invalid monitor rejected without fallback');
  await fs.writeFile(path.join(output,packaged?'packaged-native.json':'native.json'),JSON.stringify({packaged,checks,size,monitor:selected,captureAndChecksMs:Date.now()-started,paletteFraction:palette/(size.width*size.height),limitations:['Generated opaque cover and windows only; no real user page or model request','Current display and DPI; other monitors/HDR remain manual']},null,2));
  console.log(JSON.stringify({packaged,checks:checks.length,size}));
 }finally{helper?.close();child?.stdin.write('quit\n');await pause(300);child?.kill()}
 app.quit();
}).catch(async e=>{await fs.writeFile(path.join(output,packaged?'packaged-native-error.txt':'native-error.txt'),String(e.stack));console.error(e);app.exit(1)});
