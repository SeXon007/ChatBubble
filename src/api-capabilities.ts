import type { Settings } from './model';

// Verified vendor contracts, 2026-10-26. Unknown endpoints/models use defaults.
export const apiEfforts: Record<string, Record<string, string[]>> = {
  deepseek: Object.fromEntries(['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].map(id => [id, ['none', 'low', 'high', 'max']])),
  kimi: Object.fromEntries(['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed', 'kimi-k3'].map(id => [id, ['low', 'high', 'max']])),
  zhipu: Object.fromEntries(['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx'].map(id => [id, ['low', 'high', 'max']]))
};
export function apiVendor(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl), address = url.origin + url.pathname.replace(/\/chat\/completions\/?$/, '').replace(/\/+$/, '');
    return ({ 'https://api.deepseek.com': 'deepseek', 'https://api.deepseek.com/v1': 'deepseek',
      'https://api.moonshot.cn/v1': 'kimi', 'https://open.bigmodel.cn/api/paas/v4': 'zhipu' } as Record<string, string>)[address];
  } catch { return undefined; }
}
export function apiReasoningParameters(baseUrl: string, model: string, effort?: string): Record<string, unknown> {
  if (!effort) return {};
  const vendor = apiVendor(baseUrl);
  if (!vendor || !apiEfforts[vendor]?.[model]?.includes(effort)) throw new Error('该 API 模型不支持已选思考强度，请改为模型默认。');
  if (vendor === 'kimi') return { reasoning_effort: effort };
  return effort === 'none' ? { thinking: { type: 'disabled' } } : { thinking: { type: 'enabled' }, reasoning_effort: effort };
}

// Official vision contracts verified 2026-10-27; see findings.md. Do not infer
// vision from a provider name or silently switch the user's selected model.
const visionModels: Record<string, string[]> = {
  deepseek: ['deepseek-flash', 'deepseek-v4-flash-vision-exp'],
  kimi: ['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed', 'kimi-k3', 'kimi-k2.6', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed'],
  zhipu: ['glm-4.6v', 'glm-4.6v-flash', 'glm-4.6v-flashx']
};
export function captureCapability(settings: Pick<Settings, 'provider' | 'baseUrl' | 'model'>): { available: boolean; reason: string } {
  if (settings.provider === 'codex-cli') return { available: true, reason: '' };
  if (settings.provider && settings.provider !== 'api') return { available: false, reason: '当前连接暂不支持截图。' };
  if (!settings.baseUrl || !settings.model) return { available: false, reason: '请先配置 API 服务和支持识图的模型。' };
  const vendor = apiVendor(settings.baseUrl);
  if (vendor && !visionModels[vendor]?.includes(settings.model)) return { available: false,
    reason: '当前 API 模型未确认支持图片，请选择识图模型：' + visionModels[vendor]![0] + '。' };
  return { available: true, reason: vendor ? '' : '自定义 API 需支持 image_url 图片输入；实际能力以服务端为准。' };
}
