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

console.log('1. cluster.dat — the book, through the button, judged by the book');
const c1 = await p.evaluate(async () => {
  document.querySelector('#btnCluster').click();
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

console.log('5. page errors');
ok(errs.length === 0, errs.length ? errs.slice(0, 3).join(' | ') : 'none');
console.log(`\n${pass} passed, ${fail} failed`);
await p.close(); await b.close(); srv.close();
process.exit(fail ? 1 : 0);
