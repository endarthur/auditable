import { vfsError } from './error.js';
import { path } from './path.js';
import { Backend } from './backend.js';

class HandleBackend extends Backend {
  constructor(root) {
    super();
    this._root = root;
  }

  async _resolveDir(p) {
    const n = path.normalize(p);
    if (n === '/') return this._root;
    const segs = n.split('/').filter(Boolean);
    let dir = this._root;
    for (const seg of segs) {
      try {
        dir = await dir.getDirectoryHandle(seg);
      } catch {
        throw vfsError('ENOENT', p);
      }
    }
    return dir;
  }

  async _resolveFile(p, create) {
    const n = path.normalize(p);
    const parentPath = path.dirname(n);
    const name = path.basename(n);
    const dir = await this._resolveDir(parentPath);
    try {
      return await dir.getFileHandle(name, create ? { create: true } : undefined);
    } catch {
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
    // Ensure parent exists (will throw ENOENT if not)
    const n = path.normalize(p);
    const parentPath = path.dirname(n);
    await this._resolveDir(parentPath);
    const handle = await this._resolveFile(p, true);
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
  }

  async stat(p) {
    const n = path.normalize(p);
    if (n === '/') {
      return { type: 'directory', size: 0, created: new Date(0), modified: new Date(0) };
    }
    // Try file first
    try {
      const parentPath = path.dirname(n);
      const name = path.basename(n);
      const dir = await this._resolveDir(parentPath);
      const fh = await dir.getFileHandle(name);
      const file = await fh.getFile();
      return {
        type: 'file',
        size: file.size,
        created: new Date(file.lastModified),
        modified: new Date(file.lastModified),
      };
    } catch {
      // Try directory
      try {
        await this._resolveDir(n);
        return { type: 'directory', size: 0, created: new Date(0), modified: new Date(0) };
      } catch {
        throw vfsError('ENOENT', p);
      }
    }
  }

  async mkdir(p, opts) {
    const n = path.normalize(p);
    if (opts && opts.recursive) {
      const segs = n.split('/').filter(Boolean);
      let dir = this._root;
      for (const seg of segs) {
        dir = await dir.getDirectoryHandle(seg, { create: true });
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
    await parent.getDirectoryHandle(name, { create: true });
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
    // Verify it's a file
    const info = await this.stat(p);
    if (info.type === 'directory') throw vfsError('EISDIR', p);
    const parentPath = path.dirname(n);
    const name = path.basename(n);
    const parent = await this._resolveDir(parentPath);
    await parent.removeEntry(name);
  }

  async rmdir(p) {
    const n = path.normalize(p);
    // Verify it's a directory
    const info = await this.stat(p);
    if (info.type !== 'directory') throw vfsError('ENOTDIR', p);
    const parentPath = path.dirname(n);
    const name = path.basename(n);
    const parent = await this._resolveDir(parentPath);
    await parent.removeEntry(name);
  }

  async rename(oldP, newP) {
    // No native rename in handle APIs — read, write, delete
    const info = await this.stat(oldP);
    if (info.type === 'directory') {
      // Recursive copy then delete
      await this._cpDir(oldP, newP);
      await this._rmDir(oldP);
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

  async _rmDir(p) {
    const entries = await this.readdir(p);
    for (const name of entries) {
      const child = path.join(p, name);
      const info = await this.stat(child);
      if (info.type === 'directory') {
        await this._rmDir(child);
      } else {
        await this.unlink(child);
      }
    }
    await this.rmdir(p);
  }

  createReadStream(p) {
    // Return a thunk — caller must await the file handle resolution
    // For HandleBackend, return null and let subclass or consumer use readFile
    return null;
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
