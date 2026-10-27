// Isolated visual/layout verification: no user data, network or model requests.
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'docs/verification/ui-0.7.1');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'chatbubble-icons-')));
app.whenReady().then(async () => {
  fs.mkdirSync(output, { recursive: true });
  const css = fs.readFileSync(path.join(root, 'dist/ui/style.css'), 'utf8');
  const target = new BrowserWindow({ width: 500, height: 550, show: false, icon: path.join(root, 'dist/assets/app.ico') });
  const sql = 'ALTER TABLE users\nADD COLUMN nickname VARCHAR(50) NOT NULL DEFAULT ' + 'very_long_default_value_'.repeat(10) + ';';
  await target.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<style>${css}body{background:#fff;padding:20px}#messages{width:420px;height:420px}</style><div id="messages"><article class="message"><div>代码应在固定宽度内换行：</div><pre><code>${sql}</code></pre></article>${'<article class="message">这是用于检查上下滚动的消息。</article>'.repeat(25)}</div>`));
  const layout = await target.webContents.executeJavaScript(`(() => {
    const messages = document.querySelector('#messages'), pre = document.querySelector('pre');
    messages.scrollTop = 80;
    return { scrollbarHidden: getComputedStyle(messages).scrollbarWidth === 'none', verticalScrolling: messages.scrollTop > 0,
      messagesFit: messages.scrollWidth <= messages.clientWidth, codeFits: pre.scrollWidth <= pre.clientWidth,
      codeWraps: getComputedStyle(pre).whiteSpace === 'pre-wrap', actual: { messageWidth: messages.clientWidth, codeWidth: pre.clientWidth, codeScrollWidth: pre.scrollWidth } };
  })()`);
  await target.webContents.executeJavaScript('document.querySelector("#messages").scrollTop=0');
  fs.writeFileSync(path.join(output, 'wrapping.png'), (await target.webContents.capturePage()).toPNG());
  const ico = fs.readFileSync(path.join(root, 'dist/assets/app.ico'));
  const frames = [];
  for (let i=0; i<ico.readUInt16LE(4); i++) {
    const entry = 6+i*16, length = ico.readUInt32LE(entry+8), offset = ico.readUInt32LE(entry+12);
    const image = nativeImage.createFromBuffer(ico.subarray(offset, offset+length));
    const bitmap = image.toBitmap();
    frames.push({ size: image.getSize(), transparentCorner: bitmap[3] === 0, valid: !image.isEmpty() });
  }
  const executableIcon = await app.getFileIcon(path.join(root, 'release/ChatBubble-0.7.1-win32-x64/ChatBubble.exe'), { size: 'large' });
  fs.writeFileSync(path.join(output, 'exe-icon.png'), executableIcon.toPNG());
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ layout, frames, executableIcon: executableIcon.getSize() }, null, 2));
  if (Object.entries(layout).some(([key,value]) => key !== 'actual' && value !== true) || frames.some(frame => !frame.valid || !frame.transparentCorner)) throw new Error('UI asset check failed');
  console.log(JSON.stringify({layout, iconFrames: frames.length}));
  target.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
