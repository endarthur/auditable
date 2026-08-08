// micro smoke, part 2 — the DATA-INTEGRITY + persistence arcs promoted from
// gitignored experiments (2026-07-09 suite increment): sidecars + band
// pushdown (.dm and CSV, exact hits), the explicit Store-as-Parquet dialog
// (keep-original), micro:model kv self-description, pinned analysis windows
// across an OPFS project reload, and swath drag→select → selection→column.
// Run with `npm run test:micro2` (or test:micro:all). Slow (~2-3 min) — the
// fast library layer stays in `npm test`.
import { chromium } from 'playwright';
import http from 'http';
import { readFile } from 'fs/promises';
import { extname } from 'path';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };
const server = http.createServer(async (req, res) => {
  try { const p = decodeURIComponent(new URL(req.url, 'http://x').pathname); const data = await readFile('.' + p);
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' }); res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const b = await chromium.launch({ args: ['--use-gl=angle'] });
const ctx = await b.newContext({ viewport: { width: 1100, height: 750 } });
let ok = true; const chk = (n, c) => { console.log(`${c ? 'ok ' : 'FAIL'} ${n}`); ok = ok && c; };
const mkPage = async (proj) => {
  const p = await ctx.newPage(); p.on('pageerror', (e) => { console.log('PAGEERROR', e.message); ok = false; });
  await p.goto(`http://127.0.0.1:${PORT}/tools/micro/index.html`, { waitUntil: 'load' });
  await p.waitForFunction(() => window._micro, null, { timeout: 20000 });
  await p.evaluate((pr) => { window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle(pr, { create: true }); }, proj);
  return p;
};
const saveProject = async (p) => {
  await p.evaluate(() => window._micro.setAutoOptimize('off'));
  p.evaluate(() => window._micro.saveProjectAs());
  await p.waitForFunction(() => document.querySelector('#svDlg').classList.contains('show') || /project saved/.test(document.querySelector('#meta').textContent), null, { timeout: 30000 });
  await p.evaluate(() => { const d = document.querySelector('#svDlg'); if (d.classList.contains('show')) document.querySelector('#svCopy').click(); });
  await p.waitForFunction(() => /project saved/.test(document.querySelector('#meta').textContent), null, { timeout: 120000 });
};
// a minimal 2-band float32 GeoTIFF (band0 elevation, band1 gradient) for the band-pick check
const twoBandTiff = () => {
  const u16 = (v) => [v & 0xff, v >> 8], u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  const wr = (entries, img) => { const tail = []; let tb = 8 + 2 + entries.length * 12 + 4; const vb = (t, vs) => { if (vs instanceof Uint8Array) return vs; const o = []; for (const v of vs) { if (t === 3) o.push(...u16(v)); else if (t === 4) o.push(...u32(v)); else if (t === 12) { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); o.push(...b); } else o.push(v); } return new Uint8Array(o); }; const buf = [0x49, 0x49, ...u16(42), ...u32(8), ...u16(entries.length)]; for (const [tag, ty, ct, vs] of entries) { const b = vb(ty, vs); buf.push(...u16(tag), ...u16(ty), ...u32(ct)); if (b.length <= 4) buf.push(...b, ...new Array(4 - b.length).fill(0)); else { buf.push(...u32(tb)); tail.push(b); tb += b.length; } } buf.push(...u32(0)); for (const t of tail) buf.push(...t); for (const d of img) buf.push(...d); return new Uint8Array(buf); };
  const W = 40, H = 32, N = W * H, bytes = new Uint8Array(N * 2 * 4), dv = new DataView(bytes.buffer);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) { const i = r * W + c, dx = (c - W * 0.45) / (W * 0.3), dy = (r - H * 0.5) / (H * 0.3); dv.setFloat32(i * 8, 200 + 380 * Math.exp(-(dx * dx + dy * dy)), true); dv.setFloat32(i * 8 + 4, 0.5 + 3 * (c / W) + 2 * (1 - r / H), true); }
  const base = [[256, 3, 1, [W]], [257, 3, 1, [H]], [258, 3, 1, [32]], [259, 3, 1, [1]], [262, 3, 1, [1]], [277, 3, 1, [2]], [278, 3, 1, [H]], [339, 3, 1, [3]], [279, 4, 1, [bytes.length]], [33550, 12, 3, [25, 25, 0]], [33922, 12, 6, [0, 0, 0, 500000, 6000000, 0]]].sort((a, b) => a[0] - b[0]);
  const probe = wr([...base, [273, 4, 1, [0]]].sort((a, b) => a[0] - b[0]), []);
  return wr([...base, [273, 4, 1, [probe.length]]].sort((a, b) => a[0] - b[0]), [bytes]);
};

// ═══ 1. the .dm sidecar arc: sub-blocked discovery cached, stats + band index
//     restored, dm band pushdown EXACT ═══
let p = await mkPage('sm2dm');
await p.evaluate(async () => {
  const { makeDM } = await import('/test/dm-make.mjs');
  const fields = [
    { name: 'XC', type: 'N' }, { name: 'YC', type: 'N' }, { name: 'ZC', type: 'N' },
    { name: 'XINC', type: 'N' }, { name: 'YINC', type: 'N' }, { name: 'ZINC', type: 'N' },
    { name: 'XMORIG', type: 'N', constant: 1000 }, { name: 'YMORIG', type: 'N', constant: 2000 }, { name: 'ZMORIG', type: 'N', constant: 400 },
    { name: 'NX', type: 'N', constant: 40 }, { name: 'NY', type: 'N', constant: 30 }, { name: 'NZ', type: 'N', constant: 120 },
    { name: 'FE', type: 'N' }, { name: 'LITO', type: 'A', width: 8 },
  ];
  const rows = [];
  for (let k = 0; k < 120; k++) for (let j = 0; j < 30; j++) for (let i = 0; i < 40; i++) {
    const half = (i + j) % 4 === 0;
    rows.push({ XC: 1000 + i * 10 + (half ? 2.5 : 5), YC: 2000 + j * 10 + (half ? 2.5 : 5), ZC: 400 + k * 5 + (half ? 1.25 : 2.5),
      XINC: half ? 5 : 10, YINC: half ? 5 : 10, ZINC: half ? 2.5 : 5,
      FE: k < 60 ? 20 + (i % 10) : 80 + (i % 10), LITO: (i + j) % 2 ? 'BIF' : 'CANGA' });
  }
  await window._micro.openBlob(new Blob([makeDM(fields, rows, { precision: 'ep' })]), 'sub.dm', 'replace');
});
await p.waitForFunction(() => window._micro.layers().length && window._micro.renderer.layerElementCount(window._micro.layers()[0].id) > 100000, null, { timeout: 90000 });
await saveProject(p);
const side = await p.evaluate(async () => {
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('sm2dm');
  const mh = await (await dir.getDirectoryHandle('models')).getFileHandle('sub.dm.meta.json');
  const j = JSON.parse(await (await mh.getFile()).text());
  return { v: j.v, sub: j.header && j.header.subBlocked, stats: !!(j.colStats && j.colStats.FE && j.colStats.FE.centroids), bands: !!(j.bands && j.bands.cols && j.bands.cols.FE) };
});
chk(`.dm sidecar written (v${side.v}, subBlocked ${side.sub}, colStats ${side.stats}, bands ${side.bands})`, side.v === 2 && side.sub && side.stats && side.bands);
await p.close();
p = await mkPage('sm2dm');
await p.evaluate(async () => { const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('sm2dm'); await window._micro.openProjectDir(dir); });
await p.waitForFunction(() => window._micro.layers().length && window._micro.renderer.layerElementCount(window._micro.layers()[0].id) > 100000, null, { timeout: 90000 });
const re = await p.evaluate(() => { const L = window._micro.layers()[0], h = L.docs.blockDoc.header; return { sub: h.subBlocked, stats: !!(L._colStats && L._colStats.FE), bands: !!(L._bands && L._bands.cols.FE) }; });
chk(`.dm reopen: discovery cached (subBlocked ${re.sub}) + stats pre-seeded (${re.stats}) + bands loaded (${re.bands})`, re.sub && re.stats && re.bands);
await p.evaluate(() => { const i = document.querySelector('#filter'); i.value = 'FE > 70'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); });
await p.waitForFunction(() => { const L = window._micro.layers()[0]; return L._filterMask; }, null, { timeout: 90000 });
const fl = await p.evaluate(() => { const L = window._micro.layers()[0]; let hits = 0; for (let i = 0; i < L._filterMask.length; i++) hits += L._filterMask[i]; return { hits, skipped: window.__dmBandsSkipped, compact: /compacted/.test(document.querySelector('#meta').textContent) }; });
chk(`.dm band pushdown: ${fl.skipped} page-runs skipped, ${fl.hits} hits == 72000 (exact)`, fl.skipped > 0 && fl.hits === 72000);
// filtering a SUB-BLOCKED model must NOT compact (the compact set has no dim
// palette → matches would collapse to the fine-grid cell minDim/2; the mask
// path keeps each block's true size). Regression guard for the reported bug.
chk(`sub-blocked filter uses the mask path, not compaction (${!fl.compact})`, !fl.compact);
await p.close();

// ═══ 2. CSV bands + the explicit Store-as-Parquet dialog + micro:model kv ═══
const CSV = (() => { let s = 'XC,YC,ZC,FE\n'; for (let k = 0; k < 100; k++) for (let j = 0; j < 40; j++) for (let i = 0; i < 40; i++) s += `${100 + i * 10},${200 + j * 10},${400 + k * 5},${k < 50 ? 20 + (i % 10) : 80 + (i % 10)}\n`; return s; })();
p = await mkPage('sm2csv');
await p.evaluate((csv) => window._micro.openBlob(new Blob([csv]), 'big.csv', 'replace'), CSV);
await p.waitForFunction(() => window._micro.layers().length && window._micro.renderer.layerElementCount(window._micro.layers()[0].id) > 100000, null, { timeout: 120000 });
await saveProject(p);
await p.close();
p = await mkPage('sm2csv');
await p.evaluate(async () => { const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('sm2csv'); await window._micro.openProjectDir(dir); });
await p.waitForFunction(() => window._micro.layers().length && window._micro.renderer.layerElementCount(window._micro.layers()[0].id) > 100000, null, { timeout: 120000 });
await p.evaluate(() => { const i = document.querySelector('#filter'); i.value = 'FE > 70'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); });
await p.waitForFunction(() => { const L = window._micro.layers()[0]; return L._filterMask; }, null, { timeout: 120000 });
const csvFl = await p.evaluate(() => { const L = window._micro.layers()[0]; let hits = 0; for (let i = 0; i < L._filterMask.length; i++) hits += L._filterMask[i]; return { hits, skipped: window.__csvBandsSkipped }; });
chk(`CSV band pushdown: ${csvFl.skipped} bands skipped, ${csvFl.hits} hits == 80000 (exact)`, csvFl.skipped > 0 && csvFl.hits === 80000);
// the explicit dialog, keep-original honored
const opP = p.evaluate(async () => { const L = window._micro.layers()[0]; await window._micro.COMMANDS.find((c) => c.id === 'optimize').run({ L }); }).catch(() => { /* resolves after the dialog; the page may close first */ });
await p.waitForFunction(() => document.querySelector('#opDlg').classList.contains('show'), null, { timeout: 10000 });
await p.evaluate(() => { document.querySelector('#opDlg .op-opts input').checked = true; document.querySelector('#opGo').click(); });
await p.waitForFunction(() => { const L = window._micro.layers()[0]; return L.docs.blockDoc && L.docs.blockDoc.parquet; }, null, { timeout: 120000 });
chk('Store as Parquet dialog: converted with keep-original', await p.evaluate(() => window._micro.layers()[0]._optimizedOrphan == null));
// kv self-description: the converted blob reopens with grid, no discovery pass
const kvOk = await p.evaluate(async () => {
  const m = window._micro, blob = m.layers()[0].docs.blockDoc.blob;
  await m.openBlob(blob, 'again.parquet', 'add');
  const L2 = m.layers().find((x) => x.name === 'again.parquet');
  return !!(L2 && L2.docs.blockDoc.header.grid);
});
chk('micro:model kv: converted parquet reopens with its grid (no discovery)', kvOk);
await opP;
await p.close();

// ═══ 3. pinned analysis windows across an OPFS reload ═══
const SMALL = (() => { let s = 'XC,YC,ZC,FE,SG\n'; for (let k = 0; k < 2; k++) for (let j = 0; j < 10; j++) for (let i = 0; i < 10; i++) s += `${5 + i * 10},${5 + j * 10},${5 + k * 10},${(i + 1) * 10},3\n`; return s; })();
p = await mkPage('sm2an');
await p.evaluate((csv) => window._micro.openBlob(new Blob([csv]), 'model.csv', 'replace'), SMALL);
await p.waitForFunction(() => window._micro.layers().length === 1 && window._micro.renderer.layerElementCount(window._micro.layers()[0].id) === 200, null, { timeout: 30000 });
await p.evaluate(() => window._micro.openGradeTonnage(window._micro.layers()[0]));
await p.evaluate(() => {
  const el = [...document.querySelectorAll('.fwin')].find((e9) => e9.querySelector('.fwin-head .t').textContent.startsWith('grade-tonnage'));
  const wIn = [...el.querySelectorAll('.sw-ser input')].find((i) => /density expr/.test(i.placeholder));
  wIn.value = 'SG'; wIn.dispatchEvent(new Event('change'));
  el.querySelector('.sw-run').click();
});
await p.waitForFunction(() => { const el = [...document.querySelectorAll('.fwin')].find((e9) => e9.querySelector('.fwin-head .t').textContent.startsWith('grade-tonnage')); return el && el._gtSpec; }, null, { timeout: 30000 });
await saveProject(p);
await p.close();
p = await mkPage('sm2an');
await p.evaluate(async () => { const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('sm2an'); await window._micro.openProjectDir(dir); });
await p.waitForFunction(() => [...document.querySelectorAll('.fwin')].some((e9) => e9.querySelector('.fwin-head .t').textContent.startsWith('grade-tonnage')), null, { timeout: 60000 });
const pin = await p.evaluate(() => {
  const el = [...document.querySelectorAll('.fwin')].find((e9) => e9.querySelector('.fwin-head .t').textContent.startsWith('grade-tonnage'));
  const wIn = [...el.querySelectorAll('.sw-ser input')].find((i) => /density expr/.test(i.placeholder));
  return { sub: el.querySelector('.fwin-head .sub').textContent, weight: wIn && wIn.value, manual: !el._gtSpec };
});
chk(`pinned GT reopens configured (“${pin.sub}”, weight “${pin.weight}”, Run manual ${pin.manual})`, /restored/.test(pin.sub) && pin.weight === 'SG' && pin.manual);

// ═══ 4. swath drag→select → selection→column (0/1) ═══
await p.evaluate(() => { const el = [...document.querySelectorAll('.fwin')].find((e9) => e9.querySelector('.fwin-head .t').textContent.startsWith('grade-tonnage')); el.querySelector('.fwin-head button:last-child').click(); });
await p.evaluate(() => window._micro.openSwath(window._micro.layers()[0]));
await p.evaluate(() => { const el = [...document.querySelectorAll('.fwin')].find((e9) => e9.querySelector('.fwin-head .t').textContent.startsWith('swath')); el.querySelector('.sw-run').click(); });
await p.waitForFunction(() => { const el = [...document.querySelectorAll('.fwin')].find((e9) => e9.querySelector('.fwin-head .t').textContent.startsWith('swath')); return el && el._swathSpec; }, null, { timeout: 30000 });
const drag = await p.evaluate(async () => {
  const el = [...document.querySelectorAll('.fwin')].find((e9) => e9.querySelector('.fwin-head .t').textContent.startsWith('swath'));
  const cv2 = el.querySelector('.sw-main canvas'), r = cv2.getBoundingClientRect();
  const at = (fx) => ({ clientX: r.left + r.width * fx, clientY: r.top + r.height * 0.5, bubbles: true });
  cv2.dispatchEvent(new MouseEvent('mousedown', { ...at(0.3), button: 0 }));
  cv2.dispatchEvent(new MouseEvent('mousemove', at(0.7)));
  window.dispatchEvent(new MouseEvent('mouseup', at(0.7)));
  await new Promise((r2) => setTimeout(r2, 150));
  const sel = [...document.querySelectorAll('.menu .item')].find((x) => /Select rows in/.test(x.textContent));
  if (sel) sel._item.action();
  document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  await new Promise((r2) => setTimeout(r2, 400));
  return window._micro.layers()[0]._selCount || 0;
});
chk(`swath drag→select lands a real selection (${drag} rows)`, drag > 0 && drag < 200);
const mat = p.evaluate(() => window._micro.selectionToColumn(window._micro.layers()[0]));
await p.waitForFunction(() => document.querySelector('#pmDlg').classList.contains('show'), null, { timeout: 5000 });
await p.evaluate(() => { document.querySelector('#pmInput').value = 'BANDSEL'; document.querySelector('#pmOk').click(); });
await mat;
const col01 = await p.evaluate(() => {
  const L = window._micro.layers()[0], col = (L.paintCols || []).find((c) => c.name === 'BANDSEL');
  if (!col) return null;
  let n1 = 0, n0 = 0; for (const c of col.codes) { if (col.dict[c] === '1') n1++; else if (col.dict[c] === '0') n0++; }
  return { n1, n0, sel: L._selCount, total: col.codes.length };
});
chk(`selection→column 0/1: ${col01 && col01.n1} ones == sel, all ${col01 && col01.total} rows explicit`, col01 && col01.n1 === col01.sel && col01.n0 === col01.total - col01.sel);

// ═══ 5. drillholes in a ROOT-FILES project (the micro-demo shape): the trio
// already at the folder root → save (no copy prompt — they're in-folder) →
// the .holes.json descriptor lands in drillholes/ but references root files →
// reopen must RESOLVE them (descriptor-relative, then root, then drillholes/) ═══
const DH = {
  collar: 'BHID,X,Y,Z\nDH001,100,100,50\nDH002,150,100,50\n',
  survey: 'BHID,AT,AZ,DIP\nDH001,0,0,-90\nDH002,0,0,-90\n',
  assay: 'BHID,FROM,TO,FE\nDH001,0,10,55\nDH001,10,20,60\nDH002,0,10,45\n',
};
p = await mkPage('sm2dh2');
await p.evaluate(async (D) => {
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('sm2dh2', { create: true });
  for (const [n, d] of [['collars.csv', D.collar], ['survey.csv', D.survey], ['assay.csv', D.assay]]) { const fh = await dir.getFileHandle(n, { create: true }); const w = await fh.createWritable(); await w.write(d); await w.close(); }
}, DH);
await p.evaluate((D) => window._micro.importDrillholes({ collar: new File([D.collar], 'collars.csv'), survey: new File([D.survey], 'survey.csv'), intervals: new File([D.assay], 'assay.csv') }, {}, 'replace'), DH);
await p.waitForFunction(() => window._micro.layers().some((L) => L.dh), null, { timeout: 30000 });
// a DATA-PRESERVING reopen (re-desurvey) must keep the layer's derived styling AND identity —
// reopenDh/reopenDhChan/reopenWithMapping now share captureLayerStyling + captureReopenIdentity.
const dhReopen = await p.evaluate(async () => {
  const L = window._micro.layers().find((x) => x.dh);
  L.calcCols = [{ name: 'fe2', expr: 'FE * 2', ty: 'number' }]; L.colTypes = { FE: 'number' };
  L.visible = false; window._micro.renderer.setLayerVisible(L.id, false);       // hidden → must stay hidden
  await window._micro.reopenDh(L, {});                                          // re-desurvey, same config
  const L2 = window._micro.layers().find((x) => x.dh);
  return { calc: (L2.calcCols || []).map((c) => c.name), colFE: L2.colTypes && L2.colTypes.FE, visible: L2.visible };
});
chk(`re-desurvey keeps styling (calc ${JSON.stringify(dhReopen.calc)} + colTypes ${dhReopen.colFE}) and stays hidden (${dhReopen.visible})`,
  dhReopen.calc.includes('fe2') && dhReopen.colFE === 'number' && dhReopen.visible === false);
await p.evaluate(() => { const L = window._micro.layers().find((x) => x.dh); L.visible = true; window._micro.renderer.setLayerVisible(L.id, true); });
await saveProject(p);
await p.close();
p = await mkPage('sm2dh2');
await p.evaluate(async () => { const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('sm2dh2'); await window._micro.openProjectDir(dir); });
await p.waitForFunction(() => window._micro.layers().some((L) => L.dh) || /0 layers/.test(document.querySelector('#meta').textContent), null, { timeout: 60000 });
const dhBack = await p.evaluate(() => ({ n: window._micro.layers().filter((L) => L.dh).length, meta: document.querySelector('#meta').textContent }));
chk(`root-files dh project reopens with its drillholes (${dhBack.n} dh layer, “${dhBack.meta.slice(0, 40)}”)`, dhBack.n === 1);
await p.close();

