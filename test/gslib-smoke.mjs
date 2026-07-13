// gslib.wasm — the committed app smoke (like micro-smoke / lamina-smoke; not in `npm test`).
// Default target is the BUILT gslib.html (run `node build.js --target=gslib` first);
// pass `dev` to drive tools/gslib/index.html instead.
//   node test/gslib-smoke.mjs [dev]
// Pipeline: boot → sample → declus → gamv → model overlay → OK/SK krige → GeoEAS import.
import { chromium } from 'playwright';
import http from 'http'; import { readFile } from 'fs/promises'; import { extname } from 'path';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };
const srv = http.createServer(async (rq, rs) => { try { const p = decodeURIComponent(new URL(rq.url, 'http://x').pathname);
  rs.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' }); rs.end(await readFile('.' + p)); } catch { rs.writeHead(404); rs.end(); } });
await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const PORT = srv.address().port;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ', m); } else { fail++; console.log('  FAIL', m); } };
const b = await chromium.launch();
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 140)); });
await p.goto(`http://127.0.0.1:${PORT}/${process.argv[2] === 'dev' ? 'tools/gslib/index.html' : 'gslib.html'}`);
await p.waitForFunction(() => window._gslib, null, { timeout: 15000 }).catch(() => {});
ok(await p.evaluate(() => !!window._gslib), 'the app boots (wasm instantiated in the page)');

console.log('\n1. sample data → stats + histogram + location map');
const d1 = await p.evaluate(() => {
  window._gslib.sampleData();
  return { rows: window._gslib.S.rows.length, canvases: document.querySelectorAll('#dataPlots canvas').length,
           variance: window._gslib.S.variance };
});
// one dock plot (the histogram) — the sample LOCATIONS live in the 3D viewer now
ok(d1.rows === 210 && d1.canvases >= 1, `${d1.rows} samples, ${d1.canvases} dock plot, variance ${d1.variance && d1.variance.toFixed(3)}`);
const v1 = await p.evaluate(() => window._gslib.viewerInfo());
ok(v1.chunks >= 1, `the samples are in the viewer (${v1.chunks} chunk)`);

console.log('\n2. declus — the clustered mean must drop toward the truth');
const d2 = await p.evaluate(() => {
  window._gslib.runDeclus();
  const naive = window._gslib.S.rows.reduce((a, r) => a + r[2], 0) / window._gslib.S.rows.length;
  return { naive, dec: window._gslib.S.declusMean, msg: document.querySelector('#dcMsg').textContent,
           plot: document.querySelectorAll('#dcPlots canvas').length };
});
console.log(`    naive ${d2.naive.toFixed(4)} → declustered ${d2.dec && d2.dec.toFixed(4)}`);
ok(d2.dec != null && d2.dec < d2.naive, 'declustered mean < naive mean (clusters sit on highs — this is the whole point)');
ok(d2.plot >= 1, 'the cell-size sweep plotted');

console.log('\n3. gamv — experimental variogram rises from nugget toward the sill');
const d3 = await p.evaluate(() => {
  window._gslib.runVario();
  const { r, lags } = window._gslib.S.vario;
  const nlp2 = lags.n + 2;
  const pts = [];
  for (let k = 0; k < nlp2; k++) if (r.npairs[k] > 0 && r.distance[k] > 0) pts.push([r.distance[k], r.value[k]]);
  return { pts, canvases: document.querySelectorAll('#vgPlots canvas').length };
});
console.log(`    ${d3.pts.length} lags: γ(${d3.pts[0][0].toFixed(1)})=${d3.pts[0][1].toFixed(3)} … γ(${d3.pts.at(-1)[0].toFixed(1)})=${d3.pts.at(-1)[1].toFixed(3)}`);
ok(d3.pts.length >= 6, `${d3.pts.length} populated lags`);
ok(d3.pts[0][1] < d3.pts.at(-1)[1], 'γ rises with distance (spatial correlation exists)');
ok(d3.canvases >= 1, 'variogram plotted with the model overlay');

