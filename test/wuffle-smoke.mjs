// wuffle smoke — boots the BUILT wuffle.html (the deploy artifact + what lands
// in the lead-acid APK) and exercises the core: bearing integration, the live
// Schmidt net, plotting, manual entry, delete/clear. Committed guard, like
// micro-smoke. Run: node test/wuffle-smoke.mjs  (needs `node build.js --target=wuffle`)
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); res.end(data);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

let pass = 0, fail = 0;
const chk = (name, ok) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`); ok ? pass++ : fail++; };

if (!fs.existsSync(path.join(root, 'wuffle.html'))) {
  console.error('wuffle.html not built — run: node build.js --target=wuffle');
  process.exit(1);
}

const browser = await chromium.launch();
const p = await browser.newPage();
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
p.on('pageerror', (e) => errs.push(String(e)));

await p.goto(`http://127.0.0.1:${PORT}/wuffle.html`, { waitUntil: 'load' });

// 1. boots — the registry bundle wired @gcu/bearing + @gcu/leadacid without errors
const booted = await p.waitForFunction(() => !!window.__wuffle, null, { timeout: 15000 }).then(() => true).catch(() => false);
chk(`built wuffle.html boots (window.__wuffle; errors: ${errs.length ? errs.join(' ; ') : 'none'})`, booted && errs.length === 0);

// 2. the Schmidt net rendered (bearing's Stereonet — graticule + primitive + cardinals)
const net = await p.evaluate(() => {
  const svg = document.querySelector('.net svg');
  if (!svg) return null;
  const q = (s) => svg.querySelectorAll(s).length;
  return { grid: q('.sn-grid'), prim: q('.sn-primitive'), cardinals: q('.sn-cardinal') };
});
chk(`net renders (grid ${net?.grid}, primitive ${net?.prim}, cardinals ${net?.cardinals})`,
  net && net.grid > 0 && net.prim > 0 && net.cardinals === 4);

// 3. plotting: a plane → a great-circle path, a line → a point (bearing integration)
await p.evaluate(() => { window.__wuffle.plot(45, 30, 'plane'); window.__wuffle.plot(200, 25, 'plane'); window.__wuffle.plot(310, 70, 'line'); });
const plotted = await p.evaluate(() => ({
  planes: document.querySelectorAll('.net .sn-plane').length,
  lines: document.querySelectorAll('.net .sn-line').length,
  count: window.__wuffle.count(),
  rows: document.querySelectorAll('#list li').length,
}));
chk(`plots 2 planes + 1 line (planes ${plotted.planes}, lines ${plotted.lines}, log ${plotted.count}, rows ${plotted.rows})`,
  plotted.planes === 2 && plotted.lines === 1 && plotted.count === 3 && plotted.rows === 3);

// 4. a plane's great circle is real geometry inside the net (not empty / not NaN)
const geom = await p.evaluate(() => {
  const pl = document.querySelector('.net .sn-plane');
  if (!pl) return null;
  const d = pl.getAttribute('d') || '';
  const bb = pl.getBBox();
  return { hasPath: d.length > 10 && !/NaN/.test(d), w: Math.round(bb.width), h: Math.round(bb.height) };
});
chk(`plane trace is real geometry (path ${geom?.hasPath}, bbox ${geom?.w}×${geom?.h})`,
  geom && geom.hasPath && geom.w > 20 && geom.h > 20);

// 5. manual entry: "045/30" → a plane, "310→70" → a line (the desktop/two-homes path)
await p.evaluate(() => { window.__wuffle.plot && 0; });
await p.fill('#manual', '120/55'); await p.click('#add');
await p.fill('#manual', '90→15'); await p.click('#add');
const afterEntry = await p.evaluate(() => ({
  count: window.__wuffle.count(),
  last: window.__wuffle.log[window.__wuffle.log.length - 1],
  prev: window.__wuffle.log[window.__wuffle.log.length - 2],
}));
chk(`manual entry parses (count ${afterEntry.count}, 120/55 plane=${afterEntry.prev?.mode}, 90→70 line=${afterEntry.last?.mode})`,
  afterEntry.count === 5 && afterEntry.prev?.mode === 'plane' && afterEntry.prev?.d1 === 120 && afterEntry.last?.mode === 'line');

// 6. delete one row → count + net update
await p.evaluate(() => document.querySelector('#list li .del').click());
const afterDel = await p.evaluate(() => ({ count: window.__wuffle.count(), rows: document.querySelectorAll('#list li').length }));
chk(`delete a measurement (count ${afterDel.count}, rows ${afterDel.rows})`, afterDel.count === 4 && afterDel.rows === 4);

// 7. clear → empty net + log
await p.click('#clear');
const afterClear = await p.evaluate(() => ({
  count: window.__wuffle.count(),
  planes: document.querySelectorAll('.net .sn-plane').length,
  lines: document.querySelectorAll('.net .sn-line').length,
}));
chk(`clear empties log + net (count ${afterClear.count}, planes ${afterClear.planes}, lines ${afterClear.lines})`,
  afterClear.count === 0 && afterClear.planes === 0 && afterClear.lines === 0);

// 8. mode toggle updates the reading labels
const labels = await p.evaluate(() => {
  document.getElementById('mLine').click();
  const line = [document.getElementById('l1').textContent, document.getElementById('l2').textContent];
  document.getElementById('mPlane').click();
  const plane = [document.getElementById('l1').textContent, document.getElementById('l2').textContent];
  return { line, plane };
});
chk(`mode toggle relabels (plane ${labels.plane}, line ${labels.line})`,
  labels.plane[0] === 'dip dir' && labels.plane[1] === 'dip' && labels.line[0] === 'trend' && labels.line[1] === 'plunge');

await browser.close();
server.close();
console.log(`\nwuffle-smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
