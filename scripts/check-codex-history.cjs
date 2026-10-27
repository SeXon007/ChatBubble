// Explicit live integration check: two tiny model turns, one saved native conversation.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ChatController } = require('../dist/chat');
const { streamCli } = require('../dist/cli');
const { initialState, isState } = require('../dist/model');
const { JsonStore } = require('../dist/storage');
const { CodexRpc, codexArguments } = require('../dist/codex');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'docs/verification/native-codex');
const executable = process.env.CHATBUBBLE_CODEX_EXE;
async function worker(phase) {
  const store = new JsonStore(path.join(dir, 'state.json'), isState);
  const { value: state } = await store.load(initialState);
  state.settings = { ...state.settings, provider: 'codex-cli', cliPath: executable, cliModel: 'gpt-6.1-sol', reasoningEffort: 'low' };
  const workDir = path.join(process.env.APPDATA, 'ChatBubble/cli-workspace');
  const chat = new ChatController(state, store, () => '', () => {}, undefined, options => streamCli({ ...options, workDir }));
  const question = phase === 'first' ? '这是 ChatBubble 会话保存测试。请记住代号“青石731”，只回复“已记住”。不要调用工具。' : '刚才的代号是什么？只回复代号，不要调用工具。';
  const retry = ['failed', 'cancelled', 'interrupted'].includes(state.session.messages.at(-1)?.status);
  const result = await chat.send(question, retry);
  if (!result.ok) throw new Error(result.error);
  while (chat.busy) await new Promise(r => setTimeout(r, 100));
  await store.flush();
  const last = state.session.messages.at(-1);
  if (last.status !== 'complete') throw new Error(last.error || 'Live turn incomplete');
  if (phase === 'second' && !last.content.includes('731')) throw new Error('Native context recall failed');
  console.log(JSON.stringify({ phase, ok: true, threadId: state.session.codex.threadId, recall: phase === 'second' ? true : undefined }));
}
async function main() {
  if (!executable) throw new Error('Set CHATBUBBLE_CODEX_EXE to an installed codex.exe');
  await fs.mkdir(dir, { recursive: true });
  if (['first', 'second'].includes(process.argv[2])) return worker(process.argv[2]);
  // Avoid accidentally duplicating a paid live check.
  try { await fs.access(path.join(dir, 'state.json')); if (process.argv[2] !== '--continue') throw new Error('Live state exists; inspect it before explicitly repeating this test.'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const run = phase => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, phase], { cwd: root, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', s => { output += s; }); child.stderr.on('data', () => {});
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error('Live check failed in ' + phase + '; inspect the synthetic test state.')));
  });
  const checks = {};
  const existing = await fs.readFile(path.join(dir, 'state.json'), 'utf8').then(JSON.parse).catch(() => null);
  const completed = existing?.session.messages.filter(m => m.role === 'assistant' && m.status === 'complete').length ?? 0;
  if (completed === 0) await run('first');
  const first = JSON.parse(await fs.readFile(path.join(dir, 'state.json')));
  checks.nativeIdentitySaved = !!first.session.codex;
  if (completed < 2) await run('second');
  const second = JSON.parse(await fs.readFile(path.join(dir, 'state.json')));
  checks.sameThreadAfterProcessRestart = first.session.codex.threadId === second.session.codex.threadId;
  checks.nativeContextRecall = second.session.messages.at(-1).content.includes('731');
  const rpc = new CodexRpc({ executable, args: codexArguments(), cwd: second.session.codex.cwd });
  try {
    await rpc.initialize();
    const { thread } = await rpc.request('thread/read', { threadId: second.session.codex.threadId });
    checks.nativeReadback = thread.id === second.session.codex.threadId && !thread.ephemeral;
    const page = await rpc.request('thread/turns/list', { threadId: thread.id, itemsView: 'full', limit: 10, sortDirection: 'asc' });
    checks.exactlyTwoTurns = page.data.length === 2;
    checks.onlyTextItems = page.data.every(t => t.items.every(i => ['userMessage', 'agentMessage', 'reasoning', 'contextCompaction'].includes(i.type)));
    const report = { date: new Date().toISOString(), threadId: thread.id, source: thread.source, originator: thread.originator, cwd: thread.cwd, checks, desktopVisible: null };
    await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    if (Object.values(checks).some(v => !v)) throw new Error('Native history check failed');
  } finally { await rpc.close(); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
