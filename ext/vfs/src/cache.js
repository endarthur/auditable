import { vfsError } from './error.js';
import { path } from './path.js';
import { Backend } from './backend.js';

const META_PREFIX = '/_cache_meta';
const LISTING_PREFIX = '/_cache_listing';

class CacheBackend extends Backend {
  static type = 'cache';

  constructor(config) {
    super();
    this._remoteConfig = config && config.backend;
    this._storeConfig = config && config.store;
    this._ttl = (config && config.ttl) || 60000; // default 1 minute
    this._listingTtl = (config && config.listingTtl) || this._ttl;
    this._remote = null;
    this._store = null;
  }

  async init() {
    this._remote = _createBackend(this._remoteConfig);
    this._store = _createBackend(this._storeConfig || { type: 'memory' });
    if (this._remote.init) await this._remote.init();
    if (this._store.init) await this._store.init();
  }

  async _isFresh(metaPath, ttl) {
    try {
      const raw = await this._store.readFile(metaPath);
      const meta = JSON.parse(raw);
      return (Date.now() - meta.ts) < ttl;
    } catch {
      return false;
    }
  }

  async _setMeta(metaPath, extra) {
    const meta = { ts: Date.now(), ...extra };
    // Ensure parent dirs exist
    const dir = path.dirname(metaPath);
    try { await this._store.mkdir(dir, { recursive: true }); } catch {}
    await this._store.writeFile(metaPath, JSON.stringify(meta));
  }

  async readFile(p, encoding) {
    const n = path.normalize(p);
    const metaPath = META_PREFIX + n;
    if (await this._isFresh(metaPath, this._ttl)) {
      try {
        return await this._store.readFile(n, encoding);
      } catch {
        // Cache entry missing, fall through to remote
      }
    }
    // Fetch from remote
    const content = await this._remote.readFile(n, encoding);
    // Cache it
    try {
      const dir = path.dirname(n);
      try { await this._store.mkdir(dir, { recursive: true }); } catch {}
      await this._store.writeFile(n, content);
      await this._setMeta(metaPath);
    } catch {}
    return content;
  }

  async writeFile(p, content) {
    const n = path.normalize(p);
    // Write-through: remote first
    await this._remote.writeFile(n, content);
    // Update cache
    try {
      const dir = path.dirname(n);
      try { await this._store.mkdir(dir, { recursive: true }); } catch {}
      await this._store.writeFile(n, content);
      await this._setMeta(META_PREFIX + n);
    } catch {}
  }

  async stat(p) {
    const n = path.normalize(p);
    const metaPath = META_PREFIX + n;
    if (await this._isFresh(metaPath, this._ttl)) {
      try {
        const raw = await this._store.readFile(metaPath);
        const meta = JSON.parse(raw);
        if (meta.stat) return meta.stat;
      } catch {}
    }
    const s = await this._remote.stat(n);
    try { await this._setMeta(metaPath, { stat: s }); } catch {}
    return s;
  }

  async readdir(p) {
    const n = path.normalize(p);
    const listPath = LISTING_PREFIX + n;
    try {
      const raw = await this._store.readFile(listPath);
      const listing = JSON.parse(raw);
      if ((Date.now() - listing.ts) < this._listingTtl) {
        return listing.entries;
      }
    } catch {}
    const entries = await this._remote.readdir(n);
    try {
      const dir = path.dirname(listPath);
      try { await this._store.mkdir(dir, { recursive: true }); } catch {}
      await this._store.writeFile(listPath, JSON.stringify({ ts: Date.now(), entries }));
    } catch {}
    return entries;
  }

  async mkdir(p, opts) {
    return this._remote.mkdir(p, opts);
  }

  async unlink(p) {
    const n = path.normalize(p);
    await this._remote.unlink(n);
    await this.invalidate(n);
  }

  async rmdir(p) {
    const n = path.normalize(p);
    await this._remote.rmdir(n);
    await this.invalidate(n);
  }

  async rename(oldP, newP) {
    await this._remote.rename(oldP, newP);
    await this.invalidate(path.normalize(oldP));
    await this.invalidate(path.normalize(newP));
  }

  async touch(p) {
    return this._remote.touch(p);
  }

  async invalidate(p) {
    if (p === '*') {
      // Clear entire cache store
      try {
        const entries = await this._store.readdir('/');
        for (const name of entries) {
          const child = '/' + name;
          try {
            const info = await this._store.stat(child);
            if (info.type === 'directory') {
              await this._rmStoreRecursive(child);
            } else {
              await this._store.unlink(child);
            }
          } catch {}
        }
      } catch {}
      return;
    }
    const n = path.normalize(p);
    // Remove cached content
    try { await this._store.unlink(n); } catch {}
    // Remove meta
    try { await this._store.unlink(META_PREFIX + n); } catch {}
    // Remove listing
    try { await this._store.unlink(LISTING_PREFIX + n); } catch {}
  }

  async _rmStoreRecursive(p) {
    try {
      const entries = await this._store.readdir(p);
      for (const name of entries) {
        const child = p === '/' ? '/' + name : p + '/' + name;
        try {
          const info = await this._store.stat(child);
          if (info.type === 'directory') {
            await this._rmStoreRecursive(child);
          } else {
            await this._store.unlink(child);
          }
        } catch {}
      }
      await this._store.rmdir(p);
    } catch {}
  }

  async exists(p) {
    try { await this.stat(p); return true; }
    catch { return false; }
  }

  async destroy() {
    if (this._remote && this._remote.destroy) await this._remote.destroy();
    if (this._store && this._store.destroy) await this._store.destroy();
  }

  // Delegate capabilities to remote
  get persistent() { return this._remote ? !!this._remote.persistent : false; }
  get readonly() { return this._remote ? !!this._remote.readonly : false; }
  get streamable() { return this._remote ? !!this._remote.streamable : false; }
  get estimatable() { return this._remote ? !!this._remote.estimatable : false; }
}

export { CacheBackend };
