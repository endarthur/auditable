// Drives lamina through its own 120k-row sample block model with Playwright and
// captures the screenshots for the docs page. Harness-generated so they can't
// rot: re-run after a UI change → fresh images.  node tools/lamina/docs/shots.mjs
// (Runs the BUILT /lamina.html — the dev tree carries bare specifiers.)
import { chromium } from 'playwright';
import http from 'http';
import { readFile, mkdir } from 'fs/promises';
import { extname, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'shots');
await mkdir(OUT, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  try { const path = decodeURIComponent(new URL(req.url, 'http://x').pathname); const data = await readFile('.' + path); res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' }); res.end(data); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.5, colorScheme: 'dark' });
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
p.setDefaultTimeout(30000);
await p.goto(`http://127.0.0.1:${PORT}/lamina.html`, { waitUntil: 'load' });
await p.waitForFunction(() => window._lamina, null, { timeout: 15000 });

const settle = (ms = 1000) => p.waitForTimeout(ms);
const shot = async (name, opts = {}) => { await settle(opts.wait || 1000); await p.screenshot({ path: join(OUT, name + '.png') }); console.log('shot:', name); };

// 1 ── overview: the sample block model (120k rows), gutter glyphs live
await p.evaluate(() => window._lamina.openSampleData());
await p.waitForFunction(() => document.querySelector('#meta') && /rows/.test(document.querySelector('#meta').textContent), null, { timeout: 30000 });
await settle(2000);
await p.evaluate(async () => { await window._lamina.toggleSort(7); await window._lamina.toggleSort(7); });   // Au_gpt DESC — rich rows on top + the sort affordance
await shot('overview', { wait: 1500 });

// 2 ── filter: a selective expression, footer counting the matches
await p.evaluate(() => { document.querySelector('#filter').value = 'Cu_pct > 0.5 and LITO = "SULPHIDE"'; window._lamina.applyFilter('Cu_pct > 0.5 and LITO = "SULPHIDE"'); });
await p.waitForFunction(() => /filtered/.test(document.querySelector('#meta').textContent), null, { timeout: 30000 });
await shot('filter', { wait: 1200 });
await p.evaluate(() => { document.querySelector('#filter').value = ''; window._lamina.applyFilter(''); });
await settle(800);

// 3 ── Σ stats: the column summary (one sortable row per column)
await p.evaluate(() => window._lamina.precomputeStats({ show: true }));
await p.waitForFunction(() => document.querySelector('#help').classList.contains('show') && document.querySelector('#helpBody table'), null, { timeout: 60000 });
await shot('summary', { wait: 800 });
await p.evaluate(() => document.querySelector('#help').classList.remove('show'));

// 4 ── grade–tonnage: declared units + Report → domain table + cutoff curves
await p.evaluate(() => window._lamina.openGradeTonnage());
await p.waitForFunction(() => document.querySelector('#gtRun'), null, { timeout: 10000 });
await p.evaluate(() => {
  const u = document.querySelector('.gt-unit'); if (u) { u.value = 'g/t'; u.dispatchEvent(new Event('change')); }
  document.querySelector('#gtRun').click();
});
await p.waitForFunction(() => document.querySelector('canvas.gt-curve'), null, { timeout: 60000 });
await shot('gradetonnage', { wait: 1500 });
await p.evaluate(() => document.querySelector('#help').classList.remove('show'));

// 5 ── data quality: the pre-flight check
await p.evaluate(() => window._lamina.showDataQuality());
await p.waitForFunction(() => document.querySelector('#help').classList.contains('show') && /quality/i.test(document.querySelector('#helpTitle').textContent), null, { timeout: 60000 });
await shot('quality', { wait: 1200 });

console.log('done →', OUT);
await b.close(); server.close();
