// Browser smoke test for tools/micro/index.html — the point-cloud / block-model
// viewer. A DURABLE guard over the load-bearing INTEGRATION paths (the app
// wiring, as opposed to the library logic already covered by condenser/gtiff/
// parquet/winding unit tests). The exhaustive per-feature smokes live in the
// gitignored experiments/ folder; this is the curated subset that ships with
// the repo and can run in CI.
//
// Not part of `npm test` (a slow Playwright run, like works-smoke / examples-
// smoke). Run directly:  node test/micro-smoke.mjs
//   — covers: CSV block model (grid + pick), XYZ points, GeoTIFF grid,
//     Parquet (footer discovery + filter + predicate pushdown), a mesh solid
//     flag (winding), a CSV filter, and a project save→reopen round trip.

import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeParquet, parquetInfo } from '../ext/parquet/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  const file = path.join(root, decodeURIComponent(p));
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); res.end(data);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

// ── a minimal single-IFD GeoTIFF fixture (uncompressed float32 strip + geo) ──
function geoTiff(W, H, val) {
  const f32le = (vals) => { const b = new Uint8Array(vals.length * 4), v = new DataView(b.buffer); vals.forEach((x, i) => v.setFloat32(i * 4, x, true)); return b; };
  const dblle = (vals) => { const b = new Uint8Array(vals.length * 8), v = new DataView(b.buffer); vals.forEach((x, i) => v.setFloat64(i * 8, x, true)); return b; };
  const img = f32le(Array.from({ length: W * H }, (_, i) => val((i / W) | 0, i % W)));
  const defs = [
    [256, 3, 1, [W]], [257, 3, 1, [H]], [258, 3, 1, [32]], [259, 3, 1, [1]], [262, 3, 1, [1]],
    [273, 4, 1, 'IMG'], [277, 3, 1, [1]], [278, 3, 1, [H]], [279, 4, 1, [img.length]], [339, 3, 1, [3]],
    [33550, 12, 3, dblle([10, 10, 0])], [33922, 12, 6, dblle([0, 0, 0, 612000, 7765000 + H * 10, 0])],
  ].sort((a, b) => a[0] - b[0]);
  const headLen = 8 + 2 + defs.length * 12 + 4;
  const u16 = (a, v) => a.push(v & 255, v >> 8), u32 = (a, v) => a.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
  let tailOff = headLen; const body = [], tails = [];
  u16(body, defs.length);
  for (const [tag, type, count, v] of defs) {
    u16(body, tag); u16(body, type); u32(body, count);
    if (v === 'IMG') { u32(body, 0); continue; }
    let vb = v;
    if (Array.isArray(v)) { const a = []; for (const x of v) (type === 3 ? u16 : u32)(a, x); vb = new Uint8Array(a); }
    if (vb.length <= 4) body.push(...vb, ...new Array(4 - vb.length).fill(0));
    else { u32(body, tailOff); tails.push(vb); tailOff += vb.length; }
  }
  u32(body, 0);
  const imgOff = tailOff;
  const file = new Uint8Array(8 + body.length + tails.reduce((t, b) => t + b.length, 0) + img.length);
  file.set([0x49, 0x49, 42, 0, 8, 0, 0, 0]); file.set(body, 8);
  let o = headLen; for (const t of tails) { file.set(t, o); o += t.length; } file.set(img, o);
  const dv = new DataView(file.buffer);
  for (let i = 0; i < defs.length; i++) { const e = 8 + 2 + i * 12; if (dv.getUint16(e, true) === 273) dv.setUint32(e + 8, imgOff, true); }
  return file;
}

// a two-bench regular block model (shared by several checks)
function blockCsv() {
  let csv = 'XC,YC,ZC,FE,LITO\n';
  for (const z of [650, 660]) for (let j = 0; j < 20; j++) for (let i = 0; i < 30; i++)
    csv += `${612000 + i * 10},${7765000 + j * 10},${z},${30 + (i % 40)},${i % 3 === 0 ? 'HEMATITE' : i % 3 === 1 ? 'ITABIRITE' : 'WASTE'}\n`;
  return csv;
}
const NBLOCKS = 1200;
// a closed OBJ box covering the left third of the model (winding solid)
function objBox() {
  const x0 = 611995, x1 = 612105, y0 = 7764995, y1 = 7765205, z0 = 600, z1 = 700;
  const V = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const T = [[1, 3, 2], [1, 4, 3], [5, 6, 7], [5, 7, 8], [1, 2, 6], [1, 6, 5], [3, 4, 8], [3, 8, 7], [1, 5, 8], [1, 8, 4], [2, 3, 7], [2, 7, 6]];
  return V.map((v) => `v ${v.join(' ')}`).concat(T.map((f) => `f ${f.join(' ')}`)).join('\n');
}

