import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JsonStore } from './storage';
import { initialState, isState, type SavedState, type Session } from './model';
import { recordedSource } from './conversation-source';

interface Location { version: 1; directory: string }
const isLocation = (v: unknown): v is Location => !!v && typeof v === 'object' &&
  (v as Location).version === 1 && typeof (v as Location).directory === 'string' && path.isAbsolute((v as Location).directory);
const archiveName = /^\d{13}-[\da-f-]{36}\.json$/i;
export interface ArchiveInfo { id: string; createdAt: string; title: string; messages: number }

// The fixed app-data directory holds the location pointer and encrypted credentials.
// Only chat state and archives follow the user's chosen directory.
export class ChatStorage {
  private stateStore: JsonStore<SavedState>;
  private locationStore: JsonStore<Location>;
  private queue: Promise<void> = Promise.resolve();
  private needsPointer = false;
  locationRecovered = false;
  private constructor(readonly baseDirectory: string, public directory: string) {
    this.stateStore = new JsonStore(path.join(directory, 'state.json'), isState);
    this.locationStore = new JsonStore(path.join(baseDirectory, 'storage-location.json'), isLocation);
  }
  static async open(baseDirectory: string, defaultDirectory = baseDirectory): Promise<ChatStorage> {
    const pointer = await new JsonStore(path.join(baseDirectory, 'storage-location.json'), isLocation)
      .load(() => ({ version: 1, directory: baseDirectory }));
    let directory = pointer.value.directory;
    if (path.resolve(directory) === path.resolve(baseDirectory) && path.resolve(defaultDirectory) !== path.resolve(baseDirectory)) {
      const legacy = new ChatStorage(baseDirectory, baseDirectory);
      const legacyFiles = await readdir(baseDirectory).catch((error: NodeJS.ErrnoException): string[] => { if (error.code === 'ENOENT') return []; throw error; });
      if (legacyFiles.includes('state.json') || legacyFiles.includes('state.json.bak')) {
        const loaded = await legacy.load();
        await legacy.relocate(defaultDirectory, loaded.value);
        return legacy;
      }
      directory = defaultDirectory;
    }
    const storage = new ChatStorage(baseDirectory, directory);
    storage.needsPointer = path.resolve(directory) !== path.resolve(pointer.value.directory);
    storage.locationRecovered = pointer.recovered;
    // A missing external drive must not silently create an empty conversation.
    if (path.resolve(storage.directory) !== path.resolve(baseDirectory) && path.resolve(storage.directory) !== path.resolve(defaultDirectory)) {
      await stat(storage.directory);
      const files = await readdir(storage.directory);
      if (!files.includes('state.json') && !files.includes('state.json.bak')) throw new Error('聊天存储目录缺少数据，已停止启动以保留原文件。');
    }
    return storage;
  }
  async load(): ReturnType<JsonStore<SavedState>['load']> {
    const loaded = await this.stateStore.load(initialState);
    // Older versions always captured on expansion. New installations opt in.
    loaded.value.settings.screenCaptureEnabled ??= true;
    return loaded;
  }
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.catch(() => {}).then(operation); this.queue = next; return next;
  }
  save(state: SavedState): Promise<void> {
    const snapshot = structuredClone(state);
    return this.enqueue(async () => {
      await this.stateStore.save(snapshot);
      if (this.needsPointer) { await this.locationStore.save({ version: 1, directory: this.directory }); this.needsPointer = false; }
    });
  }
  async flush(): Promise<void> { await this.queue; await this.stateStore.flush(); }
  get archiveDirectory(): string { return path.join(this.directory, 'sessions'); }
  async archive(state: SavedState): Promise<string> {
    const id = `${Date.now()}-${randomUUID()}.json`;
    await new JsonStore(path.join(this.archiveDirectory, id), isState).save(state);
    return id;
  }
  async list(source?: string): Promise<{ items: ArchiveInfo[]; unreadable: number; unclassified?: number }> {
    await mkdir(this.archiveDirectory, { recursive: true });
    const entries = await readdir(this.archiveDirectory, { withFileTypes: true });
    const items: ArchiveInfo[] = []; let unreadable = 0, unclassified = 0;
    for (const entry of entries.filter(e => e.isFile() && archiveName.test(e.name)).sort((a, b) => b.name.localeCompare(a.name))) {
      try {
        const session = await this.readArchive(entry.name);
        if (source !== undefined && session.source !== source) { if (!session.source) unclassified++; continue; }
        items.push({ id: entry.name, createdAt: session.createdAt,
          title: session.messages.find(m => m.role === 'user')?.content.slice(0, 60) || session.draft.slice(0, 60) || '空白对话', messages: session.messages.length });
      } catch { unreadable++; }
    }
    return { items, unreadable, ...(source !== undefined ? { unclassified } : {}) };
  }
  async readArchive(id: unknown, source?: string): Promise<Session> {
    if (typeof id !== 'string' || !archiveName.test(id)) throw new Error('无效的归档标识。');
    const file = path.join(this.archiveDirectory, id);
    // Never follow a link outside the selected chat directory.
    if (path.dirname(await realpath(file)) !== await realpath(this.archiveDirectory)) throw new Error('归档路径无效。');
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!isState(value)) throw new Error('归档无法读取，原文件已保留。');
    const recorded = recordedSource(value.session, value.settings);
    if (source !== undefined && recorded !== source) throw new Error('这段对话不属于当前连接，已阻止混用。');
    return { ...value.session, ...(recorded ? { source: recorded } : {}) };
  }
  relocate(destination: string, state: SavedState): Promise<void> {
    const snapshot = structuredClone(state);
    return this.enqueue(() => this.relocateNow(destination, snapshot));
  }
  private async relocateNow(destination: string, state: SavedState): Promise<void> {
    if (!path.isAbsolute(destination)) throw new Error('请选择有效的存储目录。');
    await this.stateStore.save(state); await this.stateStore.flush();
    const source = await realpath(this.directory);
    await mkdir(destination, { recursive: true });
    const target = await realpath(destination);
    if (target.toLowerCase() === source.toLowerCase()) return;
    const relative = path.relative(source, target);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) throw new Error('请选择当前存储目录之外的空文件夹。');
    if ((await readdir(target)).length) throw new Error('目标文件夹必须为空，避免覆盖已有文件。');
    const copyVerified = async (from: string, to: string): Promise<void> => {
      await copyFile(from, to, constants.COPYFILE_EXCL);
      if (!(await readFile(from)).equals(await readFile(to))) throw new Error('复制校验失败，仍使用原存储目录。');
    };
    const files = await readdir(source);
    for (const name of ['state.json', 'state.json.bak']) if (files.includes(name)) await copyVerified(path.join(source, name), path.join(target, name));
    if (files.includes('sessions')) {
      const archiveSource = this.archiveDirectory;
      if (path.dirname(await realpath(archiveSource)) !== source) throw new Error('归档目录路径无效。');
      await mkdir(path.join(target, 'sessions'));
      for (const entry of await readdir(archiveSource, { withFileTypes: true })) {
        if (!entry.isFile()) throw new Error('归档目录含有非普通文件，仍使用原目录。');
        await copyVerified(path.join(archiveSource, entry.name), path.join(target, 'sessions', entry.name));
      }
    }
    // Keep originals for Codex history references, and copy durable image assets.
    if (files.includes('attachments')) {
      const sourceAttachments = path.join(source, 'attachments');
      if (path.dirname(await realpath(sourceAttachments)) !== source) throw new Error('图片目录路径无效。');
      await mkdir(path.join(target, 'attachments'));
      for (const entry of await readdir(sourceAttachments, { withFileTypes: true })) {
        if (!entry.isFile()) throw new Error('图片目录含有非普通文件，仍使用原目录。');
        if (path.dirname(await realpath(path.join(sourceAttachments, entry.name))) !== await realpath(sourceAttachments)) throw new Error('图片路径无效。');
        await copyVerified(path.join(sourceAttachments, entry.name), path.join(target, 'attachments', entry.name));
      }
    }
    await new JsonStore(path.join(target, 'state.json'), isState).load(() => { throw new Error('目标数据缺失。'); });
    await this.locationStore.save({ version: 1, directory: target });
    this.directory = target;
    this.needsPointer = false;
    this.stateStore = new JsonStore(path.join(target, 'state.json'), isState);
  }
}
