import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const reasoningEfforts = ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export interface CliModel { id: string; name: string; efforts: string[]; defaultEffort: string; contextWindow?: number }
export interface ModelCatalog { models: CliModel[]; source: string; fetchedAt: string }
export function parseModelCatalog(value: unknown): CliModel[] {
  const entries = (value as { models?: unknown[] } | null)?.models;
  if (!Array.isArray(entries)) return [];
  const models: CliModel[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') continue;
    const m = raw as Record<string, any>;
    if (typeof m.slug !== 'string' || m.slug.length > 200 || m.visibility === 'hide') continue;
    const efforts: string[] = Array.isArray(m.supported_reasoning_levels)
      ? m.supported_reasoning_levels.map((level: any) => level?.effort).filter((e: unknown) => typeof e === 'string' && !!e && reasoningEfforts.includes(e)) : [];
    models.push({ id: m.slug, name: typeof m.display_name === 'string' ? m.display_name.slice(0, 100) : m.slug,
      efforts: [...new Set(efforts)], defaultEffort: efforts.includes(m.default_reasoning_level) ? m.default_reasoning_level : '',
      contextWindow: Number.isSafeInteger(m.context_window) && m.context_window > 0 ? m.context_window : undefined });
  }
  return models;
}
export async function readModelCatalog(): Promise<ModelCatalog> {
  try {
    const file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'models_cache.json');
    const value = JSON.parse(await readFile(file, 'utf8'));
    return { models: parseModelCatalog(value), source: 'Codex 本机模型缓存；账户可用性以连接检查为准',
      fetchedAt: typeof value.fetched_at === 'string' ? value.fetched_at : '' };
  } catch { return { models: [], source: '未找到可用的本机模型缓存，可手动填写模型名称', fetchedAt: '' }; }
}