const parquet = new Uint8Array(writeParquet({ columnData: (() => {
  const XC = [], YC = [], ZC = [], FE = [], LITO = [];
  for (const z of [650, 660]) for (let j = 0; j < 20; j++) for (let i = 0; i < 30; i++) { XC.push(612000 + i * 10); YC.push(7765000 + j * 10); ZC.push(z); FE.push(30 + (i % 40)); LITO.push(i % 3 === 0 ? 'HEMATITE' : i % 3 === 1 ? 'ITABIRITE' : 'WASTE'); }
  return [{ name: 'XC', data: XC }, { name: 'YC', data: YC }, { name: 'ZC', data: ZC }, { name: 'FE', data: FE }, { name: 'LITO', data: LITO }];
})(), rowGroupSize: 512 }));

const b = await chromium.launch({ args: ['--use-gl=angle'] });
const ctx = await b.newContext({ viewport: { width: 1000, height: 700 } });
let ok = true;
const chk = (name, cond) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); ok = ok && cond; };

// ── 0. the BUILT micro.html (deploy artifact) boots — catches bundling bugs the
//    dev-tree tests below can't (a lib import not wired into the registry build) ──
if (fs.existsSync(path.join(root, 'micro.html'))) {
  const bp = await ctx.newPage(); const bootErrs = [];
  bp.on('pageerror', (e) => bootErrs.push(e.message));
  await bp.goto(`http://127.0.0.1:${PORT}/micro.html`, { waitUntil: 'load' });
  let booted = true; try { await bp.waitForFunction(() => window._micro && window._micro.declusterWeights, null, { timeout: 20000 }); } catch { booted = false; }
  chk(`built micro.html boots (no bundling errors: ${bootErrs.length ? bootErrs.join(' ; ') : 'none'})`, booted && bootErrs.length === 0);
  await bp.close();
} else { console.log('note: micro.html not built — skipping the built-boot guard (run: node build.js --target=micro)'); }

const p = await ctx.newPage();
p.on('pageerror', (e) => { console.log('PAGEERROR:', e.message); process.exitCode = 1; });
await p.goto(`http://127.0.0.1:${PORT}/tools/micro/index.html`, { waitUntil: 'load' });
await p.waitForFunction(() => window._micro, null, { timeout: 20000 });
const layerReady = (name) => p.waitForFunction((n) => { const L = window._micro.layers().find((x) => x.name === n); return L && window._micro.renderer.layerElementCount(L.id) > 0; }, name, { timeout: 60000 });

// ── 1. CSV block model → regular grid inferred ──
await p.evaluate((csv) => window._micro.openBlob(new Blob([csv]), 'model.csv', 'replace'), blockCsv());
await layerReady('model.csv');
const csvInfo = await p.evaluate(() => { const h = window._micro.layers()[0].docs.blockDoc.header; return { n: window._micro.renderer.layerElementCount(window._micro.layers()[0].id), grid: h.grid && [h.grid.x.count, h.grid.y.count, h.grid.z.count].join(), cats: (h.categories || []).length }; });
chk(`CSV block model: ${csvInfo.n} blocks, grid ${csvInfo.grid}, ${csvInfo.cats} categories`, csvInfo.n === NBLOCKS && csvInfo.grid === '30,20,2' && csvInfo.cats === 3);

// ── 1b. command palette: opens, filters, context-aware, runs ──
const pal = await p.evaluate(() => {
  window._micro.openPalette();
  const type = (q) => { const i = document.querySelector('#palInput'); i.value = q; i.dispatchEvent(new Event('input')); };
  type('swath'); const swath = [...document.querySelectorAll('#palList .pal-item .pal-t')].some((e) => /Swath/.test(e.textContent));
  type('reconcile'); const rec = [...document.querySelectorAll('#palList .pal-item .pal-t')].some((e) => /reconcile/i.test(e.textContent));
  window._micro.closePalette();
  return { open: !!document.querySelector('#palOverlay'), swath, rec };
});
chk(`command palette: filters to Swath (${pal.swath}) + Join/reconcile (${pal.rec}) on a block model`, pal.swath && pal.rec);

