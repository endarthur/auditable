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
const readVals = (rows, fb = 'fbB') => p.evaluate(([rows2, fb2]) => {
  const { V, SIM } = window._bands;
  const gl = V.renderer.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER, SIM[fb2]);
  const px = new Float32Array(8192 * rows2 * 4);
  gl.readPixels(0, 0, 8192, rows2, gl.RGBA, gl.FLOAT, px);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const out = new Array(8192 * rows2);
  for (let i = 0; i < out.length; i++) out[i] = px[i * 4];
  return out;
}, [rows, fb]);

console.log('— a single realization is standard normal —');
{
  const v = (await readVals(24, 'fbLast')).slice(0, 96 * 96 * 16);   // the first 16 z-slices
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
    const v = (await readVals(2, 'fbLast')).slice(0, 96 * 96);       // one z-slice
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
  await p.evaluate(() => { window._bands.resetAcc(); for (let i = 0; i < 40; i++) window._bands.step({}); });
  ok(await p.evaluate(() => window._bands.SIM.K === 41), 'K = 41 after 40 folded steps');
  await p.evaluate(() => { document.querySelector('#vView').value = 'mean'; document.querySelector('#vView').dispatchEvent(new Event('change')); });
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
  // a REAL mouse click, and the chip must be COMPUTED-visible — style.display
  // alone lied once (inline '' falls back to the sheet's display:none)
  const cvBox = await p.evaluate(() => { const r2 = document.querySelector('#cv').getBoundingClientRect(); return { x: r2.x, y: r2.y, w: r2.width, h: r2.height }; });
  await p.mouse.click(cvBox.x + cvBox.w / 2, cvBox.y + cvBox.h / 2);
  await p.waitForTimeout(200);
  const chip = await p.evaluate(() => {
    const el = document.querySelector('#pickInfo');
    return { visible: getComputedStyle(el).display !== 'none', text: el.textContent };
  });
  ok(chip.visible && /block \[\d+, \d+, \d+\]/.test(chip.text), `a real click shows the value chip (${chip.text.slice(0, 40)})`);
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

console.log('— play, morph, budget —');
{
  // space toggles play, even with the play button focused (native activation suppressed)
  await p.click('#btnPlay');
  ok(await p.evaluate(() => document.querySelector('#btnPlay').textContent.includes('pause')), 'play starts');
  await p.keyboard.press(' ');
  ok(await p.evaluate(() => document.querySelector('#btnPlay').textContent.includes('play')), 'space pauses (button focused)');
  await p.keyboard.press(' ');
  ok(await p.evaluate(() => document.querySelector('#btnPlay').textContent.includes('pause')), 'space resumes');
  await p.evaluate(() => window._bands.setPlaying(false));

  const corr = (a, b2) => {
    let ma = 0, mb = 0;
    for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b2[i]; }
    ma /= a.length; mb /= a.length;
    let sab = 0, sa = 0, sb = 0;
    for (let i = 0; i < a.length; i++) { const da = a[i] - ma, db = b2[i] - mb; sab += da * db; sa += da * da; sb += db * db; }
    return sab / Math.sqrt(sa * sb);
  };
  // morph: consecutive frames are the SAME field drifting (high correlation), K
  // frozen. The drift is wall-clock, so BOTH steps + reads happen in one page
  // call — a Playwright round-trip between them would add real seconds of drift.
  const morphPair = await p.evaluate(() => {
    const { V, SIM } = window._bands;
    const gl = V.renderer.gl;
    const read = () => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, SIM.fbLast);
      const px = new Float32Array(4096 * 4);
      gl.readPixels(0, 0, 4096, 1, gl.RGBA, gl.FLOAT, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return Array.from({ length: 4096 }, (_, i) => px[i * 4]);
    };
    window._bands.resetAcc();
    document.querySelector('#vMorph').checked = true;
    window._bands.step({});
    const k0 = SIM.K, t1 = window._bands.MORPH.t, a = read();
    window._bands.step({});
    return { k0, a, b: read(), k1: SIM.K, dt: window._bands.MORPH.t - t1 };
  });
  // the law: velocities ~ U(±6) ⇒ corr(Δt) = (1-nug)·sin(6Δt)/(6Δt) + nug (the
  // nugget is frozen during morph). Δt is wall-clock, so compute the expectation
  // from the measured Δt instead of assuming the steps were adjacent.
  const rM = corr(morphPair.a, morphPair.b);
  const sx = 6 * morphPair.dt;
  const expM = 0.9 * (Math.sin(sx) / sx) + 0.1;
  ok(Math.abs(rM - expM) < 0.2, `morph correlation obeys the drift law (r=${rM.toFixed(3)}, expected ${expM.toFixed(3)} at Δt=${morphPair.dt.toFixed(3)}s)`);
  ok(morphPair.k1 === morphPair.k0, 'morph steps do not tick K (correlated ≠ independent)');
  // morph off: the first step re-realizes the parked base seed (t=0), so
  // independence shows between the NEXT two fresh seeds
  await p.evaluate(() => { document.querySelector('#vMorph').checked = false; window._bands.step({}); });
  const m3 = (await readVals(1, 'fbLast')).slice(0, 4096);
  await p.evaluate(() => window._bands.step({}));
  const m4 = (await readVals(1, 'fbLast')).slice(0, 4096);
  ok(Math.abs(corr(m3, m4)) < 0.4, `independent seeds decorrelate (r=${corr(m3, m4).toFixed(3)})`);

  // budget: a still camera draws everything; a moving one uses the selector
  ok(await p.evaluate(() => window._bands.budgetNow() >= 5e7), 'still camera → full draw');
  ok(await p.evaluate(() => { window._bands.camMoved(); return window._bands.budgetNow() === +document.querySelector('#vBudget').value; }), 'moving camera → the selected budget');
  ok(errs.length === 0, `still no page errors${errs.length ? ' — ' + errs[errs.length - 1] : ''}`);
}

