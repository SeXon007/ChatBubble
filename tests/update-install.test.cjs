const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), { execFile } = require('node:child_process'), { promisify } = require('node:util'), { createHash } = require('node:crypto');
const run = promisify(execFile), powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const helper = path.resolve(__dirname, '../src/native/install-update.ps1');
async function fixture(t, kind) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatbubble-install-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const old = path.join(root, 'ChatBubble-0.14.0-win32-x64'); await fs.mkdir(path.join(old, 'chat'), { recursive: true });
  await fs.writeFile(path.join(old, 'ChatBubble.exe'), 'old executable'); await fs.writeFile(path.join(old, 'chat/state.json'), 'preserve user fixture');
  await run(powershell, ['-NoProfile', '-NonInteractive', '-File', path.resolve(__dirname, '../scripts/update-package-fixture.ps1'), '-Root', root, '-Kind', kind], { windowsHide: true, timeout: 20000 });
  const zip = path.join(root, kind + '.zip'), config = path.join(root, 'install.json');
  await fs.writeFile(config, JSON.stringify({ version: '0.15.0', sha256: createHash('sha256').update(await fs.readFile(zip)).digest('hex'), zip, oldExecutable: path.join(old, 'ChatBubble.exe'), oldPid: 99999999, shortcuts: [] }));
  return { root, old, config };
}
test('native updater stages a new directory and preserves old program and chat byte-for-byte', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, 'valid');
  await run(powershell, ['-NoProfile', '-NonInteractive', '-File', helper, '-Mode', 'Prepare', '-Config', f.config], { windowsHide: true, timeout: 20000 });
  assert.equal(await fs.readFile(path.join(f.old, 'ChatBubble.exe'), 'utf8'), 'old executable');
  assert.equal(await fs.readFile(path.join(f.old, 'chat/state.json'), 'utf8'), 'preserve user fixture');
  assert.ok(await fs.stat(path.join(f.root, 'ChatBubble-0.15.0-win32-x64/ChatBubble.exe')));
  await assert.rejects(run(powershell, ['-NoProfile', '-NonInteractive', '-File', helper, '-Mode', 'Prepare', '-Config', f.config], { windowsHide: true, timeout: 20000 }));
});
test('native updater rejects path traversal, embedded chat data and mismatched package metadata', { skip: process.platform !== 'win32' }, async t => {
  for (const kind of ['traversal', 'userdata', 'metadata']) {
    const f = await fixture(t, kind);
    const expected = { traversal: 'Invalid archive path', userdata: 'User data in update archive', metadata: 'Unexpected package metadata' }[kind];
    await assert.rejects(run(powershell, ['-NoProfile', '-NonInteractive', '-File', helper, '-Mode', 'Prepare', '-Config', f.config], { windowsHide: true, timeout: 20000 }), error => error.stderr.includes(expected));
    await assert.rejects(fs.stat(path.join(f.root, 'ChatBubble-0.15.0-win32-x64')));
    assert.equal(await fs.readFile(path.join(f.old, 'chat/state.json'), 'utf8'), 'preserve user fixture');
    await assert.rejects(fs.stat(path.join(f.root, 'outside.txt')));
  }
});

test('native update launcher starts an owned fixture, updates its shortcut, and rolls back on a failed start', { skip: process.platform !== 'win32' }, async t => {
  for (const fail of [false, true]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatbubble-launch-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
    await run(powershell, ['-NoProfile', '-NonInteractive', '-File', path.resolve(__dirname, '../scripts/update-launch-fixture.ps1'), '-Root', root, ...(fail ? ['-Fail'] : [])], { windowsHide: true, timeout: 30000 });
    const old = path.join(root, 'ChatBubble-0.14.0-win32-x64'), next = path.join(root, 'ChatBubble-0.15.0-win32-x64'), config = path.join(root, 'install.json');
    await fs.writeFile(config, JSON.stringify({ version: '0.15.0', sha256: '0'.repeat(64), oldExecutable: path.join(old, 'ChatBubble.exe'), oldPid: 99999999, shortcuts: [path.join(root, 'ChatBubble.lnk')] }));
    const task = run(powershell, ['-NoProfile', '-NonInteractive', '-File', helper, '-Mode', 'Launch', '-Config', config], { windowsHide: true, timeout: 20000 });
    if (fail) await assert.rejects(task); else await task;
    await new Promise(resolve => setTimeout(resolve, 2000));
    assert.equal(await fs.readFile(path.join(fail ? old : next, 'started.txt'), 'utf8'), fail ? 'old' : 'new');
    const check = path.join(root, 'read-shortcut.ps1');
    await fs.writeFile(check, 'param([string]$Path)\n(New-Object -ComObject WScript.Shell).CreateShortcut($Path).TargetPath');
    const result = await run(powershell, ['-NoProfile', '-NonInteractive', '-File', check, '-Path', path.join(root, 'ChatBubble.lnk')], { windowsHide: true });
    assert.equal(result.stdout.trim().toLowerCase(), path.join(fail ? old : next, 'ChatBubble.exe').toLowerCase());
  }
});
