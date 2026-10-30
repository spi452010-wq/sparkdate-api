import { StorageProvider, isValidKey } from './index';

/** In-memory storage for tests. absolutePath returns a pseudo path (not servable). */
export class MemoryStorage implements StorageProvider {
  files = new Map<string, Buffer>();
  async put(key: string, data: Buffer) { if (!isValidKey(key)) throw new Error('bad key'); this.files.set(key, data); }
  async delete(key: string) { this.files.delete(key); }
  absolutePath(key: string) { if (!isValidKey(key)) throw new Error('bad key'); return `/memory/${key}`; }
}
