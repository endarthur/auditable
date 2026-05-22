import { Backend } from './backend.js';

// An A-Bus-proxy VFS backend. Forwards every operation to a remote VFS
// service (the Auditable Works `works` service) over an A-Bus connection.
//
// Duck-typed on the bus handle: it only ever calls `bus.call(address, args)`,
// so @gcu/vfs takes no dependency on @gcu/abus — any object with a matching
// `.call()` works.
//
//   new AbusBackend({ bus, service: 'works', root: '' })
//
// `root` is prepended to every path before the remote call, so the backend
// can be mounted at one VFS path while addressing a different subtree of the
// remote filesystem (mount at /projects/self, root '/projects/<realname>').
class AbusBackend extends Backend {
  static type = 'abus';

  constructor(config) {
    super();
    this._bus = config.bus;
    this._service = config.service || 'works';
    this._root = config.root || '';
  }

  // Mount-relative path (leading slash) → remote workspace path.
  _remote(p) {
    return this._root + p;
  }

  _call(member, args) {
    return this._bus.call(
      { to: this._service, path: '/', interface: 'VFS', member },
      args);
  }

  async readFile(p, encoding) {
    return this._call('Read', [this._remote(p), encoding]);
  }

  async writeFile(p, content) {
    await this._call('Write', [this._remote(p), content]);
  }

  async readdir(p) {
    return this._call('List', [this._remote(p)]);
  }

  async stat(p) {
    return this._call('Stat', [this._remote(p)]);
  }

  // Use the service's Exists directly — avoids depending on ENOENT error
  // codes surviving the A-Bus round-trip (the base Backend.exists would).
  async exists(p) {
    return this._call('Exists', [this._remote(p)]);
  }

  async mkdir(p) {
    await this._call('MkDir', [this._remote(p)]);
  }

  async unlink(p) {
    await this._call('Delete', [this._remote(p)]);
  }

  async rmdir(p) {
    await this._call('Delete', [this._remote(p)]);
  }

  async rename(oldP, newP) {
    await this._call('Move', [this._remote(oldP), this._remote(newP)]);
  }

  get persistent() { return true; }
}

export { AbusBackend };
