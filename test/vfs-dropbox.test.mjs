// DropboxBackend — unit-mapping tests with an injected fetch (no live Dropbox).
// Spec: spec_inbox/vfs-dropbox-backend-spec.md.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DropboxBackend, VFS } from '../ext/vfs/index.js';

const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; });

function mkResp(r = {}) {
  const { ok = true, status = 200, body = '', bytes = null, headers = null } = r;
  return {
    ok, status,
    headers: { get: (k) => (headers ? (headers[k] ?? headers[k.toLowerCase()] ?? null) : null) },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? (body ? JSON.parse(body) : null) : body),
    arrayBuffer: async () => (bytes || new Uint8Array()).buffer,
  };
}

// Install a fake fetch; `handler(url, arg) → respSpec`. Records every call.
function harness(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const h = opts.headers || {};
    let arg = null;
    if (h['Dropbox-API-Arg']) arg = JSON.parse(h['Dropbox-API-Arg']);
    else if (typeof opts.body === 'string') { try { arg = JSON.parse(opts.body); } catch { /* */ } }
    calls.push({ url, method: opts.method, arg, body: opts.body, auth: h.Authorization, headers: h });
    return mkResp(handler ? handler(url, arg) : {});
  };
  return calls;
}
const db = (extra = {}) => new DropboxBackend({ getToken: async () => 'TKN', ...extra });

test('readFile → content/download, Dropbox-API-Arg, bearer auth', async () => {
  const calls = harness(() => ({ body: 'hello' }));
  assert.equal(await db().readFile('/a.txt'), 'hello');
  assert.match(calls[0].url, /content\.dropboxapi\.com\/2\/files\/download$/);
  assert.deepEqual(calls[0].arg, { path: '/a.txt' });
  assert.equal(calls[0].auth, 'Bearer TKN');
});

test('readFile bytes → Uint8Array', async () => {
  harness(() => ({ bytes: new Uint8Array([1, 2, 3]) }));
  const r = await db().readFile('/a.bin', 'bytes');
  assert.ok(r instanceof Uint8Array);
  assert.deepEqual([...r], [1, 2, 3]);
});

test('writeFile → upload overwrite+mute, octet-stream, body passthrough', async () => {
  const calls = harness(() => ({}));
  await db().writeFile('/a.txt', 'data');
  assert.match(calls[0].url, /files\/upload$/);
  assert.deepEqual(calls[0].arg, { path: '/a.txt', mode: 'overwrite', mute: true });
  assert.equal(calls[0].headers['Content-Type'], 'application/octet-stream');
  assert.equal(calls[0].body, 'data');
});

// Regression: Dropbox-API-Arg is an HTTP HEADER → must be ASCII. Non-ASCII (accented/unicode
// paths) MUST be escaped as \uXXXX, or the request is malformed and fails (in browsers it
// surfaced as a bogus CORS error, breaking upload AND download of such paths). Build the unicode
// path via fromCharCode so this test's own source stays ASCII.
test('Dropbox-API-Arg escapes non-ASCII (unicode paths) on upload AND download', async () => {
  const path = '/notes/caf' + String.fromCharCode(0xe9) + '-a' + String.fromCharCode(0xe7, 0xe3) + 'o.md';   // /notes/café-ação.md
  const isAscii = (s) => /^[\x20-\x7E]*$/.test(s);
  const up = harness(() => ({}));
  await db().writeFile(path, 'data');
  const uh = up[0].headers['Dropbox-API-Arg'];
  assert.ok(isAscii(uh), 'upload Dropbox-API-Arg must be ASCII-only (no raw unicode): ' + uh);
  assert.equal(JSON.parse(uh).path, path, 'escaped header still decodes to the original unicode path');
  const dl = harness(() => ({ body: 'x' }));
  await db().readFile(path);
  assert.ok(isAscii(dl[0].headers['Dropbox-API-Arg']), 'download Dropbox-API-Arg must be ASCII-only too');
});

test('stat file maps server/client_modified + size', async () => {
  harness(() => ({ body: { '.tag': 'file', size: 42, server_modified: '2020-01-02T03:04:05Z', client_modified: '2020-01-01T00:00:00Z' } }));
  const s = await db().stat('/a.txt');
  assert.equal(s.type, 'file');
  assert.equal(s.size, 42);
  assert.equal(s.modified.toISOString(), '2020-01-02T03:04:05.000Z');
  assert.equal(s.created.toISOString(), '2020-01-01T00:00:00.000Z');
});

