import { isCodexId, newSession, type SavedState, type Session, type Settings } from './model';
import { apiVendor } from './api-capabilities';

// Models from one service share a conversation; different custom endpoints do not.
export function conversationSource(settings: Settings): string {
  if (settings.provider && settings.provider !== 'api') return settings.provider;
  const address = settings.baseUrl.trim(), vendor = apiVendor(address);
  if (vendor) return 'api:' + vendor;
  if (!address) return 'api:unconfigured';
  try {
    const url = new URL(address);
    return 'api:' + url.origin + url.pathname.replace(/\/chat\/completions\/?$/, '').replace(/\/+$/, '');
  } catch { return 'api:invalid:' + address; }
}

export const hasConversation = (session: Session): boolean => !!(session.messages.length || session.draft.length);

export function recordedSource(session: Session, settings: Settings): string | undefined {
  if (session.source) return session.source;
  if (!hasConversation(session)) return conversationSource(settings);
  // Legacy API transcripts may contain several providers. Never guess from the
  // last saved settings. Native turn IDs are the only reliable legacy evidence.
  if (settings.provider === 'codex-cli' && session.codex && session.messages.length &&
    session.messages.every(message => isCodexId(message.codexTurnId))) return 'codex-cli';
  return undefined;
}

export async function prepareConversation(state: SavedState, archive: (snapshot: SavedState) => Promise<unknown>, save: () => Promise<void>): Promise<string> {
  const previousSettings = state.settings, previousSession = state.session;
  const source = recordedSource(previousSession, previousSettings);
  const removed = previousSettings.provider === 'claude-cli';
  const nextSettings: Settings = removed ? { ...previousSettings, provider: 'api', cliPath: '', cliModel: '', reasoningEffort: '' } : previousSettings;
  const nextSource = conversationSource(nextSettings);
  const separate = source !== nextSource;
  if (!removed && !separate && previousSession.source === source) return '';
  if (separate && hasConversation(previousSession)) await archive({ ...state, session: { ...previousSession, ...(source ? { source } : {}) } });
  state.settings = nextSettings;
  state.session = separate ? newSession(nextSource) : { ...previousSession, source: nextSource };
  try { await save(); }
  catch (error) { state.settings = previousSettings; state.session = previousSession; throw error; }
  return removed ? 'Claude CLI 已移除，旧对话文件已保留，请选择 Codex CLI 或 API 服务。'
    : separate && hasConversation(previousSession) ? '旧对话来源无法确认或与当前连接不同，已保留归档并新开对话，避免混用。' : '';
}
