import { vfsError } from './error.js';
import { HandleBackend } from './handle.js';

class FSAABackend extends HandleBackend {
  static type = 'fsaa';

  constructor(config) {
    super(config && config.handle);
  }

  async init() {
    if (!this._root) {
      throw vfsError('ENOTSUP', '/', 'no directory handle provided');
    }
  }

  async queryPermission(mode) {
    if (this._root.queryPermission) {
      return this._root.queryPermission({ mode: mode || 'read' });
    }
    return 'granted';
  }

  async requestPermission(mode) {
    if (this._root.requestPermission) {
      return this._root.requestPermission({ mode: mode || 'read' });
    }
    return 'granted';
  }
}

export { FSAABackend };