// ── 1c. viewport decorations + figure export ──
await new Promise((r) => setTimeout(r, 300));
const deco = await p.evaluate(async () => {
  window._micro.setDeco('scale', true); window._micro.setDeco('legend', true);
  const dc = document.querySelector('#decoCv');
  const drawn = dc.width > 0;
  const g = dc.getContext('2d'); const d = g.getImageData(0, 0, dc.width, dc.height).data;
  let painted = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) painted++;
  window._lastFigure = null; window._micro.exportFigure();
  await new Promise((r) => setTimeout(r, 400));
  const fb = window._lastFigure, buf = fb ? new Uint8Array(await fb.arrayBuffer()) : null;
  window._micro.setDeco('scale', false); window._micro.setDeco('legend', false);
  return { drawn, painted, png: !!buf && buf[0] === 0x89 && buf[1] === 0x50, size: fb ? fb.size : 0 };
});
chk(`decorations overlay draws (${deco.painted} px) + figure export → PNG (${deco.size} bytes)`, deco.drawn && deco.painted > 100 && deco.png && deco.size > 1000);
// background colour: clears to white then back to basalt (flows through EDL)
const bg = await p.evaluate(async () => {
  const sample = async () => { await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); const cv = document.querySelector('#cv'), c = document.createElement('canvas'); c.width = cv.width; c.height = cv.height; const g = c.getContext('2d'); g.drawImage(cv, 0, 0); const d = g.getImageData(2, 2, 1, 1).data; return [d[0], d[1], d[2]]; };
  window._micro.setBg('#ffffff'); const w = await sample(); window._micro.setBg('#121212'); const d = await sample();
  return { w, d, bgApi: window._micro.renderer.background[0] < 0.2 };
});
chk(`background colour: white [${bg.w}] → basalt [${bg.d}]`, bg.w[0] > 240 && bg.d[0] < 40 && bg.bgApi);

// ── 1d. window management: open windows → cascade → close all ──
const wm = await p.evaluate(async () => {
  const m = window._micro, L = m.layers()[0];
  m.openGradeTonnage(L); m.openSwath(L);
  await new Promise((r) => setTimeout(r, 300));
  const opened = document.querySelectorAll('.fwin').length;
  m.cascadeWindows();
  const lefts = [...document.querySelectorAll('.fwin')].map((e) => e.style.left);
  m.closeAllWindows();
  await new Promise((r) => setTimeout(r, 100));
  return { opened, cascadedDistinct: new Set(lefts).size === lefts.length && lefts.length === 2, closed: document.querySelectorAll('.fwin').length };
});
chk(`window management: opened ${wm.opened}, cascade offsets them (${wm.cascadedDistinct}), close-all → ${wm.closed}`, wm.opened === 2 && wm.cascadedDistinct && wm.closed === 0);

// ── 1e. Sealed badge: visible + the security popover ──
const seal = await p.evaluate(() => {
  const badge = document.querySelector('#sealBadge'); const visible = !!badge && /Sealed/.test(badge.textContent);
  badge.click(); const pop = document.querySelector('#sealPop');
  const info = pop ? { net: /No network access/.test(pop.textContent), link: !!pop.querySelector('a[href*="gentropic.org/security"]') } : {};
  badge.click(); const closed = !document.querySelector('#sealPop');
  return { visible, ...info, closed };
});
chk(`Sealed badge: visible, popover states no-network + verifier link, toggles closed`, seal.visible && seal.net && seal.link && seal.closed);

