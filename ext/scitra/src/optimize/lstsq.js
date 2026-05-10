// Nonlinear least squares — Levenberg-Marquardt + curve_fit wrapper.
//
// Mirrors scipy.optimize.least_squares (LM-only for v0.1) and
// scipy.optimize.curve_fit. v0.1 ships:
//   • Unbounded LM (no box constraints)
//   • Numerical Jacobian via forward differences (analytic Jacobian
//     accepted via opts.jac)
//   • Exit codes mirror scipy's status field: 0 max iter, 1 gradient
//     tol, 2 parameter tol, 3 residual tol, -1 fatal error
//
// Algorithm (Marquardt 1963):
//   r = f(x)
//   J = ∂r/∂x
//   solve (JᵀJ + λ diag(JᵀJ)) δ = -Jᵀr     ← scipy's "scaled-LM" form
//   if rho > 0: accept, λ = max(λ/ν, λmin)
//   else: reject, λ = min(λ*ν, λmax)
// We use the more standard λI form below since it converges fine for
// well-conditioned problems and is simpler to reason about.

// Solve (A + λI) δ = b in-place via Cholesky. A is m×m (flat row-major).
// Returns δ as Float64Array, or null if not positive-definite (caller
// should bump λ and retry).
function _cholSolve(A, b, m, lambda) {
  const L = new Float64Array(m * m);
  // Compute A_aug = A + λI in L (Cholesky destination).
  for (let i = 0; i < m; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * m + j];
      if (i === j) s += lambda;
      for (let k = 0; k < j; k++) s -= L[i * m + k] * L[j * m + k];
      if (i === j) {
        if (s <= 0) return null;  // not PD
        L[i * m + j] = Math.sqrt(s);
      } else {
        L[i * m + j] = s / L[j * m + j];
      }
    }
  }
  // Forward substitute: L y = b
  const y = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * m + k] * y[k];
    y[i] = s / L[i * m + i];
  }
  // Back substitute: Lᵀ x = y
  const x = new Float64Array(m);
  for (let i = m - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < m; k++) s -= L[k * m + i] * x[k];
    x[i] = s / L[i * m + i];
  }
  return x;
}

// Numerical Jacobian via forward differences.
// J[i,j] = (f(x + h e_j)[i] - f(x)[i]) / h
function _numJac(fun, x, fx, opts) {
  const n = x.length;
  const m = fx.length;
  const J = new Float64Array(m * n);
  const eps = opts && opts.diff_step !== undefined ? opts.diff_step : Math.sqrt(Number.EPSILON);
  const xp = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    for (let k = 0; k < n; k++) xp[k] = x[k];
    const h = Math.max(Math.abs(x[j]), 1) * eps;
    xp[j] = x[j] + h;
    const fxp = fun(xp);
    for (let i = 0; i < m; i++) J[i * n + j] = (fxp[i] - fx[i]) / h;
  }
  return J;
}

// JᵀJ — n×n result, J is m×n
function _jtj(J, m, n) {
  const out = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = 0;
      for (let k = 0; k < m; k++) s += J[k * n + i] * J[k * n + j];
      out[i * n + j] = s;
      out[j * n + i] = s;
    }
  }
  return out;
}

// Jᵀr — n result, J is m×n, r is m
function _jtr(J, r, m, n) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < m; k++) s += J[k * n + i] * r[k];
    out[i] = s;
  }
  return out;
}

function _norm2sq(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return s;
}

function _toF64(x) {
  if (x instanceof Float64Array) return x;
  if (x && x.data instanceof Float64Array) return x.data;
  return Float64Array.from(x);
}

