// lamina single-file build smoke — guards the SHIP artifact (lamina.html), not
// the dev harness. Rebuilds it, serves over loopback HTTP, and asserts the whole
// stack survives the registry/import-map bundling: boot, memory open, the
// off-thread worker scan (the inlined @gcu/lamina blob URL must be importable
// from the proc worker — the build's riskiest seam), filter, and a zip entry.
// Not in `npm test` (needs a browser + a build):  node test/lamina-built-smoke.mjs
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { zipSync } from '../ext/archive/vendor/fflate.module.mjs';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (m) => { console.error('✖ ' + m); process.exitCode = 1; };
const ok = (m) => console.log('✔ ' + m);

console.log('building lamina.html…');
execFileSync('node', ['build.js', '--target=lamina'], { cwd: repo, stdio: 'inherit' });

const server = http.createServer((req, res) => {
  const f = path.join(repo, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(repo) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'text/html' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

try {
  await page.goto(`http://127.0.0.1:${port}/lamina.html`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window._lamina, null, { timeout: 8000 });
  ok('single-file lamina.html booted');

  const mem = await page.evaluate(() => {
    let csv = 'id,v\n'; for (let i = 0; i < 2000; i++) csv += `${i},x${i}\n`;
    window._lamina.open('m.csv', new TextEncoder().encode(csv));
    return { rows: window._laminaVS.rowCount(), canvases: document.querySelectorAll('#grid canvas').length };
  });
  (mem.rows === 2000 && mem.canvases === 3) ? ok(`memory open → ${mem.rows} rows, grid painted`) : fail(`memory open: ${JSON.stringify(mem)}`);

  // The build's riskiest seam: the off-thread scan worker importing the inlined bundle.
  const w = await page.evaluate(async () => {
    let csv = 'n,v\n'; for (let i = 0; i < 6000; i++) csv += `${i},y${i}\n`;
    await window._lamina.openFile(new File([new TextEncoder().encode(csv)], 's.csv'));
    const deep = await window._laminaVS.ensureRow(5000);
    return { scan: window._lamina.lastScan, rows: window._laminaVS.rowCount(), deep: deep && deep[0] };
  });
  (w.scan === 'worker' && w.rows === 6000 && w.deep === '5000')
    ? ok('off-thread worker scan works from the inlined blob URL')
    : fail(`worker scan in bundle: ${JSON.stringify(w)}`);

  const flt = await page.evaluate(async () => {
    await window._lamina.applyFilter('v ~ y99');                 // contains "y99": y99, y990-999, y1990-1999, …
    const shown = window._laminaVS.rowCount();
    await window._lamina.applyFilter('');
    return { shown, cleared: window._laminaVS.rowCount() };
  });
  (flt.shown > 0 && flt.cleared === 6000)
    ? ok(`filter in bundle → ${flt.shown} match, clear restores 6000`)
    : fail(`filter in bundle: ${JSON.stringify(flt)}`);

  const zipArr = Array.from(zipSync({ 'inner.csv': new TextEncoder().encode('a,b\n1,2\n3,4\n') }));
  const zip = await page.evaluate(async (arr) => {
    await window._lamina.openFile(new File([new Uint8Array(arr)], 'z.zip'));
    return { rows: window._laminaVS.rowCount(), name: document.getElementById('fileName').textContent };
  }, zipArr);
  (zip.rows === 2 && zip.name.includes('inner.csv')) ? ok(`zip entry opened in bundle (${zip.name})`) : fail(`zip in bundle: ${JSON.stringify(zip)}`);

  // build stamp injected (version · content-hash · date) — visible in the footer + window._lamina.build
  const stamp = await page.evaluate(() => ({ footer: document.getElementById('build').textContent, api: window._lamina.build }));
  (/^\d+\.\d+\.\d+ · [0-9a-f]{7} · \d{4}-\d{2}-\d{2}$/.test(stamp.footer) && stamp.footer === stamp.api)
    ? ok(`build stamp present (${stamp.footer})`)
    : fail(`build stamp missing/malformed: ${JSON.stringify(stamp)}`);

  if (errors.length) fail('console errors: ' + errors.join(' | '));
  else ok('no console errors');
} catch (e) {
  fail('smoke threw: ' + e.message);
} finally {
  await browser.close();
  server.close();
}
console.log(process.exitCode ? '\nLAMINA BUILT SMOKE: FAIL' : '\nLAMINA BUILT SMOKE: PASS');
