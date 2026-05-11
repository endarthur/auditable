"""scipy reference data for systematic scitra correctness sweep.

Generates JSON with reference values for:
  - util.special: erf, erfc, erfinv, ndtri, lgamma, gamma, lbeta
  - stats.norm: pdf, cdf, ppf, sf, isf at many points
  - stats.lognorm: pdf, cdf, ppf, sf, isf
  - stats descriptives: weighted_mean, weighted_var, percentile, median, ecdf
  - stats.histogram + np.histogram
  - stats.moments (mean, var, skewness, kurtosis)
  - stats.gaussian_kde: pdf, cdf
  - spatial.distance: cdist, pdist, squareform (multiple metrics)
  - optimize.least_squares + curve_fit results

Run: python test/perf_scipy_compare.py > /path/to/output.json
Consumed by test/scitra-correctness-sweep.mjs.
"""
import os
os.environ['OPENBLAS_NUM_THREADS'] = '1'
import json
import numpy as np
from scipy import special, stats
from scipy.spatial import distance as spdist
from scipy.optimize import least_squares, curve_fit


def fmt(x):
    """Format scalar or array for JSON-clean output."""
    if isinstance(x, np.ndarray):
        return x.tolist()
    if isinstance(x, (np.floating, np.integer)):
        return float(x)
    return x


results = {}

# ── util.special ─────────────────────────────────────────────────────

xs_erf = [-3, -2, -1.5, -1, -0.5, -0.1, 0, 0.1, 0.5, 1, 1.5, 2, 3]
results['special'] = {
    'xs_erf': xs_erf,
    'erf': fmt(special.erf(np.array(xs_erf))),
    'erfc': fmt(special.erfc(np.array(xs_erf))),
    'ps_ndtri': [0.001, 0.01, 0.025, 0.1, 0.25, 0.5, 0.75, 0.9, 0.975, 0.99, 0.999],
    'ndtri': fmt(special.ndtri([0.001, 0.01, 0.025, 0.1, 0.25, 0.5, 0.75, 0.9, 0.975, 0.99, 0.999])),
    'ys_erfinv': [-0.99, -0.9, -0.5, -0.1, 0, 0.1, 0.5, 0.9, 0.99],
    'erfinv': fmt(special.erfinv([-0.99, -0.9, -0.5, -0.1, 0, 0.1, 0.5, 0.9, 0.99])),
    'xs_gamma': [0.5, 1, 1.5, 2, 2.5, 3, 5, 10, 20],
    'lgamma': fmt(special.gammaln([0.5, 1, 1.5, 2, 2.5, 3, 5, 10, 20])),
    'gamma': fmt(special.gamma([0.5, 1, 1.5, 2, 2.5, 3, 5, 10, 20])),
    'ab_lbeta': [(1, 1), (2, 3), (0.5, 0.5), (10, 5), (3, 7)],
    'lbeta': [float(special.gammaln(a) + special.gammaln(b) - special.gammaln(a + b))
              for a, b in [(1, 1), (2, 3), (0.5, 0.5), (10, 5), (3, 7)]],
}

# ── stats.norm ───────────────────────────────────────────────────────

xs_norm = [-3, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 3]
ps_norm = [0.001, 0.01, 0.025, 0.1, 0.25, 0.5, 0.75, 0.9, 0.975, 0.99, 0.999]

results['norm_standard'] = {
    'xs': xs_norm,
    'pdf': fmt(stats.norm.pdf(xs_norm)),
    'cdf': fmt(stats.norm.cdf(xs_norm)),
    'sf':  fmt(stats.norm.sf(xs_norm)),
    'ps': ps_norm,
    'ppf': fmt(stats.norm.ppf(ps_norm)),
    'isf': fmt(stats.norm.isf(ps_norm)),
}