// ═══ 7. bookmarks (viewpoint) + scenes (full working state) round-trip as files
//     in bookmarks/ + scenes/ across a project reopen ═══
{
  const pb = await mkPage('sm2bmk');
  const answer = async (nm) => {
    await pb.waitForFunction(() => document.querySelector('#pmDlg') && document.querySelector('#pmDlg').classList.contains('show'), null, { timeout: 8000 });
    await pb.evaluate((n) => { document.querySelector('#pmInput').value = n; document.querySelector('#pmOk').click(); }, nm);
  };
  const CSV = (g) => { let s = 'XC,YC,ZC,AU\n'; for (let k = 0; k < 5; k++) for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) s += `${i * 10},${j * 10},${k * 5},${g + (i % 3)}\n`; return s; };
  await pb.evaluate((csv) => window._micro.openBlob(new Blob([csv]), 'A.csv', 'replace'), CSV(1));
  await pb.waitForFunction(() => window._micro.layers().length === 1, null, { timeout: 30000 });
  await pb.evaluate((csv) => window._micro.openBlob(new Blob([csv]), 'B.csv', 'add'), CSV(5));
  await pb.waitForFunction(() => window._micro.layers().length === 2, null, { timeout: 30000 });

  // bookmark: move camera, save, move away, apply → restored
  await pb.evaluate(() => { window._micro.cam.state.theta = 0.3; });
  const bmSave = pb.evaluate(() => window._micro.saveViewAs()); await answer('Front'); await bmSave;
  await pb.evaluate(() => { window._micro.cam.state.theta = 2.0; window._micro.cam.update(); });
  await pb.evaluate(() => window._micro.applyView(window._micro.views()[0]));
  chk('bookmark restores camera', Math.abs(await pb.evaluate(() => window._micro.cam.state.theta) - 0.3) < 1e-6);

  // scene: hide B + filter A, save; disturb; apply → both restored
  await pb.evaluate(() => { const L = window._micro.layers().find((x) => x.name === 'B.csv'); L.visible = false; window._micro.renderer.setLayerVisible(L.id, false); });
  await pb.evaluate(() => { const A = window._micro.layers().find((x) => x.name === 'A.csv'); window._micro.setActiveLayer(A.id); document.querySelector('#filter').value = 'AU > 1.5'; });
  await pb.evaluate(() => window._micro.applyBlockFilter('AU > 1.5'));
  await pb.waitForFunction(() => window._micro.layers().find((x) => x.name === 'A.csv').filterExpr === 'AU > 1.5', null, { timeout: 10000 });
  const scSave = pb.evaluate(() => window._micro.saveSceneAs(false)); await answer('Review'); await scSave;
  await pb.evaluate(() => { const L = window._micro.layers().find((x) => x.name === 'B.csv'); L.visible = true; window._micro.renderer.setLayerVisible(L.id, true); const A = window._micro.layers().find((x) => x.name === 'A.csv'); window._micro.setActiveLayer(A.id); document.querySelector('#filter').value = ''; });
  await pb.evaluate(() => window._micro.applyBlockFilter(''));
  await pb.evaluate(() => window._micro.applyScene(window._micro.scenes()[0]));
  await pb.waitForTimeout(400);
  const sc = await pb.evaluate(() => { const A = window._micro.layers().find((x) => x.name === 'A.csv'), B = window._micro.layers().find((x) => x.name === 'B.csv'); return { bHidden: B.visible === false, aFilter: A.filterExpr }; });
  chk(`scene restores visibility + filter (B hidden=${sc.bHidden}, A="${sc.aFilter}")`, sc.bHidden && sc.aFilter === 'AU > 1.5');

  // project round-trip: files written to bookmarks/ + scenes/, reopen loads both
  await saveProject(pb);
  const files = await pb.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('sm2bmk');
    const ls = async (sub) => { try { const d = await dir.getDirectoryHandle(sub); const out = []; for await (const [nm] of d.entries()) out.push(nm); return out; } catch { return []; } };
    return { bookmarks: await ls('bookmarks'), scenes: await ls('scenes') };
  });
  chk(`bookmarks/ + scenes/ written to the project folder (${files.bookmarks.join(',')} | ${files.scenes.join(',')})`, files.bookmarks.length === 1 && files.scenes.length === 1);
  await pb.evaluate(async () => { const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('sm2bmk'); await window._micro.openProjectDir(dir); });
  await pb.waitForFunction(() => window._micro.layers().length === 2, null, { timeout: 60000 });
  const reloaded = await pb.evaluate(() => ({ bm: window._micro.views().map((v) => v.name), sc: window._micro.scenes().map((s) => ({ name: s.name, n: s.layers.length })) }));
  chk(`reopened project loads bookmark + scene (${reloaded.bm} | ${JSON.stringify(reloaded.sc)})`,
    reloaded.bm.includes('Front') && reloaded.sc.length === 1 && reloaded.sc[0].name === 'Review' && reloaded.sc[0].n === 2);
  await pb.close();
}

// ═══ 8. the demo project — one click assembles the coming-home scene: a block
//     model + drillholes, half-cut on the ore lens (holes stay WHOLE), grade-
//     coloured, with a computed grade-tonnage curve + a saved bookmark ═══
{
  const pd = await mkPage('sm2demo');
  await pd.click('#sampleDemo');
  await pd.waitForFunction(() => window._micro.layers().length >= 2
    && window._micro.views().length >= 1
    && [...document.querySelectorAll('.fwin')].some((w) => /grade.tonnage/i.test(w.textContent)), null, { timeout: 120000 });
  await pd.waitForTimeout(1000);
  const d = await pd.evaluate(() => {
    const dh = window._micro.layers().find((x) => x.dh);
    const bm = window._micro.layers().find((x) => x.docs && x.docs.blockDoc);
    const gtWin = [...document.querySelectorAll('.fwin')].find((w) => /grade.tonnage/i.test(w.textContent));
    return {
      layers: window._micro.layers().length,
      hasBlocks: !!bm, blockCount: bm ? window._micro.renderer.layerElementCount(bm.id) : 0,
      hasDh: !!dh, dhWhole: dh ? !window._micro.renderer.layerSectioned(dh.id) : false,
      section: document.querySelector('#secMode').value,
      gtCurve: gtWin ? !!gtWin.querySelector('canvas') : false,
      bookmark: window._micro.views().some((v) => /lens/i.test(v.name)),
    };
  });
  chk(`demo project: block model (${d.blockCount.toLocaleString()}) + drillholes, one click`, d.hasBlocks && d.blockCount > 100000 && d.hasDh && d.layers >= 2);
  chk(`demo project: E–W section, drillholes stay WHOLE (not cut)`, d.section === 'ew' && d.dhWhole);
  chk(`demo project: grade-tonnage window computed + a bookmark saved`, d.gtCurve && d.bookmark);
  // the analysis-window config rail scrolls, but Run + save-as-recipe stay pinned:
  // shrink the GT window so the rail overflows, scroll to the top, and the sticky
  // footer must still sit flush at the rail bottom with Run visible
  const sticky = await pd.evaluate(() => {
    const w = [...document.querySelectorAll('.fwin')].find((x) => /grade.tonnage/i.test(x.textContent));
    w.style.height = '300px'; w.style.width = '560px';
    const rail = w.querySelector('.sw-rail'), foot = w.querySelector('.sw-foot'); rail.scrollTop = 0;
    const rb = rail.getBoundingClientRect(), fb = foot.getBoundingClientRect(), run = foot.querySelector('.sw-run');
    return { overflow: rail.scrollHeight > rail.clientHeight + 4, pos: getComputedStyle(foot).position, flush: Math.abs(fb.bottom - rb.bottom) < 3, runVisible: run.getBoundingClientRect().bottom <= rb.bottom + 1 };
  });
  chk(`analysis window: Run/save-as-recipe stay pinned when the config scrolls (sticky footer)`, sticky.overflow && sticky.pos === 'sticky' && sticky.flush && sticky.runVisible);
  await pd.close();
}

// ═══ 9. vertical exaggeration — a GLOBAL scene z-scale (camera-level): geometry
//     intact, rides in the camera capture, and a pick still returns a real record
//     (queries stay in real coords under exaggeration) ═══
{
  const pe = await mkPage('sm2exag');
  const CSV = () => { let s = 'XC,YC,ZC,FE\n'; for (let k = 0; k < 20; k++) for (let j = 0; j < 20; j++) for (let i = 0; i < 20; i++) s += `${i * 10},${j * 10},${k * 5},${40 + (i % 8)}\n`; return s; };
  await pe.evaluate((csv) => window._micro.openBlob(new Blob([csv]), 'e.csv', 'replace'), CSV());
  await pe.waitForFunction(() => window._micro.layers().length && window._micro.renderer.layerElementCount(window._micro.layers()[0].id) > 5000, null, { timeout: 30000 });
  const cnt0 = await pe.evaluate(() => window._micro.renderer.layerElementCount(window._micro.layers()[0].id));
  await pe.evaluate(() => window._micro.setZExag(4));
  await pe.waitForTimeout(500);
  const ex = await pe.evaluate(() => ({
    z: window._micro.cam.state.zExag,
    count: window._micro.renderer.layerElementCount(window._micro.layers()[0].id),
    captured: window._micro.captureScene ? window._micro.captureScene('t', false).camera.zExag : null,
  }));
  chk(`exaggeration: global z-scale applied (4×), geometry intact (${ex.count.toLocaleString()})`, ex.z === 4 && ex.count === cnt0);
  chk('exaggeration rides in the camera capture (bookmarks/scenes)', ex.captured === 4);
  // a pick under exaggeration must still return a real record (ID-buffer picks what you see)
  const cv = await pe.$('#gl,canvas'); const box = await cv.boundingBox(); let hit = null;
  for (const [fx, fy] of [[0.5, 0.5], [0.45, 0.5], [0.55, 0.5], [0.5, 0.45], [0.5, 0.55]]) {
    await pe.mouse.click(box.x + box.width * fx, box.y + box.height * fy); await pe.waitForTimeout(250);
    hit = await pe.evaluate(() => { const rp = document.querySelector('#recPanel'); return rp && rp.classList.contains('show') ? rp.querySelectorAll('.rp-row').length : 0; });
    if (hit) break;
  }
  chk('exaggeration: a pick still returns a real record (queries stay in real coords)', hit > 0);
  // vertical pan must track the cursor 1:1 regardless of exaggeration (the z move
  // is divided by zExag to cancel the display stretch) — a target-depth point
  // shifts by ~the drag amount at 1× AND at 8×, not zExag× it
  const pan = await pe.evaluate(() => {
    const c = window._micro.cam; c.state.phi = Math.PI / 4; c.update(); const H = 760;
    const track = (exag) => {
      window._micro.setZExag(exag); const P = [...c.state.target];
      const projY = (vp) => { const y = vp[1] * P[0] + vp[5] * P[1] + vp[9] * P[2] + vp[13], w = vp[3] * P[0] + vp[7] * P[1] + vp[11] * P[2] + vp[15]; return (1 - y / w) * 0.5 * H; };
      const y0 = projY(c.state.viewProj); c.pan(0, 80, H); const y1 = projY(c.state.viewProj); c.pan(0, -80, H);
      return y1 - y0;
    };
    return { at1: track(1), at8: track(8) };
  });
  chk(`exaggeration: vertical pan tracks 1:1 (1×→${pan.at1.toFixed(0)}px, 8×→${pan.at8.toFixed(0)}px for an 80px drag)`, Math.abs(pan.at1 - 80) < 25 && Math.abs(pan.at8 - 80) < 25);
  await pe.evaluate(() => window._micro.setZExag(1));
  await pe.close();
}

// ═══ 10. heightfield surface — a grid reinterprets from the raw elevation point
//     cloud to a shaded-relief mesh (per-vertex colour + smooth normals), keeping
//     gridDoc for by-surface eval ═══
{
  const ph = await mkPage('sm2surf');
  const asc = await ph.evaluate(() => {
    const nc = 100, nr = 80, cs = 25, x0 = 500000, y0 = 6000000;
    let s = `ncols ${nc}\nnrows ${nr}\nxllcorner ${x0}\nyllcorner ${y0}\ncellsize ${cs}\nNODATA_value -9999\n`;
    const rows = [];
    for (let r = 0; r < nr; r++) { const line = []; for (let c = 0; c < nc; c++) { const dx = (c - nc * 0.45) / (nc * 0.3), dy = (r - nr * 0.5) / (nr * 0.3); let z = 200 + 380 * Math.exp(-(dx * dx + dy * dy)); if (c < 6 && r < 6) z = -9999; line.push(z.toFixed(1)); } rows.push(line.join(' ')); }
    return s + rows.join('\n') + '\n';
  });
  await ph.evaluate((a) => window._micro.openBlob(new Blob([a]), 'terrain.asc', 'replace'), asc);
  await ph.waitForFunction(() => window._micro.layers().length && window._micro.layers()[0].docs.gridDoc, null, { timeout: 30000 });
  const pts = await ph.evaluate(() => ({ kind: window._micro.layers()[0].kind, surface: !!window._micro.layers()[0].gridSurface }));
  chk('grid opens as an elevation point cloud', pts.kind === 'points' && !pts.surface);
  // reopen (reinterpret) preserves layer identity — incl. VISIBILITY: a reinterpret of a HIDDEN layer used to
  // bring it back visible (each reopen site hand-copied identity; reopenAs dropped `visible`). One shared
  // captureReopenIdentity/restoreReopenIdentity now guards it.
  await ph.evaluate(() => { const L = window._micro.layers()[0]; L.visible = false; window._micro.renderer.setLayerVisible(L.id, false); });
  await ph.evaluate(() => window._micro.reopenAs(window._micro.layers()[0], 'surface'));
  await ph.waitForFunction(() => window._micro.layers()[0] && window._micro.layers()[0].gridSurface, null, { timeout: 30000 });
  await ph.waitForTimeout(600);
  chk('reopen preserves a hidden layer as hidden (reinterpret used to lose visibility)', await ph.evaluate(() => window._micro.layers()[0].visible === false));
  await ph.evaluate(() => { const L = window._micro.layers()[0]; L.visible = true; window._micro.renderer.setLayerVisible(L.id, true); });
  const surf = await ph.evaluate(() => { const L = window._micro.layers()[0]; return { kind: L.kind, surface: !!L.gridSurface, hasGrid: !!(L.docs.gridDoc && L.docs.gridDoc.grid), elem: window._micro.renderer.layerElementCount(L.id) }; });
  chk(`grid reinterprets to a shaded-relief surface (mesh, ${surf.elem.toLocaleString()} elements, gridDoc kept for eval)`, surf.kind === 'mesh' && surf.surface && surf.hasGrid && surf.elem > 1000);
  // Phase 2 drape: colour the topo surface by a SECOND grid's values (grade over topo)
  const grade = await ph.evaluate(() => {
    const nc = 100, nr = 80, cs = 25, x0 = 500000, y0 = 6000000;
    let s = `ncols ${nc}\nnrows ${nr}\nxllcorner ${x0}\nyllcorner ${y0}\ncellsize ${cs}\nNODATA_value -9999\n`; const rows = [];
    for (let r = 0; r < nr; r++) { const line = []; for (let c = 0; c < nc; c++) line.push((0.5 + 3 * (c / nc) + 2 * (1 - r / nr)).toFixed(2)); rows.push(line.join(' ')); }
    return s + rows.join('\n') + '\n';
  });
  await ph.evaluate((g) => window._micro.openBlob(new Blob([g]), 'grade.asc', 'add'), grade);
  await ph.waitForFunction(() => window._micro.layers().some((L) => L.name === 'grade.asc'), null, { timeout: 30000 });
  await ph.evaluate(() => { const topo = window._micro.layers().find((L) => L.gridSurface), gr = window._micro.layers().find((L) => L.name === 'grade.asc'); window._micro.recolorSurface(topo, gr); });
  await ph.waitForTimeout(500);
  const drape = await ph.evaluate(() => { const L = window._micro.layers().find((x) => x.gridSurface); return { drape: L.drapeSource, kind: L.kind, elem: window._micro.renderer.layerElementCount(L.id) }; });
  chk(`surface drapes a second grid's values (topo coloured by grade, geometry intact)`, drape.drape === 'grade.asc' && drape.kind === 'mesh' && drape.elem > 1000);
  // the drape control is on the properties panel too (not just the context menu)
  const propDrape = await ph.evaluate(() => {
    window._micro.setActiveLayer(window._micro.layers().find((L) => L.gridSurface).id); window._micro.openProps();
    const rows = [...document.querySelectorAll('#ppBody .pp-row')];
    const row = rows.find((r) => /drape/i.test(r.querySelector('label') ? r.querySelector('label').textContent : ''));
    const sel = row && row.querySelector('select');
    return { hasDrapeRow: !!sel, value: sel && sel.value, opts: sel ? [...sel.options].map((o) => o.textContent) : [] };
  });
  chk(`properties panel has a drape picker (value "${propDrape.value}", options ${JSON.stringify(propDrape.opts)})`, propDrape.hasDrapeRow && propDrape.value === 'grade.asc' && propDrape.opts.includes('elevation'));
  // flatten: a surface can render as a horizontal sheet at a chosen z (a 2D grid, no DEM)
  const flat = await ph.evaluate(() => {
    const L = window._micro.layers().find((x) => x.gridSurface); window._micro.setSurfaceFlatZ(L, 900);
    const o = window._micro.frame ? window._micro.frame.origin : [0, 0, 0];
    const r = { flatZ: L.surfaceFlatZ, zmin: L.bboxLocal[2] + o[2], zmax: L.bboxLocal[5] + o[2], surface: !!L.gridSurface };
    window._micro.setSurfaceFlatZ(L, null); return r;   // back to relief for the following checks
  });
  chk(`surface flattens to a horizontal sheet at a chosen z (collapsed to z≈900)`, flat.surface && flat.flatZ === 900 && Math.abs(flat.zmin - 900) < 1 && Math.abs(flat.zmax - 900) < 1);
  // shading is a style option: smooth (default) ↔ faceted (flat per-triangle)
  const shade = await ph.evaluate(() => {
    const L = window._micro.layers().find((x) => x.gridSurface);
    const def = L.surfaceSmooth; window._micro.setSurfaceSmooth(L, false); const off = L.surfaceSmooth;
    window._micro.setActiveLayer(L.id); window._micro.openProps();
    const row = [...document.querySelectorAll('#ppBody .pp-row')].find((r) => /shading/i.test(r.querySelector('label') ? r.querySelector('label').textContent : ''));
    const val = row && row.querySelector('select') ? row.querySelector('select').value : '';
    window._micro.setSurfaceSmooth(L, true); return { def, off, val, picker: !!(row && row.querySelector('select')) };
  });
  chk(`surface shading toggles smooth↔faceted (default smooth, properties picker)`, shade.def !== false && shade.off === false && shade.picker && shade.val === 'faceted');
  // surface + drape PERSIST across a project save/reload
  await saveProject(ph);
  await ph.evaluate(async () => { const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('sm2surf'); await window._micro.openProjectDir(dir); });
  await ph.waitForFunction(() => window._micro.layers().length === 2, null, { timeout: 60000 });
  await ph.waitForTimeout(600);
  const reloaded = await ph.evaluate(() => { const L = window._micro.layers().find((x) => x.name === 'terrain.asc'); return { surface: !!(L && L.gridSurface), drape: L && L.drapeSource, kind: L && L.kind }; });
  chk(`surface + drape persist across a project reload (${JSON.stringify(reloaded)})`, reloaded.surface && reloaded.drape === 'grade.asc' && reloaded.kind === 'mesh');
  // ── SCENE round-trip: a scene must restore the FULL surface state (surface · drape · relief/flat ·
  //    smooth/faceted · band), not just vis/colour/filter. captureLayerSurface is the SINGLE source both
  //    the manifest AND scenes serialize through — this guards the "we wired the manifest but forgot the
  //    scene" class of bug: dress every field, snapshot, disturb every field, apply → all must come back.
  const sceneCap = await ph.evaluate(() => {
    const L = window._micro.layers().find((x) => x.name === 'terrain.asc');
    window._micro.setSurfaceSmooth(L, false);                         // dress: faceted (drape already grade.asc, relief)
    const s = window._micro.captureScene('surf-scene', false);
    window._micro._stashScene = s;
    const sl = s.layers.find((x) => x.name === 'terrain.asc');
    return { gridSurface: !!sl.gridSurface, drape: sl.drape || null, faceted: !!sl.faceted };
  });
  chk(`scene captures the full surface state (surface+drape+faceted), not just vis/colour`, sceneCap.gridSurface && sceneCap.drape === 'grade.asc' && sceneCap.faceted === true);
  await ph.evaluate(async () => {                                     // disturb EVERY captured field
    const L = window._micro.layers().find((x) => x.name === 'terrain.asc');
    window._micro.setSurfaceFlatZ(L, 500);                            // relief → flat
    window._micro.setSurfaceSmooth(L, true);                          // faceted → smooth
    window._micro.recolorSurface(L, null);                            // drape → none
    await window._micro.applyScene(window._micro._stashScene);        // and put it all back
  });
  await ph.waitForTimeout(500);
  const sceneBack = await ph.evaluate(() => {
    const L = window._micro.layers().find((x) => x.name === 'terrain.asc');
    return { surface: !!(L && L.gridSurface), drape: (L && L.drapeSource) || null, flatZ: L && L.surfaceFlatZ != null ? L.surfaceFlatZ : null, faceted: !!(L && L.surfaceSmooth === false), kind: L && L.kind };
  });
  chk(`applying a scene RESTORES surface+drape+relief+faceted (${JSON.stringify(sceneBack)})`, sceneBack.surface && sceneBack.drape === 'grade.asc' && sceneBack.flatZ === null && sceneBack.faceted === true && sceneBack.kind === 'mesh');
  await ph.close();
}