// ── 2. pick reads a record ──
await p.evaluate(() => { document.querySelector('#compass').dispatchEvent(new MouseEvent('click')); document.querySelector('#btnFit').click(); const px = document.querySelector('#ptPx'); px.value = 6; px.dispatchEvent(new Event('input')); });
await p.waitForFunction(() => /converged/.test(document.querySelector('#stats').textContent), null, { timeout: 60000 });
await p.evaluate(() => window._micro.showRecord((window._micro.layers()[0].id << 29) | 100));
await p.waitForFunction(() => document.querySelector('#recPanel').classList.contains('show'), null, { timeout: 10000 });
const rec = await p.evaluate(() => Object.fromEntries([...document.querySelectorAll('#recPanel .rp-row')].map((r) => [r.querySelector('.k').textContent, r.querySelector('.v').textContent])));
chk(`pick record 100: XC ${rec.XC}, LITO ${rec.LITO}`, +rec.XC === 612100 && rec.LITO === 'ITABIRITE');

// ── 2b. record-panel field selection (search + all/none + hidden set) ──
const recN = await p.evaluate(() => document.querySelectorAll('#recPanel .rp-row').length);
await p.evaluate(() => document.querySelector('#rpFieldsBtn').click());
await p.waitForFunction(() => document.querySelector('#rpCfg').classList.contains('show'), null, { timeout: 3000 });
const pickerUI = await p.evaluate(() => !!document.querySelector('#rpCfg .rp-search') && document.querySelectorAll('#rpCfg .rp-links a').length === 2 && document.querySelectorAll('#rpCfg .rp-checks label').length === document.querySelectorAll('#recPanel .rp-row').length);
chk('field picker: search + all/none + a checkbox per field', pickerUI);
await p.evaluate(() => { const cb = [...document.querySelectorAll('#rpCfg .rp-checks label')].find((l) => l.textContent.includes('FE')).querySelector('input'); cb.checked = false; cb.dispatchEvent(new Event('change')); });
const afterHide = await p.evaluate(() => [...document.querySelectorAll('#recPanel .rp-row .k')].map((e) => e.textContent));
chk(`hiding FE drops it from the record (${recN}→${afterHide.length})`, afterHide.length === recN - 1 && !afterHide.includes('FE') && afterHide.includes('XC'));
await p.evaluate(() => document.querySelectorAll('#rpCfg .rp-links a')[0].click());   // all → restore
chk('“all” restores every field', (await p.evaluate(() => document.querySelectorAll('#recPanel .rp-row').length)) === recN);
await p.evaluate(() => { document.querySelector('#rpFieldsBtn').click(); const L = window._micro.layers()[0]; L._recHide = new Set(); });

// ── 3. CSV filter (predicate over the model) ──
await p.evaluate(() => { const i = document.querySelector('#filter'); i.value = 'LITO = "HEMATITE" and FE > 45'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); });
await p.waitForFunction(() => window._micro.layers()[0]._filterMask, null, { timeout: 30000 });
const fmask = await p.evaluate(() => { let h = 0; for (const m of window._micro.layers()[0]._filterMask) if (m) h++; return h; });
chk(`CSV filter LITO+FE → ${fmask} hits`, fmask === 160);
await p.evaluate(() => { const i = document.querySelector('#filter'); i.value = ''; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); });

// ── 4. a mesh SOLID flags blocks inside it (winding pipeline) ──
await p.evaluate((obj) => window._micro.openBlob(new Blob([obj]), 'box.obj', 'add'), objBox());
await p.waitForFunction(() => window._micro.layers().some((L) => L.kind === 'mesh'), null, { timeout: 60000 });
await p.evaluate(async () => {
  const m = window._micro;
  const mesh = m.layers().find((L) => L.kind === 'mesh'); const model = m.layers().find((L) => L.name === 'model.csv');
  await m.flagBySolid(mesh, [model], { name: 'INBOX', label: 'Y', mode: 'inside' });
});
const flagged = await p.evaluate(() => { const col = window._micro.layers().find((L) => L.name === 'model.csv').paintCols.find((c) => c.name === 'INBOX'); let n = 0; for (const c of col.codes) if (c) n++; return n; });
// box XC 611995..612105 → columns i=0..10 (612000..612100 inside) = 11 cols
// × all 20 Y rows × both benches = 440
chk(`mesh solid flag: ${flagged} blocks inside the box (winding)`, flagged === 440);

// ── 5. GeoTIFF grid opens as a heightfield layer ──
await p.evaluate((bytes) => window._micro.openBlob(new Blob([new Uint8Array(bytes)]), 'dem.tif', 'add'), [...geoTiff(30, 20, (r, c) => 700 + r + c)]);
await layerReady('dem.tif');
const gridInfo = await p.evaluate(() => { const L = window._micro.layers().find((x) => x.name === 'dem.tif'); const g = L.docs.gridDoc.grid; return { nx: g.nx, ny: g.ny, crs: g.crs }; });
chk(`GeoTIFF grid: ${gridInfo.nx}×${gridInfo.ny}`, gridInfo.nx === 30 && gridInfo.ny === 20);