console.log('— diagnostics + the azimuth actually rotates —');
{
  const setP = (azm) => p.evaluate((azm2) => {
    const $ = (s2) => document.querySelector(s2);
    $('#vModel').value = 'gau'; $('#vRange').value = 24; $('#vRangeMinor').value = 12; $('#vRangeVert').value = 6;
    $('#vAzm').value = azm2; $('#vNug').value = 0; $('#vBands').value = 400;
    document.querySelector('#vMorph').checked = false;
    $('#vModel').dispatchEvent(new Event('change'));         // resets + forces a diagnostics refresh
    return { gx: Array.from(window._bands.DIAG.last.gx), gy: Array.from(window._bands.DIAG.last.gy), gz: Array.from(window._bands.DIAG.last.gz) };
  }, azm);
  // azimuth 0: major range 24 along +Y (north), minor 12 along X, vertical 6
  const a0 = await setP(0);
  ok(a0.gy[6] * 1.4 < a0.gx[6], `azm 0: γY(6) ≪ γX(6) — major along north (${a0.gy[6].toFixed(3)} vs ${a0.gx[6].toFixed(3)})`);
  ok(a0.gx[6] * 1.4 < a0.gz[6], `vertical range shortest: γX(6) ≪ γZ(6) (${a0.gx[6].toFixed(3)} vs ${a0.gz[6].toFixed(3)})`);
  // azimuth 90: the major axis rotates onto +X — the ordering flips
  const a90 = await setP(90);
  ok(a90.gx[6] * 1.4 < a90.gy[6], `azm 90 flips it: γX(6) ≪ γY(6) (${a90.gx[6].toFixed(3)} vs ${a90.gy[6].toFixed(3)})`);
  // histogram is a density that integrates to ~1 and peaks near 0
  const hist = await p.evaluate(() => ({ bins: Array.from(window._bands.DIAG.last.bins), bw: window._bands.DIAG.last.bw }));
  const area = hist.bins.reduce((t, b2) => t + b2 * hist.bw, 0);
  const peak = hist.bins.indexOf(Math.max(...hist.bins));
  ok(Math.abs(area - 1) < 0.05, `histogram is a density (area=${area.toFixed(3)})`);
  ok(Math.abs(peak - hist.bins.length / 2) <= 5, `histogram peaks near 0 (bin ${peak}/${hist.bins.length})`);
  ok(errs.length === 0, `still no page errors${errs.length ? ' — ' + errs[errs.length - 1] : ''}`);
}

