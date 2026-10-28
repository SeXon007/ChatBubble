import { newSession, type SavedState, type Settings } from './model';
import { conversationSource, recordedSource, hasConversation } from './conversation-source';
import { endpoint } from './provider';
import { inspectCli } from './cli';
import { readModelCatalog, reasoningEfforts } from './cli-models';
import { petFields, validPetField, type PetOptions } from './pet-state';
import { apiReasoningParameters } from './api-capabilities';

const fields = ['provider', 'cliPath', 'cliModel', 'reasoningEffort', 'apiReasoningEffort', 'baseUrl', 'model', 'fontSize', 'messageHeight', 'lightText', 'textColor', 'textShadow', 'screenCaptureEnabled', 'captureScope', ...petFields] as const;
export type SettingsField = typeof fields[number];
export type SettingsPatch = Partial<Pick<Settings, SettingsField>>;

export function mergeSettings(current: Settings, raw: unknown): Settings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('设置格式不正确。');
  const patch = raw as Record<string, unknown>;
  const keys = Object.keys(patch);
  if (!keys.length || keys.some(key => !fields.includes(key as SettingsField))) throw new Error('设置字段不正确。');
  const next = { ...current };
  for (const key of keys as SettingsField[]) {
    const value = patch[key];
    if (petFields.includes(key as keyof PetOptions)) {
      if (!validPetField(key as keyof PetOptions, value)) throw new Error('桌宠设置不正确。');
    } else if (key === 'textColor') {
      if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error('请选择有效的字体颜色。');
    } else if (key === 'captureScope') {
      if (value !== 'window' && value !== 'screen') throw new Error('请选择有效的截图范围。');
    } else if (key === 'provider') {
      if (!['api', 'codex-cli'].includes(value as string)) throw new Error('请选择 Codex CLI 或 API 服务。');
    } else if (key === 'fontSize') {
      if (![12, 14, 16, 18, 20].includes(value as number)) throw new Error('字号不正确。');
    } else if (key === 'messageHeight') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 120 || value > 800) throw new Error('消息区高度应为 120–800px 的整数。');
    } else if (key === 'lightText' || key === 'textShadow' || key === 'screenCaptureEnabled') {
      if (typeof value !== 'boolean') throw new Error('显示设置不正确。');
    } else if (typeof value !== 'string' || /[\r\n\0]/.test(value) || value.length > (key === 'cliPath' || key === 'baseUrl' ? 4096 : 200)) throw new Error('设置内容不正确。');
    Object.assign(next, { [key]: typeof value === 'string' ? value.trim() : value });
  }
  if (!reasoningEfforts.includes(next.reasoningEffort ?? '')) throw new Error('推理强度不正确。');
  if ((next.baseUrl !== current.baseUrl || next.model !== current.model) && !('apiReasoningEffort' in patch)) next.apiReasoningEffort = '';
  if ('apiReasoningEffort' in patch) apiReasoningParameters(next.baseUrl, next.model, next.apiReasoningEffort);
  if ('baseUrl' in patch) {
    if (!next.baseUrl && current.baseUrl) throw new Error('服务地址不能为空。');
    if (next.baseUrl) endpoint(next.baseUrl);
  }
  const providerChanged = (next.provider ?? 'api') !== (current.provider ?? 'api');
  if ('cliPath' in patch && !next.cliPath && current.cliPath && !providerChanged) throw new Error('程序路径不能为空。');
  if ('model' in patch && !next.model && current.model && !providerChanged && next.baseUrl === current.baseUrl) throw new Error('模型名称不能为空。');
  return next;
}

// Validate only the changed connection fields. An unconfigured connection must not block font changes.
export async function persistSettingsPatch(state: SavedState, raw: unknown, save: () => Promise<void>,
  deps = { inspectCli, readModelCatalog }, archive?: (snapshot: SavedState) => Promise<unknown>): Promise<void> {
  const previous = state.settings, next = mergeSettings(previous, raw);
  const patch = raw as SettingsPatch;
  if (next.provider && next.provider !== 'api' && next.cliPath && ('cliPath' in patch || 'provider' in patch)) {
    const candidate = await deps.inspectCli(next.provider, next.cliPath);
    if (!candidate.usable) throw new Error(candidate.error);
  }
  if (next.provider === 'codex-cli' && next.cliModel && next.reasoningEffort && ('cliModel' in patch || 'reasoningEffort' in patch || 'provider' in patch)) {
    const model = (await deps.readModelCatalog()).models.find(m => m.id === next.cliModel);
    if (model?.efforts.length && !model.efforts.includes(next.reasoningEffort)) throw new Error('该模型不支持此推理强度。');
  }
  const previousSession = state.session, nextSource = conversationSource(next);
  const switched = conversationSource(previous) !== nextSource;
  if (switched && hasConversation(previousSession)) {
    if (!archive) throw new Error('无法归档当前对话，连接未切换。');
    const source = recordedSource(previousSession, previous);
    await archive({ ...state, session: { ...previousSession, ...(source ? { source } : {}) } });
  }
  state.settings = next;
  if (switched) state.session = newSession(nextSource);
  try { await save(); } catch (error) { state.settings = previous; state.session = previousSession; throw error; }
}
