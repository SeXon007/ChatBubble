import { endpoint } from './provider';
import { apiEfforts } from './api-capabilities';

export interface ApiPreset { id: string; name: string; baseUrl: string; models: string[]; names?: Record<string, string>; efforts?: Record<string, string[]>; listModels: boolean; aliases?: string[] }
export interface ApiModelCatalog { baseUrl: string; models: string[]; names?: Record<string, string>; source: 'service' | 'preset' | 'none'; error: string }
// Official endpoints and common candidates verified on 2026-10-26; see findings.md.
// Candidates are not an assertion that the current API key has model access.
export const apiPresets: ApiPreset[] = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', aliases: ['https://api.deepseek.com/v1'], models: ['deepseek-flash', 'deepseek-v4-pro'], names: { 'deepseek-flash': 'DeepSeek-V4.1-Flash-1017', 'deepseek-v4-pro': 'DeepSeek-V4-Pro-0813' }, listModels: true },
  { id: 'kimi', name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', models: ['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed', 'kimi-k3'], names: { 'kimi-k3.1-pro': 'Kimi K3.1 Pro', 'kimi-k3.1-pro-highspeed': 'Kimi K3.1 Pro Highspeed', 'kimi-k3': 'Kimi K3' }, listModels: true },
  { id: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-5.3-flashx', 'glm-5.3-flash', 'glm-4.6v-flash', 'glm-5.3', 'glm-4.7-flash'], names: { 'glm-5.3-flashx': 'GLM-5.3-FlashX', 'glm-5.3-flash': 'GLM-5.3-Flash', 'glm-4.6v-flash': 'GLM-4.6V-Flash（识图）', 'glm-5.3': 'GLM-5.3', 'glm-4.7-flash': 'GLM-4.7-Flash' }, listModels: false }
];
for (const preset of apiPresets) preset.efforts = apiEfforts[preset.id];
export function apiPresetForUrl(baseUrl: string): ApiPreset | undefined {
  const target = endpoint(baseUrl);
  return apiPresets.find(preset => [preset.baseUrl, ...(preset.aliases ?? [])].some(url => endpoint(url) === target));
}
export function modelsEndpoint(baseUrl: string): string { return endpoint(baseUrl).replace(/\/chat\/completions$/, '/models'); }

export function parseApiModels(value: unknown): string[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { data?: unknown }).data)) throw new Error('模型列表格式不兼容。');
  const result = new Set<string>();
  for (const item of (value as { data: unknown[] }).data.slice(0, 2000)) {
    if (!item || typeof item !== 'object') continue;
    const { id, output_modalities: modalities } = item as { id?: unknown; output_modalities?: unknown };
    if (Array.isArray(modalities) && !modalities.includes('text')) continue;
    if (typeof id === 'string' && id.length > 0 && id.length <= 200 && id === id.trim() && !/[\x00-\x20\x7f]/.test(id)) result.add(id);
  }
  if (!result.size) throw new Error('服务未返回可选模型，可手动填写。');
  return [...result];
}

export function apiModelMetadata(value: unknown, preset?: ApiPreset): { models: string[]; names: Record<string, string> } {
  const models = parseApiModels(value), names: Record<string, string> = Object.create(null), dates = new Map<string, number>();
  for (const item of (value as { data: Record<string, unknown>[] }).data.slice(0, 2000)) {
    if (!item || !models.includes(item.id as string)) continue;
    const id = item.id as string, name = item.name ?? item.display_name;
    if (typeof name === 'string' && name.trim() && name.length <= 200 && !/[\x00-\x1f\x7f]/.test(name)) names[id] = name.trim();
    const release = typeof item.released_at === 'string' ? Date.parse(item.released_at) / 1000 : item.released_at ?? item.created;
    if (typeof release === 'number' && Number.isFinite(release) && release > 0) dates.set(id, release);
  }
  // Prefer dated releases, then natural version order. Never replace a service's
  // display name with a baked-in name that could become stale after an upgrade.
  models.sort((a, b) => (dates.get(b) ?? 0) - (dates.get(a) ?? 0)
    || (names[b] || b).localeCompare(names[a] || a, 'en', { numeric: true }));
  if (preset?.id === 'deepseek') {
    const retired = new Set(['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']);
    const current = models.filter(id => !retired.has(id));
    if (current.length) models.splice(0, models.length, ...current);
  }
  return { models, names };
}

export async function listApiModels(options: { baseUrl: string; key: string; fetcher?: typeof fetch; timeoutMs?: number }): Promise<ApiModelCatalog> {
  const url = modelsEndpoint(options.baseUrl), preset = apiPresetForUrl(options.baseUrl);
  const fallback = (error = ''): ApiModelCatalog => ({ baseUrl: options.baseUrl, models: [...(preset?.models ?? [])], names: preset?.names, source: preset ? 'preset' : 'none', error });
  // No documented public model-list endpoint was found for this service. Use the
  // official common candidates rather than inventing a request or claiming access.
  if (preset && !preset.listModels) return fallback();
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
  if (!options.key && !local) return fallback('请先填写 API Key，仍可选择常用模型。');
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), options.timeoutMs ?? 8000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await (options.fetcher ?? fetch)(url, { method: 'GET', redirect: 'error', signal: abort.signal,
      headers: { Accept: 'application/json', ...(options.key ? { Authorization: `Bearer ${options.key}` } : {}) } });
    if (!response.ok) {
      await response.body?.cancel();
      return fallback(response.status === 401 || response.status === 403 ? '无法读取模型，请检查 API Key。' : '未能获取模型列表，可选择常用模型或手动填写。');
    }
    if (!response.body) return fallback('服务未返回模型列表，可手动填写。');
    reader = response.body.getReader();
    const decoder = new TextDecoder(); let data = '', bytes = 0;
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 1024 * 1024) return fallback('模型列表过大，可手动填写。');
      data += decoder.decode(part.value, { stream: true });
    }
    data += decoder.decode();
    return { baseUrl: options.baseUrl, ...apiModelMetadata(JSON.parse(data), preset), source: 'service', error: '' };
  } catch { return fallback(abort.signal.aborted ? '读取模型超时，可重试或手动填写。' : '未能获取模型列表，可选择常用模型或手动填写。'); }
  finally { clearTimeout(timer); await reader?.cancel().catch(() => {}); }
}
