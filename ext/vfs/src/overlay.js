import { vfsError } from './error.js';
import { path } from './path.js';
import { Backend } from './backend.js';

const WHITEOUT_PATH = '/.vfs_whiteouts';

class OverlayBackend extends Backend {
  static type = 'overlay';

  constructor(config) {
    super();
    this._lowerConfig = config && config.lower;
    this._upperConfig = config && config.upper;
    this._lower = null;
    this._upper = null;
    this._whiteouts = new Set();
  }

  async init() {
    this._lower = _createBackend(this._lowerConfig);
    this._upper = _createBackend(this._upperConfig);
    if (this._lower.init) await this._lower.init();
    if (this._upper.init) await this._upper.init();
    // Load persisted whiteouts
    try {
      const data = await this._upper.readFile(WHITEOUT_PATH);
      const arr = JSON.parse(data);
      this._whiteouts = new Set(arr);
    } catch {
      // No whiteouts yet
    }
  }

  async _persistWhiteouts() {
    await this._upper.writeFile(WHITEOUT_PATH, JSON.stringify([...this._whiteouts]));
  }

  _isWhiteout(p) {
    return this._whiteouts.has(path.normalize(p));
  }

  async readFile(p, encoding) {
    const n = path.normalize(p);
    if (this._isWhiteout(n)) throw vfsError('ENOENT', p);
    try {
      return await this._upper.readFile(n, encoding);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      return await this._lower.readFile(n, encoding);
    }
  }

  async writeFile(p, content) {
    const n = path.normalize(p);
    // Remove whiteout if present
    if (this._whiteouts.delete(n)) {
      await this._persistWhiteouts();
    }
    await this._upper.writeFile(n, content);
  }

  async stat(p) {
    const n = path.normalize(p);
    if (this._isWhiteout(n)) throw vfsError('ENOENT', p);
    try {
      const s = await this._upper.stat(n);
      return { ...s, layer: 'upper' };
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const s = await this._lower.stat(n);
      return { ...s, layer: 'lower' };
    }
  }

  async mkdir(p, opts) {
    const n = path.normalize(p);
    if (this._whiteouts.delete(n)) {
      await this._persistWhiteouts();
    }
    await this._upper.mkdir(n, opts);
  }

  async readdir(p) {
    const n = path.normalize(p);
    if (this._isWhiteout(n)) throw vfsError('ENOENT', p);
    const names = new Set();
    // Collect from upper
    try {
      const upper = await this._upper.readdir(n);
      for (const name of upper) {
        if (name !== path.basename(WHITEOUT_PATH)) names.add(name);
      }
    } catch {
      // upper may not have this dir
    }
    // Collect from lower
    try {
      const lower = await this._lower.readdir(n);
      for (const name of lower) names.add(name);
    } catch {
      // lower may not have this dir
    }
    // Filter whiteouts
    const prefix = n === '/' ? '/' : n + '/';
    for (const name of names) {
      if (this._whiteouts.has(prefix + name)) names.delete(name);
    }
    return [...names].sort();
  }

  async unlink(p) {
    const n = path.normalize(p);
    // Check if in lower
    let inLower = false;
    try { await this._lower.stat(n); inLower = true; } catch {}
    // Try to delete from upper
    try { await this._upper.unlink(n); } catch {}
    // If in lower, add whiteout
    if (inLower) {
      this._whiteouts.add(n);
      await this._persistWhiteouts();
    }
  }

  async rmdir(p) {
    const n = path.normalize(p);
    let inLower = false;
    try { await this._lower.stat(n); inLower = true; } catch {}
    try { await this._upper.rmdir(n); } catch {}
    if (inLower) {
      this._whiteouts.add(n);
      await this._persistWhiteouts();
    }
  }

  async rename(oldP, newP) {
    const content = await this.readFile(oldP, 'bytes');
    await this.writeFile(newP, content);
    await this.unlink(oldP);
  }

  async touch(p) {
    const n = path.normalize(p);
    try {
      await this.stat(n);
      // Exists — read and rewrite to upper to update mtime
      const content = await this.readFile(n, 'bytes');
      await this.writeFile(n, content);
    } catch (e) {
      if (e.code === 'ENOENT') {
        await this.writeFile(n, '');
      } else throw e;
    }
  }

  async exists(p) {
    const n = path.normalize(p);
    if (this._isWhiteout(n)) return false;
    try { await this.stat(n); return true; }
    catch { return false; }
  }

  async reset(p) {
    if (p) {
      const n = path.normalize(p);
      // Clear whiteouts under prefix
      for (const w of this._whiteouts) {
        if (w === n || w.startsWith(n === '/' ? '/' : n + '/')) {
          this._whiteouts.delete(w);
        }
      }
      // Delete from upper
      try {
        const info = await this._upper.stat(n);
        if (info.type === 'directory') {
          await this._rmUpperRecursive(n);
        } else {
          await this._upper.unlink(n);
        }
      } catch {}
    } else {
      this._whiteouts.clear();
      // Clear all upper content (except whiteout file)
      try {
        const entries = await this._upper.readdir('/');
        for (const name of entries) {
          const child = '/' + name;
          try {
            const info = await this._upper.stat(child);
            if (info.type === 'directory') {
              await this._rmUpperRecursive(child);
            } else {
              await this._upper.unlink(child);
            }
          } catch {}
        }
      } catch {}
    }
    await this._persistWhiteouts();
  }

  async _rmUpperRecursive(p) {
    try {
      const entries = await this._upper.readdir(p);
      for (const name of entries) {
        const child = p === '/' ? '/' + name : p + '/' + name;
        const info = await this._upper.stat(child);
        if (info.type === 'directory') {
          await this._rmUpperRecursive(child);
        } else {
          await this._upper.unlink(child);
        }
      }
      await this._upper.rmdir(p);
    } catch {}
  }

  async destroy() {
    if (this._lower && this._lower.destroy) await this._lower.destroy();
    if (this._upper && this._upper.destroy) await this._upper.destroy();
  }

  get persistent() { return !!this._upper && !!this._upper.persistent; }
  get readonly() { return !!this._upper && !!this._upper.readonly; }
}

export { OverlayBackend };
