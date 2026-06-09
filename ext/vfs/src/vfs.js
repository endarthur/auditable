import { VFSError, vfsError } from './error.js';
import { path } from './path.js';
import { EventEmitter } from './emitter.js';
import { Backend } from './backend.js';
import { MemoryBackend } from './memory.js';
import { IDBBackend } from './idb.js';
import { CommentBackend } from './comment.js';
import { OPFSBackend } from './opfs.js';
import { FSAABackend } from './fsaa.js';
import { FetchBackend } from './fetch-backend.js';
import { RESTBackend } from './rest.js';
import { DropboxBackend } from './dropbox.js';
import { OverlayBackend } from './overlay.js';
import { CacheBackend } from './cache.js';
import { vfsGlob } from './glob.js';
import { checkPermission } from './permissions.js';

const BACKEND_TYPES = {
  memory: MemoryBackend,
  idb: IDBBackend,
  comment: CommentBackend,
  opfs: OPFSBackend,
  fsaa: FSAABackend,
  fetch: FetchBackend,
  rest: RESTBackend,
  dropbox: DropboxBackend,
  overlay: OverlayBackend,
  cache: CacheBackend,
};

function _createBackend(config) {
  if (!config) return new MemoryBackend();
  if (config instanceof Backend) return config;
  // Plain object with methods — custom backend
  if (typeof config.readFile === 'function' || typeof config.stat === 'function') {
    return config;
  }
  const type = config.type || 'memory';
  const Cls = BACKEND_TYPES[type];
  if (!Cls) throw new Error(`Unknown backend type: ${type}`);
  return new Cls(config);
}

class VFS extends EventEmitter {
  constructor() {
    super();
    this._mounts = new Map();
  }

  static async create(config) {
    const vfs = new VFS();
    if (!config) {
      // Default: memory at /
      const backend = new MemoryBackend();
      await backend.init();
      vfs._mounts.set('/', backend);
    } else if (config.type) {
      // Single backend shorthand
      const backend = _createBackend(config);
      if (backend.init) await backend.init();
      vfs._mounts.set('/', backend);
    } else if (config.backends) {
      for (const [mountPath, backendConfig] of Object.entries(config.backends)) {
        const backend = _createBackend(backendConfig);
        if (backend.init) await backend.init();
        vfs._mounts.set(path.normalize(mountPath), backend);
      }
    }
    return vfs;
  }

  resolve(p) {
    const normalized = path.normalize(p);
    let bestMount = '';
    let bestBackend = null;
    for (const [mount, backend] of this._mounts) {
      if (normalized === mount || normalized.startsWith(mount === '/' ? '/' : mount + '/') || mount === '/') {
        if (mount.length > bestMount.length) {
          bestMount = mount;
          bestBackend = backend;
        }
      }
    }
    if (!bestBackend) throw vfsError('ENOENT', p, 'no mount for path');
    const subpath = bestMount === '/'
      ? normalized
      : normalized.slice(bestMount.length) || '/';
    return { backend: bestBackend, subpath, mount: bestMount };
  }

  async mount(mountPath, config) {
    const normalized = path.normalize(mountPath);
    const backend = _createBackend(config);
    if (backend.init) await backend.init();
    this._mounts.set(normalized, backend);
    this.emit('mount', { path: normalized, type: backend.constructor?.type || config?.type || 'custom' });
  }

  async unmount(mountPath) {
    const normalized = path.normalize(mountPath);
    const backend = this._mounts.get(normalized);
    if (!backend) return;
    if (backend.destroy) await backend.destroy();
    this._mounts.delete(normalized);
    this.emit('unmount', { path: normalized });
  }

  mounts() {
    const result = [];
    for (const [mp, backend] of this._mounts) {
      result.push({ path: mp, type: backend.constructor?.type || 'custom' });
    }
    return result;
  }

  capabilities(p) {
    const { backend } = this.resolve(p);
    return {
      type: backend.constructor?.type || 'custom',
      persistent: !!backend.persistent,
      writable: !backend.readonly,
      streamable: !!backend.streamable,
      estimatable: !!backend.estimatable,
      exportable: backend.exportable !== false,
      portable: !!backend.portable,
      symlinks: !!backend.symlinks,
    };
  }

