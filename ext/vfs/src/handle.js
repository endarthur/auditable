import { vfsError } from './error.js';
import { path } from './path.js';
import { Backend } from './backend.js';

// HandleBackend — base for FSAABackend + OPFSBackend over the File System Access API.
//
// Directory-handle cache (vfs-handle-cache-spec.md): _resolveDir used to re-walk getDirectoryHandle
// per segment FROM ROOT on every op. On desktop that's near-free; on Android a picked folder is a SAF
// content:// URI, so each getDirectoryHandle is a Binder IPC — per-op latency = O(depth) IPCs, killing
// a many-small-files copy. We cache normalizedDirPath → FileSystemDirectoryHandle, walk only from the
// deepest cached ancestor, cache intermediates, and invalidate on structural change. Stale-handle safe:
// a cached handle can go bad if the folder is removed/recreated outside the app, so a raw FSA failure on
// a (possibly cached) handle evicts + re-resolves fresh from root once before surfacing ENOENT.

class HandleBackend extends Backend {
  constructor(root) {
    super();
    this._root = root;
    this._dirCache = new Map();   // normalized dir path → FileSystemDirectoryHandle
  }

  // Drop a path and all its descendants from the cache (structural change under it).
  _evict(p) {
    const n = path.normalize(p);
    if (n === '/') { this._dirCache.clear(); return; }
    const prefix = n + '/';
    for (const key of [...this._dirCache.keys()]) {
      if (key === n || key.startsWith(prefix)) this._dirCache.delete(key);
    }
  }

  // Resolve a dir path to its handle. Cache hit → return it. Miss → walk from the deepest cached
  // ancestor (or root), caching each intermediate as we descend. `fresh` ignores the cache entirely
  // (the from-root re-resolve used after a suspected stale handle).
  async _resolveDir(p, fresh = false) {
    const n = path.normalize(p);
    if (!fresh) { const hit = this._dirCache.get(n); if (hit) return hit; }
    if (n === '/') { this._dirCache.set('/', this._root); return this._root; }
    const segs = n.split('/').filter(Boolean);
    let dir = this._root, startI = 0;
    if (!fresh) {
      for (let i = segs.length - 1; i >= 1; i--) {
        const h = this._dirCache.get('/' + segs.slice(0, i).join('/'));
        if (h) { dir = h; startI = i; break; }
      }
    }
    this._dirCache.set('/', this._root);
    let acc = startI === 0 ? '' : '/' + segs.slice(0, startI).join('/');
    for (let i = startI; i < segs.length; i++) {
      acc += '/' + segs[i];
      try {
        dir = await dir.getDirectoryHandle(segs[i]);
      } catch {
        // a cached ancestor may be stale → drop this lineage and retry once from root
        if (!fresh && startI > 0) { this._evict(n); return this._resolveDir(n, true); }
        throw vfsError('ENOENT', p);
      }
      this._dirCache.set(acc, dir);
    }
    return dir;
  }

  // Resolve `dirPath` (cached) and run fn(dirHandle). If fn throws a RAW (non-VFSError) error, the
  // cached handle may be stale: evict + re-resolve fresh from root, retry once. Typed VFSErrors
  // (EISDIR/EEXIST/ENOTDIR/ENOENT) are semantic — rethrow without retry. A missing parent throws
  // out of the initial resolve (no retry).
  async _useDir(dirPath, fn) {
    const dir = await this._resolveDir(dirPath);
    try {
      return await fn(dir);
    } catch (e) {
      if (e && typeof e.code === 'string') throw e;
      this._evict(dirPath);
      let fresh;
      try { fresh = await this._resolveDir(dirPath, true); } catch { throw e; }
      return await fn(fresh);
    }
  }

  async _resolveFile(p, create) {
    const n = path.normalize(p);
    const parentPath = path.dirname(n);
    const name = path.basename(n);
    try {
      return await this._useDir(parentPath, (dir) => dir.getFileHandle(name, create ? { create: true } : undefined));
    } catch (e) {
      if (e && typeof e.code === 'string') throw e;
      throw vfsError('ENOENT', p);
    }
  }

  _resolveParent(p) {
    const n = path.normalize(p);
    return { dir: path.dirname(n), name: path.basename(n) };
  }

