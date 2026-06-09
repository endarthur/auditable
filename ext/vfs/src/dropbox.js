import { vfsError, VFSError } from './error.js';
import { Backend } from './backend.js';

// DropboxBackend — a cloud VFS backend over the Dropbox HTTP API. A peer of RESTBackend:
// zero deps (just fetch), stateless about auth. The consumer (weir / auditable) owns PKCE
// OAuth and injects `getToken`; the backend calls it per request and never touches OAuth.
// Spec: spec_inbox/vfs-dropbox-backend-spec.md.

const API = 'https://api.dropboxapi.com/2/';
const CONTENT = 'https://content.dropboxapi.com/2/';
const NOTIFY = 'https://notify.dropboxapi.com/2/';

class DropboxBackend extends Backend {
  static type = 'dropbox';

  // { getToken: () => Promise<string>, root?: string }
  constructor(config) {
    super();
    this._getToken = config && config.getToken;
    this._root = (config && config.root) || '';
  }

  // getToken is a function (the consumer owns OAuth) → non-serializable, so a worker
  // can't reconstruct us → null → @gcu/proc falls back to RPC. Mirrors RESTBackend's
  // function-headers case.
  toConfig() {
    if (typeof this._getToken === 'function') return null;
    return { type: 'dropbox', root: this._root };
  }

  // Mount-relative path → Dropbox path. '' is the (app/subtree) root; otherwise a
  // leading-slash path with no trailing slash. `root` prefixes the addressed subtree.
  _dpath(p) {
    const combined = (this._root || '') + (p === '/' ? '' : p);
    const norm = combined.replace(/\/+/g, '/').replace(/\/+$/, '');
    return norm === '/' ? '' : norm;
  }

  async _authHeader() {
    return 'Bearer ' + (await this._getToken());
  }

  // JSON-RPC endpoints (api.dropboxapi.com/2/*).
  async _rpc(endpoint, arg, p) {
    const headers = { Authorization: await this._authHeader() };
    let body;
    if (arg !== undefined && arg !== null) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(arg);
    }
    const resp = await fetch(API + endpoint, { method: 'POST', headers, body });
    if (!resp.ok) throw await this._mapError(resp, p);
    const text = await resp.text();
    return text ? JSON.parse(text) : null;
  }

  // Content endpoints (content.dropboxapi.com/2/*) — arg rides the Dropbox-API-Arg header.
  async _content(endpoint, arg, p, opts = {}) {
    const headers = { Authorization: await this._authHeader(), 'Dropbox-API-Arg': JSON.stringify(arg) };
    if (opts.contentType) headers['Content-Type'] = opts.contentType;
    const resp = await fetch(CONTENT + endpoint, { method: 'POST', headers, body: opts.body });
    if (!resp.ok) throw await this._mapError(resp, p);
    return resp;
  }

  // Dropbox 409s carry a (possibly nested) error['.tag']; map to vfsError codes.
  async _mapError(resp, p) {
    if (resp.status === 401) return vfsError('EACCES', p, 'dropbox token rejected');
    let raw = '';
    try { raw = await resp.text(); } catch { /* */ }
    let summary = raw, tagChain = raw;
    try {
      const j = JSON.parse(raw);
      summary = j.error_summary || raw;
      tagChain = JSON.stringify(j.error != null ? j.error : raw);
    } catch { /* not JSON */ }
    if (/not_found/.test(tagChain)) return vfsError('ENOENT', p);
    if (/conflict/.test(tagChain)) return vfsError('EEXIST', p);
    return new VFSError('EIO', p, `dropbox: ${summary || resp.status}`);
  }

  async init() {
    // No-op. The token is exercised on the first real call; nothing to validate eagerly.
  }

  async readFile(p, encoding) {
    const resp = await this._content('files/download', { path: this._dpath(p) }, p);
    if (encoding === 'bytes') return new Uint8Array(await resp.arrayBuffer());
    return await resp.text();
  }

  async writeFile(p, content) {
    await this._content(
      'files/upload',
      { path: this._dpath(p), mode: 'overwrite', mute: true },
      p,
      { body: content, contentType: 'application/octet-stream' },
    );
  }

  async stat(p) {
    const dp = this._dpath(p);
    // get_metadata rejects '' — the (app/subtree) root is always a directory.
    if (dp === '') return { type: 'directory', size: 0 };
    const m = await this._rpc('files/get_metadata', { path: dp }, p);
    if (m['.tag'] === 'folder') {
      return { type: 'directory', size: 0, modified: new Date(), created: new Date() };
    }
    const modified = m.server_modified ? new Date(m.server_modified) : new Date();
    return {
      type: 'file',
      size: m.size || 0,
      modified,
      created: m.client_modified ? new Date(m.client_modified) : modified,
    };
  }

  async readdir(p) {
    let res = await this._rpc('files/list_folder', { path: this._dpath(p) }, p);
    const names = res.entries.map((e) => e.name);
    while (res.has_more) {
      res = await this._rpc('files/list_folder/continue', { cursor: res.cursor }, p);
      for (const e of res.entries) names.push(e.name);
    }
    return names;
  }

  async mkdir(p) {
    // Conflict → _mapError yields EEXIST, which base.import / _cpRecursive tolerate.
    await this._rpc('files/create_folder_v2', { path: this._dpath(p) }, p);
  }

  // delete_v2 handles both files and folders.
  async unlink(p) { await this._rpc('files/delete_v2', { path: this._dpath(p) }, p); }
  async rmdir(p) { await this._rpc('files/delete_v2', { path: this._dpath(p) }, p); }

  // Real server-side move (atomic — unlike RESTBackend's GET→PUT→DELETE).
  async rename(oldP, newP) {
    await this._rpc('files/move_v2', { from_path: this._dpath(oldP), to_path: this._dpath(newP) }, oldP);
  }

  // ── Change feed (for a sync engine's pull) — keeps all Dropbox-API knowledge here. ──
  async latestCursor() {
    const res = await this._rpc('files/list_folder/get_latest_cursor', { path: this._root || '', recursive: true }, '/');
    return res.cursor;
  }

  async changes(cursor) {
    const res = await this._rpc('files/list_folder/continue', { cursor }, '/');
    return { entries: res.entries, cursor: res.cursor, has_more: res.has_more };
  }

  async longpoll(cursor, timeout = 30) {
    // The longpoll endpoint is UNauthenticated by design — send no Authorization header.
    const resp = await fetch(NOTIFY + 'files/list_folder/longpoll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cursor, timeout }),
    });
    if (!resp.ok) throw await this._mapError(resp, '/');
    const j = await resp.json();
    return { changes: !!j.changes };
  }

  get persistent() { return true; }
}

export { DropboxBackend };
