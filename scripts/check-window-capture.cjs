const { app, BrowserWindow, nativeImage } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const runtime = process.env.CHATBUBBLE_CAPTURE_RUNTIME || path.resolve(__dirname, '../dist');
const background = process.argv.includes('--background');
const { WindowCapture } = require(path.join(runtime, 'windows-capture'));
const { ScreenCapture } = require(path.join(runtime, 'screen-capture'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let helper, source, own;
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chatbubble-native-screen-'));
  const output = process.env.CHATBUBBLE_CAPTURE_OUTPUT || path.resolve(__dirname, '../docs/verification/feature-0.8.0');
  await fs.mkdir(output, { recursive: true });
  const checks = {};
  let commandSequence = 0;
  const command = async name => {
    const sequence = ++commandSequence;
    await fs.writeFile(path.join(directory, 'command.json'), JSON.stringify({ sequence, command: name }));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const response = await fs.readFile(path.join(directory, 'response.json'), 'utf8').then(JSON.parse).catch(() => null);
      if (response?.sequence === sequence) return response;
      await pause(50);
    }
    throw new Error('fixture-command-timeout:' + name);
  };
  const check = (name, value) => { checks[name] = !!value; if (!value) throw new Error(name); };
  try {
    helper = new WindowCapture(); await helper.ready;
    const sourceEnv = { ...process.env }; delete sourceEnv.ELECTRON_RUN_AS_NODE;
    source = spawn(process.execPath, [path.join(__dirname, 'capture-fixture.cjs'), directory, ...(background ? ['--background'] : [])], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: sourceEnv });
    let lines = '', diagnostics = ''; source.stdout.on('data', value => { lines += value; }); source.stderr.on('data', value => { diagnostics = (diagnostics + value).slice(-1600); });
    const deadline = Date.now() + 15000; while (!lines.includes('ready')) { if (Date.now() > deadline || source.exitCode !== null) throw new Error('source-start-failed: ' + diagnostics); await pause(100); }
    await pause(250);
    const identity = /ready:(\d+):(\d+)/.exec(lines);
    const target = { pid: Number(identity[1]), handle: identity[2], width: 700, height: 460 };
    if (process.argv.includes('--foreground-check')) {
      console.log('Waiting for the synthetic target to become foreground.');
      const focusDeadline = Date.now() + 120000;
      while (helper.target?.handle !== target.handle) { if (Date.now() > focusDeadline) throw new Error('foreground-check-timeout'); await pause(100); }
      check('foreground-tracker-selected-source', helper.target.pid === target.pid);
    }
    const started = Date.now(), first = await helper.capture(process.argv.includes('--foreground-check') ? helper.target : target);
    const captureMs = Date.now() - started;
    const firstImage = nativeImage.createFromBuffer(first); check('real-target-captured', !firstImage.isEmpty() && firstImage.getSize().width > 500);
    await fs.writeFile(path.join(output, 'native-window.png'), first);
    own = new BrowserWindow({ width: 350, height: 180, ...(background ? { x: -14000, y: -14000 } : {}), show: false, autoHideMenuBar: true });
    await own.loadURL('data:text/html,<body style="background:green">ChatBubble own overlay</body>'); if (background) own.showInactive(); else { own.show(); own.focus(); } await pause(200);
    const second = nativeImage.createFromBuffer(await helper.capture(target));
    check('explicit-target-does-not-capture-overlay', second.getSize().width === firstImage.getSize().width && second.getSize().height === firstImage.getSize().height);
    const manager = new ScreenCapture(() => directory, () => helper.capture(target));
    manager.request(); const image = (await manager.take()).image; await manager.close();
    check('capture-saved-directly-and-retained', path.dirname(image.file) === path.join(directory, 'attachments') && (await fs.readFile(image.file)).length > 80);
    // Retain a purely synthetic image for a later native Codex image readback.
    await fs.copyFile(image.file, path.join(output, 'synthetic-attachment.png'));
    check('fixture-actually-minimized', (await command('minimize')).minimized);
    check('minimized-window-refused', await helper.capture(target).then(() => false, () => true));
    await command('focus'); await command('protect'); if (!background) own.focus(); await pause(100);
    check('protected-window-refused', await helper.capture(target).then(() => false, () => true));
    await manager.close();
    await fs.writeFile(path.join(output, process.env.CHATBUBBLE_CAPTURE_RUNTIME ? 'packaged-native-capture.json' : 'native-capture.json'), JSON.stringify({ date: new Date().toISOString(), checks, firstCaptureMs: captureMs, limitations: ['Synthetic Electron target only', 'No cloud requests', 'No screenshot overlay, clipboard or recording session created by the capture path', 'Physical perception of flicker and other applications require manual confirmation'] }, null, 2));
    console.log(JSON.stringify(checks));
  } finally { helper?.close(); own?.destroy(); if (source) await fs.writeFile(path.join(directory, 'command.json'), JSON.stringify({ sequence: ++commandSequence, command: 'quit' })).catch(() => {}); await pause(300); source?.kill(); }
  app.exit(0);
}).catch(error => { helper?.close(); source?.kill(); console.error(error); app.exit(1); });