// ── 6. Parquet: footer discovery + filter + predicate pushdown ──
await p.evaluate((bytes) => window._micro.openBlob(new Blob([new Uint8Array(bytes)]), 'model.parquet', 'add'), [...parquet]);
await layerReady('model.parquet');
const pqInfo = await p.evaluate(() => { const L = window._micro.layers().find((x) => x.name === 'model.parquet'); const h = L.docs.blockDoc.header; return { n: window._micro.renderer.layerElementCount(L.id), grid: h.grid && [h.grid.x.count, h.grid.y.count, h.grid.z.count].join(), heldCols: !!(L.docs.blockDoc.parquet && L.docs.blockDoc.parquet.cols) }; });
chk(`Parquet block model: ${pqInfo.n} blocks, grid ${pqInfo.grid}, holds no decoded columns (${!pqInfo.heldCols})`, pqInfo.n === NBLOCKS && pqInfo.grid === '30,20,2' && !pqInfo.heldCols);
await p.evaluate(() => window._micro.setActiveLayer(window._micro.layers().find((L) => L.name === 'model.parquet').id));
await p.evaluate(() => { window.__pqFilterSkipped = 0; const i = document.querySelector('#filter'); i.value = 'ZC > 655'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); });
await p.waitForFunction(() => window._micro.layers().find((L) => L.name === 'model.parquet')._filterMask || document.querySelector('#filter').classList.contains('err'), null, { timeout: 30000 });
const pqFilt = await p.evaluate(() => { const L = window._micro.layers().find((x) => x.name === 'model.parquet'); let h = 0; for (const m of L._filterMask || []) if (m) h++; return { h, skipped: window.__pqFilterSkipped || 0, groups: L.docs.blockDoc.parquet.rowGroups.length }; });
chk(`Parquet filter ZC>655 → ${pqFilt.h} hits, ${pqFilt.skipped}/${pqFilt.groups} groups skipped by the footer`, pqFilt.h === 600 && pqFilt.skipped > 0);
await p.evaluate(() => { const i = document.querySelector('#filter'); i.value = ''; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); });

// ── 6b. export the model AS Parquet (compact, columnar) + read it back ──
await p.evaluate(async () => { const m = window._micro; await m.runExport(m.layers().find((L) => L.name === 'model.csv'), { scope: 'all', format: 'parquet', codec: 'SNAPPY', download: false }); });
const exBytes = await p.evaluate(async () => { const u = new Uint8Array(await window._lastExport.arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); });
const exInfo = parquetInfo(Uint8Array.from(atob(exBytes), (c) => c.charCodeAt(0)));
// includes the base columns AND the INBOX painted column from the flag step
const exNames = exInfo.columns.map((c) => c.name);
chk(`export as Parquet: ${exInfo.rowCount} rows, ${exInfo.codec}, cols [${exNames}]`, exInfo.rowCount === NBLOCKS && exInfo.codec === 'SNAPPY' && exNames.includes('XC') && exNames.includes('LITO') && exNames.includes('INBOX'));

// ── 7. XYZ points fall through to the points pipeline ──
await p.evaluate(() => { let s = ''; for (let i = 0; i < 200; i++) s += `${612000 + i} ${7765000 + i} ${650 + (i % 10)}\n`; return window._micro.openBlob(new Blob([s]), 'cloud.xyz', 'add'); });
await layerReady('cloud.xyz');
const xyzN = await p.evaluate(() => window._micro.renderer.layerElementCount(window._micro.layers().find((L) => L.name === 'cloud.xyz').id));
chk(`XYZ points: ${xyzN} points`, xyzN === 200);

