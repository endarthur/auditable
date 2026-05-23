import { vfsError } from './error.js';
import { HandleBackend } from './handle.js';

class OPFSBackend extends HandleBackend {
  static type = 'opfs';

  constructor(config) {
    super(null);
    this._fallbackConfig = config && config.fallback;
    this._fallback = null;
  }

  toConfig() {
    // Real OPFS replicates fine: the worker gets its own origin-private
    // directory from navigator.storage.getDirectory() — same handle as
    // the main thread. When running in fallback mode (no OPFS available
    // in this context), we can't replicate because the fallback could
    // itself be non-replicable; let proc proxy instead.
    if (this._fallback) return null;
    return { type: 'opfs' };
  }

  async init() {
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.getDirectory) {
      this._root = await navigator.storage.getDirectory();
    } else if (this._fallbackConfig) {
      // Create fallback backend via the factory function set during build
      if (typeof _createBackend === 'function') {
        this._fallback = _createBackend(this._fallbackConfig);
      } else {
        // Standalone usage — try to construct directly
        throw vfsError('ENOTSUP', '/', 'OPFS not available and no backend factory');
      }
      if (this._fallback.init) await this._fallback.init();
    } else {
      throw vfsError('ENOTSUP', '/', 'OPFS not available');
    }
  }

  // Delegate all methods when in fallback mode
  async readFile(p, encoding) {
    if (this._fallback) return this._fallback.readFile(p, encoding);
    return super.readFile(p, encoding);
  }
  async writeFile(p, content) {
    if (this._fallback) return this._fallback.writeFile(p, content);
    return super.writeFile(p, content);
  }
  async stat(p) {
    if (this._fallback) return this._fallback.stat(p);
    return super.stat(p);
  }
  async mkdir(p, opts) {
    if (this._fallback) return this._fallback.mkdir(p, opts);
    return super.mkdir(p, opts);
  }
  async readdir(p) {
    if (this._fallback) return this._fallback.readdir(p);
    return super.readdir(p);
  }
  async rmdir(p) {
    if (this._fallback) return this._fallback.rmdir(p);
    return super.rmdir(p);
  }
  async unlink(p) {
    if (this._fallback) return this._fallback.unlink(p);
    return super.unlink(p);
  }
  async rename(oldP, newP) {
    if (this._fallback) return this._fallback.rename(oldP, newP);
    return super.rename(oldP, newP);
  }
  async touch(p) {
    if (this._fallback) return this._fallback.touch(p);
    return super.touch(p);
  }
  async exists(p) {
    if (this._fallback) return this._fallback.exists(p);
    return super.exists(p);
  }
  createReadStream(p) {
    if (this._fallback) return this._fallback.createReadStream(p);
    return super.createReadStream(p);
  }
  async createWriter(p) {
    if (this._fallback) return this._fallback.createWriter(p);
    return super.createWriter(p);
  }
  async estimate() {
    if (this._fallback) return this._fallback.estimate();
    return super.estimate();
  }
  async chmod(p, mode) {
    if (this._fallback && this._fallback.chmod) return this._fallback.chmod(p, mode);
    return super.chmod(p, mode);
  }
  async chown(p, owner, group) {
    if (this._fallback && this._fallback.chown) return this._fallback.chown(p, owner, group);
    return super.chown(p, owner, group);
  }
  async destroy() {
    if (this._fallback && this._fallback.destroy) return this._fallback.destroy();
  }
  async export(basePath) {
    if (this._fallback && this._fallback.export) return this._fallback.export(basePath);
    return super.export(basePath);
  }
  async import(basePath, data) {
    if (this._fallback && this._fallback.import) return this._fallback.import(basePath, data);
    return super.import(basePath, data);
  }

  // Capabilities delegate to fallback when active
  get persistent() { return this._fallback ? !!this._fallback.persistent : true; }
  get streamable() { return this._fallback ? !!this._fallback.streamable : true; }
  get estimatable() { return this._fallback ? !!this._fallback.estimatable : true; }
  get readonly() { return this._fallback ? !!this._fallback.readonly : false; }
  get portable() { return this._fallback ? !!this._fallback.portable : false; }
  get symlinks() { return this._fallback ? !!this._fallback.symlinks : false; }
}

export { OPFSBackend };
