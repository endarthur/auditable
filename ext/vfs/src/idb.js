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

  toConfig() {
    return { type: 'idb', name: this._dbName };
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

  // Run several requests in ONE transaction (a compound op = one commit, and atomic). `q(req)` awaits a
  // request's result WITHOUT releasing the tx — a pending request keeps it alive. CONSTRAINT: `fn` must only
  // await q(...) on `store`, never a foreign promise — IndexedDB auto-commits the moment its request queue
  // goes idle, so awaiting anything else commits the tx and the next op throws TransactionInactiveError.
  // (fake-indexeddb models this faithfully, so the tests catch a violation.)
  _inTx(mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction('files', mode);
      const store = tx.objectStore('files');
      const q = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
      let out, failed;
      tx.oncomplete = () => (failed ? reject(failed) : resolve(out));
      tx.onabort = () => reject(failed || tx.error || new Error('transaction aborted'));
      tx.onerror = () => reject(failed || tx.error);
      // call fn synchronously so its first request is issued before the tx can go idle
      Promise.resolve(fn(store, q)).then((r) => { out = r; }, (e) => { failed = e; try { tx.abort(); } catch { /* already settled */ } });
    });
  }

  // collect a key range via cursor, applying `each(entry, store)` per entry — all within `store`'s tx.
  _eachInRange(store, lower, upper, each) {
    return new Promise((resolve, reject) => {
      const req = store.openCursor(IDBKeyRange.bound(lower, upper, false, true));
      req.onsuccess = () => { const c = req.result; if (!c) return resolve(); each(c.value, store); c.continue(); };
      req.onerror = () => reject(req.error);
    });
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

  _fileRecord(np, content, existing) {
    const now = new Date();
    const isBinary = content instanceof Uint8Array;
    const size = typeof content === 'string' ? new TextEncoder().encode(content).byteLength : (isBinary ? content.byteLength : 0);
    return {
      path: np, type: 'file', content, size,
      created: existing ? existing.created : now, modified: now,
      mode: existing ? existing.mode : 0o644,
      owner: existing ? existing.owner : 'user',
      group: existing ? existing.group : 'staff',
      _binary: isBinary,
    };
  }

  async writeFile(p, content) {
    const np = path.normalize(p);
    const parentPath = path.dirname(np);
    // one transaction: parent-check + existing-check + put (was 3 separate transactions; now atomic — no
    // TOCTOU on the parent between check and write).
    await this._inTx('readwrite', async (store, q) => {
      if (parentPath !== np) {
        const parent = await q(store.get(parentPath));
        if (!parent) throw vfsError('ENOENT', np);
        if (parent.type !== 'directory') throw vfsError('ENOTDIR', np);
      }
      const existing = await q(store.get(np));
      if (existing && existing.type === 'directory') throw vfsError('EISDIR', np);
      store.put(this._fileRecord(np, content, existing));
    });
  }

  // Bulk write — many files in ONE transaction (chunked), with any missing parent dirs created in the same
  // tx. The IDB twin of DropboxBackend.writeFiles; the big win for a mobile copy-in (was ~3 tx/file).
  async writeFiles(files) {
    if (!files || !files.length) return { committed: 0 };
    let committed = 0;
    for (let i = 0; i < files.length; i += 1000) {
      const chunk = files.slice(i, i + 1000);
      await this._inTx('readwrite', async (store, q) => {
        const ensured = new Set(['/']);
        for (const f of chunk) {                          // mkdir -p the ancestors, once each
          const segs = path.normalize(f.path).split('/').filter(Boolean); segs.pop();
          let cur = '';
          for (const seg of segs) {
            cur += '/' + seg;
            if (ensured.has(cur)) continue;
            ensured.add(cur);
            if (!(await q(store.get(cur)))) {
              const now = new Date();
              store.put({ path: cur, type: 'directory', content: null, size: 0, created: now, modified: now, mode: 0o755, owner: 'user', group: 'staff' });
            }
          }
        }
        for (const f of chunk) store.put(this._fileRecord(path.normalize(f.path), f.content, null));
      });
      committed += chunk.length;
    }
    return { committed };
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
    await this._inTx('readwrite', async (store, q) => {
      if (parentPath !== np) {
        if (!(await q(store.get(parentPath)))) throw vfsError('ENOENT', np);
      }
      if (await q(store.get(np))) throw vfsError('EEXIST', np);
      const now = new Date();
      store.put({ path: np, type: 'directory', content: null, size: 0, created: now, modified: now, mode: 0o755, owner: 'user', group: 'staff' });
    });
  }

  async _mkdirRecursive(np) {
    await this._inTx('readwrite', async (store, q) => {
      const segs = np.split('/').filter(Boolean);
      let current = '';
      for (const seg of segs) {
        current += '/' + seg;
        if (!(await q(store.get(current)))) {
          const now = new Date();
          store.put({ path: current, type: 'directory', content: null, size: 0, created: now, modified: now, mode: 0o755, owner: 'user', group: 'staff' });
        }
      }
    });
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

  async rmdir(p, opts) {
    const np = path.normalize(p);
    if (opts && opts.recursive) return this._rmdirRecursive(np);
    await this._inTx('readwrite', async (store, q) => {
      const rec = await q(store.get(np));
      if (!rec) throw vfsError('ENOENT', np);
      if (rec.type !== 'directory') throw vfsError('ENOTDIR', np);
      const { lower, upper } = this._cursorRange(np);
      if (await q(store.openCursor(IDBKeyRange.bound(lower, upper, false, true)))) throw vfsError('ENOTEMPTY', np);   // any child?
      store.delete(np);
    });
  }

  // Recursive delete — store.delete(range) wipes the whole subtree in ONE request (+ the dir record). The IDB
  // twin of FSA's removeEntry({recursive}); was readdir + a stat + a delete PER descendant across N transactions.
  async _rmdirRecursive(np) {
    await this._inTx('readwrite', async (store, q) => {
      if (!(await q(store.get(np)))) throw vfsError('ENOENT', np);
      const { lower, upper } = this._cursorRange(np);
      store.delete(IDBKeyRange.bound(lower, upper, false, true));   // the entire subtree, one request
      store.delete(np);                                             // the directory record itself
    });
  }

  async unlink(p) {
    const np = path.normalize(p);
    await this._inTx('readwrite', async (store, q) => {
      const rec = await q(store.get(np));
      if (!rec) throw vfsError('ENOENT', np);
      if (rec.type === 'directory') throw vfsError('EISDIR', np);
      store.delete(np);
    });
  }

  // Bulk delete — many paths in one transaction (chunked).
  async deleteBatch(paths) {
    if (!paths || !paths.length) return { deleted: 0 };
    let deleted = 0;
    for (let i = 0; i < paths.length; i += 1000) {
      const chunk = paths.slice(i, i + 1000);
      await this._inTx('readwrite', async (store) => { for (const pp of chunk) store.delete(path.normalize(pp)); });
      deleted += chunk.length;
    }
    return { deleted };
  }

  // One transaction for the whole move — and ATOMIC (was ~2N+1 transactions for an N-entry subtree, leaving a
  // half-moved tree if it crashed mid-rename). IDB is transactional, so unlike FSA this rename is truly atomic.
  async rename(oldP, newP) {
    const oldNp = path.normalize(oldP);
    const newNp = path.normalize(newP);
    await this._inTx('readwrite', async (store, q) => {
      const rec = await q(store.get(oldNp));
      if (!rec) throw vfsError('ENOENT', oldNp);
      store.delete(oldNp);
      store.put({ ...rec, path: newNp, modified: new Date() });
      if (rec.type === 'directory') {
        // re-key every descendant — put+delete issued INSIDE the cursor walk so a request is always pending
        // (no foreign await ⇒ the tx never goes idle mid-move).
        const oldPrefix = oldNp === '/' ? '/' : oldNp + '/';
        const newPrefix = newNp === '/' ? '/' : newNp + '/';
        const { lower, upper } = this._cursorRange(oldNp);
        await this._eachInRange(store, lower, upper, (entry, s) => {
          s.put({ ...entry, path: newPrefix + entry.path.slice(oldPrefix.length) });
          s.delete(entry.path);
        });
      }
    });
  }

  async touch(p) {
    const np = path.normalize(p);
    const existed = await this._inTx('readwrite', async (store, q) => {
      const rec = await q(store.get(np));
      if (!rec) return false;
      if (rec.type === 'file') { rec.modified = new Date(); store.put(rec); }
      return true;
    });
    if (!existed) await this.writeFile(np, '');
  }

  async chmod(p, mode) {
    const np = path.normalize(p);
    await this._inTx('readwrite', async (store, q) => {
      const rec = await q(store.get(np));
      if (!rec) throw vfsError('ENOENT', np);
      rec.mode = mode; store.put(rec);
    });
  }

  async chown(p, owner, group) {
    const np = path.normalize(p);
    await this._inTx('readwrite', async (store, q) => {
      const rec = await q(store.get(np));
      if (!rec) throw vfsError('ENOENT', np);
      if (owner !== undefined) rec.owner = owner;
      if (group !== undefined) rec.group = group;
      store.put(rec);
    });
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
