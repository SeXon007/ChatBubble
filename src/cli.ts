import { spawn, execFile } from 'node:child_process';
import { access, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Settings } from './model';
import { reasoningEfforts } from './cli-models';
import { codexArguments, streamCodex, type CodexConversation } from './codex';
import type { ScreenAttachment } from './screen-capture';

export type CliKind = 'codex-cli' | 'claude-cli';
export interface CliCandidate { kind: CliKind; path: string; version: string; usable: boolean; error: string }
const commandName = (kind: CliKind): string => kind === 'codex-cli' ? 'codex.exe' : 'claude.exe';
const runInfo = (file: string, args: string[]): Promise<string> => new Promise((resolve, reject) => {
  execFile(file, args, { windowsHide: true, timeout: 10000, maxBuffer: 256000, encoding: 'utf8' }, (error, stdout) => error ? reject(new Error('CLI 无法启动，请检查安装。')) : resolve(stdout));
});
const verified = new Map<string, CliCandidate>();
export async function inspectCli(kind: CliKind, file: string): Promise<CliCandidate> {
  if (!path.isAbsolute(file) || path.basename(file).toLowerCase() !== commandName(kind)) throw new Error(`请选择 ${commandName(kind)} 的绝对路径。npm 安装的脚本入口可通过自动检测解析。`);
  await access(file).catch(() => { throw new Error('CLI 文件不存在，请重新检测或选择路径。'); });
  const cached = verified.get(`${kind}:${file}`); if (cached) return cached;
  const version = (await runInfo(file, ['--version'])).trim().slice(0, 120);
  const help = await runInfo(file, kind === 'codex-cli' ? ['app-server', '--help'] : ['--help']);
  const flags = kind === 'codex-cli' ? ['--listen', 'stdio://', 'generate-json-schema'] : ['--safe-mode', '--tools', '--no-session-persistence', '--include-partial-messages'];
  const usable = flags.every(flag => help.includes(flag));
  const result = { kind, path: file, version, usable, error: usable ? '' : '当前 CLI 版本缺少聊天隔离所需参数，请先更新 CLI。' };
  verified.set(`${kind}:${file}`, result); return result;
}
export async function discoverCli(): Promise<CliCandidate[]> {
  const directories = [...new Set([...(process.env.PATH ?? '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin'), path.join(process.env.APPDATA ?? os.homedir(), 'npm')].filter(Boolean))];
  const found: CliCandidate[] = []; const seen = new Set<string>();
  for (const directory of directories) {
    if (!path.isAbsolute(directory)) continue;
    for (const kind of ['codex-cli'] as const) {
      const files = [path.join(directory, commandName(kind))];
      for (const packageDir of ['node_modules/@openai/codex/node_modules/@openai/codex-win32-x64', 'node_modules/@openai/codex-win32-x64', 'node_modules/@openai/codex']) {
        files.push(path.join(directory, packageDir, 'vendor/x86_64-pc-windows-msvc/codex/codex.exe'));
        files.push(path.join(directory, packageDir, 'vendor/x86_64-pc-windows-msvc/bin/codex.exe'));
      }
      for (const file of files) {
        try {
          const resolved = await realpath(file); const key = resolved.toLowerCase(); if (seen.has(key)) continue; seen.add(key);
          found.push(await inspectCli(kind, resolved));
        } catch { /* Only known install locations; no whole-drive scan or shell execution. */ }
      }
    }
  }
  return found;
}

export function cliArguments(kind: CliKind, model: string, effort = ''): string[] {
  if (!reasoningEfforts.includes(effort)) throw new Error('无效的推理强度。');
  if (kind === 'claude-cli') return ['--print', '--safe-mode', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-chrome', '--disable-slash-commands', '--no-session-persistence', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...(model ? ['--model', model] : [])];
  return [...codexArguments(), ...(model ? ['-c', `model=${JSON.stringify(model)}`] : []),
    ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : [])];
}