test('stat folder → directory; stat root → directory without a fetch', async () => {
  const calls = harness(() => ({ body: { '.tag': 'folder' } }));
  assert.equal((await db().stat('/dir')).type, 'directory');
  const before = calls.length;
  assert.equal((await db().stat('/')).type, 'directory');
  assert.equal(calls.length, before, 'root stat must not hit the API');
});

test('readdir paginates list_folder → continue while has_more', async () => {
  harness((url) => (/list_folder\/continue/.test(url)
    ? { body: { entries: [{ name: 'c' }], has_more: false } }
    : { body: { entries: [{ name: 'a' }, { name: 'b' }], has_more: true, cursor: 'X' } }));
  assert.deepEqual(await db().readdir('/dir'), ['a', 'b', 'c']);
});

test('mkdir / unlink / rmdir / rename endpoints + args', async () => {
  let calls = harness(() => ({ body: {} }));
  await db().mkdir('/d');
  assert.match(calls[0].url, /create_folder_v2$/);
  assert.deepEqual(calls[0].arg, { path: '/d' });

  calls = harness(() => ({ body: {} }));
  await db().unlink('/f');
  assert.match(calls[0].url, /delete_v2$/);
  assert.deepEqual(calls[0].arg, { path: '/f' });

  calls = harness(() => ({ body: {} }));
  await db().rename('/a', '/b');
  assert.match(calls[0].url, /move_v2$/);
  assert.deepEqual(calls[0].arg, { from_path: '/a', to_path: '/b' });
});

test('root prefix applied via dpath', async () => {
  const calls = harness(() => ({ body: { '.tag': 'file', size: 1, server_modified: '2020-01-01T00:00:00Z' } }));
  await db({ root: '/auditable' }).stat('/x.json');
  assert.deepEqual(calls[0].arg, { path: '/auditable/x.json' });
  // and the subtree root maps to the subtree, not the app root
  const calls2 = harness(() => ({ body: { entries: [], has_more: false } }));
  await db({ root: '/auditable' }).readdir('/');
  assert.deepEqual(calls2[0].arg, { path: '/auditable' });
});

test('error mapping: not_found→ENOENT, conflict→EEXIST, 401→EACCES, other→EIO', async () => {
  harness(() => ({ ok: false, status: 409, body: { error_summary: 'path/not_found/.', error: { '.tag': 'path', path: { '.tag': 'not_found' } } } }));
  await assert.rejects(db().readFile('/x'), (e) => e.code === 'ENOENT');

  harness(() => ({ ok: false, status: 409, body: { error_summary: 'path/conflict/.', error: { '.tag': 'path', path: { '.tag': 'conflict' } } } }));
  await assert.rejects(db().mkdir('/x'), (e) => e.code === 'EEXIST');

  harness(() => ({ ok: false, status: 401, body: 'unauthorized' }));
  await assert.rejects(db().readFile('/x'), (e) => e.code === 'EACCES');

  harness(() => ({ ok: false, status: 500, body: { error_summary: 'internal_error/.' } }));
  await assert.rejects(db().readFile('/x'), (e) => e.code === 'EIO');
});

test('change feed: longpoll has NO Authorization header (unauthenticated by design)', async () => {
  const calls = harness(() => ({ body: { changes: true } }));
  const r = await db().longpoll('CUR', 30);
  assert.equal(r.changes, true);
  assert.match(calls[0].url, /notify\.dropboxapi\.com\/2\/files\/list_folder\/longpoll$/);
  assert.equal(calls[0].auth, undefined);
  assert.deepEqual(calls[0].arg, { cursor: 'CUR', timeout: 30 });
});

test('change feed: latestCursor (recursive, root) + changes', async () => {
  harness((url) => (/get_latest_cursor/.test(url)
    ? { body: { cursor: 'C0' } }
    : { body: { entries: [{ name: 'a' }], cursor: 'C1', has_more: false } }));
  assert.equal(await db({ root: '/auditable' }).latestCursor(), 'C0');
  assert.deepEqual(await db().changes('C0'), { entries: [{ name: 'a' }], cursor: 'C1', has_more: false });
});

test('toConfig → null when getToken is a function (worker falls back to RPC)', () => {
  assert.equal(db().toConfig(), null);
});

