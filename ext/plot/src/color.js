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
