// scitra.optimize.least_squares + curve_fit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { least_squares, curve_fit } from '../ext/scitra/src/optimize/lstsq.js';

const close = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

// ── least_squares ────────────────────────────────────────────────────

test('least_squares: linear residual, 1 param', () => {
  // f(x) = x - 5; minimum at x = 5
  const r = least_squares((x) => [x[0] - 5], [0]);
  assert.ok(close(r.x[0], 5, 1e-6));
  assert.ok(r.success);
});

test('least_squares: 2 params, well-conditioned', () => {
  // r = [x - 3, y - 4]; minimum at (3, 4)
  const r = least_squares((p) => [p[0] - 3, p[1] - 4], [0, 0]);
  assert.ok(close(r.x[0], 3, 1e-6));
  assert.ok(close(r.x[1], 4, 1e-6));
  assert.ok(r.success);
  assert.ok(close(r.cost, 0, 1e-10));
});

test('least_squares: rosenbrock-like residual', () => {
  // Classic test: r = [10*(y - x²), 1 - x] ; minimum at (1, 1)
  const r = least_squares((p) => [
    10 * (p[1] - p[0] * p[0]),
    1 - p[0],
  ], [-1.2, 1.0]);
  assert.ok(close(r.x[0], 1, 1e-4), `x[0] = ${r.x[0]}`);
  assert.ok(close(r.x[1], 1, 1e-4), `x[1] = ${r.x[1]}`);
});

test('least_squares: nonlinear residual, exponential decay', () => {
  // Synthetic data: y = 2 * exp(-0.5 * t)
  const ts = [0, 1, 2, 3, 4, 5];
  const y_obs = ts.map((t) => 2 * Math.exp(-0.5 * t));
  // Fit y = a * exp(-b * t), starting from (1, 1)
  const r = least_squares(
    (p) => ts.map((t, i) => p[0] * Math.exp(-p[1] * t) - y_obs[i]),
    [1, 1],
  );
  assert.ok(close(r.x[0], 2, 1e-4), `a = ${r.x[0]}`);
  assert.ok(close(r.x[1], 0.5, 1e-4), `b = ${r.x[1]}`);
  assert.ok(r.success);
});

test('least_squares: accepts analytic Jacobian', () => {
  // r = [x - 3, y - 4]
  // J = [[1, 0], [0, 1]]
  const r = least_squares(
    (p) => [p[0] - 3, p[1] - 4],
    [0, 0],
    { jac: () => [1, 0, 0, 1] },
  );
  assert.ok(close(r.x[0], 3));
  assert.ok(close(r.x[1], 4));
  // Should evaluate Jacobian analytically (njev > 0, no extra fevals beyond residual)
  assert.ok(r.njev > 0);
});

test('least_squares: status codes', () => {
  // Already at the minimum → gtol exit (status 1)
  const r = least_squares((p) => [p[0]], [0]);
  assert.equal(r.status, 1);
});

test('least_squares: rejects m < n', () => {
  // 1 residual, 2 params
  assert.throws(() => least_squares((p) => [p[0] - p[1]], [0, 0]));
});

test('least_squares: passes args', () => {
  // r(p, target) = p - target; minimum at p = target
  const r = least_squares(
    (p, target) => [p[0] - target],
    [0],
    { args: [42] },
  );
  assert.ok(close(r.x[0], 42, 1e-6));
});

test('least_squares: respects max_nfev', () => {
  // Large maxNfev never an issue; force tiny budget
  const r = least_squares((p) => [p[0] - 5], [0], { max_nfev: 3 });
  assert.ok(r.nfev <= 5);  // some slack for the initial Jacobian fevals
});

// ── curve_fit ────────────────────────────────────────────────────────

