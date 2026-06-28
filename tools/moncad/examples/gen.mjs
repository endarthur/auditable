// Generate moncad's example DXFs — built as @gcu/dxf Documents and written with the
// library's own writer (dogfooding: this also exercises the writer's round-trip). Run:
//   node tools/moncad/examples/gen.mjs
// Renders well in moncad v0: LINE / LWPOLYLINE (+bulge arcs) / CIRCLE / POINT, at honest
// UTM coordinates (so the frame-correct readout shows real eastings/northings).

import { write, read } from '../../../ext/dxf/src/main.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const f64 = (a) => Float64Array.from(a);
const aci = (i) => ({ mode: 'aci', index: i });
const gcd = (a, b) => (b ? gcd(b, a % b) : a);

const props = (color, layer) => ({ layer, ...(color ? { color: aci(color) } : {}) });
const poly = (pts, { closed = false, bulges = null, color, layer = '0' } = {}) =>
  ({ type: 'polyline', geometry: { kind: 'polyline', vertices: f64(pts.flatMap((p) => [p[0], p[1], p[2] || 0])), bulges: bulges ? f64(bulges) : null, closed }, properties: props(color, layer) });
const line = (a, b, { color, layer = '0' } = {}) =>
  ({ type: 'line', geometry: { kind: 'polyline', vertices: f64([a[0], a[1], a[2] || 0, b[0], b[1], b[2] || 0]), bulges: null, closed: false }, properties: props(color, layer) });
const circle = (c, r, { color, layer = '0' } = {}) =>
  ({ type: 'circle', geometry: { kind: 'circle', center: [c[0], c[1], c[2] || 0], radius: r }, properties: props(color, layer) });
const point = (p, { color, layer = '0' } = {}) =>
  ({ type: 'point', geometry: { kind: 'point', position: [p[0], p[1], p[2] || 0] }, properties: props(color, layer) });
const makeDoc = (features, units = 'm') => ({ header: { units, acadver: 'AC1015' }, layers: {}, blocks: {}, features, warnings: [] });

// ── 1. an open-pit, at Quadrilátero Ferrífero-ish UTM (23S) ────────────────────────
function pit() {
  const C = [600300, 7790300], f = [];
  const ring = (r, wob, col, layer) => {
    const n = 48, pts = [];
    for (let i = 0; i < n; i++) { const a = 2 * Math.PI * i / n, rr = r + wob * Math.sin(a * 3 + r); pts.push([C[0] + rr * Math.cos(a), C[1] + rr * Math.sin(a)]); }
    f.push(poly(pts, { closed: true, color: col, layer }));
  };
  ring(280, 16, 1, 'CREST');
  for (const r of [230, 180, 130, 85]) ring(r, 7, 2, 'BENCH');
  const ramp = [];
  for (let i = 0; i <= 90; i++) { const t = i / 90, a = t * 4 * Math.PI, r = 280 - (280 - 85) * t; ramp.push([C[0] + r * Math.cos(a), C[1] + r * Math.sin(a)]); }
  f.push(poly(ramp, { color: 6, layer: 'RAMP' }));
  for (let x = -260; x <= 260; x += 40) for (let y = -260; y <= 260; y += 40) if (Math.hypot(x, y) < 270) f.push(point([C[0] + x, C[1] + y], { color: 4, layer: 'COLLAR' }));
  f.push(line([C[0] - 340, C[1]], [C[0] + 340, C[1]], { color: 7, layer: 'SECTION' }));
  f.push(line([C[0], C[1] - 340], [C[0], C[1] + 340], { color: 7, layer: 'SECTION' }));
  return makeDoc(f);
}

// ── 2. a faceplate — rounded-rect (bulge corners) + apertures (mm) ──────────────────
function faceplate() {
  const W = 120, H = 80, r = 10, b = Math.tan(Math.PI / 8);   // 90° corner → bulge tan(22.5°)
  const v = [[r, 0], [W - r, 0], [W, r], [W, H - r], [W - r, H], [r, H], [0, H - r], [0, r]];
  const bulges = [0, b, 0, b, 0, b, 0, b];
  const f = [poly(v, { closed: true, bulges, color: 7, layer: 'OUTLINE' }), circle([W / 2, H / 2], 22, { color: 4, layer: 'SCREEN' })];
  for (const x of [18, W - 18]) for (const y of [16, H - 16]) f.push(circle([x, y], 4, { color: 2, layer: 'HOLE' }));
  return makeDoc(f, 'mm');
}

// ── 3. a rosette — flower-of-life + a dense hypotrochoid (arc/segment stress) ───────
function rosette() {
  const C = [0, 0], R = 60, f = [circle(C, R, { color: 4, layer: 'FLOWER' })];
  for (let i = 0; i < 6; i++) { const a = 2 * Math.PI * i / 6; f.push(circle([C[0] + R * Math.cos(a), C[1] + R * Math.sin(a)], R, { color: 4, layer: 'FLOWER' })); }
  for (let i = 0; i < 12; i++) { const a = 2 * Math.PI * i / 12, d = i % 2 ? R * Math.sqrt(3) : 2 * R; f.push(circle([C[0] + d * Math.cos(a), C[1] + d * Math.sin(a)], R, { color: 4, layer: 'FLOWER' })); }
  const Rr = 160, rr = 34, dd = 80, turns = rr / gcd(Rr, rr), N = 1600, pts = [];
  for (let i = 0; i <= N; i++) { const t = 2 * Math.PI * turns * i / N; pts.push([(Rr - rr) * Math.cos(t) + dd * Math.cos((Rr - rr) / rr * t), (Rr - rr) * Math.sin(t) - dd * Math.sin((Rr - rr) / rr * t)]); }
  f.push(poly(pts, { color: 6, layer: 'SPIRO' }));
  return makeDoc(f);
}

// ── 4. structure contours — nested wavy closed polylines at UTM, w/ drillholes ──────
function contours() {
  const C = [600400, 7790400], f = [];
  for (let k = 0; k < 11; k++) {
    const r = 55 + k * 36, n = 90, pts = [];
    for (let i = 0; i < n; i++) { const a = 2 * Math.PI * i / n, rr = r + 16 * Math.sin(a * 2 + k) + 9 * Math.cos(a * 5 - k); pts.push([C[0] + rr * Math.cos(a), C[1] + rr * Math.sin(a)]); }
    f.push(poly(pts, { closed: true, color: 1 + (k % 6), layer: 'RL_' + (1000 + k * 10) }));
  }
  for (let i = 0; i < 14; i++) { const a = 2 * Math.PI * i / 14, r = 130 + 90 * Math.sin(i * 1.3); f.push(point([C[0] + r * Math.cos(a), C[1] + r * Math.sin(a)], { color: 4, layer: 'DH' })); }
  return makeDoc(f);
}

const examples = { 'qf-pit': pit(), 'faceplate': faceplate(), 'rosette': rosette(), 'contours': contours() };
for (const [name, doc] of Object.entries(examples)) {
  const text = write(doc);
  fs.writeFileSync(path.join(here, name + '.dxf'), text);
  const back = read(text);                                    // round-trip check
  const segs = back.features.filter((x) => x.geometry?.kind === 'polyline').length;
  console.log(`${name}.dxf — ${(text.length / 1024).toFixed(1)} KB · ${back.features.length} features (${segs} polylines) · ${back.warnings.length} warnings`);
}
