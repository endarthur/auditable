import { vfsError } from './error.js';
import { Backend } from './backend.js';
import { path } from './path.js';
import { _httpUrl, _httpHeaders, _httpError } from './fetch-backend.js';

class RESTBackend extends Backend {
  static type = 'rest';

  constructor(config) {
    super();
    this._base = (config && config.base) || '';
    this._headersCfg = config && config.headers;
    this._credentials = config && config.credentials;
  }

  async _fetch(p, opts) {
    const url = _httpUrl(this._base, p);
    const headers = await _httpHeaders(this._headersCfg);
    const fetchOpts = { ...opts, headers: { ...headers, ...(opts && opts.headers) } };
    if (this._credentials) fetchOpts.credentials = this._credentials;
    const resp = await fetch(url, fetchOpts);
    if (!resp.ok) throw _httpError(resp, p);
    return resp;
  }

  async readFile(p, encoding) {
    const resp = await this._fetch(p, { method: 'GET' });
    if (encoding === 'bytes') {
      const buf = await resp.arrayBuffer();
      return new Uint8Array(buf);
    }
    return await resp.text();
  }

  async writeFile(p, content) {
    await this._fetch(p, {
      method: 'PUT',
      body: content,
    });
  }

  async stat(p) {
    const url = _httpUrl(this._base, p);
    const headers = await _httpHeaders(this._headersCfg);
    const fetchOpts = { method: 'HEAD', headers };
    if (this._credentials) fetchOpts.credentials = this._credentials;
    const resp = await fetch(url, fetchOpts);
    if (!resp.ok) throw _httpError(resp, p);
    const size = parseInt(resp.headers.get('Content-Length') || '0', 10);
    const lastMod = resp.headers.get('Last-Modified');
    return {
      type: 'file',
      size: isNaN(size) ? 0 : size,
      modified: lastMod ? new Date(lastMod) : new Date(),
      created: lastMod ? new Date(lastMod) : new Date(),
    };
  }

  async mkdir(p) {
    const n = path.normalize(p);
    // Trailing slash signals directory creation
    await this._fetch(n + '/', { method: 'PUT' });
  }

  async readdir(p) {
    const n = path.normalize(p);
    const resp = await this._fetch(n + '/', { method: 'GET' });
    return await resp.json();
  }

  async unlink(p) {
    await this._fetch(p, { method: 'DELETE' });
  }

  async rmdir(p) {
    const n = path.normalize(p);
    await this._fetch(n + '/', { method: 'DELETE' });
  }

  async rename(oldP, newP) {
    // Not atomic: GET old → PUT new → DELETE old
    const content = await this.readFile(oldP, 'bytes');
    await this.writeFile(newP, content);
    await this.unlink(oldP);
  }

  createReadStream(p) {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        const streamPromise = self._fetch(p, { method: 'GET' }).then(r => r.body);
        let reader;
        return {
          async next() {
            if (!reader) {
              const stream = await streamPromise;
              reader = stream.getReader();
            }
            const { done, value } = await reader.read();
            return { done, value };
          }
        };
      }
    };
  }

  get persistent() { return true; }
  get streamable() { return true; }
}

export { RESTBackend };