results['norm_loc2scale3'] = {
    'xs': xs_norm, 'loc': 2, 'scale': 3,
    'pdf': fmt(stats.norm.pdf(xs_norm, loc=2, scale=3)),
    'cdf': fmt(stats.norm.cdf(xs_norm, loc=2, scale=3)),
    'ppf': fmt(stats.norm.ppf(ps_norm, loc=2, scale=3)),
}

# ── stats.lognorm ─────────────────────────────────────────────────────

xs_lognorm = [0.1, 0.5, 1, 1.5, 2, 3, 5, 10]
results['lognorm_s1'] = {
    'xs': xs_lognorm, 's': 1.0, 'loc': 0, 'scale': 1,
    'pdf': fmt(stats.lognorm.pdf(xs_lognorm, s=1.0, loc=0, scale=1)),
    'cdf': fmt(stats.lognorm.cdf(xs_lognorm, s=1.0, loc=0, scale=1)),
    'ppf': fmt(stats.lognorm.ppf([0.1, 0.25, 0.5, 0.75, 0.9], s=1.0, loc=0, scale=1)),
}

results['lognorm_s05scale5'] = {
    'xs': xs_lognorm, 's': 0.5, 'loc': 0, 'scale': 5,
    'pdf': fmt(stats.lognorm.pdf(xs_lognorm, s=0.5, loc=0, scale=5)),
    'cdf': fmt(stats.lognorm.cdf(xs_lognorm, s=0.5, loc=0, scale=5)),
}

# ── stats descriptives ───────────────────────────────────────────────

rng = np.random.default_rng(1234)
x_simple = rng.standard_normal(100).tolist()  # n=100
x_weighted_vals = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
x_weighted_w = [1, 2, 1, 3, 1, 2, 1, 4, 1, 5]

# weighted_mean
def py_weighted_mean(x, w):
    return float(np.average(np.asarray(x), weights=np.asarray(w)))

def py_weighted_var(x, w, ddof=0):
    x = np.asarray(x); w = np.asarray(w)
    mean = np.average(x, weights=w)
    sw = w.sum()
    if sw - ddof <= 0: return float('nan')
    return float(np.sum(w * (x - mean)**2) / (sw - ddof))

results['descriptives'] = {
    'x_simple_mean': float(np.mean(x_simple)),
    'x_simple_var_ddof1': float(np.var(x_simple, ddof=1)),
    'x_simple_var_ddof0': float(np.var(x_simple, ddof=0)),
    'x_simple_std_ddof1': float(np.std(x_simple, ddof=1)),
    'x_simple_median': float(np.median(x_simple)),
    'x_simple_p25': float(np.percentile(x_simple, 25)),
    'x_simple_p75': float(np.percentile(x_simple, 75)),
    'x_simple_p99': float(np.percentile(x_simple, 99)),
    'x_simple_skew': float(stats.skew(x_simple)),
    'x_simple_kurt': float(stats.kurtosis(x_simple)),  # excess kurtosis by default
    'x_simple': x_simple,
    'x_weighted_vals': x_weighted_vals,
    'x_weighted_w': x_weighted_w,
    'x_weighted_mean': py_weighted_mean(x_weighted_vals, x_weighted_w),
    'x_weighted_var_ddof0': py_weighted_var(x_weighted_vals, x_weighted_w, 0),
    'x_weighted_var_ddof1': py_weighted_var(x_weighted_vals, x_weighted_w, 1),
}

# ── stats.histogram (np.histogram) ───────────────────────────────────

x_hist = rng.standard_normal(1000).tolist()
counts, edges = np.histogram(x_hist, bins=20, range=(-4, 4))
counts_d, edges_d = np.histogram(x_hist, bins=20, range=(-4, 4), density=True)
results['histogram'] = {
    'x': x_hist,
    'counts': counts.tolist(),
    'edges': edges.tolist(),
    'density_counts': counts_d.tolist(),
}

# ── stats.gaussian_kde ───────────────────────────────────────────────