// ── 7b. spatial join: resample a compatible fine model onto a coarse grid →
//    a new block-model layer; reconcile Δ preset. A = 10 m (2×2), B = 5 m (4×4)
//    whose grade averages back to A per parent cell (aggregate mean == A, Δ==0).
await p.evaluate(() => { const m = window._micro; for (const L of [...m.layers()]) m.renderer.removeLayer(L.id); m.layers().length = 0; });
await p.evaluate(() => {
  const Aval = (i, j) => 100 * (i + 2 * j + 1);
  let s = 'XC,YC,ZC,FE\n'; for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) s += `${5 + i * 10},${5 + j * 10},650,${Aval(i, j)}\n`;
  return window._micro.openBlob(new Blob([s]), 'A.csv', 'replace');
});
await layerReady('A.csv');
await p.evaluate(() => {
  const Aval = (i, j) => 100 * (i + 2 * j + 1), bump = (bi, bj) => [-3, -1, 1, 3][(bi % 2) + 2 * (bj % 2)];
  let s = 'XC,YC,ZC,FE\n'; for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) s += `${2.5 + i * 5},${2.5 + j * 5},650,${Aval(i >> 1, j >> 1) + bump(i, j)}\n`;
  return window._micro.openBlob(new Blob([s]), 'B.csv', 'add');
});
await layerReady('B.csv');
const sj = await p.evaluate(async () => {
  const m = window._micro, A = m.layers().find((L) => L.name === 'A.csv'), B = m.layers().find((L) => L.name === 'B.csv');
  const compat = m.gridsCompatible(m.gridAxesOf(A), m.gridAxesOf(B));
  const { blob, cells } = await m.runSpatialJoin({ leftL: B, rightL: A, target: m.gridAxesOf(A), label: 'sj',
    columns: [{ src: 'left', name: 'FE', out: 'B_FE', num: true, op: 'mean' }, { src: 'right', name: 'FE', out: 'A_FE', num: true, op: 'mean' }],
    derived: [{ out: 'ΔFE', num: true, compute: (g) => { const a = g('A_FE'), b = g('B_FE'); return a != null && b != null ? b - a : null; } }] });
  const head = (await blob.text()).trim().split('\n')[0].split(',');
  const rows = (await blob.text()).trim().split('\n').slice(1).map((l) => l.split(','));
  const iD = head.indexOf('ΔFE');
  let dmax = 0; for (const r of rows) dmax = Math.max(dmax, Math.abs(+r[iD]));   // reconciliation Δ via a real derived column
  await m.openBlob(blob, 'join.csv', 'add');
  const J = m.layers().find((L) => L.name === 'join.csv');
  return { compat: compat.ok && compat.nested, cells, dmax, hasD: iD >= 0, isBM: !!(J && J.docs.blockDoc), blocks: J ? m.renderer.layerElementCount(J.id) : 0 };
});
chk(`spatial join: compatible (${sj.compat}), aggregate B→A grid = ${sj.cells} cells, derived ΔFE≈0 (${sj.hasD}, ${sj.dmax.toExponential(1)}), new block model (${sj.isBM}, ${sj.blocks})`,
  sj.compat && sj.cells === 4 && sj.hasD && sj.dmax < 1e-3 && sj.isBM && sj.blocks === 4);

// grade-tonnage + swath analysis on A (FE = 100,200,300,400)
const an = await p.evaluate(async () => {
  const m = window._micro, A = m.layers().find((L) => L.name === 'A.csv');
  const gt = await m.computeGT(A, ['FE'], '', 10);            // cutoff at gmin → mean of all = 250
  const swX = await m.computeSwath(A, ['FE'], [1, 0, 0], 10, 0, '');   // along X: col x=5 → mean 200, x=15 → mean 300
  return { gtMean: gt.gt[0][0].grade, swX: swX.profile.map((p) => p.mean[0]) };
});
chk(`analysis: GT mean-above-min = 250 (${an.gtMean}), swath along X rises [${an.swX.map((v) => Math.round(v)).join(',')}]`,
  Math.abs(an.gtMean - 250) < 1e-9 && an.swX.length === 2 && Math.abs(an.swX[0] - 200) < 1e-9 && Math.abs(an.swX[1] - 300) < 1e-9);

