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

// ═══ 12. scatter → grid interpolation core (NN · IDW · anisotropy) — a unit test
//     of interpolateLattice on synthetic points, convention-free where it matters ═══
{
  const pi = await mkPage('sm2interp');
  // samples carrying a pure x-ramp field (v = x) → IDW at query points must reproduce it
  const lin = await pi.evaluate(async () => {
    const px = [], py = [], pz = [], pv = [];
    for (let x = 0; x <= 100; x += 20) for (let y = 0; y <= 100; y += 20) { px.push(x); py.push(y); pz.push(0); pv.push(x); }
    const pts = { px: Float64Array.from(px), py: Float64Array.from(py), pz: Float64Array.from(pz), pv: Float64Array.from(pv) };
    const idw = await window._micro.estimateAtPoints({ pts, qx: Float64Array.from([10, 50, 90]), qy: Float64Array.from([50, 50, 50]), qz: null, method: 'idw', power: 2, ranges: [40, 40, 40], orient: {}, minPts: 1, maxPts: 24 });
    const nn = await window._micro.estimateAtPoints({ pts, qx: Float64Array.from([40]), qy: Float64Array.from([60]), qz: null, method: 'nn', ranges: [40, 40, 40], orient: {}, minPts: 1, maxPts: 24 });
    return { x10: idw[0], x50: idw[1], x90: idw[2], nn40: nn[0], sampleVals: [...new Set(pv)] };
  });
  chk(`IDW reproduces a linear field (x=10→${lin.x10.toFixed(1)}, x=50→${lin.x50.toFixed(1)}, x=90→${lin.x90.toFixed(1)})`,
    Math.abs(lin.x10 - 10) < 4 && Math.abs(lin.x50 - 50) < 2 && Math.abs(lin.x90 - 90) < 4);
  chk(`NN returns the nearest sample's exact value ((40,60) → ${lin.nn40})`, lin.nn40 === 40 && lin.sampleVals.includes(lin.nn40));
  // anisotropy steers the neighbourhood: query at origin, B(0,50)=100 due N, C(50,0)=20 due E.
  // a long/thin ellipse (major 60, minor 12) major→N includes only B; major→E only C.
  const aniso = await pi.evaluate(async () => {
    const pts = { px: Float64Array.from([0, 50]), py: Float64Array.from([50, 0]), pz: Float64Array.from([0, 0]), pv: Float64Array.from([100, 20]) };
    const qx = Float64Array.from([0]), qy = Float64Array.from([0]);
    const run = (orient, ranges) => window._micro.estimateAtPoints({ pts, qx, qy, qz: null, method: 'idw', power: 2, ranges, orient, minPts: 1, maxPts: 8 });
    const towardB = (await run({ dipAzimuth: 90 }, [60, 12, 12]))[0];   // major N–S → reaches B only
    const towardC = (await run({ dipAzimuth: 0 }, [60, 12, 12]))[0];    // major E–W → reaches C only
    const iso = (await run({}, [60, 60, 60]))[0];
    return { towardB, towardC, iso };
  });
  chk(`anisotropy steers the neighbourhood (major→B ${aniso.towardB.toFixed(1)}, major→C ${aniso.towardC.toFixed(1)}, iso ${aniso.iso.toFixed(1)})`,
    Math.abs(aniso.towardB - 100) < 1 && Math.abs(aniso.towardC - 20) < 1 && Math.abs(aniso.iso - 60) < 1);
  // output filter: blank result cells whose (X,Y,Z,value) fails the predicate (per record)
  const outf = await pi.evaluate(() => {
    const vals = new Float32Array([10, 20, 30, 40]);
    window._micro.applyOutputFilterPoints(vals, Float64Array.from([0, 10, 0, 10]), Float64Array.from([0, 0, 10, 10]), null, 'VAL', 'VAL > 25');
    return [...vals].map((v) => (Number.isNaN(v) ? 'x' : v));
  });
  chk(`output filter blanks cells failing the predicate (VAL>25 → ${JSON.stringify(outf)})`, outf[0] === 'x' && outf[1] === 'x' && outf[2] === 30 && outf[3] === 40);
  await pi.close();
}

