// Drives micro through a synthetic deposit with Playwright and captures the
// screenshots for the docs page. Harness-generated so they can't rot: re-run
// after a UI change → fresh images.  node tools/micro/docs/shots.mjs
import { chromium } from 'playwright';
import http from 'http';
import { readFile, mkdir } from 'fs/promises';
import { extname, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'shots');
await mkdir(OUT, { recursive: true });

// ── a small synthetic iron-ore deposit: a NE-plunging high-grade shoot, three
// lithologies by depth, a +6%-biased "new estimate", and clustered drillholes ──
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function genDeposit() {
  const r = rng(7);
  const nx = 40, ny = 40, nz = 8, px = 10, x0 = 5, y0 = 5, z0 = 5;
  const cx = 22 * px, cy = 16 * px;                          // shoot centre (plan)
  const gradeAt = (x, y, z) => {
    const dz = (7 - (z - z0) / px);                          // shoot rises to surface
    const d2 = ((x - cx - dz * 8) ** 2 + (y - cy - dz * 6) ** 2) / 9000 + (dz * dz) / 40;
    return Math.max(8, 32 + 34 * Math.exp(-d2));
  };
  const lith = (z) => { const k = (z - z0) / px; return k < 2 ? 'CANGA' : k < 5 ? 'HEMATITE' : 'ITABIRITE'; };
  let A = 'XC,YC,ZC,FE,LITO\n', B = 'XC,YC,ZC,FE\n';
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = x0 + i * px, y = y0 + j * px, z = z0 + k * px, g = gradeAt(x, y, z);
    A += `${x},${y},${z},${(g + (r() - 0.5) * 3).toFixed(2)},${lith(z)}\n`;
    const bias = ((x - 200) / 200) * 10 + ((y - 200) / 200) * 7;   // strong diagonal conditional bias: NE over-estimates, SW under
    B += `${x},${y},${z},${Math.max(2, g + bias + (r() - 0.5) * 1.5).toFixed(2)}\n`;
  }
  // drillholes: a 60 m grid, DENSER (30 m infill) over the shoot → clustering
  const holes = [];
  for (let x = 20; x <= 380; x += 60) for (let y = 20; y <= 380; y += 60) holes.push([x, y]);
  for (let x = 190; x <= 310; x += 30) for (let y = 130; y <= 250; y += 30) holes.push([x, y]);
  let collar = 'BHID,X,Y,Z\n', survey = 'BHID,AT,AZ,DIP\n', assay = 'BHID,FROM,TO,FE\n', id = 1;
  for (const [x, y] of holes) {
    const h = 'DH' + String(id++).padStart(3, '0');
    collar += `${h},${x},${y},85\n`; survey += `${h},0,0,-90\n`;
    for (let d = 0; d < 80; d += 5) { const z = 85 - d - 2.5; if (z < z0 - 5) break; const g = gradeAt(x, y, z) + (r() - 0.5) * 6; assay += `${h},${d},${d + 5},${Math.max(2, g).toFixed(2)}\n`; }
  }
  return { A, B, collar, survey, assay };
}
const D = genDeposit();

