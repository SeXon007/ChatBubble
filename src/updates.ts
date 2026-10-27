import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile, spawn } from 'node:child_process';

export const updateRepository = { owner: 'SeXon007', name: 'ChatBubble' };
export interface UpdateState {
  phase: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'error';
  message: string; version?: string; progress?: number;
}
interface Candidate { version: string; name: string; url: string; size: number; sha256: string }
export const validVersion = (s: unknown): s is string => typeof s === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(s) && s.length < 40 && s.split('.').every(n => Number.isSafeInteger(Number(n)));
export function newerVersion(next: string, current: string): boolean {
  if (!validVersion(next) || !validVersion(current)) return false;
  const a = next.split('.').map(Number), b = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}
const repositoryPath = `/${updateRepository.owner}/${updateRepository.name}`;
const maxDownload = 512 * 1024 * 1024;
const hosts = new Set(['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
function allowedUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !hosts.has(url.hostname)) throw Error('unsafe update URL');
  return url;
}
async function boundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) throw Error('empty update response');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > limit) throw Error('update response too large'); chunks.push(part.value); } }
  finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}
export function releaseCandidate(value: any, current: string): Candidate | undefined {
  if (!value || value.draft !== false || value.prerelease !== false || !Array.isArray(value.assets)) throw Error('invalid release');
  const version = typeof value.tag_name === 'string' ? value.tag_name.replace(/^v/, '') : '';
  if (!validVersion(version)) throw Error('invalid release version');
  if (!newerVersion(version, current)) return undefined;
  const name = `ChatBubble-${version}-win32-x64.zip`;
  const asset = value.assets.find((a: any) => a?.name === name && a.state === 'uploaded');
  if (!asset || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > maxDownload || typeof asset.browser_download_url !== 'string') throw Error('missing compatible asset');
  const url = allowedUrl(asset.browser_download_url);
  if (url.origin !== 'https://github.com' || url.pathname !== `${repositoryPath}/releases/download/${value.tag_name}/${name}` || url.search || url.hash) throw Error('unexpected release asset');
  if (typeof asset.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest)) throw Error('missing asset checksum');
  return { version, name, url: url.href, size: asset.size, sha256: asset.digest.slice(7).toLowerCase() };
}

