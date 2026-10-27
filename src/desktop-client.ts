import path from 'node:path';
import { stat } from 'node:fs/promises';
import type { Settings } from './model';
import { apiVendor } from './api-capabilities';

const clients = {
  deepseek: { name: 'DeepSeek Harness', executable: 'DeepSeek Harness.exe' },
  kimi: { name: 'Kimi', executable: 'Kimi.exe' },
  zhipu: { name: 'ZCode', executable: 'ZCode.exe' }
} as const;
export type DesktopClientId = keyof typeof clients;
export interface DesktopClientStatus { baseUrl: string; name: string; available: boolean; notice: string }
export function apiDesktopClient(settings: Pick<Settings, 'provider' | 'baseUrl'>): DesktopClientId | undefined {
  if ((settings.provider ?? 'api') !== 'api') return undefined;
  const vendor = apiVendor(settings.baseUrl);
  return vendor && Object.hasOwn(clients, vendor) ? vendor as DesktopClientId : undefined;
}
export const desktopClientName = (id: DesktopClientId): string => clients[id].name;
export const clientNotFound = (id: DesktopClientId): string => `未检测到可用的 ${clients[id].name} 客户端。请先安装，或检查桌面、开始菜单中的快捷方式。`;
export const localApiHistoryNotice = '此 API 对话保存在 ChatBubble，暂不支持在对应客户端中查看。';

// Only inspect known application shortcuts. Shortcut arguments are deliberately
// ignored: launch the recognized executable itself, never a shell/script/link.
export async function locateDesktopClient(id: DesktopClientId, shortcutRoots: string[],
  readShortcut: (file: string) => { target: string }): Promise<string | undefined> {
  const client = clients[id];
  for (const root of shortcutRoots) {
    if (!path.isAbsolute(root)) continue;
    for (const relative of [`${client.name}.lnk`, path.join(client.name, `${client.name}.lnk`)]) {
      try {
        const { target } = readShortcut(path.join(root, relative));
        if (!path.isAbsolute(target) || path.basename(target).toLowerCase() !== client.executable.toLowerCase()) continue;
        if ((await stat(target)).isFile()) return target;
      } catch { /* Missing or stale shortcut: continue through the known roots. */ }
    }
  }
  return undefined;
}