// ═══ 11. multi-band GeoTIFF: pick the band (grid ≈ columns) — anytime, in the
//     properties panel, re-reading the right sample; persists ═══
{
  const pm = await mkPage('sm2band');
  const tif = twoBandTiff();
  await pm.evaluate((arr) => window._micro.openBlob(new Blob([new Uint8Array(arr)]), 'multiband.tif', 'replace'), Array.from(tif));
  await pm.waitForFunction(() => window._micro.layers().length && window._micro.layers()[0].docs.gridDoc, null, { timeout: 30000 });
  const b0 = await pm.evaluate(() => { const g = window._micro.layers()[0].docs.gridDoc.grid; return { bands: g.bands, band: g.band, v: g.data[Math.floor(g.data.length * 0.4)] }; });
  chk(`multi-band GeoTIFF detected (${b0.bands} bands, showing band ${b0.band + 1})`, b0.bands === 2 && b0.band === 0);
  await pm.evaluate(() => window._micro.setGridBand(window._micro.layers()[0], 1));
  await pm.waitForFunction(() => window._micro.layers()[0] && window._micro.layers()[0].docs.gridDoc.grid.band === 1, null, { timeout: 30000 });
  const b1 = await pm.evaluate(() => {
    const L = window._micro.layers()[0], g = L.docs.gridDoc.grid;
    window._micro.setActiveLayer(L.id); window._micro.openProps();
    const row = [...document.querySelectorAll('#ppBody .pp-row')].find((r) => /band/i.test(r.querySelector('label') ? r.querySelector('label').textContent : ''));
    return { band: g.band, v: g.data[Math.floor(g.data.length * 0.4)], picker: !!(row && row.querySelector('select')), opts: row && row.querySelector('select') ? row.querySelector('select').options.length : 0 };
  });
  chk(`band pick re-reads the right sample (band0 ${b0.v.toFixed(1)} → band1 ${b1.v.toFixed(1)}) + properties picker`, b1.band === 1 && Math.abs(b0.v - b1.v) > 1 && b1.picker && b1.opts === 2);
  await saveProject(pm);
  await pm.evaluate(async () => { const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('sm2band'); await window._micro.openProjectDir(dir); });
  await pm.waitForFunction(() => window._micro.layers().length === 1 && window._micro.layers()[0].docs.gridDoc, null, { timeout: 60000 });
  const bReload = await pm.evaluate(() => window._micro.layers()[0].docs.gridDoc.grid.band);
  chk(`the chosen band persists across a project reload (band ${bReload + 1})`, bReload === 1);
  await pm.close();
}

// ═══ 12. materialized columns on a block model → GT/swath see them, and the resolver
//     composes (calc references a materialized column; out-of-order calc-on-calc).
//     Interpolation (NN/IDW) was removed — estimation lives in gslib.atra — so the
//     substrate guards now ride on materialize-a-calc-column, not an estimate ═══
{
  const pg = await mkPage('sm2compose');
  // a REGULAR 11×11 block model with a base GRADE = X (a field rising along X)
  const tgt = await pg.evaluate(() => { let s = 'X,Y,Z,GRADE\n'; for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) s += `${i * 10},${j * 10},0,${i * 10}\n`; return s; });
  await pg.evaluate((c) => window._micro.openBlob(new Blob([c]), 'model.csv', 'replace'), tgt);
  await pg.waitForFunction(() => window._micro.layers().some((L) => L.name === 'model.csv' && L.docs.blockDoc), null, { timeout: 30000 });
  // materialize a calc column GRADE_M = GRADE → a real MATERIALIZED (non-base) column
  const out = await pg.evaluate(async () => {
    const T = window._micro.layers().find((x) => x.name === 'model.csv');
    window._micro.applyCalcCols(T, [{ name: 'GRADE_M', expr: 'GRADE', ty: 'number' }]);
    await window._micro.materializeCalcCol(T, 'GRADE_M');
    const col = window._micro.matColList(T).find((c) => c.name === 'GRADE_M');
    return { has: !!col, mat: !!(col && col.mat), stillCalc: (T.calcCols || []).some((c) => c.name === 'GRADE_M'), at50: col ? col.fvalues[5 * 11 + 5] : null };
  });
  chk(`materialize-a-calc lands a materialized column on the model (mat ${out.mat}, block(50,50)≈${(out.at50 || 0).toFixed(1)})`,
    out.has && out.mat && !out.stillCalc && Math.abs(out.at50 - 50) < 0.01);
  // GT + swath SEE the materialized column (schemaExt + extendRow); numericColsOf offers it
  const gtsw = await pg.evaluate(async () => {
    const T = window._micro.layers().find((x) => x.name === 'model.csv');
    const offered = window._micro.numericColsOf(T).includes('GRADE_M');
    const gt = await window._micro.computeGT(T, ['GRADE_M'], null, 8, () => {});
    const sw = await window._micro.computeSwath(T, ['GRADE_M'], [1, 0, 0], 12, 0, null, () => {});
    const means = sw ? sw.profile.map((b) => b.mean[0]).filter(Number.isFinite) : [];
    return { offered, gtCuts: gt ? gt.gt[0].length : 0, gtMax: gt ? gt.gmax : 0, swBands: sw ? sw.profile.length : 0, rising: means.length > 2 && means[means.length - 1] > means[0] };
  });
  chk(`GT + swath compute on the materialized column (numericColsOf offers it ${gtsw.offered}; GT ${gtsw.gtCuts} cuts, gmax ${(gtsw.gtMax || 0).toFixed(0)}; swath ${gtsw.swBands} bands, rising ${gtsw.rising})`,
    gtsw.offered && gtsw.gtCuts === 9 && gtsw.gtMax > 50 && gtsw.swBands > 2 && gtsw.rising);
  // THE COMPOSITION GAP (resolver): a calc column referencing the MATERIALIZED column,
  // then materialized — the exact case that failed pre-resolver (calc saw base only)
  const matc = await pg.evaluate(async () => {
    const T = window._micro.layers().find((x) => x.name === 'model.csv');
    window._micro.applyCalcCols(T, [{ name: 'DBL', expr: 'GRADE_M * 2', ty: 'number' }]);
    const wasCalc = (T.calcCols || []).some((c) => c.name === 'DBL');
    await window._micro.materializeCalcCol(T, 'DBL');
    const col = window._micro.matColList(T).find((c) => c.name === 'DBL');
    return { wasCalc, mat: !!(col && col.mat), stillCalc: (T.calcCols || []).some((c) => c.name === 'DBL'), at50: col ? col.fvalues[5 * 11 + 5] : null, from: col && col.lineage && col.lineage.params.from };
  });
  chk(`calc REFERENCES the materialized column + materializes (DBL = GRADE_M*2 → (50,50)≈${(matc.at50 || 0).toFixed(0)})`,
    matc.wasCalc && matc.mat && !matc.stillCalc && Math.abs(matc.at50 - 100) < 0.01 && matc.from === 'calc');
  // calc-on-calc, dependency-ordered regardless of input order (B2 defined referencing A2)
  const chain = await pg.evaluate(async () => {
    const T = window._micro.layers().find((x) => x.name === 'model.csv');
    window._micro.applyCalcCols(T, [{ name: 'B2', expr: 'A2 * 10', ty: 'number' }, { name: 'A2', expr: 'GRADE_M + 1', ty: 'number' }]);
    window._micro.setActiveLayer(T.id);
    document.querySelector('#filter').value = 'B2 > 500'; await window._micro.applyBlockFilter('B2 > 500');
    const hits = T._filterMask ? T._filterMask.reduce((a, b) => a + b, 0) : -1;
    await window._micro.applyBlockFilter('');
    return { hits };
  });
  chk(`calc-on-calc chains through the resolver, out of input order (B2=A2*10, A2=GRADE_M+1; B2>500 → ${chain.hits} blocks, expect 66)`, chain.hits === 66);
  await pg.close();
}

// ═══ 14. materialized-column store — a full-precision Float32 column persists in the
//     per-layer <layer>.cols/ sidecar (OPFS project) and reloads aligned by record ═══
{
  const pc = await mkPage('sm2matcol');
  const bm = await pc.evaluate(() => { let s = 'X,Y,Z,GRADE\n'; for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 2; k++) s += `${i * 10},${j * 10},${k * 10},${(i + j + k).toFixed(1)}\n`; return s; });
  await pc.evaluate((csv) => window._micro.openBlob(new File([csv], 'bm.csv'), 'bm.csv', 'replace'), bm);
  await pc.waitForFunction(() => window._micro.layers().length && window._micro.layers()[0].docs.blockDoc, null, { timeout: 30000 });
  await saveProject(pc);                                            // copies bm into the project → storage='project'
  const setInfo = await pc.evaluate(() => {
    const L = window._micro.layers()[0]; const cnt = L.docs.blockDoc.header.count;
    const vals = new Float32Array(cnt); for (let i = 0; i < cnt; i++) vals[i] = i * 2;   // EST[i] = i·2
    const col = window._micro.matColSet(L, 'EST', vals, { lineage: { op: 'test' } });
    return { n: cnt, min: col.min, max: col.max };
  });
  chk(`matColSet attaches a full-precision column (${setInfo.n} records, min ${setInfo.min} max ${setInfo.max})`, setInfo.min === 0 && setInfo.max === (setInfo.n - 1) * 2);
  // colour by it (paint path) → legend reads the REAL range [0,62]; filter sees FULL precision (EST>40 → 11 blocks)
  const disp = await pc.evaluate(async () => {
    const L = window._micro.layers()[0]; window._micro.setActiveLayer(L.id);
    const inOpts = [...document.querySelectorAll('#colorBy option')].some((o) => o.value === 'paint:EST');
    window._micro.setLayerColorSel(L, 'paint:EST');
    const range = window._micro.rampRangeFor(L);
    document.querySelector('#filter').value = 'EST > 40'; await window._micro.applyBlockFilter('EST > 40');
    const hits = L._filterMask ? L._filterMask.reduce((a, b) => a + b, 0) : -1;
    await window._micro.applyBlockFilter('');
    return { inOpts, colorSel: L.colorSel, range, hits };
  });
  chk(`materialized column is colourable (in colorBy ${disp.inOpts}, sel ${disp.colorSel}) with a REAL-range legend [${disp.range[0]}, ${disp.range[1]}]`, disp.inOpts && disp.colorSel === 'paint:EST' && disp.range[0] === 0 && disp.range[1] === 62);
  chk(`filter sees the materialized column at FULL precision (EST>40 → ${disp.hits} blocks)`, disp.hits === 11);
  await saveProject(pc);                                            // the save hook writes the .cols sidecar
  await pc.evaluate(async () => { const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('sm2matcol'); await window._micro.openProjectDir(dir); });
  await pc.waitForFunction(() => window._micro.layers().length && window._micro.layers()[0].docs.blockDoc, null, { timeout: 60000 });
  await pc.waitForTimeout(400);
  const back = await pc.evaluate(() => {
    const L = window._micro.layers()[0]; const est = window._micro.matColList(L).find((c) => c.name === 'EST');
    return { has: !!est, mat: !!(est && est.mat), n: est ? est.fvalues.length : 0, v0: est ? est.fvalues[0] : null, v5: est ? est.fvalues[5] : null, vlast: est ? est.fvalues[est.fvalues.length - 1] : null };
  });
  chk(`materialized column reloads aligned from the sidecar (EST: ${back.n} records, mat ${back.mat}, [0]=${back.v0} [5]=${back.v5} last=${back.vlast})`, back.has && back.mat && back.v0 === 0 && back.v5 === 10 && back.vlast === (back.n - 1) * 2);
  await pc.close();
}

// ═══ 16. the FILTER WIDGET DRAWER — the expression projected as live controls;
//     widgets rewrite literals SURGICALLY; reset restores the snapshot ═══
{
  const pf = await mkPage('sm2fdrawer');
  const csv = await pf.evaluate(() => {
    let t = 'X,Y,Z,FE,LITO\n'; const LIT = ['HEMATITE', 'ITABIRITE', 'CANGA'];
    for (let i = 0; i < 20; i++) for (let j = 0; j < 20; j++) for (let k = 0; k < 2; k++)
      t += `${i * 10},${j * 10},${k * 5},${(30 + i * 2.5).toFixed(1)},${LIT[(i + j) % 3]}\n`;
    return t;
  });
  await pf.evaluate((c) => window._micro.openBlob(new Blob([c]), 'fd.csv', 'replace'), csv);
  await pf.waitForFunction(() => window._micro.layers().length === 1 && window._micro.layers()[0].docs.blockDoc, null, { timeout: 30000 });
  const EXPR = 'FE > 45 and LITO = "HEMATITE"';
  const hits0 = await pf.evaluate(async (e) => {
    document.querySelector('#filter').value = e; await window._micro.applyBlockFilter(e);
    const L = window._micro.layers()[0]; let h = 0; for (const m of L._filterMask) if (m) h++; return h;
  }, EXPR);
  await pf.click('#filterWidgets');                                 // a REAL click — the button must be hittable
  const ui = await pf.evaluate(() => {
    const d = document.querySelector('#fdrawer');
    return { shown: d.classList.contains('show'), sliders: d.querySelectorAll('input[type="range"]').length,
      chips: d.querySelectorAll('.fd-chip').length, on: [...d.querySelectorAll('.fd-chip.on')].map((c) => c.textContent) };
  });
  chk(`filter drawer renders the expression as widgets (${ui.sliders} slider, ${ui.chips} chips, on=${ui.on})`,
    ui.shown && ui.sliders === 1 && ui.chips >= 3 && ui.on.includes('HEMATITE'));
  const drag = await pf.evaluate(async () => {
    const sl = document.querySelector('#fdrawer input[type="range"]');
    sl.value = 60; sl.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    const L = window._micro.layers()[0]; let h = 0; for (const m of L._filterMask) if (m) h++;
    return { text: document.querySelector('#filter').value, h };
  });
  chk(`slider drag rewrites the literal SURGICALLY + re-filters live ("${drag.text}" → ${drag.h} hits)`,
    /^FE > (59|60|61)[0-9.]* and LITO = "HEMATITE"$/.test(drag.text) && drag.h > 0 && drag.h < hits0);
  const chip = await pf.evaluate(async () => {
    const other = [...document.querySelectorAll('#fdrawer .fd-chip')].find((c) => !c.classList.contains('on'));
    const v = other.textContent; other.click();
    await new Promise((r) => setTimeout(r, 300));
    return { v, text: document.querySelector('#filter').value };
  });
  chk(`chip click swaps the category literal (→ "${chip.v}")`, chip.text.includes('LITO = "' + chip.v + '"'));
  const rst = await pf.evaluate(async () => {
    [...document.querySelectorAll('#fdrawer .fd-head button')].find((b) => b.textContent === 'reset').click();
    await new Promise((r) => setTimeout(r, 400));
    const L = window._micro.layers()[0]; let h = 0; for (const m of L._filterMask) if (m) h++;
    return { text: document.querySelector('#filter').value, h };
  });
  chk(`reset restores the snapshot exactly ("${rst.text}", ${rst.h} hits == ${hits0})`, rst.text === EXPR && rst.h === hits0);
  // the multiline expression editor: typing there applies (debounced) + re-projects the widgets on commit
  const edt = await pf.evaluate(async () => {
    const ed = document.querySelector('#fdExpr');
    ed.focus(); ed.value = 'FE between 40\n  and 60'; ed.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 600));
    ed.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    const L = window._micro.layers()[0]; let h = 0; for (const m of L._filterMask) if (m) h++;
    return { mirrored: document.querySelector('#filter').value.includes('between 40'), sliders: document.querySelectorAll('#fdBody input[type="range"]').length, h, err: document.querySelector('#fdErr').textContent };
  });
  chk(`editor: multiline expr applies + re-projects (mirrored ${edt.mirrored}, ${edt.sliders} range sliders, ${edt.h} hits, err "${edt.err}")`,
    edt.mirrored && edt.sliders === 2 && edt.h > 0 && edt.err === '');
  const edErr = await pf.evaluate(async () => {
    const ed = document.querySelector('#fdExpr');
    ed.focus(); ed.value = 'FE > and'; ed.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    return document.querySelector('#fdExpr').classList.contains('err') && document.querySelector('#fdErr').textContent.length > 0;
  });
  chk(`editor: live validation flags a bad expression`, edErr);
  // op dropdowns / clickable joiners / bracket groups — every projected element
  // rewrites its own source span (ops via the cmp op-token span, and/or via the
  // joiner token span, groups via paren extents + insert-before-')').
  await pf.evaluate(async () => {
    const ed = document.querySelector('#fdExpr');
    ed.focus(); ed.value = 'FE > 45 and LITO = "HEMATITE"'; ed.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    ed.dispatchEvent(new Event('change', { bubbles: true })); ed.blur();
    await new Promise((r) => setTimeout(r, 200));
  });
  const opsw = await pf.evaluate(async () => {
    const s2 = [...document.querySelectorAll('#fdBody .fd-opsel')].find((x) => x.value === '>');
    if (!s2) return { text: 'NO OP SELECT' };
    s2.value = '<='; s2.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 400));
    const L = window._micro.layers()[0]; let h = 0; for (const m of L._filterMask) if (m) h++;
    return { text: document.querySelector('#fdExpr').value, h };
  });
  chk(`op dropdown rewrites the op token ("${opsw.text}", ${opsw.h} hits)`,
    opsw.text === 'FE <= 45 and LITO = "HEMATITE"' && opsw.h > 0);
  const jsw = await pf.evaluate(async () => {
    const pill = document.querySelector('#fdBody .fd-op.click');
    if (!pill) return 'NO CLICKABLE PILL';
    pill.click();
    await new Promise((r) => setTimeout(r, 300));
    return document.querySelector('#fdExpr').value;
  });
  chk(`joiner pill click switches and → or ("${jsw}")`, jsw === 'FE <= 45 or LITO = "HEMATITE"');
  const grp = await pf.evaluate(async () => {
    let add = [...document.querySelectorAll('#fdBody .fd-add')].pop();       // top-level add: seed an and-group
    add.querySelector('.fd-opsel').value = 'and ( … )';
    let col = [...add.querySelectorAll('select')].pop(); col.value = 'n:FE'; col.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 400));
    const boxed = !!document.querySelector('#fdBody .fd-group');
    add = document.querySelector('#fdBody .fd-group .fd-add');               // then add INSIDE the brackets
    if (!add) return { boxed, text: 'NO GROUP ADD' };
    const js = add.querySelector('.fd-opsel'); if (js) js.value = 'or';
    col = [...add.querySelectorAll('select')].pop(); col.value = 'n:FE'; col.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 400));
    return { boxed, text: document.querySelector('#fdExpr').value };
  });
  chk(`bracket seed + add-inside-group ("${grp.text}")`,
    grp.boxed && /or LITO = "HEMATITE" and \(FE > [0-9.]+ or FE > [0-9.]+\)$/.test(grp.text));
  await pf.close();
}


