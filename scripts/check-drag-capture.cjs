// Exercise production DOM handlers in a hidden window; capture is a synthetic spy.
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const baseline = process.argv.includes('--baseline');
const packaged = process.argv.includes('--packaged');
const checkTabs = process.argv.includes('--settings-tabs');
const nativeRegions = process.argv.includes('--native-regions');
const expressionCheck = process.argv.includes('--pet-expressions');
const output = path.join(root, 'docs/verification/manual-capture-0.9.0', expressionCheck ? 'pet-expressions' : nativeRegions ? 'native-drag' : checkTabs ? 'settings-tabs' : 'drag');
const dist = path.join(root, baseline ? 'release/ChatBubble-0.8.3-win32-x64/resources/app/dist' : packaged ? `release/ChatBubble-${require('../package.json').version}-win32-x64/resources/app/dist` : 'dist');
const { initialState } = require(path.join(dist, 'model'));
const { petDefaults } = require(path.join(dist, 'pet-state'));
// Set this before readiness so parallel checks never share Chromium caches.
app.setPath('userData', require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(), 'chatbubble-drag-')));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.whenReady().then(async () => {
  const state = initialState();
  Object.assign(state.settings, { provider: 'codex-cli', screenCaptureEnabled: true, textColor: '#5c38cc' });
  state.session.messages.push({ id: 'fixture', requestId: 'fixture', role: 'user', content: '合成测试', status: 'complete', time: '', notice: '本次未能读取目标窗口（目标窗口不可读取），已按文字发送。' });
  state.session.messages.push({ id: 'answer', requestId: 'fixture', role: 'assistant', content: '合成回复', status: 'complete', time: '' });
  let mode = 'collapsed', captures = 0, calls = [];
  const shouldCaptureOnExpand = (before, next, provider, enabled) => baseline && before !== 'expanded' && next === 'expanded' && provider === 'codex-cli' && enabled;
  const window = new BrowserWindow({ width: 800, height: 600, frame: false, transparent: true, show: false, focusable: false, webPreferences: { preload: path.join(dist, 'preload.js'), sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  if (nativeRegions) {
    await window.loadURL('about:blank');window.webContents.debugger.attach('1.3');await window.webContents.debugger.sendCommand('Page.enable');
    await window.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument',{source:`window.__nativeClock=0;window.__nativeFrames=[];performance.now=()=>__nativeClock;requestAnimationFrame=fn=>(__nativeFrames.push(fn),__nativeFrames.length);window.advanceNativePet=ms=>{while(ms>0){const dt=Math.min(ms,16);ms-=dt;__nativeClock+=dt;const batch=__nativeFrames.splice(0);for(const fn of batch)fn(__nativeClock);}};`});
  }
  const publicState = () => ({ ...state, busy: false, hasKey: false, warning: '', storage: { directory: output, archiveDirectory: output, appDirectory: output } });
  ipcMain.handle('desktop:scene', () => ({ bounds: { x: 0, y: 0, width: 800, height: 600 }, areas: [{ x: 0, y: 0, width: 800, height: 600, id: 1 }], mode, position: { x: 400, y: 300, side: null, displayId: 1 }, options: petDefaults }));
  ipcMain.handle('window:mode', (_event, next) => {
    calls.push(next);
    if (shouldCaptureOnExpand(mode, next, state.settings.provider, state.settings.screenCaptureEnabled)) captures++;
    mode = next; window.webContents.send('window:mode', mode);
  });
  let regionContext, shapeChanges = [];
  if (nativeRegions) {
    const ts = require('typescript'), vm = require('node:vm');
    const source = ts.createSourceFile('main.ts', await fs.readFile(path.join(root,'src/main.ts'),'utf8'), ts.ScriptTarget.ES2022, true);
    const update = source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='updateNativeShape');
    const original = window.setShape.bind(window);
    window.setShape = regions => { shapeChanges.push(regions); original(regions); };
    regionContext = { window, nativeShape: '', inputRegions: [], nativePaintRegions: [], expandedBounds: {x:0,y:0,width:800,height:600}, petDragging:false,
      validatePet:()=>{}, updateMouseRouting:()=>{}, shapeRegions: require(path.join(dist,'pet-state')).shapeRegions, ipcMain };
    vm.createContext(regionContext);
    const run = code => vm.runInContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,regionContext);
    run(update.getText(source));
    let handler; function visit(n) { if(ts.isCallExpression(n)&&n.expression.getText(source)==='ipcMain.handle'&&n.arguments[0]?.text==='desktop:shape')handler=n;ts.forEachChild(n,visit); } visit(source);
    run(handler.getText(source));
  } else ipcMain.handle('desktop:shape', () => {});
  ipcMain.handle('desktop:position', () => {});
  ipcMain.handle('chat:state', publicState);
  ipcMain.handle('chat:draft', () => {});
  await window.loadFile(path.join(dist, 'ui/index.html'));
  const js = code => window.webContents.executeJavaScript(code);
  for (let i = 0; i < 100 && !await js('!!window.pet'); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(await js('!!window.pet'));
  await js(`(() => { const pet=document.querySelector('#cb-pet');let held=false;pet.setPointerCapture=()=>{held=true};pet.hasPointerCapture=()=>held;pet.releasePointerCapture=()=>{held=false};window.gesture=(type,x,y,id=1)=>pet.dispatchEvent(new PointerEvent(type,{button:0,pointerId:id,clientX:x,clientY:y,bubbles:true})); })()`);
  const samples = [];
  async function gesture(name, steps, expected, expectedMode = expected ? 'expanded' : 'collapsed') {
    mode = 'collapsed'; window.webContents.send('window:mode', mode);
    await new Promise(resolve => setTimeout(resolve, 600));
    if (nativeRegions) await js('advanceNativePet(1000)');
    captures = 0; calls = [];
    await js(`(() => { const p=window.pet.inspect();${steps} })()`);
    await new Promise(resolve => setTimeout(resolve, 40));
    if (nativeRegions) await js('advanceNativePet(160)');
    samples.push({ name, captures, calls: [...calls], mode });
    if (!baseline) { assert.equal(captures, 0, name); assert.equal(mode, expectedMode, name); }
  }
  await gesture('quick drag without a delivered pointermove', "gesture('pointerdown',p.x,p.y);gesture('pointerup',p.x+80,p.y+20)", 0);
  await gesture('ordinary drag including return to start', "gesture('pointerdown',p.x,p.y);gesture('pointermove',p.x+80,p.y+20);gesture('pointerup',p.x,p.y)", 0);
  await gesture('cancelled pointer', "gesture('pointerdown',p.x,p.y);gesture('pointercancel',p.x,p.y)", 0);
  await gesture('click opens chat once', "gesture('pointerdown',p.x,p.y);gesture('pointerup',p.x,p.y)", 1);
  await js("window.desktop.setMode('expanded')");
  await new Promise(resolve => setTimeout(resolve, 40));
  if (!baseline) assert.equal(captures, 0, 'Opening and repeated mode notifications do not capture');
  if (!baseline) {
    state.settings.screenCaptureEnabled = false;
    await gesture('disabled capture still opens chat', "gesture('pointerdown',p.x,p.y);gesture('pointerup',p.x,p.y)", 0, 'expanded');
  }
  const notice = await js("document.querySelector('.message-state').textContent");
  if (nativeRegions) assert.deepEqual(await js('[...document.querySelectorAll(".message")].map(e=>getComputedStyle(e).color)'), ['rgb(92, 56, 204)','rgb(92, 56, 204)']);
  if (!baseline) assert.equal(notice, '未能读取画面');
  await fs.mkdir(output, { recursive: true });
  let nativeRegionReport;
  if (nativeRegions) {
    state.settings.screenCaptureEnabled = true;
    const hwnd=window.getNativeWindowHandle().readBigUInt64LE().toString();
    const regionProbe = () => JSON.parse(require('node:child_process').execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Add-Type @'
using System;using System.Runtime.InteropServices;
public static class RegionProbe {
[DllImport("user32.dll")]public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
[StructLayout(LayoutKind.Sequential)]public struct R{public int l,t,r,b;}
[DllImport("gdi32.dll")]public static extern IntPtr CreateRectRgn(int a,int b,int c,int d);
[DllImport("user32.dll")]public static extern int GetWindowRgn(IntPtr h,IntPtr r);
[DllImport("gdi32.dll")]public static extern int GetRgnBox(IntPtr r,out R b);
[DllImport("gdi32.dll")]public static extern bool PtInRegion(IntPtr r,int x,int y);
[DllImport("gdi32.dll")]public static extern bool DeleteObject(IntPtr r);
}
'@
[void][RegionProbe]::SetProcessDpiAwarenessContext([IntPtr]::new(-4));$r=[RegionProbe]::CreateRectRgn(0,0,0,0);$kind=[RegionProbe]::GetWindowRgn([IntPtr]::new([long]${hwnd}),$r);$b=New-Object RegionProbe+R;[void][RegionProbe]::GetRgnBox($r,[ref]$b);@{kind=$kind;left=$b.l;top=$b.t;right=$b.r;bottom=$b.b;corner=[RegionProbe]::PtInRegion($r,0,0)}|ConvertTo-Json -Compress;[void][RegionProbe]::DeleteObject($r)`],{encoding:'utf8',windowsHide:true}).trim());
    await gesture('native ordinary drag release', "gesture('pointerdown',p.x,p.y);gesture('pointermove',p.x+60,p.y+20);gesture('pointerup',p.x+60,p.y+20)",0);
    await js('advanceNativePet(2000)');
    const idle=regionProbe(); assert.ok(idle.kind>0);assert.equal(idle.corner,false);assert.ok((idle.right-idle.left)*(idle.bottom-idle.top)<800*600/3);
    const changesBefore=shapeChanges.length;
    await js(`(()=>{const p=window.pet.inspect();gesture('pointerdown',p.x,p.y);gesture('pointermove',p.x+100,p.y+20)})()`);
    await new Promise(r=>setTimeout(r,120));const during=regionProbe();const heldChanges=shapeChanges.length;await new Promise(r=>setTimeout(r,120));
    assert.ok(during.kind>0,'capture keeps an explicit local paint region');assert.equal(shapeChanges.length,heldChanges,'stationary capture keeps its paint region');
    await js(`(()=>{const p=window.pet.inspect();gesture('pointerup',p.tx,p.ty);advanceNativePet(2400)})()`);await new Promise(r=>setTimeout(r,40));const after=regionProbe();
    assert.ok(after.kind>0);assert.equal(captures,0);assert.equal(mode,'collapsed');assert.ok(shapeChanges.length>changesBefore);
    const edgeChecks=[];
    for (const [edge,x,y] of [['left',20,300],['right',780,300],['top',400,20],['bottom',400,580]]) {
      await gesture(`native drag to ${edge}`,`gesture('pointerdown',p.x,p.y);gesture('pointermove',${x},${y});gesture('pointerup',${x},${y})`,0);
      await js('advanceNativePet(3000)');const pet=await js('window.pet.inspect()');
      const probe=regionProbe();
      assert.equal(pet.side,edge);assert.ok(pet.x>0&&pet.x<800&&pet.y>0&&pet.y<600);
      assert.ok(probe.kind>0,JSON.stringify({edge,pet,probe,dragging:regionContext.petDragging,shape:shapeChanges.at(-1)}));
      assert.ok((probe.right-probe.left)*(probe.bottom-probe.top)<=800*600,'release retains a bounded paint envelope until settling');edgeChecks.push({edge,side:pet.side});
    }
    await gesture('native clipped pet click opens once',"gesture('pointerdown',p.x,p.y);gesture('pointerup',p.x,p.y)",1);
    await new Promise(r=>setTimeout(r,700));
    assert.ok(shapeChanges.at(-1).length>=2,'expanded native shape includes composer and messages');
    nativeRegionReport={idle,during,after,lastAppliedShape:shapeChanges.at(-1),captureEnabled:state.settings.screenCaptureEnabled,noReshapeWhileHeld:true,dragCaptures:0,edgeChecks,clickCaptures:captures,chatMode:mode,visible:window.isVisible()};
    state.settings.screenCaptureEnabled = false;
  }
  let settingsReport, nativeActivation;
  if (!baseline) {
    // Verify the native focusability switch without showing or activating a window.
    const handle = window.getNativeWindowHandle().readBigUInt64LE().toString();
    const readStyle = () => JSON.parse(require('node:child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type @'
using System;using System.Runtime.InteropServices;
public static class PetActivationProbe {
[DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")]public static extern IntPtr GetWindowLongPtr(IntPtr h,int index);
[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
}
'@
$style=[PetActivationProbe]::GetWindowLongPtr([IntPtr]::new([long]${handle}),-20).ToInt64();@{noActivate=(($style -band 0x08000000)-ne 0);foreground=[PetActivationProbe]::GetForegroundWindow().ToInt64().ToString()}|ConvertTo-Json -Compress`], { windowsHide: true, encoding: 'utf8' }).trim());
    const collapsed = readStyle(); assert.equal(collapsed.noActivate, true);
    window.setFocusable(true); const expanded = readStyle(); assert.equal(expanded.noActivate, false);
    window.setFocusable(false); const restored = readStyle(); assert.equal(restored.noActivate, true);
    nativeActivation = { collapsed, expanded, restored, visible: window.isVisible() };
    assert.equal(window.isVisible(), false);
    const { ChatStorage } = require(path.join(dist, 'chat-storage'));
    const { persistSettingsPatch } = require(path.join(dist, 'settings'));
    const storage = await ChatStorage.open(app.getPath('userData'));
    await storage.save(state);
    const settingsWindow = new BrowserWindow({ width: 380, height: 680, useContentSize: true, show: false, focusable: false, webPreferences: { preload: path.join(dist, 'preload.js'), sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    ipcMain.handle('settings:save', async (_event, patch) => {
      try { await persistSettingsPatch(state, patch, () => storage.save(state)); return { ok: true, error: '' }; }
      catch (error) { return { ok: false, error: error.message }; }
    });
    ipcMain.handle('settings:resize', (_event, height) => { settingsWindow.setContentSize(380, Math.min(Math.ceil(height), 680)); });
    ipcMain.handle('cli:models', () => ({ models: [], source: '', fetchedAt: '' }));
    ipcMain.handle('api:presets', () => require(path.join(dist, 'api-models')).apiPresets);
    ipcMain.handle('cli:discover', () => []);
    const settingsJs = code => settingsWindow.webContents.executeJavaScript(code);
    async function loadSettings() {
      await settingsWindow.loadFile(path.join(dist, 'ui/settings.html'));
      for (let i = 0; i < 100 && !await settingsJs('!!window.flushSettings && !document.querySelector("#provider").disabled'); i++) await new Promise(resolve => setTimeout(resolve, 20));
      if (checkTabs) assert.equal(await settingsJs('document.querySelector("[role=tab][aria-selected=true]").id'), 'tab-connection');
      await settingsJs('document.querySelector("#tab-chat-options")?.click()');
    }
    await loadSettings();
    assert.equal(await settingsJs('document.querySelector("#screenCaptureEnabled")'), null);
    const beforeToggle = captures;
    await loadSettings(); assert.equal(captures, beforeToggle, 'Opening settings does not capture');
    assert.equal(await settingsJs('document.querySelector("#screenCaptureEnabled")'), null);
    assert.equal((await (await ChatStorage.open(app.getPath('userData'))).load()).value.settings.screenCaptureEnabled, state.settings.screenCaptureEnabled);
    const layout = await settingsJs('({fits:document.documentElement.scrollWidth<=document.documentElement.clientWidth,width:document.documentElement.clientWidth})');
    assert.equal(layout.fits, true); assert.equal(layout.width, 380);
    await fs.writeFile(path.join(output, packaged ? 'packaged-settings.png' : 'settings.png'), (await settingsWindow.webContents.capturePage()).toPNG());
    settingsReport = { automaticCaptureRemoved: true, legacySettingPreserved: true, openingDoesNotCapture: true, layout };
    if (checkTabs) {
      const views = [];
      assert.equal(await settingsJs('document.querySelectorAll("details").length'), 0);
      await settingsJs(`document.querySelector('#tab-connection').click();document.querySelector('#cli-model-choice').value='__custom__';document.querySelector('#cli-model-choice').dispatchEvent(new Event('change'));document.querySelector('#cliModel').value='pending-model';document.querySelector('#cliModel').dispatchEvent(new Event('input'));document.querySelector('#tab-chat-options').click()`);
      settingsWindow.webContents.send('chat:state', publicState());
      await settingsJs('document.querySelector("#tab-connection").click()');
      assert.equal(await settingsJs('document.querySelector("#cliModel").value'), 'pending-model');
      assert.equal(await settingsJs('window.flushSettings()'), true);
      assert.equal(state.settings.cliModel, 'pending-model');
      await settingsJs(`document.querySelector('#cli-model-choice').value='';document.querySelector('#cli-model-choice').dispatchEvent(new Event('change'));window.flushSettings()`);
      for (const theme of ['light', 'dark']) {
        nativeTheme.themeSource = theme;
        for (let i = 0; i < 100 && !await settingsJs(`matchMedia('(prefers-color-scheme: dark)').matches === ${theme === 'dark'}`); i++) await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(await settingsJs("matchMedia('(prefers-color-scheme: dark)').matches"), theme === 'dark');
        for (const panel of ['connection', 'chat-options', 'appearance', 'pet-options']) {
          await settingsJs(`document.querySelector('#tab-${panel}').click()`);
          await settingsJs('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
          const view = await settingsJs(`(() => { const tabs=[...document.querySelectorAll('[role=tab]')], shell=document.querySelector('#settings-shell'), panels=[...document.querySelectorAll('[role=tabpanel]')];return {selected:tabs.find(t=>t.getAttribute('aria-selected')==='true').getAttribute('aria-controls'),visible:panels.filter(p=>!p.hidden).map(p=>p.id),widths:tabs.map(t=>t.getBoundingClientRect().width),height:Math.ceil(shell.getBoundingClientRect().height),fits:document.documentElement.scrollWidth===document.documentElement.clientWidth,checkVisible:!document.querySelector('#check').hidden}})()`);
          assert.equal(view.selected, panel); assert.deepEqual(view.visible, [panel]);
          assert.ok(Math.max(...view.widths) - Math.min(...view.widths) < 1);
          assert.equal(view.fits, true); assert.equal(view.checkVisible, panel === 'connection');
          assert.equal(settingsWindow.getContentSize()[1], view.height, 'Native window follows active panel height');
          const image = await settingsWindow.webContents.capturePage({ x: 0, y: 0, width: 380, height: view.height });
          await fs.writeFile(path.join(output, `${packaged ? 'packaged-' : ''}${theme}-${panel}.png`), image.toPNG());
          views.push({ theme, panel, ...view });
        }
      }
      await settingsJs(`document.querySelector('#tab-pet-options').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))`);
      assert.equal(await settingsJs('document.activeElement.id'), 'tab-connection');
      await settingsJs(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`);
      assert.equal(await settingsJs('document.activeElement.id'), 'tab-chat-options');
      settingsReport.tabs = { views, pendingEditSurvivesSwitchAndEcho: true, keyboardNavigation: true };
    }
    settingsWindow.destroy();
  }
  const report = { syntheticCaptureOnly: true, samples, notice, settingsReport, nativeActivation, nativeRegionReport };
  await fs.writeFile(path.join(output, baseline ? 'baseline.json' : packaged ? 'packaged-gestures.json' : 'gestures.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); window.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
