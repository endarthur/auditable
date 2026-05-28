// @gcu/patchbay — canvas rack renderer. Ported from the v0 sketch
// (spec_inbox/surfaces/patchbay.html) but driven by engine instances + live
// signal values instead of hard-coded module data. Owns the view transform,
// auto-layout, cable verlet physics, drawing, and hit-testing geometry. The
// interaction layer (interact.js) calls its hit-tests and reads/sets the view.

import { getStyle } from './styles.js';

// Rack geometry (Eurorack-inspired, our own units).
export const HP = 14;          // px per HP slot
export const ROW_H = 300;      // 3U module height
export const ROW_1U_H = 100;   // 1U row height
export const RAIL_H = 14;      // visible rail thickness
export const ROW_GAP = 8;      // gap between adjacent rows
export const RAIL_LEFT = 80;   // x-origin of the HP grid

// Default color table — the GCU/Switchboard dark palette. The surface overrides
// this with live theme tokens (setColors). Role names are referenced by styles.
export const DEFAULT_COLORS = {
  bgDeep: '#0E1012', bg: '#15171A', bgRaised: '#1D2024', bgBright: '#25282D',
  text: '#DDDCDA', textMid: '#9E9C98', textSoft: '#6E6C68',
  border: '#2F3338', rule: '#3A3E44',
  orange: '#D4672E', teal: '#3A9BA3', green: '#5A9B5E',
  amber: '#C49540', red: '#D05048', indigo: '#7E86B8',
  jack: '#7E86B8',
};

const ACCENTS = ['orange', 'teal', 'green', 'amber', 'red', 'indigo'];

// Verlet cable params.
const SEGMENTS = 28, GRAVITY = 0.45, DAMPING = 0.93, ITER = 7;

function rrectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function darken(hex, a) {
  const c = hex.replace('#', '');
  const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
  return `rgb(${(r * (1 - a)) | 0},${(g * (1 - a)) | 0},${(b * (1 - a)) | 0})`;
}
function lighten(hex, a) {
  const c = hex.replace('#', '');
  const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
  return `rgb(${(r + (255 - r) * a) | 0},${(g + (255 - g) * a) | 0},${(b + (255 - b) * a) | 0})`;
}

const cableKey = (c) => `${c.from.id}:${c.from.port}->${c.to.id}:${c.to.port}`;