console.log('— conditioning: the three laws —');
{
  // a small grid keeps the CPU solve quick; the laws are scale-free
  await p.evaluate(() => {
    const $ = (s2) => document.querySelector(s2);
    $('#gSize').value = '64,64,32'; $('#gSize').dispatchEvent(new Event('change'));
    $('#vModel').value = 'gau'; $('#vNug').value = 0;
    $('#vRange').value = 20; $('#vRangeMinor').value = 20; $('#vRangeVert').value = 10;
    $('#vModel').dispatchEvent(new Event('change'));
    $('#cHoles').value = 6; $('#cSpace').value = 3;
    window._bands.genDrillholes();
    window._bands.buildTensor();
  });
  await p.waitForFunction(() => !window._bands.COND.building && window._bands.COND.tex, null, { timeout: 120000 });
  ok(await p.evaluate(() => window._bands.COND.n > 20), `drillholes sampled (${await p.evaluate(() => window._bands.COND.n)} samples)`);

  const L = await p.evaluate(() => {
    const { COND, G, SIM, V } = window._bands;
    const gl = V.renderer.gl;
    const readRec = (r2) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, SIM.fbLast);
      const px = new Float32Array(4);
      gl.readPixels(r2 % 8192, Math.floor(r2 / 8192), 1, 1, gl.RGBA, gl.FLOAT, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return px[0];
    };
    const recOf = (x, y, z) => Math.min(G.nx - 1, Math.max(0, Math.floor(x)))
      + Math.min(G.ny - 1, Math.max(0, Math.floor(y))) * G.nx
      + Math.min(G.nz - 1, Math.max(0, Math.floor(z))) * G.nx * G.ny;
    // the datum sitting closest to a block centre (kriging should reproduce it)
    let best = 0, bestD = 1e9;
    for (let i = 0; i < COND.n; i++) {
      const d = Math.hypot(COND.x[i] - (Math.floor(COND.x[i]) + 0.5), COND.y[i] - (Math.floor(COND.y[i]) + 0.5), COND.z[i] - (Math.floor(COND.z[i]) + 0.5));
      if (d < bestD) { bestD = d; best = i; }
    }
    const recNear = recOf(COND.x[best], COND.y[best], COND.z[best]);
    let recFar = 0, farD = 0;                                  // the block furthest from every hole
    for (let t = 0; t < 300; t++) {
      const x = Math.random() * G.nx, y = Math.random() * G.ny, z = Math.random() * G.nz;
      let d = 1e9;
      for (let i = 0; i < COND.n; i++) d = Math.min(d, Math.hypot(COND.x[i] - x, COND.y[i] - y, COND.z[i] - z));
      if (d > farD) { farD = d; recFar = recOf(x, y, z); }
    }
    const seeds = (on) => {
      document.querySelector('#cOn').checked = on;
      const near = [], far = [];
      for (let s2 = 0; s2 < 6; s2++) {
        document.querySelector('#vSeed').value = 100 + s2;
        window._bands.resetAcc();
        near.push(readRec(recNear)); far.push(readRec(recFar));
      }
      return { near, far };
    };
    const sd = (a) => { const m = a.reduce((t, v) => t + v, 0) / a.length; return Math.sqrt(a.reduce((t, v) => t + (v - m) ** 2, 0) / a.length); };
    const on = seeds(true), off = seeds(false);
    const truth = COND.v[best];
    return {
      err: on.near.reduce((t, v) => t + Math.abs(v - truth), 0) / on.near.length,
      onNearSd: sd(on.near), offNearSd: sd(off.near), onFarSd: sd(on.far), offFarSd: sd(off.far),
    };
  });
  ok(L.err < 0.15, `every realization honours the datum (mean |error| ${L.err.toFixed(4)})`);
  ok(L.onNearSd < 0.25 * L.offNearSd, `variance collapses at the data (sd ${L.onNearSd.toFixed(3)} vs unconditional ${L.offNearSd.toFixed(3)})`);
  ok(L.onFarSd > 0.55 * L.offFarSd, `still a simulation away from data (sd ${L.onFarSd.toFixed(2)} vs ${L.offFarSd.toFixed(2)})`);
  ok(await p.evaluate(() => { document.querySelector('#vRange').value = 30; document.querySelector('#vRange').dispatchEvent(new Event('change')); return document.querySelector('#cOn').disabled; }), 'changing the model invalidates the tensor (geometry moved)');
  ok(errs.length === 0, `still no page errors${errs.length ? ' — ' + errs[errs.length - 1] : ''}`);
}

await b.close(); srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