// an octree sub-blocked model: 20 m parents, refined to 10 m then 5 m where the
// high-grade shoot passes through → variable-size boxes (the sub-block feature)
function genSubblocks() {
  const r = rng(11);
  const P = 20, nx = 12, ny = 12, nz = 4, o = 10;
  const cx = 6 * P, cy = 5 * P;
  const gradeAt = (x, y, z) => {
    const dz = (nz * P - z) / P;
    const d2 = ((x - cx - dz * 12) ** 2 + (y - cy - dz * 9) ** 2) / 4200;
    return Math.max(4, 12 + 52 * Math.exp(-d2));             // ~12 in the margins → ~64 in the core
  };
  let csv = 'X,Y,Z,dX,dY,dZ,FE\n';
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const px = o + i * P, py = o + j * P, pz = o + k * P, g = gradeAt(px, py, pz);
    const s = g > 46 ? 5 : g > 24 ? 10 : 20;                  // octree refine toward the shoot: 20 → 10 → 5 m
    const n = P / s, cnr = [px - P / 2, py - P / 2, pz - P / 2];
    for (let c = 0; c < n; c++) for (let b = 0; b < n; b++) for (let a = 0; a < n; a++) {
      const x = cnr[0] + (a + 0.5) * s, y = cnr[1] + (b + 0.5) * s, z = cnr[2] + (c + 0.5) * s;
      csv += `${x},${y},${z},${s},${s},${s},${(gradeAt(x, y, z) + (r() - 0.5) * 2).toFixed(2)}\n`;
    }
  }
  return csv;
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  try { const path = decodeURIComponent(new URL(req.url, 'http://x').pathname); const data = await readFile('.' + path); res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' }); res.end(data); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

const b = await chromium.launch({ args: ['--use-gl=angle'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.5 });
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
p.setDefaultTimeout(30000);
await p.goto(`http://127.0.0.1:${PORT}/tools/micro/index.html`, { waitUntil: 'load' });
await p.waitForFunction(() => window._micro, { timeout: 15000 });

const settle = (ms = 1400) => p.waitForTimeout(ms);
// WebGL screenshots can race the swap (no preserveDrawingBuffer → a capture
// between presents reads back a CLEARED canvas; this blanked overview.png once,
// silently, on the deployed docs). So VERIFY the CAPTURED PNG itself — decode
// it back in the page, count lit pixels in the viewport region — and retry.
const pngLit = async (name) => {
  const b64 = (await readFile(join(OUT, name + '.png'))).toString('base64');
  return p.evaluate(async (data) => {
    const img = new Image();                                 // fetch() is CSP-blocked in Sealed micro; img-src allows data:
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + data; });
    const c = document.createElement('canvas'); c.width = 320; c.height = 200;
    const g = c.getContext('2d');
    // sample the central viewport area (skips the toolbar + layers panel)
    g.drawImage(img, img.width * 0.3, img.height * 0.2, img.width * 0.65, img.height * 0.65, 0, 0, 320, 200);
    const d = g.getImageData(0, 0, 320, 200).data;
    let lit = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) lit++;
    return lit;
  }, b64);
};
const shot = async (name, opts = {}) => {
  await settle(opts.wait || 1200);
  for (let attempt = 0; ; attempt++) {
    await p.evaluate(() => new Promise((res) => { window._micro.requestRender(); requestAnimationFrame(() => requestAnimationFrame(res)); }));
    await (opts.el ? p.locator(opts.el) : p).screenshot({ path: join(OUT, name + '.png') });
    if (opts.blankOk) break;                                 // shots without 3D content
    const lit = await pngLit(name);
    if (lit > 200) break;                                    // the scene made it into the FILE
    if (attempt >= 3) { console.log(`shot: ${name} — STILL DARK after ${attempt + 1} tries (${lit} lit px)`); process.exitCode = 1; break; }
    console.log(`shot: ${name} — dark capture (${lit} lit px), retrying…`);
    await settle(1500);
  }
  console.log('shot:', name);
};
const layerReady = (nm) => p.waitForFunction((n) => { const L = window._micro.layers().find((x) => x.name === n); return L && window._micro.renderer.layerElementCount(L.id) > 0; }, nm, { timeout: 60000 });
const openModel = (csv, name, mode = 'replace') => p.evaluate(([c, n, m]) => window._micro.openBlob(new Blob([c]), n, m), [csv, name, mode]);

// 0a ── the demo project scene (the guided tour's opening view)
await p.evaluate(() => window._micro.openDemoProject());
await p.waitForFunction(() => window._micro.layers().length >= 6 && window._micro.layers().some((L) => L.dh && L.docs.dhDoc), null, { timeout: 90000 });
await p.evaluate(() => { const w = [...document.querySelectorAll('.fwin')].pop(); if (w) w.querySelector('.fwin-head button:last-child').click(); });
await shot('demoscene', { wait: 2600 });

// 0b ── the hole filter: a collars predicate thins the set (sticks + intervals)
await p.evaluate(async () => {
  const dh = window._micro.layers().find((L) => L.dh && L.docs.dhDoc);
  window._micro.setActiveLayer(dh.id);
  await window._micro.applyHoleFilter(dh, 'COMPANY = "MERIDIAN"');
  const nd = window._micro.layerTree().find((x) => typeof x !== 'number' && x.dhSet);
  if (nd) await window._micro.showHoleTraces(nd);         // traces desurvey the MATCHING holes only
});
await shot('holefilter', { wait: 2000 });

