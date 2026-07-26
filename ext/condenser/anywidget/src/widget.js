// @gcu/condenser — the anywidget (Jupyter) front half. Glue only: it decodes
// the packed columnar payload the Python side sends, feeds it through the
// engine's chunk builders, and drives one progressive render loop per widget
// instance. All the rendering intelligence (Morton order, prefix LOD, box
// impostors, EDL, the ID-buffer pick) is @gcu/condenser/core, unchanged — the
// SAME engine micro ships, so a notebook and the desktop tool agree by
// construction.
//
// anywidget contract (0.9+): default-export an object with render({model, el}),
// returning a cleanup function. Model traits are the wire; `_payload` carries
// the data as one atomic Bytes blob (see the format note below), everything
// else is a small scalar the user can poke from Python.

import {
  createRenderer, createEdl, createOrbitCamera, attachOrbitInput,
  createChunkBuilder, createBlockChunkBuilder, makeBlockGrid,
  rampPixels, categoryPalettePixels,
} from '../../core.js';

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

// ── the wire format (must mirror gcu_condenser/__init__.py's _pack) ──
//   'CDNS' | u32 version | u32 headerLen | header JSON (utf-8) | pad | body
// Column offsets in the header are RELATIVE TO THE BODY START, which both
// sides derive identically as (12 + headerLen) rounded up to 8 — so the header
// stays self-describing without its offsets depending on its own length. Every
// column is 8-aligned within the body (f64 requires it). ONE trait carries all
// of it, so a data change is ATOMIC: a header can never arrive describing
// buffers that haven't landed yet.
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
  const cols = {};
  for (const [name, c] of Object.entries(head.cols || {})) {
    const T = TYPES[c.type];
    if (T) cols[name] = new T(buf, base + bodyStart + c.off, c.len);
  }
  return { head, cols };
}

// which engine colour mode a `color` choice means, per element kind. The engine
// numbers differ by pipeline (points: 1 = intensity, blocks: 1 = grade), so the
// widget speaks names and translates here.
function modeOf(color, kind, cols) {
  if (color === 'value' && cols.value) return 1;
  if (color === 'category' && cols.cat) return 2;
  if (color === 'rgb' && cols.rgb && kind === 'points') return 3;
  if (color === 'flat') return kind === 'blocks' ? 3 : 0;  // blocks: 3 = solid; points have no flat → z
  return 0;                                                // 'z' (elevation) is the honest default
}

