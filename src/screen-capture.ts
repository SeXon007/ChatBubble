import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { captureFailure, captureNotice } from './capture-errors';

export interface ScreenAttachment { file: string; capturedAt: string }
export type CaptureResult = { image?: ScreenAttachment; error?: string };
export type CaptureStatus = 'empty' | 'capturing' | 'ready';

// A generation belongs to one explicit request, never to another draft/session.
// Only the latest queued request runs after the active capture finishes.
export class ScreenCapture {
  private queue: Promise<void> = Promise.resolve();
  private current?: { claimed: boolean; ready: boolean; promise: Promise<CaptureResult> };
  constructor(private directory: () => string, private capture: () => Promise<Buffer>, private prepare?: () => () => Promise<Buffer>, private changed: () => void = () => {}) {}
  get status(): CaptureStatus { return !this.current ? 'empty' : this.current.ready ? 'ready' : 'capturing'; }
  request(): Promise<CaptureResult> {
    const job = { claimed: false, ready: false, promise: Promise.resolve({}) as Promise<CaptureResult> };
    this.current = job;
    this.changed();
    const root = this.directory();
    let capture: () => Promise<Buffer>;
    try { capture = this.prepare?.() ?? this.capture; }
    catch (error) { this.current = undefined; this.changed(); return Promise.resolve({ error: captureNotice(captureFailure(error)) }); }
    job.promise = this.queue.then(async (): Promise<CaptureResult> => {
      if (job !== this.current && !job.claimed) return {};
      try {
        const data = await capture();
        // Persist every completed capture, including one that finishes after closing.
        // Superseded queued jobs still skip capture at the check above.
        const folder = path.join(root, 'attachments');
        await mkdir(folder, { recursive: true });
        await safeFolder(root, folder);
        const file = path.join(folder, randomUUID() + '.png');
        await writeFile(file, data, { flag: 'wx' });
        return { image: { file, capturedAt: new Date().toISOString() } };
      } catch (error) { return { error: captureNotice(captureFailure(error)) }; }
    });
    job.promise = job.promise.then(result => {
      if (this.current === job) {
        job.ready = !!result.image;
        if (!result.image) this.current = undefined;
        this.changed();
      }
      return result;
    });
    this.queue = job.promise.then(() => {});
    return job.promise;
  }
  async take(): Promise<CaptureResult> {
    const job = this.current;
    if (!job) return {};
    job.claimed = true; this.clear();
    return job.promise;
  }
  clear(): void {
    if (!this.current) return;
    this.current = undefined;
    this.changed();
  }
  async close(): Promise<void> { this.clear(); await this.queue; }
}

async function safeFolder(root: string, folder: string): Promise<void> {
  if ((await lstat(folder)).isSymbolicLink() || path.dirname(await realpath(folder)) !== await realpath(root)) throw new Error('图片目录不可用。');
}

// Upgrade only: preserve old files in attachments before removing their old entries.
// New captures never use screenshot/, and there is no automatic attachment deletion.
export async function migrateScreenshots(directory: string): Promise<void> {
  const folder = path.join(directory, 'attachments');
  await mkdir(folder, { recursive: true }); await safeFolder(directory, folder);
  const legacy = path.join(directory, 'screenshot');
  const entries = await readdir(legacy, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!entries) return;
  await safeFolder(directory, legacy);
  for (const entry of entries) {
    if (!entry.isFile()) continue; // Never recurse into or remove user-created directories/links.
    const source = path.join(legacy, entry.name);
    let destination = path.join(folder, entry.name);
    for (;;) {
      try { await copyFile(source, destination, constants.COPYFILE_EXCL); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        destination = path.join(folder, randomUUID() + path.extname(entry.name));
      }
    }
    if (!(await readFile(source)).equals(await readFile(destination))) throw new Error('旧截图迁移校验失败，已保留原图。');
    await unlink(source); // Verified move, not expiry or cleanup of an image.
  }
  await rmdir(legacy).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error; });
}
