import { vfsError, VFSError } from './error.js';
import { Backend } from './backend.js';

// DropboxBackend — a cloud VFS backend over the Dropbox HTTP API. A peer of RESTBackend:
// zero deps (just fetch), stateless about auth. The consumer (weir / auditable) owns PKCE
// OAuth and injects `getToken`; the backend calls it per request and never touches OAuth.
// Specs: spec_inbox/vfs-dropbox-backend-spec.md (the backend) + vfs-dropbox-efficiency-spec.md
// (this revision: listTree, writeFiles, centralized 429/Retry-After backpressure).

const API = 'https://api.dropboxapi.com/2/';
const CONTENT = 'https://content.dropboxapi.com/2/';
const NOTIFY = 'https://notify.dropboxapi.com/2/';

class DropboxBackend extends Backend {
  static type = 'dropbox';

  // { getToken: () => Promise<string>, root?: string,
  //   maxRetries?, maxBackoffMs?, tokenTtlMs?, uploadConcurrency?, batchPollMs?, sleep? }
  constructor(config) {
    super();
    const c = config || {};
    this._getToken = c.getToken;
    this._root = c.root || '';
    this._maxRetries = c.maxRetries ?? 6;            // bounded 429/503 retries
    this._maxBackoffMs = c.maxBackoffMs ?? 64000;    // cap any single wait
    this._tokenTtlMs = c.tokenTtlMs ?? 5000;         // brief token cache (refresh seam stays getToken)
    this._uploadConc = c.uploadConcurrency ?? 8;     // in-flight upload_session/start
    this._batchPollMs = c.batchPollMs ?? 1000;       // finish_batch/check poll spacing
    this._sleep = c.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));   // injectable for tests
    this._tok = null; this._tokExp = 0;
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

  // Inverse of _dpath: a Dropbox path_display → the VFS path (strip `root`, leading slash).
  _vpath(dp) {
    let s = dp || '';
    const root = this._root || '';
    if (root && s.slice(0, root.length).toLowerCase() === root.toLowerCase()) s = s.slice(root.length);   // Dropbox is case-insensitive
    if (!s) return '/';
    if (s[0] !== '/') s = '/' + s;
    return s.replace(/\/{2,}/g, '/');
  }

  // Brief token cache: getToken is the OAuth refresh seam, so a burst of calls shouldn't
  // hammer it. Invalidated on a 401 (see _send) and after tokenTtlMs.
  async _authHeader() {
    const now = Date.now();
    if (this._tok && now < this._tokExp) return 'Bearer ' + this._tok;
    this._tok = await this._getToken();
    this._tokExp = now + this._tokenTtlMs;
    return 'Bearer ' + this._tok;
  }

  // Single place that honors Dropbox backpressure for EVERY authenticated call. `make()`
  // rebuilds headers+fetch per attempt (so a refreshed token is picked up). On 429/503 it
  // waits Retry-After (or an exponential fallback) and retries, bounded; on a first 401 it
  // refreshes the token once and retries; otherwise it maps the error.
  async _send(make, p, attempt = 0, refreshed = false) {
    const resp = await make();
    if (resp.ok) return resp;
    const st = resp.status;
    if (st === 401 && !refreshed) { this._tok = null; this._tokExp = 0; return this._send(make, p, attempt, true); }
    if ((st === 429 || st === 503) && attempt < this._maxRetries) {
      await this._sleep(this._retryAfterMs(resp, attempt));
      return this._send(make, p, attempt + 1, refreshed);
    }
    if (st === 429 || st === 503) {
      throw new VFSError('EBUSY', p, 'dropbox rate-limited', { retryAfterMs: this._retryAfterMs(resp, attempt) });
    }
    throw await this._mapError(resp, p);
  }

  // Retry-After header (seconds) → ms, capped; exponential fallback when absent.
  _retryAfterMs(resp, attempt = 0) {
    const h = resp.headers, ra = h && typeof h.get === 'function' ? h.get('Retry-After') : null;
    const s = ra != null && ra !== '' ? parseFloat(ra) : NaN;
    const ms = Number.isFinite(s) ? s * 1000 : 1000 * 2 ** attempt;
    return Math.min(ms, this._maxBackoffMs);
  }

  // JSON-RPC endpoints (api.dropboxapi.com/2/*).
  async _rpc(endpoint, arg, p) {
    const resp = await this._send(async () => {
      const headers = { Authorization: await this._authHeader() };
      let body;
      if (arg !== undefined && arg !== null) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(arg); }
      return fetch(API + endpoint, { method: 'POST', headers, body });
    }, p);
    const text = await resp.text();
    return text ? JSON.parse(text) : null;
  }

  // Content endpoints (content.dropboxapi.com/2/*) — arg rides the Dropbox-API-Arg header.
  async _content(endpoint, arg, p, opts = {}) {
    return this._send(async () => {
      const headers = { Authorization: await this._authHeader(), 'Dropbox-API-Arg': JSON.stringify(arg) };
      if (opts.contentType) headers['Content-Type'] = opts.contentType;
      return fetch(CONTENT + endpoint, { method: 'POST', headers, body: opts.body });
    }, p);
  }

  // Dropbox 409s carry a (possibly nested) error['.tag']; map to vfsError codes. (401/429/503
  // are handled in _send; this is the terminal mapper for everything else.)
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

  // Bulk write — commit many files in FEW write operations via upload_session + finish_batch,
  // far gentler on Dropbox's per-namespace write lock than N files/upload calls. The single
  // writeFile stays for one-offs. Chunks at 1,000 entries (the batch limit).
  async writeFiles(files) {
    if (!files || !files.length) return { committed: 0 };
    let committed = 0;
    for (let i = 0; i < files.length; i += 1000) {
      const chunk = files.slice(i, i + 1000);
      // each file is a one-shot upload session (close:true); these are content uploads (modest
      // concurrency ok) — they don't contend on the commit lock the way files/upload does.
      const sessions = await this._mapLimit(chunk, this._uploadConc, async (f) => {
        const resp = await this._content('files/upload_session/start', { close: true }, f.path, { body: f.content, contentType: 'application/octet-stream' });
        const j = JSON.parse(await resp.text());
        return { session_id: j.session_id, offset: this._byteLen(f.content), path: f.path };
      });
      const entries = sessions.map((s) => ({ cursor: { session_id: s.session_id, offset: s.offset }, commit: { path: this._dpath(s.path), mode: 'overwrite', mute: true } }));
      this._assertBatch(await this._finishBatch(entries), sessions);
      committed += sessions.length;
    }
    return { committed };
  }

  // finish_batch may complete synchronously or hand back an async_job_id to poll via check.
  async _finishBatch(entries) {
    let res = await this._rpc('files/upload_session/finish_batch', { entries }, '/');
    let job = res && res['.tag'] === 'async_job_id' ? res.async_job_id : null;
    while (job) {
      await this._sleep(this._batchPollMs);
      res = await this._rpc('files/upload_session/finish_batch/check', { async_job_id: job }, '/');
      if (res && res['.tag'] === 'complete') job = null;   // else in_progress → keep polling
    }
    return res;   // { '.tag':'complete', entries:[…] }
  }

  // A completed batch lists a per-entry .tag; surface any non-'success' as EIO with the paths.
  _assertBatch(result, sessions) {
    const entries = (result && result.entries) || [];
    const failed = [];
    entries.forEach((e, i) => { if (e && e['.tag'] && e['.tag'] !== 'success') failed.push(sessions[i] ? sessions[i].path : String(i)); });
    if (failed.length) throw new VFSError('EIO', failed[0], `dropbox: ${failed.length} file(s) failed to commit`, { failed });
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
      contentHash: m.content_hash,   // Dropbox's byte hash → consumers skip re-downloading identical files
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

  // One paginated sweep of a whole subtree (list_folder recursive) → RICH entries (so the caller
  // never needs a per-file stat) PLUS the cursor (valid for changes() — go straight to incremental
  // afterward, no separate get_latest_cursor). Replaces a readdir+per-file-stat walk: minutes → ~1 call.
  async listTree(p) {
    let res;
    try {
      res = await this._rpc('files/list_folder', { path: this._dpath(p), recursive: true }, p);
    } catch (e) {
      if (e && e.code === 'ENOENT') return { entries: [], cursor: '' };   // empty/missing root → empty, don't throw
      throw e;
    }
    const entries = [];
    const take = (list) => { for (const e of list) { const m = this._mapEntry(e); if (m) entries.push(m); } };
    take(res.entries);
    while (res.has_more) {
      res = await this._rpc('files/list_folder/continue', { cursor: res.cursor }, p);
      take(res.entries);
    }
    return { entries, cursor: res.cursor };
  }

  // a list_folder entry → a normalized VFS entry (paths root-stripped); null for deletions/unknown tags.
  _mapEntry(e) {
    const path = this._vpath(e.path_display || e.path_lower || ('/' + (e.name || '')));
    if (e['.tag'] === 'folder') return { path, type: 'directory' };
    if (e['.tag'] === 'file') return { path, type: 'file', size: e.size || 0, contentHash: e.content_hash, modified: e.server_modified ? new Date(e.server_modified) : undefined };
    return null;
  }

  async mkdir(p) {
    // Conflict → _mapError yields EEXIST, which base.import / _cpRecursive tolerate.
    await this._rpc('files/create_folder_v2', { path: this._dpath(p) }, p);
  }

  // delete_v2 handles both files and folders.
  async unlink(p) { await this._rpc('files/delete_v2', { path: this._dpath(p) }, p); }
  async rmdir(p) { await this._rpc('files/delete_v2', { path: this._dpath(p) }, p); }

  // Bulk delete via delete_batch (few ops vs N delete_v2). Chunks at 1,000; polls check if async.
  async deleteBatch(paths) {
    if (!paths || !paths.length) return { deleted: 0 };
    let deleted = 0;
    for (let i = 0; i < paths.length; i += 1000) {
      const chunk = paths.slice(i, i + 1000);
      let res = await this._rpc('files/delete_batch', { entries: chunk.map((pp) => ({ path: this._dpath(pp) })) }, '/');
      let job = res && res['.tag'] === 'async_job_id' ? res.async_job_id : null;
      while (job) {
        await this._sleep(this._batchPollMs);
        res = await this._rpc('files/delete_batch/check', { async_job_id: job }, '/');
        if (res && res['.tag'] === 'complete') job = null;
      }
      deleted += chunk.length;
    }
    return { deleted };
  }

  // Real server-side move (atomic — unlike RESTBackend's GET→PUT→DELETE).
  async rename(oldP, newP) {
    await this._rpc('files/move_v2', { from_path: this._dpath(oldP), to_path: this._dpath(newP) }, oldP);
  }

  // ── Change feed (for a sync engine's pull) — keeps all Dropbox-API knowledge here. ──
  async latestCursor() {
    const res = await this._rpc('files/list_folder/get_latest_cursor', { path: this._root || '', recursive: true }, '/');
    return res.cursor;
  }

  // Raw entries (each carries .tag / path_display / content_hash) — the sync's incremental pull
  // reads content_hash to suppress re-downloading bytes it already has.
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

  // bounded-concurrency map (uploads fan out without re-implementing politeness per caller).
  async _mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let idx = 0;
    const n = Math.max(1, Math.min(limit, items.length));
    const worker = async () => { while (idx < items.length) { const i = idx++; out[i] = await fn(items[i], i); } };
    await Promise.all(Array.from({ length: n }, worker));
    return out;
  }

  // byte length of a write payload (string / typed-array / ArrayBuffer) for the session offset.
  _byteLen(c) {
    if (c == null) return 0;
    if (typeof c === 'string') return new TextEncoder().encode(c).length;
    if (ArrayBuffer.isView(c)) return c.byteLength;
    if (c instanceof ArrayBuffer) return c.byteLength;
    return 0;
  }

  get persistent() { return true; }
}

export { DropboxBackend };
