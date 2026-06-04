// strata selection-linking smoke — two strata surfaces on the SAME .strata file
// brush each other over the A-Bus Selection channel. Proves the selection/linking
// contract end-to-end: publish → broker fan-out → subscribe, echo-suppressed and
// dataset-scoped. (Visible highlight response is a later step; here we assert the
// descriptor crosses.)
//   node build.js --target=works && node test/strata-link-smoke.mjs
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

const t = createTable({
  schema: [{ name: 'dom', type: 'category' }, { name: 'grade', type: 'number' }],
  columns: [['ox', 'sulf', 'ox'], [1.5, 0.8, 4.2]],
  nrows: 3,
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

  // Two strata surfaces on the SAME path (spawnSurface doesn't dedup) → same dataset.
  const spawned = await page.evaluate(async (bytes) => {
    const W = window.WKS;
    await W.vfs.writeFile('/projects/demo.strata', new Uint8Array(bytes));
    const a = W.spawnSurface('strata', { path: '/projects/demo.strata', title: 'A' });
    const b = W.spawnSurface('strata', { path: '/projects/demo.strata', title: 'B' });
    const deadline = Date.now() + 20000;
    const ready = (id) => { const r = W.surfaces.get(id); return r && r.ready; };
    while ((!ready(a) || !ready(b)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    return { a, b, aReady: ready(a), bReady: ready(b) };
  }, strataBytes);
  (spawned.aReady && spawned.bReady) ? ok('two strata surfaces on the same .strata, both ready') : fail(`surfaces not ready: ${JSON.stringify(spawned)}`);

  const frameA = await surfaceFrame(spawned.a);
  const frameB = await surfaceFrame(spawned.b);
  const linked = await frameA.evaluate(() => window._strataApp.linked);
  linked ? ok('host.selection capability present (linked)') : fail('surface not linked');

  // A selects rows 0–1 → publishes a kind:"rows" descriptor.
  await frameA.evaluate(() => window._strataApp.grid.setSelection({ r0: 0, c0: 0, r1: 1, c1: 0 }));

  // B receives it (poll — signal fan-out is async).
  const got = await frameB.evaluate(async () => {
    const deadline = Date.now() + 5000;
    while (!window._strataApp.lastSelection && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    return window._strataApp.lastSelection;
  });
  (got && got.kind === 'rows' && JSON.stringify(got.rows) === '["0","1"]')
    ? ok(`B received A's row selection (rows ${JSON.stringify(got.rows)}, dataset scoped)`)
    : fail(`B did not receive the selection: ${JSON.stringify(got)}`);
  (got && got.dataset === '/projects/demo.strata' && got.origin && got.epoch >= 1)
    ? ok('descriptor carries dataset + origin + epoch')
    : fail(`descriptor fields wrong: ${JSON.stringify(got)}`);

  // VISIBLE HIGHLIGHT (the rung): B should have tinted the two brushed rows.
  const bHi = await frameB.evaluate(async () => {
    const deadline = Date.now() + 5000;
    let n = 0;
    while (Date.now() < deadline) { n = window._strataApp.grid.provider.highlightCount; if (n > 0) break; await new Promise((r) => setTimeout(r, 50)); }
    return n;
  });
  bHi === 2 ? ok('B visibly highlights the 2 brushed rows (brushing made visual)') : fail(`B highlight count wrong: ${bHi}`);

  // Echo suppression: A must NOT have received its own selection.
  const aEcho = await frameA.evaluate(() => window._strataApp.lastSelection);
  aEcho === null ? ok('echo-suppressed (A ignored its own selection)') : fail(`A received its own echo: ${JSON.stringify(aEcho)}`);

  // A filter publishes a kind:"filter" with the structured predicate spec.
  await frameA.evaluate(() => window._strataApp.applyFilter('grade > 1'));
  const filt = await frameB.evaluate(async () => {
    const deadline = Date.now() + 5000;
    const isFilter = () => window._strataApp.lastSelection && window._strataApp.lastSelection.kind === 'filter';
    while (!isFilter() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    return window._strataApp.lastSelection;
  });
  (filt && filt.kind === 'filter' && filt.predicate && filt.predicate.form === 'spec' && filt.predicate.root.op === '>')
    ? ok('B received A\'s filter as a structured predicate spec (no JS string on the bus)')
    : fail(`filter selection wrong: ${JSON.stringify(filt)}`);

  // The filter highlights EXACTLY the matching rows in B (grade>1 → base 0,2; not 1).
  const bf = await frameB.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 100));   // let the just-arrived filter apply
    const p = window._strataApp.grid.provider;
    const hi = (r) => { const c = p.cellAt(r, 0); return !!(c && c.style && c.style.highlight); };
    return { r0: hi(0), r1: hi(1), r2: hi(2), n: p.highlightCount };
  });
  (bf.r0 && !bf.r1 && bf.r2 && bf.n === 2)
    ? ok('B highlights exactly the rows matching A\'s filter predicate (grade>1 → 0,2)')
    : fail(`B filter-highlight wrong: ${JSON.stringify(bf)}`);

  // The "Linked" toggle gates it: unlink clears, re-link restores (opt-in + visible §7).
  const bUnlink = await frameB.evaluate(() => { window._strataApp.setLinked(false); return window._strataApp.grid.provider.highlightCount; });
  bUnlink === 0 ? ok('unlinking clears the highlight') : fail(`unlink did not clear: ${bUnlink}`);
  const bRelink = await frameB.evaluate(() => { window._strataApp.setLinked(true); return window._strataApp.grid.provider.highlightCount; });
  bRelink === 2 ? ok('re-linking restores the highlight') : fail(`relink did not restore: ${bRelink}`);

  errors.length ? fail('console errors: ' + errors.join(' | ')) : ok('no console errors');
} catch (e) {
  fail('smoke threw: ' + e.message);
} finally {
  await browser.close();
  server.close();
}
console.log(process.exitCode ? '\nSTRATA LINK SMOKE: FAIL' : '\nSTRATA LINK SMOKE: PASS');
