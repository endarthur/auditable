import { vfsError } from './error.js';
import { path } from './path.js';
import { Backend } from './backend.js';

const MAX_SYMLINK_DEPTH = 40;

function _makeNode(type, content) {
  const now = new Date();
  const node = {
    _meta: {
      type,
      size: 0,
      created: now,
      modified: now,
      mode: type === 'directory' ? 0o755 : 0o644,
      owner: 'user',
      group: 'staff',
    },
  };
  if (type === 'directory') {
    node._children = new Map();
  } else if (type === 'file') {
    node._content = content !== undefined ? content : '';
    node._meta.size = typeof node._content === 'string'
      ? new TextEncoder().encode(node._content).byteLength
      : node._content.byteLength;
  } else if (type === 'symlink') {
    node._target = content || '';
  }
  return node;
}

class MemoryBackend extends Backend {
  static type = 'memory';

  constructor() {
    super();
    this._root = _makeNode('directory');
  }

  _segments(p) {
    const n = path.normalize(p);
    if (n === '/') return [];
    return n.split('/').filter(Boolean);
  }

  _resolve(p, followSymlinks = true) {
    const segs = this._segments(p);
    let node = this._root;
    let depth = 0;

    for (let i = 0; i < segs.length; i++) {
      // Follow symlink if current node is a symlink
      if (followSymlinks && node._meta.type === 'symlink') {
        const target = node._target;
        node = this._resolve(target, true);
        depth++;
        if (depth > MAX_SYMLINK_DEPTH) throw vfsError('ENOENT', p, 'too many symlinks');
      }

      if (node._meta.type !== 'directory') {
        throw vfsError('ENOTDIR', p);
      }

      const child = node._children.get(segs[i]);
      if (!child) throw vfsError('ENOENT', p);
      node = child;
    }

    // Follow final symlink
    if (followSymlinks && node._meta.type === 'symlink') {
      depth++;
      if (depth > MAX_SYMLINK_DEPTH) throw vfsError('ENOENT', p, 'too many symlinks');
      node = this._resolve(node._target, true);
    }

    return node;
  }

  _resolveParent(p) {
    const segs = this._segments(p);
    if (segs.length === 0) throw vfsError('EEXIST', '/');
    const name = segs.pop();
    let node = this._root;
    for (const seg of segs) {
      if (node._meta.type === 'symlink') {
        node = this._resolve(node._target, true);
      }
      if (node._meta.type !== 'directory') throw vfsError('ENOTDIR', p);
      const child = node._children.get(seg);
      if (!child) throw vfsError('ENOENT', p);
      node = child;
    }
    if (node._meta.type === 'symlink') {
      node = this._resolve(node._target, true);
    }
    if (node._meta.type !== 'directory') throw vfsError('ENOTDIR', p);
    return [node, name];
  }

  async readFile(p, encoding) {
    const node = this._resolve(p);
    if (node._meta.type === 'directory') throw vfsError('EISDIR', p);
    if (node._meta.type === 'symlink') throw vfsError('ENOENT', p);
    const content = node._content;
    if (encoding === 'bytes') {
      if (content instanceof Uint8Array) return new Uint8Array(content);
      return new TextEncoder().encode(content);
    }
    if (content instanceof Uint8Array) return new TextDecoder().decode(content);
    return content;
  }

  // Resident bytes → a range is a cheap subarray (no re-read).
  get rangeReadable() { return true; }
  async readRange(p, offset, length) {
    const b = await this.readFile(p, 'bytes');
    return b.subarray(offset, offset + length);
  }

  async writeFile(p, content) {
    const [parent, name] = this._resolveParent(p);
    const existing = parent._children.get(name);
    if (existing && existing._meta.type === 'directory') throw vfsError('EISDIR', p);

    const node = existing || _makeNode('file');
    node._content = content;
    node._meta.type = 'file';
    node._meta.modified = new Date();
    node._meta.size = typeof content === 'string'
      ? new TextEncoder().encode(content).byteLength
      : (content instanceof Uint8Array ? content.byteLength : 0);
    if (!existing) {
      node._meta.created = new Date();
    }
    parent._children.set(name, node);
  }

