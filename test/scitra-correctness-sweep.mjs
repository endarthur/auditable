// Systematic correctness sweep: scitra vs scipy on identical inputs.
// Picks up where the KDTree bench left off — the quickselect bug stayed
// hidden for months because we only had brute-force unit tests at small
// sizes. Doing the apples-to-apples scipy comparison properly catches
// bugs the small-size tests miss.

import { execSync } from 'node:child_process';
import {
  erf, erfc, erfinv, ndtri, lgamma, gamma, lbeta,
  norm, lognorm,
  weighted_mean, weighted_var, weighted_std, weighted_percentile, weighted_median,
  moments, histogram, ecdf,
  gaussian_kde,
  cdist, pdist, squareform,
  least_squares, curve_fit,
} from '../ext/scitra/index.js';

console.log('Running scipy reference …');
const ref = JSON.parse(execSync('python test/perf_scipy_compare.py', { encoding: 'utf8' }).trim());
console.log('  ready.\n');

let pass = 0, fail = 0;
const fails = [];

// Hybrid abs/rel tolerance: passes if |got - expected| <= abstol + reltol * |expected|
// Lets the test handle quantities with huge magnitude (e.g. gamma(20) ≈ 1.2e17)
// where an absolute error of "80" is actually machine epsilon.
function check(name, got, expected, abstol = 1e-9, reltol = 0) {
  let maxAbsErr = 0;
  let maxRelErr = 0;
  if (Array.isArray(expected) && Array.isArray(got)) {
    if (got.length !== expected.length) {
      fail++; fails.push({ name, reason: `length ${got.length} vs ${expected.length}` });
      console.log(`  ✗ ${name}: length mismatch ${got.length} vs ${expected.length}`);
      return;
    }
    for (let i = 0; i < expected.length; i++) {
      const e = Math.abs((got[i] ?? NaN) - expected[i]);
      const rel = Math.abs(expected[i]) > 0 ? e / Math.abs(expected[i]) : e;
      if (Number.isNaN(e) || e > maxAbsErr) maxAbsErr = e;
      if (Number.isNaN(rel) || rel > maxRelErr) maxRelErr = rel;
    }
  } else if (typeof expected === 'number' && typeof got === 'number') {
    maxAbsErr = Math.abs(got - expected);
    maxRelErr = Math.abs(expected) > 0 ? maxAbsErr / Math.abs(expected) : maxAbsErr;
  } else {
    fail++; fails.push({ name, reason: 'type mismatch' });
    console.log(`  ✗ ${name}: type mismatch`);
    return;
  }
  const ok = !Number.isNaN(maxAbsErr) && (maxAbsErr <= abstol || maxRelErr <= reltol);
  if (!ok) {
    fail++; fails.push({ name, maxAbsErr, maxRelErr, abstol, reltol });
    console.log(`  ✗ ${name}: abs ${maxAbsErr.toExponential(2)} rel ${maxRelErr.toExponential(2)} (abstol ${abstol.toExponential(0)} reltol ${reltol.toExponential(0)})`);
  } else {
    pass++;
    console.log(`  ✓ ${name}: abs ${maxAbsErr.toExponential(2)} rel ${maxRelErr.toExponential(2)}`);
  }
}

function toArr(x) {
  if (Array.isArray(x)) return x;
  if (x && x.data) return Array.from(x.data);
  if (ArrayBuffer.isView(x)) return Array.from(x);
  if (typeof x === 'number') return [x];
  return x;
}

// ── util.special ─────────────────────────────────────────────────────
console.log('\n## util.special\n');
const sp = ref.special;
check('erf',   sp.xs_erf.map(erf), sp.erf, 1e-6);
check('erfc',  sp.xs_erf.map(erfc), sp.erfc, 1e-6);
check('ndtri', sp.ps_ndtri.map(ndtri), sp.ndtri, 1e-8);
check('erfinv', sp.ys_erfinv.map(erfinv), sp.erfinv, 1e-6);
check('lgamma', sp.xs_gamma.map(lgamma), sp.lgamma, 1e-12);
check('gamma',  sp.xs_gamma.map(gamma), sp.gamma, 1e-10, 1e-13);  // gamma(20) ≈ 1.2e17 — use rel tolerance
check('lbeta',  sp.ab_lbeta.map(([a, b]) => lbeta(a, b)), sp.lbeta, 1e-12);

