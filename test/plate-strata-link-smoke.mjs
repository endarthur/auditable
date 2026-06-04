// plate ↔ strata selection-linking smoke — a plate surface (a plot panel) and a
// strata surface on the SAME .strata file brush each other over the A-Bus
// Selection channel. Proves @gcu/plate v0.1 end-to-end: a real canvas brush on
// the scatter → kind:"rows" descriptor → strata highlights the rows; strata
// row-select → plate tints the points; strata filter → plate resolves the
// structured predicate over its own data and tints the matching points.
//   node build.js --target=works && node test/plate-strata-link-smoke.mjs
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTable, writeStrata } from '../ext/strata/src/main.js';
import { createWriter } from '../ext/archive/index.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const file = path.join(root, req.url.split('?')[0]);
  if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
const fail = (m) => { console.error('✖ ' + m); process.exitCode = 1; };
const ok = (m) => console.log('✔ ' + m);

// 5 rows; base ordinals 0..4. x = [1,2,3,4,5], y = [5,4,3,2,1].
const t = createTable({
  schema: [{ name: 'x', type: 'number' }, { name: 'y', type: 'number' }, { name: 'dom', type: 'category' }],
  columns: [[1, 2, 3, 4, 5], [5, 4, 3, 2, 1], ['a', 'b', 'a', 'b', 'a']],
  nrows: 5,
});
const strataBytes = Array.from(await writeStrata(t, { createWriter, name: 'demo' }));

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

async function surfaceFrame(tabId) {
  const h = await page.evaluateHandle((id) => (window.WKS.surfaces.get(id) || {}).iframe, tabId);
  const el = h.asElement();
  return el ? await el.contentFrame() : null;
}