// 0c ── terrain + phases as relief surfaces over the opened pit
await p.evaluate(async () => {
  const dh = window._micro.layers().find((L) => L.dh && L.docs.dhDoc);
  await window._micro.applyHoleFilter(dh, '');
  { const nd = window._micro.layerTree().find((x) => typeof x !== 'number' && x.dhSet); const tr = window._micro.layers().find((L) => L.trace); if (nd && tr) await window._micro.showHoleTraces(nd); }   // toggle traces OFF for the surfaces shot
  for (const L of window._micro.layers()) {
    if (/phase/.test(L.label || L.name)) { L.visible = true; }
  }
  window._micro.applyTreeVisibility();
  window._micro.requestRender();
});
await shot('surfaces', { wait: 2000 });
// 0 ── sub-blocked model: octree boxes at their true sizes, coloured by grade
await openModel(genSubblocks(), 'subblocks.csv', 'replace');
await layerReady('subblocks.csv');
await p.evaluate(() => { const cb = document.querySelector('#colorBy'); const o = [...cb.options].find((x) => /FE/.test(x.textContent) && x.value.startsWith('chan:')); if (o) { cb.value = o.value; cb.dispatchEvent(new Event('change')); } window._micro.cam.fit(window._micro.docBbox()); window._micro.requestRender(); });
await shot('subblocks', { wait: 2200 });

// 1 ── overview: the reference model, coloured by grade
await openModel(D.A, 'model_A.csv', 'replace');
await layerReady('model_A.csv');
await p.evaluate(() => { const cb = document.querySelector('#colorBy'); const o = [...cb.options].find((x) => /FE/.test(x.textContent) && x.value.startsWith('chan:')); if (o) { cb.value = o.value; cb.dispatchEvent(new Event('change')); } window._micro.cam.fit(window._micro.docBbox()); window._micro.requestRender(); });
await shot('overview', { wait: 2200 });

// 1b ── the filter drawer: the expression as live widgets (ops, pills, brackets, remove)
await p.evaluate(async () => {
  const e = 'FE > 40 and (LITO = "HEMATITE" or LITO = "CANGA")';
  document.querySelector('#filter').value = e; await window._micro.applyBlockFilter(e);
  window._micro.toggleFilterDrawer(true);
});
await shot('filterdrawer', { wait: 1200 });
await p.evaluate(async () => { window._micro.toggleFilterDrawer(false); await window._micro.applyBlockFilter(''); });

// 1c ── the ƒ Calculations window: an if() ladder as a case table
await p.evaluate(() => {
  const L = window._micro.layers().find((x) => x.name === 'model_A.csv');
  L.calcCols = [{ name: 'DENSITY', expr: 'if(LITO = "HEMATITE", 3.9, if(LITO = "ITABIRITE", 3.4, 2.8))', ty: 'number' }];
  window._micro.openCalcWindow(L, 0);
});
await shot('calcwindow', { wait: 1200 });
await p.evaluate(() => { window._micro.closeAllWindows(); const L = window._micro.layers().find((x) => x.name === 'model_A.csv'); L.calcCols = []; L._calcFns = null; });

// 2 ── command palette
await p.evaluate(() => { window._micro.openPalette(); const i = document.querySelector('#palInput'); i.value = 'reconcile'; i.dispatchEvent(new Event('input')); });
await shot('palette', { wait: 600 });
await p.evaluate(() => window._micro.closePalette());

// 3 ── grade–tonnage window (the swath-chassis rail: series · unit · density expr · Run)
await p.evaluate(() => window._micro.openGradeTonnage(window._micro.layers()[0]));
await p.evaluate(() => {
  const w = [...document.querySelectorAll('.fwin')].find((e) => /grade-tonnage/.test(e.querySelector('.t').textContent));
  const pu = w.querySelector('.sw-unit-plot'); pu.value = 'pct'; pu.dispatchEvent(new Event('change'));
  w.querySelector('.sw-run').click();
});
await p.waitForFunction(() => { const w = [...document.querySelectorAll('.fwin')].find((e) => /grade-tonnage/.test(e.querySelector('.t').textContent)); return w && w._gtSpec && w._gtSpec.series.length; }, { timeout: 30000 });
await shot('gradetonnage', { wait: 1600 });
await p.evaluate(() => window._micro.closeAllWindows());