// ═══ 17. the ƒ CALCULATIONS window — authoring moved out of the columns tab;
//     validates vs the FULL schema (calc-on-calc composes); live filter pickup ═══
{
  const pc = await mkPage('sm2calcwin');
  const csv = await pc.evaluate(() => {
    let t = 'X,Y,Z,FE,MN\n';
    for (let i = 0; i < 20; i++) for (let j = 0; j < 20; j++) t += `${i * 10},${j * 10},0,${(30 + i * 2.5).toFixed(1)},${(1 + j * 0.1).toFixed(2)}\n`;
    return t;
  });
  await pc.evaluate((c) => window._micro.openBlob(new Blob([c]), 'cw.csv', 'replace'), csv);
  await pc.waitForFunction(() => window._micro.layers().length === 1 && window._micro.layers()[0].docs.blockDoc, null, { timeout: 30000 });
  const added = await pc.evaluate(async () => {
    window._micro.openCalcWindow(window._micro.layers()[0]);
    document.querySelector('.cw-main input[type=text]').value = 'FE_EQ';
    const ed = document.querySelector('.cw-edwrap textarea'); ed.value = 'FE + 0.4 * MN'; ed.dispatchEvent(new Event('input'));
    [...document.querySelectorAll('.cw-main .awin-btn')].find((x) => x.textContent === 'add column').click();
    await new Promise((r) => setTimeout(r, 400));
    // a second column REFERENCING the first — the old inline form rejected this
    [...document.querySelectorAll('.cw-item')].find((x) => x.textContent === '+ add…').click();
    document.querySelector('.cw-main input[type=text]').value = 'DBL';
    const ed2 = document.querySelector('.cw-edwrap textarea'); ed2.value = 'FE_EQ * 2  # composed'; ed2.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 100));
    const valid = document.querySelector('.cw-err').textContent === '';
    [...document.querySelectorAll('.cw-main .awin-btn')].find((x) => x.textContent === 'add column').click();
    await new Promise((r) => setTimeout(r, 300));
    const L = window._micro.layers()[0];
    return { valid, cols: (L.calcCols || []).map((c) => c.name + ':' + c.ty) };
  });
  chk(`calc window: add + calc-on-calc composes (${added.cols})`,
    added.valid && added.cols.join(',') === 'FE_EQ:number,DBL:number');
  // a calccols RECIPE composes in listed order too (schema recomputed per entry)
  const rcp = await pc.evaluate(() => window._micro.applyCalcCols(window._micro.layers()[0],
    [{ name: 'A1', expr: 'FE * 2' }, { name: 'A2', expr: 'A1 + MN' }]));
  const rcpClean = await pc.evaluate(() => { const L = window._micro.layers()[0]; L.calcCols = L.calcCols.filter((c) => !/^A[12]$/.test(c.name)); L._calcFns = null; return true; });
  chk(`calccols recipe: same-set composition (A2 references A1; ${rcp.applied} applied, bad: [${rcp.bad}])`,
    rcp.applied === 2 && !rcp.bad.length && rcpClean);
  const live = await pc.evaluate(async () => {
    document.querySelector('#filter').value = 'DBL > 100'; await window._micro.applyBlockFilter('DBL > 100');
    const count = () => { const L = window._micro.layers()[0]; let h = 0; for (const m of L._filterMask) if (m) h++; return h; };
    const h0 = count();
    [...document.querySelectorAll('.cw-item')].find((x) => x.textContent.includes('FE_EQ')).click();
    const ed = document.querySelector('.cw-edwrap textarea'); ed.value = 'FE + 10 * MN'; ed.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 100));
    [...document.querySelectorAll('.cw-main .awin-btn')].find((x) => x.textContent === 'save').click();
    await new Promise((r) => setTimeout(r, 500));
    return { h0, h1: count() };
  });
  chk(`calc window: saving a definition re-applies the live filter (${live.h0} → ${live.h1} hits)`,
    live.h0 > 0 && live.h1 > live.h0);
  const tab = await pc.evaluate(() => {
    window._micro.openProps(window._micro.layers()[0].id);
    [...document.querySelectorAll('.pp-tab')].find((t) => t.textContent === 'columns').click();
    const btns = [...document.querySelectorAll('#ppBody .pp-scan')].map((x) => x.textContent);
    return { top: btns.some((t) => t.startsWith('ƒ calculations… (2')), oldAdd: btns.some((t) => t === 'add calculated column…') };
  });
  chk('columns tab: ƒ button at the top, inline form retired', tab.top && !tab.oldAdd);
  // the projection widgets: an if() ladder → a CASE TABLE (condition chips |
  // value slider | else | add case); widget edits rewrite the expression text
  // and AUTO-SAVE an existing column. Arithmetic → tunable constant sliders.
  const proj = await pc.evaluate(async () => {
    const L = window._micro.layers()[0];
    L.calcCols.push({ name: 'DENS', expr: 'if(FE > 60, 3.9, 2.8)', ty: 'number' });
    L._calcFns = null;
    [...document.querySelectorAll('.cw-item')].pop();       // rail is stale — rerender via select
    window._micro.openCalcWindow(L, 2);
    // openCalcWindow reuses the live window: select(2) re-renders
    await new Promise((r) => setTimeout(r, 300));
    const cases = document.querySelectorAll('.cw-proj .cw-case').length;
    const hasElse = !!document.querySelector('.cw-proj .cw-else');
    // edit the first case's value via its number input → text rewrite + auto-save
    const nb = document.querySelectorAll('.cw-proj .cw-val input[type=number]')[0];
    nb.value = '4.1'; nb.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 700));
    return { cases, hasElse, text: document.querySelector('.cw-edwrap textarea').value, saved: L.calcCols[2].expr };
  });
  chk(`calc projection: if-ladder case table (${proj.cases} rows) + value edit auto-saves ("${proj.saved}")`,
    proj.cases === 2 && proj.hasElse && proj.text === 'if(FE > 60, 4.1, 2.8)' && proj.saved === 'if(FE > 60, 4.1, 2.8)');
  // color-by-ƒ: picking the calc channel realizes it (ephemeral display cache →
  // the ratio-paint codes path); the choice AND a ƒ filter survive a project
  // reload (restore order: calcCols land BEFORE filter/color re-apply)
  const cc0 = await pc.evaluate(async () => {
    const cb = document.querySelector('#colorBy');
    const has = [...cb.options].some((o) => o.value === 'calc:DENS');
    cb.value = 'calc:DENS'; cb.dispatchEvent(new Event('change'));
    return has;
  });
  await pc.waitForFunction(() => { const L = window._micro.layers()[0]; return L._calcDisplay && L._calcDisplay.name === 'DENS' && !L._calcDisplayBusy; }, null, { timeout: 15000 });
  const cd0 = await pc.evaluate(() => { const c = window._micro.layers()[0]._calcDisplay.col; return { n: c.codes.length, min: c.min, max: c.max }; });
  chk(`color-by-ƒ: option + realization (${cd0.n} codes, [${cd0.min}, ${cd0.max}])`, cc0 && cd0.n === 400 && Math.abs(cd0.min - 2.8) < 1e-5 && Math.abs(cd0.max - 4.1) < 1e-5);
  await saveProject(pc);
  await pc.close();
  const pc2 = await mkPage('sm2calcwin');
  await pc2.evaluate(async () => { const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('sm2calcwin'); await window._micro.openProjectDir(dir); });
  await pc2.waitForFunction(() => { const L = window._micro.layers()[0]; return L && L._calcDisplay && L._calcDisplay.name === 'DENS' && !L._calcDisplayBusy; }, null, { timeout: 60000 });
  const rt = await pc2.evaluate(() => {
    const L = window._micro.layers()[0]; let h = 0; if (L._filterMask) for (const m of L._filterMask) if (m) h++;
    return { sel: L.colorSel, hits: h, filter: document.querySelector('#filter').value, cols: (L.calcCols || []).length };
  });
  chk(`ƒ round-trip: calc color + ƒ filter survive reload (${rt.sel}, "${rt.filter}", ${rt.hits} hits, ${rt.cols} ƒ)`,
    rt.sel === 'calc:DENS' && /DBL > 100/.test(rt.filter) && rt.hits > 0 && rt.cols === 3);
  // the ELEMENT MANIFEST (substrate Appendix A): <layer>.element.json is the
  // data-model artifact — v1, hoisted ops[], ƒ columns as derived defs
  const em = await pc2.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('sm2calcwin');
    const models = await dir.getDirectoryHandle('models');
    const man = JSON.parse(await (await (await models.getFileHandle('cw.csv.element.json')).getFile()).text());
    return { v: man.v, ops: man.ops.filter((o) => o.op === 'calc').length, derived: man.columns.filter((c) => c.from === 'derived').length, loc: Object.keys(man.locations)[0] };
  });
  chk(`element.json on disk: v${em.v}, ${em.ops} calc ops → ${em.derived} derived columns at "${em.loc}"`,
    em.v === 1 && em.ops === 3 && em.derived === 3 && em.loc === 'cells');
  await pc2.close();
}

// ═══ 18. DRILLHOLES as the first MULTI-LOCATION element (substrate spec A.3):
//     one <set>.element.json — collars + vertices(producedBy) + one interval
//     location per break-set (geometryFrom), HOLEID relations, per-location ƒ ═══
{
  const pd = await mkPage('sm2dhelem');
  await pd.evaluate(async () => { try { await (await navigator.storage.getDirectory()).removeEntry('sm2dhelem', { recursive: true }); } catch { } });
  await pd.evaluate(async () => {
    const collar = ['HOLEID,X,Y,Z,EOH'], survey = ['HOLEID,DEPTH,AZ,DIP'], assay = ['HOLEID,FROM,TO,FE'], litho = ['HOLEID,FROM,TO,LITO'];
    for (let n2 = 1; n2 <= 5; n2++) {
      const id = 'DH' + n2;
      collar.push(`${id},${100 + n2 * 40},100,300,${100 + n2 * 10}`); survey.push(`${id},0,0,-90`);
      for (let d = 0; d < 80; d += 10) { assay.push(`${id},${d},${d + 10},${(30 + n2 + d * 0.1).toFixed(1)}`); litho.push(`${id},${d},${d + 10},${d < 40 ? 'OX' : 'FR'}`); }
    }
    const f = (a, nm) => new File([a.join('\n')], nm, { type: 'text/csv' });
    await window._micro.importDrillholes({ collar: f(collar, 'collars.csv'), survey: f(survey, 'survey.csv'), intervals: f(assay, 'assay.csv') }, {}, 'replace');
    const A = window._micro.layers()[0]; A._setKey = 'k'; A._intervalName = 'assay.csv'; A.storage = 'project';
    A.calcCols = [{ name: 'FE2', expr: 'FE * 2', ty: 'number' }];
    await window._micro.importDrillholes({ collar: f(collar, 'collars.csv'), survey: f(survey, 'survey.csv'), intervals: f(litho, 'litho.csv') }, {}, 'add');
    const B2 = window._micro.layers()[1]; B2._setKey = 'k'; B2._intervalName = 'litho.csv'; B2.storage = 'project';
  });
  await pd.waitForFunction(() => window._micro.layers().length === 2 && window._micro.layers().every((L) => L.docs.dhDoc), null, { timeout: 30000 });
  await saveProject(pd);
  const dman = await pd.evaluate(async () => {
    const dh = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('sm2dhelem')).getDirectoryHandle('drillholes');
    const names = []; for await (const k of dh.keys()) names.push(k);
    const el = names.find((n2) => /\.element\.json$/.test(n2));
    const m2 = el ? JSON.parse(await (await (await dh.getFileHandle(el)).getFile()).text()) : null;
    return m2 && {
      locs: Object.keys(m2.locations), holes: m2.locations.collars.count, produced: m2.locations.vertices.producedBy,
      geomFrom: m2.locations.intervals_assay && m2.locations.intervals_assay.geometryFrom,
      rels: m2.relations.every((r) => r.parent === 'collars' && r.key === 'HOLEID'),
      eoh: m2.columns.some((c) => c.loc === 'collars' && c.name === 'EOH' && c.type === 'number'),
      fe2loc: (m2.columns.find((c) => c.name === 'FE2') || {}).loc,
    };
  });
  chk(`dh SET element.json: 4 locations (${dman && dman.locs}), ${dman && dman.holes} holes, vertices producedBy ${dman && dman.produced}, ƒ at ${dman && dman.fe2loc}`,
    !!dman && dman.locs.length === 4 && dman.holes === 5 && dman.produced === 'ds1' && dman.geomFrom === 'ds1' && dman.rels && dman.eoh && dman.fe2loc === 'intervals_assay');
  await pd.close();
  const pd2 = await mkPage('sm2dhelem');
  await pd2.evaluate(async () => { const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('sm2dhelem'); await window._micro.openProjectDir(dir); });
  await pd2.waitForFunction(() => window._micro.layers().length === 2 && window._micro.layers().every((L) => L.docs.dhDoc), null, { timeout: 60000 });
  const dback = await pd2.evaluate(() => {
    const A = window._micro.layers().find((L) => /assay/.test(L.name)), B2 = window._micro.layers().find((L) => /litho/.test(L.name));
    return { set: A && A._setPath, a: A ? (A.calcCols || []).map((c) => c.name).join() : '', b: B2 ? (B2.calcCols || []).length : -1 };
  });
  chk(`dh set restores from the element descriptor (${dback.set}; ƒ "${dback.a}" on assay only, ${dback.b} on litho)`,
    /\.element\.json$/.test(dback.set) && dback.a === 'FE2' && dback.b === 0);
  // BROADCAST — the first cross-location op: a collar column lands on the
  // intervals by the hole-id key (numeric → materialized; the op records
  // inputs [{loc:'collars', column}])
  const bc = await pd2.evaluate(async () => {
    const A = window._micro.layers().find((L) => /assay/.test(L.name));
    window._micro.setActiveLayer(A.id);
    await window._micro.broadcastCollarCol(A, 'EOH');
    await window._micro.applyBlockFilter('EOH > 125');
    let h = 0; for (const m of A._filterMask) if (m) h++;
    const man2 = await window._micro.buildDhSetManifest(window._micro.layers());
    const op2 = man2.ops.find((o) => o.op === 'broadcast');
    return { hits: h, op: !!(op2 && op2.inputs && op2.inputs[0].loc === 'collars' && op2.inputs[0].column === 'EOH') };
  });
  chk(`broadcast: collar EOH → intervals, filterable (${bc.hits} hits) + op with cross-location inputs`,
    bc.hits === 24 && bc.op);   // EOH = 110..150 by 10; > 125 → holes 3–5 × 8 intervals
  // CROSS-LOCATION FILTER PROPAGATION: a collars predicate masks the intervals
  // through the key relation — no materialization — and ANDs with the filter
  const hf = await pd2.evaluate(async () => {
    const A = window._micro.layers().find((L) => /assay/.test(L.name));
    window._micro.setActiveLayer(A.id);
    await window._micro.applyBlockFilter('');
    const r = await window._micro.applyHoleFilter(A, 'EOH > 125');
    let h0 = 0; for (const m of A._filterMask) if (m) h0++;
    await window._micro.applyBlockFilter('FE > 34');
    let h1 = 0; for (const m of A._filterMask) if (m) h1++;
    await window._micro.applyHoleFilter(A, '');
    await window._micro.applyBlockFilter('');
    return { holes: r.holes, h0, h1 };
  });
  chk(`hole filter: EOH > 125 → ${hf.holes} holes → ${hf.h0} intervals; AND FE > 34 → ${hf.h1}`,
    hf.holes === 3 && hf.h0 === 24 && hf.h1 > 0 && hf.h1 < 24);
  // the SET GROUP is the element in the tree: single-interval loads group too,
  // with collar/survey info rows whose menus carry the location verbs
  const tg = await pd2.evaluate(() => {
    const grp = window._micro.layerTree().find((x) => typeof x !== 'number' && x.dhSet);
    const infoRows = [...document.querySelectorAll('#lpRows .lp-row.lp-info .lp-name')].map((x) => x.textContent);
    const nd = grp; if (nd) { window._micro.collarsRowMenu(nd, 200, 200); }
    const menu = [...document.querySelectorAll('.menu .item')].map((x) => x.textContent.trim());
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    return { grp: !!grp, infoRows, hasVerbs: menu.some((x) => /Filter holes/.test(x)) && menu.some((x) => /Broadcast/.test(x)) && menu.some((x) => /Attribute table/.test(x)) };
  });
  chk(`dh tree: set group + collar/survey rows (${tg.infoRows.join(', ')}) + collars-row verbs`,
    tg.grp && tg.infoRows.length >= 2 && tg.hasVerbs);
  await pd2.close();
}

// ═══ 19. JOIN → COLUMNS (the cardinality rule): key joins and own-lattice
//     spatial joins land as columns ON the layer, never a new layer; ops
//     record cross-ELEMENT inputs ═══
{
  const pj = await mkPage('sm2join');
  await pj.evaluate(async () => {
    let a = 'X,Y,Z,FE,ID\n', b2 = 'X,Y,Z,AU,ID\n';
    for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) { a += `${5 + i * 10},${5 + j * 10},5,${30 + i},R${i}_${j}\n`; b2 += `${5 + i * 10},${5 + j * 10},5,${(i * 0.1).toFixed(1)},R${i}_${j}\n`; }
    await window._micro.openBlob(new Blob([a]), 'left.csv', 'replace');
    await new Promise((r) => setTimeout(r, 300));
    await window._micro.openBlob(new Blob([b2]), 'right.csv', 'add');
  });
  await pj.waitForFunction(() => window._micro.layers().length === 2 && window._micro.layers()[1].docs.blockDoc, null, { timeout: 30000 });
  const jc = await pj.evaluate(async () => {
    const [L, R] = window._micro.layers();
    window._micro.setActiveLayer(L.id);
    const outs = await window._micro.spatialJoinToCols(L, R, { target: 'left', cols: ['right:AU'], ops: {}, weights: {} });
    const { outs: kOuts, matched } = await window._micro.keyJoinToCols(L, R, { leftKey: 'ID', rightKey: 'ID', bring: ['AU'], dup: 'first' });
    await window._micro.applyBlockFilter('AU > 0.55 and ' + kOuts[0] + ' > 0.55');
    let h = 0; for (const m of L._filterMask) if (m) h++;
    const man2 = window._micro.buildElementManifest(L);
    const xel = man2.ops.filter((o) => o.inputs && o.inputs[0].element === 'right.csv').map((o) => o.op).sort();
    return { outs, kOuts, matched, layers: window._micro.layers().length, hits: h, xel };
  });
  chk(`join → columns: spatial ${jc.outs} + key ${jc.kOuts} (${jc.matched} matched), NO new layer, filter ${jc.hits} hits, ops [${jc.xel}]`,
    jc.outs.join() === 'AU' && jc.kOuts.join() === 'right_AU' && jc.matched === 100 && jc.layers === 2 && jc.hits === 40 && jc.xel.join() === 'estimate,key-lookup');
  // TYPED sidecars: an op-produced CATEGORY column materializes to a STRING
  // Parquet in .cols/ (not project.json RLE) and reloads with dict + lineage
  await pj.evaluate(async () => {
    const [L, R] = window._micro.layers();
    let b2 = 'X,Y,Z,DOM,ID\n';
    for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) b2 += `${5 + i * 10},${5 + j * 10},5,${i < 5 ? 'OX' : 'FR'},R${i}_${j}\n`;
    await window._micro.openBlob(new Blob([b2]), 'doms.csv', 'add');
    await new Promise((r) => setTimeout(r, 400));
    const D = window._micro.layers()[2];
    window._micro.setActiveLayer(L.id);
    await window._micro.keyJoinToCols(L, D, { leftKey: 'ID', rightKey: 'ID', bring: ['DOM'], dup: 'first' });
    L.storage = 'project';
  });
  await saveProject(pj);
  const tc = await pj.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('sm2join');
    const models = await dir.getDirectoryHandle('models');
    const cols = await models.getDirectoryHandle('left.csv.cols');
    const names = []; for await (const k of cols.keys()) names.push(k);
    const pj2 = JSON.parse(await (await (await dir.getFileHandle('project.json')).getFile()).text());
    const rle = ((pj2.layers.find((l) => /left/.test(l.source)) || {}).paintCols || []).map((c) => c.name);
    return { hasDom: names.includes('DOM.parquet'), rle };
  });
  chk(`typed sidecar: DOM.parquet written as a STRING column, not RLE (rle: [${tc.rle}])`, tc.hasDom && !tc.rle.includes('DOM'));
  await pj.close();
  const pj2 = await mkPage('sm2join');
  await pj2.evaluate(async () => { const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('sm2join'); await window._micro.openProjectDir(dir); });
  await pj2.waitForFunction(() => { const L = window._micro.layers().find((x) => /left/.test(x.name)); return L && (L.paintCols || []).some((c) => c.name === 'DOM' && c.dict.length > 2); }, null, { timeout: 60000 });
  const tr = await pj2.evaluate(async () => {
    const L = window._micro.layers().find((x) => /left/.test(x.name));
    window._micro.setActiveLayer(L.id);
    const dom = L.paintCols.find((c) => c.name === 'DOM');
    await window._micro.applyBlockFilter('DOM = "FR"');
    let h = 0; for (const m of L._filterMask) if (m) h++;
    return { dict: dom.dict.slice(1).sort().join(), lin: dom.lineage && dom.lineage.op, hits: h };
  });
  chk(`typed sidecar reload: dict [${tr.dict}], lineage ${tr.lin}, filter ${tr.hits} hits`, tr.dict === 'FR,OX' && tr.lin === 'key-lookup' && tr.hits === 50);
  // GOVERNED residency: matcol fvalues are evictable under the pin budget and
  // re-fault from the sidecar at the next scan that needs them
  const gv = await pj2.evaluate(async () => {
    const L = window._micro.layers().find((x) => /left/.test(x.name));
    window._micro.setActiveLayer(L.id);
    window._micro.setPinBudget(0.000001);                  // ~1 byte → everything evicts
    const evicted = L.paintCols.find((c) => c.name === 'AU').fvalues === null;
    window._micro.setPinBudget('auto');
    await window._micro.applyBlockFilter('AU > 0.55');
    let h = 0; for (const m of L._filterMask) if (m) h++;
    return { evicted, hits: h, back: !!L.paintCols.find((c) => c.name === 'AU').fvalues };
  });
  chk(`governed residency: evicted matcol re-faults from the sidecar on filter (${gv.hits} hits)`, gv.evicted && gv.back && gv.hits === 40);
  await pj2.close();
}

