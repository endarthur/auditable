// lamina harness smoke — boots tools/lamina in headless Chromium over loopback
// HTTP, opens a CSV / a text file / binary, and asserts the windowed read-only
// loop: detect → grid renders → a DEEP row resolves through the block index → the
// line view + binary handoff work. Not in `npm test` (needs a browser):
//   node test/lamina-smoke.mjs
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, gzipSync } from '../ext/archive/vendor/fflate.module.mjs';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const f = path.join(repo, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(repo) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
const fail = (m) => { console.error('✖ ' + m); process.exitCode = 1; };
const ok = (m) => console.log('✔ ' + m);

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

try {
  await page.goto(`http://127.0.0.1:${port}/tools/lamina/index.html`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window._lamina, null, { timeout: 8000 });
  ok('lamina booted');

  // ── a 5000-row CSV (with a header) ──
  const N = 5000;
  let csv = 'id,grade,lito\n';
  for (let i = 0; i < N; i++) csv += `${i},${(i * 0.01).toFixed(2)},${['ox', 'sulf', 'trans'][i % 3]}\n`;
  const opened = await page.evaluate((text) => {
    window._lamina.open('block.csv', new TextEncoder().encode(text));
    const vs = window._laminaVS;
    return { rows: vs.rowCount(), cols: vs.cols, hasGrid: !!window._lamina.grid, footer: document.getElementById('meta').textContent };
  }, csv);
  (opened.rows === N && opened.cols === 3 && opened.hasGrid)
    ? ok(`opened CSV → ${opened.rows} rows × ${opened.cols} cols (footer: ${opened.footer})`)
    : fail(`CSV open failed: ${JSON.stringify(opened)}`);

  // 3 canvases, painted
  const canvasOk = await page.evaluate(() => {
    const cs = document.querySelectorAll('#grid canvas');
    return cs.length === 3 && [...cs].every((c) => c.width > 0 && c.height > 0);
  });
  canvasOk ? ok('grid rendered (3 canvases sized)') : fail('grid canvases missing');

  // A DEEP row resolves through the block index (windowed read, not a full load).
  const deep = await page.evaluate(async () => {
    const vs = window._laminaVS;
    const R = 4500;                                      // block 1 (blockSize 4096) — not loaded by the initial paint
    const before = vs.rowAt(R);                          // not loaded yet → LOADING
    const row = await vs.ensureRow(R);                   // fetch its block
    return { wasPending: typeof before === 'symbol', id: row[0], lito: row[2] };
  });
  (deep.wasPending && deep.id === '4500' && deep.lito === ['ox', 'sulf', 'trans'][4500 % 3])
    ? ok(`deep row 4500 resolved through the block index (id=${deep.id}, lito=${deep.lito})`)
    : fail(`deep row failed: ${JSON.stringify(deep)}`);

  // ── a text file → line view (one column) ──
  const txt = Array.from({ length: 300 }, (_, i) => `log line ${i}: nothing tabular here`).join('\n') + '\n';
  const textOpen = await page.evaluate((t) => {
    window._lamina.open('app.log', new TextEncoder().encode(t));
    const vs = window._laminaVS;
    return { rows: vs.rowCount(), cols: vs.cols, kind: vs.kind, badge: document.getElementById('kindBadge').textContent };
  }, txt);
  (textOpen.rows === 300 && textOpen.cols === 1 && textOpen.kind === 'text')
    ? ok(`opened text → line view (${textOpen.rows} lines, 1 col, badge "${textOpen.badge}")`)
    : fail(`text open failed: ${JSON.stringify(textOpen)}`);

  // ── binary → hex handoff message ──
  const bin = await page.evaluate(() => {
    window._lamina.open('blob.bin', new Uint8Array([1, 2, 0, 3, 255, 7, 0, 9]));
    return { binaryShown: getComputedStyle(document.getElementById('binary')).display !== 'none' };
  });
  bin.binaryShown ? ok('binary file → hex-handoff message shown') : fail('binary not handled');

  // ── a streamed File (never-resident path) → block index + deep windowed row ──
  const stream = await page.evaluate(async () => {
    let csv = 'n,v\n';
    for (let i = 0; i < 6000; i++) csv += `${i},x${i}\n`;
    const file = new File([new TextEncoder().encode(csv)], 'stream.csv');
    await window._lamina.openFile(file);                 // streams file.stream() → block index
    const vs = window._laminaVS;
    const R = 5000;                                      // a deep, unloaded block
    const before = vs.rowAt(R);                          // LOADING
    const row = await vs.ensureRow(R);                   // windowed via File.slice (lazy)
    return { rows: vs.rowCount(), wasPending: typeof before === 'symbol', n: row[0], v: row[1], scan: window._lamina.lastScan };
  });
  (stream.rows === 6000 && stream.wasPending && stream.n === '5000' && stream.v === 'x5000')
    ? ok(`streamed File → ${stream.rows} rows; deep row 5000 windowed via File.slice (n=${stream.n})`)
    : fail(`streaming open failed: ${JSON.stringify(stream)}`);
  // over http the index scan must run in a @gcu/proc worker (off the main thread), not the inline fallback
  stream.scan === 'worker'
    ? ok('index scan ran off-thread (@gcu/proc worker)')
    : fail(`expected worker scan, got "${stream.scan}" (worker path fell back to inline)`);

  // ── index cache: reopen the SAME file → hit (no re-scan), identical view ──
  const cache = await page.evaluate(async () => {
    await window._lamina.cache.clear();
    let csv = 'a,b\n';
    for (let i = 0; i < 4000; i++) csv += `${i},y${i}\n`;
    const file = new File([new TextEncoder().encode(csv)], 'cached.csv');   // one object → stable fileKey
    await window._lamina.openFile(file);
    const first = { scan: window._lamina.lastScan, rows: window._laminaVS.rowCount() };
    await window._lamina.openFile(file);                                    // reopen → should hit the sidecar
    const row = await window._laminaVS.ensureRow(3700);
    return { first, secondScan: window._lamina.lastScan, secondRows: window._laminaVS.rowCount(), b: row[1] };
  });
  (cache.first.scan === 'worker' && cache.secondScan === 'cache' && cache.secondRows === cache.first.rows && cache.b === 'y3700')
    ? ok(`index cache: first open scanned (${cache.first.scan}), reopen hit the cache (${cache.first.rows} rows, deep row intact)`)
    : fail(`index cache failed: ${JSON.stringify(cache)}`);

  // ── archive (resident tier): a CSV inside a zip → grid; a single entry auto-opens ──
  const enc = new TextEncoder();
  let zcsv = 'p,q\n'; for (let i = 0; i < 800; i++) zcsv += `${i},z${i}\n`;
  const zipBytes = zipSync({ 'inner.csv': enc.encode(zcsv) });
  const zipArr = Array.from(zipBytes);
  const zipRes = await page.evaluate(async (arr) => {
    const file = new File([new Uint8Array(arr)], 'bundle.zip');
    await window._lamina.openFile(file);
    const vs = window._laminaVS;
    return { rows: vs.rowCount(), cols: vs.cols, scan: window._lamina.lastScan, name: document.getElementById('fileName').textContent };
  }, zipArr);
  (zipRes.rows === 800 && zipRes.cols === 2 && zipRes.scan === 'resident' && zipRes.name.includes('inner.csv'))
    ? ok(`zip → single CSV entry auto-opened (${zipRes.rows} rows, label "${zipRes.name}")`)
    : fail(`zip open failed: ${JSON.stringify(zipRes)}`);

  // multi-entry zip → picker lists both; clicking one renders it
  const zip2 = Array.from(zipSync({ 'a.csv': enc.encode('x\n1\n2\n3\n'), 'b.csv': enc.encode('y,z\n4,5\n6,7\n') }));
  const pick = await page.evaluate(async (arr) => {
    await window._lamina.openFile(new File([new Uint8Array(arr)], 'two.zip'));
    const items = [...document.querySelectorAll('#picker.show .pk-item .pk-name')].map((n) => n.textContent);
    document.querySelectorAll('#picker .pk-item')[1].click();     // pick b.csv
    await new Promise((r) => setTimeout(r, 100));
    return { items, cols: window._laminaVS.cols, rows: window._laminaVS.rowCount() };
  }, zip2);
  (pick.items.length === 2 && pick.items.includes('a.csv') && pick.items.includes('b.csv') && pick.cols === 2 && pick.rows === 2)
    ? ok(`multi-entry zip → picker (${pick.items.join(', ')}), chose b.csv → ${pick.rows}×${pick.cols}`)
    : fail(`zip picker failed: ${JSON.stringify(pick)}`);

  // a .gz stream → decompress + render
  const gzArr = Array.from(gzipSync(enc.encode('m\n' + Array.from({ length: 200 }, (_, i) => i).join('\n') + '\n')));
  const gz = await page.evaluate(async (arr) => {
    await window._lamina.openFile(new File([new Uint8Array(arr)], 'log.txt.gz'));
    return { rows: window._laminaVS.rowCount(), name: document.getElementById('fileName').textContent };
  }, gzArr);
  (gz.rows === 201 && gz.name.includes('log.txt'))
    ? ok(`.gz → decompressed + rendered (${gz.rows} rows, label "${gz.name}")`)
    : fail(`gz open failed: ${JSON.stringify(gz)}`);

  // ── tape: window a zip entry WITHOUT unpacking (forces the streaming path by
  // dropping the resident threshold to 0) — deep row resolves; reopen hits cache ──
  let bcsv = 'id,v\n'; for (let i = 0; i < 5000; i++) bcsv += `${i},w${i}\n`;
  const bigZip = Array.from(zipSync({ 'big.csv': enc.encode(bcsv) }, { level: 6 }));
  const tape = await page.evaluate(async (arr) => {
    window.__LAMINA_RESIDENT_LIMIT__ = 0;                                  // force the tape, even for a tiny zip
    await window._lamina.cache.clear();
    const file = new File([new Uint8Array(arr)], 'huge.zip');
    await window._lamina.openFile(file);                                   // stream-enumerate → 1 entry → tape
    const first = { scan: window._lamina.lastScan, rows: window._laminaVS.rowCount(), name: document.getElementById('fileName').textContent };
    const deep = await window._laminaVS.ensureRow(4200);                   // forward-windowed through the tape
    const back = await window._laminaVS.ensureRow(15);                     // far back → rewind, still correct
    await window._lamina.openFile(file);                                   // reopen → cached stream index
    const second = window._lamina.lastScan;
    window.__LAMINA_RESIDENT_LIMIT__ = undefined;
    return { ...first, deep, back, second };
  }, bigZip);
  (tape.scan === 'stream' && tape.rows === 5000 && tape.deep[0] === '4200' && tape.back[0] === '15'
    && tape.name.includes('big.csv') && tape.second === 'cache')
    ? ok(`zip entry windowed via tape (no unpack): ${tape.rows} rows, deep=${tape.deep[0]}, rewind-back=${tape.back[0]}, reopen=${tape.second}`)
    : fail(`tape zip failed: ${JSON.stringify(tape)}`);

  if (errors.length) fail('console errors: ' + errors.join(' | '));
  else ok('no console errors');
} catch (e) {
  fail('smoke threw: ' + e.message);
} finally {
  await browser.close();
  server.close();
}
console.log(process.exitCode ? '\nLAMINA SMOKE: FAIL' : '\nLAMINA SMOKE: PASS');
