// bands.gpu — the committed guard: boot, the statistical honesty checks (a single
// realization is standard normal; the experimental variogram tracks the requested
// model; the GPU-side reductions obey the laws), chanTex display, pick, sections.
//   node test/bands-smoke.mjs        (built bands.html — the default)
//   node test/bands-smoke.mjs dev    (tools/bands/index.html over the dev tree)
import { chromium } from 'playwright';
import http from 'http'; import { readFile } from 'fs/promises'; import { extname } from 'path';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };
const srv = http.createServer(async (rq, rs) => { try { const p = decodeURIComponent(new URL(rq.url, 'http://x').pathname);
  rs.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' }); rs.end(await readFile('.' + p)); } catch { rs.writeHead(404); rs.end(); } });
await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const PORT = srv.address().port;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 140)); });
await p.goto(`http://127.0.0.1:${PORT}/${process.argv[2] === 'dev' ? 'tools/bands/index.html' : 'bands.html'}`);
await p.waitForFunction(() => window._bands && window._bands.SIM.K >= 1, null, { timeout: 20000 }).catch(() => {});

console.log('— boot —');
ok(await p.evaluate(() => !!window._bands), 'app booted');
ok(errs.length === 0, `no page errors${errs.length ? ' — ' + errs[0] : ''}`);
ok(await p.evaluate(() => window._bands.SIM.K === 1), 'boot lands on one realization (K=1)');
ok(await p.evaluate(() => window._bands.G.n === 96 * 96 * 48), 'default grid 96×96×48');

// helper: read the resolved value texture rows [0, rows) → Float32Array of values
const readVals = (rows) => p.evaluate((rows2) => {
  const { V, SIM } = window._bands;
  const gl = V.renderer.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER, SIM.fbB);
  const px = new Float32Array(8192 * rows2 * 4);
  gl.readPixels(0, 0, 8192, rows2, gl.RGBA, gl.FLOAT, px);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const out = new Array(8192 * rows2);
  for (let i = 0; i < out.length; i++) out[i] = px[i * 4];
  return out;
}, rows);

console.log('— a single realization is standard normal —');
{
  const v = (await readVals(24)).slice(0, 96 * 96 * 16);   // the first 16 z-slices
  const n = v.length;
  let m = 0; for (const x of v) m += x; m /= n;
  let s2 = 0; for (const x of v) s2 += (x - m) * (x - m); s2 /= n;
  ok(Math.abs(m) < 0.5, `mean ≈ 0 (got ${m.toFixed(3)})`);
  ok(s2 > 0.5 && s2 < 1.6, `variance ≈ 1 (got ${s2.toFixed(3)})`);
  ok(v.every(Number.isFinite), 'all values finite');
}

console.log('— the covariance is exact: experimental γ(h) vs the model —');
{
  // isotropic gaussian, range 16, no nugget; average the variogram over 8 seeds
  await p.evaluate(() => {
    const $ = (s) => document.querySelector(s);
    $('#vModel').value = 'gau'; $('#vRange').value = 16; $('#vRangeMinor').value = 16; $('#vRangeVert').value = 16;
    $('#vAzm').value = 0; $('#vNug').value = 0; $('#vBands').value = 400;
    $('#vModel').dispatchEvent(new Event('change'));
  });
  const LAGS = [2, 4, 8, 12, 16, 24];
  const acc = new Float64Array(LAGS.length), cnt = new Float64Array(LAGS.length);
  for (let s = 0; s < 8; s++) {
    await p.evaluate(() => window._bands.resetAcc());
    const v = (await readVals(2)).slice(0, 96 * 96);       // one z-slice
    for (let li = 0; li < LAGS.length; li++) {
      const h = LAGS[li];
      for (let iy = 0; iy < 96; iy++) for (let ix = 0; ix + h < 96; ix++) {
        const d = v[iy * 96 + ix] - v[iy * 96 + ix + h];
        acc[li] += d * d / 2; cnt[li]++;
      }
    }
  }
  let worst = 0;
  for (let li = 0; li < LAGS.length; li++) {
    const g = acc[li] / cnt[li];
    const model = 1 - Math.exp(-((LAGS[li] / 16) ** 2));
    const err = Math.abs(g - model);
    worst = Math.max(worst, err);
    console.log(`    h=${String(LAGS[li]).padStart(2)}  γ̂=${g.toFixed(3)}  model=${model.toFixed(3)}  Δ=${err.toFixed(3)}`);
  }
  ok(worst < 0.12, `experimental variogram tracks the gaussian model (worst Δ=${worst.toFixed(3)})`);
}