// linked brushing: a selection restricts the compute (high-FE half → min 300, tonnage halved)
const lk = await p.evaluate(async () => {
  const m = window._micro, A = m.layers().find((L) => L.name === 'A.csv');
  const all = await m.computeGT(A, ['FE'], '', 10);
  const sel = new Uint8Array(4); sel[2] = 1; sel[3] = 1;   // FE 300, 400 (recs 2,3)
  const s = await m.computeGT(A, ['FE'], '', 10, null, sel);
  return { allMin: all.gmin, allT: all.gt[0][0].tonnage, selMin: s.gmin, selT: s.gt[0][0].tonnage };
});
chk(`linked brushing: selection restricts GT (min ${lk.allMin}→${lk.selMin}, tonnage ${lk.selT}==${lk.allT}/2)`, lk.allMin === 100 && lk.selMin === 300 && lk.selT === lk.allT / 2);

// validation math: sample swath (gsjs declustering consumed) — clustered samples down-weighted, rising profile
const vm = await p.evaluate(() => {
  const m = window._micro;
  const means = m.computeSampleSwath([[10, 0, 0, 1], [20, 0, 0, 2], [30, 0, 0, 3]], null, [1, 0, 0], 10, 5).map((p) => p.mean);
  const w = m.declusterWeights([[0, 0, 0, 5], [1, 0, 0, 5], [100, 0, 0, 5]], 10).weights;
  return { means, clustered: w[0] < w[2] && w[1] < w[2] };
});
chk(`validation: sample-swath rises [${vm.means.map((v) => Math.round(v)).join(',')}] + declustering down-weights the cluster (${vm.clustered})`,
  vm.means.length === 3 && Math.abs(vm.means[0] - 1) < 1e-9 && Math.abs(vm.means[2] - 3) < 1e-9 && vm.clustered);

// ── 8. project round trip (OPFS) + auto-optimize on save: the CSV model is
//    reordered to spatial Parquet in place at save time, and reopens as Parquet ──
await p.evaluate(() => { window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('microsmoke', { create: true }); });
// keep only the CSV model for a clean round trip
await p.evaluate(() => { const m = window._micro; for (const L of [...m.layers()]) if (L.name !== 'model.csv') m.renderer.removeLayer(L.id); m.layers().length = 0; });
await p.evaluate((csv) => window._micro.openBlob(new Blob([csv]), 'model.csv', 'replace'), blockCsv());
await layerReady('model.csv');
await p.evaluate(() => window._micro.setAutoOptimize('on'));    // "Parquet is the project store": optimize on save, no confirm
p.evaluate(() => window._micro.saveProjectAs());
await p.waitForFunction(() => document.querySelector('#svDlg').classList.contains('show') || /project saved/.test(document.querySelector('#meta').textContent), null, { timeout: 30000 });
await p.evaluate(() => { if (document.querySelector('#svDlg').classList.contains('show')) document.querySelector('#svCopy').click(); });
await p.waitForFunction(() => /project saved/.test(document.querySelector('#meta').textContent), null, { timeout: 60000 });
const p2 = await ctx.newPage();
p2.on('pageerror', (e) => { console.log('P2 PAGEERROR:', e.message); process.exitCode = 1; });
await p2.goto(`http://127.0.0.1:${PORT}/tools/micro/index.html`, { waitUntil: 'load' });
await p2.waitForFunction(() => window._micro, null, { timeout: 20000 });
await p2.waitForFunction(() => document.querySelector('#emptyProjects .er-chip'), null, { timeout: 5000 });
await p2.evaluate(() => document.querySelector('#emptyProjects .er-chip').click());
await p2.waitForFunction(() => /project “microsmoke”/.test(document.querySelector('#meta').textContent), null, { timeout: 120000 });
const back = await p2.evaluate(() => { const L = window._micro.layers().find((x) => x.docs.blockDoc); const h = L && L.docs.blockDoc.header; return { n: L ? window._micro.renderer.layerElementCount(L.id) : 0, grid: h && h.grid && [h.grid.x.count, h.grid.y.count, h.grid.z.count].join(), parquet: !!(L && L.docs.blockDoc.parquet), name: L && L.name, linOp: L && L.lineage && L.lineage.op, linSrc: L && L.lineage && L.lineage.sources[0] && L.lineage.sources[0].op }; });
chk(`project round trip: ${back.n} blocks back, grid ${back.grid}, auto-optimized to Parquet (${back.parquet}, “${back.name}”)`, back.n === NBLOCKS && back.grid === '30,20,2' && back.parquet && /\.parquet$/.test(back.name || ''));
chk(`lineage survives round trip: optimize wrapping the opened file (${back.linOp}←${back.linSrc})`, back.linOp === 'optimize' && back.linSrc === 'open');

