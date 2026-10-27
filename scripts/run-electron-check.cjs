const { spawn } = require('node:child_process');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const args = process.argv.slice(2);
const executable = args[0] === '--executable' ? (args.shift(), args.shift()) : require('electron');
const child = spawn(executable, args, { env, windowsHide: true, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('close', code => { process.exitCode = code ?? 1; });
