import { mkdir, readFile, rename, copyFile, open } from 'node:fs/promises';
import path from 'node:path';

// One queue per file. Snapshots are serialized at enqueue time, not at write time.
export class JsonStore<T> {
  private queue: Promise<void> = Promise.resolve();
  constructor(readonly file: string, private valid: (value: unknown) => value is T) {}
  async load(fallback: () => T): Promise<{ value: T; recovered: boolean }> {
    try { return { value: await this.read(this.file), recovered: false }; }
    catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      try {
        const value = await this.read(this.file + '.bak');
        if (!missing) await rename(this.file, this.file + `.corrupt-${Date.now()}`);
        return { value, recovered: true };
      } catch (backupError) {
        if (missing && (backupError as NodeJS.ErrnoException).code === 'ENOENT') return { value: fallback(), recovered: false };
        throw new Error('本地数据无法读取，已保留原文件。请备份用户数据目录后修复。');
      }
    }
  }
  private async read(file: string): Promise<T> {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!this.valid(value)) throw new Error('Invalid stored data');
    return value;
  }
  save(value: T): Promise<void> {
    const snapshot = JSON.stringify(value, null, 2);
    const operation = this.queue.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temp = this.file + '.tmp';
      const handle = await open(temp, 'w');
      try { await handle.writeFile(snapshot, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      try {
        await this.read(this.file); // Only back up a valid previous state.
        await copyFile(this.file, this.file + '.bak.tmp');
        await rename(this.file + '.bak.tmp', this.file + '.bak');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await rename(temp, this.file);
    });
    this.queue = operation;
    return operation;
  }
  flush(): Promise<void> { return this.queue; }
}
