class Backend {
  static type = 'base';

  async init() {}
  async destroy() {}

  async exists(p) {
    try { await this.stat(p); return true; }
    catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  }

  async cp(src, dst, opts) {
    const info = await this.stat(src);
    if (info.type === 'directory') {
      if (!opts || !opts.recursive) throw vfsError('EISDIR', src);
      await this._cpRecursive(src, dst);
    } else {
      const isBytes = info._binary;
      const content = await this.readFile(src, isBytes ? 'bytes' : 'utf8');
      try { await this.mkdir(dst.split('/').slice(0, -1).join('/') || '/'); } catch {}
      await this.writeFile(dst, content);
    }
  }

  async _cpRecursive(src, dst) {
    try { await this.mkdir(dst); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const entries = await this.readdir(src);
    for (const name of entries) {
      const srcChild = src === '/' ? '/' + name : src + '/' + name;
      const dstChild = dst === '/' ? '/' + name : dst + '/' + name;
      const info = await this.stat(srcChild);
      if (info.type === 'directory') {
        await this._cpRecursive(srcChild, dstChild);
      } else {
        const content = await this.readFile(srcChild, info._binary ? 'bytes' : 'utf8');
        await this.writeFile(dstChild, content);
      }
    }
  }

  async touch(p) {
    try {
      const info = await this.stat(p);
      if (info.type === 'file') {
        // Update mtime — re-read and re-write
        const content = await this.readFile(p, 'bytes');
        await this.writeFile(p, content);
      }
    } catch (e) {
      if (e.code === 'ENOENT') {
        await this.writeFile(p, '');
      } else throw e;
    }
  }

  async lstat(p) {
    return this.stat(p);
  }

  async export(basePath) {
    const result = {};
    const _walk = async (dir, prefix) => {
      const entries = await this.readdir(dir);
      for (const name of entries) {
        const full = dir === '/' ? '/' + name : dir + '/' + name;
        const rel = prefix ? prefix + '/' + name : name;
        const info = await this.stat(full);
        if (info.type === 'directory') {
          await _walk(full, rel);
        } else {
          const content = await this.readFile(full);
          result[rel] = content;
        }
      }
    };
    await _walk(basePath, '');
    return result;
  }

  async import(basePath, data) {
    // Collect and sort paths so directories come first
    const paths = Object.keys(data).sort();
    const createdDirs = new Set();
    for (const rel of paths) {
      const full = basePath === '/' ? '/' + rel : basePath + '/' + rel;
      // Ensure parent directories exist
      const parts = rel.split('/');
      for (let i = 1; i < parts.length; i++) {
        const dir = basePath === '/'
          ? '/' + parts.slice(0, i).join('/')
          : basePath + '/' + parts.slice(0, i).join('/');
        if (!createdDirs.has(dir)) {
          try { await this.mkdir(dir); } catch (e) { if (e.code !== 'EEXIST') throw e; }
          createdDirs.add(dir);
        }
      }
      await this.writeFile(full, data[rel]);
    }
  }

  createReadStream() { return null; }
  createWriter() { return null; }

  get readonly() { return false; }
  get persistent() { return false; }
  get streamable() { return false; }
  get estimatable() { return false; }
  get exportable() { return true; }
  get portable() { return false; }
  get symlinks() { return false; }
}

export { Backend };