console.log('— accumulation: the e-type converges, std → 1, P behaves —');
{
  await p.evaluate(() => { window._bands.resetAcc(); for (let i = 0; i < 40; i++) window._bands.step(true); });
  ok(await p.evaluate(() => window._bands.SIM.K === 41), 'K = 41 after 40 accumulated steps');
  const mean40 = (await readVals(2)).slice(0, 4096);
  let mAbs = 0; for (const x of mean40) mAbs += Math.abs(x); mAbs /= mean40.length;
  ok(mAbs < 0.35, `e-type mean shrinks toward 0 (mean |Z̄| = ${mAbs.toFixed(3)} over K=41)`);
  await p.evaluate(() => { document.querySelector('#vView').value = 'std'; document.querySelector('#vView').dispatchEvent(new Event('change')); });
  const std40 = (await readVals(2)).slice(0, 4096);
  let sM = 0; for (const x of std40) sM += x; sM /= std40.length;
  ok(Math.abs(sM - 1) < 0.25, `std of the ensemble ≈ 1 (got ${sM.toFixed(3)})`);
  await p.evaluate(() => { document.querySelector('#vView').value = 'prob'; document.querySelector('#vCut').value = 0;
    document.querySelector('#vView').dispatchEvent(new Event('change')); });
  // NOTE: P was folded with the cutoff at realize time (1.0 default) — the view change
  // alone re-resolves channel B which counted z > 1.0; expect P ≈ P(Z>1) ≈ 0.16
  const p40 = (await readVals(2)).slice(0, 4096);
  let pM = 0; for (const x of p40) pM += x; pM /= p40.length;
  ok(Math.abs(pM - 0.159) < 0.08, `P(Z>1) ≈ 0.16 across the ensemble (got ${pM.toFixed(3)})`);
  ok(p40.every((x) => x >= 0 && x <= 1), 'P within [0, 1]');
}

console.log('— the viewer draws it (chanTex → pixels) and picks it —');
{
  await p.evaluate(() => { document.querySelector('#vView').value = 'mean'; document.querySelector('#vView').dispatchEvent(new Event('change')); });
  await p.waitForTimeout(300);
  const shot = await p.screenshot({ clip: { x: 400, y: 100, width: 900, height: 700 } });
  const { PNG } = await import('pngjs').catch(() => ({ PNG: null }));
  if (PNG) {
    const img = PNG.sync.read(shot);
    const seen = new Set();
    for (let i = 0; i < img.data.length; i += 40) seen.add((img.data[i] >> 4) + ',' + (img.data[i + 1] >> 4) + ',' + (img.data[i + 2] >> 4));
    ok(seen.size > 12, `viewport shows a varied field (${seen.size} colour bins)`);
  }
  const picked = await p.evaluate(() => {
    const r = document.querySelector('#cv').getBoundingClientRect();
    return window._bands.pickAt(r.width / 2, r.height / 2);
  });
  ok(picked && Number.isFinite(picked.value), `click-to-inspect reads a GPU value (${picked ? picked.value.toFixed(3) : '—'})`);
}

console.log('— sections + knife stay alive —');
{
  await p.evaluate(() => { const s = document.querySelector('#vSec'); s.value = 'Z'; s.dispatchEvent(new Event('change')); });
  await p.waitForTimeout(250);
  ok(await p.evaluate(() => { const s = window._bands.currentSection(); return s && s.on && s.n[2] === 1; }), 'Z section active');
  ok(await p.evaluate(() => window._bands.knifeFrom(300, 200, 700, 500)), 'knife accepts a drag → oblique plane');
  await p.waitForTimeout(250);
  ok(errs.length === 0, `still no page errors${errs.length ? ' — ' + errs[errs.length - 1] : ''}`);
}

await b.close(); srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
