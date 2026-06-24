import { vfsError } from './error.js';
import { path } from './path.js';
import { Backend } from './backend.js';

class CommentBackend extends Backend {
  static type = 'comment';

  constructor(config) {
    super();
    this._map = new Map();
    this._commentNode = null;
    this._dataMode = !!(config && config.data);
    this._initData = (config && config.data) || null;
  }

  async init() {
    if (this._initData) {
      // Data mode: load from provided object
      for (const [key, entry] of Object.entries(this._initData)) {
        this._map.set(key, { ...entry });
      }
    } else if (typeof document !== 'undefined') {
      // DOM mode: find existing AUDITABLE-FS comment
      this._commentNode = this._findComment();
      if (this._commentNode) {
        const raw = this._commentNode.nodeValue.replace(/^AUDITABLE-FS\n/, '').replace(/\nAUDITABLE-FS$/, '');
        const obj = this._decode(raw);
        for (const [key, entry] of Object.entries(obj)) {
          this._map.set(key, entry);
        }
      }
    }
  }

  _findComment() {
    if (typeof document === 'undefined') return null;
    const walker = document.createTreeWalker(document, 128 /* NodeFilter.SHOW_COMMENT */);
    while (walker.nextNode()) {
      if (walker.currentNode.nodeValue.startsWith('AUDITABLE-FS\n')) {
        return walker.currentNode;
      }
    }
    return null;
  }

  _toRel(p) {
    // Strip leading / for internal storage
    const np = path.normalize(p);
    return np === '/' ? '' : np.slice(1);
  }

  _toAbs(rel) {
    return rel ? '/' + rel : '/';
  }

  _encode(obj) {
    const json = JSON.stringify(obj);
    const b64 = btoa(unescape(encodeURIComponent(json)));
    // Split into 76-char lines
    const lines = [];
    for (let i = 0; i < b64.length; i += 76) {
      lines.push(b64.slice(i, i + 76));
    }
    return lines.join('\n');
  }

  _decode(raw) {
    const stripped = raw.replace(/\s/g, '');
    // Legacy raw JSON detection
    if (stripped.startsWith('{')) {
      return JSON.parse(stripped);
    }
    const json = decodeURIComponent(escape(atob(stripped)));
    return JSON.parse(json);
  }

  _syncComment() {
    if (!this._commentNode) return;
    const obj = Object.fromEntries(this._map);
    this._commentNode.nodeValue = 'AUDITABLE-FS\n' + this._encode(obj) + '\nAUDITABLE-FS';
  }

  async readFile(p, encoding) {
    const rel = this._toRel(p);
    const entry = this._map.get(rel);
    if (!entry) throw vfsError('ENOENT', p);

    let raw;
    if (entry.compressed && typeof DecompressionStream !== 'undefined') {
      // Decompress gzip base64
      const bytes = Uint8Array.from(atob(entry.data), c => c.charCodeAt(0));
      const ds = new DecompressionStream('gzip');
      const writer = ds.writable.getWriter();
      writer.write(bytes);
      writer.close();
      const reader = ds.readable.getReader();
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const total = chunks.reduce((s, c) => s + c.byteLength, 0);
      const result = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) { result.set(c, offset); offset += c.byteLength; }
      raw = result;
    } else if (entry.data) {
      // Uncompressed base64
      const binary = atob(entry.data);
      raw = Uint8Array.from(binary, c => c.charCodeAt(0));
    } else {
      raw = new Uint8Array(0);
    }