// 4 ── swath: Run, zebra bands on the 3D
await p.evaluate(() => window._micro.openSwath(window._micro.layers()[0]));
await p.evaluate(() => { const w = [...document.querySelectorAll('.fwin')].find((e) => /swath/.test(e.querySelector('.t').textContent)); w.querySelector('.sw-run').click(); });
await p.waitForFunction(() => { const w = [...document.querySelectorAll('.fwin')].find((e) => /swath/.test(e.querySelector('.t').textContent)); return w && w._swathSpec && w._swathSpec.series.length; }, { timeout: 30000 });
await p.evaluate(() => { const w = [...document.querySelectorAll('.fwin')].find((e) => /swath/.test(e.querySelector('.t').textContent)); const zc = [...w.querySelectorAll('input[type=checkbox]')].find((c) => /zebra/.test((c.nextElementSibling || c.parentElement).textContent)); if (zc && !zc.checked) zc.click(); });
await shot('swath', { wait: 1800 });

// 4b ── the band ghost: hover the swath plot → that band's slab lights on the 3D
await p.evaluate(() => { const w = [...document.querySelectorAll('.fwin')].find((e) => /swath/.test(e.querySelector('.t').textContent)); const zc = [...w.querySelectorAll('input[type=checkbox]')].find((c) => /zebra/.test((c.nextElementSibling || c.parentElement).textContent)); if (zc && zc.checked) zc.click(); });
await p.evaluate(() => {
  const w = [...document.querySelectorAll('.fwin')].find((e) => /swath/.test(e.querySelector('.t').textContent));
  const cv2 = w.querySelector('.sw-main canvas'), r = cv2.getBoundingClientRect();
  cv2.dispatchEvent(new MouseEvent('mousemove', { clientX: r.left + r.width * 0.58, clientY: r.top + r.height * 0.5, bubbles: true }));
});
await shot('bandghost', { wait: 1000 });
await p.evaluate(() => window._micro.closeAllWindows());
await p.evaluate(() => window._micro.setSwathBand(null));

// 4c ── a TRUE section: a thin N–S slab seen obliquely — blocks cut analytically,
// the cut wall continuous and coloured (not a ragged centroid cull)
await p.evaluate(() => {
  const cb = document.querySelector('#colorBy'); const o = [...cb.options].find((x) => /FE/.test(x.textContent) && x.value.startsWith('chan:'));   // zebra teardown reset the colour
  if (o) { cb.value = o.value; cb.dispatchEvent(new Event('change')); }
  const set = (id, v) => { const e = document.querySelector('#' + id); e.value = v; e.dispatchEvent(new Event('input')); };
  set('secMode', 'ns'); set('secHalf', '12'); set('secPos', '0.45');
  window._micro.cam.fit(window._micro.docBbox());
  window._micro.requestRender();
});
await shot('truesection', { wait: 2600 });
await p.evaluate(() => { const e = document.querySelector('#secMode'); e.value = 'off'; e.dispatchEvent(new Event('input')); window._micro.cam.fit(window._micro.docBbox()); window._micro.requestRender(); });

// 5 ── figure decorations (scale bar / north / legend / title) on a print background
await p.evaluate(() => { const m = window._micro; m.setBg('#ffffff'); for (const k of ['scale', 'north', 'legend']) m.setDeco(k, true); m.setDecoTitle('Deposit — FE (%)'); m.drawDecorations(); });
await shot('figure', { wait: 1600 });
await p.evaluate(() => { const m = window._micro; for (const k of ['scale', 'north', 'legend', 'title']) m.setDeco(k, false); m.setBg('#121212'); });