test('composes cleanly under the cache backend (VFS.create round-trip)', async () => {
  const store = {};
  harness((url, arg) => {
    if (/files\/upload$/.test(url)) { store[arg.path] = true; return { body: {} }; }
    if (/files\/download$/.test(url)) return { body: 'via-dropbox' };
    if (/get_metadata$/.test(url)) {
      return arg.path in store
        ? { body: { '.tag': 'file', size: 11, server_modified: '2020-01-01T00:00:00Z' } }
        : { ok: false, status: 409, body: { error: { '.tag': 'path', path: { '.tag': 'not_found' } } } };
    }
    return { body: {} };
  });
  // NOTE: CacheBackend's remote key is `backend` (the spec's example says `source` — a typo).
  const vfs = await VFS.create({
    backends: { '/mnt/dropbox': { type: 'cache', backend: { type: 'dropbox', getToken: async () => 'TKN' } } },
  });
  await vfs.writeFile('/mnt/dropbox/x.txt', 'via-dropbox');
  assert.equal(await vfs.readFile('/mnt/dropbox/x.txt'), 'via-dropbox');
});

// ── efficiency follow-up (vfs-dropbox-efficiency-spec.md): listTree, writeFiles, 429 backpressure ──

test('listTree → recursive list_folder, normalized rich entries + cursor', async () => {
  const calls = harness((url) => (/list_folder\/continue/.test(url)
    ? { body: { entries: [{ '.tag': 'file', path_display: '/d/c.txt', size: 9, content_hash: 'hc', server_modified: '2020-01-03T00:00:00Z' }], has_more: false, cursor: 'C2' } }
    : { body: { entries: [
        { '.tag': 'folder', path_display: '/d/sub' },
        { '.tag': 'file', path_display: '/d/a.txt', size: 5, content_hash: 'ha', server_modified: '2020-01-01T00:00:00Z' },
      ], has_more: true, cursor: 'C1' } }));
  const r = await db().listTree('/d');
  assert.equal(calls[0].arg.recursive, true);
  assert.equal(r.cursor, 'C2');
  assert.deepEqual(r.entries.map((e) => [e.path, e.type, e.size, e.contentHash]), [
    ['/d/sub', 'directory', undefined, undefined],
    ['/d/a.txt', 'file', 5, 'ha'],
    ['/d/c.txt', 'file', 9, 'hc'],
  ]);
});

test('listTree strips root from entry paths', async () => {
  harness(() => ({ body: { entries: [{ '.tag': 'file', path_display: '/auditable/x.txt', size: 1, content_hash: 'h', server_modified: '2020-01-01T00:00:00Z' }], has_more: false, cursor: 'C' } }));
  const r = await db({ root: '/auditable' }).listTree('/');
  assert.equal(r.entries[0].path, '/x.txt');
});

test('listTree on a missing subtree → empty (no throw)', async () => {
  harness(() => ({ ok: false, status: 409, body: { error: { '.tag': 'path', path: { '.tag': 'not_found' } } } }));
  assert.deepEqual(await db().listTree('/nope'), { entries: [], cursor: '' });
});

test('writeFiles → upload_session/start per file + one finish_batch', async () => {
  let sid = 0;
  const calls = harness((url) => {
    if (/upload_session\/start/.test(url)) return { body: { session_id: 's' + (sid++) } };
    if (/finish_batch$/.test(url)) return { body: { '.tag': 'complete', entries: [{ '.tag': 'success' }, { '.tag': 'success' }] } };
    return { body: {} };
  });
  const r = await db().writeFiles([{ path: '/a.txt', content: 'hello' }, { path: '/b.txt', content: 'hi' }]);
  assert.equal(r.committed, 2);
  const starts = calls.filter((c) => /upload_session\/start/.test(c.url));
  assert.equal(starts.length, 2);
  assert.deepEqual(starts[0].arg, { close: true });
  const fin = calls.find((c) => /finish_batch$/.test(c.url));
  assert.equal(fin.arg.entries.length, 2);
  assert.deepEqual(fin.arg.entries[0].commit, { path: '/a.txt', mode: 'overwrite', mute: true });
  assert.equal(fin.arg.entries[0].cursor.offset, 5);
});

test('writeFiles polls finish_batch/check when async', async () => {
  let checks = 0;
  harness((url) => {
    if (/upload_session\/start/.test(url)) return { body: { session_id: 's' } };
    if (/finish_batch\/check/.test(url)) return (++checks < 2) ? { body: { '.tag': 'in_progress' } } : { body: { '.tag': 'complete', entries: [{ '.tag': 'success' }] } };
    if (/finish_batch$/.test(url)) return { body: { '.tag': 'async_job_id', async_job_id: 'job1' } };
    return { body: {} };
  });
  const r = await db({ sleep: async () => {} }).writeFiles([{ path: '/a.txt', content: 'x' }]);
  assert.equal(r.committed, 1);
  assert.equal(checks, 2);
});

