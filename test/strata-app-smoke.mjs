// strata standalone app smoke — drives tools/strata in headless Chromium over
// loopback HTTP: open the real blockmodel CSV, edit a cell in the grid, save to
// .strata bytes, reopen them, and assert the overlay edit survived the round
// trip through the live app (host wiring + model + loom + document).
// Not part of `npm test` (needs a browser): node test/strata-app-smoke.mjs
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
  await page.goto(`http://127.0.0.1:${port}/tools/strata/index.html`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window._strataApp, null, { timeout: 8000 });
  ok('app booted');

  // Open the real CSV through the app's entry point.
  const opened = await page.evaluate(async () => {
    const res = await fetch('/examples/data/blockmodel-sample.csv');
    const bytes = new Uint8Array(await res.arrayBuffer());
    window._strataApp.open('blockmodel-sample.csv', bytes);
    const t = window._strataApp.table;
    return { nrows: t.nrows, cols: t.cols, hasGrid: !!window._strataApp.grid };
  });
  opened.nrows > 1000 && opened.hasGrid ? ok(`opened CSV → grid (${opened.nrows} rows × ${opened.cols} cols)`) : fail(`open failed: ${JSON.stringify(opened)}`);

  // Edit a numeric cell through the grid UI.
  const box = await (await page.$('#grid')).boundingBox();
  await page.mouse.click(box.x + 70, box.y + 90); // X column, a few rows down
  await page.keyboard.type('777.77');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(80);

  const afterEdit = await page.evaluate(() => {
    const t = window._strataApp.table;
    const entries = [...t._overlay.entries()].map(([k, o]) => ({ k, value: o.value, base: o.base }));
    return { dirty: t.dirtyCount(), entries, footer: document.getElementById('dirty').textContent };
  });
  (afterEdit.dirty === 1 && afterEdit.footer === '1' && afterEdit.entries[0].value === 777.77)
    ? ok(`grid edit → overlay (cell ${afterEdit.entries[0].k}, base ${afterEdit.entries[0].base} → 777.77)`)
    : fail(`edit failed: ${JSON.stringify(afterEdit)}`);

  // Add a derived column through the app and check it computes.
  const dv = await page.evaluate(() => {
    const okAdd = window._strataApp.addColumn('metal', 'Au_gpt * density');
    const t = window._strataApp.table;
    const c = t.cols - 1;
    return { okAdd, cols: t.cols, isDerived: t.isDerived(c), v0: t.getCell(0, c).value,
             au0: t.columnByName('Au_gpt')[0], d0: t.columnByName('density')[0] };
  });
  const expectMetal = dv.au0 * dv.d0;
  (dv.okAdd && dv.isDerived && Math.abs(dv.v0 - expectMetal) < 1e-9)
    ? ok(`derived column computes (metal[0] = ${dv.v0.toFixed(4)} = Au_gpt·density)`)
    : fail(`derived column failed: ${JSON.stringify(dv)}`);

  // Save to .strata bytes and reopen — overlay AND the derived formula survive.
  const rt = await page.evaluate(async () => {
    const bytes = await window._strataApp.saveBytes();
    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
    window._strataApp.open('roundtrip.strata', bytes);
    const t = window._strataApp.table;
    const c = t.cols - 1;
    const e = [...t._overlay.entries()].map(([k, o]) => ({ k, value: o.value, base: o.base }));
    return { isZip, len: bytes.length, dirty: t.dirtyCount(), entry: e[0],
             derivedSurvived: t.isDerived(c), metal0: t.getCell(0, c).value };
  });
  rt.isZip ? ok(`saved .strata (${rt.len} bytes, zip magic)`) : fail('saved bytes are not a zip');
  (rt.dirty === 1 && rt.entry.value === 777.77 && afterEdit.entries[0].base === rt.entry.base)
    ? ok('reopened .strata → overlay edit + base preserved')
    : fail(`round-trip lost state: ${JSON.stringify(rt)}`);
  (rt.derivedSurvived && Math.abs(rt.metal0 - expectMetal) < 1e-9)
    ? ok('reopened .strata → derived column recomputed from formula')
    : fail(`derived round-trip lost: ${JSON.stringify(rt)}`);

  // Filter + click-to-sort through the app (on the reopened doc).
  const sf = await page.evaluate(() => {
    const t = window._strataApp.table, v = window._strataApp.view, g = window._strataApp.grid;
    const total = t.nrows;
    window._strataApp.applyFilter('Au_gpt > 1');     // filter to high-grade rows
    const filtered = v.length;
    const auIdx = t.schema.findIndex((s) => s.name === 'Au_gpt');
    window._strataApp.cycleSort(auIdx);              // asc
    window._strataApp.cycleSort(auIdx);              // → desc
    const top = g.provider.cellAt(0, auIdx).value;
    const next = g.provider.cellAt(1, auIdx).value;
    window._strataApp.applyFilter('');               // clear filter
    return { total, filtered, top, next, restored: v.length };
  });
  (sf.filtered > 0 && sf.filtered < sf.total && sf.top >= sf.next && sf.restored === sf.total)
    ? ok(`filter Au_gpt>1 (${sf.filtered}/${sf.total}) + sort desc (${sf.top} ≥ ${sf.next}); clear restores ${sf.restored}`)
    : fail(`sort/filter failed: ${JSON.stringify(sf)}`);

  // Group-by through the app: group the (now unfiltered) data by LITO.
  const gb = await page.evaluate(() => {
    const ok = window._strataApp.groupByColumn('LITO');
    const t = window._strataApp.table;            // now the summary table
    const litho = t.columnByName('LITO');
    const n = t.columnByName('n');
    const totalN = n.reduce((a, b) => a + b, 0);
    const hasMeanAu = t.schema.some((s) => s.name === 'mean_Au_gpt');
    return { ok, groups: t.nrows, litho, totalN, hasMeanAu, isDerivedKept: t.schema.length };
  });
  (gb.ok && gb.groups > 0 && gb.groups < 3200 && gb.totalN === 3200 && gb.hasMeanAu)
    ? ok(`group by LITO → ${gb.groups} groups, Σn=${gb.totalN}, mean_Au_gpt present`)
    : fail(`group-by failed: ${JSON.stringify(gb)}`);

  // "← Data" restores the detail table.
  const back = await page.evaluate(() => {
    window._strataApp.ungroup();
    return { rows: window._strataApp.table.nrows };
  });
  back.rows === 3200 ? ok('ungroup restores the detail table (3200 rows)') : fail(`ungroup failed: ${JSON.stringify(back)}`);

  // OVER transform → a new table (windows + match + check + project), via the bridge.
  const tx = await page.evaluate(() => {
    const ok = window._strataApp.transformWith([
      'AU_REL = Au_gpt / mean(Au_gpt) over LITO',
      'ORE = match Au_gpt { >=1: "ore", _: "waste" }',
      'check "au present": present(Au_gpt)',
      'saveonly(LITO, Au_gpt, AU_REL, ORE)',
    ].join('\n'));
    const t = window._strataApp.table;
    const rel = t.columnByName('AU_REL') || [];
    return {
      ok, nrows: t.nrows, cols: t.schema.map((s) => s.name),
      ore0: (t.columnByName('ORE') || [])[0],
      relFinite: rel.slice(0, 200).every((v) => v == null || Number.isFinite(v)),
    };
  });
  (tx.ok && tx.nrows === 3200 && JSON.stringify(tx.cols) === JSON.stringify(['LITO', 'Au_gpt', 'AU_REL', 'ORE']) && tx.relFinite)
    ? ok(`OVER transform → ${tx.cols.join(', ')} (${tx.nrows} rows); ORE[0]=${tx.ore0}`)
    : fail(`transform failed: ${JSON.stringify(tx)}`);

  errors.length ? fail('console errors: ' + errors.join(' | ')) : ok('no console errors');
} catch (e) {
  fail('smoke threw: ' + e.message);
} finally {
  await browser.close();
  server.close();
}
console.log(process.exitCode ? '\nSTRATA APP SMOKE: FAIL' : '\nSTRATA APP SMOKE: PASS');