// anywidget wants a DEFAULT export; @gcu/build emits named exports only (its
// rename-on-collision pass needs names). So this is named, and build.js appends
// the one-line `export default { render }` footer to the bundle.
export function render({ model, el }) {
  {
    // ── DOM: a sized host + the canvas the engine owns ──
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
    let doc = null, kind = 'points', payload = null, disposed = false;
    let converged = false, needFit = false;

    try {
      renderer = createRenderer(canvas, { background: [0.07, 0.07, 0.07, 1] });
      edl = createEdl(renderer.gl);
      cam = createOrbitCamera();
    } catch (e) {                                          // no WebGL2 (headless CI, locked-down VM)
      host.style.height = '80px';
      hud.style.cssText += 'position:static;padding:10px;color:#d07a5c;';
      hud.textContent = `condenser: ${e.message}`;
      return () => { el.innerHTML = ''; };
    }

    const draw = () => {
      raf = 0;
      if (disposed) return;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; renderer.invalidate(); }
      cam.setAspect(w / h);
      if (needFit && doc) { cam.fit(doc.bboxLocal); needFit = false; }
      const opts = {
        budget: model.get('budget') || 3_000_000,
        pointPx: model.get('point_size') || 2.5,
        colorMode: modeOf(model.get('color'), kind, payload ? payload.cols : {}),
        blocksAsPoints: !!model.get('as_points'),
        blockEdges: !!model.get('block_edges'),
        section: null,
        clip: model.get('clip') && model.get('clip').length === 2 ? model.get('clip') : null,
      };
      const r = edl.render(w, h, cam, () => renderer.draw(cam, opts),
        { enabled: model.get('edl') !== false, strength: model.get('edl_strength') != null ? model.get('edl_strength') : 1.0 });
      converged = r.converged;
      if (doc) {
        const acc = renderer.accumulated, tot = renderer.elementCount;
        hud.textContent = converged
          ? `${tot.toLocaleString()} ${kind === 'blocks' ? 'blocks' : 'points'}`
          : `${tot.toLocaleString()} · ${Math.round((100 * acc) / (tot || 1))}%`;
      }
      if (!converged) schedule();                          // keep accumulating until the frame settles
    };
    const schedule = () => { if (!raf && !disposed) raf = requestAnimationFrame(draw); };
    const invalidate = () => { renderer.invalidate(); schedule(); };

    // ── load: payload → chunk builders → GPU. Rebuilt wholesale on any data
    // change (a notebook re-run means new data, not an incremental edit). ──
    const load = () => {
      renderer.clearChunks();
      doc = null; payload = null;
      const p = decodePayload(model.get('_payload'));
      if (!p || !p.head.count) { hud.textContent = 'no data'; schedule(); return; }
      payload = p;
      const { head, cols } = p;
      kind = head.kind;
      const frame = { origin: head.frame, crs: head.crs || null, units: head.units || 'm' };
      const n = head.count;
      if (kind === 'blocks') {
        // Python inferred the lattice (np.unique over resident columns is exact
        // and trivial); the engine's own inferAxis is for STREAMING sweeps where
        // nothing is resident — a different situation, not a duplicate.
        const grid = makeBlockGrid(head.axes.map(([origin, pitch, count]) => ({ origin, pitch, count })), frame);
        const b = createBlockChunkBuilder({ frame, grid, chunkSize: 1 << 18, seed: 1, onChunk: (c) => renderer.addChunk(c, 'base', 0) });
        b.push({ count: n, x: cols.x, y: cols.y, z: cols.z, chan: cols.value || null, cat: cols.cat || null, recStart: 0 });
        doc = b.flush();
        if (head.cat_n) renderer.setCategories(head.cat_n);
      } else {
        const b = createChunkBuilder({ frame, chunkSize: 1 << 19, seed: 1, onChunk: (c) => renderer.addChunk(c, 'base', 0) });
        b.push({
          count: n, x: cols.x, y: cols.y, z: cols.z,
          intensity: cols.value_u16 || new Uint16Array(n),  // points colour-by-value rides the intensity channel
          classification: cols.cat || new Uint8Array(n),
          rgb: cols.rgb || null, recStart: 0,
        });
        doc = b.flush();
        if (head.cat_n) renderer.setLayerCats(0, head.cat_n);
      }
      renderer.setDocBbox(doc.bboxLocal);
      applyRamp();
      applyThreshold();
      applyOpacity();
      needFit = true;
      invalidate();
    };

    const applyRamp = () => {
      const name = model.get('ramp') || 'viridis';
      const stops = RAMPS[name];
      renderer.setLayerRamp(0, stops ? rampPixels(256, stops) : null);
      schedule();
    };

    // ── threshold: the grade shell. A block model is SOLID — from outside you
    // see waste, so a cutoff is not a nicety, it's how you look at an ore body
    // at all. The mask is built here from the value column already on hand, so
    // dragging a cutoff never re-sends data. isolate hides; dim keeps the rest
    // as grey context. ──
    const applyThreshold = () => {
      if (!payload) return;
      const t = model.get('threshold');
      const v = payload.cols.value;
      if (!v || !t || t.length !== 2) { renderer.setFilter(null, {}, 0); schedule(); return; }
      const [lo, hi] = t;
      const mask = new Uint8Array(v.length);
      for (let i = 0; i < v.length; i++) mask[i] = (v[i] >= lo && v[i] <= hi) ? 1 : 0;
      renderer.setFilter(mask, { isolate: model.get('filter_mode') !== 'dim' }, 0);
      schedule();
    };

    // per-layer opacity is a screen-door dither, not alpha blending — so depth
    // stays exact and no sorting is needed. Pairs with filter_mode='dim': the
    // context turns to ghost and the shell inside becomes visible through it.
    const applyOpacity = () => {
      const o = model.get('opacity');
      renderer.setLayerOpacity(0, o == null ? 1 : o);
      schedule();
    };

    const applyBackground = () => {
      const hex = String(model.get('background') || '#121212').replace('#', '');
      if (hex.length !== 6) return;
      const v = parseInt(hex, 16);
      renderer.setBackground([((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255, 1]);
      schedule();
    };

    // ── the click → `selected` round trip: the ID buffer names the RECORD, and
    // a record IS the source row, so Python reads back a DataFrame index. ──
    let downAt = null;
    const onDown = (e) => { downAt = [e.clientX, e.clientY]; };
    const onUp = (e) => {
      if (!downAt || !doc) return;
      const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
      downAt = null;
      if (moved > 4) return;                               // a drag is navigation, not a pick
      const r = canvas.getBoundingClientRect();
      const hit = renderer.pick(e.clientX - r.left, e.clientY - r.top, cam, {
        pointPx: model.get('point_size') || 2.5, blocksAsPoints: !!model.get('as_points'), section: null,
      });
      renderer.setPicked(hit || null);
      model.set('selected', hit ? hit.rec : -1);
      model.save_changes();
      schedule();
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);

    detach = attachOrbitInput(canvas, cam, { onChange: schedule });

    const applyHeight = () => { host.style.height = `${model.get('height') || 420}px`; invalidate(); };

    // ── trait reactions ──
    const subs = [
      ['change:_payload', load],
      ['change:ramp', applyRamp],
      ['change:background', applyBackground],
      ['change:height', applyHeight],
      ['change:threshold', applyThreshold], ['change:filter_mode', applyThreshold],
      ['change:opacity', applyOpacity],
      ['change:color', invalidate], ['change:clip', invalidate],
      ['change:point_size', invalidate], ['change:as_points', invalidate],
      ['change:block_edges', invalidate], ['change:edl', invalidate],
      ['change:edl_strength', invalidate], ['change:budget', invalidate],
    ];
    for (const [ev, fn] of subs) model.on(ev, fn);
    // an explicit fit request from Python (a counter — any bump refits)
    model.on('change:_fit', () => { needFit = true; invalidate(); });

    ro = new ResizeObserver(() => invalidate());
    ro.observe(host);

    applyHeight();
    applyBackground();
    load();

    return () => {                                         // anywidget teardown
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
      if (detach) detach();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      for (const [ev, fn] of subs) model.off(ev, fn);
      try { renderer.clearChunks(); } catch { /* context already gone */ }
      const lose = renderer.gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();                        // a notebook can build dozens of these
      el.innerHTML = '';
    };
  }
}