export function least_squares(fun, x0, opts = {}) {
  const x = Float64Array.from(_toF64(x0));
  const n = x.length;

  const jacFn = typeof opts.jac === 'function' ? opts.jac : null;
  const ftol = opts.ftol ?? 1e-8;
  const xtol = opts.xtol ?? 1e-8;
  const gtol = opts.gtol ?? 1e-8;
  const maxNfev = opts.max_nfev ?? 100 * n;
  const verbose = opts.verbose ?? 0;

  // Apply args trick: many problems pass extra arguments via closures, but
  // mirror scipy's `args` shorthand.
  const args = opts.args || [];
  const evaluate = args.length > 0
    ? (xx) => _toF64(fun(xx, ...args))
    : (xx) => _toF64(fun(xx));
  const evalJac = args.length > 0
    ? (jacFn ? (xx) => _toF64(jacFn(xx, ...args)) : null)
    : (jacFn ? (xx) => _toF64(jacFn(xx)) : null);

  let nfev = 0, njev = 0;
  let r = evaluate(x); nfev++;
  const m = r.length;
  if (m < n) {
    throw new Error(`least_squares requires m ≥ n (got m=${m}, n=${n})`);
  }
  let cost = 0.5 * _norm2sq(r);

  // Initial Jacobian
  let J;
  if (evalJac) {
    J = evalJac(x);
    if (J.length !== m * n) throw new Error(`jac shape mismatch: ${J.length} vs ${m * n}`);
    njev++;
  } else {
    J = _numJac(evaluate, x, r, opts);
    nfev += n;
  }

  let lambda = opts.lambda0 ?? 1e-3;
  const lambdaInc = 10;
  const lambdaDec = 10;
  const lambdaMin = 1e-12;
  const lambdaMax = 1e12;

  let status = 0;       // 0 = max iter (default)
  let iter = 0;

  while (true) {
    if (nfev >= maxNfev) { status = 0; break; }

    const A = _jtj(J, m, n);
    const g = _jtr(J, r, m, n);

    // Gradient norm convergence: ‖Jᵀr‖_∞ < gtol
    let gMax = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(g[i]);
      if (a > gMax) gMax = a;
    }
    if (gMax < gtol) { status = 1; break; }

    // Solve (A + λI) δ = -g
    let deltaTried = false;
    let xNew, rNew, costNew, accepted = false;
    while (!accepted) {
      const negG = new Float64Array(n);
      for (let i = 0; i < n; i++) negG[i] = -g[i];
      const delta = _cholSolve(A, negG, n, lambda);
      if (!delta) {
        lambda = Math.min(lambda * lambdaInc, lambdaMax);
        if (lambda >= lambdaMax) { status = -1; break; }
        continue;
      }
      deltaTried = true;
      // Check parameter step convergence
      let stepNorm = 0, xNorm = 0;
      for (let i = 0; i < n; i++) { stepNorm += delta[i] * delta[i]; xNorm += x[i] * x[i]; }
      stepNorm = Math.sqrt(stepNorm);
      xNorm = Math.sqrt(xNorm);
      if (stepNorm < xtol * (xNorm + xtol)) { status = 2; break; }

      xNew = new Float64Array(n);
      for (let i = 0; i < n; i++) xNew[i] = x[i] + delta[i];
      rNew = evaluate(xNew); nfev++;
      costNew = 0.5 * _norm2sq(rNew);

      if (costNew < cost) {
        // Accept; reduce λ for next iteration
        accepted = true;
        lambda = Math.max(lambda / lambdaDec, lambdaMin);
        // Residual-tol convergence
        if (Math.abs(cost - costNew) < ftol * cost) { status = 3; }
      } else {
        // Reject; increase λ and retry
        lambda = Math.min(lambda * lambdaInc, lambdaMax);
        if (lambda >= lambdaMax) { status = -1; break; }
      }
    }

    if (status !== 0 && status !== -1) {
      // Apply the step and exit
      if (accepted) {
        for (let i = 0; i < n; i++) x[i] = xNew[i];
        r = rNew;
        cost = costNew;
      }
      break;
    }
    if (status === -1) break;

    // Apply step
    for (let i = 0; i < n; i++) x[i] = xNew[i];
    r = rNew;
    cost = costNew;

    // Recompute Jacobian
    if (evalJac) { J = evalJac(x); njev++; }
    else { J = _numJac(evaluate, x, r, opts); nfev += n; }

    iter++;
    if (verbose >= 2) {
      const gNorm = Math.sqrt(_norm2sq(g));
      console.log(`iter=${iter} cost=${cost.toExponential(4)} |g|=${gNorm.toExponential(2)} λ=${lambda.toExponential(2)}`);
    }
  }

  return {
    x,
    fun: r,
    cost,
    jac: J,
    nfev,
    njev,
    status,
    success: status > 0,
    message: _statusMessage(status),
    optimality: _gradMaxAbs(_jtr(J, r, m, n)),
  };
}

