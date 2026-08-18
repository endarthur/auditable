// Colormaps — perceptual maps interpolate anchor stops sampled from the
// reference palettes (the retired polynomial fits went badly wrong at the
// ends: viridis(1) came out green, coolwarm(1) white).

function _lerpCmap(stops) {
  return (t) => {
    t = Math.max(0, Math.min(1, t));
    const x = t * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(x));
    const f = x - k;
    const c = [0, 1, 2].map((i) => Math.round(stops[k][i] + (stops[k + 1][i] - stops[k][i]) * f));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  };
}

// Direct-function colormaps for the easy ones — jet, gray, hot, cool
// are well-defined by closed-form ramps.
function _rgb(r, g, b) {
  const cl = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return `rgb(${cl(r)},${cl(g)},${cl(b)})`;
}

const _cmaps = {
  viridis: _lerpCmap([
    [68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142], [33, 145, 140],
    [53, 183, 121], [109, 205, 89], [180, 222, 44], [253, 231, 37],
  ]),
  coolwarm: _lerpCmap([
    [59, 76, 192], [98, 130, 234], [141, 176, 254], [184, 208, 249], [221, 221, 221],
    [245, 196, 173], [244, 154, 123], [222, 96, 77], [180, 4, 38],
  ]),
  turbo: _lerpCmap([
    [48, 18, 59], [70, 107, 227], [40, 167, 221], [32, 229, 181], [110, 252, 107],
    [202, 240, 52], [253, 188, 39], [240, 96, 12], [122, 4, 3],
  ]),
  plasma: _lerpCmap([
    [13, 8, 135], [84, 2, 163], [139, 10, 165], [185, 50, 137], [219, 92, 104],
    [244, 136, 73], [254, 188, 43], [244, 238, 39], [240, 249, 33],
  ]),
  inferno: _lerpCmap([
    [0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66],
    [245, 125, 21], [250, 193, 39], [245, 240, 132], [252, 255, 164],
  ]),
  magma: _lerpCmap([
    [0, 0, 4], [40, 11, 84], [101, 21, 110], [158, 47, 127], [222, 73, 104],
    [247, 120, 107], [254, 176, 120], [254, 229, 160], [252, 253, 191],
  ]),
  cividis: _lerpCmap([
    [0, 32, 77], [26, 51, 105], [60, 77, 110], [92, 102, 112], [124, 123, 120],
    [155, 148, 115], [187, 173, 108], [222, 202, 92], [255, 234, 70],
  ]),
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
  // an array of colors is a categorical map (matplotlib's ListedColormap):
  // [0,1) splits into equal buckets, one color each
  if (Array.isArray(name)) {
    const n = name.length;
    return (t) => name[Math.max(0, Math.min(n - 1, Math.floor(Math.max(0, Math.min(1, t)) * n)))];
  }
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