// ── 8b. RE-SAVE after auto-optimize (the data-loss bug): a CSV already IN a project
//    → enable optimize → save AGAIN. The layer's stale handle used to make save skip
//    writing the parquet, so reload found no rows. Assert: parquet on disk, CSV gone,
//    reload has rows. (Closes the round-trip blind spot per the ROADMAP testing note.) ──
const walkDir = (pg, proj) => pg.evaluate(async (proj) => { const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(proj); const out = []; async function rec(d, pre) { for await (const [n, h] of d.entries()) { if (h.kind === 'directory') await rec(h, pre + n + '/'); else out.push(pre + n); } } await rec(root, ''); return out.sort(); }, proj);
const pr = await ctx.newPage(); pr.on('pageerror', (e) => { console.log('PR PAGEERROR:', e.message); process.exitCode = 1; });
await pr.goto(`http://127.0.0.1:${PORT}/tools/micro/index.html`, { waitUntil: 'load' });
await pr.waitForFunction(() => window._micro, null, { timeout: 20000 });
await pr.evaluate(() => { window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('microsmoke_rs', { create: true }); });
await pr.evaluate((csv) => window._micro.openBlob(new Blob([csv]), 'model.csv', 'replace'), blockCsv());
await pr.waitForFunction(() => { const L = window._micro.layers()[0]; return L && window._micro.renderer.layerElementCount(L.id) > 0; }, null, { timeout: 60000 });
await pr.evaluate(() => window._micro.setAutoOptimize('off'));   // first save keeps the CSV in the project
pr.evaluate(() => window._micro.saveProjectAs());
await pr.waitForFunction(() => document.querySelector('#svDlg').classList.contains('show') || /project saved/.test(document.querySelector('#meta').textContent), null, { timeout: 30000 });
await pr.evaluate(() => { if (document.querySelector('#svDlg').classList.contains('show')) document.querySelector('#svCopy').click(); });
await pr.waitForFunction(() => /project saved/.test(document.querySelector('#meta').textContent), null, { timeout: 60000 });
await pr.evaluate(() => window._micro.setAutoOptimize('on'));    // now optimize + SAVE AGAIN (the bug trigger)
await pr.evaluate(() => window._micro.saveProject());
await pr.waitForFunction(() => /project saved/.test(document.querySelector('#meta').textContent), null, { timeout: 60000 });
await pr.waitForTimeout(500);
const rsDisk = await walkDir(pr, 'microsmoke_rs');
chk(`re-save optimize: parquet on disk, orphan CSV removed (${JSON.stringify(rsDisk.filter((f) => /model\.(csv|parquet)$/.test(f)))})`, rsDisk.some((f) => f.endsWith('model.parquet')) && !rsDisk.some((f) => f.endsWith('model.csv')));
const pr2 = await ctx.newPage(); pr2.on('pageerror', (e) => { console.log('PR2 PAGEERROR:', e.message); process.exitCode = 1; });
await pr2.goto(`http://127.0.0.1:${PORT}/tools/micro/index.html`, { waitUntil: 'load' });
await pr2.waitForFunction(() => window._micro, null, { timeout: 20000 });
const rs = await pr2.evaluate(async () => { const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('microsmoke_rs'); await window._micro.openProjectDir(dir); for (let i = 0; i < 200; i++) { const L = window._micro.layers()[0]; if (L && window._micro.renderer.layerElementCount(L.id) > 0) break; await new Promise((r) => setTimeout(r, 100)); } const L = window._micro.layers()[0]; const h = L && L.docs.blockDoc && L.docs.blockDoc.header; return { n: L ? window._micro.renderer.layerElementCount(L.id) : 0, count: h && h.count, name: L && L.name }; });
chk(`re-save reload HAS ROWS (${rs.n} blocks, ${rs.count} rows, “${rs.name}”)`, rs.n === NBLOCKS && rs.count === NBLOCKS && /\.parquet$/.test(rs.name || ''));

console.log(ok && process.exitCode !== 1 ? '\nMICRO SMOKE: PASS' : '\nMICRO SMOKE: FAIL');
await b.close(); server.close();
process.exit(ok && process.exitCode !== 1 ? 0 : 1);
