import { vfsError } from './error.js';
import { path } from './path.js';
import { Backend } from './backend.js';

class IDBBackend extends Backend {
  static type = 'idb';

  constructor(config) {
    super();
    this._dbName = (config && config.name) || 'gcu-vfs';
    this._db = null;
  }

  async init() {
    this._db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(this._dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('files')) {
          db.createObjectStore('files', { keyPath: 'path' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    // Ensure root directory exists
    const root = await this._get('/');
    if (!root) {
      const now = new Date();
      await this._put({
        path: '/', type: 'directory', content: null,
        size: 0, created: now, modified: now,
        mode: 0o755, owner: 'user', group: 'staff',
      });
    }
  }

  async destroy() {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  }

  _tx(mode) {
    const tx = this._db.transaction('files', mode);
    return tx.objectStore('files');
  }

  _get(p) {
    return new Promise((resolve, reject) => {
      const req = this._tx('readonly').get(p);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  _put(record) {
    return new Promise((resolve, reject) => {
      const req = this._tx('readwrite').put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  _del(p) {
    return new Promise((resolve, reject) => {
      const req = this._tx('readwrite').delete(p);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  _cursorRange(prefix) {
    // All paths that start with prefix
    const lower = prefix === '/' ? '/' : prefix + '/';
    const upper = prefix === '/' ? '/\uffff' : prefix + '/\uffff';
    return { lower, upper };
  }

  _scan(prefix) {
    return new Promise((resolve, reject) => {
      const store = this._tx('readonly');
      const { lower, upper } = this._cursorRange(prefix);
      const range = IDBKeyRange.bound(lower, upper, false, true);
      const results = [];
      const req = store.openCursor(range);
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async readFile(p, encoding) {
    const np = path.normalize(p);
    const rec = await this._get(np);
    if (!rec) throw vfsError('ENOENT', np);
    if (rec.type === 'directory') throw vfsError('EISDIR', np);
    if (encoding === 'bytes') {
      if (rec.content instanceof Uint8Array) return new Uint8Array(rec.content);
      return new TextEncoder().encode(rec.content || '');
    }
    if (rec.content instanceof Uint8Array) return new TextDecoder().decode(rec.content);
    return rec.content || '';
  }

  async writeFile(p, content) {
    const np = path.normalize(p);
    const parentPath = path.dirname(np);
    if (parentPath !== np) {
      const parent = await this._get(parentPath);
      if (!parent) throw vfsError('ENOENT', np);
      if (parent.type !== 'directory') throw vfsError('ENOTDIR', np);
    }
    const existing = await this._get(np);
    if (existing && existing.type === 'directory') throw vfsError('EISDIR', np);
    const now = new Date();
    const isBinary = content instanceof Uint8Array;
    const size = typeof content === 'string'
      ? new TextEncoder().encode(content).byteLength
      : (isBinary ? content.byteLength : 0);
    await this._put({
      path: np, type: 'file', content,
      size, created: existing ? existing.created : now, modified: now,
      mode: existing ? existing.mode : 0o644,
      owner: existing ? existing.owner : 'user',
      group: existing ? existing.group : 'staff',
      _binary: isBinary,
    });
  }

  async stat(p) {
    const np = path.normalize(p);
    const rec = await this._get(np);
    if (!rec) throw vfsError('ENOENT', np);
    return {
      type: rec.type,
      size: rec.size || 0,
      created: rec.created instanceof Date ? rec.created : new Date(rec.created),
      modified: rec.modified instanceof Date ? rec.modified : new Date(rec.modified),
      mode: rec.mode != null ? rec.mode : (rec.type === 'directory' ? 0o755 : 0o644),
      owner: rec.owner || 'user',
      group: rec.group || 'staff',
    };
  }

  async mkdir(p, opts) {
    const np = path.normalize(p);
    if (opts && opts.recursive) return this._mkdirRecursive(np);
    const parentPath = path.dirname(np);
    if (parentPath !== np) {
      const parent = await this._get(parentPath);
      if (!parent) throw vfsError('ENOENT', np);
    }
    const existing = await this._get(np);
    if (existing) throw vfsError('EEXIST', np);
    const now = new Date();
    await this._put({
      path: np, type: 'directory', content: null,
      size: 0, created: now, modified: now,
      mode: 0o755, owner: 'user', group: 'staff',
    });
  }

  async _mkdirRecursive(np) {
    const segs = np.split('/').filter(Boolean);
    let current = '';
    for (const seg of segs) {
      current += '/' + seg;
      const existing = await this._get(current);
      if (!existing) {
        const now = new Date();
        await this._put({
          path: current, type: 'directory', content: null,
          size: 0, created: now, modified: now,
          mode: 0o755, owner: 'user', group: 'staff',
        });
      }
    }
  }

  async readdir(p) {
    const np = path.normalize(p);
    const rec = await this._get(np);
    if (!rec) throw vfsError('ENOENT', np);
    if (rec.type !== 'directory') throw vfsError('ENOTDIR', np);

    const all = await this._scan(np);
    const prefix = np === '/' ? '/' : np + '/';
    const names = new Set();
    for (const entry of all) {
      const rel = entry.path.slice(prefix.length);
      if (!rel) continue;
      // Direct children only: no '/' in the remaining path
      const slashIdx = rel.indexOf('/');
      names.add(slashIdx === -1 ? rel : rel.slice(0, slashIdx));
    }
    return [...names].sort();
  }

  async rmdir(p) {
    const np = path.normalize(p);
    const rec = await this._get(np);
    if (!rec) throw vfsError('ENOENT', np);
    if (rec.type !== 'directory') throw vfsError('ENOTDIR', np);
    const children = await this.readdir(np);
    if (children.length > 0) throw vfsError('ENOTEMPTY', np);
    await this._del(np);
  }

  async unlink(p) {
    const np = path.normalize(p);
    const rec = await this._get(np);
    if (!rec) throw vfsError('ENOENT', np);
    if (rec.type === 'directory') throw vfsError('EISDIR', np);
    await this._del(np);
  }

  async rename(oldP, newP) {
    const oldNp = path.normalize(oldP);
    const newNp = path.normalize(newP);
    const rec = await this._get(oldNp);
    if (!rec) throw vfsError('ENOENT', oldNp);

    if (rec.type === 'directory') {
      // Move directory and all children
      const all = await this._scan(oldNp);
      const oldPrefix = oldNp === '/' ? '/' : oldNp + '/';
      const newPrefix = newNp === '/' ? '/' : newNp + '/';
      // Re-key all children
      for (const entry of all) {
        const newPath = newPrefix + entry.path.slice(oldPrefix.length);
        await this._del(entry.path);
        entry.path = newPath;
        await this._put(entry);
      }
      // Move the directory record itself
      await this._del(oldNp);
      rec.path = newNp;
      rec.modified = new Date();
      await this._put(rec);
    } else {
      await this._del(oldNp);
      rec.path = newNp;
      rec.modified = new Date();
      await this._put(rec);
    }
  }

  async touch(p) {
    const np = path.normalize(p);
    const rec = await this._get(np);
    if (rec) {
      if (rec.type === 'file') {
        rec.modified = new Date();
        await this._put(rec);
      }
    } else {
      await this.writeFile(np, '');
    }
  }

  async chmod(p, mode) {
    const np = path.normalize(p);
    const rec = await this._get(np);
    if (!rec) throw vfsError('ENOENT', np);
    rec.mode = mode;
    await this._put(rec);
  }

  async chown(p, owner, group) {
    const np = path.normalize(p);
    const rec = await this._get(np);
    if (!rec) throw vfsError('ENOENT', np);
    if (owner !== undefined) rec.owner = owner;
    if (group !== undefined) rec.group = group;
    await this._put(rec);
  }

  async estimate() {
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      return { used: est.usage || 0, available: (est.quota || 0) - (est.usage || 0) };
    }
    // Fallback: sum record sizes
    const all = await this._scan('/');
    let used = 0;
    for (const entry of all) used += entry.size || 0;
    return { used, available: Infinity };
  }

  get persistent() { return true; }
  get estimatable() { return true; }
}

export { IDBBackend };
