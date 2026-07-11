// lamina single-file build smoke — guards the SHIP artifact (lamina.html), not
// the dev harness. Rebuilds it, serves over loopback HTTP, and asserts the whole
// stack survives the registry/import-map bundling: boot, memory open, the
// off-thread worker scan (the inlined @gcu/lamina blob URL must be importable
// from the proc worker — the build's riskiest seam), filter, and a zip entry.
// Not in `npm test` (needs a browser + a build):  node test/lamina-built-smoke.mjs
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { zipSync } from '../ext/archive/vendor/fflate.module.mjs';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (m) => { console.error('✖ ' + m); process.exitCode = 1; };
const ok = (m) => console.log('✔ ' + m);

console.log('building lamina.html…');
execFileSync('node', ['build.js', '--target=lamina'], { cwd: repo, stdio: 'inherit' });

const server = http.createServer((req, res) => {
  const f = path.join(repo, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(repo) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'text/html' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
// The deliberate egress-block test trips a CSP-violation console error on purpose —
// that's the proof the lock fires, not a real fault, so don't count it.
const expectedCsp = (t) => /Content Security Policy|Refused to connect/i.test(t);
page.on('console', (m) => { if (m.type() === 'error' && !expectedCsp(m.text())) errors.push(m.text()); });
page.on('pageerror', (e) => { if (!expectedCsp(String(e))) errors.push(String(e)); });
// Count connect-src-governed egress (fetch/xhr/ws/sse) — the requests the Sealed
// profile forbids. Snapshotted right after boot → seal's runtime network gate.
const EGRESS = new Set(['fetch', 'xhr', 'websocket', 'eventsource']);
let egressReqs = 0;
page.on('request', (r) => { if (EGRESS.has(r.resourceType())) egressReqs++; });

try {
  await page.goto(`http://127.0.0.1:${port}/lamina.html`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window._lamina, null, { timeout: 8000 });
  ok('single-file lamina.html booted');
  const egressOnLoad = egressReqs;   // snapshot before the deliberate egress test below

  const mem = await page.evaluate(() => {
    let csv = 'id,v\n'; for (let i = 0; i < 2000; i++) csv += `${i},x${i}\n`;
    window._lamina.open('m.csv', new TextEncoder().encode(csv));
    return { rows: window._laminaVS.rowCount(), canvases: document.querySelectorAll('#grid canvas').length };
  });
  (mem.rows === 2000 && mem.canvases === 3) ? ok(`memory open → ${mem.rows} rows, grid painted`) : fail(`memory open: ${JSON.stringify(mem)}`);

  // The enterprise guarantee: CSP connect-src 'none' must BLOCK egress. A same-origin
  // fetch would succeed without CSP (served over http here) — so a rejection proves
  // the lock is live, not just that the app happens not to call out.
  const egress = await page.evaluate(async () => {
    try { await fetch(location.href, { cache: 'no-store' }); return 'ALLOWED'; }
    catch { return 'blocked'; }
  });
  (egress === 'blocked') ? ok('CSP connect-src \'none\' blocks egress (same-origin fetch rejected) — networkless')
    : fail(`egress NOT blocked: ${egress}`);

  // The build's riskiest seam: the off-thread scan worker importing the inlined bundle.
  const w = await page.evaluate(async () => {
    let csv = 'n,v\n'; for (let i = 0; i < 6000; i++) csv += `${i},y${i}\n`;
    await window._lamina.openFile(new File([new TextEncoder().encode(csv)], 's.csv'));
    const deep = await window._laminaVS.ensureRow(5000);
    return { scan: window._lamina.lastScan, rows: window._laminaVS.rowCount(), deep: deep && deep[0] };
  });
  (w.scan === 'worker' && w.rows === 6000 && w.deep === '5000')
    ? ok('off-thread worker scan works from the inlined blob URL')
    : fail(`worker scan in bundle: ${JSON.stringify(w)}`);

  const flt = await page.evaluate(async () => {
    await window._lamina.applyFilter('v ~ "y99"');              // contains "y99" (text quoted): y99, y990-999, y1990-1999, …
    const shown = window._laminaVS.rowCount();
    await window._lamina.applyFilter('');
    return { shown, cleared: window._laminaVS.rowCount() };
  });
  (flt.shown > 0 && flt.cleared === 6000)
    ? ok(`filter in bundle → ${flt.shown} match, clear restores 6000`)
    : fail(`filter in bundle: ${JSON.stringify(flt)}`);

  const zipArr = Array.from(zipSync({ 'inner.csv': new TextEncoder().encode('a,b\n1,2\n3,4\n') }));
  const zip = await page.evaluate(async (arr) => {
    await window._lamina.openFile(new File([new Uint8Array(arr)], 'z.zip'));
    return { rows: window._laminaVS.rowCount(), name: document.getElementById('fileName').textContent };
  }, zipArr);
  (zip.rows === 2 && zip.name.includes('inner.csv')) ? ok(`zip entry opened in bundle (${zip.name})`) : fail(`zip in bundle: ${JSON.stringify(zip)}`);

  // ── gotoRow scrolls the viewport (loom scroll on an internal overflow:auto div),
  //    and a lens round-trips the grade–tonnage setup by column name. ──
  const gt = await page.evaluate(async () => {
    let csv = 'x,y,z,Au_gpt,dens\n';
    for (let i = 0; i < 4000; i++) csv += `${i},${i},${i},${(i % 10) * 0.3},2.7\n`;
    window._lamina.open('g.csv', new TextEncoder().encode(csv));
    const loomTop = () => Math.max(0, ...[...document.querySelectorAll('#grid div')]
      .filter((d) => getComputedStyle(d).overflowY === 'auto' || getComputedStyle(d).overflow === 'auto')
      .map((d) => d.scrollTop));
    window._lamina.gotoRow(1); await new Promise((r) => setTimeout(r, 120)); const top0 = loomTop();
    window._lamina.gotoRow(3800); await new Promise((r) => setTimeout(r, 200)); const top1 = loomTop();

    window._lamina.openGradeTonnage();
    const dens = document.querySelector('.gt-expr[data-f="density"]'); dens.value = '3.1'; dens.dispatchEvent(new Event('input'));
    const u = document.querySelector('.gt-unit'); if (u) { u.value = 'g/t'; u.dispatchEvent(new Event('change')); }
    const cut = document.querySelector('.gt-cut'); if (cut) { cut.value = '0.5, 1, 2'; cut.dispatchEvent(new Event('input')); }
    const gsel = document.querySelector('.gt-grade');
    if (gsel) { const o = [...gsel.options].find((x) => /Au_gpt/.test(x.textContent)); if (o) { gsel.value = o.value; gsel.dispatchEvent(new Event('change')); } }
    const lens = window._lamina.buildLens();
    // reset + re-apply the lens fresh, then reopen GT → it must be seeded from the lens
    document.querySelector('#help') && document.querySelector('#help').classList.remove('show');
    window._lamina.applyLensView(lens);
    await new Promise((r) => setTimeout(r, 300));
    document.querySelector('#help') && document.querySelector('#help').classList.remove('show');
    window._lamina.openGradeTonnage();
    const seeded = {
      density: document.querySelector('.gt-expr[data-f="density"]').value,
      unit: (document.querySelector('.gt-unit') || {}).value,
      cut: (document.querySelector('.gt-cut') || {}).value,
      grade: (document.querySelector('.gt-grade') || {}).selectedOptions && document.querySelector('.gt-grade').selectedOptions[0].textContent,
    };
    return { top0, top1, lensGt: lens.gt, seeded };
  });
  (gt.top1 > gt.top0 + 50000) ? ok(`gotoRow scrolls the viewport (${gt.top0} → ${gt.top1}px)`) : fail(`gotoRow did not scroll: ${JSON.stringify({ top0: gt.top0, top1: gt.top1 })}`);
  (gt.lensGt && gt.lensGt.density === '3.1' && gt.lensGt.grades.some((g) => /Au_gpt/.test(g.col) && g.unit === 'g/t' && /0\.5/.test(g.cutoffs)))
    ? ok('lens carries the grade–tonnage setup (density + graded unit + cutoffs, by name)')
    : fail(`lens gt missing/wrong: ${JSON.stringify(gt.lensGt)}`);
  (gt.seeded.density === '3.1' && gt.seeded.unit === 'g/t' && /0\.5/.test(gt.seeded.cut) && /Au_gpt/.test(gt.seeded.grade))
    ? ok('applied lens seeds GT on a matching schema (name → index)')
    : fail(`applied lens did not seed GT: ${JSON.stringify(gt.seeded)}`);

  // build stamp injected (version · content-hash · date) — visible in the footer + window._lamina.build
  const stamp = await page.evaluate(() => ({ footer: document.getElementById('build').textContent, api: window._lamina.build }));
  (/^\d+\.\d+\.\d+ · [0-9a-f]{7} · \d{4}-\d{2}-\d{2}$/.test(stamp.footer) && stamp.footer === stamp.api)
    ? ok(`build stamp present (${stamp.footer})`)
    : fail(`build stamp missing/malformed: ${JSON.stringify(stamp)}`);

  // ── seal: the build-ENFORCED capability — verify the emitted declaration against
  //    the real artifact + the observed runtime (0 egress on load = the Sealed gate). ──
  const seal = await import('../ext/seal/index.js');
  const template = JSON.parse(fs.readFileSync(path.join(repo, 'tools/lamina/capability.template.json'), 'utf8'));
  const bytes = fs.readFileSync(path.join(repo, 'lamina.html'));
  const { capability, sha256 } = seal.emitArtifacts({ bytes, template, version: '0.1.0' });
  try {
    const rep = await seal.verifyClaims({ bytes, capability, runSmoke: async () => ({ networkRequests: egressOnLoad, ranClean: true }) });
    ok(`seal: ${capability.profile} verified — ${egressOnLoad} egress req on load, sha256 ${sha256.slice(0, 12)}… (${rep.checks.filter((c) => c.pass).length}/${rep.checks.length} checks pass)`);
  } catch (e) {
    fail(`seal verify FAILED: ${e.message}` + (e.report ? ' — ' + JSON.stringify(e.report.checks.filter((c) => !c.pass && c.gate)) : ''));
  }

  if (errors.length) fail('console errors: ' + errors.join(' | '));
  else ok('no console errors');
} catch (e) {
  fail('smoke threw: ' + e.message);
} finally {
  await browser.close();
  server.close();
}
console.log(process.exitCode ? '\nLAMINA BUILT SMOKE: FAIL' : '\nLAMINA BUILT SMOKE: PASS');
