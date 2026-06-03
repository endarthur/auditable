// @gcu/strata browser smoke — loads the demo (blockmodel CSV → recon → strata →
// loom) in headless Chromium over loopback HTTP, asserts it ingests + renders,
// the recon-rich schema carries units, and an edit lands in the overlay.
// Not part of `npm test` (needs a browser): node test/strata-smoke.mjs
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(root, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.csv': 'text/csv' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(repo, rel);
  if (!file.startsWith(repo) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const fail = (m) => { console.error('✖ ' + m); process.exitCode = 1; };
const ok = (m) => console.log('✔ ' + m);

await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

try {
  await page.goto(`http://127.0.0.1:${port}/ext/strata/demo.html`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window._strata && window._strata.table, null, { timeout: 8000 });
  ok('demo mounted (CSV ingested → table → loom)');

  const info = await page.evaluate(() => {
    const { table, provider } = window._strata;
    const au = table.schema.find((s) => s.name === 'Au_gpt');
    const auIdx = table.schema.findIndex((s) => s.name === 'Au_gpt');
    return { nrows: table.nrows, cols: table.cols, auUnit: au && au.unit, auHeader: provider.header(auIdx).label };
  });
  info.nrows > 1000 ? ok(`ingested ${info.nrows} rows × ${info.cols} cols`) : fail(`too few rows: ${info.nrows}`);
  info.auUnit === 'g/t' ? ok('recon rich schema: Au_gpt unit = g/t') : fail(`Au_gpt unit wrong: ${info.auUnit}`);
  info.auHeader === 'Au_gpt (g/t)' ? ok('header renders unit suffix') : fail(`header wrong: ${info.auHeader}`);

  // Body canvas painted.
  const painted = await page.evaluate(() => {
    const c = document.querySelector('#grid canvas');
    const d = c.getContext('2d').getImageData(0, 0, Math.min(400, c.width), Math.min(200, c.height)).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 18) > 12 || Math.abs(d[i + 1] - 18) > 12 || Math.abs(d[i + 2] - 18) > 12) n++;
    return n;
  });
  painted > 50 ? ok(`grid painted (${painted} non-bg px)`) : fail('grid looks blank');

  // Edit a cell → overlay dirty count goes 0 → 1, base preserved.
  const box = await (await page.$('#grid')).boundingBox();
  await page.mouse.click(box.x + 120, box.y + 90);
  await page.keyboard.type('123.45');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(80);
  const edit = await page.evaluate(() => ({ dirty: window._strata.table.dirtyCount(), footer: document.getElementById('dirty').textContent }));
  (edit.dirty === 1 && edit.footer === '1') ? ok('edit committed to overlay (dirty 0 → 1)') : fail(`overlay edit failed: ${JSON.stringify(edit)}`);

  errors.length ? fail('console errors: ' + errors.join(' | ')) : ok('no console errors');
} catch (e) {
  fail('smoke threw: ' + e.message);
} finally {
  await browser.close();
  server.close();
}
console.log(process.exitCode ? '\nSTRATA SMOKE: FAIL' : '\nSTRATA SMOKE: PASS');