  async unlink(p) {
    const [parent, name] = this._resolveParent(p);
    const child = parent._children.get(name);
    if (!child) throw vfsError('ENOENT', p);
    if (child._meta.type === 'directory') throw vfsError('EISDIR', p);
    parent._children.delete(name);
  }

  async rename(oldP, newP) {
    const [oldParent, oldName] = this._resolveParent(oldP);
    const child = oldParent._children.get(oldName);
    if (!child) throw vfsError('ENOENT', oldP);

    const [newParent, newName] = this._resolveParent(newP);
    const existingNew = newParent._children.get(newName);

    // Can't overwrite a non-empty directory
    if (existingNew && existingNew._meta.type === 'directory' && existingNew._children.size > 0) {
      throw vfsError('ENOTEMPTY', newP);
    }
    // Can't overwrite a directory with a file
    if (existingNew && existingNew._meta.type === 'directory' && child._meta.type !== 'directory') {
      throw vfsError('EISDIR', newP);
    }

    oldParent._children.delete(oldName);
    child._meta.modified = new Date();
    newParent._children.set(newName, child);
  }

  async stat(p) {
    const node = this._resolve(p);
    const m = node._meta;
    return {
      type: m.type,
      size: m.size,
      created: m.created,
      modified: m.modified,
      mode: m.mode,
      owner: m.owner,
      group: m.group,
    };
  }

  async lstat(p) {
    const node = this._resolve(p, false);
    const m = node._meta;
    const result = {
      type: m.type,
      size: m.size,
      created: m.created,
      modified: m.modified,
      mode: m.mode,
      owner: m.owner,
      group: m.group,
    };
    if (m.type === 'symlink') result.target = node._target;
    return result;
  }

  async mkdir(p, opts) {
    if (opts && opts.recursive) return this._mkdirRecursive(p);
    const [parent, name] = this._resolveParent(p);
    if (parent._children.has(name)) throw vfsError('EEXIST', p);
    parent._children.set(name, _makeNode('directory'));
  }

  async _mkdirRecursive(p) {
    const segs = this._segments(p);
    let node = this._root;
    for (const seg of segs) {
      if (node._meta.type !== 'directory') throw vfsError('ENOTDIR', p);
      if (!node._children.has(seg)) {
        node._children.set(seg, _makeNode('directory'));
      }
      node = node._children.get(seg);
    }
  }

  async readdir(p) {
    const node = this._resolve(p);
    if (node._meta.type !== 'directory') throw vfsError('ENOTDIR', p);
    return [...node._children.keys()].sort();
  }

  async rmdir(p) {
    const [parent, name] = this._resolveParent(p);
    const child = parent._children.get(name);
    if (!child) throw vfsError('ENOENT', p);
    if (child._meta.type !== 'directory') throw vfsError('ENOTDIR', p);
    if (child._children.size > 0) throw vfsError('ENOTEMPTY', p);
    parent._children.delete(name);
  }

  async symlink(target, p) {
    const [parent, name] = this._resolveParent(p);
    if (parent._children.has(name)) throw vfsError('EEXIST', p);
    const node = _makeNode('symlink', target);
    parent._children.set(name, node);
  }

  async readlink(p) {
    const node = this._resolve(p, false);
    if (node._meta.type !== 'symlink') throw vfsError('ENOENT', p, 'not a symlink');
    return node._target;
  }

  async chmod(p, mode) {
    const node = this._resolve(p);
    node._meta.mode = mode;
  }

  async chown(p, owner, group) {
    const node = this._resolve(p);
    if (owner !== undefined) node._meta.owner = owner;
    if (group !== undefined) node._meta.group = group;
  }

  async estimate() {
    return { used: this._calcSize(this._root), available: Infinity };
  }

  _calcSize(node) {
    if (node._meta.type === 'file') return node._meta.size;
    if (node._meta.type !== 'directory') return 0;
    let total = 0;
    for (const child of node._children.values()) {
      total += this._calcSize(child);
    }
    return total;
  }

  get symlinks() { return true; }
}

export { MemoryBackend };