  async readFile(p, encoding) {
    const handle = await this._resolveFile(p);
    const file = await handle.getFile();
    if (encoding === 'bytes') {
      const buf = await file.arrayBuffer();
      return new Uint8Array(buf);
    }
    return await file.text();
  }

  async writeFile(p, content) {
    // _resolveFile resolves the parent ONCE (was resolved twice — a standalone _resolveDir plus the
    // one inside _resolveFile). getFileHandle({create:true}) creates the file (throws ENOENT if the
    // parent is missing — same as before).
    const handle = await this._resolveFile(p, true);
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
  }

  // file-or-dir probe on an already-resolved parent handle (no extra walk). null = neither.
  async _probe(parent, name) {
    try {
      const fh = await parent.getFileHandle(name);
      const file = await fh.getFile();
      return { type: 'file', size: file.size, created: new Date(file.lastModified), modified: new Date(file.lastModified) };
    } catch { /* not a file */ }
    try {
      await parent.getDirectoryHandle(name);
      return { type: 'directory', size: 0, created: new Date(0), modified: new Date(0) };
    } catch { return null; }
  }

  async stat(p) {
    const n = path.normalize(p);
    if (n === '/') return { type: 'directory', size: 0, created: new Date(0), modified: new Date(0) };
    const parentPath = path.dirname(n);
    const name = path.basename(n);
    // resolve the parent ONCE, probe file-then-dir on it (was two full walks: parent for the file-try,
    // then a separate _resolveDir(n) for the dir-try).
    const wasHit = this._dirCache.has(path.normalize(parentPath));
    let parent;
    try { parent = await this._resolveDir(parentPath); } catch { throw vfsError('ENOENT', p); }
    let r = await this._probe(parent, name);
    if (r) return r;
    // both missed — if the parent came from the cache it may be stale; re-resolve fresh once
    if (wasHit) {
      this._evict(parentPath);
      try { parent = await this._resolveDir(parentPath, true); } catch { throw vfsError('ENOENT', p); }
      r = await this._probe(parent, name);
      if (r) return r;
    }
    throw vfsError('ENOENT', p);
  }

  async mkdir(p, opts) {
    const n = path.normalize(p);
    if (opts && opts.recursive) {
      const segs = n.split('/').filter(Boolean);
      let dir = this._root; this._dirCache.set('/', this._root);
      let acc = '';
      for (const seg of segs) {
        acc += '/' + seg;
        dir = await dir.getDirectoryHandle(seg, { create: true });
        this._dirCache.set(acc, dir);   // seed the cache with the created handles
      }
      return;
    }
    const parentPath = path.dirname(n);
    const name = path.basename(n);
    const parent = await this._resolveDir(parentPath);
    // Check if exists
    try {
      await parent.getDirectoryHandle(name);
      throw vfsError('EEXIST', p);
    } catch (e) {
      if (e.code === 'EEXIST') throw e;
    }
    const h = await parent.getDirectoryHandle(name, { create: true });
    this._dirCache.set(n, h);   // seed the created dir
  }

  async readdir(p) {
    const dir = await this._resolveDir(p);
    const names = [];
    for await (const [name] of dir.entries()) {
      names.push(name);
    }
    return names.sort();
  }

  async unlink(p) {
    const n = path.normalize(p);
    const parentPath = path.dirname(n);
    const name = path.basename(n);
    try {
      await this._useDir(parentPath, async (parent) => {
        // EISDIR if it's actually a directory; else remove (file → gone, missing → throws)
        let isDir = false;
        try { await parent.getDirectoryHandle(name); isDir = true; } catch { /* not a dir */ }
        if (isDir) throw vfsError('EISDIR', p);
        await parent.removeEntry(name);
      });
    } catch (e) {
      if (e && typeof e.code === 'string') throw e;
      throw vfsError('ENOENT', p);
    }
  }

