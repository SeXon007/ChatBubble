const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
app.setPath('userData', path.join(process.argv[2], 'source-data'));
let window;
const background = process.argv.includes('--background');
app.whenReady().then(async () => {
  window = new BrowserWindow({ width: 700, height: 460, ...(background ? { x: -12000, y: -12000 } : {}), autoHideMenuBar: true, show: false, webPreferences: { sandbox: true } });
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<html><title>ChatBubble synthetic capture target</title><body style="margin:0;background:#f5f6f7;font:28px Arial"><div style="background:#185abc;color:white;padding:35px">ChatBubble synthetic capture test</div><div style="padding:35px">SCREEN-CODE-731<br><br><span style="background:#e53935;color:white;padding:16px">RED</span> <span style="background:#2962ff;color:white;padding:16px">BLUE</span></div></body></html>'));
  if (background) window.showInactive(); else { window.show(); window.focus(); }
  process.stdout.write('ready:' + process.pid + ':' + window.getNativeWindowHandle().readBigUInt64LE() + '\n');
  let lastSequence = 0;
  setInterval(() => {
    let request;
    try { request = JSON.parse(fs.readFileSync(path.join(process.argv[2], 'command.json'), 'utf8')); } catch { return; }
    if (request.sequence <= lastSequence) return;
    lastSequence = request.sequence; const command = request.command;
    if (command === 'focus') { window.restore(); if (background) window.showInactive(); else { window.show(); window.focus(); } }
    if (command === 'minimize') window.minimize();
    if (command === 'protect') window.setContentProtection(true);
    if (command === 'quit') app.quit();
    setTimeout(() => fs.writeFileSync(path.join(process.argv[2], 'response.json'), JSON.stringify({ sequence: lastSequence, minimized: window.isMinimized() })), 100);
  }, 50);
});
