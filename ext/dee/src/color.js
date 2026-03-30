// @gcu/dee — color maps: continuous, categorical, palettes, colorbar

// ── named palettes (256 samples each, [r,g,b] 0-1) ──

const _palettes = {};

// Generate viridis-like palette (approximation)
function _viridis(t) {
  const r = 0.267 + t * (0.003 + t * (2.168 + t * (-5.044 + t * 2.163)));
  const g = 0.004 + t * (1.396 + t * (-1.118 + t * (0.546 - t * 0.453)));
  const b = 0.329 + t * (1.442 + t * (-4.894 + t * (6.560 - t * 3.110)));
  return [Math.max(0, Math.min(1, r)), Math.max(0, Math.min(1, g)), Math.max(0, Math.min(1, b))];
}

function _inferno(t) {
  const r = t < 0.5 ? t * 2.6 : 1.0 - (t - 0.8) * 3;
  const g = t < 0.3 ? 0 : t < 0.7 ? (t - 0.3) * 2.5 : 1.0;
  const b = t < 0.25 ? t * 3.2 : t < 0.5 ? 0.8 - (t - 0.25) * 2.4 : 0.2 - (t - 0.5) * 0.4;
  return [Math.max(0, Math.min(1, r)), Math.max(0, Math.min(1, g)), Math.max(0, Math.min(1, b))];
}

function _coolwarm(t) {
  const r = t < 0.5 ? 0.3 + t * 1.0 : 0.8 + (t - 0.5) * 0.4;
  const g = t < 0.5 ? 0.3 + t * 0.8 : 0.7 - (t - 0.5) * 1.4;
  const b = t < 0.5 ? 0.8 - t * 0.4 : 0.6 - (t - 0.5) * 1.2;
  return [Math.max(0, Math.min(1, r)), Math.max(0, Math.min(1, g)), Math.max(0, Math.min(1, b))];
}

function _turbo(t) {
  const r = 0.13572 + t * (4.61539 + t * (-42.6603 + t * (132.130 + t * (-152.548 + t * 56.298))));
  const g = 0.09140 + t * (2.26400 + t * (-14.0191 + t * (34.637 + t * (-38.073 + t * 14.178))));
  const b = 0.10667 + t * (12.5925 + t * (-60.5820 + t * (109.370 + t * (-83.440 + t * 21.798))));
  return [Math.max(0, Math.min(1, r)), Math.max(0, Math.min(1, g)), Math.max(0, Math.min(1, b))];
}

const _paletteFns = { viridis: _viridis, inferno: _inferno, coolwarm: _coolwarm, turbo: _turbo };

function _getPalette(name) {
  if (_palettes[name]) return _palettes[name];
  const fn = _paletteFns[name];
  if (!fn) return null;
  const p = new Float32Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = fn(i / 255);
    p[i * 3] = r; p[i * 3 + 1] = g; p[i * 3 + 2] = b;
  }
  _palettes[name] = p;
  return p;
}

// ── continuous color map ──

export function colorMap(opts) {
  const breaks = opts.breaks;
  const nBins = breaks.length + 1;
  const nanColor = opts.nanColor || [0.3, 0.3, 0.3];
  const palette = typeof opts.palette === 'string' ? _getPalette(opts.palette) : opts.palette;
  const belowColor = opts.belowColor || (palette ? [palette[0], palette[1], palette[2]] : [0.1, 0.1, 0.4]);
  const aboveColor = opts.aboveColor || (palette ? [palette[(255) * 3], palette[255 * 3 + 1], palette[255 * 3 + 2]] : [0.9, 0.1, 0.1]);

  function _binColor(binId) {
    if (binId === 255) return nanColor;
    if (!palette) return nanColor;
    const t = nBins > 1 ? (binId + 0.5) / nBins : 0.5;
    const idx = Math.min(255, Math.max(0, Math.round(t * 255)));
    return [palette[idx * 3], palette[idx * 3 + 1], palette[idx * 3 + 2]];
  }

  const cmap = {
    breaks, nBins, nanColor, palette,
    map(value) {
      if (isNaN(value)) return nanColor;
      if (value <= breaks[0]) return belowColor;
      if (value > breaks[breaks.length - 1]) return aboveColor;
      let bin = 0;
      for (let i = 0; i < breaks.length; i++) { if (value > breaks[i]) bin = i + 1; }
      return _binColor(bin);
    },
    mapBin(binId) { return _binColor(binId); },
    texture(THREE) {
      if (!THREE) return null;
      const data = new Uint8Array(nBins * 4);
      for (let i = 0; i < nBins; i++) {
        const [r, g, b] = _binColor(i);
        data[i * 4] = r * 255; data[i * 4 + 1] = g * 255; data[i * 4 + 2] = b * 255; data[i * 4 + 3] = 255;
      }
      const tex = new THREE.DataTexture(data, nBins, 1, THREE.RGBAFormat);
      tex.needsUpdate = true;
      return tex;
    },
  };
  return cmap;
}