try {
  await page.goto(`http://127.0.0.1:${port}/works.html`);
  await page.waitForFunction(() => window.WKS && window.WKS.broker && window.WKS.vfs, { timeout: 15000 });

  // A strata surface + a plate surface on the SAME path → same dataset identity.
  const spawned = await page.evaluate(async (bytes) => {
    const W = window.WKS;
    await W.vfs.writeFile('/projects/demo.strata', new Uint8Array(bytes));
    const s = W.spawnSurface('strata', { path: '/projects/demo.strata', title: 'table' });
    const p = W.spawnSurface('plate',  { path: '/projects/demo.strata', title: 'figure' });
    const deadline = Date.now() + 20000;
    const ready = (id) => { const r = W.surfaces.get(id); return r && r.ready; };
    while ((!ready(s) || !ready(p)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    return { s, p, sReady: ready(s), pReady: ready(p) };
  }, strataBytes);
  (spawned.sReady && spawned.pReady) ? ok('strata + plate surfaces on the same .strata, both ready') : fail(`surfaces not ready: ${JSON.stringify(spawned)}`);

  const frameS = await surfaceFrame(spawned.s);
  const frameP = await surfaceFrame(spawned.p);

  // plate booted a plot panel scattering the first two numeric columns.
  const specOk = await frameP.evaluate(() => {
    const P = window._plateSurface;
    const spec = P.plate.getPanelSpec(P.panelId);
    return spec && spec.x === 'x' && spec.y === 'y';
  });
  specOk ? ok('plate panel scatters the first two numeric columns (x vs y)') : fail('plate default spec wrong');

  // Wait for the canvas to be laid out + painted.
  await frameP.evaluate(async () => {
    const deadline = Date.now() + 5000;
    const cv = () => document.querySelector('#plate canvas');
    while (Date.now() < deadline) { const c = cv(); if (c && c.getBoundingClientRect().width > 10) return; await new Promise((r) => setTimeout(r, 50)); }
  });

  // ── plate → strata: a real brush over the whole scatter selects all 5 points ──
  await frameP.evaluate(() => {
    const cv = document.querySelector('#plate canvas');
    const r = cv.getBoundingClientRect();
    const ev = (type, x, y) => cv.dispatchEvent(new PointerEvent(type,
      { clientX: r.left + x, clientY: r.top + y, button: 0, bubbles: true, pointerId: 1 }));
    ev('pointerdown', 2, 2);
    ev('pointermove', r.width - 2, r.height - 2);
    ev('pointerup', r.width - 2, r.height - 2);
  });

  // strata receives a kind:"rows" descriptor of all 5 base ordinals → highlights all 5.
  const sHi = await frameS.evaluate(async () => {
    const deadline = Date.now() + 5000;
    let n = 0;
    while (Date.now() < deadline) { n = window._strataApp.grid.provider.highlightCount; if (n > 0) break; await new Promise((r) => setTimeout(r, 50)); }
    return { n, last: window._strataApp.lastSelection };
  });
  (sHi.n === 5 && sHi.last && sHi.last.kind === 'rows' && sHi.last.rows.length === 5)
    ? ok('brushing the plate scatter highlights all 5 rows in strata (plate → strata)')
    : fail(`strata did not highlight the brushed points: ${JSON.stringify(sHi)}`);

  // Echo suppression: plate must NOT highlight from its own publish (its brush is
  // a local amber selection, not an incoming indigo one).
  const pSelfEcho = await frameP.evaluate(() => window._plateSurface.plate.getPanelInstance(window._plateSurface.panelId).getHighlight());
  pSelfEcho === null ? ok('plate echo-suppressed (no self-highlight from its own brush)') : fail(`plate self-highlighted: ${JSON.stringify(pSelfEcho)}`);

  // ── strata → plate: select rows 0–1 → plate tints those two points ──
  await frameS.evaluate(() => window._strataApp.grid.setSelection({ r0: 0, c0: 0, r1: 1, c1: 0 }));
  const pHi = await frameP.evaluate(async () => {
    const inst = () => window._plateSurface.plate.getPanelInstance(window._plateSurface.panelId);
    const deadline = Date.now() + 5000;
    let h = null;
    while (Date.now() < deadline) { h = inst().getHighlight(); if (h && h.length) break; await new Promise((r) => setTimeout(r, 50)); }
    return h;
  });
  (pHi && pHi.slice().sort().join(',') === '0,1')
    ? ok('strata row-select tints the matching points in plate (strata → plate)')
    : fail(`plate did not tint the selected rows: ${JSON.stringify(pHi)}`);

  // ── strata filter → plate resolves the structured predicate over its own data ──
  await frameS.evaluate(() => window._strataApp.applyFilter('x > 3'));   // x>3 → base 3,4
  const pf = await frameP.evaluate(async () => {
    const inst = () => window._plateSurface.plate.getPanelInstance(window._plateSurface.panelId);
    const deadline = Date.now() + 5000;
    let h = null;
    while (Date.now() < deadline) { h = inst().getHighlight(); if (h && h.slice().sort().join(',') === '3,4') break; await new Promise((r) => setTimeout(r, 50)); }
    return { h, last: window._plateSurface.plate.lastSelection };
  });
  (pf.h && pf.h.slice().sort().join(',') === '3,4' && pf.last && pf.last.kind === 'filter' && pf.last.predicate && pf.last.predicate.form === 'spec')
    ? ok('strata filter (x>3) tints exactly the matching points in plate (structured predicate, no JS string on the bus)')
    : fail(`plate filter-highlight wrong: ${JSON.stringify(pf)}`);

  // ── the Linked toggle gates incoming selections (opt-in + visible §7) ──
  const pUnlink = await frameP.evaluate(() => { const P = window._plateSurface.plate; P.setLinked(false); return P.getPanelInstance(window._plateSurface.panelId).getHighlight(); });
  pUnlink === null ? ok('unlinking clears plate highlight') : fail(`unlink did not clear: ${JSON.stringify(pUnlink)}`);
  const pRelink = await frameP.evaluate(() => { const P = window._plateSurface.plate; P.setLinked(true); return P.getPanelInstance(window._plateSurface.panelId).getHighlight(); });
  (pRelink && pRelink.slice().sort().join(',') === '3,4') ? ok('re-linking restores plate highlight') : fail(`relink did not restore: ${JSON.stringify(pRelink)}`);

  errors.length ? fail('console errors: ' + errors.join(' | ')) : ok('no console errors');
} catch (e) {
  fail('smoke threw: ' + e.message);
} finally {
  await browser.close();
  server.close();
}
console.log(process.exitCode ? '\nPLATE↔STRATA LINK SMOKE: FAIL' : '\nPLATE↔STRATA LINK SMOKE: PASS');
