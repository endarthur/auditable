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

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
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

  if (errors.length) fail('console errors: ' + errors.join(' | '));
  else ok('no console errors');
} catch (e) {
  fail('smoke threw: ' + e.message);
} finally {
  await browser.close();
  server.close();
}
console.log(process.exitCode ? '\nLAMINA SMOKE: FAIL' : '\nLAMINA SMOKE: PASS');
