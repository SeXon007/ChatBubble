const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CliOutput, cliArguments, inspectCli } = require('../dist/cli');
const { runCliProcess } = require('../dist/cli');
const path = require('node:path');
test('Codex JSONL shows assistant text only and requires a completed turn', () => {
  let text = ''; const output = new CliOutput('codex-cli', chunk => { text += chunk; });
  output.consume(JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'private reasoning' } }));
  output.consume(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '你好' } }));
  assert.equal(output.complete, false); output.consume('{"type":"turn.completed"}');
  assert.equal(text, '你好'); assert.equal(output.complete, true);
});
test('Claude partial stream and final message do not duplicate text', () => {
  let text = ''; const output = new CliOutput('claude-cli', chunk => { text += chunk; });
  output.consume(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } } }));
  output.consume(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '你好' }] } }));
  output.consume('{"type":"result","subtype":"success","result":"你好","is_error":false}');
  assert.equal(text, '你好'); assert.equal(output.complete, true);
});
test('CLI failures and unexpected tool calls fail without returning raw diagnostics', () => {
  const codex = new CliOutput('codex-cli', () => {}); const claude = new CliOutput('claude-cli', () => {});
  assert.throws(() => codex.consume('{"type":"turn.failed","error":{"message":"secret"}}'), error => !error.message.includes('secret'));
  assert.throws(() => codex.consume('{"type":"item.started","item":{"type":"command_execution"}}'), /非聊天工具/);
  assert.throws(() => claude.consume('{"type":"assistant","message":{"content":[{"type":"tool_use"}]}}'), /工具/);
  assert.throws(() => claude.consume('{"type":"result","subtype":"error_max_turns","is_error":true}'), /请求失败/);
});
test('fixed CLI args prohibit shell execution and keep model selection in a single argument', () => {
  const model = 'test & echo should-not-run';
  const codex = cliArguments('codex-cli', model); const claude = cliArguments('claude-cli', model);
  assert.ok(codex.includes('app-server')); assert.ok(codex.includes('sandbox_mode="read-only"')); assert.ok(codex.includes('shell_tool'));
  assert.ok(codex.includes('model=' + JSON.stringify(model)));
  assert.ok(claude.includes('--safe-mode')); assert.equal(claude[claude.indexOf('--tools') + 1], '');
  assert.ok(!codex.includes('--dangerously-bypass-approvals-and-sandbox'));
});
test('manual CLI path cannot be a shell script or a composed command', async () => {
  await assert.rejects(inspectCli('codex-cli', 'codex & whoami'), /绝对路径/);
  await assert.rejects(inspectCli('claude-cli', 'C:\\temp\\claude.ps1'), /绝对路径/);
});
const processOptions = (extra = {}) => ({ executable: process.execPath, args: [path.join(__dirname, 'fixtures/cli-process.cjs')], cwd: __dirname, env: process.env, prompt: '中文 & echo $(not-a-command)', kind: 'codex-cli', signal: new AbortController().signal, onChunk: () => {}, ...extra });
test('subprocess transports UTF-8 prompt through stdin literally', async () => {
  let text = ''; await runCliProcess(processOptions({ onChunk: s => { text += s; } }));
  assert.equal(text, '中文 & echo $(not-a-command)');
});
test('subprocess cancellation terminates the owned CLI and preserves partial output', { timeout: 10000 }, async () => {
  const abort = new AbortController(); let text = '';
  await assert.rejects(runCliProcess(processOptions({ args: [path.join(__dirname, 'fixtures/cli-process.cjs'), '--hang'], signal: abort.signal, onChunk: s => { text += s; abort.abort(); } })), /停止生成/);
  assert.ok(text.includes('中文'));
});
test('subprocess timeout and nonzero exit are never reported as successful completion', { timeout: 10000 }, async () => {
  await assert.rejects(runCliProcess(processOptions({ args: [path.join(__dirname, 'fixtures/cli-process.cjs'), '--hang'], timeoutMs: 150 })), /超时/);
  await assert.rejects(runCliProcess(processOptions({ args: [path.join(__dirname, 'fixtures/cli-process.cjs'), '--fail'] })), /请求失败/);
});