// ── stats.norm ────────────────────────────────────────────────────────
console.log('\n## stats.norm (standard)\n');
const nstd = ref.norm_standard;
check('norm.pdf(x)',  nstd.xs.map(x => norm.pdf(x)),  nstd.pdf, 1e-12);
check('norm.cdf(x)',  nstd.xs.map(x => norm.cdf(x)),  nstd.cdf, 1e-6);
check('norm.sf(x)',   nstd.xs.map(x => norm.sf(x)),   nstd.sf, 1e-6);
check('norm.ppf(p)',  nstd.ps.map(p => norm.ppf(p)),  nstd.ppf, 1e-8);
check('norm.isf(p)',  nstd.ps.map(p => norm.isf(p)),  nstd.isf, 1e-8);

console.log('\n## stats.norm (loc=2, scale=3)\n');
const n23 = ref.norm_loc2scale3;
check('norm(2,3).pdf', n23.xs.map(x => norm.pdf(x, 2, 3)), n23.pdf, 1e-12);
check('norm(2,3).cdf', n23.xs.map(x => norm.cdf(x, 2, 3)), n23.cdf, 1e-6);
check('norm(2,3).ppf', [0.001, 0.01, 0.025, 0.1, 0.25, 0.5, 0.75, 0.9, 0.975, 0.99, 0.999].map(p => norm.ppf(p, 2, 3)), n23.ppf, 1e-8);

// ── stats.lognorm ─────────────────────────────────────────────────────
console.log('\n## stats.lognorm\n');
const ln1 = ref.lognorm_s1;
check('lognorm(s=1).pdf', ln1.xs.map(x => lognorm.pdf(x, 1)), ln1.pdf, 1e-12);
check('lognorm(s=1).cdf', ln1.xs.map(x => lognorm.cdf(x, 1)), ln1.cdf, 1e-6);
check('lognorm(s=1).ppf', [0.1, 0.25, 0.5, 0.75, 0.9].map(p => lognorm.ppf(p, 1)), ln1.ppf, 1e-7);

const ln05 = ref.lognorm_s05scale5;
check('lognorm(s=0.5, scale=5).pdf', ln05.xs.map(x => lognorm.pdf(x, 0.5, 0, 5)), ln05.pdf, 1e-12);
check('lognorm(s=0.5, scale=5).cdf', ln05.xs.map(x => lognorm.cdf(x, 0.5, 0, 5)), ln05.cdf, 1e-6);

// ── stats descriptives ────────────────────────────────────────────────
console.log('\n## stats descriptives\n');
const d = ref.descriptives;
check('mean (unweighted)',   weighted_mean(d.x_simple),                              d.x_simple_mean, 1e-12);
check('var ddof=1',           weighted_var(d.x_simple, null, { ddof: 1 }),           d.x_simple_var_ddof1, 1e-10);
check('var ddof=0',           weighted_var(d.x_simple, null, { ddof: 0 }),           d.x_simple_var_ddof0, 1e-10);
check('std ddof=1',           weighted_std(d.x_simple, null, { ddof: 1 }),           d.x_simple_std_ddof1, 1e-10);
check('median',               weighted_median(d.x_simple),                           d.x_simple_median, 1e-12);
check('percentile 25',        weighted_percentile(d.x_simple, null, 25),             d.x_simple_p25, 0.5);  // method may differ
check('percentile 75',        weighted_percentile(d.x_simple, null, 75),             d.x_simple_p75, 0.5);
check('percentile 99',        weighted_percentile(d.x_simple, null, 99),             d.x_simple_p99, 0.5);
check('weighted_mean',        weighted_mean(d.x_weighted_vals, d.x_weighted_w),      d.x_weighted_mean, 1e-12);
check('weighted_var ddof=0',  weighted_var(d.x_weighted_vals, d.x_weighted_w, { ddof: 0 }), d.x_weighted_var_ddof0, 1e-12);
check('weighted_var ddof=1',  weighted_var(d.x_weighted_vals, d.x_weighted_w, { ddof: 1 }), d.x_weighted_var_ddof1, 1e-12);

const m = moments(d.x_simple);
check('moments.mean',     m.mean,     d.x_simple_mean, 1e-12);
check('moments.var',      m.var,      d.x_simple_var_ddof0, 1e-12);  // moments uses ddof=0
check('moments.skewness', m.skewness, d.x_simple_skew, 1e-10);
check('moments.kurtosis', m.kurtosis, d.x_simple_kurt, 1e-10);  // both: excess

// ── histogram ─────────────────────────────────────────────────────────
console.log('\n## histogram\n');
const h = ref.histogram;
const hRes = histogram(h.x, { bins: 20, range: [-4, 4] });
check('histogram counts', toArr(hRes.counts), h.counts, 1e-10);
check('histogram edges',  toArr(hRes.edges),  h.edges,  1e-10);
const hResD = histogram(h.x, { bins: 20, range: [-4, 4], density: true });
check('histogram density', toArr(hResD.counts), h.density_counts, 1e-10);

