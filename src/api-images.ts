import path from 'node:path';
import { lstat, readFile, realpath } from 'node:fs/promises';
import type { Settings } from './model';
import type { ScreenAttachment } from './screen-capture';
import { apiVendor, captureCapability } from './api-capabilities';

export interface ContextMessage { role: string; content: string; image?: ScreenAttachment }
type WireMessage = { role: string; content: string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[] };
const maxImageBytes = 16_000_000, maxTotalBytes = 24_000_000;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function readScreenshot(image: ScreenAttachment, directory: string | undefined, signal: AbortSignal, remaining: number): Promise<Buffer> {
  // Read only the captured asset in the current attachments directory. Resolving
  // by basename also keeps copied attachments usable after a storage migration.
  if (!directory || !path.isAbsolute(image.file) || path.basename(path.dirname(image.file)) !== 'attachments' || path.extname(image.file).toLowerCase() !== '.png') throw Error('invalid attachment');
  if ((await lstat(directory)).isSymbolicLink()) throw Error('invalid directory');
  const file = path.join(directory, path.basename(image.file));
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > Math.min(maxImageBytes, remaining) || path.dirname(await realpath(file)) !== await realpath(directory)) throw Error('invalid attachment');
  const bytes = await readFile(file, { signal });
  if (bytes.length > maxImageBytes || bytes.length < 24 || !bytes.subarray(0, 8).equals(pngSignature)) throw Error('invalid PNG');
  return bytes;
}

export async function apiMessages(options: { settings: Settings; messages: ContextMessage[]; image?: ScreenAttachment; screenNotice?: string; attachmentDirectory?: string; signal: AbortSignal }): Promise<WireMessage[]> {
  const { settings, image, signal } = options, capability = captureCapability(settings);
  if (image && !capability.available) throw new Error(capability.reason);
  const result: WireMessage[] = options.messages.map(message => ({ role: message.role, content: message.content }));
  let total = 0, images = 0;
  // Newest first reserves space for the current image. Older omitted/missing
  // assets stay explicit in the prompt; do not block an otherwise valid chat.
  for (let i = result.length - 1; i >= 0; i--) {
    const original = options.messages[i]!, message = result[i]!;
    if (original.role !== 'user') continue;
    const current = i === result.length - 1;
    const attachment = current ? image ?? original.image : original.image;
    if (!attachment) {
      if (current && options.screenNotice) message.content += '\n[本轮截图失败，未附带新画面。]';
      continue;
    }
    try {
      if (!capability.available) throw Error('text only model');
      if (images >= 8) throw Error('image count exceeded');
      const bytes = await readScreenshot(attachment, options.attachmentDirectory, signal, maxTotalBytes - total);
      if (total + bytes.length > maxTotalBytes) throw Error('image budget exceeded');
      total += bytes.length;
      images++;
      const data = bytes.toString('base64');
      message.content = [{ type: 'text', text: original.content + (current ? '\n[本轮附带的截图。]' : '\n[历史截图，仅用于回顾，不代表当前画面。]') },
        { type: 'image_url', image_url: { url: apiVendor(settings.baseUrl) === 'zhipu' ? data : 'data:image/png;base64,' + data } }];
    } catch {
      if (signal.aborted) throw new Error('已停止生成。');
      if (current) throw new Error('本次截图无法发送：图片丢失、格式不正确或超过 16 MB。请重新截图，或移除本次截图后发送文字。');
      message.content += '\n[历史截图本轮未附带：文件不可用、模型不支持或已超出图片预算。不得猜测原图内容。]';
    }
  }
  return result;
}
