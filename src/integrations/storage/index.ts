import fs from 'fs/promises';
import path from 'path';
import { env } from '../../config/env';

// Swap this for an S3/R2 provider later; callers only ever see keys.
export interface StorageProvider {
  put(key: string, data: Buffer): Promise<void>;
  delete(key: string): Promise<void>;
  absolutePath(key: string): string; // local only, for sendFile / X-Accel
}

const KEY_RE = /^(photos|selfies)\/[a-f0-9]{24}\/[0-9a-f-]{36}\.webp$/;
export const isValidKey = (k: string) => KEY_RE.test(k);

export class LocalStorage implements StorageProvider {
  constructor(private root = env.UPLOAD_DIR) {}
  absolutePath(key: string) {
    if (!isValidKey(key)) throw new Error('bad key');
    const sub = key.startsWith('photos/') ? 'public' : 'private';
    const p = path.resolve(this.root, sub, key);
    if (!p.startsWith(path.resolve(this.root) + path.sep)) throw new Error('path escape');
    return p;
  }
  async put(key: string, data: Buffer) {
    const p = this.absolutePath(key);
    await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o750 });
    await fs.writeFile(p, data, { mode: 0o640, flag: 'wx' });
  }
  async delete(key: string) { await fs.rm(this.absolutePath(key), { force: true }); }
}
export let storage: StorageProvider = new LocalStorage();
export const setStorage = (s: StorageProvider) => { storage = s; };
