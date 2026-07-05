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
const p = await ctx.newPage();
p.on('pageerror', (e) => { console.log('PAGEERROR:', e.message); process.exitCode = 1; });
await p.goto(`http://127.0.0.1:${PORT}/tools/micro/index.html`, { waitUntil: 'load' });
await p.waitForFunction(() => window._micro, null, { timeout: 20000 });
let ok = true;
const chk = (name, cond) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); ok = ok && cond; };
const layerReady = (name) => p.waitForFunction((n) => { const L = window._micro.layers().find((x) => x.name === n); return L && window._micro.renderer.layerElementCount(L.id) > 0; }, name, { timeout: 60000 });

// ── 1. CSV block model → regular grid inferred ──
await p.evaluate((csv) => window._micro.openBlob(new Blob([csv]), 'model.csv', 'replace'), blockCsv());
await layerReady('model.csv');
const csvInfo = await p.evaluate(() => { const h = window._micro.layers()[0].docs.blockDoc.header; return { n: window._micro.renderer.layerElementCount(window._micro.layers()[0].id), grid: h.grid && [h.grid.x.count, h.grid.y.count, h.grid.z.count].join(), cats: (h.categories || []).length }; });
chk(`CSV block model: ${csvInfo.n} blocks, grid ${csvInfo.grid}, ${csvInfo.cats} categories`, csvInfo.n === NBLOCKS && csvInfo.grid === '30,20,2' && csvInfo.cats === 3);

// ── 2. pick reads a record ──
await p.evaluate(() => { document.querySelector('#compass').dispatchEvent(new MouseEvent('click')); document.querySelector('#btnFit').click(); const px = document.querySelector('#ptPx'); px.value = 6; px.dispatchEvent(new Event('input')); });
await p.waitForFunction(() => /converged/.test(document.querySelector('#stats').textContent), null, { timeout: 60000 });
await p.evaluate(() => window._micro.showRecord((window._micro.layers()[0].id << 29) | 100));
await p.waitForFunction(() => document.querySelector('#recPanel').classList.contains('show'), null, { timeout: 10000 });
const rec = await p.evaluate(() => Object.fromEntries([...document.querySelectorAll('#recPanel .rp-row')].map((r) => [r.querySelector('.k').textContent, r.querySelector('.v').textContent])));
chk(`pick record 100: XC ${rec.XC}, LITO ${rec.LITO}`, +rec.XC === 612100 && rec.LITO === 'ITABIRITE');

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

// ── 8. project round trip (OPFS): save → reopen → grid + filter survive ──
await p.evaluate(() => { window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('microsmoke', { create: true }); });
// keep only the CSV model for a clean round trip
await p.evaluate(() => { const m = window._micro; for (const L of [...m.layers()]) if (L.name !== 'model.csv') m.renderer.removeLayer(L.id); m.layers().length = 0; });
await p.evaluate((csv) => window._micro.openBlob(new Blob([csv]), 'model.csv', 'replace'), blockCsv());
await layerReady('model.csv');
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
const back = await p2.evaluate(() => { const L = window._micro.layers().find((x) => x.docs.blockDoc); const h = L && L.docs.blockDoc.header; return { n: L ? window._micro.renderer.layerElementCount(L.id) : 0, grid: h && h.grid && [h.grid.x.count, h.grid.y.count, h.grid.z.count].join() }; });
chk(`project round trip: ${back.n} blocks back, grid ${back.grid}`, back.n === NBLOCKS && back.grid === '30,20,2');

console.log(ok && process.exitCode !== 1 ? '\nMICRO SMOKE: PASS' : '\nMICRO SMOKE: FAIL');
await b.close(); server.close();
process.exit(ok && process.exitCode !== 1 ? 0 : 1);
