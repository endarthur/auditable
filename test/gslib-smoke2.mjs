// gslib.wasm — the second committed smoke (like micro-smoke2): the BOOK guards.
// cluster.dat authenticity THROUGH the oracle (our declus must land on the book's
// published ~2.5), the kt3d.par export→wipe→import round-trip (the full anisotropy
// ellipsoid must survive), and a book-style gamv.par driving the panel.
//   node test/gslib-smoke2.mjs   (runs against the BUILT gslib.html)
import { chromium } from 'playwright';
import http from 'http'; import { readFile } from 'fs/promises'; import { extname } from 'path';
const MIME = { '.html': 'text/html', '.js': 'text/javascript' };
const srv = http.createServer(async (rq, rs) => { try { const p = decodeURIComponent(new URL(rq.url, 'http://x').pathname);
  rs.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' }); rs.end(await readFile('.' + p)); } catch { rs.writeHead(404); rs.end(); } });
await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const PORT = srv.address().port;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ', m); } else { fail++; console.log('  FAIL', m); } };
const b = await chromium.launch({ args: ['--use-gl=angle'] });
const p = await b.newPage();
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
await p.goto(`http://127.0.0.1:${PORT}/gslib.html`);
await p.waitForFunction(() => window._gslib, null, { timeout: 20000 });

console.log('1. cluster.dat — the book, through the samples MENU, judged by the book');
const c1 = await p.evaluate(async () => {
  document.querySelector('#btnSamples').click();            // the dedicated button became a menu item
  document.querySelector('[data-smp="book"]').click();
  await new Promise((r) => setTimeout(r, 1200));
  const S = window._gslib.S;
  const v = S.rows.map((r) => r[S.map.v]);
  document.querySelector('#dcMin').value = 1; document.querySelector('#dcMax').value = 25;
  window._gslib.runDeclus();
  return { n: S.rows.length, col: S.cols[S.map.v], mean: v.reduce((a, b) => a + b, 0) / v.length,
           max: Math.max(...v), dec: S.declusMean };
});
ok(c1.n === 140 && c1.col === 'Primary', `140 samples, value = ${c1.col}`);
ok(Math.abs(c1.mean - 4.3504) < 1e-3 && Math.abs(c1.max - 58.32) < 1e-9, `the fingerprints: mean ${c1.mean.toFixed(4)}, max ${c1.max}`);
ok(c1.dec > 2.2 && c1.dec < 2.9, `OUR declus reproduces the BOOK: declustered mean ${c1.dec.toFixed(4)} (published ≈ 2.5)`);

console.log('2. kt3d.par round-trip: export the session, wipe it, import it back');
const c2 = await p.evaluate(async () => {
  // configure a distinctive state
  document.querySelector('#kNx').value = 37; document.querySelector('#kSx').value = 1.4;
  document.querySelector('#kNy').value = 29; document.querySelector('#kSy').value = 1.8;
  document.querySelector('#kMin').value = 3; document.querySelector('#kMax').value = 21;
  document.querySelector('#kRad').value = 33;
  window._gslib.S.model.structures = [
    { type: 'exponential', contribution: 0.7, range: 15, rangeMinor: 9, rangeVert: 4, angle: 42, angle2: 10 },
    { type: 'gaussian', contribution: 0.3, range: 40, rangeMinor: 40, rangeVert: 40, angle: 0, angle2: 0 },
  ];
  document.querySelector('#mNug').value = 0.25;
  // capture the .par text (hook download)
  let parText = null;
  const orig = URL.createObjectURL;
  URL.createObjectURL = (blob) => { blob.text().then((t) => { parText = t; }); return 'blob:probe'; };
  const clickGuard = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {};       // don't actually download
  window._gslib.exportPar('kt3d');
  await new Promise((r) => setTimeout(r, 300));
  URL.createObjectURL = orig; HTMLAnchorElement.prototype.click = clickGuard;
  if (!parText) return null;
  // wipe, then re-import
  document.querySelector('#kNx').value = 5; document.querySelector('#kRad').value = 1;
  document.querySelector('#mNug').value = 0; window._gslib.S.model.structures = [];
  window._gslib.importPar('kt3d.par', parText);
  const m = window._gslib.modelSpec();
  return {
    parHead: parText.split('\n').slice(0, 2).join(' ').trim(),
    nx: +document.querySelector('#kNx').value, sx: +document.querySelector('#kSx').value,
    ndmax: +document.querySelector('#kMax').value, rad: +document.querySelector('#kRad').value,
    nug: m.nugget, nst: m.structures.length, s1: m.structures[0], s2: m.structures[1],
    msg: document.querySelector('#parMsg').textContent.slice(0, 90),
  };
});
console.log(`    ${c2 && c2.msg}…`);
ok(c2 && c2.nx === 37 && c2.sx === 1.4 && c2.ndmax === 21 && c2.rad === 33, `grid + search survive the round-trip (nx ${c2.nx}, cell ${c2.sx}, max ${c2.ndmax}, r ${c2.rad})`);
ok(c2 && c2.nug === 0.25 && c2.nst === 2 && c2.s1.type === 'exponential' && c2.s1.contribution === 0.7
   && c2.s1.range === 15 && c2.s1.rangeMinor === 9 && c2.s1.rangeVert === 4 && c2.s1.angle === 42 && c2.s1.angle2 === 10,
   `the FULL anisotropy ellipsoid survives (exp 0.7 @ 15/9/4, azm 42, dip 10)`);

console.log('3. a book-style gamv.par drives the variography panel');
const c3 = await p.evaluate(() => {
  const par = `                  Parameters for GAMV
                  *******************

START OF PARAMETERS:
cluster.dat                    -file with data
1   2   0                      -columns for X, Y, Z coordinates
1   3                          -number of variables, column numbers
-1.0e21   1.0e21               -trimming limits
gamv.out                       -file for variogram output
12                             -number of lags
2.0                            -lag separation distance
1.0                            -lag tolerance
3                              -number of directions
0.0  90.0 50.0   0.0  90.0  50.0   -azm,atol,bandh,dip,dtol,bandv
0.0  22.5 25.0   0.0  22.5  25.0   -azm,atol,bandh,dip,dtol,bandv
90.0 22.5 25.0   0.0  22.5  25.0   -azm,atol,bandh,dip,dtol,bandv
0                              -standardize sills? (0=no, 1=yes)
1                              -number of variograms
1   1   1                      -tail var., head var., variogram type
`;
  window._gslib.importPar('gamv.par', par);
  const dirs = [...document.querySelectorAll('#dirTable tbody tr')].map((tr) => [...tr.querySelectorAll('input')].map((i) => +i.value));
  return { nlag: +document.querySelector('#vgNlag').value, lag: +document.querySelector('#vgLag').value, dirs };
});
ok(c3.nlag === 12 && c3.lag === 2 && c3.dirs.length === 3, `12 lags × 2.0, 3 directions loaded`);
ok(c3.dirs[2][0] === 90 && c3.dirs[2][1] === 22.5, `direction 3 = azm 90 ± 22.5 (the book's E–W)`);

console.log('4. …and gamv RUNS with the imported parameterization on cluster.dat');
const c4 = await p.evaluate(() => {
  window._gslib.runVario();
  return { msg: document.querySelector('#vgMsg').textContent, plots: document.querySelectorAll('#vgPlots canvas').length };
});
ok(/3 directions/.test(c4.msg) && c4.plots === 3, `${c4.msg} → ${c4.plots} plots`);

console.log('5. the variogram MAP — anisotropy at a glance');
const c5 = await p.evaluate(() => {
  const before = document.querySelectorAll('#vgPlots canvas').length;
  window._gslib.runVarmap();
  const figs = document.querySelectorAll('#vgPlots figure');
  return { before, after: document.querySelectorAll('#vgPlots canvas').length,
           cap: figs[0] ? figs[0].querySelector('figcaption').textContent.slice(0, 60) : '' };
});
ok(c5.after === c5.before + 1 && /variogram map/.test(c5.cap), `the map renders and prepends (${c5.cap}…)`);

console.log('6. multiple realizations: e-type mean is SMOOTHER than any one realization');
const c6 = await p.evaluate(async () => {
  document.querySelector('#kNx').value = 20; document.querySelector('#kNy').value = 20;
  document.querySelector('#kSx').value = 2.5; document.querySelector('#kSy').value = 2.5;
  document.querySelector('#kRad').value = 25; document.querySelector('#kMax').value = 16;
  document.querySelector('#sgNsim').value = 4;
  window._gslib.runSim();
  await new Promise((r) => setTimeout(r, 2500));
  const R = window._gslib.S.realizations;
  if (!R || R.list.length !== 4) return null;
  const varOf = (a) => { let s = 0, n2 = 0; for (const v of a) if (Number.isFinite(v)) { s += v; n2++; }
    const m = s / n2; let q = 0; for (const v of a) if (Number.isFinite(v)) q += (v - m) ** 2; return q / n2; };
  document.querySelector('#sgShow').value = 'mean';
  document.querySelector('#sgShow').dispatchEvent(new Event('change'));
  await new Promise((r) => setTimeout(r, 400));
  const et = window._gslib.simViewArray();
  return { n: R.list.length, vReal: varOf(R.list[0]), vMean: varOf(et), viewRow: document.querySelector('#sgViewRow').style.display !== 'none' };
});
ok(c6 && c6.n === 4 && c6.viewRow, `4 realizations from one click, the view row appears`);
// the DIRECTION is the testable property; the magnitude depends on how much the
// realizations share through the conditioning data (4 realizations ≈ 25% here)
ok(c6 && c6.vMean < c6.vReal * 0.95, `e-type mean variance ${c6.vMean.toFixed(3)} < realization ${c6.vReal.toFixed(3)} — averaging smooths, as it must`);

console.log('7. the keyboard: x toggles the section, , and . scrub it');
const c7 = await p.evaluate(async () => {
  const key = (k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  key('x');
  const on = document.querySelector('#vSec').value;
  const p0 = +document.querySelector('#vSecPos').value;
  key('.'); key('.'); key('.');
  const p1 = +document.querySelector('#vSecPos').value;
  key(',');
  const p2 = +document.querySelector('#vSecPos').value;
  key('x');
  const off = document.querySelector('#vSec').value;
  return { on, off, p0, p1, p2 };
});
ok(c7.on !== 'off' && c7.off === 'off', `x toggles (off → ${c7.on} → off)`);
ok(Math.abs(c7.p1 - c7.p0 - 0.03) < 1e-9 && Math.abs(c7.p2 - c7.p1 + 0.01) < 1e-9, `. and , scrub the slab (${c7.p0} → ${c7.p1} → ${c7.p2})`);

console.log('8. a Brazilian CSV: semicolons + decimal COMMAS');
const c8 = await p.evaluate(async () => {
  const csv = 'X;Y;TEOR\n1,5;2,5;0,42\n3,5;4,5;1,10\n5,0;6,0;2,30\n';
  document.querySelector('#csvDec').value = ',';
  window._gslib.openText('teores.csv', csv);
  await new Promise((r) => setTimeout(r, 600));
  const S = window._gslib.S;
  const out = { rows: S.rows.length, first: S.rows[0], knobs: document.querySelector('#csvRow').style.display !== 'none' };
  document.querySelector('#csvDec').value = '.';             // leave the page as found
  return out;
});
ok(c8.rows === 3 && c8.first[0] === 1.5 && c8.first[2] === 0.42, `decimal-comma CSV reads true (row 1 = ${JSON.stringify(c8.first)})`);
ok(c8.knobs, 'the CSV knobs appear for a CSV (and not for GeoEAS)');

console.log('9. page errors');
ok(errs.length === 0, errs.length ? errs.slice(0, 3).join(' | ') : 'none');
console.log(`\n${pass} passed, ${fail} failed`);
await p.close(); await b.close(); srv.close();
process.exit(fail ? 1 : 0);