// ═══ 13. INTERPOLATE ONTO A TARGET: source samples → an existing block model →
//     a materialized column ON the target (decoupled from grid creation) ═══
{
  const pg = await mkPage('sm2interp2');
  const src = await pg.evaluate(() => {
    let s = 'X,Y,Z,GRADE\n';                                            // off-lattice jitter → opens as POINTS; GRADE = x
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) { const x = i * 20 + ((i * 3 + j * 7) % 5 - 2) * 1.5, y = j * 20 + ((i * 5 + j * 2) % 5 - 2) * 1.5; s += `${x.toFixed(2)},${y.toFixed(2)},0,${x.toFixed(2)}\n`; }
    return s;
  });
  await pg.evaluate((c) => window._micro.openBlob(new Blob([c]), 'samples.csv', 'replace'), src);
  await pg.waitForFunction(() => window._micro.layers().length === 1, null, { timeout: 30000 });
  const tgt = await pg.evaluate(() => { let s = 'X,Y,Z,DUMMY\n'; for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) s += `${i * 10},${j * 10},0,0\n`; return s; });   // a REGULAR 11×11 block model target
  await pg.evaluate((c) => window._micro.openBlob(new Blob([c]), 'model.csv', 'add'), tgt);
  await pg.waitForFunction(() => window._micro.layers().some((L) => L.name === 'model.csv' && L.docs.blockDoc), null, { timeout: 30000 });
  // the readers: source samples + the TARGET's own record coordinates
  const rd = await pg.evaluate(async () => {
    const S = window._micro.layers().find((x) => x.name === 'samples.csv'), T = window._micro.layers().find((x) => x.name === 'model.csv');
    const pts = await window._micro.readLayerPoints(S, 'GRADE'); const tq = await window._micro.readLayerCoords(T);
    return { sn: pts.px.length, srcX: Math.abs(pts.pv[0] - pts.px[0]) < 0.01, tn: tq.n };
  });
  chk(`readers: ${rd.sn} source samples (GRADE==X) + ${rd.tn} target records`, rd.sn === 36 && rd.srcX && rd.tn === 121);
  // the standalone dialog shows Source + onto-target + method + range + output column
  const ui = await pg.evaluate(() => {
    window._micro.openInterpolateDialog(); const txt = document.querySelector('#ngDlgBody').textContent;
    return { shown: document.querySelector('#ngDlg').classList.contains('show'), src: /source/.test(txt), onto: /onto/.test(txt), method: /IDW/.test(txt) && /nearest/.test(txt), range: /range \(m\)/.test(txt), col: /column/.test(txt) };
  });
  chk(`interpolate dialog: source + onto + method + range + column`, ui.shown && ui.src && ui.onto && ui.method && ui.range && ui.col);
  await pg.evaluate(() => document.querySelector('#ngCancel').click());
  // estimate GRADE onto the model → a materialized column ON the target (the recipe-run path)
  const out = await pg.evaluate(async () => {
    const cfg = { srcName: 'samples.csv', srcCol: 'GRADE', tgtName: 'model.csv', method: 'idw', power: 2, aniso: false, rMaj: 60, rSemi: 60, rMin: 60, dip: 0, dipAz: 0, pitch: 0, minPts: 1, maxPts: 12, inFilter: '', outFilter: '', outName: 'GRADE_IDW' };
    await window._micro.estimateOntoTarget(cfg, () => {});
    const T = window._micro.layers().find((x) => x.name === 'model.csv');
    const col = window._micro.matColList(T).find((c) => c.name === 'GRADE_IDW');
    const inOpts = [...document.querySelectorAll('#colorBy option')].some((o) => o.value === 'paint:GRADE_IDW');
    const lin = col && col.lineage;                                    // the estimate's provenance rides on the COLUMN, not the target layer
    return { has: !!col, mat: !!(col && col.mat), at50: col ? col.fvalues[5 * 11 + 5] : null, op: lin && lin.op, target: lin && lin.params.target, column: lin && lin.params.column, colorSel: T.colorSel, inOpts };
  });
  chk(`estimate lands a materialized column ON the target (mat ${out.mat}, block(50,50)≈${(out.at50 || 0).toFixed(1)}, coloured ${out.colorSel})`,
    out.has && out.mat && Math.abs(out.at50 - 50) < 6 && out.op === 'interpolate' && out.target === 'model.csv' && out.column === 'GRADE_IDW' && out.colorSel === 'paint:GRADE_IDW' && out.inOpts);
  // GT + swath now SEE the materialized column (schemaExt + extendRow); numericColsOf offers it
  const gtsw = await pg.evaluate(async () => {
    const T = window._micro.layers().find((x) => x.name === 'model.csv');
    const offered = window._micro.numericColsOf(T).includes('GRADE_IDW');
    const gt = await window._micro.computeGT(T, ['GRADE_IDW'], null, 8, () => {});
    const sw = await window._micro.computeSwath(T, ['GRADE_IDW'], [1, 0, 0], 12, 0, null, () => {});
    const means = sw ? sw.profile.map((b) => b.mean[0]).filter(Number.isFinite) : [];
    return { offered, gtCuts: gt ? gt.gt[0].length : 0, gtMax: gt ? gt.gmax : 0, swBands: sw ? sw.profile.length : 0, rising: means.length > 2 && means[means.length - 1] > means[0] };
  });
  chk(`GT + swath compute on the materialized column (numericColsOf offers it ${gtsw.offered}; GT ${gtsw.gtCuts} cuts, gmax ${(gtsw.gtMax || 0).toFixed(0)}; swath ${gtsw.swBands} bands, rising ${gtsw.rising})`,
    gtsw.offered && gtsw.gtCuts === 9 && gtsw.gtMax > 50 && gtsw.swBands > 2 && gtsw.rising);
  // THE COMPOSITION GAP (resolver): a calc column referencing the ESTIMATED column,
  // then materialized — the exact case that failed pre-resolver (calc saw base only)
  const matc = await pg.evaluate(async () => {
    const T = window._micro.layers().find((x) => x.name === 'model.csv');
    window._micro.applyCalcCols(T, [{ name: 'DBL', expr: 'GRADE_IDW * 2', ty: 'number' }]);
    const wasCalc = (T.calcCols || []).some((c) => c.name === 'DBL');
    await window._micro.materializeCalcCol(T, 'DBL');
    const col = window._micro.matColList(T).find((c) => c.name === 'DBL');
    return { wasCalc, mat: !!(col && col.mat), stillCalc: (T.calcCols || []).some((c) => c.name === 'DBL'), at50: col ? col.fvalues[5 * 11 + 5] : null, from: col && col.lineage && col.lineage.params.from };
  });
  chk(`calc REFERENCES the estimated column + materializes (DBL = GRADE_IDW*2 → (50,50)≈${(matc.at50 || 0).toFixed(0)})`,
    matc.wasCalc && matc.mat && !matc.stillCalc && Math.abs(matc.at50 - 100) < 12 && matc.from === 'calc');
  // calc-on-calc, dependency-ordered regardless of input order (B2 defined referencing A2)
  const chain = await pg.evaluate(async () => {
    const T = window._micro.layers().find((x) => x.name === 'model.csv');
    window._micro.applyCalcCols(T, [{ name: 'B2', expr: 'A2 * 10', ty: 'number' }, { name: 'A2', expr: 'GRADE_IDW + 1', ty: 'number' }]);
    window._micro.setActiveLayer(T.id);
    document.querySelector('#filter').value = 'B2 > 500'; await window._micro.applyBlockFilter('B2 > 500');
    const hits = T._filterMask ? T._filterMask.reduce((a, b) => a + b, 0) : -1;
    await window._micro.applyBlockFilter('');
    return { hits };
  });
  chk(`calc-on-calc chains through the resolver, out of input order (B2=A2*10, A2=GRADE_IDW+1; B2>500 → ${chain.hits} blocks)`, chain.hits > 50 && chain.hits < 80);
  // input + output filters compose: drop low samples, blank low results → some blocks unestimated
  const flt = await pg.evaluate(async () => {
    const cfg = { srcName: 'samples.csv', srcCol: 'GRADE', tgtName: 'model.csv', method: 'idw', power: 2, aniso: false, rMaj: 80, rSemi: 80, rMin: 80, dip: 0, dipAz: 0, pitch: 0, minPts: 1, maxPts: 12, inFilter: 'GRADE > 20', outFilter: 'GRADE_F > 40', outName: 'GRADE_F' };
    await window._micro.estimateOntoTarget(cfg, () => {});
    const T = window._micro.layers().find((x) => x.name === 'model.csv'); const col = window._micro.matColList(T).find((c) => c.name === 'GRADE_F');
    let valid = 0, blank = 0; for (const v of col.fvalues) (Number.isFinite(v) ? valid++ : blank++);
    return { inF: col.lineage.params.inFilter, outF: col.lineage.params.outFilter, valid, blank, min: col.min };
  });
  chk(`filters compose on the target (in "${flt.inF}", out "${flt.outF}"; ${flt.valid} valid · ${flt.blank} blank, min ${(flt.min || 0).toFixed(1)})`,
    flt.inF === 'GRADE > 20' && flt.outF === 'GRADE_F > 40' && flt.valid > 0 && flt.blank > 0 && flt.min > 40);
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
  await pr.close();
}

console.log(ok ? '\nMICRO SMOKE 2: PASS' : '\nMICRO SMOKE 2: FAIL');
await b.close(); server.close();
process.exit(ok ? 0 : 1);