// ═══ 20. ARRAY-BACKED grid locations: a grid emits its element manifest —
//     records are lattice nodes, coords IMPLICIT (no coord columns) ═══
{
  const pg = await mkPage('sm2gelem');
  await pg.evaluate(async () => { try { await (await navigator.storage.getDirectory()).removeEntry('sm2gelem', { recursive: true }); } catch { } });
  await pg.evaluate(async () => {
    let t = 'ncols 12\nnrows 8\nxllcorner 0\nyllcorner 0\ncellsize 50\nNODATA_value -9999\n';
    for (let r = 0; r < 8; r++) t += Array.from({ length: 12 }, (_, c) => 100 + r + c).join(' ') + '\n';
    await window._micro.openBlob(new Blob([t]), 'dem.asc', 'replace');
  });
  await pg.waitForFunction(() => window._micro.layers().length === 1 && window._micro.layers()[0].docs.gridDoc, null, { timeout: 30000 });
  await pg.evaluate(() => { window._micro.layers()[0].storage = 'project'; });
  await saveProject(pg);
  const ge = await pg.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('sm2gelem');
    const man = JSON.parse(await (await (await (await dir.getDirectoryHandle('grids')).getFileHandle('dem.asc.element.json')).getFile()).text());
    const n2 = man.locations.nodes;
    return { v: man.v, kind: man.geometry.kind, storage: n2.storage, count: n2.count, lat: n2.lattice && n2.lattice.nx === 12 && n2.lattice.dx === 50, noCoords: !n2.coords, col: man.columns[0] && man.columns[0].loc === 'nodes' };
  });
  chk(`grid element: array-backed nodes (${ge.count} records, coords implicit from the lattice)`,
    ge.v === 1 && ge.kind === 'grid' && ge.storage === 'array' && ge.count === 96 && ge.lat && ge.noCoords && ge.col);
  await pg.close();
}

// ═══ 21. the ROUTINE: recipes running recipes — each-block expansion,
//     $var substitution, dated report routing, the no-overwrites guard ═══
{
  const pr = await mkPage('sm2routine');
  await pr.evaluate(async () => { try { await (await navigator.storage.getDirectory()).removeEntry('sm2routine', { recursive: true }); } catch { } });
  await pr.evaluate(() => {
    let t = 'X,Y,Z,FE,SG\n';
    for (let i = 0; i < 15; i++) for (let j = 0; j < 15; j++) t += `${5 + i * 10},${5 + j * 10},5,${(30 + i * 2).toFixed(1)},${(2.5 + i * 0.05).toFixed(2)}\n`;
    return window._micro.openBlob(new Blob([t]), 'm.csv', 'replace');
  });
  await pr.waitForFunction(() => window._micro.layers().length === 1 && window._micro.layers()[0].docs.blockDoc, null, { timeout: 30000 });
  await pr.evaluate(() => { window._micro.layers()[0].storage = 'project'; });
  await saveProject(pr);
  const rt = await pr.evaluate(async () => {
    window._micro._recipesList().push({ name: 'gt std', tool: 'gt', params: { layer: 'm.csv', series: [{ layer: 'm.csv', col: 'FE' }], nCut: 6 } });
    await window._micro.runRoutine({ name: 'month', tool: 'routine', params: {
      steps: [{ each: { grade: ['FE'] }, steps: [{ recipe: 'gt std', series: [{ layer: 'm.csv', col: '$grade' }] }] }],
    } });
    const meta1 = document.querySelector('#meta').textContent;
    await window._micro.runRoutine({ name: 'month', tool: 'routine', params: {
      steps: [{ guard: 'no-overwrites' }, { each: { grade: ['FE'] }, steps: [{ recipe: 'gt std', series: [{ layer: 'm.csv', col: '$grade' }] }] }],
    } });
    const meta2 = document.querySelector('#meta').textContent;
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('sm2routine');
    const day = new Date().toISOString().slice(0, 10);
    const rep = await (await dir.getDirectoryHandle('reports')).getDirectoryHandle(day);
    const names = []; for await (const k of rep.keys()) names.push(k);
    return { meta1, meta2, names };
  });
  chk(`routine: each-expansion runs + report written (${rt.names}) + guard stops the re-run`,
    /1 report/.test(rt.meta1) && rt.names.join() === 'gt-std-fe.tsv' && /guard stopped/.test(rt.meta2));

  // §21b — the routine EDITOR: Save writes YAML that loadRecipes reads back;
  // reopening restores the guard (the file is the truth, the window a view)
  const ed = await pr.evaluate(async () => {
    window._micro.openRoutineWindow(null);
    const el = document.querySelector('.fwin[data-routine]');
    el.querySelector('input[placeholder="month-end"]').value = 'edited';
    el.querySelector('#rwGuard').checked = true; el.querySelector('#rwGuard').dispatchEvent(new Event('change'));
    const sel = el.querySelector('.rw-step select');
    sel.value = 'gt std'; sel.dispatchEvent(new Event('change'));
    [...el.querySelectorAll('button')].find((x) => x.textContent === 'Save').click();
    await new Promise((r) => { const iv = setInterval(() => { if (/saved routine/.test(document.querySelector('#meta').textContent)) { clearInterval(iv); r(); } }, 100); });
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('sm2routine');
    const yml = await (await (await (await dir.getDirectoryHandle('recipes')).getFileHandle('edited.yaml')).getFile()).text();
    window._micro._recipesList().length = 0;
    await window._micro.loadRecipes(dir);
    const back = window._micro._recipesList().find((x) => x.name === 'edited');
    el.remove();
    let guardBack = false;
    if (back) {
      window._micro.openRoutineWindow(back);
      const el2 = document.querySelector('.fwin[data-routine]');
      guardBack = el2 && el2.querySelector('#rwGuard').checked;
      if (el2) el2.remove();
    }
    return { hasTool: /tool: "routine"/.test(yml), hasGuard: /guard: "no-overwrites"/.test(yml), loaded: !!back, guardBack };
  });
  chk('routine editor: Save → YAML → loadRecipes → reopen restores the guard',
    ed.hasTool && ed.hasGuard && ed.loaded && ed.guardBack);

  // §21c — inputs: a recipe with `inputs:` generates the ask-me-first dialog;
  // Run substitutes $vars (typed for number inputs) and executes
  const inp = await pr.evaluate(async () => {
    window._micro._recipesList().push({ name: 'ask', tool: 'gt', file: 'recipes/ask.yaml',
      inputs: [{ name: 'grade', type: 'column' }, { name: 'n', type: 'number', default: 5 }],
      params: { layer: 'm.csv', series: [{ layer: 'm.csv', col: '$grade' }], nCut: '$n' } });
    window._micro.runRecipe(window._micro._recipesList().find((x) => x.name === 'ask'), true);
    const dlg = document.querySelector('.fwin[data-inputs-dialog]');
    if (!dlg) return { dlg: false };
    const opts = [...dlg.querySelector('select').options].map((o) => o.value);
    dlg.querySelector('select').value = 'FE';
    [...dlg.querySelectorAll('button')].find((x) => x.textContent === 'Run').click();
    const t0 = Date.now();
    let w;
    while (Date.now() - t0 < 60000) {
      w = [...document.querySelectorAll('.fwin')].find((x) => x._tableTSV && x._tableTSV());
      if (w) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const tsv = w ? w._tableTSV() : '';
    document.querySelectorAll('.fwin').forEach((x) => x.remove());
    return { dlg: true, opts: opts.join(','), head: tsv.split('\n')[0], rows: tsv.split('\n').length - 1 };
  });
  chk(`inputs: dialog generated (cols ${inp.opts}) + substituted run (${inp.head} · ${inp.rows} rows)`,
    inp.dlg && /FE/.test(inp.opts) && /FE/.test(inp.head || '') && inp.rows === 6);

  // §21d — inline steps (tool: instead of recipe: — a batch from scratch,
  // nothing pre-recorded) + a routine's own inputs: gate the run
  const inl = await pr.evaluate(async () => {
    await window._micro.runRoutine({ name: 'scratch', tool: 'routine', params: {
      steps: [{ each: [{ g: 'FE' }], steps: [{ tool: 'gt', series: [{ layer: 'm.csv', col: '$g' }], nCut: 4, as: 'inline' }] }],
    } });
    const meta = document.querySelector('#meta').textContent;
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('sm2routine');
    const day = new Date().toISOString().slice(0, 10);
    const rep = await (await dir.getDirectoryHandle('reports')).getDirectoryHandle(day);
    const names = []; for await (const k of rep.keys()) names.push(k);
    window._micro._recipesList().push({ name: 'ask-routine', tool: 'routine', file: 'recipes/ar.yaml',
      inputs: [{ name: 'g2', type: 'column' }],
      params: { steps: [{ tool: 'gt', series: [{ layer: 'm.csv', col: '$g2' }] }] } });
    window._micro.runRecipe(window._micro._recipesList().find((x) => x.name === 'ask-routine'), true);
    const dlg = !!document.querySelector('.fwin[data-inputs-dialog]');
    document.querySelectorAll('.fwin').forEach((x) => x.remove());
    return { meta, names: names.join(','), dlg };
  });
  chk(`inline step ran from scratch (${inl.names}) + routine inputs gate the run`,
    /1 report/.test(inl.meta) && /inline-fe\.tsv/.test(inl.names) && inl.dlg);

  // §21e — the run tracker walks the expansion live and stays as the summary;
  // preview lines open a specific parameterization row configured (not run)
  const trk = await pr.evaluate(async () => {
    document.querySelectorAll('.fwin').forEach((w) => w.remove());
    await window._micro.runRoutine({ name: 'trk', tool: 'routine', params: { output: { prefix: 'k-' }, steps: [
      { each: [{ g: 'FE' }], steps: [{ tool: 'gt', series: [{ layer: 'm.csv', col: '$g' }], nCut: 4 }] },
    ] } });
    const el = document.querySelector('.fwin[data-routine-run]');
    const oks = el ? el.querySelectorAll('.rw-state.ok').length : 0;
    const summary = el ? [...el.querySelectorAll('.lbl')].map((x) => x.textContent).join(' ') : '';
    document.querySelectorAll('.fwin').forEach((w) => w.remove());
    window._micro.openRoutineWindow({ name: 'trk', tool: 'routine', file: 'recipes/trk.yaml', params: { steps: [
      { each: [{ g: 'FE' }, { g: 'SG' }], steps: [{ tool: 'gt', series: [{ layer: 'm.csv', col: '$g' }] }] },
    ] } });
    const ed = document.querySelector('.fwin[data-routine]');
    [...ed.querySelectorAll('button')].find((x) => x.textContent === 'Preview').click();
    await new Promise((r) => setTimeout(r, 300));
    const lines = [...ed.querySelectorAll('.rw-prevline')];
    const sg = lines.find((x) => /-sg\.tsv/.test(x.textContent) && x.classList.contains('open'));
    if (sg) sg.click();
    await new Promise((r) => setTimeout(r, 800));
    const w = [...document.querySelectorAll('.fwin')].find((x) => !x.dataset.routine && /grade/i.test(x.querySelector('.fwin-head .t')?.textContent || ''));
    const cfg = w ? [...w.querySelectorAll('select')].map((x) => x.value).join(',') : '';
    const ran = w && w._tableTSV && !!w._tableTSV();
    document.querySelectorAll('.fwin').forEach((x) => x.remove());
    return { oks, summary, clicked: !!sg, cfg, ran };
  });
  chk(`run tracker (✓×${trk.oks}, "${trk.summary.trim()}") + preview click opens the SG row configured (${trk.cfg})`,
    trk.oks === 1 && /1 report/.test(trk.summary) && trk.clicked && /SG/.test(trk.cfg) && !trk.ran);

  // §22 — Reload from disk: fresh bytes through the layer's existing config
  const rld = await pr.evaluate(async () => {
    document.querySelectorAll('.fwin').forEach((w) => w.remove());
    const L = window._micro.layers()[0];
    const can = window._micro.canReloadLayer(L);
    L.calcCols = [{ name: 'FE2', expr: 'FE * 2', ty: 'number' }];
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('sm2routine');
    const models = await dir.getDirectoryHandle('models');
    const fh = await models.getFileHandle('m.csv');
    let t = 'X,Y,Z,FE,SG\n';
    for (let i = 0; i < 15; i++) for (let j = 0; j < 15; j++) t += `${5 + i * 10},${5 + j * 10},5,${(70 + i).toFixed(1)},${(2.5 + i * 0.05).toFixed(2)}\n`;
    const w = await fh.createWritable(); await w.write(t); await w.close();
    await window._micro.reloadLayerFromDisk(L);
    const row = await window._micro.fetchCsvRecord(0, window._micro.layers()[0].docs.blockDoc);
    return { can, fe: +row[3], calc: (window._micro.layers()[0].calcCols || []).map((c) => c.name).join(','), meta: document.querySelector('#meta').textContent };
  });
  chk(`reload from disk: fresh bytes (FE ${rld.fe}) + calc column kept + "${rld.meta}"`,
    rld.can && rld.fe === 70 && rld.calc === 'FE2' && /reloaded/.test(rld.meta));
  await pr.close();
}

// ── §23: the TABLE kind — a coordinate-less CSV is a first-class layer ──
{
  const pt = await mkPage('sm2table');
  await pt.evaluate(async () => { try { await (await navigator.storage.getDirectory()).removeEntry('sm2table', { recursive: true }); } catch { } });
  await pt.evaluate(() => window._micro.openBlob(new Blob(['DOMAIN,CUTOFF,PRICE\nHEM,55,105\nITA,50,98\nCANGA,45,80\nWASTE,0,0\n']), 'cutoffs.csv', 'replace'));
  await pt.waitForFunction(() => window._micro.layers()[0] && window._micro.layers()[0].kind === 'table', null, { timeout: 20000 });
  const tb = await pt.evaluate(async () => {
    const L = window._micro.layers()[0];
    window._micro.setActiveLayer(L.id);
    await window._micro.applyBlockFilter('CUTOFF > 45');
    const hits = L._filterCount;
    window._micro.applyCalcCols(L, [{ name: 'NET', expr: 'PRICE * 0.9', ty: 'number' }]);
    L.storage = 'project';
    return { kind: L.kind, rows: L.docs.tableDoc.header.count, hits, spatial: !!window._micro.gridAxesOf(L), calc: (L.calcCols || []).length };
  });
  await saveProject(pt);
  const rt = await pt.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('sm2table');
    const man = JSON.parse(await (await (await dir.getFileHandle('project.json')).getFile()).text());
    const names = []; for await (const k of (await dir.getDirectoryHandle('tables')).keys()) names.push(k);
    window.showDirectoryPicker = async () => dir;
    await window._micro.openProjectDir();
    await new Promise((r) => setTimeout(r, 1500));
    const L = window._micro.layers()[0];
    return { manKind: man.layers[0].kind, inTables: names.includes('cutoffs.csv'), kind: L.kind, filter: L.filterExpr, calc: (L.calcCols || []).length };
  });
  chk(`table kind: coordinate-less CSV → table layer (${tb.rows} rows), filter ${tb.hits}/4, ƒ column, no spatial verbs`,
    tb.kind === 'table' && tb.rows === 4 && tb.hits === 2 && !tb.spatial && tb.calc === 1);
  chk(`table kind: project round-trip (manifest kind=${rt.manKind}, tables/ folder, filter + ƒ restored)`,
    rt.manKind === 'table' && rt.inTables && rt.kind === 'table' && rt.filter === 'CUTOFF > 45' && rt.calc === 1);
  await pt.close();
}

// ── §24: Excel — a worksheet is a table (typed), geometry only when asked ──
{
  const px = await mkPage('sm2xlsx');
  await px.evaluate(async () => { try { await (await navigator.storage.getDirectory()).removeEntry('sm2xlsx', { recursive: true }); } catch { } });
  // build the workbook IN THE PAGE with @gcu/sheet's writer (micro bundles it)
  const built = await px.evaluate(async () => {
    const m = await import('/ext/sheet/index.js');
    const bytes = await m.sheet.write({ sheets: [
      { name: 'Cutoffs', columns: { DOMAIN: ['HEM', 'ITA', 'WASTE'], CUTOFF: [55, 50, 0], PRICE: [105.5, 98, 0] } },
      { name: 'Grid', columns: { X: [0, 10, 20], Y: [0, 0, 10], Z: [5, 5, 5], FE: [61, 58, 44] } },
    ] });
    window._wb = new Blob([bytes]);
    return true;
  });
  const xl = await px.evaluate(async () => {
    await window._micro.openBlob(window._wb, 'book.xlsx', 'replace', null, { sheet: 'Cutoffs' });
    await new Promise((r) => setTimeout(r, 600));
    const L = window._micro.layers()[0];
    const h = L.docs.tableDoc.header;
    window._micro.setActiveLayer(L.id);
    await window._micro.applyBlockFilter('CUTOFF > 45');
    // the COORDINATE sheet must ALSO open as a table — a workbook is not a coordinate system
    await window._micro.openBlob(window._wb, 'book.xlsx', 'add', null, { sheet: 'Grid' });
    await new Promise((r) => setTimeout(r, 600));
    const G = window._micro.layers()[1];
    return {
      kind: L.kind, sheet: h.sheet, rows: h.count, num: h.numericColumns.map((c) => c.name).join(),
      typed: typeof L.docs.tableDoc.xlsx.at(0)[2], hits: L._filterCount,
      gridKind: G.kind, gridSpatial: !!window._micro.gridAxesOf(G),
      promote: window._micro.reinterpretOptions(G).map((o) => o.kind).join(),
    };
  });
  chk(`xlsx: sheet "${xl.sheet}" → table (${xl.rows} rows, numeric ${xl.num} typed from Excel), filter ${xl.hits}/3`,
    xl.kind === 'table' && xl.rows === 3 && xl.num === 'CUTOFF,PRICE' && xl.typed === 'number' && xl.hits === 2);
  chk(`xlsx: an X/Y/Z sheet still opens as a table (geometry offered, never guessed: ${xl.promote})`,
    xl.gridKind === 'table' && !xl.gridSpatial && xl.promote === 'blocks,points');
  await px.close();
}

// ── §25: routine params — a key→value sheet is a SCALAR scope, not a fan-out ──
{
  const pp = await mkPage('sm2params');
  await pp.evaluate(async () => { try { await (await navigator.storage.getDirectory()).removeEntry('sm2params', { recursive: true }); } catch { } });
  await pp.evaluate(() => window._micro.openBlob(new Blob(['X,Y,Z,FE\n0,0,0,50\n10,0,0,55\n20,0,0,60\n']), 'm.csv', 'replace'));
  await pp.waitForFunction(() => window._micro.layers()[0] && window._micro.layers()[0].docs.blockDoc, null, { timeout: 20000 });
  await pp.evaluate(() => { window._micro.layers()[0].storage = 'project'; });
  await saveProject(pp);
  const pr = await pp.evaluate(async () => {
    const m = await import('/ext/sheet/index.js');
    const bytes = await m.sheet.write({ sheets: [
      // a General series WITH a blank cell — Excel types that column as text,
      // so the routine reader must coerce or $g.cutoff arrives as "55"
      { name: 'General', columns: { parameter: ['cutoff', 'density', 'spare'], value: [55, 2.75, ''] } },
      { name: 'Benches', columns: { grade: ['FE', 'SIO2'], nCut: [12, 8] } },
    ] });
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('sm2params');
    const fh = await dir.getFileHandle('params.xlsx', { create: true });
    const w = await fh.createWritable(); await w.write(bytes); await w.close();
    const steps = await window._micro.expandRoutine({
      params: [{ from: 'params.xlsx#General', as: 'g', fill: 0 }],
      steps: [
        { tool: 'gt', layer: 'm.csv', nCut: '$g.cutoff', dens: '$g.density', spare: '$g.spare' },
        { each: { from: 'params.xlsx#Benches' }, steps: [{ tool: 'gt', series: [{ layer: 'm.csv', col: '$grade' }], nCut: '$nCut', floor: '$g.cutoff' }] },
      ],
    });
    return {
      scalar: steps[0].nCut, type: typeof steps[0].nCut, dens: steps[0].dens, spare: steps[0].spare,
      fan: steps.slice(1).map((x) => `${x.series[0].col}:${x.nCut}:${x.floor}`).join(','),
      n: steps.length,
    };
  });
  chk(`routine params: a key→value sheet is a scalar scope ($g.cutoff=${pr.scalar} ${pr.type}, fill→${pr.spare}), one run not three`,
    pr.n === 3 && pr.scalar === 55 && pr.type === 'number' && pr.dens === 2.75 && pr.spare === 0);
  chk(`routine params: the scope reaches each-blocks too (${pr.fan})`,
    pr.fan === 'FE:12:55,SIO2:8:55');
  await pp.close();
}

