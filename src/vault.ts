import { safeStorage } from 'electron';
import { JsonStore } from './storage';
interface Secret { encrypted: string; endpoint: string }
export class Vault {
  value = '';
  endpoint = '';
  warning = '';
  private store: JsonStore<Secret>;
  constructor(file: string) {
    this.store = new JsonStore(file, (v): v is Secret => !!v && typeof v === 'object' && typeof (v as Secret).encrypted === 'string' && typeof (v as Secret).endpoint === 'string');
  }
  async load(): Promise<void> {
    const saved = await this.store.load(() => ({ encrypted: '', endpoint: '' }));
    this.endpoint = saved.value.endpoint;
    if (!saved.value.encrypted) return;
    try {
      if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error();
      this.value = (await safeStorage.decryptStringAsync(Buffer.from(saved.value.encrypted, 'base64'))).result;
    } catch { this.warning = '已保存的密钥无法解密，请在设置中重新输入。'; }
  }
  forEndpoint(url: string): string { return this.endpoint === url ? this.value : ''; }
  async save(key: string, endpoint: string): Promise<void> {
    if (key && !await safeStorage.isAsyncEncryptionAvailable()) throw new Error('系统安全存储不可用，密钥未保存，请稍后重试。');
    const encrypted = key ? (await safeStorage.encryptStringAsync(key)).toString('base64') : '';
    await this.store.save({ encrypted, endpoint });
    this.value = key; this.endpoint = endpoint; this.warning = '';
  }
}
