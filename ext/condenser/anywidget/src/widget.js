// @gcu/condenser — the anywidget (Jupyter) front half. Glue only: it decodes
// the packed columnar payload, feeds each layer through the engine's chunk
// builders, and drives one progressive render loop per widget instance. All
// the rendering intelligence (Morton order, prefix LOD, box impostors, capsule
// impostors, EDL, true sections, the ID-buffer pick) is @gcu/condenser/core,
// unchanged — the SAME engine micro ships, so a notebook and the desktop tool
// agree by construction. Drillholes desurvey through @gcu/drillhole, also the
// same code, so a hole lands in the same place in both.
//
// anywidget contract: default-export an object with render({model, el}),
// returning a cleanup function. `_payload` is one atomic Bytes blob holding
// EVERY layer against ONE shared frame; `_styles` is a per-layer style dict.

import {
  createRenderer, createEdl, createOrbitCamera, attachOrbitInput,
  createChunkBuilder, createBlockChunkBuilder, createStickChunkBuilder,
  makeBlockGrid, rampPixels, mat4Inverse,
} from '../../core.js';
import { dhDesurveySamples } from '../../../drillhole/src/samples.js';
import { createToolbar } from './toolbar.js';

// ── ramp presets. rampPixels' default is the viridis-ish walk; these are the
// few a geologist reaches for. Kept here (not in the engine) because they are
// a PRESENTATION choice — micro has its own richer set in its own UI. ──
const RAMPS = {
  viridis: null,                                           // the engine default
  magma: [[0, 0, 4], [80, 18, 123], [182, 54, 121], [252, 137, 97], [252, 253, 191]],
  turbo: [[48, 18, 59], [28, 156, 220], [96, 252, 100], [249, 190, 60], [122, 4, 3]],
  greys: [[20, 20, 20], [90, 90, 90], [150, 150, 150], [205, 205, 205], [250, 250, 250]],
  spectral: [[94, 79, 162], [102, 194, 165], [255, 255, 191], [253, 174, 97], [158, 1, 66]],
  fire: [[10, 5, 40], [120, 20, 90], [220, 80, 40], [250, 180, 50], [255, 250, 200]],
};

const TYPES = { f64: Float64Array, f32: Float32Array, u32: Uint32Array, u16: Uint16Array, u8: Uint8Array };

// ── the wire format (mirrors gcu_condenser/__init__.py's _pack) ──
//   'CDNS' | u32 version | u32 headerLen | header JSON (utf-8) | pad | body
// Column offsets are RELATIVE TO THE BODY START, which both sides derive as
// (12 + headerLen) rounded up to 8 — self-describing without the offsets
// depending on the header's own length. ONE blob keeps a data change ATOMIC.
function decodePayload(raw) {
  if (!raw) return null;
  const buf = raw instanceof ArrayBuffer ? raw : (raw.buffer || raw);
  const base = raw.byteOffset || 0;
  const len = raw.byteLength != null ? raw.byteLength : (buf ? buf.byteLength : 0);
  if (!buf || len < 12) return null;
  const dv = new DataView(buf, base, len);
  if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'CDNS') return null;
  const headerLen = dv.getUint32(8, true);
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, base + 12, headerLen)));
  const bodyStart = (12 + headerLen + 7) & ~7;
  const all = {};
  for (const [name, c] of Object.entries(head.cols || {})) {
    const T = TYPES[c.type];
    if (T) all[name] = new T(buf, base + bodyStart + c.off, c.len);
  }
  const layers = (head.layers || []).map((L) => {
    const cols = {};
    for (const [name, key] of Object.entries(L.cols || {})) if (all[key]) cols[name] = all[key];
    return { ...L, cols };
  });
  return { frame: head.frame, layers };
}

// which engine colour mode a `color` choice means, per element kind. The engine
// numbers differ by pipeline (points: 1 = intensity, blocks/sticks: 1 = grade),
// so the widget speaks names and translates here.
function modeOf(color, kind, cols) {
  if (color === 'value' && (cols.value || cols.value_u16)) return 1;
  if (color === 'category' && cols.cat) return 2;
  if (color === 'rgb' && cols.rgb && kind === 'points') return 3;
  if (color === 'flat') return kind === 'points' ? 0 : 3;  // blocks/sticks: 3 = solid
  return 0;                                                // 'z' (elevation)
}