export class Updates {
  state: UpdateState = { phase: 'idle', message: '点击“检查更新”读取 GitHub 最新版本。' };
  private candidate?: Candidate;
  private abort?: AbortController;
  private prepared?: string;
  constructor(private options: { version: string; cache: string; fetcher: typeof fetch; changed: () => void;
    prepare: (candidate: Candidate, zip: string, folder: string) => Promise<string> }) {}
  private set(state: UpdateState): UpdateState { this.state = state; this.options.changed(); return state; }
  get busy(): boolean { return !!this.abort; }
  get launchConfig(): string | undefined { return this.state.phase === 'ready' ? this.prepared : undefined; }
  cancel(): void { this.abort?.abort(); }
  remainReady(message: string): void { this.set({ ...this.state, phase: 'ready', message }); }
  failure(message: string): UpdateState { this.prepared = undefined; return this.set({ phase: 'error', message }); }
  private async fetch(url: string, signal: AbortSignal): Promise<Response> {
    for (let redirects = 0; redirects < 6; redirects++) {
      const checked = allowedUrl(url);
      const response = await this.options.fetcher(checked.href, { signal, redirect: 'manual', headers: { Accept: checked.hostname === 'api.github.com' ? 'application/vnd.github+json' : 'application/octet-stream', 'User-Agent': 'ChatBubble/' + this.options.version } });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location) throw Error('missing redirect'); url = new URL(location, checked).href;
    }
    throw Error('too many redirects');
  }
  async check(): Promise<UpdateState> {
    if (this.busy || this.state.phase === 'ready') return this.state;
    this.candidate = undefined; const abort = this.abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 15000);
    this.set({ phase: 'checking', message: '正在检查 GitHub 更新…' });
    try {
      const response = await this.fetch(`https://api.github.com/repos${repositoryPath}/releases/latest`, abort.signal);
      if (response.status === 404) { await response.body?.cancel(); return this.set({ phase: 'idle', message: '更新仓库暂未发布正式版本，请稍后检查。' }); }
      if (!response.ok) { await response.body?.cancel(); throw Error('GitHub unavailable'); }
      const candidate = releaseCandidate(JSON.parse(await boundedText(response, 1024 * 1024)), this.options.version);
      this.candidate = candidate;
      return this.set(candidate ? { phase: 'available', version: candidate.version, message: `发现新版本 ${candidate.version}，可下载更新。` }
        : { phase: 'current', message: '当前已是最新版本。' });
    } catch { return this.failure('检查更新失败，请检查网络或稍后重试。'); }
    finally { clearTimeout(timer); this.abort = undefined; }
  }
  async download(): Promise<UpdateState> {
    if (this.busy || !this.candidate || !['available', 'error'].includes(this.state.phase)) return this.state;
    const candidate = this.candidate, abort = this.abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 10 * 60 * 1000);
    this.set({ phase: 'downloading', version: candidate.version, progress: 0, message: '正在下载更新… 0%' });
    try {
      await mkdir(this.options.cache, { recursive: true });
      const folder = await mkdtemp(path.join(this.options.cache, candidate.version + '-'));
      const response = await this.fetch(candidate.url, abort.signal);
      if (!response.ok || !response.body) { await response.body?.cancel(); throw Error('download failed'); }
      const zip = path.join(folder, candidate.name), partial = zip + '.partial', hash = createHash('sha256'); let bytes = 0, progress = 0;
      const self = this;
      async function* chunks() {
        for await (const chunk of Readable.fromWeb(response.body as any)) {
          const data = Buffer.from(chunk); bytes += data.length;
          if (bytes > candidate.size || bytes > maxDownload) throw Error('oversized download'); hash.update(data);
          const next = Math.floor(bytes / candidate.size * 100);
          if (next !== progress) { progress = next; self.set({ phase: 'downloading', version: candidate.version, progress, message: `正在下载更新… ${progress}%` }); }
          yield data;
        }
      }
      await pipeline(chunks(), createWriteStream(partial, { flags: 'wx' }), { signal: abort.signal });
      if (bytes !== candidate.size || hash.digest('hex') !== candidate.sha256) throw Error('checksum mismatch');
      await rename(partial, zip);
      this.set({ phase: 'downloading', version: candidate.version, progress: 100, message: '下载完成，正在校验并准备新版本…' });
      this.prepared = await this.options.prepare(candidate, zip, folder);
      return this.set({ phase: 'ready', version: candidate.version, message: '新版已准备完成，点击“重启并更新”。原聊天和旧版均保留。' });
    } catch { return this.failure('更新准备失败，旧版和聊天记录已保留。请重新检查后再试。'); }
    finally { clearTimeout(timer); this.abort = undefined; }
  }
}

const powershell = () => path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
export async function prepareUpdate(options: { candidate: Candidate; zip: string; folder: string; executable: string; helper: string; shortcuts: string[] }): Promise<string> {
  const config = path.join(options.folder, 'install.json');
  await writeFile(config, JSON.stringify({ version: options.candidate.version, sha256: options.candidate.sha256, zip: options.zip,
    oldExecutable: await realpath(options.executable), oldPid: process.pid, shortcuts: options.shortcuts }), { flag: 'wx' });
  await new Promise<void>((resolve, reject) => execFile(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', options.helper, '-Mode', 'Prepare', '-Config', config],
    { windowsHide: true, timeout: 180000, maxBuffer: 64000 }, error => error ? reject(Error('update extraction failed')) : resolve()));
  return config;
}
export async function launchUpdate(config: string, helper: string): Promise<void> {
  const value = JSON.parse(await readFile(config, 'utf8'));
  if (!validVersion(value.version)) throw Error('invalid prepared update');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Mode', 'Launch', '-Config', config], { detached: true, windowsHide: true, stdio: 'ignore' });
    child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
  });
}