// ── §26: nested each (cross product) vs one each (zip); params as a step ──
{
  const pn = await mkPage('sm2nest');
  await pn.evaluate(async () => { try { await (await navigator.storage.getDirectory()).removeEntry('sm2nest', { recursive: true }); } catch { } });
  await pn.evaluate(() => window._micro.openBlob(new Blob(['X,Y,Z,FE\n0,0,0,50\n10,0,0,60\n']), 'm.csv', 'replace'));
  await pn.waitForFunction(() => window._micro.layers()[0] && window._micro.layers()[0].docs.blockDoc, null, { timeout: 20000 });
  const nx = await pn.evaluate(async () => {
    // nested = CROSS PRODUCT
    const cross = await window._micro.expandRoutine({ steps: [
      { each: [{ bench: 1040 }, { bench: 1060 }], as: 'b', steps: [
        { each: [{ grade: 'FE' }, { grade: 'SIO2' }], as: 'g', steps: [
          { tool: 'gt', layer: 'm.csv', b: '$b.bench', g: '$g.grade' },
        ] },
      ] },
    ] });
    // one each, two columns = ZIP
    const zip = await window._micro.expandRoutine({ steps: [
      { each: { bench: [1040, 1060], grade: ['FE', 'SIO2'] }, steps: [{ tool: 'gt', layer: 'm.csv', b: '$bench', g: '$grade' }] },
    ] });
    return {
      cross: cross.map((x) => `${x.g}@${x.b}`).join(','), crossSlugs: cross.map((x) => x._slug).join(','),
      zip: zip.map((x) => `${x.g}@${x.b}`).join(','),
    };
  });
  chk(`routine nesting: nested each = CROSS product (${nx.cross})`,
    nx.cross === 'FE@1040,SIO2@1040,FE@1060,SIO2@1060' && nx.crossSlugs === 'gt-1040-fe,gt-1040-sio2,gt-1060-fe,gt-1060-sio2');
  chk(`routine nesting: one each with two columns stays a ZIP (${nx.zip})`,
    nx.zip === 'FE@1040,SIO2@1060');
  await pn.close();
}

// ── §27: ${expr} in routines — one calculus; values compute, structure doesn't ──
{
  const pe = await mkPage('sm2expr');
  const ex = await pe.evaluate(async () => {
    const steps = await window._micro.expandRoutine({ steps: [
      { each: [{ bench: 1040, grade: 'FE' }, { bench: 1060, grade: 'SIO2' }], as: 'b', steps: [
        { tool: 'gt', layer: 'm.csv', cut: '${b.bench * 0.001}', pick: '${if(b.grade = "FE", 55, 45)}', label: 'bench ${b.bench}' },
      ] },
    ] });
    let typo = null;
    try { await window._micro.expandRoutine({ steps: [{ each: [{ bench: 1 }], as: 'b', steps: [{ tool: 'gt', v: '${b.bnch}' }] }] }); }
    catch (e) { typo = e.message; }
    return {
      n: steps.length, cut: steps[0].cut, t: typeof steps[0].cut,
      picks: steps.map((x) => x.pick).join(','), label: steps[0].label,
      slugs: steps.map((x) => x._slug).join(','), typo,
    };
  });
  chk(`routine \${expr}: typed arithmetic (${ex.cut} ${ex.t}), if() (${ex.picks}), text interpolation ("${ex.label}")`,
    ex.cut === 1.04 && ex.t === 'number' && ex.picks === '55,45' && ex.label === 'bench 1040');
  chk(`routine \${expr}: structure stays static (2 steps, slugs ${ex.slugs}) + a typo fails loudly`,
    ex.n === 2 && ex.slugs === 'gt-1040-fe,gt-1060-sio2' && /unknown column: b\.bnch/.test(ex.typo || ''));
  await pe.close();
}

// ── §28: filter: on an each block — which rows fan out (data selection, not ifs) ──
{
  const pf = await mkPage('sm2eachfilter');
  const ef = await pf.evaluate(async () => {
    const steps = await window._micro.expandRoutine({ steps: [
      { each: [
        { bench: 1020, active: 'true' },
        { bench: 1040, active: 'true' },
        { bench: 1060, active: 'false' },
      ], as: 'b', filter: 'active = "true" and bench >= 1040',
        steps: [{ tool: 'gt', layer: 'm.csv', v: '$b.bench' }] },
    ] });
    const scoped = window._micro.routineFilterRows([{ bench: 1020 }, { bench: 1060 }], 'bench >= g.floor', { g: { floor: 1040 } });
    let typo = null;
    try { window._micro.routineFilterRows([{ bench: 1 }], 'bnch > 1', {}); } catch (e) { typo = e.message; }
    return { n: steps.length, v: steps.map((x) => x.v).join(','), scoped: scoped.map((r) => r.bench).join(','), typo };
  });
  chk(`each filter: 3 rows → ${ef.n} run (${ef.v}); compares against a scalar (${ef.scoped}); a typo fails loudly`,
    ef.n === 1 && ef.v === '1040' && ef.scoped === '1060' && /unknown column: bnch/.test(ef.typo || ''));
  await pf.close();
}

// ── §29: the guard knows COLUMNS · results become table layers · resume ──
{
  const p3 = await mkPage('sm2r3');
  await p3.evaluate(async () => { try { await (await navigator.storage.getDirectory()).removeEntry('sm2r3', { recursive: true }); } catch { } });
  await p3.evaluate(() => {
    let t = 'X,Y,Z,FE\n';
    for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) t += `${i * 10},${j * 10},5,${45 + i}\n`;
    return window._micro.openBlob(new Blob([t]), 'm.csv', 'replace');
  });
  await p3.waitForFunction(() => window._micro.layers()[0] && window._micro.layers()[0].docs.blockDoc, null, { timeout: 20000 });
  await p3.evaluate(() => { window._micro.layers()[0].storage = 'project'; });
  await saveProject(p3);
  const g3 = await p3.evaluate(async () => {
    const L = window._micro.layers()[0];
    // the guard must catch a COLUMN overwrite, not just a report file
    window._micro.applyCalcCols(L, [{ name: 'FE_EQ', expr: 'FE * 1.1', ty: 'number' }]);
    window._micro._recipesList().length = 0;
    window._micro._recipesList().push({ name: 'cols', tool: 'calccols', params: { layer: 'm.csv', cols: [{ name: 'FE_EQ', expr: 'FE * 1.1' }] } });
    await window._micro.runRoutine({ name: 'guarded', tool: 'routine', params: { steps: [{ guard: 'no-overwrites' }, { recipe: 'cols' }] } });
    const guardMeta = document.querySelector('#meta').textContent;
    // createPaintCol replaces on name (run-twice == run-once), still refuses to shadow source
    window._micro.createPaintCol(L, 'DOM');
    window._micro.createPaintCol(L, 'DOM');
    const paintN = (L.paintCols || []).filter((c) => c.name === 'DOM').length;
    const shadow = window._micro.createPaintCol(L, 'FE') === null;
    // an analysis result becomes a table layer
    const T = await window._micro.resultToLayer('gt · m.csv', 'cutoff\ttonnes\n0\t900\n55\t300\n');
    return { guardMeta, paintN, shadow, tKind: T.kind, tRows: T.docs.tableDoc.header.count, tLabel: T.label };
  });
  chk(`guard sees COLUMNS ("${g3.guardMeta.slice(0, 60)}…"); paint replaces on name (${g3.paintN}); source still protected`,
    /guard stopped/.test(g3.guardMeta) && /FE_EQ/.test(g3.guardMeta) && g3.paintN === 1 && g3.shadow);
  chk(`analysis result → table layer ("${g3.tLabel}", ${g3.tRows} rows)`,
    g3.tKind === 'table' && g3.tRows === 2);
  const r3 = await p3.evaluate(async () => {
    window._micro._recipesList().length = 0;
    window._micro._recipesList().push({ name: 'gt std', tool: 'gt', params: { layer: 'm.csv', series: [{ layer: 'm.csv', col: 'FE' }], nCut: 4 } });
    await window._micro.runRoutine({ name: 'resumed', tool: 'routine', params: { output: { prefix: 'z-' }, steps: [
      { each: [{ g: 'FE' }, { g: 'FE' }], steps: [{ recipe: 'gt std', series: [{ layer: 'm.csv', col: '$g' }] }] },
    ] } }, { from: 1 });
    const el = document.querySelector('.fwin[data-routine-run]');
    const icons = [...el.querySelectorAll('.rw-state')].map((x) => x.textContent).join('');
    const meta = document.querySelector('#meta').textContent;
    document.querySelectorAll('.fwin').forEach((w) => w.remove());
    return { icons, meta };
  });
  chk(`resume from a step: the tracker marks the skipped ones (${r3.icons}) and the summary is honest ("${r3.meta.split('—')[1] || ''}".trim())`,
    r3.icons === '–✓' && /1 step run \(1 skipped\)/.test(r3.meta));
  await p3.close();
}

// ── §30: groups as sugar on naming — "swaths/FE drift" files the layer ──
{
  const pg = await mkPage('sm2groups');
  await pg.evaluate(() => window._micro.openBlob(new Blob(['X,Y,Z,FE\n0,0,0,50\n10,0,0,60\n']), 'm.csv', 'replace'));
  await pg.waitForFunction(() => window._micro.layers()[0], null, { timeout: 20000 });
  const gp = await pg.evaluate(async () => {
    const A = await window._micro.resultToLayer('swaths/FE drift', 'band\tmean\n1\t55\n2\t58\n');
    await window._micro.resultToLayer('swaths/SIO2 drift', 'band\tmean\n1\t4\n');
    await window._micro.resultToLayer('month-end/gt/FE', 'cutoff\tt\n0\t9\n');
    const L = window._micro.layers().find((x) => x.name === 'm.csv');
    window._micro.fileLayerByPath(L, 'models/deposit');
    const tree = window._micro.layerTree();
    const sw = tree.find((n) => n.group && n.name === 'swaths');
    const me = tree.find((n) => n.group && n.name === 'month-end');
    const gt = me && me.children.find((n) => typeof n !== 'number' && n.group && n.name === 'gt');
    const md = tree.find((n) => n.group && n.name === 'models');
    return { label: A.label, kind: A.kind, sw: sw ? sw.children.length : 0, nested: !!gt, model: md ? md.children.includes(L.id) : false, modelLabel: L.label };
  });
  chk(`group paths: "swaths/FE drift" → group swaths (${gp.sw} members), leaf as label ("${gp.label}"), nested path nests (${gp.nested})`,
    gp.kind === 'table' && gp.label === 'FE drift' && gp.sw === 2 && gp.nested);
  chk(`group paths: renaming a layer with a path files it ("models/deposit" → ${gp.modelLabel}, in models: ${gp.model})`,
    gp.model && gp.modelLabel === 'deposit');
  await pg.close();
}

// ── §31: layers are no longer a scarce resource (the id left the pick record) ──
{
  const pl = await mkPage('sm2pool');
  const pool = await pl.evaluate(async () => {
    await window._micro.openBlob(new Blob(['X,Y,Z,FE\n0,0,0,50\n10,0,0,60\n']), 'm.csv', 'replace');
    await new Promise((r) => setTimeout(r, 500));
    for (let i = 0; i < 8; i++) await window._micro.resultToLayer(`swaths/run ${i + 1}`, 'band\tmean\n1\t55\n');
    let opened = 0;
    for (let i = 0; i < 5; i++) {
      await window._micro.openBlob(new Blob([`X,Y,Z,AU\n${i},0,0,1\n${i + 1},0,0,2\n`]), `own-${i}.csv`, 'add');
      await new Promise((r) => setTimeout(r, 250));
      if (window._micro.layers().some((L) => L.name === `own-${i}.csv`)) opened++;
    }
    const Ls = window._micro.layers();
    const tabs = Ls.filter((L) => L.kind === 'table');

    // …and a HIGH layer id is still PICKABLE. The old scheme packed the layer into
    // three spare bits of the 32-bit pick id, so a model with id 8 was unreachable
    // by the ID buffer. The layer rides a per-draw uniform now (pick target RG32UI:
    // R = record, G = layer), so id has no ceiling — prove it end-to-end.
    const hi = Ls.filter((L) => /^own-/.test(L.name)).sort((a, b) => b.id - a.id)[0];
    window._micro.setActiveLayer(hi.id);
    window._micro.showRecord({ layer: hi.id, rec: 1 });
    await new Promise((r) => setTimeout(r, 600));
    const rows = [...document.querySelectorAll('#recPanel .rp-row')].map((r) => [r.querySelector('.k').textContent, r.querySelector('.v').textContent]);
    const au = rows.find(([k]) => k === 'AU');

    // the ID buffer itself: every lit pixel names a layer that actually exists
    document.querySelector('#btnFit').click();
    await new Promise((r) => setTimeout(r, 800));
    const cv = document.querySelector('#cv'), r = cv.getBoundingClientRect();
    const region = window._micro.renderer.pickRegion({ x: 0, y: 0, w: Math.floor(r.width), h: Math.floor(r.height) },
      window._micro.cam, { pointPx: 8, blocksAsPoints: false, section: null });
    const known = new Set(Ls.map((L) => L.id));
    let lit = 0, bogus = 0;
    const data = region ? region.data : new Uint32Array(0);
    for (let i = 0; i < data.length; i += 4) {
      const g = data[i + 1] >>> 0;
      if (g === 0xFFFFFFFF) continue;                       // miss
      lit++;
      const lid = g & 0xFFFF;                               // G = layer | face<<16 — never read it raw
      const face = (g >>> 16) & 7;
      if (!known.has(lid)) bogus++;                         // a packed-id ghost would land here
      if (face > 7) bogus++;
    }
    return { tables: tabs.length, opened, hiId: hi.id, hiName: hi.name, au: au && au[1], lit, bogus };
  });
  chk(`no layer partition: ${pool.tables} result tables + five of the visitor's models coexist (${pool.opened}/5 opened) — the old 7-slot ceiling is gone`,
    pool.tables === 8 && pool.opened === 5);
  chk(`a high layer id is pickable: layer ${pool.hiId} (${pool.hiName}) record 1 → AU ${pool.au} — its OWN data, not a neighbour's`,
    pool.hiId >= 8 && pool.au === '2');
  chk(`the ID buffer names only real layers (${pool.lit} lit pixels, ${pool.bogus} ghosts)`,
    pool.lit > 20 && pool.bogus === 0);
  await pl.close();
}

// ── §32: surfaces are pickable — WHICH mesh from the GPU, WHICH TRIANGLE from the CPU ──
{
  const pk = await mkPage('sm2mesh');
  const r = await pk.evaluate(async () => {
    let t = 'XC,YC,ZC,FE\n';
    for (let k = 0; k < 4; k++) for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++)
      t += `${5 + i * 10},${5 + j * 10},${5 + k * 10},${40 + k * 3}\n`;
    await window._micro.openBlob(new Blob([t]), 'cube.csv', 'replace');
    await new Promise((z) => setTimeout(z, 1200));
    const obj = ['v 0 0 80', 'v 80 0 80', 'v 80 80 80', 'v 0 80 80', 'f 1 2 3', 'f 1 3 4'].join('\n') + '\n';
    await window._micro.openBlob(new Blob([obj]), 'lid.obj', 'add');
    await new Promise((z) => setTimeout(z, 1500));

    const m = document.querySelector('#secMode'); m.value = 'off'; m.dispatchEvent(new Event('input'));
    const st = window._micro.cam.state;
    window._micro.cam.orbit(0, (Math.PI / 2 - 0.03) - st.phi);      // straight down (phi is FROM the XY plane)
    document.querySelector('#btnFit').click();
    window._micro.requestRender();
    await new Promise((z) => setTimeout(z, 1200));

    const cv = document.querySelector('#cv'), rc = cv.getBoundingClientRect();
    const cx = rc.width * 0.5, cy = rc.height * 0.5;
    const P = () => window._micro.renderer.pick(cx, cy, window._micro.cam, { pointPx: 6, blocksAsPoints: false, section: null });
    const kindOf = (h) => { const L = h && window._micro.layers().find((x) => x.id === h.layer); return L && L.kind; };

    const mesh = window._micro.layers().find((x) => x.kind === 'mesh');
    const blocks = window._micro.layers().find((x) => x.kind === 'blocks');

    const hOpaque = P();                                             // the lid ships opaque → it picks
    const mh = kindOf(hOpaque) === 'mesh' ? await window._micro.meshHitAt(mesh, cx, cy) : null;

    // see-through → the click must reach the blocks (you made it see-through to see past it)
    mesh.opacity = 0.4; window._micro.renderer.setLayerOpacity(mesh.id, 0.4);
    window._micro.setActiveLayer(blocks.id);
    window._micro.requestRender();
    await new Promise((z) => setTimeout(z, 800));
    const hThrough = P();

    // …but selecting it says "I mean this surface"
    window._micro.setActiveLayer(mesh.id);
    window._micro.requestRender();
    await new Promise((z) => setTimeout(z, 800));
    const hSelected = P();

    // the FACE code, sampled over several pixels: looking straight down, the top
    // face must dominate. (One centre pixel is brittle — at a near-vertical view a
    // block's side sliver is a fraction of a degree wide and can own that pixel.)
    window._micro.setActiveLayer(blocks.id);
    mesh.visible = false; window._micro.applyTreeVisibility();
    window._micro.requestRender();
    await new Promise((z) => setTimeout(z, 800));
    const faces = [];
    for (const [fx, fy] of [[0.5, 0.5], [0.45, 0.45], [0.55, 0.55], [0.48, 0.53], [0.53, 0.47]]) {
      const h = window._micro.renderer.pick(rc.width * fx, rc.height * fy, window._micro.cam,
        { pointPx: 6, blocksAsPoints: false, section: null });
      if (h) faces.push(h.face);
    }
    return {
      opaqueKind: kindOf(hOpaque), tri: mh && mh.tri, z: mh && mh.point[2], nz: mh && mh.normal[2],
      throughKind: kindOf(hThrough), throughFace: hThrough && hThrough.face,
      selectedKind: kindOf(hSelected),
      faces, tops: faces.filter((f) => f === 5).length,
    };
  });
  chk(`mesh pick: an opaque surface picks, and the CPU names the triangle (tri ${r.tri} at z=${r.z}, normal z=${r.nz && r.nz.toFixed(2)})`,
    r.opaqueKind === 'mesh' && r.tri != null && Math.abs(r.z - 80) < 0.01 && Math.abs(r.nz - 1) < 0.01);
  chk(`mesh pick: a 40%-opaque surface does NOT steal the click — it reaches the BLOCKS under it (${r.throughKind}, face ${r.throughFace})`,
    r.throughKind === 'blocks' && r.throughFace <= 5);
  chk(`face code: looking straight down, the top face dominates (${r.tops}/${r.faces.length} are +Z: [${r.faces.join(',')}])`,
    r.faces.length >= 4 && r.tops >= r.faces.length - 1);
  chk(`mesh pick: selecting that surface makes it clickable again (${r.selectedKind})`, r.selectedKind === 'mesh');
  await pk.close();
}

// ── §33: the EXPERIMENTAL natural-language bar — the SAFETY properties ──
// Its accuracy is allowed to be imperfect; these three are not:
//   (a) it is OFF by default — a cold visitor never meets a box that guesses
//   (b) it PROPOSES, it never ACTS — nothing happens until you read it and press Enter
//   (c) nonsense is refused, not guessed at
{
  const nl = await mkPage('sm2nl');
  const r = await nl.evaluate(async () => {
    let t = 'XC,YC,ZC,FE,LITO\n';
    for (let k = 0; k < 4; k++) for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++)
      t += `${5 + i * 10},${5 + j * 10},${1000 + k * 10},${40 + ((i + j + k) % 30)},${(i + j) % 3 === 0 ? 'HEMATITE' : (i + j) % 3 === 1 ? 'ITABIRITE' : 'WASTE'}\n`;
    await window._micro.openBlob(new Blob([t]), 'deposit.csv', 'replace');
    await new Promise((z) => setTimeout(z, 1200));

    const offByDefault = { stored: localStorage.getItem('micro.nl'), proposes: !!window._micro.nlPropose('colour the model by FE') };

    window._micro.nlSetEnabled(true);
    await window._micro.nlEnsureTrained();
    const said = window._micro.nlPropose('show blocks with FE above 60');
    const sym = window._micro.nlPropose('FE > 55');                       // SYMBOL operator (was misread as colour-by)
    const cat = window._micro.nlPropose('only hematite');                 // CATEGORICAL filter (was unrecognised)
    window._micro.createLayerGroup('phase set', [window._micro.layers().find((L) => L.docs && L.docs.blockDoc).id]);
    await window._micro.nlEnsureTrained();                                // the group changes the session key → retrain
    const grpProp = window._micro.nlPropose('hide phase set');           // a GROUP is an addressable target too
    grpProp && grpProp.run();
    const grpHidden = (window._micro.layerTree().find((n) => n && n.group && n.name === 'phase set') || {}).visible === false;
    const before = document.querySelector('#filter').value;              // proposing must NOT act
    const junk = window._micro.nlPropose('what is the airspeed velocity of an unladen swallow');
    if (said) said.run();                                                // …running must
    await new Promise((z) => setTimeout(z, 1200));
    const after = document.querySelector('#filter').value;

    // completion surface (Alt+K): starters when empty, word completion, breakdown chips
    window._micro.openPalette({ nl: true });
    const palItems = () => [...document.querySelectorAll('#palList .pal-item')];
    const nStarters = palItems().length;
    const typ = (v) => { const inp = document.querySelector('#palInput'); inp.value = v; inp.dispatchEvent(new Event('input')); };
    typ('hide phase'); const compHit = palItems().some((el) => /phase set/i.test((el.querySelector('.pal-t') || {}).textContent || ''));
    typ('FE > 55'); const bdChips = ((palItems()[0] || document.createElement('div')).querySelectorAll('.pal-chip')).length;
    window._micro.closePalette();

    window._micro.nlSetEnabled(false);
    return { offByDefault, said: said && said.title, sym: sym && sym.title, cat: cat && cat.title, grp: grpProp && grpProp.title, grpHidden, nStarters, compHit, bdChips, junk: junk && junk.title, before, after };
  });
  chk(`NL bar: OFF by default — nothing stored, nothing proposed (stored=${r.offByDefault.stored})`,
    r.offByDefault.stored === null && r.offByDefault.proposes === false);
  chk(`NL bar: it PROPOSES ("${r.said}") and does NOT act — filter stayed "${r.before}" until run, then "${r.after}"`,
    /FE/.test(r.said || '') && r.before === '' && /FE/.test(r.after) && /60/.test(r.after));
  chk(`NL bar: SYMBOL operators dispatch to a filter, not colour-by (FE > 55 → "${r.sym}")`, /FE\s*>\s*55/.test(r.sym || ''));
  chk(`NL bar: CATEGORICAL filter is recognised (only hematite → "${r.cat}")`, /LITO/.test(r.cat || '') && /HEMATITE/i.test(r.cat || ''));
  chk(`NL bar: a GROUP is an addressable visibility target (hide phase set → "${r.grp}", hidden=${r.grpHidden})`, /phase set/i.test(r.grp || '') && r.grpHidden === true);
  chk(`NL bar (Alt+K): completion surface — ${r.nStarters} starters, group word-completion=${r.compHit}, ${r.bdChips} breakdown chips`, r.nStarters >= 4 && r.compHit === true && r.bdChips >= 2);
  chk('NL bar: nonsense is refused, not guessed at', r.junk == null);
  await nl.close();
}

