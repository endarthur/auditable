import { vfsError } from './error.js';
import { Backend } from './backend.js';
import { path } from './path.js';

// -- Shared HTTP helpers (also used by rest.js via concatenation) --

function _httpUrl(base, p) {
  const normalized = path.normalize(p);
  const stripped = normalized === '/' ? '' : normalized;
  // Remove trailing slash from base, then join
  const b = base.replace(/\/+$/, '');
  // Preserve explicit trailing slash from caller (e.g. REST dir ops)
  const trailingSlash = p.length > 1 && p.endsWith('/') && !stripped.endsWith('/');
  return b + stripped + (trailingSlash ? '/' : '');
}

async function _httpHeaders(cfg) {
  if (!cfg) return {};
  if (typeof cfg === 'function') return await cfg();
  return cfg;
}

function _httpError(resp, p) {
  const status = resp.status;
  if (status === 404) return vfsError('ENOENT', p);
  if (status === 401 || status === 403) return vfsError('EACCES', p);
  if (status === 409) return vfsError('EEXIST', p);
  if (status === 413 || status === 507) return vfsError('ENOSPC', p);
  return vfsError('ENOTSUP', p, `HTTP ${status}`);
}

// -- FetchBackend --

class FetchBackend extends Backend {
  static type = 'fetch';

  constructor(config) {
    super();
    this._base = (config && config.base) || '';
    this._index = config && config.index;
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
    const resp = await this._fetch(p);
    if (encoding === 'bytes') {
      const buf = await resp.arrayBuffer();
      return new Uint8Array(buf);
    }
    return await resp.text();
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

  async readdir(p) {
    if (!this._index) throw vfsError('ENOENT', p, 'no index configured');
    const n = path.normalize(p);
    const indexPath = n === '/' ? '/' + this._index : n + '/' + this._index;
    const resp = await this._fetch(indexPath);
    return await resp.json();
  }

  createReadStream(p) {
    // Return a promise-wrapped stream
    const self = this;
    return {
      async getReader() {
        const resp = await self._fetch(p);
        return resp.body.getReader();
      },
      [Symbol.asyncIterator]() {
        const streamPromise = self._fetch(p).then(r => r.body);
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

  // All write ops throw EACCES
  async writeFile(p) { throw vfsError('EACCES', p, 'read-only backend'); }
  async mkdir(p) { throw vfsError('EACCES', p, 'read-only backend'); }
  async unlink(p) { throw vfsError('EACCES', p, 'read-only backend'); }
  async rmdir(p) { throw vfsError('EACCES', p, 'read-only backend'); }
  async rename(p) { throw vfsError('EACCES', p, 'read-only backend'); }
  async touch(p) { throw vfsError('EACCES', p, 'read-only backend'); }

  get readonly() { return true; }
  get persistent() { return false; }
  get streamable() { return true; }
}

export { FetchBackend, _httpUrl, _httpHeaders, _httpError };
