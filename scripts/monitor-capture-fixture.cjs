// Covers the selected display with generated colors before any monitor capture.
const {app,BrowserWindow,screen}=require('electron'),path=require('node:path'),readline=require('node:readline'),fs=require('node:fs');
app.setPath('userData',path.join(process.argv[2],'fixture-data'));
app.whenReady().then(async()=>{
 const display=screen.getDisplayNearestPoint(screen.getCursorScreenPoint()),b=display.bounds;
 const make=async(rect,color,full=false,parent)=>{
  const win=new BrowserWindow({...rect,parent,show:false,focusable:false,skipTaskbar:true,type:'toolbar',frame:false,thickFrame:false,resizable:false,maximizable:false,fullscreenable:full,fullscreen:full,alwaysOnTop:true,hasShadow:false,backgroundColor:color,webPreferences:{sandbox:true,backgroundThrottling:false}});
  await win.loadURL('data:text/html,'+encodeURIComponent(`<style>html,body{margin:0;width:100%;height:100%;background:${color}}${full?'body::after{content:"";position:absolute;left:40%;top:10px;width:10px;height:10px;background:#4269c8;animation:tick 1s linear infinite alternate}@keyframes tick{to{transform:translateX(120px)}}':''}</style>`));win.showInactive();win.moveTop();
  await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');return win;
 };
 const part=(x,y,w,h)=>({x:b.x+Math.floor(b.width*x),y:b.y+Math.floor(b.height*y),width:Math.floor(b.width*w),height:Math.floor(b.height*h)});
 const cover=await make(b,'#245a72',true),red=await make(part(.18,.18,.48,.48),'#d84b40',false,cover),blue=await make(part(.46,.42,.36,.34),'#4269c8',false,cover);
 for(const win of [cover,red,blue]){win.setAlwaysOnTop(false);win.setAlwaysOnTop(true,'screen-saver');win.moveTop()}
 const handle=w=>w.getNativeWindowHandle().readBigUInt64LE().toString();
 const emit=x=>process.stdout.write(JSON.stringify(x)+'\n');
 emit({ready:true,pid:process.pid,cover:handle(cover),red:handle(red),blue:handle(blue),bounds:b,scale:display.scaleFactor});
 const command=async line=>{
  if(line==='static'){await cover.webContents.executeJavaScript("document.body.style.setProperty('animation','none');const s=document.createElement('style');s.textContent='body::after{animation:none!important}';document.head.append(s)");emit({static:true})}
  if(line==='quit'){blue.destroy();red.destroy();cover.destroy();app.quit()}
 };
 readline.createInterface({input:process.stdin}).on('line',command);
 let previous='';setInterval(()=>{try{const next=fs.readFileSync(path.join(process.argv[2],'command.txt'),'utf8');if(next!==previous){previous=next;void command(next).catch(e=>emit({error:e.message}))}}catch{}},50);
});