console.log('\n4. krige — OK on a 50×50 grid');
await p.evaluate(() => window._gslib.runKrige());
await p.waitForTimeout(600);                                  // a rAF or two — let the viewer paint
const d4 = await p.evaluate(() => {
  const K = window._gslib.S.krige;
  if (!K) return null;
  let informed = 0, sum = 0, mn = Infinity, mx = -Infinity, negVar = 0;
  for (let i = 0; i < K.est.length; i++) {
    if (K.est[i] > -1e20) { informed++; sum += K.est[i]; if (K.est[i] < mn) mn = K.est[i]; if (K.est[i] > mx) mx = K.est[i]; }
    if (K.var[i] > -1e20 && K.var[i] < -1e-6) negVar++;
  }
  const vi = window._gslib.viewerInfo();
  // the viewer canvas is preserveDrawingBuffer — read a band of pixels to prove
  // the block model actually PAINTED, not merely uploaded
  const cv = document.querySelector('#cv'); const g2 = cv.getContext('webgl2');
  const px = new Uint8Array(4 * 64);
  g2.readPixels((cv.width / 2) | 0, (cv.height / 2) | 0, 64, 1, g2.RGBA, g2.UNSIGNED_BYTE, px);
  let lit = 0; for (let i = 0; i < 64; i++) if (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2] > 60) lit++;
  return { n: K.est.length, informed, mean: sum / informed, mn, mx, negVar,
           msg: document.querySelector('#kMsg').textContent, chunks: vi.chunks, lit };
});
console.log(`    ${d4 && d4.msg}`);
ok(d4 && d4.informed > d4.n * 0.8, `${d4.informed}/${d4.n} blocks estimated`);
ok(d4 && d4.mn > 0 && d4.mx < 20, `estimates within data range (${d4.mn.toFixed(2)}…${d4.mx.toFixed(2)})`);
ok(d4 && d4.negVar === 0, 'no negative kriging variances');
ok(d4 && d4.chunks >= 2 && d4.lit > 16, `the kriged model is IN THE VIEWER and painted (${d4.chunks} chunks, ${d4.lit}/64 centre px lit)`);

console.log('\n5. SK vs OK differ; the model export round-trips');
const d5 = await p.evaluate(() => {
  const okMean = window._gslib.S.krige.est.filter((x) => x > -1e20).reduce((a, b) => a + b, 0);
  document.querySelector('#kType').value = 'SK';
  document.querySelector('#kType').dispatchEvent(new Event('change'));
  document.querySelector('#kMean').value = window._gslib.S.declusMean;
  window._gslib.runKrige();
  const skMean = window._gslib.S.krige.est.filter((x) => x > -1e20).reduce((a, b) => a + b, 0);
  return { differ: Math.abs(okMean - skMean) > 1e-9, model: window._gslib.modelSpec() };
});
ok(d5.differ, 'SK (with the declustered mean) differs from OK');
ok(d5.model.structures.length >= 1 && d5.model.structures[0].contribution > 0, `model spec exports (${d5.model.structures.length} structure)`);

console.log('\n6. GeoEAS import');
const d6 = await p.evaluate(() => {
  const dat = 'toy data\n3\nXloc\nYloc\nGrade\n' +
    Array.from({ length: 30 }, (_, i) => `${(i % 6) * 10} ${Math.floor(i / 6) * 10} ${(1 + (i % 7) * 0.3).toFixed(2)}`).join('\n') + '\n';
  window._gslib.openText('toy.dat', dat);
  return { rows: window._gslib.S.rows.length, cols: window._gslib.S.cols.join(',') };
});
ok(d6.rows === 30 && d6.cols === 'Xloc,Yloc,Grade', `GeoEAS parsed: ${d6.rows} rows, cols [${d6.cols}]`);

// ── the 3D arc: drillholes → 3D variography → kt3d → section → sgsim ──
console.log('\n8. sample DRILLHOLES: 3 CSVs → sniff → desurvey → 3D composites');
const e1 = await p.evaluate(async () => {
  window._gslib.sampleDrillholes();
  await new Promise((r) => setTimeout(r, 1500));
  const S = window._gslib.S;
  const zs = S.rows.map((r) => r[S.map.z]);
  return { rows: S.rows.length, cols: S.cols.join(','), is3d: S.map.z >= 0,
           zSpan: Math.max(...zs) - Math.min(...zs), drop: document.querySelector('#drop').textContent };
});
console.log(`    ${e1.drop}`);
ok(e1.rows === 480 && e1.is3d, `${e1.rows} composites, 3D mapped (cols ${e1.cols})`);
ok(e1.zSpan > 50, `real vertical extent (${e1.zSpan.toFixed(0)} m of hole)`);

console.log('\n9. 3D variography: a horizontal AND a vertical direction differ');
const e2 = await p.evaluate(() => {
  window._gslib.addDir(0, 22.5, 0, 22.5);                   // horizontal N–S
  window._gslib.addDir(0, 90, -90, 22.5);                   // straight DOWN the holes
  window._gslib.runVario();
  const { r, lags } = window._gslib.S.vario;
  const nlp2 = lags.n + 2;
  const dirGamma = (id) => { const g = []; for (let k = 0; k < nlp2; k++) if (r.npairs[id * nlp2 + k] > 0 && r.distance[id * nlp2 + k] > 0) g.push(r.value[id * nlp2 + k]); return g; };
  return { omni: dirGamma(0).length, horiz: dirGamma(1).length, vert: dirGamma(2).length,
           canvases: document.querySelectorAll('#vgPlots canvas').length };
});
ok(e2.vert >= 5 && e2.horiz >= 3, `populated lags — omni ${e2.omni}, horizontal ${e2.horiz}, downhole ${e2.vert}`);
ok(e2.canvases === 3, `${e2.canvases} direction plots (each with its model curve)`);

