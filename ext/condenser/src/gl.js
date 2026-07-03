// @gcu/condenser — the WebGL2 splat renderer. Raw GL, no scene graph: per-chunk
// VAOs over the quantized buffers (positions stay uint16 on the GPU — denormalized
// in the vertex shader against per-chunk bbox uniforms), circular point splats,
// color-by as a mode uniform + LUT texture (switching color source is a uniform/
// texture swap, never a buffer re-upload — micro-spec §2.2).
//
// Prefix-LOD (M1 form): a global per-frame element budget split across visible
// chunks proportionally; each chunk draws its FIRST k elements — correct as a
// uniform subsample because chunks.js shuffled them (the §2.1.4 invariant).

import { frustumPlanes, aabbInFrustum } from './camera.js';
import { createBlocksPipeline, categoryPalettePixels } from './gl-blocks.js';
import { createPickPipeline } from './gl-pick.js';

const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;        // uint16 normalized -> 0..1
layout(location=1) in float aIntensity; // uint16 normalized
layout(location=2) in float aClass;     // uint8, raw (0..255)
layout(location=3) in vec3 aRgb;        // uint8 normalized
layout(location=4) in uint aRec;        // uint32 record index (highlight + mask lookups)
uniform uint uPicked;                   // record index to highlight (0xFFFFFFFF = none)
uniform uvec2 uRepaint;                 // repaint pass: draw ONLY these two records (both 0xFFFFFFFF = off)
uniform vec4 uSecPlane;                 // section plane: xyz = unit normal, w = offset (frame-local)
uniform vec2 uSecCfg;                   // x: 0 = off, 1 = slab; y: slab half-thickness
uniform mat4 uViewProj;
uniform vec3 uBoxMin, uBoxSpan;
uniform float uPointPx;
uniform int uColorMode;                 // 0 elevation | 1 intensity | 2 classification | 3 rgb
uniform vec2 uZRange;                   // document local z min/span (elevation ramp)
uniform float uIntensityScale;          // 1 / (p98-ish max, normalized units)
uniform sampler2D uRamp;                // 256x1 continuous ramp
uniform sampler2D uPalette;             // classification / category palette
uniform float uPaletteN;                // its width (32 = LAS classes, 256 = category dict)
uniform sampler2D uMask;                // filter bitmask by record index (8192-wide)
uniform float uFilterOn, uIsolate;
out vec4 vColor;
flat out float vCull;
void main() {
  vec3 p = uBoxMin + aPos * uBoxSpan;
  gl_Position = uViewProj * vec4(p, 1.0);
  gl_PointSize = uPointPx;
  vCull = (uSecCfg.x > 0.5 && abs(dot(p, uSecPlane.xyz) - uSecPlane.w) > uSecCfg.y) ? 1.0 : 0.0;
  float m = 1.0;
  if (uFilterOn > 0.5) {
    int rec = int(aRec & 0x1FFFFFFFu);  // low 29 bits = the record (top 3 = layer)
    m = texelFetch(uMask, ivec2(rec & 8191, rec >> 13), 0).r > 0.5 ? 1.0 : 0.0;
    if (uIsolate > 0.5 && m < 0.5) vCull = 1.0;
  }
  if (uColorMode == 0) {
    float t = clamp((p.z - uZRange.x) / max(uZRange.y, 1e-6), 0.0, 1.0);
    vColor = texture(uRamp, vec2(t, 0.5));
  } else if (uColorMode == 1) {
    float t = clamp(aIntensity * uIntensityScale, 0.0, 1.0);
    vColor = texture(uRamp, vec2(t, 0.5));
  } else if (uColorMode == 2) {
    vColor = texture(uPalette, vec2((aClass + 0.5) / uPaletteN, 0.5));
  } else {
    vColor = vec4(aRgb, 1.0);
  }
  if (uFilterOn > 0.5 && m < 0.5) vColor = vec4(vColor.rgb * 0.3, vColor.a);   // context mode: dim non-matching
  if (aRec == uPicked) vColor = vec4(mix(vColor.rgb, vec3(1.0, 0.15, 0.7), 0.85) + 0.1, vColor.a);   // picked: hot magenta — the hue viridis doesn't have
  if ((uRepaint.x != 0xFFFFFFFFu || uRepaint.y != 0xFFFFFFFFu) && aRec != uRepaint.x && aRec != uRepaint.y) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);   // repaint pass: everything else clips out
}`;

const FRAG = `#version 300 es
precision highp float;
in vec4 vColor;
flat in float vCull;
out vec4 outColor;
void main() {
  if (vCull > 0.5) discard;             // outside the section slab
  vec2 d = gl_PointCoord - 0.5;
  if (dot(d, d) > 0.25) discard;        // circular splat
  outColor = vColor;
}`;

export { makeProgram } from './gl-util.js';
import { makeProgram } from './gl-util.js';

// ── LUTs ──
// A small viridis-ish ramp (Switchboard-friendly; perceptual enough for v0.1).
const RAMP_STOPS = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]];
export function rampPixels(n = 256, stops = RAMP_STOPS) {
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1) * (stops.length - 1), k = Math.min(stops.length - 2, t | 0), f = t - k;
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(stops[k][c] * (1 - f) + stops[k + 1][c] * f);
    out[i * 4 + 3] = 255;
  }
  return out;
}
// Standard LAS classification palette (0..18+; index = class code).
const CLASS_COLORS = {
  0: [140, 144, 153], 1: [170, 170, 170], 2: [161, 124, 82], 3: [122, 168, 100],
  4: [90, 150, 70], 5: [60, 130, 60], 6: [200, 105, 84], 7: [220, 80, 80],
  8: [180, 180, 90], 9: [74, 120, 176], 10: [200, 160, 60], 11: [110, 110, 120],
  12: [235, 100, 60], 13: [180, 140, 200], 14: [140, 120, 220], 15: [120, 200, 200],
  16: [200, 200, 120], 17: [160, 90, 160], 18: [230, 150, 150],
};
export function palettePixels(n = 32) {
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const c = CLASS_COLORS[i] || [200, 60, 200];           // unknown classes scream magenta, quietly
    out[i * 4] = c[0]; out[i * 4 + 1] = c[1]; out[i * 4 + 2] = c[2]; out[i * 4 + 3] = 255;
  }
  return out;
}

function lutTexture(gl, pixels, n) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, n, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  return t;
}

// Upload one chunk's buffers → a VAO. CPU copies are the caller's to release —
// after this returns, the GPU owns the data (§2.1.5 CPU-release). recIdx goes up
// too (an unattached buffer, wired by the M5 pick pass) so nothing per-element
// has to stay resident in JS.
export function uploadChunk(gl, chunk) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = (data, loc, size, type, normalized) => {
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, type, normalized, 0, 0);
    return b;
  };
  const buffers = [
    buf(chunk.pos, 0, 3, gl.UNSIGNED_SHORT, true),
    buf(chunk.intensity, 1, 1, gl.UNSIGNED_SHORT, true),
    buf(chunk.classification, 2, 1, gl.UNSIGNED_BYTE, false),
  ];
  if (chunk.rgb) buffers.push(buf(chunk.rgb, 3, 3, gl.UNSIGNED_BYTE, true));
  else { gl.disableVertexAttribArray(3); gl.vertexAttrib3f(3, 0.7, 0.7, 0.7); }
  const recBuf = gl.createBuffer();                        // highlight + pick lookups, GPU-resident
  gl.bindBuffer(gl.ARRAY_BUFFER, recBuf);
  gl.bufferData(gl.ARRAY_BUFFER, chunk.recIdx, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(4);
  gl.vertexAttribIPointer(4, 1, gl.UNSIGNED_INT, 0, 0);
  buffers.push(recBuf);
  gl.bindVertexArray(null);
  return { vao, buffers, count: chunk.count, bboxLocal: chunk.bboxLocal, cursor: 0 };
}

/**
 * createRenderer(canvas) — owns the GL context, program, LUTs, and the chunk
 * list; draw(cam, opts) renders one frame (into the current framebuffer — the
 * EDL pass wraps it). Chunks arrive via addChunk() as the stream lands.
 *
 * M2 state machine (§2.2): each frame classifies as MOVING (camera/viewport/
 * uniform changed since last frame) or STILL.
 *   moving → clear + draw a per-chunk PREFIX: k_i = budget · w_i/Σw where w_i is
 *   the chunk's projected screen weight ((radius/dist)², floored so the coarse
 *   global prefix never disappears), front-to-back over the frustum-culled set.
 *   still  → no clear; draw the NEXT SLICE of each unfinished visible chunk
 *   (progressive accumulation into the persistent FBO) until converged.
 * New chunks stream INTO the accumulation (no clear — they just draw behind).
 * All of it is correct because chunk prefixes are uniform subsamples (§2.1.4).
 */
export function createRenderer(canvas, { background = [0.07, 0.07, 0.07, 1] } = {}) {
  // preserveDrawingBuffer: the viewport is also the screenshot-export surface
  // (micro-spec §6) and readPixels-after-frame is how the smoke verifies renders;
  // the cost is one buffer copy per composite — negligible next to the splat pass.
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: true });
  if (!gl) throw new Error('condenser: WebGL2 unavailable');
  const prog = makeProgram(gl, VERT, FRAG);
  const U = (n) => gl.getUniformLocation(prog, n);
  const uni = {
    viewProj: U('uViewProj'), boxMin: U('uBoxMin'), boxSpan: U('uBoxSpan'),
    pointPx: U('uPointPx'), colorMode: U('uColorMode'), zRange: U('uZRange'),
    intensityScale: U('uIntensityScale'), ramp: U('uRamp'), palette: U('uPalette'), picked: U('uPicked'), repaint: U('uRepaint'),
    secPlane: U('uSecPlane'), secCfg: U('uSecCfg'),
    mask: U('uMask'), filterOn: U('uFilterOn'), isolate: U('uIsolate'), paletteN: U('uPaletteN'),
  };
  const ramp = lutTexture(gl, rampPixels(), 256);
  const palette = lutTexture(gl, palettePixels(), 32);   // LAS classification (points)
  let catPalette = null;                                  // category palette (blocks), lazy
  let blocksPipe = null;                                  // impostor pipeline, lazy
  let pickPipe = null;                                    // ID-buffer pick pipeline, lazy
  const chunks = [];
  let docBbox = null;                                     // scene bbox (fit + the shared elevation ramp)
  let pickedRec = 0xFFFFFFFF;                             // highlighted record (sentinel = none; FULL partitioned id)
  const repaintSet = new Set();                           // records to repaint over a converged frame
  let lastConverged = false;
  // ── layers (micro-layers spec §1): each opened dataset is a layer with its own
  // visibility, filter mask, compaction set, and color ranges. recIdx is
  // PARTITIONED — (layerId << 29) | record — so one ID buffer serves all layers
  // (§3). Single-layer callers never notice: layer 0 shifts by zero and every
  // API defaults to it. ──
  const layers = new Map();                               // id → per-layer state
  function layerOf(id) {
    let l = layers.get(id);
    if (!l) {
      l = { visible: true, set: 'base', maskTex: null, maskH: 0, isolate: false,
            intensityMax: 1, docChan: [Infinity, -Infinity], catN: 0 };
      layers.set(id, l);
    }
    return l;
  }
  const activeChunk = (c) => { const l = layers.get(c._layer); return !!l && l.visible && c._set === l.set; };
  const freeChunk = (c) => { gl.deleteVertexArray(c.vao); c.buffers.forEach((b) => gl.deleteBuffer(b)); };
  const byLayer = (arr) => {
    const m = new Map();
    for (const c of arr) { let g = m.get(c._layer); if (!g) m.set(c._layer, g = []); g.push(c); }
    return m;
  };
  // accumulation state
  const lastVP = new Float32Array(16);
  let lastKey = '', needClear = true, lastVisible = 0;

  const vpChanged = (vp) => {
    for (let i = 0; i < 16; i++) if (vp[i] !== lastVP[i]) { lastVP.set(vp); return true; }
    return false;
  };

  return {
    gl,
    get chunkCount() { return chunks.reduce((s, c) => s + (activeChunk(c) ? 1 : 0), 0); },
    get elementCount() { return chunks.reduce((s, c) => s + (activeChunk(c) ? c.count : 0), 0); },
    get accumulated() { return chunks.reduce((s, c) => s + (activeChunk(c) ? c.cursor : 0), 0); },   // elements in the current accumulation
    addChunk(chunk, set = 'base', layer = 0) {
      const ls = layerOf(layer);
      if (layer) {                                        // partition the record ids (layer 0 shifts by zero)
        const base = (layer << 29) >>> 0, r = chunk.recIdx;
        for (let i = 0; i < r.length; i++) r[i] = (r[i] | base) >>> 0;
      }
      if (chunk.kind === 'blocks') {
        if (!blocksPipe) blocksPipe = createBlocksPipeline(gl);
        const up = blocksPipe.upload(chunk); up._set = set; up._layer = layer;
        chunks.push(up);                                   // GPU owns it now
        if (set === 'base') {                              // compact chunks never tighten the ramp
          if (chunk.chanRange[0] < ls.docChan[0]) ls.docChan[0] = chunk.chanRange[0];
          if (chunk.chanRange[1] > ls.docChan[1]) ls.docChan[1] = chunk.chanRange[1];
        }
        return;
      }
      const up = uploadChunk(gl, chunk); up._set = set; up._layer = layer;
      chunks.push(up);                                     // GPU owns it now; CPU copy dies with the caller
      if (set === 'base') {
        let m = 0; const a = chunk.intensity;
        for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i];
        ls.intensityMax = Math.max(ls.intensityMax, m);
      }
    },
    setCategories(n) {                                     // block category palette (golden-angle hues)
      if (n > 0 && !catPalette) catPalette = lutTexture(gl, categoryPalettePixels(256), 256);
    },
    // Filter bitmask by RECORD INDEX within the layer (micro-spec section 4).
    // mask = Uint8Array (0|1 per source row) or null to clear; isolate: true
    // discards non-matching, false dims them.
    setFilter(mask, { isolate = false } = {}, layer = 0) {
      const ls = layerOf(layer);
      ls.isolate = isolate;
      if (!mask) {
        if (ls.maskTex) { gl.deleteTexture(ls.maskTex); ls.maskTex = null; }
      } else {
        const W = 8192, H = Math.max(1, Math.ceil(mask.length / W));
        const padded = new Uint8Array(W * H);
        for (let i = 0; i < mask.length; i++) padded[i] = mask[i] ? 255 : 0;
        if (ls.maskTex && H === ls.maskH) {
          gl.bindTexture(gl.TEXTURE_2D, ls.maskTex);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RED, gl.UNSIGNED_BYTE, padded);
        } else {
          if (ls.maskTex) gl.deleteTexture(ls.maskTex);
          ls.maskTex = gl.createTexture(); ls.maskH = H;
          gl.bindTexture(gl.TEXTURE_2D, ls.maskTex);
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, W, H, 0, gl.RED, gl.UNSIGNED_BYTE, padded);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        }
      }
      needClear = true;
    },
    setDocBbox(b) { docBbox = b; },
    // Filter compaction (per layer): 'compact' chunks hold ONLY matching elements
    // (record ids preserved), so the render budget runs over the matches instead
    // of shader-discarding the rest. Base chunks stay resident — clearing is instant.
    setActiveSet(set, layer = 0) { const ls = layerOf(layer); if (set !== ls.set) { ls.set = set; needClear = true; } },
    get activeSet() { return layerOf(0).set; },            // legacy single-layer read
    clearCompact(layer = 0) {
      for (let i = chunks.length - 1; i >= 0; i--) {
        const c = chunks[i];
        if (c._layer !== layer || c._set !== 'compact') continue;
        freeChunk(c);
        chunks.splice(i, 1);
      }
      const ls = layerOf(layer);
      if (ls.set === 'compact') { ls.set = 'base'; needClear = true; }
    },
    // points layers with a CATEGORY dict color class codes through the 256-wide
    // golden-angle palette instead of the 32-entry LAS classification table
    setLayerCats(layer, n) { const ls = layerOf(layer); if (ls.catN !== (n || 0)) { ls.catN = n || 0; needClear = true; } },
    setLayerVisible(layer, on) {
      const ls = layerOf(layer);
      if (ls.visible !== !!on) { ls.visible = !!on; needClear = true; }
    },
    removeLayer(layer) {
      for (let i = chunks.length - 1; i >= 0; i--) {
        if (chunks[i]._layer !== layer) continue;
        freeChunk(chunks[i]);
        chunks.splice(i, 1);
      }
      const ls = layers.get(layer);
      if (ls && ls.maskTex) gl.deleteTexture(ls.maskTex);
      layers.delete(layer);
      needClear = true;
    },
    layerElementCount(layer) {
      const ls = layers.get(layer);
      if (!ls) return 0;
      return chunks.reduce((s, c) => s + (c._layer === layer && c._set === ls.set ? c.count : 0), 0);
    },
    invalidate() { needClear = true; },
    // Pick/unpick over a CONVERGED frame repaints just the affected elements
    // (a depth-LEQUAL pass where everything else clips out) instead of
    // restarting the accumulation — same total vertex work, none of the
    // de-densify blink. Mid-accumulation falls back to the clear.
    setPicked(rec) {
      const next = rec == null ? 0xFFFFFFFF : rec >>> 0;
      if (next === pickedRec) return;
      const prev = pickedRec;
      pickedRec = next;
      if (lastConverged && !needClear) {
        if (prev !== 0xFFFFFFFF) repaintSet.add(prev);
        if (next !== 0xFFFFFFFF) repaintSet.add(next);
        if (repaintSet.size > 2) { repaintSet.clear(); needClear = true; }   // rapid multi-pick: one redraw is cheaper
      } else needClear = true;
    },
    // GPU pick at CSS coordinates → PARTITIONED record id | null. Draws each
    // visible layer's accumulated prefix into a scissored offscreen target with
    // the record id as the color (gl-pick.js) — you pick exactly what you see.
    pick(cssX, cssY, cam, { pointPx = 2.5, blocksAsPoints = false, section = null } = {}) {
      if (!chunks.length) return null;
      if (!pickPipe) pickPipe = createPickPipeline(gl);
      const dpr = window.devicePixelRatio || 1;
      const px = Math.round(cssX * dpr), py = Math.round(canvas.height - cssY * dpr - 1);
      if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return null;
      return pickPipe.pick(px, py, chunks.filter(activeChunk), cam, {
        pointPx, blocksAsPoints, layerStates: layers,
        section: section && section.on ? section : null,
        viewportW: canvas.width, viewportH: canvas.height,
      });
    },
    clearChunks() {
      for (const c of chunks) freeChunk(c);
      chunks.length = 0; needClear = true;
      for (const ls of layers.values()) if (ls.maskTex) gl.deleteTexture(ls.maskTex);
      layers.clear();
    },
    resize() {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; needClear = true; }
      return [w, h];
    },
    // Draw one frame into the CURRENT framebuffer (the EDL pass owns the target).
    // opts.layerOpts = { [id]: { colorMode, clip } } overrides the global color
    // opts per layer (absent → the globals, so single-layer callers are unchanged).
    // Returns { drawn, converged, visible }.
    draw(cam, { budget = 3_000_000, pointPx = 2.5, colorMode = 0, blocksAsPoints = false, section = null, clip = null, layerOpts = null } = {}) {
      const vp = cam.state.viewProj;
      const sec = section && section.on ? section : null;
      const secKey = sec ? `${sec.n.join(',')}|${sec.d}|${sec.half}` : 'off';
      const clipKey = clip ? `${clip[0]}~${clip[1]}` : 'a';
      const loKey = layerOpts ? JSON.stringify(layerOpts) : '';
      const key = `${pointPx}|${colorMode}|${blocksAsPoints ? 'P' : 'B'}|${secKey}|${clipKey}|${loKey}|${canvas.width}x${canvas.height}`;
      const moving = vpChanged(vp) || key !== lastKey || needClear;
      lastKey = key; needClear = false;
      if (moving) repaintSet.clear();                      // the full redraw covers any pending repaint

      // frustum-cull + front-to-back over chunk bboxes (tight, thanks to Morton)
      const planes = frustumPlanes(vp);
      const eye = cam.state.eye;
      const visible = [];
      for (const c of chunks) {
        if (!activeChunk(c)) continue;
        if (!aabbInFrustum(planes, c.bboxLocal)) { if (moving) c.cursor = 0; continue; }
        const b = c.bboxLocal;
        const cx = (b[0] + b[3]) / 2 - eye[0], cy = (b[1] + b[4]) / 2 - eye[1], cz = (b[2] + b[5]) / 2 - eye[2];
        const dist = Math.max(Math.hypot(cx, cy, cz), cam.state.near);
        const r = Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2 || 1;
        c._dist = dist;
        c._w = Math.min(1, (r / dist) * (r / dist));       // projected-area weight
        visible.push(c);
      }
      visible.sort((a, b) => a._dist - b._dist);           // front-to-back
      lastVisible = visible.length;
      const sumW = visible.reduce((s, c) => s + c._w, 0) || 1;

      gl.enable(gl.DEPTH_TEST);
      if (moving) {
        gl.clearColor(background[0], background[1], background[2], background[3]);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        for (const c of visible) c.cursor = 0;
      }

      const db = docBbox || Float64Array.of(0, 0, 0, 1, 1, 1);
      // per-layer view opts (color mode + clip); the globals when not overridden
      const lopt = (id) => (layerOpts && layerOpts[id]) || { colorMode, clip };
      // elevation ramp = the SCENE z range (layers share vertical space) + clip
      const zRangeOf = (o) => {
        const zLo = o.clip && o.clip[0] != null && o.colorMode === 0 ? o.clip[0] : db[2];
        const zHi = o.clip && o.clip[1] != null && o.colorMode === 0 ? o.clip[1] : db[5];
        return [zLo, Math.max(zHi - zLo, 1e-6)];
      };
      // this frame's allotment per chunk: budget share by projected weight, floored
      // so distant chunks keep a sparse presence (coarse prefix always on)
      const allot = (c) => {
        const share = Math.max(Math.min(c.count, 1000), Math.floor(budget * (c._w / sumW)));
        const first = moving ? 0 : c.cursor;
        return [first, Math.min(c.count - first, share)];
      };
      let drawn = 0, converged = true;
      // pending pick repaint: one extra full-geometry pass at depth LEQUAL —
      // lands exactly on the element's already-accumulated pixels
      const rp = !moving && repaintSet.size
        ? [...repaintSet, 0xFFFFFFFF, 0xFFFFFFFF].slice(0, 2).map((v) => v >>> 0) : null;

      const pts = visible.filter((c) => c.kind !== 'blocks');
      if (pts.length) {
        const ptsGroups = byLayer(pts);
        gl.useProgram(prog);
        gl.uniformMatrix4fv(uni.viewProj, false, vp);
        gl.uniform1f(uni.pointPx, pointPx * (window.devicePixelRatio || 1));
        gl.uniform1ui(uni.picked, pickedRec);
        gl.uniform2ui(uni.repaint, 0xFFFFFFFF, 0xFFFFFFFF);
        gl.uniform4f(uni.secPlane, sec ? sec.n[0] : 0, sec ? sec.n[1] : 0, sec ? sec.n[2] : 1, sec ? sec.d : 0);
        gl.uniform2f(uni.secCfg, sec ? 1 : 0, sec ? sec.half : 0);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, ramp); gl.uniform1i(uni.ramp, 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, palette); gl.uniform1i(uni.palette, 1);
        // per-layer uniforms + slices (front-to-back preserved within each group)
        const setupPtsLayer = (id) => {
          const ls = layerOf(id), o = lopt(id), zr = zRangeOf(o);
          gl.uniform1i(uni.colorMode, o.colorMode);
          gl.uniform2f(uni.zRange, zr[0], zr[1]);
          gl.uniform1f(uni.intensityScale, 65535 / (ls.intensityMax || 1));
          gl.uniform1f(uni.paletteN, ls.catN || 32);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, ls.catN && catPalette ? catPalette : palette);
          gl.uniform1i(uni.palette, 1);
          gl.uniform1f(uni.filterOn, ls.maskTex ? 1 : 0);
          gl.uniform1f(uni.isolate, ls.isolate ? 1 : 0);
          if (ls.maskTex) { gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, ls.maskTex); gl.uniform1i(uni.mask, 4); }
        };
        for (const [id, group] of ptsGroups) {
          setupPtsLayer(id);
          for (const c of group) {
            const [first, k] = allot(c);
            if (k > 0) {
              gl.uniform3f(uni.boxMin, c.bboxLocal[0], c.bboxLocal[1], c.bboxLocal[2]);
              gl.uniform3f(uni.boxSpan, c.bboxLocal[3] - c.bboxLocal[0], c.bboxLocal[4] - c.bboxLocal[1], c.bboxLocal[5] - c.bboxLocal[2]);
              gl.bindVertexArray(c.vao);
              gl.drawArrays(gl.POINTS, first, k);
              drawn += k; c.cursor = first + k;
            }
            if (c.cursor < c.count) converged = false;
          }
        }
        if (rp) {
          gl.depthFunc(gl.LEQUAL);
          gl.uniform2ui(uni.repaint, rp[0], rp[1]);
          for (const [id, group] of ptsGroups) {
            setupPtsLayer(id);
            for (const c of group) {
              gl.uniform3f(uni.boxMin, c.bboxLocal[0], c.bboxLocal[1], c.bboxLocal[2]);
              gl.uniform3f(uni.boxSpan, c.bboxLocal[3] - c.bboxLocal[0], c.bboxLocal[4] - c.bboxLocal[1], c.bboxLocal[5] - c.bboxLocal[2]);
              gl.bindVertexArray(c.vao);
              gl.drawArrays(gl.POINTS, 0, c.count);
            }
          }
          gl.uniform2ui(uni.repaint, 0xFFFFFFFF, 0xFFFFFFFF);
          gl.depthFunc(gl.LESS);
        }
      }

      const blks = visible.filter((c) => c.kind === 'blocks');
      if (blks.length) {
        const blkGroups = byLayer(blks);
        const perspScale = (canvas.height / 2) / Math.tan(cam.state.fovY / 2);
        const cheapOf = (c) => {
          // the whole chunk below the demotion threshold → the cheap program
          // (no gl_FragDepth → early-z stays on): the far-field perf lever
          const b = c.bboxLocal;
          const bboxR = Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2;
          const rBlock = Math.hypot(c.grid.size[0], c.grid.size[1], c.grid.size[2]) / 2;
          const distNear = Math.max(cam.state.near, c._dist - bboxR);
          return blocksAsPoints || rBlock * perspScale / distNear < 2.0;
        };
        const beginLayer = (id) => {
          const ls = layerOf(id), o = lopt(id);
          const cLo = o.clip && o.clip[0] != null && o.colorMode === 1 ? o.clip[0] : (ls.docChan[0] === Infinity ? 0 : ls.docChan[0]);
          const cHi = o.clip && o.clip[1] != null && o.colorMode === 1 ? o.clip[1] : ls.docChan[1];
          blocksPipe.begin(cam, {
            pointPx, colorMode: o.colorMode, zRange: zRangeOf(o),
            chanDoc: [cLo, cHi > cLo ? cHi - cLo : 1],
            ramp, palette: catPalette || palette, viewportH: canvas.height,
            maskTex: ls.maskTex, isolate: ls.isolate, pointsView: blocksAsPoints, picked: pickedRec, section: sec,
          });
        };
        for (const [id, group] of blkGroups) {
          beginLayer(id);
          for (const c of group) {
            const [first, k] = allot(c);
            if (k > 0) {
              blocksPipe.drawSlice(c, first, k, cheapOf(c));
              drawn += k; c.cursor = first + k;
            }
            if (c.cursor < c.count) converged = false;
          }
        }
        if (rp) {
          gl.depthFunc(gl.LEQUAL);
          for (const [id, group] of blkGroups) {
            beginLayer(id);                                // begin resets uRepaint — set it after, per layer
            blocksPipe.setRepaint(rp[0], rp[1]);
            for (const c of group) blocksPipe.drawSlice(c, 0, c.count, cheapOf(c));
          }
          blocksPipe.setRepaint(0xFFFFFFFF, 0xFFFFFFFF);
          gl.depthFunc(gl.LESS);
        }
      }
      if (rp) repaintSet.clear();
      lastConverged = converged;
      gl.bindVertexArray(null);
      return { drawn, converged, visible: lastVisible };
    },
  };
}