    if (encoding === 'bytes') return raw;
    return new TextDecoder().decode(raw);
  }

  // gzip+base64 one file → an AUDITABLE-FS map entry. The only async/expensive part of a write; pulled out so
  // writeFiles can encode many then sync the comment ONCE (writeFile/_syncComment re-serialize the whole map).
  async _encodeEntry(p, content) {
    const mimeType = path.mime(p);
    const bytes = content instanceof Uint8Array ? content : new TextEncoder().encode(content || '');
    const size = bytes.byteLength;
    let data, compressed = false;
    if (typeof CompressionStream !== 'undefined') {
      const cs = new CompressionStream('gzip');
      const writer = cs.writable.getWriter(); writer.write(bytes); writer.close();
      const reader = cs.readable.getReader(); const chunks = [];
      while (true) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
      const total = chunks.reduce((s, c) => s + c.byteLength, 0);
      const gz = new Uint8Array(total); let off = 0;
      for (const c of chunks) { gz.set(c, off); off += c.byteLength; }
      if (gz.byteLength < bytes.byteLength) { data = btoa(String.fromCharCode(...gz)); compressed = true; }
      else data = btoa(String.fromCharCode(...bytes));
    } else {
      data = btoa(String.fromCharCode(...bytes));
    }
    return { type: mimeType, compressed, size, data };
  }

  _assertParentDir(p) {
    // implicit dirs — just guard against writing under a file
    const parentRel = this._toRel(path.dirname(path.normalize(p)));
    if (parentRel && this._map.has(parentRel)) throw vfsError('ENOTDIR', p);
  }

  async writeFile(p, content) {
    this._assertParentDir(p);
    this._map.set(this._toRel(p), await this._encodeEntry(p, content));
    this._syncComment();
  }

  // Bulk write — encode all entries, then re-serialize the comment ONCE (vs once per file → O(N²)).
  async writeFiles(files) {
    if (!files || !files.length) return { committed: 0 };
    for (const f of files) {
      this._assertParentDir(f.path);
      this._map.set(this._toRel(f.path), await this._encodeEntry(f.path, f.content));
    }
    this._syncComment();
    return { committed: files.length };
  }

  // Bulk delete — one comment re-serialization for the whole batch.
  async deleteBatch(paths) {
    if (!paths || !paths.length) return { deleted: 0 };
    let deleted = 0;
    for (const p of paths) if (this._map.delete(this._toRel(p))) deleted++;
    this._syncComment();
    return { deleted };
  }

  async stat(p) {
    const np = path.normalize(p);
    const rel = this._toRel(np);

    // Root always exists
    if (rel === '') {
      return {
        type: 'directory', size: 0,
        created: new Date(0), modified: new Date(0),
        mode: 0o755, owner: 'user', group: 'staff',
      };
    }

    // Check if it's a file
    const entry = this._map.get(rel);
    if (entry) {
      return {
        type: 'file', size: entry.size || 0,
        created: new Date(0), modified: new Date(0),
        mode: 0o644, owner: 'user', group: 'staff',
      };
    }

    // Check if it's an implicit directory
    const prefix = rel + '/';
    for (const key of this._map.keys()) {
      if (key.startsWith(prefix)) {
        return {
          type: 'directory', size: 0,
          created: new Date(0), modified: new Date(0),
          mode: 0o755, owner: 'user', group: 'staff',
        };
      }
    }

    throw vfsError('ENOENT', np);
  }

  async mkdir(/* p, opts */) {
    // Implicit directories — mkdir is a no-op
  }

  async readdir(p) {
    const np = path.normalize(p);
    const rel = this._toRel(np);
    const prefix = rel ? rel + '/' : '';
    const names = new Set();

    for (const key of this._map.keys()) {
      if (rel === '') {
        // Root: all top-level entries
        const slashIdx = key.indexOf('/');
        names.add(slashIdx === -1 ? key : key.slice(0, slashIdx));
      } else if (key.startsWith(prefix)) {
        const rest = key.slice(prefix.length);
        if (!rest) continue;
        const slashIdx = rest.indexOf('/');
        names.add(slashIdx === -1 ? rest : rest.slice(0, slashIdx));
      }
    }

    return [...names].sort();
  }

  async rmdir(p) {
    const np = path.normalize(p);
    const rel = this._toRel(np);
    if (rel === '') throw vfsError('EACCES', np, 'cannot remove root');
    const children = await this.readdir(np);
    if (children.length > 0) throw vfsError('ENOTEMPTY', np);
    // No-op if empty (implicit directories have no record to delete)
  }

  async unlink(p) {
    const np = path.normalize(p);
    const rel = this._toRel(np);
    if (!this._map.has(rel)) throw vfsError('ENOENT', np);
    this._map.delete(rel);
    this._syncComment();
  }

  async rename(oldP, newP) {
    const oldRel = this._toRel(oldP);
    const newRel = this._toRel(newP);
    const entry = this._map.get(oldRel);
    if (!entry) throw vfsError('ENOENT', oldP);
    this._map.delete(oldRel);
    this._map.set(newRel, entry);
    this._syncComment();
  }

  async touch(p) {
    const np = path.normalize(p);
    const rel = this._toRel(np);
    if (!this._map.has(rel)) {
      // Create empty file
      this._map.set(rel, { type: path.mime(np), compressed: false, size: 0, data: '' });
      this._syncComment();
    }
    // No mtime to update in this format
  }

  async chmod() {
    // AUDITABLE-FS format doesn't store permissions — no-op
  }

  async chown() {
    // AUDITABLE-FS format doesn't store ownership — no-op
  }

  async export(basePath) {
    const np = path.normalize(basePath);
    const rel = this._toRel(np);
    const result = {};
    const prefix = rel ? rel + '/' : '';

    for (const [key, entry] of this._map) {
      let exportKey;
      if (rel === '') {
        exportKey = key;
      } else if (key.startsWith(prefix)) {
        exportKey = key.slice(prefix.length);
      } else if (key === rel) {
        // Exporting a single file
        const content = await this.readFile(np);
        return { [path.basename(np)]: content };
      } else {
        continue;
      }
      if (!exportKey) continue;
      result[exportKey] = entry;
    }
    return result;
  }

  async import(basePath, data) {
    const np = path.normalize(basePath);
    const rel = this._toRel(np);
    const prefix = rel ? rel + '/' : '';

    for (const [key, entry] of Object.entries(data)) {
      this._map.set(prefix + key, { ...entry });
    }
    this._syncComment();
  }

  getData() {
    return Object.fromEntries(this._map);
  }

  get persistent() { return true; }
  get portable() { return true; }
  get exportable() { return true; }
}

export { CommentBackend };
