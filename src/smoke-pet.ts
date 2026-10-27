import { BrowserWindow, screen } from 'electron';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SavedState } from './model';
import type { ChatController } from './chat';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export async function smokePet(o: { window: BrowserWindow; state: SavedState; chat: ChatController;
  openSettings: () => Promise<void>; settingsWindow: () => BrowserWindow | null; artifactDir: string;
  setMode: (mode: 'expanded' | 'collapsed' | 'hidden') => void; check: (name: string, ok: boolean) => void }): Promise<void> {
  const { window, check } = o;
  const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
  const js = <T = any>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const mouse = async (point: {x:number;y:number}, action: 'move'|'down'|'up'): Promise<void> => {
    const pixel = screen.dipToScreenPoint({x:Math.round(point.x),y:Math.round(point.y)});
    const code = `Add-Type @'
using System;using System.Runtime.InteropServices;
public static class PetMouseFixture {
[DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
}
'@
[void][PetMouseFixture]::SetThreadDpiAwarenessContext([IntPtr]::new(-4));[void][PetMouseFixture]::SetCursorPos(${pixel.x},${pixel.y});[Threading.Thread]::Sleep(${action === 'down' ? 150 : 30});[PetMouseFixture]::mouse_event(${action === 'down' ? 2 : action === 'up' ? 4 : 0},0,0,0,[UIntPtr]::Zero)`;
    await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',code],{windowsHide:true});
  };
  const until = async (condition: () => Promise<boolean>): Promise<void> => {
    const end = Date.now() + 6000; while (!await condition()) { if (Date.now() > end) throw new Error('Pet smoke timeout'); await wait(25); }
  };
  o.setMode('collapsed'); await wait(1000);
  check('production-pet-approved-controls', await js("window.desktop.getState().then(s=>s.settings.petSize===82 && s.settings.petEyeSize===140 && s.settings.petColor==='#000000')"));
  check('no-collapse-hide-buttons-or-demo-copy', await js("!document.querySelector('#collapse,#hide,#launcher') && !document.body.textContent.includes('桌面预览')"));
  o.setMode('expanded'); await wait(1000);
  const origin = await js<{ x: number; y: number }>('window.pet.inspect()');
  await js("document.querySelector('#input').value='桌宠原位草稿';document.querySelector('#input').dispatchEvent(new Event('input'))");
  check('same-material-morph-opens-real-form', await js("!document.querySelector('#composer').hidden && document.querySelector('#cb-pet').hidden && window.pet.inspect().morph>.99 && document.activeElement.id==='input' && document.querySelector('#input').getBoundingClientRect().height>=24"));
  const other = new BrowserWindow({ x: screen.getPrimaryDisplay().workArea.x + 20, y: screen.getPrimaryDisplay().workArea.y + 20, width: 200, height: 100, show: false });
  try { await other.loadURL('data:text/html,<title>ChatBubble local focus fixture</title>'); other.show(); other.focus(); await until(async () => await js("!document.querySelector('#cb-pet').hidden")); }
  finally { other.destroy(); }
  const restored = await js<{ x: number; y: number }>('window.pet.inspect()');
  check('native-window-blur-returns-to-origin-with-draft', Math.hypot(origin.x - restored.x, origin.y - restored.y) < .05 && await js("document.querySelector('#input').value==='桌宠原位草稿'"));
  const scene = await js<any>('window.desktop.getDesktopScene()');
  const area = scene.areas.find((a: { id: number }) => a.id === scene.position.displayId) || scene.areas[0];
  const local = { x: area.x - scene.bounds.x, y: area.y - scene.bounds.y, width: area.width, height: area.height };
  o.setMode('expanded'); await wait(900); o.setMode('collapsed'); await wait(900); window.focus();
  let p = await js<{ x: number; y: number }>('window.pet.inspect()');
  const target = { x: Math.round(local.x + 56 * .82), y: Math.round(local.y + local.height / 2) };
  const originalCursor = screen.getCursorScreenPoint();
  const readCursor = screen.getCursorScreenPoint, realInput = process.argv.includes('--real-pet-input');
  let fixtureCursor = { x:p.x+scene.bounds.x, y:p.y+scene.bounds.y };
  const pointer = async (point: {x:number;y:number}, action:'down'|'move'|'up'): Promise<void> => {
    if(realInput) { await mouse({x:point.x+scene.bounds.x,y:point.y+scene.bounds.y},action); return; }
    fixtureCursor={x:point.x+scene.bounds.x,y:point.y+scene.bounds.y};await wait(80);
    if(action==='move')window.webContents.sendInputEvent({type:'mouseMove',x:Math.round(point.x),y:Math.round(point.y),modifiers:['leftbuttondown']});
    else window.webContents.sendInputEvent({type:action==='down'?'mouseDown':'mouseUp',x:Math.round(point.x),y:Math.round(point.y),button:'left',clickCount:1});
    await wait(60);
  };
  try {
  if(!realInput)screen.getCursorScreenPoint=()=>fixtureCursor;
  await pointer(p,'down');
  await pointer(target,'move'); await wait(1100);
  const held = await js(`(()=>{const s=window.pet.inspect(),d=document.querySelector('#cb-body').getAttribute('d'),nums=[d.match(/^M([^C]+)/)[1].split(',').map(Number),...Array.from(d.matchAll(/C([^CZ]+)/g),m=>m[1].split(',').map(Number).slice(-2))];nums.pop();const radii=nums.map(p=>Math.hypot(p[0]-s.x,p[1]-s.y));return {s,roundness:Math.max(...radii)-Math.min(...radii),hit:document.elementFromPoint(s.x,s.y)?.id};})()`);
  await writeFile(path.join(o.artifactDir, 'pet-drag-state.json'), JSON.stringify({p,target,held,cursor:screen.getCursorScreenPoint(),bounds:window.getBounds(),local},null,2));
  check('native-drag-held-remains-round-and-expression-awake', held.s.side === null && held.s.expression === 'drag' && held.roundness < .1);
  await pointer(target,'up'); await wait(100);
  check('release-starts-real-screen-adhesion-without-wait', await js("window.pet.inspect().side==='left' && window.pet.inspect().mode==='snapping'"));
  } finally {
    if(realInput){await mouse(screen.getCursorScreenPoint(),'up');await mouse(originalCursor,'move');}
    else {window.webContents.sendInputEvent({type:'mouseUp',x:target.x,y:target.y,button:'left',clickCount:1});screen.getCursorScreenPoint=readCursor;}
  }
  await wait(3200);
  check('pet-position-persisted-at-real-display-edge', o.state.petPosition?.side === 'left' && o.state.petPosition.x >= area.x && o.state.petPosition.x < area.x + 60);
  const body = await js<{ x: number; y: number; width: number; height: number }>("(()=>{const r=document.querySelector('#cb-pet').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()");
  await writeFile(path.join(o.artifactDir, 'pet-left.png'), (await window.webContents.capturePage({ x: Math.max(0, Math.floor(body.x)), y: Math.max(0, Math.floor(body.y)), width: Math.ceil(body.width), height: Math.ceil(body.height) })).toPNG());
  if (process.platform === 'win32') {
    const center = await js<{x:number;y:number}>('window.pet.inspect()');
    const probe = `Add-Type @'
using System;using System.Runtime.InteropServices;
public static class RegionProbe {
[DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr w);
[DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr w,int index);
}
'@
$w=[IntPtr]::new([long]${window.getNativeWindowHandle().readBigUInt64LE().toString()});$style=[RegionProbe]::GetWindowLongPtr($w,-20).ToInt64()
@{passThrough=(($style -band 32)-ne 0);dpi=[RegionProbe]::GetDpiForWindow($w)}|ConvertTo-Json -Compress`;
    const read = async (): Promise<{ passThrough: boolean; dpi: number }> => JSON.parse((await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', probe], { windowsHide: true })).stdout.trim());
    const original = screen.getCursorScreenPoint;
    try {
      screen.getCursorScreenPoint = () => ({ x: center.x + scene.bounds.x, y: center.y + scene.bounds.y }); await wait(150);
      const inside = await read();
      screen.getCursorScreenPoint = () => ({ x: area.x + area.width - 4, y: area.y + area.height - 4 }); await wait(150);
      const outside = await read();
      await writeFile(path.join(o.artifactDir, 'native-input-region.json'), JSON.stringify({inside,outside},null,2));
      check('windows-pet-receives-input-and-empty-desktop-passes-through', !inside.passThrough && outside.passThrough);
    } finally { screen.getCursorScreenPoint = original; }
  }
  let visibleMass = true;
  for (const key of ['Right', 'Up', 'Down']) {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: ['shift'] }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: ['shift'] }); await wait(3000);
    visibleMass = visibleMass && await js(`(()=>{const d=document.querySelector('#cb-body').getAttribute('d'),p=[d.match(/^M([^C]+)/)[1].split(',').map(Number),...Array.from(d.matchAll(/C([^CZ]+)/g),m=>m[1].split(',').map(Number).slice(-2))];p.pop();const a=p.reduce((sum,v,i)=>{const n=p[(i+1)%p.length];return sum+v[0]*n[1]-n[0]*v[1];},0)/2;return a>Math.PI*(49*.82)**2*.9&&a<Math.PI*(49*.82)**2*1.1&&p.every(v=>v[0]>=${local.x}-.05&&v[0]<=${local.x+local.width}+.05&&v[1]>=${local.y}-.05&&v[1]<=${local.y+local.height}+.05);})()`);
  }
  check('native-docked-body-retains-area-without-entering-wall', visibleMass);
  check('four-direction-native-keyboard-docking', await js("window.pet.inspect().side==='bottom' && window.pet.inspect().mode==='docked'"));
  const beforeReload = { ...o.state.petPosition };
  await o.chat.persist(); await window.reload();
  await until(async () => await js('!!window.pet')); await wait(500);
  check('pet-position-restored-after-renderer-reload', await js("window.pet.inspect().side==='bottom'") && o.state.petPosition?.displayId === beforeReload.displayId);
  await o.openSettings(); const settings = o.settingsWindow()!;
  await until(async () => settings.webContents.executeJavaScript("!document.querySelector('#provider').disabled"));
  await settings.webContents.executeJavaScript("document.querySelector('#tab-pet-options').click();document.querySelector('#petEyeSize').value='100';document.querySelector('#petEyeSize').dispatchEvent(new Event('input'));document.querySelector('#petEyeSize').dispatchEvent(new Event('change'));window.flushSettings()");
  check('real-pet-slider-autosaves-and-updates-graphics', o.state.settings.petEyeSize === 100 && await settings.webContents.executeJavaScript("document.querySelector('[data-value=petEyeSize]').value==='100%'"));
  await wait(300);
  await writeFile(path.join(o.artifactDir, 'pet-settings.png'), (await settings.webContents.capturePage()).toPNG());
  check('pet-host-bridge-rejects-settings-window', await settings.webContents.executeJavaScript('window.desktop.getDesktopScene().then(()=>false,()=>true)'));
  check('invalid-native-region-request-rejected', await js("window.desktop.setRegions([{x:0,y:0,width:NaN,height:1}]).then(()=>false,()=>true)"));
  settings.close(); await until(async () => o.settingsWindow() === null);
  o.setMode('expanded'); await wait(1000);
  const box = await js<any>("(()=>{const r=document.querySelector('#composer').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()");
  await writeFile(path.join(o.artifactDir, 'pet-expanded.png'), (await window.webContents.capturePage({ x: Math.max(0, Math.floor(box.x - 12)), y: Math.max(0, Math.floor(box.y - 240)), width: Math.ceil(box.width + 24), height: Math.min(310, window.getBounds().height - Math.max(0, Math.floor(box.y - 240))) })).toPNG());
  o.setMode('collapsed');
  // Advance the inactivity clock; the human can keep using the mouse during this test.
  await wait(900);
  try {
    await js("window.__petRealNow=performance.now;const s=window.pet.inspect();performance.now=()=>window.__petRealNow.call(performance)-13000;document.querySelector('#cb-desktop').dispatchEvent(new PointerEvent('pointermove',{clientX:s.x,clientY:s.y}))");
    await wait(700);
    check('native-idle-enters-rest-expression', await js("window.pet.inspect().expression==='rest' && Number(document.querySelector('#cb-eye-left').getAttribute('height'))<3"));
  } finally { await js('performance.now=window.__petRealNow;delete window.__petRealNow'); }
}