// 6 ── reconcile: load the new estimate, drive the join tab → Δ map
await openModel(D.B, 'model_B.csv', 'add');
await layerReady('model_B.csv');
await p.evaluate(() => { const m = window._micro, B = m.layers().find((L) => L.name === 'model_B.csv'), A = m.layers().find((L) => L.name === 'model_A.csv'); m.setActiveLayer(B.id); m.openProps(); });
await p.evaluate(() => { const t = [...document.querySelectorAll('#ppTabs .pp-tab')].find((b) => b.textContent === 'join'); if (t) t.click(); });
await p.evaluate(() => { const sel = document.querySelector('#ppBody select'); const A = window._micro.layers().find((L) => L.name === 'model_A.csv'); sel.value = String(A.id); sel.dispatchEvent(new Event('change')); });
await p.waitForFunction(() => [...document.querySelectorAll('#ppBody button')].some((b) => /Reconcile/.test(b.textContent)), { timeout: 8000 });
await p.evaluate(() => [...document.querySelectorAll('#ppBody button')].find((b) => /Reconcile/.test(b.textContent)).click());
await p.waitForFunction(() => [...document.querySelectorAll('.menu .item')].some((i) => /Δ on FE/.test(i.textContent)), { timeout: 5000 });
await p.evaluate(() => [...document.querySelectorAll('.menu .item')].find((i) => /Δ on FE/.test(i.textContent)).click());
await p.waitForFunction(() => /reconcile /.test(document.querySelector('#meta').textContent), { timeout: 30000 });
await p.evaluate(() => { const m = window._micro; for (const L of m.layers()) if (L.name === 'model_A.csv' || L.name === 'model_B.csv') { L.visible = false; m.renderer.setLayerVisible(L.id, false); } m.applyTreeVisibility(); const J = m.layers().find((L) => /reconcile/.test(L.name)); m.setActiveLayer(J.id); m.cam.fit(m.docBbox()); });
await p.keyboard.press('d');   // plan view — the NE→SW Δ gradient reads across the deposit
await p.evaluate(() => { const set = (id, v) => { const e = document.querySelector('#' + id); e.value = v; e.dispatchEvent(new Event('input')); }; set('clipMin', '-8'); set('clipMax', '8'); });   // tighten the clip past the corner outliers so the conditional bias reads
await p.evaluate(() => { const pp = document.querySelector('#propPanel'); if (pp) pp.classList.remove('show'); window._micro.requestRender(); });
await shot('reconcile', { wait: 2600 });

// 7 ── validation vs drillholes
await p.evaluate(([c, s, a]) => window._micro.importDrillholes({ collar: new File([c], 'collar.csv'), survey: new File([s], 'survey.csv'), intervals: new File([a], 'assay.csv') }, {}, 'add'), [D.collar, D.survey, D.assay]);
await p.waitForFunction(() => window._micro.layers().some((L) => L.dh), { timeout: 30000 });
// 7b ── the drillhole SET in the layers panel: group + collar/survey rows
await shot('dhset', { el: '#layersPanel', wait: 800, blankOk: true });
await p.evaluate(() => { const A = window._micro.layers().find((L) => L.name === 'model_A.csv'); window._micro.setActiveLayer(A.id); window._micro.openValidation(A); });
await shot('validation', { wait: 2200 });

// 8 ── lineage inspector
await p.evaluate(() => window._micro.closeAllWindows());
await p.evaluate(() => { const J = window._micro.layers().find((L) => /reconcile/.test(L.name)); window._micro.openLineageWindow(J); });
await shot('lineage', { wait: 1200 });

// 9 ── Sealed badge popover
await p.evaluate(() => window._micro.closeAllWindows());
await p.evaluate(() => window._micro.sealedInfo());
await shot('sealed', { wait: 700 });