function cliFailure(detail: unknown): Error {
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail ?? '');
  if (/usage limit|quota|rate.limit|credit|额度|限流/i.test(text)) return new Error('CLI 当前账户额度不足或受到限流，请稍后重试或切换连接方式。');
  if (/unauthorized|authentication|not.logged|log.in|sign.in|401|登录/i.test(text)) return new Error('CLI 尚未登录或登录已失效，请先在终端完成登录。');
  return new Error('CLI 请求失败，请在终端检查登录、额度、网络和版本。');
}
export class CliOutput {
  complete = false;
  text = '';
  private partial = false;
  constructor(private kind: CliKind, private chunk: (text: string) => void) {}
  private append(text: string): void {
    this.text += text; if (this.text.length > 1000000) throw new Error('CLI 回复过长，已停止接收。');
    this.chunk(text);
  }
  consume(line: string): void {
    if (!line.trim()) return;
    let e: any; try { e = JSON.parse(line); } catch { throw new Error('CLI 返回了无法识别的数据，请检查 CLI 版本。'); }
    if (this.kind === 'codex-cli') {
      if (e.type === 'item.completed' && e.item?.type === 'agent_message' && typeof e.item.text === 'string') this.append(e.item.text);
      if (e.type === 'turn.completed') this.complete = true;
      if (e.type === 'turn.failed' || e.type === 'error') throw cliFailure(e.error ?? e.message);
      if ((e.type === 'item.started' || e.type === 'item.completed') && ['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(e.item?.type)) throw new Error('CLI 尝试调用非聊天工具，已停止本次请求。');
    } else {
      if (e.type === 'stream_event' && e.event?.type === 'content_block_delta' && e.event.delta?.type === 'text_delta' && typeof e.event.delta.text === 'string') {
        this.partial = true; this.append(e.event.delta.text);
      }
      if (e.type === 'assistant' && !this.partial && Array.isArray(e.message?.content)) {
        for (const block of e.message.content) if (block.type === 'text' && typeof block.text === 'string') this.append(block.text);
      }
      if (e.type === 'result') {
        if (e.is_error || e.subtype !== 'success') throw cliFailure(e.result ?? e.errors);
        if (!this.text && typeof e.result === 'string') this.append(e.result);
        this.complete = true;
      }
      if (e.type === 'assistant' && e.message?.content?.some((block: any) => block.type === 'tool_use')) throw new Error('CLI 尝试调用工具，已停止本次请求。');
    }
  }
}

export async function streamCli(options: { settings: Settings; messages: { role: string; content: string }[]; signal: AbortSignal; onChunk: (text: string) => void; workDir: string; codex?: CodexConversation; image?: ScreenAttachment; screenNotice?: string }): Promise<void> {
  const kind = options.settings.provider;
  if (kind !== 'codex-cli') throw new Error('请选择 Codex CLI；Claude CLI 已移除。');
  const candidate = await inspectCli(kind, options.settings.cliPath ?? '');
  if (!candidate.usable) throw new Error(candidate.error);
  if (options.signal.aborted) throw new Error('已停止生成。');
  await mkdir(options.workDir, { recursive: true });
  const question = options.messages.at(-1);
  if (question?.role !== 'user' || !question.content.trim()) throw new Error('请输入消息。');
  return streamCodex({ executable: candidate.path, settings: options.settings, question: question.content,
    workDir: options.workDir, signal: options.signal, onChunk: options.onChunk, conversation: options.codex, image: options.image, screenNotice: options.screenNotice });
}

// Separate subprocess transport so protocol/cancellation can be tested without a paid model.
export async function runCliProcess(options: {
  executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; prompt: string;
  kind: CliKind; signal: AbortSignal; onChunk: (text: string) => void; timeoutMs?: number;
}): Promise<void> {
  if (options.signal.aborted) throw new Error('已停止生成。');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(options.executable, options.args, { cwd: options.cwd, env: options.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = new CliOutput(options.kind, options.onChunk);
    let buffer = ''; let diagnostics = ''; let failure: Error | undefined; let timer: ReturnType<typeof setTimeout>;
    const stop = (error: Error): void => {
      if (failure) return; failure = error;
      if (child.pid && child.exitCode === null) {
        // A CLI may own network/helper children; terminate only this process tree.
        const killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
        killer.on('exit', code => { if (code !== 0) child.kill(); });
      }
    };
    const abort = (): void => stop(new Error('已停止生成。'));
    const reset = (): void => { clearTimeout(timer); timer = setTimeout(() => stop(new Error('CLI 响应超时，请检查登录或网络后重试。')), options.timeoutMs ?? 120000); };
    options.signal.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      reset(); buffer += chunk;
      try {
        if (buffer.length > 2000000) throw new Error('CLI 输出过大，已停止接收。');
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!failure) output.consume(line); }
      } catch (error) { stop(error as Error); }
    });
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-64000); });
    child.stdin.on('error', () => { /* EPIPE is handled by process exit. */ });
    child.on('error', () => { failure = new Error('无法启动 CLI，请重新检测安装路径。'); });
    child.on('close', code => {
      clearTimeout(timer); options.signal.removeEventListener('abort', abort);
      try { if (!failure && buffer.trim()) output.consume(buffer); } catch (error) { failure = error as Error; }
      if (failure) reject(failure);
      else if (code !== 0) reject(cliFailure(diagnostics));
      else if (!output.complete || !output.text) reject(new Error('CLI 未返回完整回答，请检查版本后重试。'));
      else resolve();
    });
    reset(); if (options.signal.aborted) abort();
    child.stdin.end(options.prompt, 'utf8');
  });
}
