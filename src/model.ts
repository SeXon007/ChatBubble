import { petDefaults, petFields, validPetField, isPetPosition, type PetOptions, type PetPosition } from './pet-state';
import type { ScreenAttachment } from './screen-capture';
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'complete' | 'generating' | 'failed' | 'cancelled' | 'interrupted';
  requestId: string;
  time: string;
  error?: string;
  previousAttempts?: { content: string; status: string; error?: string }[];
  codexTurnId?: string;
  image?: ScreenAttachment;
  notice?: string;
}
export interface Settings extends Partial<PetOptions> {
  provider?: 'api' | 'codex-cli' | 'claude-cli';
  cliPath?: string;
  cliModel?: string;
  reasoningEffort?: string;
  apiReasoningEffort?: string;
  contextBudget?: number;
  baseUrl: string;
  model: string;
  fontSize: number;
  lightText: boolean;
  textColor?: string;
  textShadow: boolean;
  screenCaptureEnabled?: boolean; // Legacy setting, retained for file compatibility; capture is now manual.
  captureScope?: 'window' | 'screen';
}
export interface CodexSession { threadId: string; home: string; cwd: string; lastTurnId?: string; lastUserMessageId?: string }
export interface Session { id: string; createdAt: string; draft: string; messages: ChatMessage[]; codex?: CodexSession; source?: string }
export const isCodexId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
export interface SavedState {
  version: 1;
  session: Session;
  settings: Settings;
  bounds?: { x: number; y: number; width: number; height: number };
  petPosition?: PetPosition;
}
export function newSession(source?: string): Session {
  return { id: crypto.randomUUID(), createdAt: new Date().toISOString(), draft: '', messages: [], ...(source ? { source } : {}) };
}
export function initialState(): SavedState {
  return { version: 1, session: newSession(), settings: { provider: 'api', cliPath: '', cliModel: '', baseUrl: '', model: '', fontSize: 14, lightText: false, textShadow: false, screenCaptureEnabled: false, captureScope: 'window', ...petDefaults } };
}
export function isState(value: unknown): value is SavedState {
  if (!value || typeof value !== 'object') return false;
  const s = value as SavedState;
  return s.version === 1 && !!s.session && typeof s.session.id === 'string' &&
    typeof s.session.createdAt === 'string' && typeof s.session.draft === 'string' &&
    (s.session.source === undefined || (typeof s.session.source === 'string' && s.session.source.length > 0 && s.session.source.length <= 8192 && !/[\r\n\0]/.test(s.session.source))) &&
    (s.session.codex === undefined || (!!s.session.codex && isCodexId(s.session.codex.threadId) &&
      typeof s.session.codex.home === 'string' && typeof s.session.codex.cwd === 'string' &&
      (s.session.codex.lastTurnId === undefined || isCodexId(s.session.codex.lastTurnId)) &&
      (s.session.codex.lastUserMessageId === undefined || isCodexId(s.session.codex.lastUserMessageId)))) &&
    Array.isArray(s.session.messages) && s.session.messages.every(m =>
      m && typeof m.id === 'string' && typeof m.requestId === 'string' && typeof m.time === 'string' &&
      ['user', 'assistant'].includes(m.role) && typeof m.content === 'string' &&
      ['complete', 'generating', 'failed', 'cancelled', 'interrupted'].includes(m.status) &&
      (m.error === undefined || typeof m.error === 'string') &&
      (m.notice === undefined || typeof m.notice === 'string') &&
      (m.image === undefined || (!!m.image && typeof m.image.file === 'string' && typeof m.image.capturedAt === 'string')) &&
      (m.codexTurnId === undefined || isCodexId(m.codexTurnId)) &&
      (m.previousAttempts === undefined || (Array.isArray(m.previousAttempts) && m.previousAttempts.every(a => a && typeof a.content === 'string' && typeof a.status === 'string' && (a.error === undefined || typeof a.error === 'string'))))) &&
    !!s.settings && typeof s.settings.baseUrl === 'string' && typeof s.settings.model === 'string' &&
    (s.settings.provider === undefined || ['api', 'codex-cli', 'claude-cli'].includes(s.settings.provider)) &&
    (s.settings.cliPath === undefined || typeof s.settings.cliPath === 'string') &&
    (s.settings.cliModel === undefined || typeof s.settings.cliModel === 'string') &&
    (s.settings.reasoningEffort === undefined || (typeof s.settings.reasoningEffort === 'string' && ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(s.settings.reasoningEffort))) &&
    (s.settings.contextBudget === undefined || [24000, 48000, 96000].includes(s.settings.contextBudget)) &&
    (s.settings.apiReasoningEffort === undefined || ['', 'none', 'low', 'high', 'max'].includes(s.settings.apiReasoningEffort)) &&
    (s.settings.screenCaptureEnabled === undefined || typeof s.settings.screenCaptureEnabled === 'boolean') &&
    (s.settings.captureScope === undefined || ['window', 'screen'].includes(s.settings.captureScope)) &&
    (s.settings.textColor === undefined || (typeof s.settings.textColor === 'string' && /^#[0-9a-f]{6}$/i.test(s.settings.textColor))) &&
    petFields.every(key => s.settings[key] === undefined || validPetField(key, s.settings[key])) &&
    (s.petPosition === undefined || isPetPosition(s.petPosition)) &&
    Number.isFinite(s.settings.fontSize) && s.settings.fontSize >= 12 && s.settings.fontSize <= 20 &&
    typeof s.settings.lightText === 'boolean' && typeof s.settings.textShadow === 'boolean' &&
    (s.bounds === undefined || ['x', 'y', 'width', 'height'].every(k => Number.isFinite(s.bounds![k as keyof typeof s.bounds])));
}
