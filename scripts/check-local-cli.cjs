const { discoverCli, streamCli } = require('../dist/cli');
const { initialState } = require('../dist/model');
const { mkdtemp, writeFile } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
(async () => {
  const candidates = await discoverCli();
  const candidate = candidates.find(c => c.kind === 'codex-cli' && c.usable);
  if (!candidate) throw new Error('No compatible Codex CLI found');
  const report = { date: '2026-10-24', kind: candidate.kind, version: candidate.version, detected: true, generated: false, error: '' };
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 45000);
  let output = '';
  try {
    await streamCli({ settings: { ...initialState().settings, provider: candidate.kind, cliPath: candidate.path }, messages: [{ role: 'user', content: '请只回复 OK，不要调用任何工具。' }], signal: abort.signal, onChunk: s => { output += s; }, workDir: await mkdtemp(path.join(os.tmpdir(), 'chatbubble-cli-check-')) });
    report.generated = output.trim().length > 0;
  } catch (error) { report.error = error.message; }
  finally { clearTimeout(timeout); }
  await writeFile(path.join(__dirname, '../docs/verification/cli-live-check.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