// ── §23 window system: dialog lifecycle · results footer · minimize strip ──
// Guards the 2026-07-25 coherence pass: dialogs stack on the shared z counter
// (later on top), Escape unwinds them newest-first, floats are opaque, every
// analysis foot carries the shared results row, minimize goes to a strip chip.
{
  const wp = await mkPage('sm2win');
  await wp.evaluate(() => {
    let csv = 'XC,YC,ZC,FE\n';
    for (let i = 0; i < 200; i++) csv += `${612000 + (i % 20) * 10},${7765000 + ((i / 20) | 0) * 10},400,${30 + i % 20}\n`;
    return window._micro.openBlob(new Blob([csv]), 'w.csv', 'replace');
  });
  await wp.waitForTimeout(700);
  await wp.evaluate(() => { window._micro.openNewDialog(); window._micro.openExportDialog(window._micro.layers()[0]); });
  await wp.waitForTimeout(250);
  const z1 = await wp.evaluate(() => ({ ng: +document.querySelector('#ngDlg').style.zIndex, ex: +document.querySelector('#exDlg').style.zIndex, ngShow: document.querySelector('#ngDlg').classList.contains('show'), exShow: document.querySelector('#exDlg').classList.contains('show'), ngModeless: document.querySelector('#ngDlg').classList.contains('modeless') }));
  chk(`window system: two config dialogs coexist modeless, later on top (ng z${z1.ng} < ex z${z1.ex})`, z1.ngShow && z1.exShow && z1.ngModeless && z1.ex > z1.ng);
  await wp.keyboard.press('Escape'); await wp.waitForTimeout(120);
  await wp.keyboard.press('Escape'); await wp.waitForTimeout(120);
  const z2 = await wp.evaluate(() => ({ ngShow: document.querySelector('#ngDlg').classList.contains('show'), exShow: document.querySelector('#exDlg').classList.contains('show') }));
  chk('window system: Escape unwinds dialogs newest-first to none', !z2.ngShow && !z2.exShow);
  const r3 = await wp.evaluate(async () => {
    const L = window._micro.layers()[0];
    window._micro.openGradeTonnage(L);
    await new Promise((z) => setTimeout(z, 300));
    const win = [...document.querySelectorAll('.fwin')].pop();
    const footBtns = [...win.querySelectorAll('.sw-foot .pp-exp button')].map((x) => x.textContent);
    const opaque = getComputedStyle(win).backgroundColor;
    const minB = win.querySelector('.fwin-head button');   // buttons are [minimize, close]
    minB.click();
    const chipCount = document.querySelectorAll('#winStrip .win-chip').length;
    const hidden = win.style.display === 'none';
    document.querySelector('#winStrip .win-chip').click();
    const restored = win.style.display !== 'none' && document.querySelectorAll('#winStrip .win-chip').length === 0;
    const topAccent = win.classList.contains('top');
    window._micro.closeAllWindows();
    return { footBtns, opaque, chipCount, hidden, restored, topAccent };
  });
  chk(`window system: the results row lives in the analysis foot [${r3.footBtns.join(' · ')}]`,
    r3.footBtns.some((x) => x.includes('layer')) && r3.footBtns.some((x) => x.includes('table')) && r3.footBtns.some((x) => x.includes('png')));
  chk(`window system: floats are opaque (${r3.opaque})`, r3.opaque === 'rgb(22, 22, 22)');
  chk(`window system: minimize → strip chip (${r3.chipCount}), chip restores + raises`, r3.chipCount === 1 && r3.hidden && r3.restored && r3.topAccent);

  // ── the solid RECIPE path: params → resolve by name → flag column lands ──
  const solidR = await wp.evaluate(async () => {
    // a closed OBJ box over the left half of the 20×10 block sheet
    const x0 = 611995, x1 = 612095, y0 = 7764995, y1 = 7765095, z0 = 350, z1 = 450;
    const V = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    const T = [[1, 3, 2], [1, 4, 3], [5, 6, 7], [5, 7, 8], [1, 2, 6], [1, 6, 5], [3, 4, 8], [3, 8, 7], [1, 5, 8], [1, 8, 4], [2, 3, 7], [2, 7, 6]];
    const obj = V.map((v) => `v ${v.join(' ')}`).join('\n') + '\n' + T.map((t) => `f ${t.join(' ')}`).join('\n');
    await window._micro.openBlob(new Blob([obj]), 'box.obj', 'add');
    await new Promise((z) => setTimeout(z, 800));
    const err = await window._micro.runSolidRecipe({ geometry: 'box.obj', do: 'flag', which: 'inside', column: 'INBOX', value: 'IN', targets: ['w.csv'] }).then(() => null, (e) => e.message);
    const L = window._micro.layers().find((x) => x.name === 'w.csv');
    const col = (L.paintCols || []).find((c) => c.name === 'INBOX');
    const hasCol = window._micro.layerHasColumn('INBOX', 'w.csv');
    // a bad recipe fails with a NAMED layer, before anything runs
    const bad = await window._micro.runSolidRecipe({ geometry: 'nope.obj', do: 'flag' }).then(() => null, (e) => e.message);
    return { err, hasCol, colKind: col && col.kind, bad };
  });
  chk(`solid recipe: params resolve by name and the flag column lands (INBOX, ${solidR.colKind})`, solidR.err === null && solidR.hasCol);
  chk(`solid recipe: a missing layer fails NAMED before running ("${solidR.bad}")`, /nope\.obj/.test(solidR.bad || ''));

  // ── join scope: "only the 3D selection" masks the source rows ──
  const joinSel = await wp.evaluate(async () => {
    const L = window._micro.layers().find((x) => x.name === 'w.csv');
    const T = window._micro.gridAxesOf(L);
    const n = 200;                                          // w.csv = 20×10 blocks, one bench
    const mask = new Uint8Array(n); for (let i = 0; i < n; i++) if (i % 20 < 10) mask[i] = 1;   // the left half
    L._selMask = mask; L._selCount = 100;
    const columns = () => [{ src: 'left', name: 'FE', out: 'FE', num: true, op: 'mean' }];
    const all = await window._micro.runSpatialJoin({ leftL: L, rightL: null, target: T, columns: columns(), coverage: false, label: 'j', asCells: true });
    const sel = await window._micro.runSpatialJoin({ leftL: L, rightL: null, target: T, columns: columns(), coverage: false, label: 'j', asCells: true, useSelection: true });
    L._selMask = null; L._selCount = 0;
    return { all: all.nPresent, sel: sel.nPresent };
  });
  chk(`join scope: selection masks the source (${joinSel.all} cells all → ${joinSel.sel} selected)`, joinSel.all === 200 && joinSel.sel === 100);

  // ── settings window: sectioned rail + the PREFS registry persists ──
  const setw = await wp.evaluate(() => {
    window._micro.openSettingsWindow();
    const win = [...document.querySelectorAll('.fwin')].pop();
    const railBtns = [...win.querySelectorAll('button')].filter((b2) => ['display', 'interaction', 'compute', 'data', 'experimental', 'housekeeping'].includes(b2.textContent));
    railBtns.find((b2) => b2.textContent === 'interaction').click();
    const sels = [...win.querySelectorAll('select')];
    const stickSel = sels.find((s2) => [...s2.options].some((o) => o.value === 'sticky'));
    stickSel.value = 'sticky'; stickSel.dispatchEvent(new Event('change'));
    const stored = localStorage.getItem('micro.selStick');
    stickSel.value = 'smart'; stickSel.dispatchEvent(new Event('change'));   // restore the default
    const descs = win.querySelectorAll('div').length;
    window._micro.closeAllWindows();
    return { title: win.querySelector('.fwin-head .t').textContent, sections: railBtns.length, stored, descs };
  });
  chk(`settings: ${setw.sections} sections on the rail, a choice persists (selStick → ${setw.stored})`,
    setw.title === 'settings' && setw.sections === 6 && setw.stored === 'sticky');

  // ── the g-leader: save a view slot, move, recall; a bare digit does nothing ──
  await wp.evaluate(() => document.body.focus());
  const cam0 = await wp.evaluate(() => JSON.stringify(window._micro.cam.state));
  await wp.keyboard.press('g'); await wp.waitForTimeout(80);
  await wp.keyboard.press('Shift+Digit3'); await wp.waitForTimeout(250);
  const slotSaved = await wp.evaluate(() => window._micro.views().some((v) => v.name === 'slot 3'));
  await wp.evaluate(() => { window._micro.cam.orbit(0.8, 0.3); window._micro.requestRender(); });
  await wp.waitForTimeout(120);
  await wp.keyboard.press('Digit3'); await wp.waitForTimeout(150);   // bare digit: must NOT recall
  const camAfterBare = await wp.evaluate(() => JSON.stringify(window._micro.cam.state));
  await wp.keyboard.press('g'); await wp.waitForTimeout(80);
  await wp.keyboard.press('Digit3'); await wp.waitForTimeout(300);
  const camRecalled = await wp.evaluate(() => JSON.stringify(window._micro.cam.state));
  chk('g-leader: Shift+digit saves a named slot, bare digit is inert, g+digit recalls',
    slotSaved && camAfterBare !== cam0 && camRecalled === cam0);
  await wp.close();
}

// ── §34: deferred re-shade — a cosmetic poke over a converged frame is ONE
//    fullscreen resolve pass (condenser gl-resolve.js, O(pixels) at any model
//    size), not a re-raster; a CULLING change (isolate filter) still re-rasters ──
{
  const rp = await mkPage('sm2resolve');
  const r = await rp.evaluate(async () => {
    const M = window._micro;
    let csv = 'X,Y,Z,FE\n';                                // small model: converges in a frame or two
    for (let k = 0; k < 2; k++) for (let j = 0; j < 20; j++) for (let i = 0; i < 20; i++)
      csv += `${i * 10},${j * 10},${k * 10 + 900},${(10 + i + k * 5).toFixed(1)}\n`;
    await M.openBlob(new Blob([csv]), 'shade.csv', 'replace');
    await new Promise((s) => setTimeout(s, 900));
    document.querySelector('#btnFit').click();
    await new Promise((s) => setTimeout(s, 1200));          // converge + go idle
    const L = M.layers()[0];
    const shot = () => document.querySelector('#cv').toDataURL().slice(1000, 3000);
    const rc0 = M.renderer.resolveCount;
    const before = shot();
    const px = new Uint8Array(256 * 4);                     // a hot ramp nothing defaults to
    for (let t = 0; t < 256; t++) { px[t * 4] = 255; px[t * 4 + 1] = t; px[t * 4 + 2] = 0; px[t * 4 + 3] = 255; }
    M.renderer.setLayerRamp(L.id, px); M.requestRender();
    await new Promise((s) => setTimeout(s, 400));
    const rc1 = M.renderer.resolveCount;
    const after = shot();
    const n = 800;                                          // culling change: must NOT resolve
    const mask = new Uint8Array(n); for (let q = 0; q < n; q++) mask[q] = q % 2;
    M.renderer.setFilter(mask, { isolate: true }, L.id); M.requestRender();
    await new Promise((s) => setTimeout(s, 400));
    const rc2 = M.renderer.resolveCount;
    M.renderer.setFilter(null, {}, L.id); M.requestRender();
    await new Promise((s) => setTimeout(s, 400));
    // THE DRILLHOLE SCENE (the regression Arthur hit): sticks layers coexist,
    // and a ramp poke on the BLOCKS layer must STILL resolve — per-layer dirt,
    // untouched sticks keep their pixels
    await M.importDrillholes(M.makeDemoDrillholes(), { radius: 6 }, 'add');
    await new Promise((s) => setTimeout(s, 1200));
    const hasSticks = M.layers().some((L2) => L2.dh);
    const rc3 = M.renderer.resolveCount;
    for (let t = 0; t < 256; t++) px[t * 4] = 0;            // a different ramp
    M.renderer.setLayerRamp(L.id, px); M.requestRender();
    await new Promise((s) => setTimeout(s, 400));
    const rc4 = M.renderer.resolveCount;
    return { rc0, rc1, rc2, rc3, rc4, hasSticks, changed: before !== after };
  });
  chk(`deferred re-shade: a ramp poke over the converged frame resolves (${r.rc0}→${r.rc1}) and repaints; isolate still re-rasters (rc stays ${r.rc2})`,
    r.rc1 > r.rc0 && r.rc2 === r.rc1 && r.changed);
  chk(`deferred re-shade with drillholes loaded: the block ramp poke still resolves (${r.rc3}→${r.rc4})`,
    r.hasSticks && r.rc4 > r.rc3);
  await rp.close();
}


// ── LOCATIONS: an element's record spaces, and the count that used to lie ──────
// attrRowCountOf fell through to renderer.layerElementCount, so a mesh reported
// its TRIANGLE count as though those were attribute rows. Every caller happened
// to guard with `kind !== 'mesh'` separately, so the wrong number was latent
// rather than visible — exactly the kind of thing that bites the first caller
// who forgets. These assert the count is honest and the record spaces are named.
{
  const rp = await mkPage('sm2loc');
  const r = await rp.evaluate(async () => {
    const M = window._micro;
    let t = 'XC,YC,ZC,FE\n';
    for (let k = 0; k < 2; k++) for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++)
      t += `${5 + i * 10},${5 + j * 10},${5 + k * 10},${40 + k}\n`;
    await M.openBlob(new Blob([t]), 'blocks.csv', 'replace');
    await new Promise((z) => setTimeout(z, 1200));
    // a quad -> 4 vertices, 2 faces: the two counts DIFFER, so a mix-up shows
    const obj = ['v 0 0 80', 'v 40 0 80', 'v 40 40 80', 'v 0 40 80', 'f 1 2 3', 'f 1 3 4'].join('\n') + '\n';
    await M.openBlob(new Blob([obj]), 'lid.obj', 'add');
    await new Promise((z) => setTimeout(z, 1500));
    const B = M.layers().find((L) => L.name === 'blocks.csv');
    const Me = M.layers().find((L) => L.kind === 'mesh');
    return {
      blockRows: M.attrRowCountOf(B), blockHas: M.hasRecords(B), blockLoc: M.primaryLocationOf(B),
      blockLocs: M.locationsOf(B).map((l) => [l.name, l.count, l.shape]),
      meshRows: M.attrRowCountOf(Me), meshHas: M.hasRecords(Me), meshLoc: M.primaryLocationOf(Me),
      meshLocs: M.locationsOf(Me).map((l) => [l.name, l.count]),
      meshLine: M.propKindLine(Me),
      meshTris: M.renderer.layerElementCount(Me.id),
      meshCols: (M.attrColumnsOf(Me) || []).map((c) => c.name),
      meshRow2: await M.fetchLayerRow(Me, 2),
    };
  });
  chk(`locations: a block model is one 'cells' location of ${r.blockRows} rows`,
    r.blockRows === 32 && r.blockHas === true && r.blockLoc === 'cells'
    && JSON.stringify(r.blockLocs) === JSON.stringify([['cells', 32, 'table']]));
  chk(`locations: a mesh reports its ${r.meshRows} VERTEX rows, not its ${r.meshTris} triangles`,
    r.meshRows === 4 && r.meshHas === true && r.meshTris === 2);
  chk(`locations: the vertex table's columns are the coordinates (${JSON.stringify(r.meshCols)})`,
    JSON.stringify(r.meshCols) === JSON.stringify(['X', 'Y', 'Z']));
  chk(`locations: a vertex row reads back its own coordinates (${JSON.stringify(r.meshRow2)})`,
    JSON.stringify(r.meshRow2) === JSON.stringify([40, 40, 80]));
  chk(`locations: the mesh names BOTH record spaces (${JSON.stringify(r.meshLocs)})`,
    r.meshLoc === 'vertices' && JSON.stringify(r.meshLocs) === JSON.stringify([['vertices', 4], ['faces', 2]]));
  chk(`locations: the properties line says so too - "${r.meshLine}"`,
    /4 vertices/.test(r.meshLine) && /2 faces/.test(r.meshLine));
  await rp.close();
}


// ── the mesh VERTEX location, end to end ──────────────────────────────────────
// A painted PLY carries its set colors as vertex properties. This walks the
// whole chain: condenser keeps them at read, meshDoc names them in its header,
// the vertex table lists them as columns, and a row reads its own values back.
// That chain is what a ply2atti import will ride on.
{
  const rp = await mkPage('sm2meshvtx');
  const r = await rp.evaluate(async () => {
    const M = window._micro;
    const ply = [
      'ply', 'format ascii 1.0', 'element vertex 4',
      'property float x', 'property float y', 'property float z',
      'property uchar red', 'property uchar green', 'property uchar blue',
      'element face 2', 'property list uchar int vertex_indices', 'end_header',
      '0 0 80 255 0 0', '40 0 80 255 0 0', '40 40 80 0 255 0', '0 40 80 0 255 0',
      '3 0 1 2', '3 0 2 3',
    ].join('\n') + '\n';
    await M.openBlob(new Blob([ply]), 'painted.ply', 'replace');
    await new Promise((z) => setTimeout(z, 1600));
    const L = M.layers().find((x) => x.kind === 'mesh');
    if (!L) return { err: 'no mesh layer' };
    const cols = (M.attrColumnsOf(L) || []).map((c) => c.name);
    const rows = [];
    for (let k = 0; k < 4; k++) rows.push(await M.fetchLayerRow(L, k));
    // the attribute table must now open on a mesh — it is a record-bearing layer
    M.openAttrTable(L);
    await new Promise((z) => setTimeout(z, 500));
    const opened = M.attrTables.has(L.id);
    // and the parse is shared: a solid query must not re-read the file
    const before = L.docs.meshDoc._vtxData;
    await M.meshSolidOf(L).catch(() => null);
    return { cols, rows, opened, shared: before === L.docs.meshDoc._vtxData && !!before, n: M.attrRowCountOf(L) };
  });
  chk(`mesh vertices: a painted PLY's colors ARE columns (${JSON.stringify(r.cols)})`,
    JSON.stringify(r.cols) === JSON.stringify(['X', 'Y', 'Z', 'red', 'green', 'blue']));
  chk(`mesh vertices: ${r.n} rows read back their own coordinates and colors`,
    r.n === 4
    && JSON.stringify(r.rows[0]) === JSON.stringify([0, 0, 80, 255, 0, 0])
    && JSON.stringify(r.rows[2]) === JSON.stringify([40, 40, 80, 0, 255, 0]));
  chk('mesh vertices: the attribute table opens on a mesh', r.opened === true);
  chk('mesh vertices: a solid query reuses the vertex parse rather than re-reading', r.shared === true);
  await rp.close();
}