// the section trait → the engine's frame-local plane. `position` is a WORLD
// coordinate along the normal (that is what a geologist types), so the frame
// origin comes off it here.
function normalOf(sec) {
  let n = sec.normal;
  if (!n) {
    const ax = sec.axis;
    if (!ax) return null;
    n = ax === 'x' ? [1, 0, 0] : ax === 'y' ? [0, 1, 0] : [0, 0, 1];
  }
  const L = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / L, n[1] / L, n[2] / L];
}
function sectionOf(sec, origin) {
  if (!sec) return null;
  const n = normalOf(sec);
  if (!n) return null;
  const d = (+sec.position || 0) - (n[0] * origin[0] + n[1] * origin[1] + n[2] * origin[2]);
  const half = Math.max(0.01, (+sec.thickness || 10) / 2);
  return { on: true, n, d, half, d0: d, clip: 'slab', traceHalf: half };
}

// ── drillholes: three tables → desurveyed capsule segments ──
// The interval FROM and TO depths are located as two point-samples on the
// desurveyed trace (arc-correct via positionAt), then paired back into a
// segment keyed by source row — the same construction condenser's own file
// provider uses, so notebook and micro place a hole identically.
function drillholeSegments(head, cols) {
  const nC = cols.c_bhid.length, nS = cols.s_bhid.length, n = cols.i_bhid.length;
  const collars = new Array(nC);
  for (let i = 0; i < nC; i++) {
    collars[i] = { bhid: String(cols.c_bhid[i]), x: cols.c_x[i], y: cols.c_y[i], z: cols.c_z[i] };
    if (cols.c_eoh) collars[i].eoh = cols.c_eoh[i];
  }
  const surveys = new Array(nS);
  for (let i = 0; i < nS; i++) surveys[i] = { bhid: String(cols.s_bhid[i]), depth: cols.s_depth[i], az: cols.s_az[i], dip: cols.s_dip[i] };

  const bhid = new Array(2 * n), depth = new Float64Array(2 * n);
  const rowIdx = new Float64Array(2 * n), endIdx = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    const hb = String(cols.i_bhid[i]);
    bhid[2 * i] = hb; bhid[2 * i + 1] = hb;
    depth[2 * i] = cols.i_from[i]; depth[2 * i + 1] = cols.i_to[i];
    rowIdx[2 * i] = i; rowIdx[2 * i + 1] = i;
    endIdx[2 * i] = 0; endIdx[2 * i + 1] = 1;
  }
  const ds = dhDesurveySamples(
    { collars, surveys, samples: { bhid, depth, cols: [{ name: '__row', values: rowIdx }, { name: '__end', values: endIdx }] } },
    { method: head.method || 'minimumCurvature', dipConvention: head.dip_convention || 'auto' },
  );

  const endA = new Map(), endB = new Map();                // src row → [x,y,z]
  for (const row of ds.rows) (row[6] | 0) === 0 ? endA.set(row[5] | 0, [row[1], row[2], row[3]]) : endB.set(row[5] | 0, [row[1], row[2], row[3]]);
  const placed = [];
  for (const src of endA.keys()) if (endB.has(src)) placed.push(src);
  placed.sort((a, b) => a - b);
  const k = placed.length;
  const out = {
    count: k,
    ax: new Float64Array(k), ay: new Float64Array(k), az: new Float64Array(k),
    bx: new Float64Array(k), by: new Float64Array(k), bz: new Float64Array(k),
    x: new Float64Array(k), y: new Float64Array(k), z: new Float64Array(k),
    chan: new Float64Array(k), cat: cols.cat ? new Uint8Array(k) : null,
    recIdx: new Uint32Array(k),
  };
  for (let i = 0; i < k; i++) {
    const s = placed[i], A = endA.get(s), B = endB.get(s);
    out.ax[i] = A[0]; out.ay[i] = A[1]; out.az[i] = A[2];
    out.bx[i] = B[0]; out.by[i] = B[1]; out.bz[i] = B[2];
    out.x[i] = (A[0] + B[0]) / 2; out.y[i] = (A[1] + B[1]) / 2; out.z[i] = (A[2] + B[2]) / 2;
    out.chan[i] = cols.value && Number.isFinite(cols.value[s]) ? cols.value[s] : 0;
    if (out.cat) out.cat[i] = cols.cat[s];
    out.recIdx[i] = s;                                     // the INTERVAL row — the pick's join key
  }
  return out;
}

const fmtN = (v) => {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  return a >= 1e5 || (a < 0.01 && a > 0) ? v.toExponential(2) : String(Math.round(v * 100) / 100);
};