test('writeFiles chunks at 1000 entries', async () => {
  const calls = harness((url) => (/upload_session\/start/.test(url)
    ? { body: { session_id: 's' } }
    : (/finish_batch$/.test(url) ? { body: { '.tag': 'complete', entries: [] } } : { body: {} })));
  const files = Array.from({ length: 1500 }, (_, i) => ({ path: '/f' + i + '.txt', content: 'x' }));
  const r = await db().writeFiles(files);
  assert.equal(r.committed, 1500);
  const fins = calls.filter((c) => /finish_batch$/.test(c.url));
  assert.equal(fins.length, 2);
  assert.equal(fins[0].arg.entries.length, 1000);
  assert.equal(fins[1].arg.entries.length, 500);
});

test('writeFiles surfaces a per-entry failure as EIO with the failed paths', async () => {
  let sid = 0;
  harness((url) => {
    if (/upload_session\/start/.test(url)) return { body: { session_id: 's' + (sid++) } };
    if (/finish_batch$/.test(url)) return { body: { '.tag': 'complete', entries: [{ '.tag': 'success' }, { '.tag': 'failure', failure: {} }] } };
    return { body: {} };
  });
  await assert.rejects(
    db().writeFiles([{ path: '/a.txt', content: 'a' }, { path: '/b.txt', content: 'b' }]),
    (e) => e.code === 'EIO' && Array.isArray(e.failed) && e.failed.includes('/b.txt'),
  );
});

test('429 + Retry-After → waits the header seconds then retries', async () => {
  let n = 0; const waited = [];
  harness(() => (n++ === 0 ? { ok: false, status: 429, headers: { 'Retry-After': '2' } } : { body: 'ok' }));
  const r = await db({ sleep: async (ms) => waited.push(ms) }).readFile('/a.txt');
  assert.equal(r, 'ok');
  assert.deepEqual(waited, [2000]);
});

test('persistent 429 → EBUSY after bounded attempts, carries retryAfterMs', async () => {
  harness(() => ({ ok: false, status: 429, headers: { 'Retry-After': '1' } }));
  await assert.rejects(
    db({ sleep: async () => {}, maxRetries: 3 }).readFile('/a.txt'),
    (e) => e.code === 'EBUSY' && e.retryAfterMs === 1000,
  );
});

test('503 without Retry-After → exponential backoff fallback', async () => {
  let n = 0; const waited = [];
  harness(() => (n++ < 2 ? { ok: false, status: 503 } : { body: 'ok' }));
  await db({ sleep: async (ms) => waited.push(ms) }).readFile('/a.txt');
  assert.deepEqual(waited, [1000, 2000]);
});

test('401 → one transparent token refresh + retry, then succeeds', async () => {
  let n = 0, toks = 0;
  globalThis.fetch = async () => mkResp(n++ === 0 ? { ok: false, status: 401, body: 'unauth' } : { body: 'ok' });
  const be = new DropboxBackend({ getToken: async () => { toks++; return 'T' + toks; } });
  assert.equal(await be.readFile('/a.txt'), 'ok');
  assert.equal(toks, 2);
});

test('persistent 401 → EACCES after the single refresh', async () => {
  globalThis.fetch = async () => mkResp({ ok: false, status: 401, body: 'unauth' });
  await assert.rejects(new DropboxBackend({ getToken: async () => 'T' }).readFile('/a.txt'), (e) => e.code === 'EACCES');
});

test('token cache: a burst of calls hits getToken once', async () => {
  let toks = 0;
  globalThis.fetch = async () => mkResp({ body: 'ok' });
  const be = new DropboxBackend({ getToken: async () => { toks++; return 'T'; } });
  await be.readFile('/a.txt'); await be.readFile('/b.txt'); await be.readFile('/c.txt');
  assert.equal(toks, 1);
});

test('stat exposes contentHash', async () => {
  harness(() => ({ body: { '.tag': 'file', size: 3, content_hash: 'abc', server_modified: '2020-01-01T00:00:00Z' } }));
  assert.equal((await db().stat('/a.txt')).contentHash, 'abc');
});

test('deleteBatch → delete_batch with dpath entries', async () => {
  const calls = harness((url) => (/delete_batch$/.test(url) ? { body: { '.tag': 'complete', entries: [{}, {}] } } : { body: {} }));
  const r = await db({ root: '/auditable' }).deleteBatch(['/a.txt', '/b.txt']);
  assert.equal(r.deleted, 2);
  const c = calls.find((x) => /delete_batch$/.test(x.url));
  assert.deepEqual(c.arg.entries, [{ path: '/auditable/a.txt' }, { path: '/auditable/b.txt' }]);
});
