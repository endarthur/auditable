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

console.log(ok ? '\nMICRO SMOKE 2: PASS' : '\nMICRO SMOKE 2: FAIL');
await b.close(); server.close();
process.exit(ok ? 0 : 1);
