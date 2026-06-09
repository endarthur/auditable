// DropboxBackend — unit-mapping tests with an injected fetch (no live Dropbox).
// Spec: spec_inbox/vfs-dropbox-backend-spec.md.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DropboxBackend, VFS } from '../ext/vfs/index.js';

const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; });

function mkResp(r = {}) {
  const { ok = true, status = 200, body = '', bytes = null } = r;
  return {
    ok, status,
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
