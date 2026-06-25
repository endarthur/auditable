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

  // Undo then redo the edit via the commands (then redo so the rest of the flow
  // still sees exactly one edit). Exercises the wrapped provider.undo/redo path.
  const ur = await page.evaluate(() => {
    const app = window._strataApp, t = app.table;
    app.runCommand('strata:undo');
    const afterUndo = { dirty: t.dirtyCount(), v: t.getCell(2, 0).value };
    app.runCommand('strata:redo');
    const afterRedo = { dirty: t.dirtyCount(), v: t.getCell(2, 0).value };
    return { afterUndo, afterRedo };
  });
  (ur.afterUndo.dirty === 0 && ur.afterRedo.dirty === 1 && ur.afterRedo.v === 777.77)
    ? ok(`undo/redo via command (dirty 1→0→1, cell 2:0 restored to ${ur.afterRedo.v})`)
    : fail(`undo/redo failed: ${JSON.stringify(ur)}`);

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
    const hdrSort = g.provider.header(auIdx).sort;   // the in-header arrow indicator
    window._strataApp.applyFilter('');               // clear filter
    return { total, filtered, top, next, restored: v.length, hdrSort };
  });
  (sf.filtered > 0 && sf.filtered < sf.total && sf.top >= sf.next && sf.restored === sf.total && sf.hdrSort === 'desc')
    ? ok(`filter Au_gpt>1 (${sf.filtered}/${sf.total}) + sort desc (${sf.top} ≥ ${sf.next}, header arrow=${sf.hdrSort}); clear restores ${sf.restored}`)
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

  // The command registry is enumerable + well-shaped (the palette/agent seam).
  const reg = await page.evaluate(() => window._strataApp.commands);
  const ids = reg.map((c) => c.id);
  const wanted = ['strata:open', 'strata:save', 'strata:save-as', 'strata:add-column', 'strata:group', 'strata:transform', 'strata:ungroup'];
  (wanted.every((id) => ids.includes(id)) && reg.every((c) => typeof c.label === 'string' && 'enabled' in c))
    ? ok(`command registry exposes ${reg.length} commands (${ids.join(', ')})`)
    : fail(`registry shape off: ${JSON.stringify(reg)}`);

  // +Col via the command + the new form modal (no native prompt()). Drive the
  // dialog DOM exactly as a user would: open, fill, OK.
  // NB: don't return the promise — runCommand resolves only after OK is clicked
  // below, and page.evaluate auto-awaits a returned promise → deadlock.
  await page.evaluate(() => { window._strataApp.runCommand('strata:add-column'); });
  await page.waitForSelector('input[data-name="name"]', { timeout: 2000 });
  await page.fill('input[data-name="name"]', 'metal2');
  await page.fill('input[data-name="formula"]', 'Au_gpt * 2');
  await page.click('button.fm-ok');
  await page.waitForTimeout(80);
  const modalAdd = await page.evaluate(() => {
    const t = window._strataApp.table;
    const c = t.schema.findIndex((s) => s.name === 'metal2');
    return { added: c >= 0, isDerived: c >= 0 && t.isDerived(c), v0: c >= 0 ? t.getCell(0, c).value : null, au0: (t.columnByName('Au_gpt') || [])[0], open: !!document.querySelector('input[data-name="name"]') };
  });
  (modalAdd.added && modalAdd.isDerived && !modalAdd.open && Math.abs(modalAdd.v0 - modalAdd.au0 * 2) < 1e-9)
    ? ok('+Col form modal (replaces prompt) added a derived column + closed')
    : fail(`+Col modal failed: ${JSON.stringify(modalAdd)}`);

  // Right-click an edited cell → context menu → "Revert to …" reverts it.
  const cbox = await (await page.$('#grid')).boundingBox();
  await page.mouse.click(cbox.x + 70, cbox.y + 90);   // select a base cell
  await page.keyboard.type('ZZZ');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(60);
  await page.mouse.click(cbox.x + 70, cbox.y + 90, { button: 'right' });
  await page.waitForTimeout(60);
  const ctxRevert = await page.evaluate(() => {
    const m = document.querySelector('.strata-ctx');
    if (!m) return { shown: false };
    const item = [...m.querySelectorAll('div')].find((d) => /Revert to/.test(d.textContent));
    if (!item) return { shown: true, hasRevert: false, text: m.textContent };
    const before = window._strataApp.table.dirtyCount();
    item.click();
    return { shown: true, hasRevert: true, label: item.textContent, before, after: window._strataApp.table.dirtyCount() };
  });
  (ctxRevert.shown && ctxRevert.hasRevert && ctxRevert.after === ctxRevert.before - 1)
    ? ok(`right-click "${ctxRevert.label}" reverts (dirty ${ctxRevert.before}→${ctxRevert.after})`)
    : fail(`context revert failed: ${JSON.stringify(ctxRevert)}`);

  // Column-header ▾ menu (right-click): revert all edits in a column, then sort.
  await page.evaluate(() => { const p = window._strataApp.grid.provider; p.commit(0, 1, '1'); p.commit(1, 1, '2'); window._strataApp.grid.refresh(); });
  const hbox = await (await page.$('#grid')).boundingBox();
  await page.mouse.click(hbox.x + 186, hbox.y + 12, { button: 'right' }); // col 1 (Au_gpt) header
  await page.waitForTimeout(60);
  const hdrRevert = await page.evaluate(() => {
    const m = document.querySelector('.strata-ctx');
    if (!m) return { shown: false };
    const item = [...m.querySelectorAll('div')].find((d) => /Revert \d+ edits? in column/.test(d.textContent));
    const before = window._strataApp.table.dirtyCount();
    if (item) item.click();
    return { shown: true, label: item && item.textContent, before, after: window._strataApp.table.dirtyCount() };
  });
  (hdrRevert.shown && /Revert 2 edits/.test(hdrRevert.label || '') && hdrRevert.after === hdrRevert.before - 2)
    ? ok(`header ▾ "${hdrRevert.label}" (dirty ${hdrRevert.before}→${hdrRevert.after})`)
    : fail(`header revert-column failed: ${JSON.stringify(hdrRevert)}`);

  await page.mouse.click(hbox.x + 186, hbox.y + 12, { button: 'right' });
  await page.waitForTimeout(60);
  const hdrSort = await page.evaluate(() => {
    const m = document.querySelector('.strata-ctx');
    const item = m && [...m.querySelectorAll('div')].find((d) => /Sort ascending/.test(d.textContent));
    if (item) item.click();
    const v = window._strataApp.view;
    return { clicked: !!item, sort: v && v.sortSpec };
  });
  (hdrSort.clicked && hdrSort.sort && hdrSort.sort.by === 'Au_gpt' && hdrSort.sort.dir === 'asc')
    ? ok(`header ▾ "Sort ascending" (${hdrSort.sort.by} ${hdrSort.sort.dir})`)
    : fail(`header sort failed: ${JSON.stringify(hdrSort)}`);

  // Header ▾ "Filter…" → per-column quick-filter composes into the view.
  await page.mouse.click(hbox.x + 186, hbox.y + 12, { button: 'right' });   // Au_gpt header
  await page.waitForTimeout(60);
  await page.evaluate(() => {
    const m = document.querySelector('.strata-ctx');
    const item = [...m.querySelectorAll('div')].find((d) => d.textContent === 'Filter…');
    if (item) item.click();
  });
  await page.waitForSelector('input[data-name="expr"]', { timeout: 2000 });
  await page.fill('input[data-name="expr"]', '> 2');
  await page.click('button.fm-ok');
  await page.waitForTimeout(80);
  const colFilt = await page.evaluate(() => {
    const v = window._strataApp.view, t = window._strataApp.table;
    const ci = t.schema.findIndex((s) => s.name === 'Au_gpt');
    return { len: v.length, total: t.nrows, filtered: window._strataApp.grid.provider.header(ci).filtered };
  });
  (colFilt.len > 0 && colFilt.len < colFilt.total && colFilt.filtered === true)
    ? ok(`per-column filter Au_gpt > 2 (${colFilt.len}/${colFilt.total}, header funnel shown)`)
    : fail(`per-column filter failed: ${JSON.stringify(colFilt)}`);

  // Header ▾ "Hide column" → fewer columns; "Show <name>" from any header restores.
  const colsBefore = await page.evaluate(() => window._strataApp.grid.provider.dims().cols);
  await page.mouse.click(hbox.x + 94, hbox.y + 12, { button: 'right' });   // col 0 (LITO) header
  await page.waitForTimeout(60);
  await page.evaluate(() => { const m = document.querySelector('.strata-ctx'); const it = [...m.querySelectorAll('div')].find((d) => d.textContent === 'Hide column'); if (it) it.click(); });
  await page.waitForTimeout(60);
  const colsHidden = await page.evaluate(() => window._strataApp.grid.provider.dims().cols);
  await page.mouse.click(hbox.x + 94, hbox.y + 12, { button: 'right' });   // any header now
  await page.waitForTimeout(60);
  const shown = await page.evaluate(() => {
    const m = document.querySelector('.strata-ctx');
    const it = m && [...m.querySelectorAll('div')].find((d) => d.textContent === 'Show LITO');
    if (it) it.click();
    return { had: !!it, cols: window._strataApp.grid.provider.dims().cols };
  });
  (colsHidden === colsBefore - 1 && shown.had && shown.cols === colsBefore)
    ? ok(`header ▾ hide/show column (cols ${colsBefore}→${colsHidden}→${shown.cols})`)
    : fail(`hide/show failed: ${JSON.stringify({ colsBefore, colsHidden, shown })}`);

  // Header ▾ Type → change a column's type (relabel).
  await page.mouse.click(hbox.x + 186, hbox.y + 12, { button: 'right' });   // Au_gpt header
  await page.waitForTimeout(60);
  const typed = await page.evaluate(() => {
    const m = document.querySelector('.strata-ctx');
    const it = m && [...m.querySelectorAll('div')].find((d) => /Category$/.test(d.textContent));
    const before = window._strataApp.table.schema.find((s) => s.name === 'Au_gpt').type;
    if (it) it.click();
    return { had: !!it, before, after: window._strataApp.table.schema.find((s) => s.name === 'Au_gpt').type };
  });
  (typed.had && typed.before === 'number' && typed.after === 'category')
    ? ok(`header ▾ Type → Au_gpt ${typed.before}→${typed.after}`)
    : fail(`convert type failed: ${JSON.stringify(typed)}`);

  // Columns… dialog: reorder (▼), hide via checkbox, Reset order, Show all, OK.
  await page.evaluate(() => { window._strataApp.runCommand('strata:columns'); });
  await page.waitForSelector('.strata-cols-modal', { timeout: 2000 });
  const dlg = await page.evaluate(() => {
    const m = document.querySelector('.strata-cols-modal');
    const P = window._strataApp.grid.provider;
    const rows = () => [...m.querySelectorAll('div[draggable]')];
    const order0 = P.columnOrder().join(',');
    rows()[0].querySelectorAll('button')[1].click();           // ▼ on first row
    const orderMoved = P.columnOrder().join(',');
    const cols0 = P.dims().cols;
    rows()[0].querySelector('input[type=checkbox]').click();    // hide the new first column
    const colsHidden = P.dims().cols;
    const fbtns = [...m.querySelectorAll('button')];
    fbtns.find((b) => b.textContent === 'Reset order').click();
    const orderReset = P.columnOrder().join(',');
    fbtns.find((b) => b.textContent === 'Show all').click();
    const colsShown = P.dims().cols;
    fbtns.find((b) => b.textContent === 'OK').click();
    return { order0, orderMoved, cols0, colsHidden, orderReset, colsShown, open: !!document.querySelector('.strata-cols-modal') };
  });
  (dlg.orderMoved !== dlg.order0 && dlg.colsHidden === dlg.cols0 - 1
    && dlg.orderReset === dlg.order0 && dlg.colsShown === dlg.cols0 && !dlg.open)
    ? ok(`Columns dialog: reorder (${dlg.order0}→${dlg.orderMoved}) + hide (${dlg.cols0}→${dlg.colsHidden}) + reset/show-all restore`)
    : fail(`columns dialog failed: ${JSON.stringify(dlg)}`);

  // ── validation: a check tints failing cells + summarizes; filter-to-failures ──
  await page.evaluate(() => window._strataApp.clearFilters());   // clear global + per-column filters
  const v1 = await page.evaluate(() => {
    const app = window._strataApp;
    app.addCheck('au<=5', 'Au_gpt <= 5');
    const ci = app.table.schema.findIndex((s) => s.name === 'Au_gpt');
    return { total: app.validation.total, nrows: app.table.nrows, hdr: app.grid.provider.header(ci).invalid, footer: document.getElementById('meta').textContent };
  });
  (v1.total > 0 && v1.total < v1.nrows && v1.hdr === true && /failing rows/.test(v1.footer))
    ? ok(`validation: Au_gpt<=5 → ${v1.total} failing rows + header ⚠ + footer`)
    : fail(`validation failed: ${JSON.stringify(v1)}`);
  const v2 = await page.evaluate(() => {
    const app = window._strataApp;
    const total = app.validation.total;
    app.filterToFailures();
    const shown = app.view.length;
    app.applyFilter('');
    app.removeCheck(0);
    return { total, shown, cleared: app.validation };
  });
  (v2.shown === v2.total && v2.cleared === null)
    ? ok(`filter-to-failures shows ${v2.shown} failing rows; removeCheck clears validation`)
    : fail(`filter-to-failures/clear failed: ${JSON.stringify(v2)}`);

  // ── Checks… dialog: add via the inputs (listed + live count), then ✕ removes ──
  await page.evaluate(() => { window._strataApp.clearFilters(); window._strataApp.runCommand('strata:checks'); });
  await page.waitForSelector('.strata-checks-modal', { timeout: 2000 });
  await page.fill('.strata-checks-modal input[placeholder^="condition"]', 'Au_gpt <= 8');
  await page.evaluate(() => [...document.querySelectorAll('.strata-checks-modal button')].find((b) => b.textContent === 'Add').click());
  await page.waitForTimeout(60);
  const cd = await page.evaluate(() => {
    const app = window._strataApp;
    return { count: app.table.checkCount, formula: app.table.checks[0] && app.table.checks[0].formula, total: app.validation && app.validation.total, hasRow: !!document.querySelector('.strata-checks-modal div > span') };
  });
  (cd.count === 1 && cd.formula === 'Au_gpt <= 8' && cd.total > 0 && cd.hasRow)
    ? ok(`Checks dialog: added "Au_gpt <= 8" → ${cd.total} failing, listed`)
    : fail(`checks dialog add failed: ${JSON.stringify(cd)}`);
  await page.evaluate(() => [...document.querySelectorAll('.strata-checks-modal button')].find((b) => b.textContent === '✕').click());
  await page.waitForTimeout(40);
  const removed = await page.evaluate(() => window._strataApp.table.checkCount);
  removed === 0 ? ok('Checks dialog: ✕ removes the check') : fail(`remove failed: ${removed}`);
  await page.keyboard.press('Escape');

  // ── checks persist through a .strata save/reopen ──
  const rt2 = await page.evaluate(async () => {
    const app = window._strataApp;
    app.addCheck('au>=0', 'Au_gpt >= 0');
    const bytes = await app.saveBytes();
    app.open('rt.strata', bytes);
    return { count: app.table.checkCount, name: app.table.checks[0] && app.table.checks[0].name };
  });
  (rt2.count === 1 && rt2.name === 'au>=0')
    ? ok('checks persist through .strata save/reopen')
    : fail(`checks round-trip failed: ${JSON.stringify(rt2)}`);

  // ── header ▾ "Require not null" template → a one-click check ──
  await page.evaluate(() => { window._strataApp.clearFilters(); window._strataApp.table.clearChecks(); window._strataApp.runValidation(); });
  await page.mouse.click(hbox.x + 186, hbox.y + 12, { button: 'right' });   // Au_gpt header
  await page.waitForTimeout(60);
  await page.evaluate(() => { const m = document.querySelector('.strata-ctx'); const it = [...m.querySelectorAll('div')].find((d) => d.textContent === 'Require not null'); if (it) it.click(); });
  await page.waitForTimeout(60);
  const tmpl = await page.evaluate(() => {
    const app = window._strataApp;
    return { count: app.table.checkCount, formula: app.table.checks[0] && app.table.checks[0].formula };
  });
  (tmpl.count === 1 && tmpl.formula === 'Au_gpt != null')
    ? ok(`header ▾ "Require not null" → check "${tmpl.formula}"`)
    : fail(`require-template failed: ${JSON.stringify(tmpl)}`);

  errors.length ? fail('console errors: ' + errors.join(' | ')) : ok('no console errors');
} catch (e) {
  fail('smoke threw: ' + e.message);
} finally {
  await browser.close();
  server.close();
}
console.log(process.exitCode ? '\nSTRATA APP SMOKE: FAIL' : '\nSTRATA APP SMOKE: PASS');
