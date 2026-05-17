// Linear scale with Heckbert nice-number tick generation

function _niceNum(range, round) {
  const exp = Math.floor(Math.log10(range));
  const frac = range / Math.pow(10, exp);
  let nice;
  if (round) {
    if (frac < 1.5) nice = 1;
    else if (frac < 3) nice = 2;
    else if (frac < 7) nice = 5;
    else nice = 10;
  } else {
    if (frac <= 1) nice = 1;
    else if (frac <= 2) nice = 2;
    else if (frac <= 5) nice = 5;
    else nice = 10;
  }
  return nice * Math.pow(10, exp);
}

export class LinearScale {
  constructor(domain, range) {
    this.domain = domain;
    this.range = range;
  }

  transform(v) {
    const [d0, d1] = this.domain;
    const [r0, r1] = this.range;
    const dr = d1 - d0;
    if (dr === 0) return (r0 + r1) / 2;
    return r0 + (v - d0) / dr * (r1 - r0);
  }

  inverse(px) {
    const [d0, d1] = this.domain;
    const [r0, r1] = this.range;
    const rr = r1 - r0;
    if (rr === 0) return (d0 + d1) / 2;
    return d0 + (px - r0) / rr * (d1 - d0);
  }

  ticks(count) {
    if (count == null) count = 5;
    const [lo, hi] = this.domain;
    const range = _niceNum(hi - lo, false);
    const step = _niceNum(range / (count - 1), true);
    const start = Math.ceil(lo / step) * step;
    const end = Math.floor(hi / step) * step;
    const ticks = [];
    // safety: ensure finite loop
    if (step <= 0 || !isFinite(start) || !isFinite(end)) return [lo, hi];
    for (let v = start; v <= end + step * 0.5; v += step) {
      ticks.push(+v.toPrecision(12));
    }
    return ticks;
  }

  tickFormat() {
    const [lo, hi] = this.domain;
    const range = Math.abs(hi - lo);
    if (range === 0) return (v) => String(v);
    const mag = Math.log10(Math.max(Math.abs(lo), Math.abs(hi), 1e-30));
    if (mag > 6 || mag < -3) return (v) => v.toExponential(1);
    const dec = Math.max(0, -Math.floor(Math.log10(range)) + 1);
    return (v) => v.toFixed(Math.min(dec, 6));
  }
}

// Log10 scale — matplotlib's `set_xscale('log')` equivalent. Domain
// must be strictly positive; callers should clamp lo before passing.
// Ticks are integer powers of 10 within the domain.
export class LogScale {
  constructor(domain, range) {
    // Clamp lo to a tiny positive value if non-positive (defensive).
    const [d0, d1] = domain;
    this.domain = [d0 > 0 ? d0 : 1e-300, d1 > 0 ? d1 : 1];
    this.range = range;
  }

  transform(v) {
    const [d0, d1] = this.domain;
    const [r0, r1] = this.range;
    if (v <= 0) return r0;
    const l0 = Math.log10(d0);
    const l1 = Math.log10(d1);
    const dr = l1 - l0;
    if (dr === 0) return (r0 + r1) / 2;
    return r0 + (Math.log10(v) - l0) / dr * (r1 - r0);
  }

  inverse(px) {
    const [d0, d1] = this.domain;
    const [r0, r1] = this.range;
    const rr = r1 - r0;
    const l0 = Math.log10(d0);
    const l1 = Math.log10(d1);
    if (rr === 0) return Math.pow(10, (l0 + l1) / 2);
    return Math.pow(10, l0 + (px - r0) / rr * (l1 - l0));
  }

  ticks() {
    const [lo, hi] = this.domain;
    const loE = Math.ceil(Math.log10(lo));
    const hiE = Math.floor(Math.log10(hi));
    const ticks = [];
    // Limit decade-count so degenerate domains don't blow up.
    if (hiE - loE > 30) return [lo, hi];
    for (let e = loE; e <= hiE; e++) ticks.push(Math.pow(10, e));
    return ticks;
  }

  tickFormat() {
    return (v) => {
      const e = Math.round(Math.log10(v));
      // Pretty-print integer powers as 10^N.
      if (Math.abs(Math.pow(10, e) - v) / v < 1e-6) {
        if (e >= -3 && e <= 4) return Math.pow(10, e).toString();
        return '10^' + e;
      }
      return v.toExponential(1);
    };
  }
}