// ═══ derived columns across a project round trip ═══════════════════════════════
// The subsystems that hold most of the column-storage call sites — calc columns,
// element persistence, styling restore, the paint column registry — had no
// durable coverage at all. These assert the BEHAVIOR rather than the storage
// shape ("a calc still resolves after a reload"), so they stay true through the
// (location, name) re-keying and are what will prove it correct.
{
  const pc = await mkPage('sm2cols');
  const before = await pc.evaluate(async () => {
    const M = window._micro;
    let t = 'XC,YC,ZC,FE\n';
    for (let k = 0; k < 2; k++) for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++)
      t += `${5 + i * 10},${5 + j * 10},${5 + k * 10},${10 + i}\n`;
    await M.openBlob(new Blob([t]), 'w.csv', 'replace');
    await new Promise((z) => setTimeout(z, 1400));
    // a box over part of the model → a real category (paint) column with lineage
    const V = [[0, 0, 0], [25, 0, 0], [25, 25, 0], [0, 25, 0], [0, 0, 25], [25, 0, 25], [25, 25, 25], [0, 25, 25]];
    const T = [[1, 2, 3], [1, 3, 4], [5, 7, 6], [5, 8, 7], [1, 5, 6], [1, 6, 2], [2, 6, 7], [2, 7, 3], [3, 7, 8], [3, 8, 4], [4, 8, 5], [4, 5, 1]];
    const obj = V.map((v) => `v ${v.join(' ')}`).join('\n') + '\n' + T.map((x) => `f ${x.join(' ')}`).join('\n');
    await M.openBlob(new Blob([obj]), 'box.obj', 'add');
    await new Promise((z) => setTimeout(z, 1400));
    await M.runSolidRecipe({ geometry: 'box.obj', do: 'flag', which: 'inside', column: 'INBOX', value: 'IN', targets: ['w.csv'] });
    await new Promise((z) => setTimeout(z, 800));

    const L = M.layers().find((x) => x.name === 'w.csv');
    // a calc, a calc ON that calc, and a calc referencing the PAINT column —
    // the three composition shapes the resolver core exists to support
    M.applyCalcCols(L, [
      { name: 'DBL', expr: 'FE * 2' },
      { name: 'QUAD', expr: 'DBL * 2' },
      { name: 'TAG', expr: 'if(INBOX == "IN", 1, 0)' },
    ]);
    await M.materializeCalcCol(L, 'DBL');                   // → a Parquet sidecar matcol
    await new Promise((z) => setTimeout(z, 800));
    M.setLayerColorSel(L, 'paint:INBOX');
    M.setRampCfg(L, { mode: 'fixed', lo: 1, hi: 9 });

    const qd = await M.realizeCalc(L, 'QUAD');
    const tg = await M.realizeCalc(L, 'TAG');
    const paint = M.paintColByName(L, 'INBOX');
    return {
      calc: (L.calcCols || []).map((c) => [c.name, c.expr]),
      census: M.schemaExt(L, L.docs.blockDoc.header).map((c) => c.name),
      quad: [...qd.slice(0, 5)],
      tagSum: [...tg].reduce((a, b) => a + b, 0),
      mat: (M.matColGet(L, 'DBL') || {}).name,
      matVals: [...(M.matColGet(L, 'DBL').fvalues || []).slice(0, 5)],
      paintDict: paint ? paint.dict.filter(Boolean) : null,
      paintNonBlank: paint ? [...paint.codes].filter((c) => c).length : 0,
      colorSel: L.colorSel,
      exportCols: (M.exportColumnsOf(L) || []).map((c) => (typeof c === 'string' ? c : c.name)),
    };
  });
  // materializing DBL moves it OUT of calcCols and into the sidecar, which is the
  // point of materializing — so QUAD is now a calc over a MATERIALIZED column, and
  // TAG a calc over a PAINT column. Both composition shapes, in one fixture.
  chk(`round trip: the fixture builds paint + calc-over-matcol + calc-over-paint (${before.calc.map((c) => c[0])})`,
    before.calc.length === 2 && before.mat === 'DBL' && before.paintNonBlank === 16
    && before.quad[0] === 40 && before.tagSum === 16);

  await saveProject(pc);
  await pc.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('sm2cols');
    await window._micro.openProjectDir(dir);
  });
  await pc.waitForFunction(() => window._micro.layers().some((L) => L.name === 'w.csv'), null, { timeout: 60000 });
  await new Promise((z) => setTimeout(z, 1500));

  const after = await pc.evaluate(async () => {
    const M = window._micro;
    const L = M.layers().find((x) => x.name === 'w.csv');
    const qd = await M.realizeCalc(L, 'QUAD');
    const tg = await M.realizeCalc(L, 'TAG');
    const paint = M.paintColByName(L, 'INBOX');
    const mc = M.matColGet(L, 'DBL');
    await M.ensureStoredValues(L, new Set(['dbl']));
    return {
      calc: (L.calcCols || []).map((c) => [c.name, c.expr]),
      census: M.schemaExt(L, L.docs.blockDoc.header).map((c) => c.name),
      quad: [...qd.slice(0, 5)],
      tagSum: [...tg].reduce((a, b) => a + b, 0),
      mat: (mc || {}).name,
      matVals: mc && mc.fvalues ? [...mc.fvalues.slice(0, 5)] : null,
      paintDict: paint ? paint.dict.filter(Boolean) : null,
      paintNonBlank: paint ? [...paint.codes].filter((c) => c).length : 0,
      colorSel: L.colorSel,
      exportCols: (M.exportColumnsOf(L) || []).map((c) => (typeof c === 'string' ? c : c.name)),
      row: M.extendRow(L, await M.fetchLayerRow(L, 0), 0),
    };
  });

  chk(`round trip: calc columns come back with their expressions (${JSON.stringify(after.calc)})`,
    JSON.stringify(after.calc) === JSON.stringify(before.calc));
  chk(`round trip: a calc ON a calc still resolves (QUAD ${after.quad.slice(0, 3)})`,
    JSON.stringify(after.quad) === JSON.stringify(before.quad));
  chk(`round trip: a calc referencing a PAINT column still resolves (sum ${after.tagSum})`,
    after.tagSum === before.tagSum && after.tagSum > 0);
  chk(`round trip: the materialized column keeps its values (${after.matVals && after.matVals.slice(0, 3)})`,
    after.mat === 'DBL' && JSON.stringify(after.matVals) === JSON.stringify(before.matVals));
  chk(`round trip: the paint column keeps its dictionary and codes (${after.paintDict}, ${after.paintNonBlank})`,
    JSON.stringify(after.paintDict) === JSON.stringify(before.paintDict)
    && after.paintNonBlank === before.paintNonBlank);
  // this one FAILED when written: the manifest emitted every materialized column
  // and then every category column, so (INBOX, DBL) came back as (DBL, INBOX) and
  // the census shifted under every positional consumer after a reload
  chk(`round trip: the census order is stable (${JSON.stringify(after.census)})`,
    JSON.stringify(after.census) === JSON.stringify(before.census));
  chk(`round trip: the EXPORT column list is stable too (${after.exportCols.length} columns)`,
    JSON.stringify(after.exportCols) === JSON.stringify(before.exportCols) && after.exportCols.length > 0);
  chk(`round trip: styling restores (color by ${after.colorSel})`,
    after.colorSel === before.colorSel && before.colorSel === 'paint:INBOX');
  chk('round trip: a full extended row reads back every census slot',
    Array.isArray(after.row) && after.row.length === after.census.length);
  await pc.close();
}


// ── a .dm auto-optimized to Parquet, then re-channelled ───────────────────────
// Reported from real use: open a .dm, save, auto-optimize converts it to Parquet
// and the layer reports ZERO blocks; after a reload, changing the display column
// empties it again. One root cause behind both — the channel-switch dispatch was
// `.dm ? openDmBlob : openBlocksBlob`, written before Parquet existed, so a
// Parquet layer was handed to the DELIMITED reader, which sniffed its bytes as
// text, found no rows, and replaced a good document with an empty one. The layer
// kept its count and its columns and drew nothing, which is why it read as data
// loss. Auto-optimize was only ever tested over CSV, and the .dm section turns it
// off, so the combination was uncovered.
{
  const pd = await mkPage('sm2dmpq');
  await pd.evaluate(async () => {
    const { makeDM } = await import('/test/dm-make.mjs');
    const fields = [
      { name: 'XC', type: 'N' }, { name: 'YC', type: 'N' }, { name: 'ZC', type: 'N' },
      { name: 'XINC', type: 'N', constant: 10 }, { name: 'YINC', type: 'N', constant: 10 }, { name: 'ZINC', type: 'N', constant: 5 },
      { name: 'XMORIG', type: 'N', constant: 1000 }, { name: 'YMORIG', type: 'N', constant: 2000 }, { name: 'ZMORIG', type: 'N', constant: 400 },
      { name: 'NX', type: 'N', constant: 8 }, { name: 'NY', type: 'N', constant: 6 }, { name: 'NZ', type: 'N', constant: 4 },
      { name: 'FE', type: 'N' }, { name: 'AU', type: 'N' }, { name: 'LITO', type: 'A', width: 8 },
    ];
    const rows = [];
    for (let k = 0; k < 4; k++) for (let j = 0; j < 6; j++) for (let i = 0; i < 8; i++)
      rows.push({ XC: 1005 + i * 10, YC: 2005 + j * 10, ZC: 402.5 + k * 5,
        FE: 20 + i, AU: 0.5 + k, LITO: (i + j) % 2 ? 'BIF' : 'CANGA' });
    await window._micro.openBlob(new Blob([makeDM(fields, rows, { precision: 'ep' })]), 'bm.dm', 'replace');
  });
  await pd.waitForFunction(() => { const L = window._micro.layers()[0]; return L && window._micro.renderer.layerElementCount(L.id) === 192; }, null, { timeout: 60000 });

  // convert exactly as an auto-optimizing save does
  await pd.evaluate(() => window._micro.convertLayerToParquet(window._micro.layers()[0], { keepOriginal: true }));
  await pd.waitForFunction(() => /\d+ blocks|blocks ·/.test(document.querySelector('#meta').textContent), null, { timeout: 60000 });
  await new Promise((z) => setTimeout(z, 1200));
  const conv = await pd.evaluate(() => {
    const M = window._micro, L = M.layers()[0];
    return { name: L.name, rows: M.attrRowCountOf(L), drawn: M.renderer.layerElementCount(L.id), pq: !!L.docs.blockDoc.parquet };
  });
  chk(`dm→parquet: the converted model still DRAWS (${conv.drawn} of ${conv.rows}, “${conv.name}”, parquet-backed ${conv.pq})`,
    conv.rows === 192 && conv.drawn === 192 && conv.pq === true);

  // and switching the display column must not empty it — the same handler, and
  // the second half of the report. Drive the real select, not the setter.
  const swapped = await pd.evaluate(async () => {
    const M = window._micro, L = M.layers()[0];
    M.setActiveLayer(L.id);
    const sel = document.querySelector('#colorBy');
    const opt = [...sel.options].map((o) => o.value).filter((v) => v.startsWith('chan:'));
    const cur = sel.value;
    const next = opt.find((v) => v !== cur) || opt[0];
    sel.value = next; sel.dispatchEvent(new Event('change'));
    await new Promise((z) => setTimeout(z, 2000));
    return { next, drawn: M.renderer.layerElementCount(L.id), rows: M.attrRowCountOf(L), chans: opt.length };
  });
  chk(`dm→parquet: switching the display column keeps the blocks (${swapped.drawn} drawn, by ${swapped.next})`,
    swapped.drawn === 192 && swapped.rows === 192);

  // volume selection reads records through a COLD position stream, and its
  // dispatch had no Parquet branch either — a Parquet blockDoc fell to the
  // delimited reader and the box selected nothing at all. Same for painting.
  const vol = await pd.evaluate(async () => {
    const M = window._micro, L = M.layers()[0];
    M.setActiveLayer(L.id);
    M.clearSelection({ silent: true });
    document.querySelector('#btnFit').click();
    await new Promise((z) => setTimeout(z, 600));
    // a screen rectangle over the whole viewport: "through" selection projects
    // every record, so a working Parquet stream selects them all and a broken
    // one selects none — the difference the missing branch made
    const c = document.querySelector('canvas');
    const w = c.clientWidth, h = c.clientHeight;
    await M.selectVolume([[2, 2], [w - 2, 2], [w - 2, h - 2], [2, h - 2]], 'replace', true);
    await new Promise((z) => setTimeout(z, 1500));
    return { sel: L._selCount || 0, rows: M.attrRowCountOf(L) };
  }).catch((e) => ({ err: String(e).slice(0, 120) }));
  chk(`dm→parquet: volume selection reaches a Parquet model (${vol.sel} of ${vol.rows} selected)`,
    !vol.err && vol.sel === 192);

  // the capability record itself. Four consumers (export, spatial join, rules,
  // column scan) decide whether to re-drop invalid-coordinate rows from this ONE
  // predicate, so testing it once tests all four. Delimited renumbers what
  // survives its load; .dm keeps true row numbers and Parquet emits every row.
  const caps = await pd.evaluate(async () => {
    const M = window._micro;
    const pq = M.blockCaps(M.layers()[0]);                 // the converted Parquet model
    let t = 'XC,YC,ZC,FE' + String.fromCharCode(10);
    for (let i = 0; i < 8; i++) t += `${i * 10},0,0,${i}` + String.fromCharCode(10);
    await M.openBlob(new Blob([t]), 'plain.csv', 'add');
    await new Promise((z) => setTimeout(z, 1200));
    const csv = M.blockCaps(M.layers().find((L) => L.name === 'plain.csv'));
    return { pq, csv };
  });
  chk(`capabilities: Parquet is row-is-record with stats + projection (${JSON.stringify(caps.pq)})`,
    caps.pq.rowIsRecord === true && caps.pq.stats === true && caps.pq.projection === true);
  chk(`capabilities: a delimited model renumbers, and offers neither (${JSON.stringify(caps.csv)})`,
    caps.csv.rowIsRecord === false && caps.csv.stats === false && caps.csv.projection === false);
  await pd.close();
}


// ── a materialized column must survive the Morton reorder ─────────────────────
// "Store as Parquet" spatially re-sorts every base column and permutes each paint
// column's `codes`. It did NOT permute `fvalues` — the full-precision backing that
// IS the truth for a materialized column, read positionally by export, filter and
// grade-tonnage. So the colour stayed right while the numbers shuffled, and
// persistElement baked the misordering into the sidecar. This pins a value to a
// coordinate and checks they are still together afterwards.
{
  const pm = await mkPage('sm2matorder');
  const r = await pm.evaluate(async () => {
    const M = window._micro;
    // FE is a pure function of X, so every block's value is predictable from
    // its own coordinates — misalignment cannot hide behind a plausible number
    let t = 'XC,YC,ZC,FE' + String.fromCharCode(10);
    for (let k = 0; k < 3; k++) for (let j = 0; j < 4; j++) for (let i = 0; i < 6; i++)
      t += `${5 + i * 10},${5 + j * 10},${5 + k * 10},${i * 100}` + String.fromCharCode(10);
    await M.openBlob(new Blob([t]), 'ord.csv', 'replace');
    await new Promise((z) => setTimeout(z, 1400));
    const L = M.layers()[0];
    // a materialized column carrying that same predictable value
    M.applyCalcCols(L, [{ name: 'EST', expr: 'FE * 2' }]);
    await M.materializeCalcCol(L, 'EST');
    await new Promise((z) => setTimeout(z, 900));

    const check = async (tag) => {
      const mc = M.matColGet(L, 'EST');
      const nrec = M.attrRowCountOf(L);
      let bad = 0, sample = null;
      for (let rec = 0; rec < nrec; rec++) {
        const row = await M.fetchLayerRow(L, rec);
        const want = (+row[0] - 5) / 10 * 200;              // EST = FE*2 = ((X-5)/10)*100*2
        const got = mc.fvalues[rec];
        if (Math.abs(got - want) > 1e-6) { bad++; if (!sample) sample = { tag, rec, x: +row[0], want, got }; }
      }
      return { bad, nrec, sample };
    };

    const before = await check('before');
    await M.convertLayerToParquet(L, { keepOriginal: true });
    await new Promise((z) => setTimeout(z, 1600));
    const after = await check('after');
    return { before, after, name: M.layers()[0].name };
  });
  chk(`materialize order: the column is aligned before the reorder (${r.before.bad} mismatches of ${r.before.nrec})`,
    r.before.bad === 0 && r.before.nrec === 72);
  chk(`materialize order: it is STILL aligned after Store-as-Parquet (${r.after.bad} mismatches of ${r.after.nrec}${r.after.sample ? ', e.g. x=' + r.after.sample.x + ' want ' + r.after.sample.want + ' got ' + r.after.sample.got : ''})`,
    r.after.bad === 0 && r.after.nrec === 72);
  await pm.close();
}


// ── record numbering across a row the loader threw away ──────────────────────
// A delimited source drops rows with unparseable coordinates at load, so the
// renderer never numbers them. Six sweeps re-derived that rule independently and
// computeGT/computeSwath got it wrong — they counted every row, then used the
// count to index the selection mask and the materialized columns, so after the
// first bad row every block read another block's selection and another block's
// grade. layerRecords owns the rule now; this pins it.
{
  const pn = await mkPage('sm2recnum');
  const r = await pn.evaluate(async () => {
    const M = window._micro;
    const NL = String.fromCharCode(10);
    // FE is a pure function of X, and row 3 has an unparseable X
    let t = 'XC,YC,ZC,FE' + NL;
    for (let i = 0; i < 8; i++) t += (i === 3 ? 'n/a' : String(5 + i * 10)) + ',5,5,' + (i * 100) + NL;
    await M.openBlob(new Blob([t]), 'gap.csv', 'replace');
    await new Promise((z) => setTimeout(z, 1400));
    const L = M.layers()[0];
    const n = M.attrRowCountOf(L);
    const seen = [];
    for await (const { f, rec } of M.layerRecords(L)) seen.push({ rec, x: +f[0], fe: +f[3] });
    // and the independent ladder must agree record-for-record
    const viaFetch = [];
    for (let k = 0; k < n; k++) { const row = await M.fetchLayerRow(L, k); viaFetch.push(+row[0]); }
    return { n, seen, viaFetch, caps: M.blockCaps(L) };
  });
  chk(`record numbering: the bad row is not a record (${r.n} of 8 rows, delimited ${!r.caps.rowIsRecord})`,
    r.n === 7 && r.caps.rowIsRecord === false);
  chk('record numbering: layerRecords numbers 0..n-1 with no gap',
    r.seen.length === 7 && r.seen.every((e, i) => e.rec === i));
  chk(`record numbering: it agrees with fetchLayerRow record-for-record (${JSON.stringify(r.seen.map((e) => e.x))})`,
    JSON.stringify(r.seen.map((e) => e.x)) === JSON.stringify(r.viaFetch));
  chk('record numbering: every record still carries its OWN grade (FE = (X-5)/10*100)',
    r.seen.every((e) => Math.abs(e.fe - (e.x - 5) / 10 * 100) < 1e-6));
  await pn.close();
}


// ── the pick ray is correct under vertical exaggeration ──────────────────────
// pixelRay unprojects through inverse(viewProj), which INCLUDES zExag. Round-trip
// a point OFF the z-scale centre: the camera target is the fixed point of the
// z-scale, so a point offset from it in z is where the old geometric ray (which
// ignored zExag) drifted. Project the point through the full viewProj to a pixel,
// then pixelRay at that pixel must return a ray through it — in viewProj's own
// coordinate space, so no frame bookkeeping (a probe confirmed target round-trips
// to ~1e-3 at every exaggeration).
{
  const pz = await mkPage('sm2zexag');
  const r = await pz.evaluate(async () => {
    const M = window._micro;
    let t = 'XC,YC,ZC,FE' + String.fromCharCode(10);
    for (let k = 0; k < 5; k++) for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++)
      t += `${i * 10},${j * 10},${k * 10},${k}` + String.fromCharCode(10);
    await M.openBlob(new Blob([t]), 'z.csv', 'replace');
    await new Promise((z) => setTimeout(z, 1200));
    document.querySelector('#btnFit').click();
    await new Promise((z) => setTimeout(z, 400));
    const cv = document.querySelector('canvas'), rect = cv.getBoundingClientRect();
    const missOffCentre = () => {
      const st = M.cam.state, vp = st.viewProj;
      const Q = [st.target[0] + 6, st.target[1] - 4, st.target[2] + 15];   // off the z-scale centre
      const cw = vp[3] * Q[0] + vp[7] * Q[1] + vp[11] * Q[2] + vp[15];
      const nx = (vp[0] * Q[0] + vp[4] * Q[1] + vp[8] * Q[2] + vp[12]) / cw;
      const ny = (vp[1] * Q[0] + vp[5] * Q[1] + vp[9] * Q[2] + vp[13]) / cw;
      const px = (nx + 1) * 0.5 * rect.width, py = (1 - ny) * 0.5 * rect.height;
      const ray = M.pixelRay(px, py), o = ray.o, d = ray.d;
      const w = [Q[0] - o[0], Q[1] - o[1], Q[2] - o[2]];
      const tp = w[0] * d[0] + w[1] * d[1] + w[2] * d[2];
      return Math.hypot(w[0] - tp * d[0], w[1] - tp * d[1], w[2] - tp * d[2]);
    };
    const out = {};
    for (const ex of [1, 3, 8]) { M.setZExag(ex); M.requestRender(); await new Promise((z) => setTimeout(z, 250)); out['m' + ex] = missOffCentre(); }
    M.setZExag(1);
    return out;
  });
  const near = (v) => v < 0.1;                             // 0.1 world units; the old bug drifts by the z-scale (whole units, growing)
  chk(`zExag pick: an off-centre point round-trips at ×1 (${r.m1.toExponential(1)})`, near(r.m1));
  chk(`zExag pick: STILL round-trips at ×3 and ×8 — the ray follows the exaggeration, not drifts (${r.m3.toExponential(1)}, ${r.m8.toExponential(1)})`,
    near(r.m3) && near(r.m8));
  await pz.close();
}

console.log(ok ? '\nMICRO SMOKE 2: PASS' : '\nMICRO SMOKE 2: FAIL');
await b.close(); server.close();
process.exit(ok ? 0 : 1);
