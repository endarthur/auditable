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
  makeBlockGrid, rampPixels,
} from '../../core.js';
import { dhDesurveySamples } from '../../../drillhole/src/samples.js';

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
  // each layer's header maps its own column names onto the flat body
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
function sectionOf(sec, origin) {
  if (!sec) return null;
  let n = sec.normal;
  if (!n) {
    const ax = sec.axis;
    if (!ax) return null;
    n = ax === 'x' ? [1, 0, 0] : ax === 'y' ? [0, 1, 0] : [0, 0, 1];
  }
  const L = Math.hypot(n[0], n[1], n[2]) || 1;
  n = [n[0] / L, n[1] / L, n[2] / L];
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

// anywidget wants a DEFAULT export; @gcu/build emits named exports only (its
// rename-on-collision pass needs names). So this is named, and build.js appends
// the one-line `export default { render }` footer to the bundle.
export function render({ model, el }) {
  const host = document.createElement('div');
  host.style.cssText = 'position:relative;width:100%;background:#121212;border-radius:3px;overflow:hidden;';
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100%;height:100%;';
  host.appendChild(canvas);
  const hud = document.createElement('div');
  hud.style.cssText = 'position:absolute;left:6px;bottom:5px;font:11px ui-monospace,Menlo,Consolas,monospace;color:#8b8b8b;pointer-events:none;text-shadow:0 1px 2px #000;';
  host.appendChild(hud);
  el.appendChild(host);

  let renderer = null, edl = null, cam = null, detach = null, raf = 0, ro = null;
  let payload = null, disposed = false, needFit = false, converged = false;
  let docBbox = null;
  const kinds = [];                                        // layer index → element kind

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

  const draw = () => {
    raf = 0;
    if (disposed) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; renderer.invalidate(); }
    cam.setAspect(w / h);
    if (needFit && docBbox) { cam.fit(docBbox); needFit = false; }

    const st = styles();
    // per-layer colour mode + clip; the engine takes point size / points-view
    // as VIEW-wide, so those fold across the visible layers
    const layerOpts = {};
    let pointPx = 2.5, asPoints = false;
    st.forEach((s, i) => {
      const cols = payload && payload.layers[i] ? payload.layers[i].cols : {};
      layerOpts[i] = {
        colorMode: modeOf(s.color, kinds[i], cols),
        clip: s.clip && s.clip.length === 2 ? s.clip : null,
      };
      if (s.visible !== false) {
        pointPx = Math.max(pointPx, s.point_size || 0);
        asPoints = asPoints || !!s.as_points;
      }
    });
    const opts = {
      budget: model.get('budget') || 3_000_000,
      pointPx, blocksAsPoints: asPoints, blockEdges: false,   // edges are a per-layer override
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
    if (!p || !p.layers.length) { hud.textContent = 'no data'; schedule(); return; }
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
      // threshold → the isolate/dim mask, built here from the value column that
      // is already resident, so dragging a cutoff never re-sends data
      const v = L.cols.value;
      const t = s.threshold;
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

  // ── the click → `selection` round trip: the ID buffer names the LAYER and the
  // RECORD, and a record IS the source row, so Python gets back a table index. ──
  let downAt = null;
  const onDown = (e) => { downAt = [e.clientX, e.clientY]; };
  const onUp = (e) => {
    if (!downAt || !payload) return;
    const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
    downAt = null;
    if (moved > 4) return;                                 // a drag is navigation, not a pick
    const r = canvas.getBoundingClientRect();
    const st = styles();
    let pointPx = 2.5, asPoints = false;
    st.forEach((s) => { if (s.visible !== false) { pointPx = Math.max(pointPx, s.point_size || 0); asPoints = asPoints || !!s.as_points; } });
    const hit = renderer.pick(e.clientX - r.left, e.clientY - r.top, cam, {
      pointPx, blocksAsPoints: asPoints,
      section: sectionOf(model.get('section'), payload.frame),
    });
    renderer.setPicked(hit || null);
    model.set('selection', hit ? { layer: hit.layer, name: (styleAt(hit.layer).name || ''), row: hit.rec } : {});
    model.save_changes();
    schedule();
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);
  detach = attachOrbitInput(canvas, cam, { onChange: schedule });

  const subs = [
    ['change:_payload', load],
    ['change:_styles', () => { applyStyles(); invalidate(); }],
    ['change:section', invalidate],
    ['change:background', applyBackground],
    ['change:height', applyHeight],
    ['change:edl', invalidate], ['change:edl_strength', invalidate], ['change:budget', invalidate],
    ['change:_fit', () => { needFit = true; invalidate(); }],
  ];
  for (const [ev, fn] of subs) model.on(ev, fn);

  ro = new ResizeObserver(() => invalidate());
  ro.observe(host);
  applyHeight();
  applyBackground();
  load();

  return () => {                                           // anywidget teardown
    disposed = true;
    if (raf) cancelAnimationFrame(raf);
    if (ro) ro.disconnect();
    if (detach) detach();
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointerup', onUp);
    for (const [ev, fn] of subs) model.off(ev, fn);
    try { renderer.clearChunks(); } catch { /* context already gone */ }
    const lose = renderer.gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();                          // a notebook can build dozens of these
    el.innerHTML = '';
  };
}