console.log('\n10. kt3d on a REAL 3D grid');
const e3 = await p.evaluate(async () => {
  document.querySelector('#kNx').value = 24; document.querySelector('#kNy').value = 24; document.querySelector('#kNz').value = 16;
  const e = (id) => document.querySelector(id);
  e('#kSx').value = 2; e('#kSy').value = 2; e('#kSz').value = 3.6;
  window._gslib.runKrige();
  await new Promise((r) => setTimeout(r, 800));
  const K = window._gslib.S.krige;
  let inf = 0, mn = Infinity, mx = -Infinity;
  for (const v of K.est) if (v > -1e20) { inf++; if (v < mn) mn = v; if (v > mx) mx = v; }
  return { nz: K.grid.nz, n: K.est.length, inf, mn, mx, msg: document.querySelector('#kMsg').textContent };
});
console.log(`    ${e3.msg}`);
ok(e3.nz === 16 && e3.n === 24 * 24 * 16, `a true 3D grid (${e3.n.toLocaleString()} blocks, nz=${e3.nz})`);
ok(e3.inf > e3.n * 0.5 && e3.mn > 0 && e3.mx < 10, `${e3.inf.toLocaleString()} estimated, range ${e3.mn.toFixed(2)}…${e3.mx.toFixed(2)}`);

console.log('\n11. a SECTION through the 3D model');
const e4 = await p.evaluate(async () => {
  const cv = document.querySelector('#cv'), g2 = cv.getContext('webgl2');
  const count = () => { const px = new Uint8Array(4 * 400);
    g2.readPixels((cv.width / 2 - 200) | 0, (cv.height / 2) | 0, 400, 1, g2.RGBA, g2.UNSIGNED_BYTE, px);
    let lit = 0; for (let i = 0; i < 400; i++) if (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2] > 60) lit++; return lit; };
  await new Promise((r) => setTimeout(r, 500));
  const before = count();
  const sec = document.querySelector('#vSec'); sec.value = 'Y'; sec.dispatchEvent(new Event('change'));
  document.querySelector('#vSecPos').value = 0.5; document.querySelector('#vSecPos').dispatchEvent(new Event('input'));
  await new Promise((r) => setTimeout(r, 600));
  const during = count();
  sec.value = 'off'; sec.dispatchEvent(new Event('change'));
  await new Promise((r) => setTimeout(r, 400));
  return { before, during };
});
ok(e4.before > 100 && e4.during < e4.before, `the slab hides blocks (${e4.before} lit → ${e4.during} in section)`);

console.log('\n12. simulation: nscore → sgsim → backtr');
const e5 = await p.evaluate(async () => {
  window._gslib.runSim();
  await new Promise((r) => setTimeout(r, 1200));
  const R = window._gslib.S.realization;
  if (!R) return { msg: document.querySelector('#sgMsg').textContent };
  const vals = window._gslib.S.rows.map((r) => r[window._gslib.S.map.v]);
  const dmin = Math.min(...vals), dmax = Math.max(...vals);
  let fin = 0, inRange = 0, mn = Infinity, mx = -Infinity;
  for (const v of R.real) if (Number.isFinite(v) && v > -1e20) { fin++; if (v >= dmin - 1e-9 && v <= dmax + 1e-9) inRange++; if (v < mn) mn = v; if (v > mx) mx = v; }
  // a second seed must give a DIFFERENT realization
  document.querySelector('#sgReal').value = 2;
  window._gslib.runSim();
  await new Promise((r) => setTimeout(r, 900));
  const R2 = window._gslib.S.realization;
  let diff = 0; for (let i = 0; i < R.real.length; i++) if (Math.abs(R.real[i] - R2.real[i]) > 1e-9) diff++;
  return { n: R.real.length, fin, inRange, mn, mx, diff, msg: document.querySelector('#sgMsg').textContent };
});
console.log(`    ${e5.msg}`);
ok(e5.fin > e5.n * 0.9, `${e5.fin}/${e5.n} nodes simulated`);
ok(e5.inRange > e5.fin * 0.99, `back-transform honours the data range (${e5.mn && e5.mn.toFixed(2)}…${e5.mx && e5.mx.toFixed(2)})`);
ok(e5.diff > e5.n * 0.5, `seed 2 is a genuinely different realization (${e5.diff.toLocaleString()} nodes differ)`);


console.log('\n13. page errors');
ok(errs.length === 0, errs.length ? errs.slice(0, 3).join(' | ') : 'none');

console.log(`\n${pass} passed, ${fail} failed`);
await p.close(); await b.close(); srv.close();
process.exit(fail ? 1 : 0);