  _checkWrite(backend, p) {
    if (backend.readonly) throw vfsError('EACCES', p, 'read-only backend');
  }

  // --- Filesystem operations ---

  async readFile(p, encodingOrOpts) {
    const encoding = typeof encodingOrOpts === 'string' ? encodingOrOpts : undefined;
    const opts = typeof encodingOrOpts === 'object' ? encodingOrOpts : {};
    const principal = opts.principal;
    checkPermission('readFile', p, principal);
    const { backend, subpath } = this.resolve(p);
    if (principal) {
      try {
        const meta = await backend.stat(subpath);
        checkPermission('readFile', p, principal, meta);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    return backend.readFile(subpath, encoding || (opts.encoding));
  }

  async writeFile(p, content, opts) {
    const principal = opts?.principal;
    checkPermission('writeFile', p, principal);
    const { backend, subpath } = this.resolve(p);
    this._checkWrite(backend, p);
    if (principal) {
      try {
        const meta = await backend.stat(subpath);
        checkPermission('writeFile', p, principal, meta);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    await backend.writeFile(subpath, content);
    this.emit('write', { path: path.normalize(p) });
  }

  async mkdir(p, opts) {
    const principal = opts?.principal;
    checkPermission('mkdir', p, principal);
    const { backend, subpath } = this.resolve(p);
    this._checkWrite(backend, p);
    await backend.mkdir(subpath, opts);
    this.emit('mkdir', { path: path.normalize(p) });
  }

  async readdir(p, opts) {
    const principal = opts?.principal;
    checkPermission('readdir', p, principal);
    const { backend, subpath } = this.resolve(p);

    const entries = await backend.readdir(subpath);

    // Check for child mounts — add their mount-point names
    const normalized = path.normalize(p);
    const childNames = new Set(entries);
    for (const [mount] of this._mounts) {
      if (mount === '/') continue;
      const parent = path.dirname(mount);
      if (parent === normalized) {
        childNames.add(path.basename(mount));
      }
    }

    const result = [...childNames].sort();

    if (opts && opts.stat) {
      const detailed = [];
      for (const name of result) {
        const childPath = normalized === '/' ? '/' + name : normalized + '/' + name;
        try {
          const info = await this.stat(childPath);
          detailed.push({ name, ...info });
        } catch {
          detailed.push({ name, type: 'unknown' });
        }
      }
      return detailed;
    }
    return result;
  }

  async stat(p, opts) {
    const principal = opts?.principal;
    checkPermission('stat', p, principal);
    const { backend, subpath } = this.resolve(p);
    return backend.stat(subpath);
  }

  async lstat(p, opts) {
    const principal = opts?.principal;
    checkPermission('lstat', p, principal);
    const { backend, subpath } = this.resolve(p);
    return backend.lstat(subpath);
  }

  async unlink(p, opts) {
    const principal = opts?.principal;
    checkPermission('unlink', p, principal);
    const { backend, subpath } = this.resolve(p);
    this._checkWrite(backend, p);
    await backend.unlink(subpath);
    this.emit('delete', { path: path.normalize(p) });
  }

  async rmdir(p, opts) {
    const principal = opts?.principal;
    checkPermission('rmdir', p, principal);
    const { backend, subpath } = this.resolve(p);
    this._checkWrite(backend, p);
    await backend.rmdir(subpath);
    this.emit('delete', { path: path.normalize(p) });
  }

  async rm(p, opts) {
    const principal = opts?.principal;
    checkPermission('rm', p, principal);
    const { backend, subpath } = this.resolve(p);
    this._checkWrite(backend, p);
    if (opts && opts.recursive) {
      await this._rmRecursive(p, backend, subpath);
    } else {
      const info = await backend.stat(subpath);
      if (info.type === 'directory') throw vfsError('EISDIR', p);
      await backend.unlink(subpath);
      this.emit('delete', { path: path.normalize(p) });
    }
  }

  async _rmRecursive(absPath, backend, subpath) {
    const info = await backend.stat(subpath);
    if (info.type === 'directory') {
      const entries = await backend.readdir(subpath);
      for (const name of entries) {
        const childSub = subpath === '/' ? '/' + name : subpath + '/' + name;
        const childAbs = absPath === '/' ? '/' + name : absPath + '/' + name;
        await this._rmRecursive(childAbs, backend, childSub);
      }
      await backend.rmdir(subpath);
    } else {
      await backend.unlink(subpath);
    }
    this.emit('delete', { path: path.normalize(absPath) });
  }

  async rename(oldP, newP, opts) {
    const principal = opts?.principal;
    checkPermission('rename', oldP, principal);
    checkPermission('rename', newP, principal);
    const src = this.resolve(oldP);
    const dst = this.resolve(newP);

    if (src.backend === dst.backend) {
      this._checkWrite(src.backend, oldP);
      await src.backend.rename(src.subpath, dst.subpath);
      this.emit('rename', { oldPath: path.normalize(oldP), newPath: path.normalize(newP) });
    } else {
      // Cross-mount: copy + delete (not atomic — emit write + delete, not rename)
      this._checkWrite(dst.backend, newP);
      this._checkWrite(src.backend, oldP);
      const info = await src.backend.stat(src.subpath);
      if (info.type === 'directory') {
        await this._crossMountCpRecursive(src.backend, src.subpath, dst.backend, dst.subpath);
        await this._rmRecursiveBackend(src.backend, src.subpath);
      } else {
        const content = await src.backend.readFile(src.subpath, 'bytes');
        await dst.backend.writeFile(dst.subpath, content);
        await src.backend.unlink(src.subpath);
      }
      this.emit('write', { path: path.normalize(newP) });
      this.emit('delete', { path: path.normalize(oldP) });
    }
  }

  async _crossMountCpRecursive(srcBackend, srcPath, dstBackend, dstPath) {
    try { await dstBackend.mkdir(dstPath); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const entries = await srcBackend.readdir(srcPath);
    for (const name of entries) {
      const srcChild = srcPath === '/' ? '/' + name : srcPath + '/' + name;
      const dstChild = dstPath === '/' ? '/' + name : dstPath + '/' + name;
      const info = await srcBackend.stat(srcChild);
      if (info.type === 'directory') {
        await this._crossMountCpRecursive(srcBackend, srcChild, dstBackend, dstChild);
      } else {
        const content = await srcBackend.readFile(srcChild, 'bytes');
        await dstBackend.writeFile(dstChild, content);
      }
    }
  }

  async _rmRecursiveBackend(backend, subpath) {
    const info = await backend.stat(subpath);
    if (info.type === 'directory') {
      const entries = await backend.readdir(subpath);
      for (const name of entries) {
        await this._rmRecursiveBackend(backend, subpath === '/' ? '/' + name : subpath + '/' + name);
      }
      await backend.rmdir(subpath);
    } else {
      await backend.unlink(subpath);
    }
  }

  async exists(p, opts) {
    try { await this.stat(p, opts); return true; }
    catch { return false; }
  }

  async touch(p, opts) {
    const principal = opts?.principal;
    checkPermission('touch', p, principal);
    const { backend, subpath } = this.resolve(p);
    this._checkWrite(backend, p);
    await backend.touch(subpath);
    this.emit('write', { path: path.normalize(p) });
  }

  async cp(src, dst, opts) {
    const principal = opts?.principal;
    checkPermission('readFile', src, principal);
    checkPermission('writeFile', dst, principal);
    const srcR = this.resolve(src);
    const dstR = this.resolve(dst);
    this._checkWrite(dstR.backend, dst);

    if (srcR.backend === dstR.backend) {
      await srcR.backend.cp(srcR.subpath, dstR.subpath, opts);
    } else {
      const info = await srcR.backend.stat(srcR.subpath);
      if (info.type === 'directory') {
        if (!opts || !opts.recursive) throw vfsError('EISDIR', src);
        await this._crossMountCpRecursive(srcR.backend, srcR.subpath, dstR.backend, dstR.subpath);
      } else {
        const content = await srcR.backend.readFile(srcR.subpath, 'bytes');
        await dstR.backend.writeFile(dstR.subpath, content);
      }
    }
    this.emit('write', { path: path.normalize(dst) });
  }

  async symlink(target, p, opts) {
    const principal = opts?.principal;
    checkPermission('symlink', p, principal);
    const { backend, subpath } = this.resolve(p);
    this._checkWrite(backend, p);
    if (!backend.symlinks) throw vfsError('ENOTSUP', p, 'backend does not support symlinks');
    await backend.symlink(target, subpath);
    this.emit('write', { path: path.normalize(p) });
  }

  async readlink(p, opts) {
    const principal = opts?.principal;
    checkPermission('readlink', p, principal);
    const { backend, subpath } = this.resolve(p);
    if (!backend.symlinks) throw vfsError('ENOTSUP', p, 'backend does not support symlinks');
    return backend.readlink(subpath);
  }

  async chmod(p, mode, opts) {
    const principal = opts?.principal;
    checkPermission('chmod', p, principal);
    const { backend, subpath } = this.resolve(p);
    this._checkWrite(backend, p);
    if (!backend.chmod) throw vfsError('ENOTSUP', p);
    await backend.chmod(subpath, mode);
  }

  async chown(p, owner, group, opts) {
    const principal = opts?.principal;
    checkPermission('chown', p, principal);
    const { backend, subpath } = this.resolve(p);
    this._checkWrite(backend, p);
    if (!backend.chown) throw vfsError('ENOTSUP', p);
    await backend.chown(subpath, owner, group);
  }

  async glob(pattern, opts) {
    return vfsGlob(this, pattern);
  }

  async du(p) {
    let files = 0, directories = 0, bytes = 0;
    const walk = async (dir) => {
      const entries = await this.readdir(dir);
      for (const name of entries) {
        const full = dir === '/' ? '/' + name : dir + '/' + name;
        const info = await this.stat(full);
        if (info.type === 'directory') {
          directories++;
          await walk(full);
        } else {
          files++;
          bytes += info.size || 0;
        }
      }
    };
    // Check if p is a directory
    const info = await this.stat(p);
    if (info.type === 'directory') {
      directories++;
      await walk(p);
    } else {
      files = 1;
      bytes = info.size || 0;
    }
    return { files, directories, bytes };
  }

  async estimate(p) {
    const { backend } = this.resolve(p);
    if (backend.estimate) return backend.estimate();
    return { used: 0, available: Infinity };
  }

  async export(p) {
    const { backend, subpath } = this.resolve(p);
    if (!backend.export) throw vfsError('ENOTSUP', p);
    return backend.export(subpath);
  }

  async import(p, data) {
    const { backend, subpath } = this.resolve(p);
    this._checkWrite(backend, p);
    if (!backend.import) throw vfsError('ENOTSUP', p);
    await backend.import(subpath, data);
    this.emit('write', { path: path.normalize(p) });
  }

  createReadStream(p, opts) {
    const { backend, subpath } = this.resolve(p);
    return backend.createReadStream(subpath, opts);
  }

  async createWriter(p, opts) {
    const { backend, subpath } = this.resolve(p);
    this._checkWrite(backend, p);
    return backend.createWriter(subpath, opts);
  }

  async writeFrom(p, iterable) {
    const { backend, subpath } = this.resolve(p);
    this._checkWrite(backend, p);
    const writer = backend.createWriter?.(subpath);
    if (writer) {
      for await (const chunk of iterable) writer.write(chunk);
      await writer.close();
    } else {
      // Fallback: collect and writeFile
      const chunks = [];
      for await (const chunk of iterable) chunks.push(chunk);
      if (chunks.length === 0) {
        await backend.writeFile(subpath, '');
      } else if (typeof chunks[0] === 'string') {
        await backend.writeFile(subpath, chunks.join(''));
      } else {
        // Concatenate Uint8Arrays
        const total = chunks.reduce((s, c) => s + c.byteLength, 0);
        const result = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) { result.set(c, offset); offset += c.byteLength; }
        await backend.writeFile(subpath, result);
      }
    }
    this.emit('write', { path: path.normalize(p) });
  }
}

export { VFS };