// anywidget wants a DEFAULT export; @gcu/build emits named exports only (its
// rename-on-collision pass needs names). So this is named, and build.js appends
// the one-line `export default { render }` footer to the bundle.
export function render({ model, el }) {
  const host = document.createElement('div');
  host.style.cssText = 'position:relative;width:100%;background:#121212;border-radius:3px;overflow:hidden;';
  // right-drag PANS, so JupyterLab's own context menu must stay out of the way.
  // This attribute is the supported hook: JupyterLab's handler does
  // `el.closest('[data-jp-suppress-context-menu]')` and stands down if it hits.
  host.setAttribute('data-jp-suppress-context-menu', 'true');
  host.addEventListener('contextmenu', (e) => e.preventDefault());
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100%;height:100%;';
  host.appendChild(canvas);
  const hud = document.createElement('div');
  hud.className = 'cdhud';
  hud.style.cssText = 'position:absolute;left:6px;bottom:5px;font:11px ui-monospace,Menlo,Consolas,monospace;color:#8b8b8b;pointer-events:none;text-shadow:0 1px 2px #000;z-index:1;';
  host.appendChild(hud);
  el.appendChild(host);

  let renderer = null, edl = null, cam = null, detach = null, raf = 0, ro = null, tb = null;
  let payload = null, disposed = false, needFit = false, converged = false;
  let docBbox = null;
  const kinds = [];

  try {
    renderer = createRenderer(canvas, { background: [0.07, 0.07, 0.07, 1] });
    edl = createEdl(renderer.gl);
    cam = createOrbitCamera();
  } catch (e) {                                            // no WebGL2 (headless CI, locked-down VM)
    host.style.height = '80px';
    hud.style.cssText += 'position:static;padding:10px;color:#d07a5c;';
    hud.textContent = `condenser: ${e.message}`;
    return () => { el.innerHTML = ''; };
  }

  const styles = () => model.get('_styles') || [];
  const styleAt = (i) => styles()[i] || {};
  const viewOpts = () => {                                 // point size / points-view are VIEW-wide in the engine
    let pointPx = 2.5, asPoints = false;
    for (const s of styles()) if (s.visible !== false) { pointPx = Math.max(pointPx, s.point_size || 0); asPoints = asPoints || !!s.as_points; }
    return { pointPx, asPoints };
  };

  const draw = () => {
    raf = 0;
    if (disposed) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; renderer.invalidate(); }
    cam.setAspect(w / h);
    if (needFit && docBbox) { cam.fit(docBbox); needFit = false; }

    const layerOpts = {};
    styles().forEach((s, i) => {
      const cols = payload && payload.layers[i] ? payload.layers[i].cols : {};
      layerOpts[i] = { colorMode: modeOf(s.color, kinds[i], cols), clip: s.clip && s.clip.length === 2 ? s.clip : null };
    });
    const vo = viewOpts();
    const opts = {
      budget: model.get('budget') || 3_000_000,
      pointPx: vo.pointPx, blocksAsPoints: vo.asPoints, blockEdges: false,
      section: sectionOf(model.get('section'), (payload && payload.frame) || [0, 0, 0]),
      clip: null, layerOpts,
    };
    const r = edl.render(w, h, cam, () => renderer.draw(cam, opts),
      { enabled: model.get('edl') !== false, strength: model.get('edl_strength') != null ? model.get('edl_strength') : 1.0 });
    converged = r.converged;
    if (payload) {
      const tot = renderer.elementCount, acc = renderer.accumulated;
      const n = payload.layers.length;
      const what = n === 1 ? (kinds[0] === 'blocks' ? 'blocks' : kinds[0] === 'drillholes' ? 'intervals' : 'points')
        : `elements · ${n} layers`;
      hud.textContent = converged ? `${tot.toLocaleString()} ${what}` : `${tot.toLocaleString()} · ${Math.round((100 * acc) / (tot || 1))}%`;
    }
    if (!converged) schedule();
  };
  const schedule = () => { if (!raf && !disposed) raf = requestAnimationFrame(draw); };
  const invalidate = () => { renderer.invalidate(); schedule(); };

  // ── load: payload → chunk builders → GPU, one engine layer per data layer ──
  const load = () => {
    renderer.clearChunks();
    payload = null; docBbox = null; kinds.length = 0;
    const p = decodePayload(model.get('_payload'));
    if (!p || !p.layers.length) { hud.textContent = 'no data'; if (tb) { tb.showPick(null); tb.syncLegend(null); } schedule(); return; }
    payload = p;
    const frame = { origin: p.frame, crs: null, units: 'm' };
    const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];

    p.layers.forEach((L, i) => {
      const cols = L.cols;
      kinds[i] = L.kind;
      let doc = null;
      if (L.kind === 'blocks') {
        const grid = makeBlockGrid(L.axes.map(([origin, pitch, count]) => ({ origin, pitch, count })), frame);
        const b = createBlockChunkBuilder({
          frame, grid, chunkSize: 1 << 18, seed: 1,
          dimPalette: L.dim_palette || null,               // sub-blocked: per-code half-dims
          onChunk: (c) => renderer.addChunk(c, 'base', i),
        });
        b.push({ count: L.count, x: cols.x, y: cols.y, z: cols.z, chan: cols.value || null, cat: cols.cat || null, dim: cols.dim || null, recStart: 0 });
        doc = b.flush();
        if (L.cat_n) renderer.setCategories(L.cat_n);
      } else if (L.kind === 'drillholes') {
        const seg = drillholeSegments(L, cols);
        // the desurvey computes these, so stash the interval midpoints by ROW:
        // measure and the readout need a position for a drillhole pick too
        L._pos = { x: new Float64Array(L.count), y: new Float64Array(L.count), z: new Float64Array(L.count) };
        for (let q = 0; q < seg.count; q++) {
          const r = seg.recIdx[q];
          L._pos.x[r] = seg.x[q]; L._pos.y[r] = seg.y[q]; L._pos.z[r] = seg.z[q];
        }
        const b = createStickChunkBuilder({ frame, chunkSize: 1 << 16, seed: 1, onChunk: (c) => renderer.addChunk(c, 'base', i) });
        b.push({ count: seg.count, ax: seg.ax, ay: seg.ay, az: seg.az, bx: seg.bx, by: seg.by, bz: seg.bz,
          x: seg.x, y: seg.y, z: seg.z, chan: seg.chan, cat: seg.cat, recIdx: seg.recIdx });
        doc = b.flush();
        if (L.cat_n) renderer.setCategories(L.cat_n);
      } else {
        const b = createChunkBuilder({ frame, chunkSize: 1 << 19, seed: 1, onChunk: (c) => renderer.addChunk(c, 'base', i) });
        b.push({
          count: L.count, x: cols.x, y: cols.y, z: cols.z,
          intensity: cols.value_u16 || new Uint16Array(L.count),
          classification: cols.cat || new Uint8Array(L.count),
          rgb: cols.rgb || null, recStart: 0,
        });
        doc = b.flush();
        if (L.cat_n) renderer.setLayerCats(i, L.cat_n);
      }
      if (doc && doc.bboxLocal) {
        for (let a = 0; a < 3; a++) {
          if (doc.bboxLocal[a] < bb[a]) bb[a] = doc.bboxLocal[a];
          if (doc.bboxLocal[a + 3] > bb[a + 3]) bb[a + 3] = doc.bboxLocal[a + 3];
        }
      }
    });

    docBbox = Float64Array.from(bb);
    renderer.setDocBbox(docBbox);
    applyStyles();
    if (tb) { tb.showPick(null); syncChrome(); }
    needFit = true;
    invalidate();
  };

  // ── styles: everything the engine keeps per LAYER ──
  const applyStyles = () => {
    if (!payload) return;
    styles().forEach((s, i) => {
      const L = payload.layers[i];
      if (!L) return;
      renderer.setLayerVisible(i, s.visible !== false);
      renderer.setLayerOpacity(i, s.opacity == null ? 1 : s.opacity);
      renderer.setLayerSectioned(i, s.sectioned === undefined ? true : s.sectioned);
      const stops = RAMPS[s.ramp || 'viridis'];
      renderer.setLayerRamp(i, stops ? rampPixels(256, stops) : null);
      if (L.kind === 'blocks') renderer.setLayerEdges(i, !!s.block_edges);
      if (L.kind === 'drillholes') renderer.setLayerStickRadius(i, s.radius || 1.5);
      const v = L.cols.value, t = s.threshold;
      if (v && t && t.length === 2) {
        const mask = new Uint8Array(v.length);
        for (let q = 0; q < v.length; q++) mask[q] = (v[q] >= t[0] && v[q] <= t[1]) ? 1 : 0;
        renderer.setFilter(mask, { isolate: s.filter_mode !== 'dim' }, i);
      } else {
        renderer.setFilter(null, {}, i);
      }
    });
    schedule();
  };

  const applyBackground = () => {
    const hex = String(model.get('background') || '#121212').replace('#', '');
    if (hex.length !== 6) return;
    const v = parseInt(hex, 16);
    renderer.setBackground([((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255, 1]);
    schedule();
  };
  const applyHeight = () => { host.style.height = `${model.get('height') || 460}px`; invalidate(); };

  // ── the section's world extent along its normal, for the scrub slider ──
  const sectionExtent = (sec) => {
    if (!payload || !docBbox) return [0, 1];
    const n = normalOf(sec) || [0, 1, 0], o = payload.frame;
    let lo = Infinity, hi = -Infinity;
    for (let c = 0; c < 8; c++) {
      const p = [docBbox[(c & 1) ? 3 : 0], docBbox[(c & 2) ? 4 : 1], docBbox[(c & 4) ? 5 : 2]];
      const d = (p[0] + o[0]) * n[0] + (p[1] + o[1]) * n[1] + (p[2] + o[2]) * n[2];
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
    return [lo, hi];
  };

  // the legend follows the first VISIBLE layer coloured by value
  const legendInfo = () => {
    const st = styles();
    for (let i = 0; i < st.length; i++) {
      const s = st[i], L = payload && payload.layers[i];
      if (!L || s.visible === false || s.color !== 'value') continue;
      const range = (s.clip && s.clip.length === 2) ? s.clip : (L.value_range || null);
      if (!range) continue;
      const stops = RAMPS[s.ramp || 'viridis'];
      return { range, pixels: rampPixels(256, stops || undefined) };
    }
    return null;
  };

  const syncChrome = () => {
    if (!tb) return;
    const sec = model.get('section');
    tb.syncSection(sec, sec ? sectionExtent(sec) : null);
    tb.syncLegend(legendInfo());
    tb.syncOrtho(cam.state.ortho);
  };

  // camera presets — ONE implementation, shared by the toolbar and w.look()
  const setView = (k) => {
    const c = cam.state;
    if (k === 'plan') { c.theta = -Math.PI / 2; c.phi = Math.PI / 2 - 0.001; }
    else if (k === 'north') { c.theta = -Math.PI / 2; c.phi = 0; }
    else if (k === 'south') { c.theta = Math.PI / 2; c.phi = 0; }
    else if (k === 'east') { c.theta = Math.PI; c.phi = 0; }
    else if (k === 'west') { c.theta = 0; c.phi = 0; }
    else { c.theta = Math.PI / 4; c.phi = Math.PI / 5; }
    cam.update();
    needFit = true; invalidate();
  };

  // the stored camera state. Applied on CHANGE *and* at load: a widget
  // displayed a second time (any cell whose value is the Viewer) builds a fresh
  // view, and it must not come up pointing somewhere else than its sibling.
  const applyView = () => {
    const v = model.get('_view') || {};
    if (v.name) setView(v.name);
    if (v.ortho != null) { cam.setOrtho(!!v.ortho); if (tb) tb.syncOrtho(!!v.ortho); }
    invalidate();
  };

  // ── the toolbar ──
  const buildToolbar = () => {
    if (tb) { tb.destroy(); tb = null; }
    if (model.get('toolbar') === false) return;
    tb = createToolbar(host, {
      layers: () => (payload ? payload.layers.map((L, i) => ({ name: styleAt(i).name || L.kind, kind: L.kind, visible: styleAt(i).visible !== false })) : []),
      setStyle: (i, patch) => {
        const next = styles().map((s, k) => (k === i ? { ...s, ...patch } : s));
        model.set('_styles', next);                        // syncs back to the Python Layer
        model.save_changes();
        applyStyles();
        syncChrome();
      },
      fit: () => { needFit = true; invalidate(); },
      setView,
      toggleOrtho: () => { const on = !cam.state.ortho; cam.setOrtho(on); invalidate(); return on; },
      isOrtho: () => cam.state.ortho,
      getSection: () => model.get('section'),
      setSection: (s) => { model.set('section', s); model.save_changes(); syncChrome(); invalidate(); },
      snapshot: () => {
        schedule();
        requestAnimationFrame(() => {
          try {
            const a = document.createElement('a');
            a.href = canvas.toDataURL('image/png');        // preserveDrawingBuffer keeps this valid
            a.download = 'condenser.png';
            a.click();
          } catch (e) { hud.textContent = `snapshot failed: ${e.message}`; }
        });
      },
      onToolChange: (t) => {
        tb.setBand(null);
        measA = null;
        canvas.style.cursor = (t === 'knife' || t === 'rect' || t === 'lasso' || t === 'measure') ? 'crosshair' : '';
      },
      clearSelection: () => { selected.clear(); pushSelection(); if (tb) tb.showPick(null); },
    });
    syncChrome();
  };

  // ── pointer: pick / knife (the toolbar decides which) ──
  const relXY = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

  // unproject a screen point onto the horizontal plane through the camera target
  const groundAt = (sx, sy) => {
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    const inv = mat4Inverse(cam.state.viewProj);
    if (!inv) return null;
    const nx = (sx / w) * 2 - 1, ny = 1 - (sy / h) * 2;
    const un = (z) => {
      const x = inv[0] * nx + inv[4] * ny + inv[8] * z + inv[12];
      const y = inv[1] * nx + inv[5] * ny + inv[9] * z + inv[13];
      const zz = inv[2] * nx + inv[6] * ny + inv[10] * z + inv[14];
      const ww = inv[3] * nx + inv[7] * ny + inv[11] * z + inv[15];
      return [x / ww, y / ww, zz / ww];
    };
    const a = un(-1), b = un(1);
    const dz = b[2] - a[2];
    const tz = cam.state.target[2];
    if (Math.abs(dz) < 1e-9) return [a[0], a[1], tz];
    const t = (tz - a[2]) / dz;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, tz];
  };

  const doKnife = (a, b) => {
    const p1 = groundAt(a[0], a[1]), p2 = groundAt(b[0], b[1]);
    if (!p1 || !p2) return;
    const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return;
    const n = [-dy / len, dx / len, 0];                    // horizontal perpendicular to the drag
    const o = payload ? payload.frame : [0, 0, 0];
    const position = (p1[0] + o[0]) * n[0] + (p1[1] + o[1]) * n[1] + (p1[2] + o[2]) * n[2];
    const cur = model.get('section') || {};
    model.set('section', { normal: n, position, thickness: cur.thickness || 20 });
    model.save_changes();
    syncChrome();
    invalidate();
  };

  const pickInfo = (hit) => {
    if (!hit || !payload) return null;
    const L = payload.layers[hit.layer];
    if (!L) return null;
    const c = L.cols, r = hit.rec;
    const name = styleAt(hit.layer).name || L.kind;
    const rows = [];
    if (L.kind === 'drillholes') {
      const names = L.hole_names || [];
      const code = c.i_bhid ? c.i_bhid[r] : null;
      rows.push(['hole', code != null && names[code] != null ? names[code] : `#${code}`]);
      if (c.i_from) rows.push(['from–to', `${fmtN(c.i_from[r])} – ${fmtN(c.i_to[r])}`]);
    } else if (c.x) {
      rows.push(['x y z', `${fmtN(c.x[r])} ${fmtN(c.y[r])} ${fmtN(c.z[r])}`]);
    }
    if (c.value) rows.push(['value', fmtN(c.value[r])]);
    if (c.cat && L.cat_labels) rows.push(['category', L.cat_labels[c.cat[r]] ?? String(c.cat[r])]);
    rows.push(['row', String(r)]);
    return { title: name, rows };
  };

  // a record's WORLD position (blocks/points carry their columns; drillholes
  // get theirs from the desurvey stash above)
  const posOf = (li, rec) => {
    const L = payload && payload.layers[li];
    if (!L) return null;
    const c = L._pos || L.cols;
    if (!c || !c.x) return null;
    return [c.x[rec], c.y[rec], c.z[rec]];
  };

  const pointInPoly = (x, y, poly) => {
    let inside = false;
    for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
      const xa = poly[a][0], ya = poly[a][1], xb = poly[b][0], yb = poly[b][1];
      if ((ya > y) !== (yb > y) && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) inside = !inside;
    }
    return inside;
  };

  // ── region selection. The ID buffer already answers "which record is at this
  // pixel" for the whole viewport, so a marquee is: render the region's ids,
  // keep the pixels inside the shape, and collect the records. Which means what
  // you select is exactly what you can SEE — occluded elements are not caught,
  // the same contract as a click. ──
  const selected = new Map();                              // layer → Set(row)
  const packSelection = () => {
    let n = 0, total = 0;
    for (const set of selected.values()) if (set.size) { n++; total += set.size; }
    const buf = new ArrayBuffer(4 + n * 8 + total * 4);
    const dv = new DataView(buf);
    dv.setUint32(0, n, true);
    let off = 4;
    for (const [li, set] of selected) {
      if (!set.size) continue;
      dv.setUint32(off, li, true); dv.setUint32(off + 4, set.size, true);
      off += 8;
      for (const r of set) { dv.setUint32(off, r, true); off += 4; }
    }
    return buf;
  };
  const pushSelection = () => {
    styles().forEach((_s, i) => {
      const L = payload && payload.layers[i];
      const set = selected.get(i);
      if (!L) return;
      if (!set || !set.size) { renderer.setLayerSelection(i, null); return; }
      const mask = new Uint8Array(L.count);
      for (const r of set) if (r < mask.length) mask[r] = 1;
      renderer.setLayerSelection(i, mask);
    });
    model.set('_sel_rows', new DataView(packSelection()));
    model.save_changes();
    schedule();
  };
  const selectRegion = (rectCss, polyCss, additive) => {
    if (!payload) return;
    const vo = viewOpts();
    const reg = renderer.pickRegion(rectCss, cam, {
      pointPx: vo.pointPx, blocksAsPoints: vo.asPoints,
      section: sectionOf(model.get('section'), payload.frame),
    });
    if (!additive) selected.clear();
    if (reg && reg.data) {
      const { data, w: rw, h: rh, dpr } = reg;
      for (let row = 0; row < rh; row++) {
        for (let col = 0; col < rw; col++) {
          const i = (row * rw + col) * 4;
          const g = data[i + 1] >>> 0;
          if (g === 0xFFFFFFFF) continue;                  // nothing at this pixel
          if (polyCss) {                                   // lasso: rows are BOTTOM-UP
            const cx = rectCss.x + col / dpr;
            const cy = rectCss.y + (rh - 1 - row) / dpr;
            if (!pointInPoly(cx, cy, polyCss)) continue;
          }
          const li = g & 0xFFFF;
          let set = selected.get(li);
          if (!set) selected.set(li, set = new Set());
          set.add(data[i] >>> 0);
        }
      }
    }
    pushSelection();
    if (tb) {
      const counts = [...selected.entries()].filter(([, v]) => v.size)
        .map(([li, v]) => [styleAt(li).name || `layer ${li}`, v.size.toLocaleString()]);
      tb.showPick(counts.length ? { title: 'selected', rows: counts } : null);
    }
  };

  // ── measure: two picks, then distance + bearing + plunge (the numbers a
  // geologist actually wants off two points) ──
  let measA = null;
  const doMeasure = (hit, xy) => {
    if (!hit) return;
    const p = posOf(hit.layer, hit.rec);
    if (!p) return;
    if (!measA) { measA = { p, xy }; if (tb) { tb.setBand('measure', xy, xy); tb.showPick({ title: 'measure', rows: [['from', `${fmtN(p[0])} ${fmtN(p[1])} ${fmtN(p[2])}`], ['', 'click a second element']] }); } return; }
    const a = measA.p, b = p;
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const dist = Math.hypot(dx, dy, dz);
    const horiz = Math.hypot(dx, dy);
    const bearing = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;   // from north, clockwise
    const plunge = -Math.atan2(dz, horiz) * 180 / Math.PI;              // + is downward
    model.set('measurement', {
      from: [a[0], a[1], a[2]], to: [b[0], b[1], b[2]],
      distance: dist, dx, dy, dz, bearing, plunge,
    });
    model.save_changes();
    if (tb) {
      tb.setBand('measure', measA.xy, xy);
      tb.showPick({ title: 'measure', rows: [
        ['distance', fmtN(dist)], ['dx dy dz', `${fmtN(dx)} ${fmtN(dy)} ${fmtN(dz)}`],
        ['bearing', `${fmtN(bearing)}\u00b0`], ['plunge', `${fmtN(plunge)}\u00b0`],
      ] });
    }
    measA = null;
  };

  let down = null, dragging = false, lasso = null;
  const DRAG_TOOLS = { knife: 'line', rect: 'rect', lasso: 'poly' };
  const onDown = (e) => {
    const t = tb ? tb.tool : 'pick';
    down = { xy: relXY(e), t, shift: e.shiftKey };
    if (DRAG_TOOLS[t]) {
      dragging = true;
      lasso = t === 'lasso' ? [relXY(e)] : null;
      e.stopPropagation(); e.preventDefault();
    }
  };
  const onMove = (e) => {
    if (!dragging || !down) return;
    e.stopPropagation();
    const xy = relXY(e);
    const kind = DRAG_TOOLS[down.t];
    if (kind === 'poly') {
      const last = lasso[lasso.length - 1];
      if (Math.hypot(xy[0] - last[0], xy[1] - last[1]) > 3) lasso.push(xy);
      if (tb) tb.setBand('poly', lasso);
    } else if (tb) tb.setBand(kind, down.xy, xy);
  };
  const onUp = (e) => {
    if (!down) return;
    const xy = relXY(e);
    const moved = Math.hypot(xy[0] - down.xy[0], xy[1] - down.xy[1]);
    if (dragging) {
      e.stopPropagation();
      dragging = false;
      const t0 = down.t, add = down.shift, a = down.xy, path = lasso;
      lasso = null; down = null;
      if (tb) tb.setBand(null);
      if (t0 === 'lasso') {
        // a lasso ENDS WHERE IT STARTED, so start-to-end displacement is ~0 for
        // every real loop — the twitch test has to be the path's EXTENT.
        if (!path || path.length < 3) return;
        const xsL = path.map((q) => q[0]), ysL = path.map((q) => q[1]);
        const x0 = Math.min(...xsL), y0 = Math.min(...ysL);
        const bw = Math.max(...xsL) - x0, bh = Math.max(...ysL) - y0;
        if (Math.max(bw, bh) < 8) return;
        selectRegion({ x: x0, y: y0, w: bw, h: bh }, path, add);
        return;
      }
      if (moved <= 8) return;                              // a twitch is not a gesture
      if (t0 === 'knife') { doKnife(a, xy); if (tb) tb.clearTool(); return; }
      if (t0 === 'rect') {
        selectRegion({ x: Math.min(a[0], xy[0]), y: Math.min(a[1], xy[1]), w: Math.abs(xy[0] - a[0]), h: Math.abs(xy[1] - a[1]) }, null, add);
      }
      return;
    }
    const t = down.t;
    down = null;
    if ((t !== 'pick' && t !== 'measure') || moved > 4 || !payload) return;   // a drag is navigation
    const vo = viewOpts();
    const hit = renderer.pick(xy[0], xy[1], cam, {
      pointPx: vo.pointPx, blocksAsPoints: vo.asPoints,
      section: sectionOf(model.get('section'), payload.frame),
    });
    if (t === 'measure') { doMeasure(hit, xy); schedule(); return; }
    renderer.setPicked(hit || null);
    model.set('selection', hit ? { layer: hit.layer, name: styleAt(hit.layer).name || '', row: hit.rec } : {});
    model.save_changes();
    if (tb) tb.showPick(pickInfo(hit));
    schedule();
  };
  // capture on the HOST so the knife can pre-empt the orbit handlers bound to
  // the canvas (capture runs parent → target)
  host.addEventListener('pointerdown', onDown, true);
  host.addEventListener('pointermove', onMove, true);
  host.addEventListener('pointerup', onUp, true);

  detach = attachOrbitInput(canvas, cam, { onChange: () => { schedule(); if (tb) tb.syncOrtho(cam.state.ortho); } });

  const subs = [
    ['change:_payload', load],
    ['change:_styles', () => { applyStyles(); syncChrome(); invalidate(); }],
    ['change:section', () => { syncChrome(); invalidate(); }],
    ['change:background', applyBackground],
    ['change:height', applyHeight],
    ['change:toolbar', buildToolbar],
    ['change:edl', invalidate], ['change:edl_strength', invalidate], ['change:budget', invalidate],
    ['change:_fit', () => { needFit = true; invalidate(); }],
    ['change:_clear_sel', () => { selected.clear(); pushSelection(); if (tb) tb.showPick(null); }],
    ['change:_view', applyView],
  ];
  for (const [ev, fn] of subs) model.on(ev, fn);

  ro = new ResizeObserver(() => invalidate());
  ro.observe(host);
  applyHeight();
  applyBackground();
  buildToolbar();
  load();
  applyView();                                             // match any camera state already on the widget

  return () => {
    disposed = true;
    if (raf) cancelAnimationFrame(raf);
    if (ro) ro.disconnect();
    if (detach) detach();
    if (tb) tb.destroy();
    host.removeEventListener('pointerdown', onDown, true);
    host.removeEventListener('pointermove', onMove, true);
    host.removeEventListener('pointerup', onUp, true);
    for (const [ev, fn] of subs) model.off(ev, fn);
    try { renderer.clearChunks(); } catch { /* context already gone */ }
    const lose = renderer.gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    el.innerHTML = '';
  };
}