// 10 ── the routine editor: for-each table filled, Preview listing the run
await p.keyboard.press('Escape');                            // dismiss the Sealed popover
await p.evaluate(() => { document.querySelectorAll('.menu, .popover, #sealPop').forEach((x) => x.remove()); window._micro.closeAllWindows(); });
await p.evaluate(() => {
  const rl = window._micro._recipesList();
  if (!rl.some((x) => x.name === 'refresh calc columns')) rl.push(
    { name: 'refresh calc columns', tool: 'calccols', file: 'recipes/rc.yaml', params: { layer: 'model_A.csv', cols: [{ name: 'FE_EQ', expr: 'FE' }] } },
    { name: 'drift check', tool: 'swath', file: 'recipes/dc.yaml', params: { layer: 'model_A.csv', series: [{ layer: 'model_A.csv', col: 'FE' }] } },
  );
  window._micro.openRoutineWindow(null);
  const el = document.querySelector('.fwin[data-routine]');
  el.style.left = '120px'; el.style.top = '60px'; el.style.width = '620px'; el.style.height = '640px';
  el.querySelector('input[placeholder="month-end"]').value = 'month-end';
  el.querySelector('#rwGuard').checked = true; el.querySelector('#rwGuard').dispatchEvent(new Event('change'));
  const bars = [...el.querySelectorAll('.rw-bar')];
  bars.find((x) => /reports/.test(x.textContent)).querySelectorAll('input')[1].value = 'm-';
  const s1 = el.querySelector('.rw-step select');
  s1.value = 'refresh calc columns'; s1.dispatchEvent(new Event('change'));
  [...el.querySelectorAll('button')].find((x) => x.textContent === '+ for-each block').click();
});
await p.evaluate(() => {
  const el = document.querySelector('.fwin[data-routine]');
  const th = el.querySelector('.rw-grid th input');
  th.value = 'grade'; th.dispatchEvent(new Event('change'));
});
await p.evaluate(() => {
  const el = document.querySelector('.fwin[data-routine]');
  const c1 = el.querySelector('.rw-grid td input');
  c1.value = 'FE'; c1.dispatchEvent(new Event('change'));
  [...el.querySelectorAll('button')].find((x) => x.textContent === '+ row').click();
});
await p.evaluate(() => {
  const el = document.querySelector('.fwin[data-routine]');
  const rows = [...el.querySelectorAll('.rw-grid tr')];
  const c2 = rows[2].querySelector('td input');
  c2.value = 'SIO2'; c2.dispatchEvent(new Event('change'));
  const box = [...el.querySelectorAll('.rw-step')].find((x) => x.querySelector('.rw-grid'));
  const inner = box.querySelectorAll('select')[1];
  inner.value = 'drift check'; inner.dispatchEvent(new Event('change'));
  [...box.querySelectorAll('button')].find((x) => x.textContent === '⋯').click();
  const ta = box.querySelector('.rw-ovr');
  ta.value = 'series:\n  - layer: "model_A.csv"\n    col: "$grade"';
  ta.style.height = '60px';
  ta.dispatchEvent(new Event('change'));
  [...el.querySelectorAll('button')].find((x) => x.textContent === 'Preview').click();
});
await shot('routineeditor', { el: '.fwin[data-routine]', wait: 900 });

// 11 ── the generated inputs dialog (ask-me-first recipes)
await p.evaluate(() => {
  document.querySelectorAll('.fwin').forEach((w) => w.remove());
  const rl = window._micro._recipesList();
  rl.push({ name: 'GT — any model', tool: 'gt', file: 'recipes/gt-any.yaml',
    inputs: [
      { name: 'model', label: 'Block model', type: 'layer' },
      { name: 'grade', label: 'Grade column', type: 'column', of: 'model' },
      { name: 'ncut', label: 'How many cutoffs', type: 'number', default: 15 },
    ],
    params: { nCut: '$ncut', series: [{ layer: '$model', col: '$grade' }] } });
  window._micro.runRecipe(rl.find((x) => x.name === 'GT — any model'), true);
  const el = document.querySelector('.fwin[data-inputs-dialog]');
  el.style.left = '340px'; el.style.top = '180px'; el.style.width = '420px';
  const gradeSel = [...el.querySelectorAll('.rw-bar')][1].querySelector('select');
  gradeSel.value = 'FE';
});
await shot('inputsdialog', { el: '.fwin[data-inputs-dialog]', wait: 700 });
await p.evaluate(() => { document.querySelectorAll('.fwin').forEach((w) => w.remove()); });

// 12 ── the routine run tracker mid-run (staged through the real component)
await p.evaluate(() => {
  document.querySelectorAll('.fwin').forEach((w) => w.remove());
  const steps = [
    { guard: 'no-overwrites' },
    { recipe: 'refresh calc columns', _slug: 'refresh-calc-columns' },
    { recipe: 'drift check', _slug: 'drift-check-fe' },
    { recipe: 'drift check', _slug: 'drift-check-sio2' },
    { recipe: 'drift check', _slug: 'drift-check-al2o3' },
  ];
  const t = window._micro.openRoutineTracker('month-end', steps, { output: { prefix: 'm-' } });
  t.el.style.left = '260px'; t.el.style.top = '120px';
  t.state(0, 'ok'); t.state(1, 'ok'); t.state(2, 'ok'); t.state(3, 'run');
});
await shot('routinetracker', { el: '.fwin[data-routine-run]', wait: 700 });
await p.evaluate(() => { document.querySelectorAll('.fwin').forEach((w) => w.remove()); });

console.log('done →', OUT);
await b.close(); server.close();
