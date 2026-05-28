// @gcu/patchbay — the `pb` display library. Module-sized, style-aware
// visualizations drawn into a module's display rect (world coords; the canvas
// transform is already in world space when run() is called). Reactive by virtue
// of the render loop: values are read each frame and passed in via `out`.
//
// Intentionally constrained — there is no general-purpose chart. If you want a
// real plot in a module you're using the wrong surface; keep it in a cell.

// 7-segment lit-segment maps.
const SEG7 = {
  '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc',
  '5': 'afgcd', '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg',
  '-': 'g', ' ': '', '.': '',
};

export function createPb(ctx) {
  let rect, style, colors, accent, cursor;

  const col = (name) => (name && colors[name]) || name || accent;
  const c01 = (v) => Math.max(0, Math.min(1, v));

  // Reserve a sub-rect: explicit {x,y,w,h} (rect-local) or auto-stack downward.
  // Auto-stacked slots clamp to the remaining display band, so a primitive can
  // ask for a tall slot (e.g. a full-height trend) and get the available space.
  function slot(opts, defH) {
    if (opts && Number.isFinite(opts.x)) {
      return { x: rect.x + opts.x, y: rect.y + opts.y, w: opts.w ?? rect.w, h: opts.h ?? defH };
    }
    const remaining = rect.y + rect.h - cursor.y - 2;
    const h = Math.max(8, Math.min((opts && opts.h) || defH, remaining));
    const s = { x: rect.x + 2, y: cursor.y, w: rect.w - 4, h };
    cursor.y += h + 3;
    return s;
  }

  function inset(s) {
    ctx.fillStyle = colors.bgDeep;
    ctx.fillRect(s.x, s.y, s.w, s.h);
    ctx.strokeStyle = colors.border; ctx.lineWidth = 1;
    ctx.strokeRect(s.x + 0.5, s.y + 0.5, s.w - 1, s.h - 1);
  }

  // ── primitives ──

  function led(value, opts = {}) {
    const s = slot(opts, 14);
    const c = col(opts.color);
    const on = typeof value === 'number' ? value : (value ? 1 : 0);
    const cx = s.x + 7, cy = s.y + s.h / 2, r = 5;
    if (style.led === 'pixel') {
      ctx.fillStyle = colors.bgDeep; ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
      ctx.globalAlpha = 0.25 + 0.75 * on; ctx.fillStyle = c;
      ctx.fillRect(cx - r + 1, cy - r + 1, r * 2 - 2, r * 2 - 2); ctx.globalAlpha = 1;
    } else {
      if (style.led === 'glow' && on > 0.05) {
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 2.4);
        g.addColorStop(0, c); g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.globalAlpha = 0.5 * on; ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(cx, cy, r * 2.4, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
      }
      ctx.fillStyle = colors.bgDeep; ctx.beginPath(); ctx.arc(cx, cy, r + 1, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.2 + 0.8 * on; ctx.fillStyle = c;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
      if (style.led === 'ring') { ctx.strokeStyle = c; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx, cy, r + 2, 0, Math.PI * 2); ctx.stroke(); }
    }
    if (opts.label) {
      ctx.fillStyle = colors.textSoft; ctx.font = '8px "Space Mono", monospace';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(String(opts.label).toUpperCase(), cx + r + 5, cy);
    }
  }

  function bargraph(value, opts = {}) {
    const steps = opts.steps || 8;
    const lo = opts.min ?? 0, hi = opts.max ?? 1;
    const frac = Math.max(0, Math.min(1, (value - lo) / (hi - lo || 1)));
    const lit = Math.round(frac * steps);
    const vert = opts.orient === 'v';
    const s = slot(opts, vert ? rect.h - cursor.y + rect.y - 2 : 12);
    inset(s);
    const gap = 2;
    if (vert) {
      const segH = (s.h - gap * (steps + 1)) / steps;
      for (let i = 0; i < steps; i++) {
        const on = i < lit;
        ctx.fillStyle = on ? (i >= steps - 2 ? colors.red : i >= steps - 4 ? colors.amber : colors.green) : colors.bgRaised;
        ctx.fillRect(s.x + gap, s.y + s.h - gap - (i + 1) * (segH + gap) + gap, s.w - gap * 2, segH);
      }
    } else {
      const segW = (s.w - gap * (steps + 1)) / steps;
      for (let i = 0; i < steps; i++) {
        const on = i < lit;
        ctx.fillStyle = on ? (i >= steps - 2 ? colors.red : i >= steps - 4 ? colors.amber : colors.green) : colors.bgRaised;
        ctx.fillRect(s.x + gap + i * (segW + gap), s.y + gap, segW, s.h - gap * 2);
      }
    }
  }

  // Strip-chart trend. Single series via `buffer`, or multiple colored pens via
  // opts.series = [{ data, color }]. Autoscales across all series unless
  // opts.min/max pin the range. opts: { grid, fill, labels, color, h }.
  function scope(buffer, opts = {}) {
    const s = slot(opts, opts.h || 40);
    inset(s);
    const series = opts.series && opts.series.length
      ? opts.series
      : [{ data: (buffer && buffer.length) ? buffer : [0], color: opts.color }];

    let lo = opts.min, hi = opts.max;
    if (lo == null || hi == null) {
      let mn = Infinity, mx = -Infinity;
      for (const ser of series) for (const v of ser.data) { if (v < mn) mn = v; if (v > mx) mx = v; }
      if (!isFinite(mn)) { mn = 0; mx = 1; }
      if (mn === mx) { mn -= 0.5; mx += 0.5; }
      if (lo == null) lo = mn;
      if (hi == null) hi = mx;
    }
    const ix = s.x + 2, iy = s.y + 2, iw = s.w - 4, ih = s.h - 4;
    const yOf = (v) => iy + ih - ih * c01((v - lo) / (hi - lo || 1));

    if (opts.grid !== false) {
      ctx.strokeStyle = colors.rule; ctx.lineWidth = 0.5; ctx.globalAlpha = 0.4;
      for (let i = 1; i < 4; i++) { const y = iy + ih * i / 4; ctx.beginPath(); ctx.moveTo(ix, y); ctx.lineTo(ix + iw, y); ctx.stroke(); }
      for (let i = 1; i < 6; i++) { const x = ix + iw * i / 6; ctx.beginPath(); ctx.moveTo(x, iy); ctx.lineTo(x, iy + ih); ctx.stroke(); }
      ctx.globalAlpha = 1;
    }

    for (const ser of series) {
      const data = ser.data; if (!data || !data.length) continue;
      const c = col(ser.color);
      const xOf = (i) => ix + iw * (i / (data.length - 1 || 1));
      if (opts.fill) {
        ctx.fillStyle = c; ctx.globalAlpha = 0.12;
        ctx.beginPath(); ctx.moveTo(ix, iy + ih);
        for (let i = 0; i < data.length; i++) ctx.lineTo(xOf(i), yOf(data[i]));
        ctx.lineTo(ix + iw, iy + ih); ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = c; ctx.lineWidth = 1.4; ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i < data.length; i++) { const x = xOf(i), y = yOf(data[i]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.stroke();
      // current-value marker at the right edge (the live pen tip)
      ctx.fillStyle = c; ctx.beginPath(); ctx.arc(ix + iw, yOf(data[data.length - 1]), 2, 0, Math.PI * 2); ctx.fill();
    }

    if (opts.labels !== false && ih > 24) {
      ctx.fillStyle = colors.textSoft; ctx.font = '7px "Space Mono", monospace'; ctx.textAlign = 'right';
      ctx.textBaseline = 'top'; ctx.fillText(hi.toFixed(2), ix + iw - 2, iy + 1);
      ctx.textBaseline = 'bottom'; ctx.fillText(lo.toFixed(2), ix + iw - 2, iy + ih - 1);
    }
  }

  function lcd(text, opts = {}) {
    const s = slot(opts, 18);
    const back = style.display === 'vfd' ? colors.bgDeep : style.display === 'crt' ? '#0a160a' : colors.bgDeep;
    ctx.fillStyle = back; ctx.fillRect(s.x, s.y, s.w, s.h);
    ctx.strokeStyle = colors.border; ctx.lineWidth = 1; ctx.strokeRect(s.x + 0.5, s.y + 0.5, s.w - 1, s.h - 1);
    const fg = opts.color ? col(opts.color) : style.display === 'vfd' ? colors.teal : style.display === 'crt' ? colors.green : colors.text;
    ctx.fillStyle = fg; ctx.font = `${Math.min(13, s.h - 6)}px "Space Mono", monospace`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(String(text), s.x + 5, s.y + s.h / 2);
  }

  function _draw7(s, ch, onColor) {
    const segs = SEG7[ch] || '';
    const w = s.w, h = s.h, t = Math.max(1.5, Math.min(w, h) * 0.13);
    const x = s.x, y = s.y, midY = y + h / 2;
    const off = colors.bgRaised;
    const hbar = (yy) => [x + t, yy - t / 2, w - 2 * t, t];
    const vbar = (xx, yy0, yy1) => [xx - t / 2, yy0 + t / 2, t, (yy1 - yy0) - t];
    const R = {
      a: hbar(y + t / 2), d: hbar(y + h - t / 2), g: hbar(midY),
      f: vbar(x + t / 2, y, midY), b: vbar(x + w - t / 2, y, midY),
      e: vbar(x + t / 2, midY, y + h), c: vbar(x + w - t / 2, midY, y + h),
    };
    for (const k of 'abcdefg') {
      ctx.fillStyle = segs.includes(k) ? onColor : off;
      ctx.globalAlpha = segs.includes(k) ? 1 : 0.22;
      const r = R[k]; ctx.fillRect(r[0], r[1], r[2], r[3]);
    }
    ctx.globalAlpha = 1;
  }

  function numeric(value, opts = {}) {
    const s = slot(opts, 26);
    inset(s);
    const decimals = opts.decimals ?? (Number.isInteger(value) ? 0 : 2);
    let str = (typeof value === 'number' && isFinite(value)) ? value.toFixed(decimals) : String(value);
    const digits = opts.digits || str.length;
    str = str.slice(0, digits).padStart(digits, ' ');
    const onColor = opts.color ? col(opts.color) : style.display === 'vfd' ? colors.teal : colors.amber;
    const pad = 4, dw = (s.w - pad * 2) / digits, dh = s.h - pad * 2;
    const cw = Math.min(dw - 3, dh * 0.6);
    let cx = s.x + pad;
    for (const ch of str) {
      _draw7({ x: cx + (dw - cw) / 2, y: s.y + pad, w: cw, h: dh }, ch, onColor);
      cx += dw;
    }
  }

  function dot(x, y, opts = {}) {
    const s = slot(opts, 36);
    inset(s);
    ctx.strokeStyle = colors.rule; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(s.x + s.w / 2, s.y + 2); ctx.lineTo(s.x + s.w / 2, s.y + s.h - 2);
    ctx.moveTo(s.x + 2, s.y + s.h / 2); ctx.lineTo(s.x + s.w - 2, s.y + s.h / 2); ctx.stroke();
    const px = s.x + 3 + (s.w - 6) * Math.max(0, Math.min(1, x));
    const py = s.y + s.h - 3 - (s.h - 6) * Math.max(0, Math.min(1, y));
    ctx.fillStyle = col(opts.color); ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2); ctx.fill();
  }

  function spectrum(values, opts = {}) {
    const s = slot(opts, 40);
    inset(s);
    const vals = values && values.length ? values : [0];
    const hi = opts.max ?? Math.max(1, ...vals);
    const n = vals.length, gap = 1, bw = (s.w - 4 - gap * (n - 1)) / n;
    for (let i = 0; i < n; i++) {
      const frac = Math.max(0, Math.min(1, vals[i] / (hi || 1)));
      const bh = (s.h - 4) * frac;
      ctx.fillStyle = col(opts.color);
      ctx.fillRect(s.x + 2 + i * (bw + gap), s.y + s.h - 2 - bh, bw, bh);
    }
  }

  function indicator(stateName, opts = {}) {
    const map = { ok: colors.green, warn: colors.amber, err: colors.red, off: colors.textSoft };
    led(1, { ...opts, color: map[stateName] || colors.textSoft });
  }

  // Analog-needle dial — the instrumentation signature. A 270°-sweep arc (gap
  // at the bottom), ticks, a colored value sweep, a needle, and a digital
  // value in the gap. Sized + centered to fit inside the inset (the arc spans
  // 2·r wide and ~1.71·r tall, including the lower arms).
  function gauge(value, opts = {}) {
    const pad = 10;
    const explicit = Number.isFinite(opts.x);
    const availW = explicit ? (opts.w ?? rect.w) : rect.w - 4;
    const capH = (explicit ? opts.h : opts.maxH) || 160;
    // Size the dial from the panel width (usually the binding constraint),
    // capped by maxH. Then make the inset exactly tall enough for the arc +
    // its lower arms + the readout — no dead space below.
    const rad = Math.max(8, Math.min((availW - 2 * pad) / 2, (capH - 2 * pad - 14) / 1.71));
    const needH = Math.round(pad + rad * 1.71 + 16);
    const s = explicit
      ? { x: rect.x + opts.x, y: rect.y + opts.y, w: availW, h: opts.h ?? needH }
      : slot({ h: needH }, needH);
    inset(s);
    const lo = opts.min ?? 0, hi = opts.max ?? 1;
    const frac = c01(((value || 0) - lo) / (hi - lo || 1));
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;   // 135° → 405° (270° sweep)
    const cx = s.x + s.w / 2;
    const cy = s.y + pad + rad;                       // top of arc sits `pad` below the inset top

    ctx.strokeStyle = colors.rule; ctx.lineWidth = 2.5; ctx.lineCap = 'butt';
    ctx.beginPath(); ctx.arc(cx, cy, rad, a0, a1); ctx.stroke();
    ctx.strokeStyle = colors.textSoft; ctx.lineWidth = 1;
    for (let i = 0; i <= 8; i++) {
      const a = a0 + (a1 - a0) * (i / 8), major = i % 2 === 0;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * (rad - (major ? 5 : 3)), cy + Math.sin(a) * (rad - (major ? 5 : 3)));
      ctx.lineTo(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
      ctx.stroke();
    }
    const va = a0 + (a1 - a0) * frac;
    ctx.strokeStyle = col(opts.color); ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(cx, cy, rad, a0, va); ctx.stroke();
    ctx.strokeStyle = colors.text; ctx.lineWidth = 2; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(va) * (rad - 3), cy + Math.sin(va) * (rad - 3)); ctx.stroke();
    ctx.fillStyle = colors.text; ctx.beginPath(); ctx.arc(cx, cy, 2.6, 0, Math.PI * 2); ctx.fill();
    // digital readout in the bottom gap
    ctx.fillStyle = col(opts.color); ctx.font = '10px "Space Mono", monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText((value == null ? 0 : value).toFixed(opts.decimals ?? 2), cx, cy + rad * 0.52);
  }

  const api = { led, bargraph, scope, lcd, numeric, dot, spectrum, indicator, gauge };

  function run(inst, r, out, st, themeColors, accentColor) {
    rect = r; style = st; colors = themeColors; accent = accentColor;
    cursor = { x: r.x + 2, y: r.y + 2 };
    inst.def.display(api, out, inst.state);
  }

  return { run, api };
}
