// Production page and preload, isolated IPC, synthetic gestures and a fixed clock.
// No user configuration, screen capture, system-setting changes or model calls.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '..'), packaged = process.argv.includes('--packaged');
const runtime = path.join(root, packaged ? `release/ChatBubble-${require('../package.json').version}-win32-x64/resources/app/dist` : 'dist');
const out = process.env.CHATBUBBLE_MOTION_OUTPUT, contexts = new Map(), errors = [];
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'chatbubble-motion-')));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.on('window-all-closed', () => {});
const ctx = e => contexts.get(e.sender.id);
ipcMain.handle('desktop:scene', e => ctx(e).scene);
ipcMain.handle('chat:state', e => ({ ...ctx(e).state, busy: false, hasKey: false, warning: '', storage: { directory: '', archiveDirectory: '', appDirectory: '' } }));
ipcMain.handle('chat:draft', () => {});
ipcMain.handle('desktop:position', () => {});
ipcMain.handle('desktop:shape', () => {});
ipcMain.handle('window:mode', (e, mode) => e.sender.send('window:mode', mode));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = (win, source) => win.webContents.executeJavaScript(source);
app.whenReady().then(async () => {
  const { petDefaults } = require(path.join(runtime, 'pet-state'));
  const report = { packaged, cases: [], errors, controlledClock: true, syntheticGestures: true };
  for (const [profile, options] of [['defaults', petDefaults], ['custom', { ...petDefaults, petSize: 80, petGaze: 27, petWidth: 320, petDistance: 80 }]]) {
    let baseline;
    for (const scenario of ['normal', 'reduced', 'normal-to-reduced', 'reduced-to-normal']) {
      const initialReduced = scenario.startsWith('reduced'), changed = scenario.includes('-to-');
      const win = new BrowserWindow({ width: 736, height: 490, show: false, focusable: false, frame: false, transparent: true,
        webPreferences: { preload: path.join(runtime, 'preload.js'), sandbox: true, contextIsolation: true, backgroundThrottling: false, offscreen: true } });
      win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
      const state = require(path.join(runtime, 'model')).initialState();
      Object.assign(state.settings, options);
      contexts.set(win.webContents.id, { state, scene: { bounds: { x: 0, y: 0, width: 736, height: 490 }, areas: [{ id: 1, x: 0, y: 0, width: 736, height: 490 }],
        position: { x: 368, y: 280, side: null, displayId: 1 }, options, mode: 'collapsed' } });
      await win.loadURL('about:blank');
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Page.enable');
      await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `window.__clock=0;window.__frames=[];performance.now=()=>__clock;requestAnimationFrame=fn=>(__frames.push(fn),__frames.length);let seed=91;Math.random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);window.advancePet=ms=>{while(ms>0){const dt=Math.min(16,ms);ms-=dt;__clock+=dt;for(const fn of __frames.splice(0))fn(__clock);}};` });
      async function media(reduced) {
        await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] });
        await pause(20); // Deliver the real MediaQueryList change event.
        assert.equal(await js(win, "matchMedia('(prefers-reduced-motion: reduce)').matches"), reduced);
      }
      async function load() {
        await media(initialReduced);
        await win.loadFile(path.join(runtime, 'ui/index.html'));
        for (let i = 0; i < 200 && !await js(win, '!!window.pet && __frames.length>0'); i++) await pause(10);
        assert.ok(await js(win, '!!window.pet && __frames.length>0'));
        await js(win, `(()=>{const p=document.querySelector('#cb-pet');let held=false;p.setPointerCapture=()=>held=true;p.hasPointerCapture=()=>held;p.releasePointerCapture=()=>held=false;window.gesture=(type,x,y,button=0)=>p.dispatchEvent(new PointerEvent(type,{button,pointerId:1,clientX:x,clientY:y,bubbles:true}));window.sample=()=>{const b=document.querySelector('#cb-body'),box=b.getBBox();return {state:pet.inspect(),body:b.getAttribute('d'),box:[box.x,box.y,box.width,box.height],eyes:['cb-eye-left','cb-eye-right'].map(id=>{const e=document.getElementById(id);return ['x','y','width','height','transform'].map(k=>e.getAttribute(k));})};};window.frames=n=>{const a=[];for(let i=0;i<n;i++){advancePet(16);a.push(sample());}return a;};})();advancePet(1000);`);
      }
      await load();
      const hopStart = await js(win, "(()=>{const s=sample();gesture('pointerdown',s.state.x,s.state.y,2);gesture('pointerup',s.state.x,s.state.y,2);return s;})()");
      const hop = await js(win, 'frames(25)');
      if (changed) await media(!initialReduced);
      hop.push(...await js(win, 'frames(155)'));
      const hopDistance = Math.hypot(hop.at(-1).state.x-hopStart.state.x, hop.at(-1).state.y-hopStart.state.y);
      assert.ok(hopDistance > 30, 'right click must hop with either system preference');
      await load();
      await js(win, "(()=>{const s=sample();window.stretchStart=s;gesture('pointerdown',s.state.x,s.state.y,2);gesture('pointermove',s.state.x+100,s.state.y-45,2);advancePet(720);})()");
      const held = await js(win, 'sample()');
      if (changed) await media(!initialReduced);
      await js(win, "gesture('pointerup',stretchStart.state.x+100,stretchStart.state.y-45,2)");
      const stretch = await js(win, 'frames(150)');
      const releaseRemaining = Math.max(...stretch[0].box.map((v, i) => Math.abs(v-stretch.at(-1).box[i])));
      assert.ok(releaseRemaining > 5, 'release must spring back gradually instead of snapping');
      assert.ok(Math.hypot(stretch.at(-1).state.x-held.state.x, stretch.at(-1).state.y-held.state.y) < .001, 'stretch keeps its anchor');
      await load();
      await js(win, "(()=>{const s=sample();gesture('pointerdown',s.state.x,s.state.y);gesture('pointermove',22,s.state.y);advancePet(320);gesture('pointerup',22,s.state.y);})()");
      const dock = await js(win, 'frames(10)');
      if (changed) await media(!initialReduced);
      dock.push(...await js(win, 'frames(170)'));
      assert.equal(dock.at(-1).state.side, 'left');
      await load();
      await js(win, "(()=>{const s=pet.inspect();gesture('pointerdown',s.x,s.y);gesture('pointerup',s.x,s.y);})()");
      const open = await js(win, 'frames(10)');
      if (changed) await media(!initialReduced);
      open.push(...await js(win, 'frames(80)'));
      assert.ok(open.at(-1).state.morph > .99);
      assert.ok(open[0].state.morph > 0 && open[0].state.morph < 1, 'opening must preserve the morph transition');
      const digest = crypto.createHash('sha256').update(JSON.stringify({ hopStart, hop, held, stretch, dock, open })).digest('hex');
      if (baseline === undefined) baseline = digest;
      else assert.equal(digest, baseline, 'system preference and live changes must not alter pet animation frames');
      report.cases.push({ profile, scenario, frames: 600, hopDistance, releaseRemaining, digest });
      contexts.delete(win.webContents.id); win.destroy();
    }
  }
  assert.deepEqual(errors, []);
  if (out) { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, packaged ? 'packaged-motion.json' : 'source-motion.json'), JSON.stringify(report, null, 2)); }
  console.log(JSON.stringify(report, null, 2));
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