  async rmdir(p, opts) {
    if (opts && opts.recursive) return this._rmDir(p);   // native recursive delete (one call vs an O(subtree) walk)
    const n = path.normalize(p);
    const parentPath = path.dirname(n);
    const name = path.basename(n);
    this._evict(n);   // the directory (and any cached descendants) is going away
    try {
      await this._useDir(parentPath, async (parent) => {
        // ENOTDIR if it's actually a file; else remove the directory
        let isFile = false;
        try { await parent.getFileHandle(name); isFile = true; } catch { /* not a file */ }
        if (isFile) throw vfsError('ENOTDIR', p);
        await parent.removeEntry(name);
      });
    } catch (e) {
      if (e && typeof e.code === 'string') throw e;
      if (e && e.name === 'InvalidModificationError') throw vfsError('ENOTEMPTY', p);   // non-empty dir
      throw vfsError('ENOENT', p);
    }
  }

  async rename(oldP, newP) {
    // No native rename in handle APIs — read, write, delete
    const info = await this.stat(oldP);
    if (info.type === 'directory') {
      // Recursive copy then delete
      await this._cpDir(oldP, newP);
      await this._rmDir(oldP);
      this._evict(oldP);   // the source subtree is gone (rmdir already evicted its leaf; be thorough)
    } else {
      const content = await this.readFile(oldP, 'bytes');
      await this.writeFile(newP, content);
      await this.unlink(oldP);
    }
  }

  async _cpDir(src, dst) {
    await this.mkdir(dst, { recursive: true });
    const entries = await this.readdir(src);
    for (const name of entries) {
      const srcChild = path.join(src, name);
      const dstChild = path.join(dst, name);
      const info = await this.stat(srcChild);
      if (info.type === 'directory') {
        await this._cpDir(srcChild, dstChild);
      } else {
        const content = await this.readFile(srcChild, 'bytes');
        await this.writeFile(dstChild, content);
      }
    }
  }

  // Recursive directory delete. Native removeEntry({recursive:true}) is ONE call; the old hand-walk was
  // readdir + a stat + a delete PER child (each a SAF IPC on Android — O(whole subtree)). The handle-cache
  // (0.4.0) cut resolution IPCs; this removes the per-child ops entirely. Falls back to the manual walk on a
  // runtime without recursive removeEntry. (Directory rename stays copy-then-delete = non-atomic — platform
  // floor; this only makes the delete half one call.)
  async _rmDir(p) {
    const n = path.normalize(p);
    this._evict(n);   // the subtree's cached handles are invalid either way
    const parentPath = path.dirname(n);
    const name = path.basename(n);
    try {
      await this._useDir(parentPath, (parent) => parent.removeEntry(name, { recursive: true }));
      return;
    } catch (e) {
      if (e && typeof e.code === 'string') throw e;   // a mapped error (e.g. missing parent) → propagate
      // otherwise: runtime lacks recursive removeEntry (or it threw) → fall back to the manual walk
    }
    await this._rmDirManual(p);
  }

  async _rmDirManual(p) {
    const entries = await this.readdir(p);
    for (const name of entries) {
      const child = path.join(p, name);
      const info = await this.stat(child);
      if (info.type === 'directory') {
        await this._rmDirManual(child);
      } else {
        await this.unlink(child);
      }
    }
    await this.rmdir(p);
  }

  // A lazily-resolved byte stream off the file handle — FSA file handles support .stream(). Matches
  // FetchBackend's { getReader, [asyncIterator] } shape so the `streamable` capability is honest (it used to
  // return null while `streamable` claimed true — a consumer that checked then called got nothing).
  createReadStream(p) {
    const self = this;
    return {
      async getReader() {
        const handle = await self._resolveFile(p);
        return (await handle.getFile()).stream().getReader();
      },
      [Symbol.asyncIterator]() {
        const streamPromise = self._resolveFile(p).then((h) => h.getFile()).then((f) => f.stream());
        let reader;
        return {
          async next() {
            if (!reader) reader = (await streamPromise).getReader();
            return reader.read();
          },
        };
      },
    };
  }

  async createWriter(p) {
    const handle = await this._resolveFile(p, true);
    return handle.createWritable();
  }

  get persistent() { return true; }
  get streamable() { return true; }
  get estimatable() { return true; }

  async estimate() {
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      return { used: est.usage || 0, available: (est.quota || 0) - (est.usage || 0) };
    }
    return { used: 0, available: Infinity };
  }
}

export { HandleBackend };