// ── categorical color map ──

export function categoricalMap(opts) {
  const codes = opts.codes;
  const colors = opts.colors;
  const labels = opts.labels;
  const nanColor = opts.nanColor || [0.3, 0.3, 0.3];
  const codeToColor = new Map();
  for (let i = 0; i < codes.length; i++) {
    const c = colors[i];
    if (typeof c === 'number') {
      codeToColor.set(codes[i], [(c >> 16 & 0xFF) / 255, (c >> 8 & 0xFF) / 255, (c & 0xFF) / 255]);
    } else {
      codeToColor.set(codes[i], c);
    }
  }
  return {
    codes, colors, labels, nanColor,
    map(value) { return codeToColor.get(value) || nanColor; },
    mapBin(binId) { return codeToColor.get(binId) || nanColor; },
  };
}

// ── colorbar ──

export function colorBar(cmap, opts = {}) {
  const position = opts.position || 'right';
  const title = opts.title || '';
  const width = opts.width || 30;
  const tickCount = opts.tickCount || 6;
  const format = opts.format || (v => v.toPrecision(3));

  const container = document.createElement('div');
  container.style.cssText = `position:absolute;${position === 'right' ? 'right:10px;top:50%;transform:translateY(-50%)' : position === 'left' ? 'left:10px;top:50%;transform:translateY(-50%)' : 'bottom:10px;left:50%;transform:translateX(-50%)'};z-index:10;pointer-events:none;font:11px monospace;color:#ccc;`;

  const canvas = document.createElement('canvas');
  const height = 200;
  canvas.width = width; canvas.height = height;
  canvas.style.cssText = 'display:block;border:1px solid #444;';
  container.appendChild(canvas);

  if (title) {
    const t = document.createElement('div');
    t.textContent = title;
    t.style.cssText = 'text-align:center;margin-top:4px;font-size:11px;';
    container.appendChild(t);
  }

  function _draw(cm) {
    const ctx = canvas.getContext('2d');
    const nBins = cm.nBins || (cm.breaks ? cm.breaks.length + 1 : 10);
    for (let y = 0; y < height; y++) {
      const t = 1 - y / height;
      const binId = Math.min(nBins - 1, Math.floor(t * nBins));
      const [r, g, b] = cm.mapBin(binId);
      ctx.fillStyle = `rgb(${r * 255 | 0},${g * 255 | 0},${b * 255 | 0})`;
      ctx.fillRect(0, y, width, 1);
    }
    // ticks
    if (cm.breaks) {
      const lo = cm.breaks[0], hi = cm.breaks[cm.breaks.length - 1];
      // remove old tick labels
      container.querySelectorAll('.dee-tick').forEach(e => e.remove());
      const step = Math.max(1, Math.floor(cm.breaks.length / tickCount));
      for (let i = 0; i < cm.breaks.length; i += step) {
        const t = (cm.breaks[i] - lo) / (hi - lo);
        const y = (1 - t) * height;
        const label = document.createElement('div');
        label.className = 'dee-tick';
        label.textContent = format(cm.breaks[i]);
        label.style.cssText = `position:absolute;right:${width + 6}px;top:${y - 6}px;font-size:10px;white-space:nowrap;`;
        container.appendChild(label);
      }
    }
  }

  _draw(cmap);

  const bar = {
    element: container,
    update(newCmap) { _draw(newCmap); },
    dispose() { container.remove(); },
  };

  return bar;
}
