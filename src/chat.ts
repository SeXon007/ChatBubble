import { randomUUID } from 'node:crypto';
import type { SavedState, ChatMessage } from './model';
import { context, streamChat, endpoint } from './provider';
import type { JsonStore } from './storage';
import type { CaptureResult } from './screen-capture';
import type { NativeHistoryTurn } from './codex';
import { conversationSource, recordedSource } from './conversation-source';
import { captureCapability } from './api-capabilities';
import type { ContextMessage } from './api-images';

export class ChatController {
  private active?: { id: string; abort: AbortController; task: Promise<void> };
  warning = '';
  constructor(readonly state: SavedState, private store: Pick<JsonStore<SavedState>, 'save'>, private key: () => string,
    private changed: () => void, private fetcher?: typeof fetch, private generate: typeof streamChat = streamChat,
    private takeScreen?: () => Promise<CaptureResult>) {}
  get busy(): boolean { return !!this.active; }
  private insertHistory(turns: NativeHistoryTurn[], before?: ChatMessage): void {
    const session = this.state.session, imported: ChatMessage[] = [];
    for (const turn of turns) {
      if (session.messages.some(message => message.codexTurnId === turn.id)) continue;
      const requestId = randomUUID(), time = new Date().toISOString();
      imported.push({ id: randomUUID(), role: 'user', content: turn.user, status: 'complete', requestId, time, codexTurnId: turn.id });
      imported.push({ id: randomUUID(), role: 'assistant', content: turn.assistant, status: turn.status === 'completed' ? 'complete' : 'interrupted', requestId, time, codexTurnId: turn.id,
        ...(turn.status === 'completed' ? {} : { error: '此轮在桌面端未完整结束。' }) });
    }
    session.messages.splice(before ? session.messages.indexOf(before) : session.messages.length, 0, ...imported);
  }
  async synchronize(read: () => Promise<NativeHistoryTurn[]>): Promise<void> {
    if (this.busy || !this.state.session.codex) return;
    const session = this.state.session, binding = session.codex!, previousTurn = binding.lastTurnId;
    const turns = await read();
    if (!turns.length || this.busy || this.state.session !== session || session.codex !== binding || binding.lastTurnId !== previousTurn) return;
    this.insertHistory(turns); binding.lastTurnId = turns.at(-1)!.id; binding.lastUserMessageId = undefined;
    await this.persist(); this.changed();
  }
  async persist(): Promise<void> {
    try { await this.store.save(this.state); const hadWarning = !!this.warning; this.warning = ''; if (hadWarning) this.changed(); }
    catch { this.warning = '本地保存失败，当前内容尚未保存。请检查磁盘空间和目录权限。'; this.changed(); throw new Error(this.warning); }
  }
  saveSoon(): void { void this.persist().catch(() => {}); }
  async send(text: unknown, retry = false): Promise<{ ok: boolean; error: string }> {
    if (this.active) return { ok: false, error: '请等待当前回复结束或先停止生成。' };
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: '请输入消息。' };
    if (this.state.settings.provider === 'claude-cli') return { ok: false, error: 'Claude CLI 已移除，请选择 Codex CLI 或 API 服务。' };
    const source = conversationSource(this.state.settings);
    if (recordedSource(this.state.session, this.state.settings) !== source) return { ok: false, error: '当前对话不属于此连接或来源未确认，请开始新对话。' };
    const cli = this.state.settings.provider && this.state.settings.provider !== 'api';
    const nativeCodex = this.state.settings.provider === 'codex-cli';
    if (cli ? !this.state.settings.cliPath : (!this.state.settings.baseUrl || !this.state.settings.model)) return { ok: false, error: '尚未接入模型，请在托盘菜单的设置中配置服务。输入已保留。' };
    let messages: ContextMessage[];
    let previous: ChatMessage | undefined;
    const id = randomUUID();
    const abort = new AbortController();
    // Reserve before the first await: concurrent IPC sends must not both start.
    this.active = { id, abort, task: Promise.resolve() };
    try {
      if (!cli) endpoint(this.state.settings.baseUrl);
      if (retry) {
        const last = this.state.session.messages.at(-1);
        const user = this.state.session.messages.at(-2);
        if (!last || last.role !== 'assistant' || !['failed', 'cancelled', 'interrupted'].includes(last.status) || !user || user.role !== 'user') throw new Error('当前没有可以重试的回答。');
        previous = last; text = user.content;
        messages = nativeCodex ? [{ role: 'user', content: text as string }] : context(this.state.session.messages.slice(0, -2), text as string, this.state.settings.contextBudget);
      } else messages = nativeCodex ? [{ role: 'user', content: text }] : context(this.state.session.messages, text, this.state.settings.contextBudget);
      if (nativeCodex && (text as string).length > 200000) throw new Error('本次输入超过本地输入上限，请缩短后发送。');
    } catch (error) { this.active = undefined; return { ok: false, error: (error as Error).message }; }
    const assistant: ChatMessage = { id: randomUUID(), role: 'assistant', content: '', status: 'generating', requestId: id, time: new Date().toISOString() };
    this.state.session.source = source;
    if (previous) {
      assistant.codexTurnId = previous.codexTurnId;
      assistant.previousAttempts = [...(previous.previousAttempts ?? []), { content: previous.content, status: previous.status, error: previous.error }];
      this.state.session.messages.pop();
      this.state.session.messages.at(-1)!.requestId = id;
    } else {
      this.state.session.messages.push({ id: randomUUID(), role: 'user', content: text as string, status: 'complete', requestId: id, time: new Date().toISOString() });
      this.state.session.draft = '';
    }
    this.state.session.messages.push(assistant);
    this.changed();
    const task = this.run(id, abort, assistant, messages, retry);
    this.active.task = task;
    return { ok: true, error: '' };
  }
  private async run(id: string, abort: AbortController, assistant: ChatMessage, messages: ContextMessage[], retry: boolean): Promise<void> {
    let lastSave = Date.now();
    const session = this.state.session;
    try {
      const user = session.messages.at(-2)!;
      if (!retry && captureCapability(this.state.settings).available && this.takeScreen) {
        const screen = await this.takeScreen();
        if (screen.image) user.image = screen.image;
        if (screen.error) user.notice = screen.error;
        this.changed();
      }
      if (abort.signal.aborted) throw new Error('已停止生成。');
      await this.persist(); // Don't initiate a paid request unless the user message is durable.
      await this.generate({ settings: { ...this.state.settings }, key: this.key(), messages, signal: abort.signal, fetcher: this.fetcher,
        ...(this.state.settings.provider === 'codex-cli' ? { codex: {
          session: session.codex, userMessageId: user.id, retry, retryTurnId: assistant.codexTurnId,
          onSession: async binding => { session.codex = binding; await this.persist(); this.changed(); },
          onTurn: async turnId => { assistant.codexTurnId = turnId; user.codexTurnId = turnId; await this.persist(); },
          onHistory: async turns => {
            this.insertHistory(turns, user);
            await this.persist(); this.changed();
          }
        } } : {}),
        ...(user.image ? { image: user.image } : {}),
        ...(user.notice ? { screenNotice: user.notice } : {}),
        onChunk: chunk => {
          if (this.active?.id !== id || abort.signal.aborted) return;
          assistant.content += chunk; this.changed();
          if (Date.now() - lastSave > 1000) { lastSave = Date.now(); this.saveSoon(); }
        } });
      assistant.status = 'complete';
    } catch (error) {
      assistant.status = abort.signal.aborted ? 'cancelled' : 'failed';
      assistant.error = (error as Error).message;
    } finally {
      if (this.active?.id === id) this.active = undefined;
      await this.persist().catch(() => {}); this.changed();
    }
  }
  async stop(): Promise<void> {
    const active = this.active;
    active?.abort.abort();
    await active?.task;
  }
}
