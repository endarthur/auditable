// Real-engine validation of IDBBackend's transaction batching against DESKTOP CHROMIUM's production
// IndexedDB (Blink/LevelDB — the SAME engine Android Chrome ships, since IDB never touches SAF). fake-indexeddb
// is faithful but a reimplementation; this runs the same scenarios on the real thing. Chromium blocks IDB on
// file://, so we serve the repo over http://localhost and import the vfs bundle into a real page.
//
// Not part of `npm test` (needs Playwright + a browser). Run: `npm run test:idb-browser`.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.css': 'text/css' };

// ── tiny static server rooted at the repo (serves /ext/vfs/index.js with a JS MIME so it imports as a module)
const server = http.createServer(async (req, res) => {
  try {
    const p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/' || p === '/blank.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><meta charset=utf-8><title>idb</title>'); return; }
    const file = join(ROOT, p);
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });
await page.goto(origin + '/blank.html');

// ── the scenarios run IN THE PAGE against real window.indexedDB; results come back as plain data ──
const results = await page.evaluate(async (base) => {
  const { IDBBackend, VFS } = await import(base + '/ext/vfs/index.js');
  const out = [];
  const check = (name, cond, msg) => out.push({ name, ok: !!cond, msg: cond ? '' : (msg || 'failed') });
  const freshBe = async () => { const b = new IDBBackend({ name: 'idbt-' + Math.random().toString(36).slice(2) }); await b.init(); return b; };
  // spy on the REAL IDBDatabase.prototype.transaction to count transactions (same trick as the unit tests)
  const countTx = async (fn) => {
    const proto = IDBDatabase.prototype, orig = proto.transaction; let n = 0;
    proto.transaction = function (...a) { n++; return orig.apply(this, a); };
    try { await fn(); } finally { proto.transaction = orig; }
    return n;
  };
  const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e && e.code; } };
  const gone = async (fn) => (await codeOf(fn)) === 'ENOENT';

  // 1. writeFile — one transaction (was three), round-trips
  { const b = await freshBe(); await b.mkdir('/d');
    check('writeFile = 1 tx', (await countTx(() => b.writeFile('/d/a.txt', 'hi'))) === 1);
    check('writeFile round-trip', (await b.readFile('/d/a.txt')) === 'hi'); }

  // 2. writeFiles — a corpus in one tx per 1000-file chunk
  { const b = await freshBe(); const files = Array.from({ length: 1500 }, (_, i) => ({ path: `/dir/f${i}.txt`, content: 'x' + i }));
    const n = await countTx(() => b.writeFiles(files));
    check('writeFiles(1500) = 2 tx', n === 2, 'got ' + n);
    check('writeFiles wrote 1500', (await b.readdir('/dir')).length === 1500);
    check('writeFiles read-back', (await b.readFile('/dir/f42.txt')) === 'x42'); }

  // 3. writeFiles creates missing parents in-tx
  { const b = await freshBe(); await b.writeFiles([{ path: '/a/b/c.txt', content: 'deep' }]);
    check('writeFiles mkdir-p', (await b.stat('/a/b')).type === 'directory');
    check('writeFiles deep read', (await b.readFile('/a/b/c.txt')) === 'deep'); }

  // 4. recursive rmdir — one tx, whole subtree gone
  { const b = await freshBe(); await b.mkdir('/d/sub', { recursive: true }); await b.writeFile('/d/sub/f.txt', 'x'); await b.writeFile('/d/g.txt', 'y');
    check('rmdir recursive = 1 tx', (await countTx(() => b.rmdir('/d', { recursive: true }))) === 1);
    check('rmdir recursive: dir gone', await gone(() => b.stat('/d')));
    check('rmdir recursive: child gone', await gone(() => b.stat('/d/sub/f.txt'))); }

  // 5. directory rename — one ATOMIC tx, subtree re-keyed
  { const b = await freshBe(); await b.mkdir('/src/inner', { recursive: true }); await b.writeFile('/src/inner/f.txt', 'moved'); await b.writeFile('/src/top.txt', 't');
    check('rename dir = 1 tx', (await countTx(() => b.rename('/src', '/dst'))) === 1);
    check('rename inner moved', (await b.readFile('/dst/inner/f.txt')) === 'moved');
    check('rename top moved', (await b.readFile('/dst/top.txt')) === 't');
    check('rename source gone', await gone(() => b.stat('/src'))); }

  // 6. deleteBatch — many paths in one tx
  { const b = await freshBe(); await b.mkdir('/d'); for (const f of ['a', 'b', 'c']) await b.writeFile('/d/' + f + '.txt', f);
    check('deleteBatch = 1 tx', (await countTx(() => b.deleteBatch(['/d/a.txt', '/d/b.txt', '/d/c.txt']))) === 1);
    check('deleteBatch emptied', (await b.readdir('/d')).length === 0); }

  // 7. error codes preserved through the single-transaction rewrite
  { const b = await freshBe();
    check('ENOENT (missing parent)', (await codeOf(() => b.writeFile('/no/x.txt', 'x'))) === 'ENOENT');
    await b.mkdir('/dd');
    check('EEXIST', (await codeOf(() => b.mkdir('/dd'))) === 'EEXIST');
    check('EISDIR (write over dir)', (await codeOf(() => b.writeFile('/dd', 'x'))) === 'EISDIR');
    check('EISDIR (unlink dir)', (await codeOf(() => b.unlink('/dd'))) === 'EISDIR');
    await b.writeFile('/dd/f.txt', 'x');
    check('ENOTEMPTY', (await codeOf(() => b.rmdir('/dd'))) === 'ENOTEMPTY');
    check('ENOTDIR', (await codeOf(() => b.rmdir('/dd/f.txt'))) === 'ENOTDIR'); }

  // 8. binary round-trip on the real engine (structured clone of a typed array)
  { const b = await freshBe(); const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    await b.writeFile('/b.bin', bytes); const got = await b.readFile('/b.bin', 'bytes');
    check('binary round-trip', got instanceof Uint8Array && [...got].join(',') === '0,1,2,250,255'); }

  // 9. CAPSTONE: the optimization reaches through the VFS router on the real engine
  { const vfs = await VFS.create(); await vfs.mount('/m', { type: 'idb', name: 'plumb-' + Math.random().toString(36).slice(2) });
    await vfs.mkdir('/m/d/sub', { recursive: true }); await vfs.writeFile('/m/d/sub/f.txt', 'x'); await vfs.writeFile('/m/d/g.txt', 'y');
    check('vfs.rm({recursive}) through mount = 1 tx', (await countTx(() => vfs.rm('/m/d', { recursive: true }))) === 1);
    check('vfs.rm({recursive}) through mount: gone', !(await vfs.exists('/m/d')));
    const files = Array.from({ length: 1500 }, (_, i) => ({ path: `/m/bulk/f${i}.txt`, content: 'x' + i }));
    check('vfs.writeFiles through mount = 2 tx', (await countTx(() => vfs.writeFiles(files))) === 2);
    check('vfs.writeFiles through mount wrote 1500', (await vfs.readdir('/m/bulk')).length === 1500); }

  return out;
}, origin);

await browser.close();
await new Promise((r) => server.close(r));

for (const r of results) console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.name + (r.msg ? ' — ' + r.msg : ''));
if (pageErrors.length) console.log('\npage errors:', pageErrors);
const failed = results.filter((r) => !r.ok);
const ok = failed.length === 0 && pageErrors.length === 0;
console.log(ok
  ? `\n✅ real-Chromium IndexedDB — ${results.length}/${results.length} checks pass (same Blink engine as Android Chrome)`
  : `\n❌ ${failed.length}/${results.length} failed` + (pageErrors.length ? ` + ${pageErrors.length} page errors` : ''));
process.exit(ok ? 0 : 1);
