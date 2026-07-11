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
import { createSticksPipeline } from './gl-sticks.js';
import { createMeshPipeline } from './gl-mesh.js';
import { createSoupPipeline } from './gl-soup.js';
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
uniform sampler2D uCatVis;              // 256x1 per-class visibility (layer properties)
uniform float uCatVisOn;
uniform sampler2D uSel;                 // selection bitmask by record index (8192-wide)
uniform float uSelOn;
uniform sampler2D uRule;                // rule-code byte by record index (8192-wide)
uniform float uRuleOn;                  // rule mode: the code REPLACES the class for palette + eyes
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
  float cls = aClass;
  if (uRuleOn > 0.5) {
    int rr = int(aRec & 0x1FFFFFFFu);
    cls = floor(texelFetch(uRule, ivec2(rr & 8191, rr >> 13), 0).r * 255.0 + 0.5);
  }
  if (uCatVisOn > 0.5 && texelFetch(uCatVis, ivec2(int(cls) & 255, 0), 0).r < 0.5) vCull = 1.0;
  float selHit = 0.0;
  if (uSelOn > 0.5) {
    int rs = int(aRec & 0x1FFFFFFFu);
    selHit = texelFetch(uSel, ivec2(rs & 8191, rs >> 13), 0).r;
  }
  if (uColorMode == 0) {
    float t = clamp((p.z - uZRange.x) / max(uZRange.y, 1e-6), 0.0, 1.0);
    vColor = texture(uRamp, vec2(t, 0.5));
  } else if (uColorMode == 1) {
    float t = clamp(aIntensity * uIntensityScale, 0.0, 1.0);
    vColor = texture(uRamp, vec2(t, 0.5));
  } else if (uColorMode == 2) {
    vColor = texture(uPalette, vec2((cls + 0.5) / uPaletteN, 0.5));
  } else {
    vColor = vec4(aRgb, 1.0);
  }
  if (uFilterOn > 0.5 && m < 0.5) vColor = vec4(vColor.rgb * 0.3, vColor.a);   // context mode: dim non-matching
  if (selHit > 0.5) vColor = vec4(mix(vColor.rgb, vec3(1.0, 0.85, 0.3), 0.55), vColor.a);   // selected: warm gold wash
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
  return { kind: 'points', vao, buffers, count: chunk.count, bboxLocal: chunk.bboxLocal, cursor: 0 };
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
    catVis: U('uCatVis'), catVisOn: U('uCatVisOn'),
    sel: U('uSel'), selOn: U('uSelOn'),
    rule: U('uRule'), ruleOn: U('uRuleOn'),
  };
  const ramp = lutTexture(gl, rampPixels(), 256);
  const palette = lutTexture(gl, palettePixels(), 32);   // LAS classification (points)
  let catPalette = null;                                  // category palette (blocks), lazy
  let blocksPipe = null;                                  // impostor pipeline, lazy
  let sticksPipe = null;                                  // capsule pipeline, lazy
  let meshPipe = null;                                    // context-mesh pipeline, lazy
  let soupPipe = null;                                    // streaming-mesh (soup) pipeline, lazy
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
  // a layer's view of the section: false = exempt, 'front'/'behind' = keep that
  // side only (a half-space is a slab with the far face pushed past the data —
  // same trick the global clip uses, but per layer, derived from sec.d0)
  const layerSecOf = (ls, sec) => {
    const m = ls.sectioned;
    if (!sec || m === false) return m === false ? null : sec;
    if ((m === 'front' || m === 'behind') && sec.d0 !== undefined) {
      const H = Math.max(1e5, 8 * (sec.half || 1));
      return { ...sec, d: m === 'front' ? sec.d0 + H : sec.d0 - H, half: H, clip: m };
    }
    return sec;
  };
  function layerOf(id) {
    let l = layers.get(id);
    if (!l) {
      l = { visible: true, set: 'base', maskTex: null, maskH: 0, isolate: false,
            intensityMax: 1, docChan: [Infinity, -Infinity], catN: 0, stickRadius: 1, sectioned: true,
            meshTint: [0.62, 0.64, 0.66], meshOpacity: 1, opacity: 1, catVisTex: null, rampTex: null, paletteTex: null, paletteW: 0, selTex: null, selH: 0,
            ruleTex: null, ruleH: 0, ruleOn: false };
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
    // background clear colour (also the figure/screenshot backdrop, since EDL
    // passes through background pixels untouched). rgba 0-1; a moving frame
    // re-clears so it takes effect next redraw.
    setBackground(rgba) { if (rgba && rgba.length >= 3) { background[0] = rgba[0]; background[1] = rgba[1]; background[2] = rgba[2]; background[3] = rgba[3] != null ? rgba[3] : 1; needClear = true; } },
    get background() { return [background[0], background[1], background[2], background[3]]; },
    get chunkCount() { return chunks.reduce((s, c) => s + (activeChunk(c) ? 1 : 0), 0); },
    get elementCount() { return chunks.reduce((s, c) => s + (activeChunk(c) ? c.count : 0), 0); },
    // ALL resident chunks (hidden layers + inactive sets included — they hold
    // their buffers), so the number is what the GPU is actually carrying
    get vramBytes() { return chunks.reduce((s, c) => s + (c.bytes || 0), 0); },
    layerVramBytes(layer) { return chunks.reduce((s, c) => s + (c._layer === layer ? (c.bytes || 0) : 0), 0); },
    get accumulated() { return chunks.reduce((s, c) => s + (activeChunk(c) ? c.cursor : 0), 0); },   // elements in the current accumulation
    addChunk(chunk, set = 'base', layer = 0) {
      const ls = layerOf(layer);
      if (layer && chunk.recIdx) {                        // partition the record ids (layer 0 shifts by zero)
        const base = (layer << 29) >>> 0, r = chunk.recIdx;
        for (let i = 0; i < r.length; i++) r[i] = (r[i] | base) >>> 0;
      }
      // honest VRAM accounting: every typed array in the CPU chunk becomes a
      // GPU buffer (bboxLocal's 48 B is noise) — summed here, read as vramBytes
      let cb = 0;
      for (const k in chunk) { const v = chunk[k]; if (v && v.buffer && v.byteLength) cb += v.byteLength; }
      if (chunk.kind === 'mesh') {                        // context tier: static, recordless, whole-draw
        if (!meshPipe) meshPipe = createMeshPipeline(gl);
        const up = meshPipe.upload(chunk); up._set = set; up._layer = layer; up.bytes = cb;
        chunks.push(up);
        needClear = true;                                 // draw it into a fresh accumulation
        return;
      }
      if (chunk.kind === 'soup') {                        // streaming tier: budgeted like points
        if (!soupPipe) soupPipe = createSoupPipeline(gl);
        const up = soupPipe.upload(chunk); up._set = set; up._layer = layer; up.bytes = cb;
        chunks.push(up);                                  // streams INTO the accumulation, no clear
        return;
      }
      if (chunk.kind === 'blocks' || chunk.kind === 'sticks') {
        if (chunk.kind === 'blocks' && !blocksPipe) blocksPipe = createBlocksPipeline(gl);
        if (chunk.kind === 'sticks' && !sticksPipe) sticksPipe = createSticksPipeline(gl);
        const up = (chunk.kind === 'blocks' ? blocksPipe : sticksPipe).upload(chunk);
        up._set = set; up._layer = layer; up.bytes = cb;
        chunks.push(up);                                   // GPU owns it now
        if (set === 'base') {                              // compact chunks never tighten the ramp
          if (chunk.chanRange[0] < ls.docChan[0]) ls.docChan[0] = chunk.chanRange[0];
          if (chunk.chanRange[1] > ls.docChan[1]) ls.docChan[1] = chunk.chanRange[1];
        }
        return;
      }
      const up = uploadChunk(gl, chunk); up._set = set; up._layer = layer; up.bytes = cb;
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
    // stick thickness (world metres) — a live per-layer knob
    setLayerStickRadius(layer, r) { const ls = layerOf(layer); const v = Math.max(0.05, +r || 1); if (ls.stickRadius !== v) { ls.stickRadius = v; needClear = true; } },
    layerStickRadius(layer) { return layerOf(layer).stickRadius; },
    layerChanRange(layer) { const ls = layers.get(layer); return ls && ls.docChan[0] !== Infinity ? [ls.docChan[0], ls.docChan[1]] : null; },
    // per-layer section participation: an exempt layer draws (and picks) whole
    // while the others are slabbed — e.g. topo kept for context during sectioning
    setLayerSectioned(layer, mode) { const ls = layerOf(layer); const v = mode === undefined ? true : mode; if (ls.sectioned !== v) { ls.sectioned = v; needClear = true; } },
    layerSectioned(layer) { const m = layerOf(layer).sectioned; return m === undefined ? true : m; },
    
    // context-mesh style: tint [r,g,b] 0..1 + opacity 0..1 (Bayer screen-door)
    setLayerMeshStyle(layer, { tint, opacity } = {}) {
      const ls = layerOf(layer);
      if (tint) ls.meshTint = tint;
      if (opacity != null) ls.meshOpacity = Math.max(0.02, Math.min(1, +opacity));
      needClear = true;
    },
    layerMeshStyle(layer) { const ls = layerOf(layer); return { tint: ls.meshTint, opacity: ls.meshOpacity }; },
    // per-layer opacity for blocks (box impostors) + sticks (drillholes) — applied
    // as a screen-door dither in their shaders (see-through, no alpha-blend ordering).
    setLayerOpacity(layer, opacity) { const ls = layerOf(layer); ls.opacity = Math.max(0.02, Math.min(1, +opacity)); needClear = true; },
    // block-edge override: null = follow the draw-level blockEdges flag, true/false = force
    setLayerEdges(layer, v) { const ls = layerOf(layer); const nv = v == null ? null : !!v; if (ls.edges !== nv) { ls.edges = nv; needClear = true; } },
    layerEdges(layer) { const v = layerOf(layer).edges; return v === undefined ? null : v; },
    layerOpacity(layer) { return layerOf(layer).opacity; },
    // per-layer SELECTION bitmask (spec §15): same texture shape as the filter
    // mask; selected elements get a warm tint in every element program
    setLayerSelection(layer, mask) {
      const ls = layerOf(layer);
      if (!mask) {
        if (ls.selTex) { gl.deleteTexture(ls.selTex); ls.selTex = null; ls.selH = 0; }
      } else {
        const W = 8192, H = Math.max(1, Math.ceil(mask.length / W));
        const padded = new Uint8Array(W * H);
        for (let i = 0; i < mask.length; i++) padded[i] = mask[i] ? 255 : 0;
        if (ls.selTex && H === ls.selH) {
          gl.bindTexture(gl.TEXTURE_2D, ls.selTex);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RED, gl.UNSIGNED_BYTE, padded);
        } else {
          if (ls.selTex) gl.deleteTexture(ls.selTex);
          ls.selTex = gl.createTexture(); ls.selH = H;
          gl.bindTexture(gl.TEXTURE_2D, ls.selTex);
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, W, H, 0, gl.RED, gl.UNSIGNED_BYTE, padded);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        }
      }
      needClear = true;
    },
    // per-layer RULE CODES (spec §10.4): one byte per record — which styling
    // rule claimed it (0 = none/else, 1..255 = rule order). Same texture shape
    // as the filter mask, but the byte is a VALUE, not a bit: in rule mode it
    // substitutes for the class code, so the palette, the per-class eyes, and
    // pick culling all compose without new machinery.
    setLayerRuleCodes(layer, codes) {
      const ls = layerOf(layer);
      if (!codes) {
        if (ls.ruleTex) { gl.deleteTexture(ls.ruleTex); ls.ruleTex = null; ls.ruleH = 0; }
      } else {
        const W = 8192, H = Math.max(1, Math.ceil(codes.length / W));
        const padded = new Uint8Array(W * H);
        padded.set(codes);
        if (ls.ruleTex && H === ls.ruleH) {
          gl.bindTexture(gl.TEXTURE_2D, ls.ruleTex);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RED, gl.UNSIGNED_BYTE, padded);
        } else {
          if (ls.ruleTex) gl.deleteTexture(ls.ruleTex);
          ls.ruleTex = gl.createTexture(); ls.ruleH = H;
          gl.bindTexture(gl.TEXTURE_2D, ls.ruleTex);
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, W, H, 0, gl.RED, gl.UNSIGNED_BYTE, padded);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        }
      }
      needClear = true;
    },
    // rule mode on/off per layer — kept separate from the codes so switching
    // categorized ⇄ rule-based is a flag flip, no re-upload
    setLayerRuleMode(layer, on) {
      const ls = layerOf(layer);
      if (ls.ruleOn !== !!on) { ls.ruleOn = !!on; needClear = true; }
    },
    // per-layer CATEGORY palette (legend colors/groups baked app-side).
    // pixels = Uint8Array(width*4) RGBA (width 256 for dict layers, 32 for LAS
    // classification — it must match what uPaletteN samples), null = built-ins.
    setLayerPalette(layer, pixels, width = 256) {
      const ls = layerOf(layer);
      if (!pixels) {
        if (ls.paletteTex) { gl.deleteTexture(ls.paletteTex); ls.paletteTex = null; ls.paletteW = 0; }
      } else if (!ls.paletteTex || ls.paletteW !== width) {
        if (ls.paletteTex) gl.deleteTexture(ls.paletteTex);
        ls.paletteTex = lutTexture(gl, pixels, width);
        ls.paletteW = width;
      } else {
        gl.bindTexture(gl.TEXTURE_2D, ls.paletteTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      }
      needClear = true;
    },
    // per-layer color ramp LUT (layer properties: presets + baked breakpoints).
    // pixels = Uint8Array(256*4) RGBA, or null to fall back to the built-in ramp.
    setLayerRamp(layer, pixels) {
      const ls = layerOf(layer);
      if (!pixels) {
        if (ls.rampTex) { gl.deleteTexture(ls.rampTex); ls.rampTex = null; }
      } else if (!ls.rampTex) {
        ls.rampTex = lutTexture(gl, pixels, 256);
      } else {
        gl.bindTexture(gl.TEXTURE_2D, ls.rampTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      }
      needClear = true;
    },
    // per-CLASS visibility (layer properties): vis = Uint8Array(256) of 0|1, or
    // null to clear. GPU-side — the class code already rides every element as
    // an attribute, so eyes are a texture update: no sweeps, any element count.
    // Composes with the filter mask (both are cull paths); hidden classes
    // don't pick either (gl-pick reads the same texture).
    setLayerCatVisibility(layer, vis) {
      const ls = layerOf(layer);
      if (!vis) {
        if (ls.catVisTex) { gl.deleteTexture(ls.catVisTex); ls.catVisTex = null; }
      } else {
        const px = new Uint8Array(256);
        for (let i = 0; i < 256; i++) px[i] = vis[i] ? 255 : 0;
        if (!ls.catVisTex) {
          ls.catVisTex = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, ls.catVisTex);
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 256, 1, 0, gl.RED, gl.UNSIGNED_BYTE, px);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        } else {
          gl.bindTexture(gl.TEXTURE_2D, ls.catVisTex);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RED, gl.UNSIGNED_BYTE, px);
        }
      }
      needClear = true;
    },
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
      if (ls && ls.catVisTex) gl.deleteTexture(ls.catVisTex);
      if (ls && ls.rampTex) gl.deleteTexture(ls.rampTex);
      if (ls && ls.paletteTex) gl.deleteTexture(ls.paletteTex);
      if (ls && ls.selTex) gl.deleteTexture(ls.selTex);
      if (ls && ls.ruleTex) gl.deleteTexture(ls.ruleTex);
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
    // marquee/lasso support (spec §15): render the ID buffer once over a CSS
    // rect and hand back the raw pixels — the app polygon-masks and decodes.
    pickRegion(cssRect, cam, { pointPx = 2.5, blocksAsPoints = false, section = null } = {}) {
      if (!chunks.length) return null;
      if (!pickPipe) pickPipe = createPickPipeline(gl);
      const dpr = window.devicePixelRatio || 1;
      const x = Math.max(0, Math.round(cssRect.x * dpr));
      const yTop = Math.round(cssRect.y * dpr);
      const w = Math.min(canvas.width - x, Math.round(cssRect.w * dpr));
      const h = Math.min(canvas.height, Math.round(cssRect.h * dpr));
      const y = Math.max(0, canvas.height - yTop - h);
      if (w <= 0 || h <= 0) return null;
      const data = pickPipe.pickRegion(x, y, w, h, chunks.filter(activeChunk), cam, {
        pointPx, blocksAsPoints, layerStates: layers,
        section: section && section.on ? section : null,
        viewportW: canvas.width, viewportH: canvas.height,
      });
      return { data, w, h, dpr };                          // rows bottom-up (GL), NO_HIT = 0xFFFFFFFF
    },
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
      for (const ls of layers.values()) { if (ls.maskTex) gl.deleteTexture(ls.maskTex); if (ls.catVisTex) gl.deleteTexture(ls.catVisTex); if (ls.rampTex) gl.deleteTexture(ls.rampTex); if (ls.paletteTex) gl.deleteTexture(ls.paletteTex); if (ls.selTex) gl.deleteTexture(ls.selTex); if (ls.ruleTex) gl.deleteTexture(ls.ruleTex); }
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
    draw(cam, { budget = 3_000_000, pointPx = 2.5, colorMode = 0, blocksAsPoints = false, blockEdges = false, section = null, clip = null, layerOpts = null } = {}) {
      const vp = cam.state.viewProj;
      const sec = section && section.on ? section : null;
      const secKey = sec ? `${sec.n.join(',')}|${sec.d}|${sec.half}` : 'off';
      const clipKey = clip ? `${clip[0]}~${clip[1]}` : 'a';
      const loKey = layerOpts ? JSON.stringify(layerOpts) : '';
      const key = `${pointPx}|${colorMode}|${blocksAsPoints ? 'P' : 'B'}${blockEdges ? 'E' : ''}|${secKey}|${clipKey}|${loKey}|${canvas.width}x${canvas.height}`;
      const moving = vpChanged(vp) || key !== lastKey || needClear;
      lastKey = key; needClear = false;
      if (moving) repaintSet.clear();                      // the full redraw covers any pending repaint

      // frustum-cull + front-to-back over chunk bboxes (tight, thanks to Morton)
      const planes = frustumPlanes(vp);
      const eye = cam.state.eye;
      const visible = [];
      const padBox = new Float64Array(6);
      for (const c of chunks) {
        if (!activeChunk(c)) continue;
        let cullBox = c.bboxLocal;
        if (c.kind === 'sticks') {
          const r = layerOf(c._layer).stickRadius;
          for (let i = 0; i < 3; i++) { padBox[i] = c.bboxLocal[i] - r; padBox[i + 3] = c.bboxLocal[i + 3] + r; }
          cullBox = padBox;
        }
        if (!aabbInFrustum(planes, cullBox)) { if (moving) c.cursor = 0; continue; }
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

      // context meshes first: static occluders drawn WHOLE on clear frames (or
      // when freshly streamed in) — early-z then rejects points behind them.
      // On still frames their cursor == count, so accumulation skips them.
      const msh = visible.filter((c) => c.kind === 'mesh');
      if (msh.length) {
        for (const [id, group] of byLayer(msh)) {
          if (!group.some((c) => moving || c.cursor === 0)) continue;
          const ls = layerOf(id);
          meshPipe.begin(cam, { tint: ls.meshTint, opacity: ls.meshOpacity, section: layerSecOf(ls, sec),
            vcolor: group.some((c) => c.hasColor), vnormal: group.some((c) => c.hasNormal) });   // heightfield drape + smooth normals
          for (const c of group) {
            if (!(moving || c.cursor === 0)) continue;
            meshPipe.draw(c);
            c.cursor = c.count;
            drawn += c.count;
          }
        }
        gl.bindVertexArray(null);
      }

      // streaming-tier meshes: budgeted prefixes like points (the shuffle makes
      // any prefix a uniform subsample of the soup), drawn before points so the
      // surface occludes early
      const soup = visible.filter((c) => c.kind === 'soup');
      if (soup.length) {
        for (const [id, group] of byLayer(soup)) {
          const ls = layerOf(id);
          soupPipe.begin(cam, { tint: ls.meshTint, opacity: ls.meshOpacity, section: layerSecOf(ls, sec) });
          for (const c of group) {
            const [first, k] = allot(c);
            if (k > 0) {
              soupPipe.drawSlice(c, first, k);
              drawn += k; c.cursor = first + k;
            }
            if (c.cursor < c.count) converged = false;
          }
        }
        gl.bindVertexArray(null);
      }

      const pts = visible.filter((c) => c.kind === 'points');
      if (pts.length) {
        const ptsGroups = byLayer(pts);
        gl.useProgram(prog);
        gl.uniformMatrix4fv(uni.viewProj, false, vp);
        gl.uniform1f(uni.pointPx, pointPx * (window.devicePixelRatio || 1));
        gl.uniform1ui(uni.picked, pickedRec);
        gl.uniform2ui(uni.repaint, 0xFFFFFFFF, 0xFFFFFFFF);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, ramp); gl.uniform1i(uni.ramp, 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, palette); gl.uniform1i(uni.palette, 1);
        // per-layer uniforms + slices (front-to-back preserved within each group)
        const setupPtsLayer = (id) => {
          const ls = layerOf(id), o = lopt(id), zr = zRangeOf(o);
          const lsec = layerSecOf(ls, sec);
          gl.uniform4f(uni.secPlane, lsec ? lsec.n[0] : 0, lsec ? lsec.n[1] : 0, lsec ? lsec.n[2] : 1, lsec ? lsec.d : 0);
          gl.uniform2f(uni.secCfg, lsec ? 1 : 0, lsec ? lsec.half : 0);
          gl.uniform1i(uni.colorMode, o.colorMode);
          gl.uniform2f(uni.zRange, zr[0], zr[1]);
          gl.uniform1f(uni.intensityScale, 65535 / (ls.intensityMax || 1));
          gl.uniform1f(uni.paletteN, ls.paletteTex ? ls.paletteW : (ls.catN || 32));
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, ls.paletteTex || (ls.catN && catPalette ? catPalette : palette));
          gl.uniform1i(uni.palette, 1);
          gl.uniform1f(uni.filterOn, ls.maskTex ? 1 : 0);
          gl.uniform1f(uni.isolate, ls.isolate ? 1 : 0);
          if (ls.maskTex) { gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, ls.maskTex); gl.uniform1i(uni.mask, 4); }
          gl.uniform1f(uni.catVisOn, ls.catVisTex ? 1 : 0);
          if (ls.catVisTex) { gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, ls.catVisTex); gl.uniform1i(uni.catVis, 5); }
          gl.uniform1f(uni.selOn, ls.selTex ? 1 : 0);
          if (ls.selTex) { gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, ls.selTex); gl.uniform1i(uni.sel, 6); }
          gl.uniform1f(uni.ruleOn, ls.ruleOn && ls.ruleTex ? 1 : 0);
          if (ls.ruleOn && ls.ruleTex) { gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, ls.ruleTex); gl.uniform1i(uni.rule, 7); }
          gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, ls.rampTex || ramp); gl.uniform1i(uni.ramp, 0);
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
          // sub-blocked: fine grid.size is the min pitch — use the largest box radius
          const rBlock = c.dimPalette
            ? Math.max(...c.dimPalette.map((h) => Math.hypot(h[0], h[1], h[2])))
            : Math.hypot(c.grid.size[0], c.grid.size[1], c.grid.size[2]) / 2;
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
            ramp: ls.rampTex || ramp, palette: ls.paletteTex || catPalette || palette, viewportH: canvas.height,
            maskTex: ls.maskTex, isolate: ls.isolate, pointsView: blocksAsPoints, picked: pickedRec,
            section: layerSecOf(ls, sec),
            catVisTex: ls.catVisTex, selTex: ls.selTex, ruleTex: ls.ruleOn ? ls.ruleTex : null,
            opacity: ls.opacity, edges: ls.edges != null ? ls.edges : blockEdges,   // per-layer override, else the View toggle
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
      const stks = visible.filter((c) => c.kind === 'sticks');
      if (stks.length) {
        const stkGroups = byLayer(stks);
        const perspScale2 = cam.state.ortho ? (canvas.height / 2) / cam.state.halfH : (canvas.height / 2) / Math.tan(cam.state.fovY / 2);
        const cheapOf2 = (c) => {
          // whole chunk under the demotion threshold → the no-fragdepth program
          const ls = layerOf(c._layer);
          const b = c.bboxLocal;
          const bboxR = Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2;
          const distNear = Math.max(cam.state.near, c._dist - bboxR);
          // a generous per-chunk proxy: the layer radius at the chunk's nearest point
          return blocksAsPoints || (ls.stickRadius * 4) * perspScale2 / (cam.state.ortho ? 1 : distNear) < 2.0;
        };
        const beginStkLayer = (id) => {
          const ls = layerOf(id), o = lopt(id);
          const cLo = o.clip && o.clip[0] != null && o.colorMode === 1 ? o.clip[0] : (ls.docChan[0] === Infinity ? 0 : ls.docChan[0]);
          const cHi = o.clip && o.clip[1] != null && o.colorMode === 1 ? o.clip[1] : ls.docChan[1];
          sticksPipe.begin(cam, {
            pointPx, colorMode: o.colorMode, zRange: zRangeOf(o),
            chanDoc: [cLo, cHi > cLo ? cHi - cLo : 1],
            ramp: ls.rampTex || ramp, palette: ls.paletteTex || catPalette || palette, viewportH: canvas.height,
            maskTex: ls.maskTex, isolate: ls.isolate, pointsView: blocksAsPoints, picked: pickedRec,
            section: layerSecOf(ls, sec),
            radius: ls.stickRadius, catVisTex: ls.catVisTex, selTex: ls.selTex, ruleTex: ls.ruleOn ? ls.ruleTex : null,
            opacity: ls.opacity,
          });
        };
        for (const [id, group] of stkGroups) {
          beginStkLayer(id);
          for (const c of group) {
            const [first, k] = allot(c);
            if (k > 0) {
              sticksPipe.drawSlice(c, first, k, cheapOf2(c));
              drawn += k; c.cursor = first + k;
            }
            if (c.cursor < c.count) converged = false;
          }
        }
        if (rp) {
          gl.depthFunc(gl.LEQUAL);
          for (const [id, group] of stkGroups) {
            beginStkLayer(id);
            sticksPipe.setRepaint(rp[0], rp[1]);
            for (const c of group) sticksPipe.drawSlice(c, 0, c.count, cheapOf2(c));
          }
          sticksPipe.setRepaint(0xFFFFFFFF, 0xFFFFFFFF);
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