export function createRenderer(opts) {
  const { canvas, engine, pb = null } = opts;
  const ctx = canvas.getContext('2d');
  let rack = opts.rack || { hp: 64, rows: [{ kind: '3U' }, { kind: '3U' }] };
  let colors = { ...DEFAULT_COLORS, ...(opts.colors || {}) };

  let W = 0, H = 0, DPR = 1;
  const view = { scale: 1, tx: 0, ty: 0 };
  const _cablePts = new Map();   // cableKey → points[]
  const _layoutCache = new WeakMap();   // def → layout

  function accent(name) { return colors[name] || colors.indigo; }

  // Per-row y origins from the rack's row list.
  function rowYs() {
    const ys = [];
    let y = 100;
    for (const r of rack.rows) {
      ys.push(y);
      const h = r.kind === '1U' ? ROW_1U_H : ROW_H;
      y += h + 2 * RAIL_H + ROW_GAP;
    }
    return ys;
  }
  function rowHeight(i) { return (rack.rows[i] && rack.rows[i].kind === '1U') ? ROW_1U_H : ROW_H; }

  // The faceplate covers both rails (top of the top rail to bottom of the
  // bottom rail) — like a real Eurorack panel. Rails show only in empty HP
  // gaps; screws (drawMounts) sit on the faceplate over the rail holes.
  function moduleRect(inst) {
    const ys = rowYs();
    const x = RAIL_LEFT + inst.hpPos * HP;
    const rowY = ys[inst.row] != null ? ys[inst.row] : ys[0];
    const w = inst.def.hp * HP;
    const ch = rowHeight(inst.row);
    return { x, y: rowY - RAIL_H, w, h: ch + 2 * RAIL_H };
  }

  // Auto-layout: knob row near top, ports row near bottom, display band between.
  // Manual layout (def.layout) overrides element positions when present.
  function layoutFor(def) {
    let lay = _layoutCache.get(def);
    if (lay) return lay;
    const w = def.hp * HP;
    const ch = def.height === '1U' ? ROW_1U_H : ROW_H;
    const h = ch + 2 * RAIL_H;      // faceplate height (covers both rails)
    // Flow the panel vertically: a mounting strip over each rail (for the
    // screws), then header → knob row (only if knobs) → display (fills the
    // middle) → jacks just above the bottom mounting strip. The +RAIL_H on the
    // header keeps content clear of the top rail-cover strip.
    const headerBottom = RAIL_H + 58;   // title + subtitle + divider, below the top strip
    const jackY = h - RAIL_H - 36;      // jacks above the bottom rail-cover strip
    // Control band: knobs + interactive controls. Knobs/buttons/toggles/
    // switches sit in a short top row; faders are tall — they run down the
    // panel body (mixer-style), laid across the width.
    const cells = [];
    for (const k of def.knobs) cells.push({ kind: 'knob', name: k.name, label: k.label });
    for (const c of def.controls) cells.push({ kind: c.kind, name: c.name, label: c.label, count: c.count });
    const faders = cells.filter((c) => c.kind === 'fader');
    const others = cells.filter((c) => c.kind !== 'fader');
    const knobY = headerBottom + 26;
    others.forEach((cell, i) => { cell.x = (w * (i + 1)) / (others.length + 1); cell.y = knobY; });
    const fTop = others.length ? knobY + 24 : headerBottom + 10;
    const fBot = jackY - 18;
    faders.forEach((cell, i) => {
      cell.x = (w * (i + 1)) / (faders.length + 1);
      cell.y = (fTop + fBot) / 2;
      cell.h = Math.max(40, fBot - fTop);
    });
    const ports = [];
    const all = [
      ...def.inPorts.map((p) => ({ name: p.name, side: 'in' })),
      ...def.outPorts.map((p) => ({ name: p.name, side: 'out', cable: p.cable })),
    ];
    const nP = all.length;
    all.forEach((p, i) => {
      ports.push({ ...p, x: (w * (i + 1)) / (nP + 1), y: jackY });
    });
    // Faders occupy the body; no display band when present.
    const dispTop = others.length ? knobY + 28 : headerBottom + 8;
    const dispBottom = jackY - 16;   // leave room above the jack circles
    const display = { x: 14, y: dispTop, w: w - 28, h: faders.length ? 0 : Math.max(0, dispBottom - dispTop) };
    lay = { cells, ports, display };
    // Manual override (positions in panel-local px).
    if (def.layout && typeof def.layout === 'object') Object.assign(lay, def.layout);
    _layoutCache.set(def, lay);
    return lay;
  }

  function portLocal(inst, name, side) {
    const lay = layoutFor(inst.def);
    return lay.ports.find((p) => p.name === name && p.side === side) || null;
  }
  function portWorldPos(inst, name, side) {
    const p = portLocal(inst, name, side);
    if (!p) return null;
    const r = moduleRect(inst);
    return { x: r.x + p.x, y: r.y + p.y };
  }
  function refPos(ref, side) {
    const inst = engine.instances.get(ref.id);
    if (!inst) return null;
    return portWorldPos(inst, ref.port, side);
  }

  // ── view ──
  function resize() {
    DPR = (typeof devicePixelRatio !== 'undefined' && devicePixelRatio) || 1;
    W = canvas.clientWidth || canvas.width || 800;
    H = canvas.clientHeight || canvas.height || 600;
    canvas.width = W * DPR; canvas.height = H * DPR;
  }
  function screenToWorld(sx, sy) { return { x: (sx - view.tx) / view.scale, y: (sy - view.ty) / view.scale }; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function rackBBox() {
    const ys = rowYs();
    const lastY = ys[ys.length - 1] + rowHeight(rack.rows.length - 1);
    return {
      minX: RAIL_LEFT - 18, minY: ys[0] - RAIL_H - 18,
      maxX: RAIL_LEFT + rack.hp * HP + 18, maxY: lastY + RAIL_H + 18,
    };
  }
  function fitToViewport() {
    const b = rackBBox(), margin = 16;
    const wW = b.maxX - b.minX, wH = b.maxY - b.minY;
    view.scale = clamp(Math.min((W - margin * 2) / wW, (H - margin * 2) / wH), 0.3, 1.2);
    view.tx = (W - wW * view.scale) / 2 - b.minX * view.scale;
    view.ty = (H - wH * view.scale) / 2 - b.minY * view.scale;
  }

  // ── hit testing ──
  function findPortAt(wx, wy, inputType) {
    const screenR = inputType === 'touch' ? 22 : 14;
    const r = Math.max(11.5, screenR / view.scale), r2 = r * r;
    const list = [...engine.instances.values()];
    for (let i = list.length - 1; i >= 0; i--) {
      const inst = list[i];
      const lay = layoutFor(inst.def);
      const rect = moduleRect(inst);
      for (const p of lay.ports) {
        const dx = wx - (rect.x + p.x), dy = wy - (rect.y + p.y);
        if (dx * dx + dy * dy <= r2) return { id: inst.id, port: p.name, side: p.side };
      }
    }
    return null;
  }
  function findModuleAt(wx, wy) {
    const list = [...engine.instances.values()];
    for (let i = list.length - 1; i >= 0; i--) {
      const inst = list[i];
      const r = moduleRect(inst);
      if (wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h) return inst;
    }
    return null;
  }
  // Hit-test a control cell (knob/toggle/button/switch/fader). Returns
  // { id, name, kind } — interact.js dispatches by kind.
  function findControlAt(wx, wy) {
    const list = [...engine.instances.values()];
    for (let i = list.length - 1; i >= 0; i--) {
      const inst = list[i];
      const lay = layoutFor(inst.def);
      const rect = moduleRect(inst);
      for (const cell of lay.cells) {
        const dx = wx - (rect.x + cell.x), dy = wy - (rect.y + cell.y);
        if (cell.kind === 'fader') {
          if (Math.abs(dx) <= 11 && Math.abs(dy) <= (cell.h || 34) / 2 + 6) return { id: inst.id, name: cell.name, kind: cell.kind };
        } else if (dx * dx + dy * dy <= 17 * 17) {
          return { id: inst.id, name: cell.name, kind: cell.kind };
        }
      }
    }
    return null;
  }

  // ── grid snap (grid-only placement; row + hpPos) ──
  function overlaps(inst, row, hpPos) {
    const lo = hpPos, hi = hpPos + inst.def.hp;
    for (const other of engine.instances.values()) {
      if (other === inst) continue;
      if (other.row !== row) continue;
      const olo = other.hpPos, ohi = other.hpPos + other.def.hp;
      if (lo < ohi && hi > olo) return true;
    }
    return false;
  }
  function snapTarget(inst, wx, wy, grabHp = 0, grabY = 0) {
    const ys = rowYs();
    // Pick the row by where the module's row-top would LAND (cursor minus the
    // vertical grab offset), not the raw cursor — otherwise grabbing a panel's
    // lower half snaps it to the next row immediately.
    const topY = wy - grabY;
    let row = 0, bd = Infinity;
    for (let i = 0; i < ys.length; i++) { const d = Math.abs(topY - ys[i]); if (d < bd) { bd = d; row = i; } }
    const maxHp = rack.hp - inst.def.hp;
    const hpPos = clamp(Math.round((wx - RAIL_LEFT) / HP - grabHp), 0, Math.max(0, maxHp));
    return {
      row, hpPos, valid: !overlaps(inst, row, hpPos),
      // Ghost matches the faceplate extent (covers the rails).
      x: RAIL_LEFT + hpPos * HP, y: ys[row] - RAIL_H, w: inst.def.hp * HP, h: rowHeight(row) + 2 * RAIL_H,
    };
  }

  // ── cable verlet ──
  function _ensurePts(key, a, b) {
    let pts = _cablePts.get(key);
    if (pts) return pts;
    pts = [];
    for (let i = 0; i < SEGMENTS; i++) {
      const t = i / (SEGMENTS - 1);
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t + Math.sin(t * Math.PI) * 30;
      pts.push({ x, y, px: x, py: y });
    }
    _cablePts.set(key, pts);
    return pts;
  }
  function _relax(pts, aPos, bPos) {
    const N = pts.length;
    const dist = Math.hypot(bPos.x - aPos.x, bPos.y - aPos.y);
    const slack = Math.max(75, dist * 0.18);
    const segLen = (dist + slack) / (N - 1);
    for (let i = 1; i < N - 1; i++) {
      const p = pts[i];
      const vx = (p.x - p.px) * DAMPING, vy = (p.y - p.py) * DAMPING;
      p.px = p.x; p.py = p.y;
      p.x += vx; p.y += vy + GRAVITY;
    }
    pts[0].x = aPos.x; pts[0].y = aPos.y;
    pts[N - 1].x = bPos.x; pts[N - 1].y = bPos.y;
    for (let it = 0; it < ITER; it++) {
      pts[0].x = aPos.x; pts[0].y = aPos.y;
      pts[N - 1].x = bPos.x; pts[N - 1].y = bPos.y;
      for (let i = 0; i < N - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.0001;
        const k = ((d - segLen) / d) * 0.5;
        const ox = dx * k, oy = dy * k;
        if (i > 0) { a.x += ox; a.y += oy; }
        if (i < N - 2) { b.x -= ox; b.y -= oy; }
      }
    }
  }
  function updateCables(drag) {
    const live = new Set();
    for (const c of engine.cables) {
      const key = cableKey(c);
      live.add(key);
      const aPos = refPos(c.from, 'out'), bPos = refPos(c.to, 'in');
      if (!aPos || !bPos) continue;
      _relax(_ensurePts(key, aPos, bPos), aPos, bPos);
    }
    for (const key of [..._cablePts.keys()]) if (!live.has(key)) _cablePts.delete(key);
    if (drag) {
      const aPos = drag.from ? refPos(drag.from, 'out') : drag.mouse;
      const bPos = drag.to ? refPos(drag.to, 'in') : drag.mouse;
      if (aPos && bPos) _relax(_ensurePts('__drag__', aPos, bPos), aPos, bPos);
    } else {
      _cablePts.delete('__drag__');
    }
  }

  // ── drawing ──
  function drawBg() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.fillStyle = colors.bg; ctx.fillRect(0, 0, W, H);
    const sp = 26 * view.scale;
    if (sp >= 7) {
      ctx.fillStyle = colors.bgRaised;
      const ox = ((view.tx % sp) + sp) % sp, oy = ((view.ty % sp) + sp) % sp;
      for (let y = oy; y < H; y += sp) for (let x = ox; x < W; x += sp) ctx.fillRect(x, y, 1, 1);
    }
    ctx.setTransform(view.scale * DPR, 0, 0, view.scale * DPR, view.tx * DPR, view.ty * DPR);
  }
  function drawRail(x, y, w) {
    const g = ctx.createLinearGradient(0, y, 0, y + RAIL_H);
    g.addColorStop(0, '#3a3e44'); g.addColorStop(0.45, '#2d3137');
    g.addColorStop(0.55, '#252a30'); g.addColorStop(1, '#1a1d22');
    ctx.fillStyle = g; ctx.fillRect(x, y, w, RAIL_H);
    ctx.fillStyle = '#4a4e54'; ctx.fillRect(x, y, w, 1);
    ctx.fillStyle = '#0a0c0e'; ctx.fillRect(x, y + RAIL_H - 1, w, 1);
    const n = Math.round(w / HP);
    for (let i = 0; i < n; i++) {
      const cx = x + i * HP + HP / 2, cy = y + RAIL_H / 2;
      ctx.fillStyle = '#0a0c0e'; ctx.beginPath(); ctx.arc(cx, cy, 1.8, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#3f4348'; ctx.lineWidth = 0.5; ctx.beginPath(); ctx.arc(cx, cy, 1.8, 0, Math.PI * 2); ctx.stroke();
    }
  }
  function drawRack() {
    const ys = rowYs(), w = rack.hp * HP;
    for (let i = 0; i < rack.rows.length; i++) {
      const y = ys[i], h = rowHeight(i);
      ctx.fillStyle = colors.bgDeep; ctx.fillRect(RAIL_LEFT, y, w, h);
      const sg = ctx.createLinearGradient(0, y, 0, y + 12);
      sg.addColorStop(0, 'rgba(0,0,0,0.55)'); sg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = sg; ctx.fillRect(RAIL_LEFT, y, w, 12);
      drawRail(RAIL_LEFT, y - RAIL_H, w);
      drawRail(RAIL_LEFT, y + h, w);
    }
  }
  // A mounting screw seated in the rail. Drawn AFTER modules + rails, at the
  // rail↔panel boundary, so each module reads as bolted to the rail.
  function railScrew(x, y) {
    ctx.fillStyle = '#0a0c0e'; ctx.beginPath(); ctx.arc(x, y, 4.2, 0, Math.PI * 2); ctx.fill();   // recess
    const g = ctx.createRadialGradient(x - 1.4, y - 1.6, 0.4, x, y, 3.4);
    g.addColorStop(0, '#7a7e84'); g.addColorStop(0.6, '#4a4e54'); g.addColorStop(1, '#23262b');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 3.2, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#15171a'; ctx.lineWidth = 0.6; ctx.beginPath(); ctx.arc(x, y, 3.2, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = '#0a0c0e'; ctx.lineWidth = 1.1; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x - 2.1, y - 0.6); ctx.lineTo(x + 2.1, y + 0.6); ctx.stroke();    // slot
  }
  function drawMounts(inst) {
    if (!getStyle(inst.def.style).screws) return;
    const r = moduleRect(inst);
    // Screws on the faceplate's mounting strips, over the rail hole centres.
    // The rail holes are HP-grid-centred (drawRail), so align to HP centres
    // near each panel edge — the screw reads as going through the faceplate
    // into the rail beneath.
    const topY = r.y + RAIL_H / 2, botY = r.y + r.h - RAIL_H / 2;
    for (const sx of [r.x + HP / 2, r.x + r.w - HP / 2]) { railScrew(sx, topY); railScrew(sx, botY); }
  }
  function drawKnob(cx, cy, value, label, accentColor) {
    const r = 14;
    ctx.fillStyle = colors.bgDeep; ctx.beginPath(); ctx.arc(cx, cy, r + 2, 0, Math.PI * 2); ctx.fill();
    const g = ctx.createRadialGradient(cx - 4, cy - 5, 1, cx, cy, r);
    g.addColorStop(0, '#3a3f46'); g.addColorStop(1, colors.bg);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = colors.border; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    const start = Math.PI * 0.75, end = Math.PI * 2.25, a = start + (end - start) * clamp(value, 0, 1);
    ctx.strokeStyle = accentColor; ctx.lineWidth = 2.4; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * 3, cy + Math.sin(a) * 3);
    ctx.lineTo(cx + Math.cos(a) * (r - 2), cy + Math.sin(a) * (r - 2));
    ctx.stroke();
    ctx.fillStyle = colors.textSoft; ctx.font = '9px "Space Mono", monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(label, cx, cy + r + 4);
  }
  // ── interactive controls ──
  function drawToggle(cx, cy, on, label, accentColor) {
    const w = 26, h = 15;
    ctx.fillStyle = colors.bgDeep; rrectPath(ctx, cx - w / 2, cy - h / 2, w, h, 3); ctx.fill();
    ctx.strokeStyle = colors.border; ctx.lineWidth = 1; rrectPath(ctx, cx - w / 2 + 0.5, cy - h / 2 + 0.5, w - 1, h - 1, 3); ctx.stroke();
    const kx = on ? cx + w / 2 - 6 : cx - w / 2 + 6;
    ctx.fillStyle = on ? accentColor : colors.textSoft;
    ctx.beginPath(); ctx.arc(kx, cy, 5, 0, Math.PI * 2); ctx.fill();
    if (on) { ctx.globalAlpha = 0.18; ctx.fillStyle = accentColor; rrectPath(ctx, cx - w / 2, cy - h / 2, w, h, 3); ctx.fill(); ctx.globalAlpha = 1; }
    ctx.fillStyle = colors.textSoft; ctx.font = '8px "Space Mono", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(label, cx, cy + h / 2 + 4);
  }
  function drawButton(cx, cy, pressed, label, accentColor) {
    const r = 9;
    ctx.fillStyle = colors.bgDeep; ctx.beginPath(); ctx.arc(cx, cy, r + 2, 0, Math.PI * 2); ctx.fill();
    if (pressed) {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 1.8);
      g.addColorStop(0, accentColor); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = 0.5; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r * 1.8, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
    }
    const g2 = ctx.createRadialGradient(cx - 2, cy - 3, 1, cx, cy, r);
    g2.addColorStop(0, pressed ? accentColor : '#3a3f46'); g2.addColorStop(1, pressed ? darken(accentColor, 0.3) : colors.bg);
    ctx.fillStyle = g2; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = pressed ? accentColor : colors.border; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = colors.textSoft; ctx.font = '8px "Space Mono", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(label, cx, cy + r + 5);
  }
  function drawSwitch(cx, cy, idx, count, label, accentColor) {
    const n = Math.max(2, count || 2), w = Math.min(30, 7 * n), x0 = cx - w / 2, pip = w / n;
    ctx.fillStyle = colors.bgDeep; rrectPath(ctx, x0, cy - 7, w, 14, 3); ctx.fill();
    ctx.strokeStyle = colors.border; ctx.lineWidth = 1; rrectPath(ctx, x0 + 0.5, cy - 6.5, w - 1, 13, 3); ctx.stroke();
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = i === idx ? accentColor : colors.textSoft;
      ctx.globalAlpha = i === idx ? 1 : 0.35;
      ctx.beginPath(); ctx.arc(x0 + pip * (i + 0.5), cy, 2.4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = colors.textSoft; ctx.font = '8px "Space Mono", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(label, cx, cy + 11);
  }
  function drawFader(cx, cy, frac, label, accentColor, hh) {
    const h = hh || 34, w = 6, x = cx, y0 = cy - h / 2, y1 = cy + h / 2;
    ctx.strokeStyle = colors.bgDeep; ctx.lineWidth = w; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
    const hy = y1 - h * clamp(frac, 0, 1);
    ctx.strokeStyle = accentColor; ctx.lineWidth = w - 2;
    ctx.beginPath(); ctx.moveTo(x, y1); ctx.lineTo(x, hy); ctx.stroke();
    ctx.fillStyle = colors.text; rrectPath(ctx, x - 7, hy - 3.5, 14, 7, 2); ctx.fill();
    ctx.strokeStyle = colors.border; ctx.lineWidth = 1; rrectPath(ctx, x - 7, hy - 3.5, 14, 7, 2); ctx.stroke();
    ctx.fillStyle = colors.textSoft; ctx.font = '8px "Space Mono", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(label, cx, y1 + 4);
  }
  function drawPort(x, y, p, hovered) {
    const col = p.side === 'out' ? accent(p._accent || 'indigo') : colors.jack;
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, 8.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = colors.bgDeep; ctx.beginPath(); ctx.arc(x, y, 6.5, 0, Math.PI * 2); ctx.fill();
    const g = ctx.createRadialGradient(x, y - 1, 0, x, y, 5);
    g.addColorStop(0, colors.bgRaised); g.addColorStop(1, '#000');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fill();
    if (hovered) {
      ctx.strokeStyle = colors.text; ctx.lineWidth = 2 / view.scale;
      ctx.beginPath(); ctx.arc(x, y, 11.5, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.fillStyle = p.side === 'out' ? col : colors.textSoft;
    ctx.font = '8.5px "Space Mono", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(String(p.name).toUpperCase(), x, y + 11);
  }
  function drawModule(inst, hoveredPort, selected) {
    const r = moduleRect(inst), lay = layoutFor(inst.def), style = getStyle(inst.def.style);
    const bandColor = accent(inst.def.color);
    const g = ctx.createLinearGradient(r.x, r.y, r.x, r.y + r.h);
    g.addColorStop(0, colors[style.panel.top] || colors.bgBright);
    g.addColorStop(1, colors[style.panel.bottom] || colors.bgRaised);
    ctx.fillStyle = g; rrectPath(ctx, r.x, r.y, r.w, r.h, 2); ctx.fill();
    // Seated seam: a dark line along the top + bottom edges where the panel
    // tucks under the rail — reads as recessed into the rack, not a card laid
    // on top. (No drop shadow, for the same reason.)
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(r.x, r.y, r.w, 1.5); ctx.fillRect(r.x, r.y + r.h - 1.5, r.w, 1.5);
    ctx.strokeStyle = selected ? bandColor : (colors[style.panel.edge] || colors.border);
    ctx.lineWidth = selected ? 1.5 : 1; rrectPath(ctx, r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, 2); ctx.stroke();
    // Header content sits below the top rail-cover/mounting strip (RAIL_H).
    if (style.accentStripe) {
      let sc = bandColor;
      if (_showFlow) { const a = _moduleActivity(inst); if (a > 0.05) sc = lighten(bandColor, 0.5 * a); }
      ctx.fillStyle = sc; ctx.fillRect(r.x + 3, r.y + RAIL_H + 3, r.w - 6, 2.5);
    }
    const headerColor = style.headerColor === 'accent' ? bandColor : (colors[style.headerColor] || colors.text);
    ctx.fillStyle = headerColor; ctx.font = style.headerFont; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(inst.def.title, r.x + r.w / 2, r.y + RAIL_H + 16);
    if (inst.def.subtitle) {
      ctx.fillStyle = colors.textSoft; ctx.font = style.labelFont;
      ctx.fillText(inst.def.subtitle.toUpperCase(), r.x + r.w / 2, r.y + RAIL_H + 38);
    }
    ctx.strokeStyle = colors.rule; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(r.x + 18, r.y + RAIL_H + 56); ctx.lineTo(r.x + r.w - 18, r.y + RAIL_H + 56); ctx.stroke();
    // display band — pb (Phase C). Guarded so Phase B renders without it.
    if (pb && inst.def.display && lay.display.h > 4) {
      try {
        const out = {}; for (const n in inst.outputs) out[n] = inst.outputs[n].read();
        pb.run(inst, { x: r.x + lay.display.x, y: r.y + lay.display.y, w: lay.display.w, h: lay.display.h },
          out, style, colors, bandColor);
      } catch (e) { /* display errors never break the rack */ }
    }
    for (const cell of lay.cells) {
      const cx = r.x + cell.x, cy = r.y + cell.y;
      if (cell.kind === 'knob') {
        // Normalize by the knob's declared range so the needle reflects value
        // for non-0..1 knobs (gain 0..4, pid gains, …) — drawKnob expects 0..1.
        const kd = inst.def.knobs.find((d) => d.name === cell.name);
        const raw = engine.knobValue(inst.id, cell.name);
        const norm = (kd && kd.max !== kd.min) ? (raw - kd.min) / (kd.max - kd.min) : raw;
        drawKnob(cx, cy, norm, cell.label, bandColor);
      } else if (cell.kind === 'toggle') {
        drawToggle(cx, cy, engine.controlValue(inst.id, cell.name) ? 1 : 0, cell.label, bandColor);
      } else if (cell.kind === 'button') {
        drawButton(cx, cy, engine.controlValue(inst.id, cell.name) ? 1 : 0, cell.label, bandColor);
      } else if (cell.kind === 'switch') {
        drawSwitch(cx, cy, engine.controlValue(inst.id, cell.name) | 0, cell.count, cell.label, bandColor);
      } else if (cell.kind === 'fader') {
        const cd = inst.def.controls.find((d) => d.name === cell.name);
        const raw = engine.controlValue(inst.id, cell.name);
        const frac = (cd && cd.max !== cd.min) ? (raw - cd.min) / (cd.max - cd.min) : raw;
        drawFader(cx, cy, frac, cell.label, bandColor, cell.h);
      }
    }
    for (const p of lay.ports) {
      p._accent = inst.def.color;
      const hov = hoveredPort && hoveredPort.id === inst.id && hoveredPort.port === p.name && hoveredPort.side === p.side;
      drawPort(r.x + p.x, r.y + p.y, p, hov);
    }
  }
  function drawCableStroke(pts, color) {
    if (pts.length < 2) return;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 7.5;
    ctx.beginPath(); ctx.moveTo(pts[0].x + 3, pts[0].y + 6);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x + 3, pts[i].y + 6);
    ctx.stroke();
    for (const [w, c] of [[6.6, darken(color, 0.6)], [4.2, color]]) {
      ctx.strokeStyle = c; ctx.lineWidth = w;
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
    ctx.strokeStyle = lighten(color, 0.32); ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y - 1.3);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y - 1.3);
    ctx.stroke();
    drawPlug(pts[0].x, pts[0].y, color); drawPlug(pts[pts.length - 1].x, pts[pts.length - 1].y, color);
  }
  function drawPlug(x, y, color) {
    ctx.fillStyle = darken(color, 0.65); ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = lighten(color, 0.45); ctx.beginPath(); ctx.arc(x - 0.9, y - 0.9, 0.95, 0, Math.PI * 2); ctx.fill();
  }
  function cableColor(c) {
    if (c.color) return accent(c.color);
    const inst = engine.instances.get(c.from.id);
    return inst ? accent(inst.color || inst.def.color) : colors.textMid;
  }
  // Hit-test a cable by distance from its rendered polyline (for delete).
  function findCableAt(wx, wy) {
    const tol = Math.pow(Math.max(7, 10 / view.scale), 2);
    for (let ci = engine.cables.length - 1; ci >= 0; ci--) {
      const pts = _cablePts.get(cableKey(engine.cables[ci]));
      if (!pts) continue;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const dx = b.x - a.x, dy = b.y - a.y;
        const L2 = dx * dx + dy * dy || 1;
        let t = ((wx - a.x) * dx + (wy - a.y) * dy) / L2;
        t = Math.max(0, Math.min(1, t));
        const px = a.x + dx * t, py = a.y + dy * t;
        const d2 = (wx - px) * (wx - px) + (wy - py) * (wy - py);
        if (d2 <= tol) return engine.cables[ci];
      }
    }
    return null;
  }
  function drawDragGhost(ghost) {
    if (!ghost) return;
    ctx.save(); ctx.lineWidth = 2 / view.scale;
    ctx.strokeStyle = ghost.valid ? colors.orange : colors.red;
    ctx.fillStyle = ghost.valid ? 'rgba(212,103,46,0.10)' : 'rgba(208,80,72,0.10)';
    rrectPath(ctx, ghost.x, ghost.y, ghost.w, ghost.h, 4); ctx.fill(); ctx.stroke(); ctx.restore();
  }

  // ── signal-flow activity (show-the-flow) ──
  // Per output port: how recently its value changed (1 on change, decays). The
  // cable beads + stripe pulse read from this, so the rack visibly carries the
  // signal — the cable IS the dependency.
  const perfNow = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
  const _act = new Map();   // "id:port" → { last, act }
  let _showFlow = false;
  function _updateActivity() {
    for (const inst of engine.instances.values()) {
      for (const name in inst.outputs) {
        const key = inst.id + ':' + name;
        const v = inst.outputs[name].read();
        const a = _act.get(key);
        if (!a) _act.set(key, { last: v, act: 0 });
        else if (v !== a.last) { a.act = 1; a.last = v; }
        else a.act *= 0.9;
      }
    }
  }
  function _activityOf(id, port) { const a = _act.get(id + ':' + port); return a ? a.act : 0; }
  function _moduleActivity(inst) { let m = 0; for (const n in inst.outputs) m = Math.max(m, _activityOf(inst.id, n)); return m; }

  // Beads flowing source → dest along the cable; speed + opacity track activity.
  function drawFlow(cab, pts, color) {
    const act = _activityOf(cab.from.id, cab.from.port);
    if (act < 0.03 || pts.length < 2) return;
    const seg = [], cum = [0]; let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      seg.push(d); total += d; cum.push(total);
    }
    const gap = 26, speed = 0.03 + 0.12 * act, offset = (perfNow() * speed) % gap;
    ctx.fillStyle = lighten(color, 0.5); ctx.globalAlpha = 0.35 + 0.55 * act;
    for (let d = offset; d < total; d += gap) {
      let i = 1; while (i < cum.length && cum[i] < d) i++;
      if (i >= cum.length) break;
      const t = (d - cum[i - 1]) / (seg[i - 1] || 1);
      ctx.beginPath();
      ctx.arc(pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // One full frame. state from interact.js: { dragGhost, dragCable, hoveredPort, selectedId, railsOn, showFlow }
  function draw(state = {}) {
    _showFlow = !!state.showFlow;
    if (_showFlow) _updateActivity();
    drawBg();
    if (state.railsOn !== false) drawRack();
    updateCables(state.dragCable);
    drawDragGhost(state.dragGhost);
    for (const inst of engine.instances.values()) drawModule(inst, state.hoveredPort, inst.id === state.selectedId);
    if (state.railsOn !== false) for (const inst of engine.instances.values()) drawMounts(inst);
    for (const c of engine.cables) {
      const pts = _cablePts.get(cableKey(c));
      if (pts) { drawCableStroke(pts, cableColor(c)); if (_showFlow) drawFlow(c, pts, cableColor(c)); }
    }
    const dpts = _cablePts.get('__drag__');
    if (dpts && state.dragCable) {
      const src = state.dragCable.from || state.dragCable.to;
      const inst = src && engine.instances.get(src.id);
      const col = state.wireColor ? accent(state.wireColor)
        : (inst ? accent(inst.color || inst.def.color) : colors.textMid);
      drawCableStroke(dpts, col);
    }
  }

  return {
    view, get colors() { return colors; },
    setColors(t) { colors = { ...DEFAULT_COLORS, ...t }; },
    setRack(r) { rack = r; },
    get rack() { return rack; },
    resize, screenToWorld, fitToViewport, rowYs, rowHeight, moduleRect, layoutFor,
    portWorldPos, refPos, findPortAt, findModuleAt, findControlAt, findCableAt, overlaps, snapTarget,
    updateCables, draw,
    get W() { return W; }, get H() { return H; }, get DPR() { return DPR; },
    ACCENTS,
  };
}
