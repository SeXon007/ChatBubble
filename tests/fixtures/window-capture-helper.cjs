const readline = require('node:readline');
const mode = process.argv[2];
const target = handle => ({ handle, pid: 731, width: 700, height: 460 });
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const monitor = handle => ({ handle, width: 1920, height: 1080 });
const ready = () => { emit({ target: target('101') }); emit({ monitor: monitor('301') }); emit({ ready: true }); };
if (mode === 'delayed') setTimeout(ready, 60); else ready();
readline.createInterface({ input: process.stdin }).on('line', line => {
  if (line === 'change') { emit({ target: target('202') }); emit({ monitor: monitor('302') }); return; }
  if (!line.startsWith('capture:') && !line.startsWith('monitor:')) return;
  if (mode === 'hang') return;
  if (mode === 'blank') { emit({ error: 'blank-image' }); return; }
  if (mode === 'exit') { process.exit(0); return; }
  if (mode === 'oversize') { emit({ image: Buffer.alloc(16_000_001).toString('base64') }); return; }
  const handle = line.split(':')[1];
  emit({ image: Buffer.alloc(100, Number(handle) % 256).toString('base64') });
});