function _gradMaxAbs(g) {
  let m = 0;
  for (let i = 0; i < g.length; i++) {
    const a = Math.abs(g[i]); if (a > m) m = a;
  }
  return m;
}

function _statusMessage(s) {
  switch (s) {
    case 0: return 'maximum number of function evaluations reached';
    case 1: return '`gtol` termination condition is satisfied';
    case 2: return '`xtol` termination condition is satisfied';
    case 3: return '`ftol` termination condition is satisfied';
    case -1: return 'numerical breakdown (lambda saturated)';
    default: return 'unknown';
  }
}

// curve_fit — high-level wrapper over least_squares.
// Mirrors scipy.optimize.curve_fit:
//   model: (xdata, ...params) → ydata
//   xdata: independent variable, shape (m,) or (m, k)
//   ydata: observed dependent variable, shape (m,)
//   p0:    initial parameter guess, shape (n,)
// Returns { popt, pcov, ... }
export function curve_fit(model, xdata, ydata, p0, opts = {}) {
  const ya = _toF64(ydata);
  const m = ya.length;
  const sigma = opts.sigma ? _toF64(opts.sigma) : null;

  // Residual function for least_squares.
  // r_i = (model(x_i, *p) - y_i) / sigma_i
  let xa;
  if (Array.isArray(xdata) && Array.isArray(xdata[0])) {
    // 2D: pass per-row to model
    xa = xdata;
  } else {
    xa = _toF64(xdata);
  }

  const residual = (params) => {
    const r = new Float64Array(m);
    if (Array.isArray(xa)) {
      // Multi-input; call model row-by-row
      for (let i = 0; i < m; i++) {
        const yi = model(xa[i], ...params);
        r[i] = sigma ? (yi - ya[i]) / sigma[i] : yi - ya[i];
      }
    } else {
      // Single-input; vectorize via per-element call (model can also accept arrays)
      const ymodel = model(xa, ...params);
      const ymf = _toF64(ymodel);
      for (let i = 0; i < m; i++) {
        r[i] = sigma ? (ymf[i] - ya[i]) / sigma[i] : ymf[i] - ya[i];
      }
    }
    return r;
  };

  const result = least_squares(residual, p0, opts);

  // Covariance estimate: pcov ≈ s² (JᵀJ)⁻¹  where s² = 2*cost / (m - n)
  const n = result.x.length;
  let pcov = null;
  if (m > n) {
    const A = _jtj(result.jac, m, n);
    const I = new Float64Array(n);
    pcov = new Float64Array(n * n);
    // Invert A column-by-column via Cholesky solve
    for (let j = 0; j < n; j++) {
      const e = new Float64Array(n);
      e[j] = 1;
      const col = _cholSolve(A, e, n, 0);
      if (!col) { pcov = null; break; }
      for (let i = 0; i < n; i++) pcov[i * n + j] = col[i];
    }
    if (pcov) {
      const s2 = sigma ? 1 : (2 * result.cost) / (m - n);
      for (let i = 0; i < pcov.length; i++) pcov[i] *= s2;
    }
  }

  return {
    popt: result.x,
    pcov,
    nfev: result.nfev,
    njev: result.njev,
    status: result.status,
    success: result.success,
    message: result.message,
    cost: result.cost,
  };
}