test('curve_fit: linear y = a*x + b', () => {
  const xdata = [0, 1, 2, 3, 4];
  const ydata = [1, 3, 5, 7, 9];  // y = 2x + 1
  const model = (x, a, b) => xdata.map((xi) => a * xi + b);
  // Easier: write model so it accepts the x argument it was given
  const linModel = (x, a, b) => {
    if (Array.isArray(x) || ArrayBuffer.isView(x)) {
      return Array.from(x).map((xi) => a * xi + b);
    }
    return a * x + b;
  };
  const r = curve_fit(linModel, xdata, ydata, [0, 0]);
  assert.ok(close(r.popt[0], 2, 1e-6), `a = ${r.popt[0]}`);
  assert.ok(close(r.popt[1], 1, 1e-6), `b = ${r.popt[1]}`);
  assert.ok(r.success);
});

test('curve_fit: nonlinear y = a*exp(b*x)', () => {
  const xdata = [0, 1, 2, 3, 4];
  // True params: a=2, b=-0.5
  const ydata = xdata.map((x) => 2 * Math.exp(-0.5 * x));
  const model = (x, a, b) => {
    if (Array.isArray(x) || ArrayBuffer.isView(x)) {
      return Array.from(x).map((xi) => a * Math.exp(b * xi));
    }
    return a * Math.exp(b * x);
  };
  const r = curve_fit(model, xdata, ydata, [1, -0.1]);
  assert.ok(close(r.popt[0], 2, 1e-4));
  assert.ok(close(r.popt[1], -0.5, 1e-4));
});

test('curve_fit: with sigma weights', () => {
  const xdata = [0, 1, 2, 3, 4];
  const ydata = [1, 3, 5, 7, 9];
  const sigma = [1, 1, 1, 1, 1];  // uniform → same as no-sigma
  const linModel = (x, a, b) => {
    if (Array.isArray(x) || ArrayBuffer.isView(x)) {
      return Array.from(x).map((xi) => a * xi + b);
    }
    return a * x + b;
  };
  const r = curve_fit(linModel, xdata, ydata, [0, 0], { sigma });
  assert.ok(close(r.popt[0], 2, 1e-6));
});

test('curve_fit: returns covariance matrix', () => {
  // Add noise so the fit isn't exact and pcov is nontrivial
  const xdata = [];
  const ydata = [];
  let seed = 1;
  const rng = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < 20; i++) {
    xdata.push(i);
    ydata.push(2 * i + 1 + (rng() - 0.5) * 0.5);
  }
  const linModel = (x, a, b) => {
    if (Array.isArray(x) || ArrayBuffer.isView(x)) {
      return Array.from(x).map((xi) => a * xi + b);
    }
    return a * x + b;
  };
  const r = curve_fit(linModel, xdata, ydata, [0, 0]);
  assert.ok(r.pcov, 'expected pcov to be returned');
  assert.equal(r.pcov.length, 4);  // 2x2
  // Diagonal entries are variances → positive
  assert.ok(r.pcov[0] >= 0);
  assert.ok(r.pcov[3] >= 0);
});

test('curve_fit: gaussian peak', () => {
  // y = A * exp(-(x - μ)² / (2σ²))
  const xdata = [];
  const ydata = [];
  for (let i = 0; i <= 100; i++) {
    const x = -5 + 0.1 * i;
    xdata.push(x);
    ydata.push(3 * Math.exp(-((x - 1) ** 2) / (2 * 0.7 ** 2)));
  }
  const gauss = (x, A, mu, sigma) => {
    if (Array.isArray(x) || ArrayBuffer.isView(x)) {
      return Array.from(x).map((xi) => A * Math.exp(-((xi - mu) ** 2) / (2 * sigma ** 2)));
    }
    return A * Math.exp(-((x - mu) ** 2) / (2 * sigma ** 2));
  };
  const r = curve_fit(gauss, xdata, ydata, [1, 0, 1]);
  assert.ok(close(r.popt[0], 3, 1e-3), `A = ${r.popt[0]}`);
  assert.ok(close(r.popt[1], 1, 1e-3), `μ = ${r.popt[1]}`);
  assert.ok(close(Math.abs(r.popt[2]), 0.7, 1e-3), `σ = ${r.popt[2]}`);
});