data_kde = rng.standard_normal(200)
kde = stats.gaussian_kde(data_kde)  # default 'scott'
eval_pts = np.linspace(-3, 3, 13)
results['gaussian_kde'] = {
    'data': data_kde.tolist(),
    'eval_pts': eval_pts.tolist(),
    'pdf_scott': kde(eval_pts).tolist(),
    'factor_scott': float(kde.factor),
    'bandwidth_scott': float(kde.factor * data_kde.std(ddof=1)),
}

# ── spatial.distance ─────────────────────────────────────────────────

X = rng.standard_normal((10, 4))
Y = rng.standard_normal((6, 4))
results['cdist'] = {
    'X': X.tolist(), 'Y': Y.tolist(),
    'euclidean':   spdist.cdist(X, Y, 'euclidean').tolist(),
    'sqeuclidean': spdist.cdist(X, Y, 'sqeuclidean').tolist(),
    'cityblock':   spdist.cdist(X, Y, 'cityblock').tolist(),
    'chebyshev':   spdist.cdist(X, Y, 'chebyshev').tolist(),
    'cosine':      spdist.cdist(X, Y, 'cosine').tolist(),
    'minkowski_p3': spdist.cdist(X, Y, 'minkowski', p=3).tolist(),
}

results['pdist'] = {
    'X': X.tolist(),
    'euclidean':   spdist.pdist(X, 'euclidean').tolist(),
    'cityblock':   spdist.pdist(X, 'cityblock').tolist(),
    'chebyshev':   spdist.pdist(X, 'chebyshev').tolist(),
}
# squareform — convert pdist back to square
sq = spdist.squareform(spdist.pdist(X))
results['squareform'] = {
    'pdist_vec': spdist.pdist(X).tolist(),
    'square': sq.tolist(),
}

# ── optimize.least_squares ───────────────────────────────────────────

# Linear regression: y = 2x + 1 + noise
xs_lin = np.linspace(0, 10, 20)
ys_lin = 2 * xs_lin + 1 + rng.standard_normal(20) * 0.1

def lin_residual(p, xs, ys):
    return p[0] * xs + p[1] - ys

ls_lin = least_squares(lin_residual, [0, 0], args=(xs_lin, ys_lin))
results['least_squares_linear'] = {
    'xs': xs_lin.tolist(), 'ys': ys_lin.tolist(),
    'x_opt': ls_lin.x.tolist(),
    'cost': float(ls_lin.cost),
    'status': int(ls_lin.status),
}

# Nonlinear exponential decay: y = A·exp(-k·t)
ts_exp = np.linspace(0, 5, 30)
true_A, true_k = 2.5, 0.7
ys_exp = true_A * np.exp(-true_k * ts_exp) + rng.standard_normal(30) * 0.05

def exp_residual(p, ts, ys):
    return p[0] * np.exp(-p[1] * ts) - ys

ls_exp = least_squares(exp_residual, [1, 0.1], args=(ts_exp, ys_exp))
results['least_squares_exp'] = {
    'ts': ts_exp.tolist(), 'ys': ys_exp.tolist(),
    'true': [true_A, true_k],
    'x_opt': ls_exp.x.tolist(),
    'cost': float(ls_exp.cost),
}

# curve_fit (gaussian peak)
xs_cf = np.linspace(-5, 5, 50)
true_params = [3.0, 0.5, 1.2]  # A, mu, sigma
ys_cf = true_params[0] * np.exp(-((xs_cf - true_params[1])**2) / (2 * true_params[2]**2))
ys_cf += rng.standard_normal(50) * 0.02

def gauss(x, A, mu, sigma):
    return A * np.exp(-((x - mu)**2) / (2 * sigma**2))

popt, pcov = curve_fit(gauss, xs_cf, ys_cf, p0=[1, 0, 1])
results['curve_fit_gauss'] = {
    'xs': xs_cf.tolist(), 'ys': ys_cf.tolist(),
    'true': true_params,
    'popt': popt.tolist(),
    'pcov_diag': np.diag(pcov).tolist(),
}

print(json.dumps(results, indent=None))
