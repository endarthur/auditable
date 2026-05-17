// Colormaps — polynomial approximation (same as stdlib.js)

function _poly(coeffs, t) {
  let r = coeffs[coeffs.length - 1];
  for (let i = coeffs.length - 2; i >= 0; i--) r = r * t + coeffs[i];
  return r;
}

function _cmap(rC, gC, bC) {
  return (t) => {
    t = Math.max(0, Math.min(1, t));
    return `rgb(${Math.round(Math.max(0, Math.min(255, _poly(rC, t) * 255)))},${
      Math.round(Math.max(0, Math.min(255, _poly(gC, t) * 255)))},${
      Math.round(Math.max(0, Math.min(255, _poly(bC, t) * 255)))})`;
  };
}

// Direct-function colormaps for the easy ones — jet, gray, hot, cool
// are well-defined by closed-form ramps. Polynomial fits used only
// for perceptual maps (viridis/plasma/etc.) where the curve is
// non-trivial. Approximate fits — visual fidelity is "close enough"
// for notebook plots, not pixel-perfect against matplotlib.
function _rgb(r, g, b) {
  const cl = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return `rgb(${cl(r)},${cl(g)},${cl(b)})`;
}

const _cmaps = {
  viridis: _cmap(
    [0.267, 0.004, 5.294, -14.05, 8.5],
    [0.004, 1.384, 0.098, -2.74, 2.23],
    [0.329, 1.44, -5.11, 6.87, -3.57]
  ),
  coolwarm: _cmap(
    [0.23, 2.82, -4.67, 3.54, -0.93],
    [0.30, 1.26, -3.87, 6.49, -3.19],
    [0.75, 0.53, -3.04, 5.56, -2.82]
  ),
  turbo: _cmap(
    [0.19, 3.08, -3.92, 1.66],
    [0.08, 3.54, -8.42, 5.79],
    [0.58, -2.58, 7.52, -11.42, 6.88]
  ),
  // perceptual maps — single-color-family approximations
  plasma: _cmap(
    [0.05, 2.1, 0.9, -2.6, 1.5],
    [0.03, 0.0, 1.2, 0.4, -0.6],
    [0.53, -1.3, 0.6, 0.0, 0.0]
  ),
  inferno: _cmap(
    [0.0, 0.4, 4.0, -4.0, 1.0],
    [0.0, -0.6, 3.0, -1.5, 0.0],
    [0.0, 1.0, -3.0, 4.0, -1.4]
  ),
  magma: _cmap(
    [0.0, 0.4, 3.5, -3.5, 1.2],
    [0.0, -0.3, 1.8, -0.5, 0.0],
    [0.0, 1.6, -2.5, 1.0, 0.4]
  ),
  cividis: _cmap(
    [0.0, 0.3, 2.5, -2.5, 1.2],
    [0.13, 0.6, 1.5, -1.5, 0.5],
    [0.32, 1.1, -2.5, 0.5, 0.7]
  ),
  // direct-function ramps
  jet: (t) => {
    t = Math.max(0, Math.min(1, t));
    let r, g, b;
    if (t < 0.25) { r = 0; g = t * 4; b = 1; }
    else if (t < 0.5) { r = 0; g = 1; b = 1 - (t - 0.25) * 4; }
    else if (t < 0.75) { r = (t - 0.5) * 4; g = 1; b = 0; }
    else { r = 1; g = 1 - (t - 0.75) * 4; b = 0; }
    return _rgb(r, g, b);
  },
  gray: (t) => { t = Math.max(0, Math.min(1, t)); return _rgb(t, t, t); },
  Greys: (t) => { t = Math.max(0, Math.min(1, t)); return _rgb(1 - t, 1 - t, 1 - t); },
  hot: (t) => {
    t = Math.max(0, Math.min(1, t));
    return _rgb(Math.min(1, t * 3), Math.max(0, t * 3 - 1), Math.max(0, t * 3 - 2));
  },
  cool: (t) => { t = Math.max(0, Math.min(1, t)); return _rgb(t, 1 - t, 1); },
  spring: (t) => { t = Math.max(0, Math.min(1, t)); return _rgb(1, t, 1 - t); },
  summer: (t) => { t = Math.max(0, Math.min(1, t)); return _rgb(t, 0.5 + t * 0.5, 0.4); },
  autumn: (t) => { t = Math.max(0, Math.min(1, t)); return _rgb(1, t, 0); },
  winter: (t) => { t = Math.max(0, Math.min(1, t)); return _rgb(0, t, 1 - 0.5 * t); },
  // Named reversed variants — matplotlib's `_r` suffix convention
  viridis_r: (t) => _cmaps.viridis(1 - t),
  plasma_r: (t) => _cmaps.plasma(1 - t),
  inferno_r: (t) => _cmaps.inferno(1 - t),
  magma_r: (t) => _cmaps.magma(1 - t),
  jet_r: (t) => _cmaps.jet(1 - t),
  gray_r: (t) => _cmaps.gray(1 - t),
};

export function getCmap(name) {
  if (typeof name === 'function') return name;
  return _cmaps[name] || _cmaps.viridis;
}

export function cmapRgb(name, t) {
  return getCmap(name)(t);
}

export function renderColorbar(ctx, x, y, w, h, cmap, vmin, vmax, opts) {
  const cmapFn = getCmap(cmap);
  const n = Math.max(1, Math.floor(h));
  for (let i = 0; i < n; i++) {
    const t = 1 - i / (n - 1);
    ctx.fillStyle = cmapFn(t);
    ctx.fillRect(x, y + i, w, Math.ceil(h / n) + 1);
  }
  // tick labels
  const textColor = opts?.textColor || '#ccc';
  ctx.fillStyle = textColor;
  ctx.font = opts?.font || '10px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const nticks = opts?.nticks || 5;
  const fmt = opts?.format || ((v) => {
    const range = Math.abs(vmax - vmin);
    if (range === 0) return String(v);
    const mag = Math.log10(Math.max(Math.abs(vmin), Math.abs(vmax), 1e-30));
    if (mag > 6 || mag < -3) return v.toExponential(1);
    const dec = Math.max(0, -Math.floor(Math.log10(range)) + 1);
    return v.toFixed(Math.min(dec, 6));
  });
  for (let i = 0; i < nticks; i++) {
    const t = i / (nticks - 1);
    const val = vmin + (1 - t) * (vmax - vmin);
    const ty = y + t * h;
    ctx.fillText(fmt(val), x + w + 4, ty);
  }
  // label
  if (opts?.label) {
    ctx.save();
    ctx.translate(x + w + 40, y + h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(opts.label, 0, 0);
    ctx.restore();
  }
}