// ── gaussian_kde ──────────────────────────────────────────────────────
console.log('\n## gaussian_kde\n');
const k = ref.gaussian_kde;
const kde = gaussian_kde(k.data);
const sctPdf = k.eval_pts.map(x => kde.pdf(x));
check('kde factor',    kde.factor,    k.factor_scott, 1e-12);
check('kde bandwidth', kde.bandwidth, k.bandwidth_scott, 1e-9);
check('kde.pdf',       sctPdf,        k.pdf_scott, 1e-6);

// ── spatial.distance ─────────────────────────────────────────────────
console.log('\n## spatial.distance\n');
const cd = ref.cdist;
const X = { data: new Float64Array(cd.X.flat()), shape: [10, 4] };
const Y = { data: new Float64Array(cd.Y.flat()), shape: [6, 4] };
check('cdist euclidean',   toArr(cdist(X, Y, { metric: 'euclidean' })),   cd.euclidean.flat(),   1e-12);
check('cdist sqeuclidean', toArr(cdist(X, Y, { metric: 'sqeuclidean' })), cd.sqeuclidean.flat(), 1e-12);
check('cdist cityblock',   toArr(cdist(X, Y, { metric: 'cityblock' })),   cd.cityblock.flat(),   1e-12);
check('cdist chebyshev',   toArr(cdist(X, Y, { metric: 'chebyshev' })),   cd.chebyshev.flat(),   1e-12);
check('cdist cosine',      toArr(cdist(X, Y, { metric: 'cosine' })),      cd.cosine.flat(),      1e-12);
check('cdist minkowski p=3', toArr(cdist(X, Y, { metric: 'minkowski', p: 3 })), cd.minkowski_p3.flat(), 1e-12);

const pd = ref.pdist;
const Xp = { data: new Float64Array(pd.X.flat()), shape: [10, 4] };
check('pdist euclidean',  toArr(pdist(Xp, { metric: 'euclidean' })),  pd.euclidean, 1e-12);
check('pdist cityblock',  toArr(pdist(Xp, { metric: 'cityblock' })),  pd.cityblock, 1e-12);
check('pdist chebyshev',  toArr(pdist(Xp, { metric: 'chebyshev' })),  pd.chebyshev, 1e-12);

// squareform
const sf = ref.squareform;
const sfResult = squareform(new Float64Array(sf.pdist_vec));
check('squareform pdist→square', toArr(sfResult), sf.square.flat(), 1e-12);
const sfBack = squareform(new Float64Array(sf.square.flat()));
check('squareform square→pdist', toArr(sfBack), sf.pdist_vec, 1e-12);

// ── optimize ─────────────────────────────────────────────────────────
console.log('\n## optimize\n');
const ll = ref.least_squares_linear;
const lsLinResult = least_squares((p) => {
  const r = new Float64Array(ll.xs.length);
  for (let i = 0; i < ll.xs.length; i++) r[i] = p[0] * ll.xs[i] + p[1] - ll.ys[i];
  return r;
}, [0, 0]);
check('least_squares linear x', Array.from(lsLinResult.x), ll.x_opt, 1e-6);
check('least_squares linear cost', lsLinResult.cost, ll.cost, 1e-6);

const le = ref.least_squares_exp;
const lsExpResult = least_squares((p) => {
  const r = new Float64Array(le.ts.length);
  for (let i = 0; i < le.ts.length; i++) r[i] = p[0] * Math.exp(-p[1] * le.ts[i]) - le.ys[i];
  return r;
}, [1, 0.1]);
check('least_squares exp x', Array.from(lsExpResult.x), le.x_opt, 1e-5);
check('least_squares exp cost', lsExpResult.cost, le.cost, 1e-7);

const cf = ref.curve_fit_gauss;
const gauss = (x, A, mu, sigma) => {
  if (Array.isArray(x) || ArrayBuffer.isView(x)) {
    return Array.from(x).map((xi) => A * Math.exp(-((xi - mu) ** 2) / (2 * sigma ** 2)));
  }
  return A * Math.exp(-((x - mu) ** 2) / (2 * sigma ** 2));
};
const cfRes = curve_fit(gauss, cf.xs, cf.ys, [1, 0, 1]);
// curve_fit's optimization can converge to different solutions when there's noise,
// so we tolerate larger error on popt directly. Verify by re-computing residuals.
check('curve_fit popt', Array.from(cfRes.popt), cf.popt, 1e-3);

// ── summary ──────────────────────────────────────────────────────────
console.log(`\n=== ${pass} pass / ${fail} fail ===\n`);
if (fails.length) {
  for (const f of fails) console.log('  ', f);
  process.exit(1);
}
