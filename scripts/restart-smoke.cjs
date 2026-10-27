const { spawnSync } = require('node:child_process');
const { mkdtempSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const packaged = process.argv[2];
const executable = packaged ? path.resolve(packaged) : require('electron');
const env = { ...process.env, CHATBUBBLE_RESTART_DATA: mkdtempSync(path.join(os.tmpdir(), 'chatbubble-restart-')) };
delete env.ELECTRON_RUN_AS_NODE;
for (const phase of ['--restart-seed', '--restart-verify']) {
  const result = spawnSync(executable, [...(packaged ? [] : [root]), phase], { env, windowsHide: true, stdio: 'inherit', timeout: 30000 });
  if (result.error || result.status !== 0) { console.error(result.error || `Restart test failed: ${result.status}`); process.exit(1); }
}
console.log('Process restart and single-instance checks passed.');
