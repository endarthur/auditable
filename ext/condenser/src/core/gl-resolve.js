// @gcu/condenser — DEFERRED RE-SHADE (render-paths spec §2). Once the scene
// has converged, the pick pipeline's full-viewport (record, layer|face) id
// buffer is kept as a texture, and COSMETIC changes — ramp, clip, colour
// mode, filter (dim), selection, chanTex values — run ONE fullscreen resolve
// pass per element layer instead of re-rasterizing the geometry. O(pixels)
// at any model size: a ramp drag over a 50M-block model recolours at refresh
// rate instead of restarting the accumulation.
//
// Two GPU pieces, no CPU data needed:
//   bake    — per layer, scatter each element's (z, value, category, rgb) to
//             its RECORD's texel in an 8192-wide RGBA32F attribute texture
//             (one point-draw over the layer's chunks; works for streamed
//             models whose columns were never CPU-resident).
//   resolve — fullscreen triangle per layer: id → attr texel → the SAME
//             colour math the raster shaders use (parity by construction,
//             including the raster shaders' per-kind wash order), written
//             into the EDL colour buffer; `discard` leaves background /
//             mesh / other-layer pixels untouched, and the untouched EDL
//             depth still shades the presented frame.
//
// Blocks' per-face impostor lighting reconstructs from the id buffer's FACE
// code (gl-pick names the plane the eye ray entered): shade = (0.55 +
// 0.45·max(n·L,0)) · (cut ? 0.85 : 1) — the exact gl-blocks formula. Splat-
// demoted pixels (NO_FACE) stay unlit, exactly as rasterized. Out of scope
// (the caller falls back to re-raster): block EDGE lines (need the intra-face
// hit position), opacity < 1 (screen-door), catVis / isolate (they CULL
// geometry, so the id buffer itself goes stale), sticks / soup layers.

import { makeProgram } from './gl-util.js';
import { FACE_NORMALS } from './gl-pick.js';

const TEXW = 8192;

// ── bake shaders: element → its record's texel ──────────────────────────────
const BAKE_VERT_BLOCKS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aIjk;
layout(location=1) in float aChan;
layout(location=2) in float aCat;
layout(location=3) in uint aRec;
uniform vec3 uGridOrigin, uGridSize;
uniform vec2 uChanChunk;                 // this chunk's [min, span] (dequantize aChan)
uniform vec2 uTexSize;
flat out vec4 vAttr;
void main() {
  int rec = int(aRec);
  vec2 px = vec2(float(rec & 8191) + 0.5, float(rec >> 13) + 0.5);
  gl_Position = vec4(px / uTexSize * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
  float z = uGridOrigin.z + aIjk.z * uGridSize.z;
  vAttr = vec4(z, uChanChunk.x + aChan * uChanChunk.y, aCat, 0.0);
}`;

const BAKE_VERT_POINTS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in float aIntensity;
layout(location=2) in float aClass;
layout(location=3) in vec3 aRgb;
layout(location=4) in uint aRec;
uniform vec3 uBoxMin, uBoxSpan;
uniform vec2 uTexSize;
flat out vec4 vAttr;
void main() {
  int rec = int(aRec);
  vec2 px = vec2(float(rec & 8191) + 0.5, float(rec >> 13) + 0.5);
  gl_Position = vec4(px / uTexSize * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
  float z = uBoxMin.z + aPos.z * uBoxSpan.z;
  // rgb packs into one float exactly (24 bits fit f32's 24-bit mantissa)
  float rgb = floor(aRgb.r * 255.0 + 0.5) + floor(aRgb.g * 255.0 + 0.5) * 256.0 + floor(aRgb.b * 255.0 + 0.5) * 65536.0;
  vAttr = vec4(z, aIntensity, aClass, rgb);
}`;

const BAKE_FRAG = `#version 300 es
precision highp float;
flat in vec4 vAttr;
out vec4 outAttr;
void main() { outAttr = vAttr; }`;

// ── the resolve pass: id → attrs → the raster shaders' colour math ──────────
const RESOLVE_VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const RESOLVE_FRAG = `#version 300 es
precision highp float;
precision highp usampler2D;
uniform usampler2D uId;                  // RG32UI: R = record, G = layer | face<<16 (NO_LAYER = miss)
uniform sampler2D uAttr;                 // baked (z, value, cat, rgbPacked) by record
uniform sampler2D uRamp, uPalette, uMask, uSel, uRule, uChanTex;
uniform sampler2D uDepth;                // the capture's hit depths (edge-line unproject)
uniform uint uLayerId, uPicked, uPickedLayer;
uniform int uKind;                       // 0 = points, 1 = blocks
uniform int uColorMode;
uniform vec2 uZRange, uChanDoc;
uniform float uPaletteN, uIntensityScale;
uniform float uFilterOn, uSelOn, uRuleOn, uChanTexOn;
uniform vec3 uLightDir, uCutNormal;
uniform vec3 uFaceN[6];                  // gl-pick's FACE_NORMALS
uniform float uEdgesOn, uOrtho, uPerspScale;
uniform mat4 uInvVP;                     // inverse viewProj: (pixel, depth) → world hit point
uniform vec2 uViewport;
uniform vec3 uEyePos, uGridOrigin, uGridSize;   // the blocks layer's lattice (regular grids only)
out vec4 outColor;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  uvec2 id = texelFetch(uId, px, 0).rg;
  if (id.g == 0xFFFFFFFFu) discard;                        // background: untouched
  uint layer = id.g & 0xFFFFu;
  if (layer != uLayerId) discard;                          // mesh / other layers: untouched
  int rec = int(id.r);
  ivec2 at = ivec2(rec & 8191, rec >> 13);
  vec4 attr = texelFetch(uAttr, at, 0);
  float cls = attr.z;
  if (uRuleOn > 0.5) cls = floor(texelFetch(uRule, at, 0).r * 255.0 + 0.5);
  vec4 col;
  if (uColorMode == 0) {                                   // elevation (both kinds)
    float t = clamp((attr.x - uZRange.x) / max(uZRange.y, 1e-6), 0.0, 1.0);
    col = texture(uRamp, vec2(t, 0.5));
  } else if (uColorMode == 1) {
    if (uKind == 1) {                                      // blocks: grade (doc-normalized)
      float v = uChanTexOn > 0.5 ? texelFetch(uChanTex, at, 0).r : attr.y;
      float t = clamp((v - uChanDoc.x) / max(uChanDoc.y, 1e-6), 0.0, 1.0);
      col = texture(uRamp, vec2(t, 0.5));
    } else {                                               // points: intensity
      float t = clamp(attr.y * uIntensityScale, 0.0, 1.0);
      col = texture(uRamp, vec2(t, 0.5));
    }
  } else if (uColorMode == 2) {                            // category / classification
    col = texture(uPalette, vec2((cls + 0.5) / uPaletteN, 0.5));
  } else {
    if (uKind == 1) col = vec4(0.62, 0.63, 0.66, 1.0);     // blocks: solid
    else {                                                 // points: rgb (unpack)
      float p3 = attr.w;
      float b = floor(p3 / 65536.0); p3 -= b * 65536.0;
      float g = floor(p3 / 256.0); p3 -= g * 256.0;
      col = vec4(p3 / 255.0, g / 255.0, b / 255.0, 1.0);
    }
  }
  float m = 1.0;
  if (uFilterOn > 0.5) m = texelFetch(uMask, at, 0).r > 0.5 ? 1.0 : 0.0;
  float selHit = uSelOn > 0.5 ? texelFetch(uSel, at, 0).r : 0.0;
  // wash order matches each kind's raster shader EXACTLY: gl.js points dim
  // THEN sel-wash; gl-blocks sel-washes THEN dims. Only both-at-once pixels
  // differ between the orders, but parity is the contract here.
  if (uKind == 1) {
    if (selHit > 0.5) col = vec4(mix(col.rgb, vec3(1.0, 0.85, 0.3), 0.55), col.a);
    if (uFilterOn > 0.5 && m < 0.5) col = vec4(col.rgb * 0.3, col.a);
  } else {
    if (uFilterOn > 0.5 && m < 0.5) col = vec4(col.rgb * 0.3, col.a);
    if (selHit > 0.5) col = vec4(mix(col.rgb, vec3(1.0, 0.85, 0.3), 0.55), col.a);
  }
  if (id.r == uPicked && layer == uPickedLayer) col = vec4(mix(col.rgb, vec3(1.0, 0.15, 0.7), 0.85) + 0.1, col.a);
  float shade = 1.0;
  if (uKind == 1) {                                        // blocks: per-face impostor lighting
    uint face = (id.g >> 16) & 7u;
    if (face < 6u) shade = 0.55 + 0.45 * max(dot(uFaceN[face], uLightDir), 0.0);
    else if (face == 6u) shade = (0.55 + 0.45 * max(dot(uCutNormal, uLightDir), 0.0)) * 0.85;   // the section cut wall
    // face 7 (NO_FACE): a demoted splat — unlit, as rasterized (and no edges)
    // BLOCK EDGE LINES (gl-blocks' exact math): the capture depth gives back
    // the hit point — unproject it, snap the block centre from the face plane
    // + the regular lattice, and the box-local coords fall out. Sub-blocked
    // models (per-block half-dims) can't reconstruct the centre this way and
    // fall back to the re-raster before we get here.
    if (uEdgesOn > 0.5 && face < 7u) {
      float dz = texelFetch(uDepth, px, 0).r;
      vec2 xy = (gl_FragCoord.xy / uViewport) * 2.0 - 1.0;
      vec4 hp = uInvVP * vec4(xy, dz * 2.0 - 1.0, 1.0);
      vec3 p = hp.xyz / hp.w;
      vec3 half_ = uGridSize * 0.5;
      // the pixel ray (also perturbed rays below, for the analytic derivative)
      vec4 rA = uInvVP * vec4(xy, -1.0, 1.0);
      vec4 rB = uInvVP * vec4(xy, 1.0, 1.0);
      vec3 ro = rA.xyz / rA.w, rd = rB.xyz / rB.w - ro;
      float pv = 0.0; int ax = 0;
      if (face < 6u) {
        // depth only PICKS the lattice face plane; the position comes from
        // re-intersecting the ray with that exact plane (no 24-bit jitter)
        ax = int(face >> 1);
        float o0 = uGridOrigin[ax] - half_[ax];
        pv = o0 + round((p[ax] - o0) / uGridSize[ax]) * uGridSize[ax];
        if (abs(rd[ax]) > 1e-12) p = ro + rd * ((pv - ro[ax]) / rd[ax]);
        p[ax] = pv;
      }
      vec3 base = face < 6u ? p - uFaceN[face] * half_ : p;   // face pixel: step inward; cut pixel: already interior
      vec3 center = uGridOrigin + vec3(round((base.x - uGridOrigin.x) / uGridSize.x), round((base.y - uGridOrigin.y) / uGridSize.y), round((base.z - uGridOrigin.z) / uGridSize.z)) * uGridSize;
      vec3 a2 = abs(p - center) / half_;
      float m1 = max(a2.x, max(a2.y, a2.z));
      float m2 = max(min(a2.x, a2.y), min(max(a2.x, a2.y), a2.z));
      float e = face == 6u ? m1 : m2;
      // ANALYTIC screen derivative of e: fwidth() cancels at block seams (e is
      // symmetric across them — …0.8, 1.0 │ 1.0, 0.8…), erasing the lines
      // exactly where they live; the raster never sees that because each
      // impostor is its own primitive with helper-invocation derivatives. So
      // evaluate e at the hardware's own 2×2 QUAD positions — rays through the
      // quad-aligned pixels, intersected with THIS pixel's plane — and
      // difference them ourselves. Quad alignment matters: it reproduces the
      // raster's per-quad-shared derivative, phase and all.
      float cutD = dot(p, uCutNormal);
      vec2 qb = floor(gl_FragCoord.xy * 0.5) * 2.0 + 0.5;
      float eq[3];
      for (int k = 0; k < 3; k++) {
        vec2 fxy = k == 0 ? qb : (k == 1 ? qb + vec2(1.0, 0.0) : qb + vec2(0.0, 1.0));
        vec2 nxy = (fxy / uViewport) * 2.0 - 1.0;
        vec4 qA = uInvVP * vec4(nxy, -1.0, 1.0);
        vec4 qB = uInvVP * vec4(nxy, 1.0, 1.0);
        vec3 qo = qA.xyz / qA.w, qd = qB.xyz / qB.w - qo;
        vec3 q;
        if (face < 6u) { float den = qd[ax]; q = abs(den) > 1e-12 ? qo + qd * ((pv - qo[ax]) / den) : p; }
        else { float den = dot(qd, uCutNormal); q = abs(den) > 1e-9 ? qo + qd * ((cutD - dot(qo, uCutNormal)) / den) : p; }
        vec3 aq = abs(q - center) / half_;
        float q1 = max(aq.x, max(aq.y, aq.z));
        float q2 = max(min(aq.x, aq.y), min(max(aq.x, aq.y), aq.z));
        eq[k] = face == 6u ? q1 : q2;
      }
      float fw = abs(eq[1] - eq[0]) + abs(eq[2] - eq[0]);
      float dpx = (1.0 - e) / max(fw, 1e-6);
      float edge = 1.0 - clamp(dpx * 0.7 - 0.3, 0.0, 1.0);
      float distE = uOrtho > 0.5 ? 1.0 : max(distance(uEyePos, center), 1e-3);
      float pxR = length(half_) * uPerspScale / distE;
      edge *= clamp((pxR - 5.0) / 8.0, 0.0, 1.0);          // fade toward demotion, as rasterized
      shade *= 1.0 - 0.4 * edge;
    }
  }
  outColor = vec4(col.rgb * shade, col.a);
}`;

export function createResolvePipeline(gl) {
  // the bake target is RGBA32F — colour-renderable only with this extension;
  // absent (rare on WebGL2-era GPUs) the whole feature quietly disables and
  // every cosmetic change re-rasters, exactly as before.
  const floatOk = !!gl.getExtension('EXT_color_buffer_float');
  const bakeBlocks = makeProgram(gl, BAKE_VERT_BLOCKS, BAKE_FRAG);
  const bakePoints = makeProgram(gl, BAKE_VERT_POINTS, BAKE_FRAG);
  const resolveProg = makeProgram(gl, RESOLVE_VERT, RESOLVE_FRAG);
  const U = (p, n) => gl.getUniformLocation(p, n);
  const uB = { gridOrigin: U(bakeBlocks, 'uGridOrigin'), gridSize: U(bakeBlocks, 'uGridSize'), chanChunk: U(bakeBlocks, 'uChanChunk'), texSize: U(bakeBlocks, 'uTexSize') };
  const uP = { boxMin: U(bakePoints, 'uBoxMin'), boxSpan: U(bakePoints, 'uBoxSpan'), texSize: U(bakePoints, 'uTexSize') };
  const uR = {
    id: U(resolveProg, 'uId'), attr: U(resolveProg, 'uAttr'), ramp: U(resolveProg, 'uRamp'), palette: U(resolveProg, 'uPalette'),
    mask: U(resolveProg, 'uMask'), sel: U(resolveProg, 'uSel'), rule: U(resolveProg, 'uRule'), chanTex: U(resolveProg, 'uChanTex'),
    layerId: U(resolveProg, 'uLayerId'), picked: U(resolveProg, 'uPicked'), pickedLayer: U(resolveProg, 'uPickedLayer'),
    kind: U(resolveProg, 'uKind'), colorMode: U(resolveProg, 'uColorMode'), zRange: U(resolveProg, 'uZRange'), chanDoc: U(resolveProg, 'uChanDoc'),
    paletteN: U(resolveProg, 'uPaletteN'), intensityScale: U(resolveProg, 'uIntensityScale'),
    filterOn: U(resolveProg, 'uFilterOn'), selOn: U(resolveProg, 'uSelOn'), ruleOn: U(resolveProg, 'uRuleOn'), chanTexOn: U(resolveProg, 'uChanTexOn'),
    lightDir: U(resolveProg, 'uLightDir'), cutNormal: U(resolveProg, 'uCutNormal'), faceN: U(resolveProg, 'uFaceN'),
    depth: U(resolveProg, 'uDepth'), edgesOn: U(resolveProg, 'uEdgesOn'), ortho: U(resolveProg, 'uOrtho'), perspScale: U(resolveProg, 'uPerspScale'),
    invVP: U(resolveProg, 'uInvVP'), viewport: U(resolveProg, 'uViewport'), eyePos: U(resolveProg, 'uEyePos'),
    gridOrigin: U(resolveProg, 'uGridOrigin'), gridSize: U(resolveProg, 'uGridSize'),
  };
  const IDENT4 = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  const bakeFbo = gl.createFramebuffer();
  const bakes = new Map();                                 // layerId → { tex, h }
  const faceFlat = new Float32Array(18);
  for (let i = 0; i < 6; i++) { const n = FACE_NORMALS[i]; faceFlat[i * 3] = n[0]; faceFlat[i * 3 + 1] = n[1]; faceFlat[i * 3 + 2] = n[2]; }

  // one bake VAO per blocks chunk: the same buffers the instanced VAO uses, but
  // re-pointed per-VERTEX (divisor 0) so one gl.POINTS draw scatters every block
  function blocksBakeVao(c) {
    if (c._bakeVao) return c._bakeVao;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, c.bIjk); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.UNSIGNED_SHORT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, c.bChan); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.UNSIGNED_SHORT, true, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, c.bCat); gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.UNSIGNED_BYTE, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, c.bRec); gl.enableVertexAttribArray(3); gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_INT, 0, 0);
    gl.bindVertexArray(null);
    c._bakeVao = vao;
    return vao;
  }

  return {
    ok: floatOk,
    // (re)bake one layer's attribute texture from its resident chunks.
    // maxRec = 1 + the highest record index the caller has seen for the layer.
    // Leaves the FBO at null and the viewport at the bake size — the caller
    // (inside the EDL sceneDraw) restores its own binding + viewport after.
    bakeLayer(layerId, chunksOfLayer, maxRec) {
      if (!floatOk || !chunksOfLayer.length || !maxRec) return null;
      const h = Math.max(1, Math.ceil(maxRec / TEXW));
      let b = bakes.get(layerId);
      if (!b || b.h < h) {
        if (b) gl.deleteTexture(b.tex);
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TEXW, h, 0, gl.RGBA, gl.FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        b = { tex, h };
        bakes.set(layerId, b);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, bakeFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, b.tex, 0);
      gl.viewport(0, 0, TEXW, b.h);
      gl.disable(gl.DEPTH_TEST);
      const kind = chunksOfLayer[0].kind;
      if (kind === 'blocks') {
        gl.useProgram(bakeBlocks);
        gl.uniform2f(uB.texSize, TEXW, b.h);
        for (const c of chunksOfLayer) {
          const g = c.grid;
          gl.uniform3f(uB.gridOrigin, g.originLocal[0], g.originLocal[1], g.originLocal[2]);
          gl.uniform3f(uB.gridSize, g.size[0], g.size[1], g.size[2]);
          const span = c.chanRange[1] - c.chanRange[0];
          gl.uniform2f(uB.chanChunk, c.chanRange[0], span > 0 ? span : 0);
          gl.bindVertexArray(blocksBakeVao(c));
          gl.drawArrays(gl.POINTS, 0, c.count);
        }
      } else {
        gl.useProgram(bakePoints);
        gl.uniform2f(uP.texSize, TEXW, b.h);
        for (const c of chunksOfLayer) {
          const bb = c.bboxLocal;
          gl.uniform3f(uP.boxMin, bb[0], bb[1], bb[2]);
          gl.uniform3f(uP.boxSpan, bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2]);
          gl.bindVertexArray(c.vao);                       // per-vertex layout already, locations match
          gl.drawArrays(gl.POINTS, 0, c.count);
        }
      }
      gl.bindVertexArray(null);
      gl.enable(gl.DEPTH_TEST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return b;
    },
    hasBake(layerId) { return bakes.has(layerId); },
    dropBake(layerId) { const b = bakes.get(layerId); if (b) { gl.deleteTexture(b.tex); bakes.delete(layerId); } },
    // one fullscreen pass for one layer, into the CURRENTLY BOUND framebuffer
    // (the EDL colour buffer). `u` carries the same per-layer values the raster
    // path's begin/setup functions computed. Depth stays untouched.
    resolveLayer(idTex, layerId, u) {
      const b = bakes.get(layerId);
      if (!b) return false;
      gl.useProgram(resolveProg);
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      const bind = (unit, loc, tex) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(loc, unit); };
      bind(0, uR.id, idTex);
      bind(1, uR.attr, b.tex);
      bind(2, uR.ramp, u.ramp);
      bind(3, uR.palette, u.palette);
      // every float sampler MUST land on a float texture: an unset sampler
      // uniform defaults to unit 0 — the INTEGER id texture — and that type
      // mismatch silently kills the whole draw (GL_INVALID_OPERATION). The
      // ramp parks the unused ones; their On-flags gate actual sampling.
      bind(4, uR.mask, u.mask || u.ramp);
      bind(5, uR.sel, u.sel || u.ramp);
      bind(6, uR.rule, u.rule || u.ramp);
      bind(7, uR.chanTex, u.chanTex || u.ramp);
      bind(8, uR.depth, (u.edges && u.depth) || u.ramp);   // depth-as-sampler2D: .r is the depth (compare mode NONE)
      gl.uniform1f(uR.edgesOn, u.edges && u.depth ? 1 : 0);
      gl.uniform1f(uR.ortho, u.ortho ? 1 : 0);
      gl.uniform1f(uR.perspScale, u.perspScale || 1);
      gl.uniformMatrix4fv(uR.invVP, false, u.invVP || IDENT4);
      gl.uniform2f(uR.viewport, u.viewportW || 1, u.viewportH || 1);
      gl.uniform3f(uR.eyePos, u.eye ? u.eye[0] : 0, u.eye ? u.eye[1] : 0, u.eye ? u.eye[2] : 0);
      gl.uniform3f(uR.gridOrigin, u.grid ? u.grid.originLocal[0] : 0, u.grid ? u.grid.originLocal[1] : 0, u.grid ? u.grid.originLocal[2] : 0);
      gl.uniform3f(uR.gridSize, u.grid ? u.grid.size[0] : 1, u.grid ? u.grid.size[1] : 1, u.grid ? u.grid.size[2] : 1);
      gl.uniform1ui(uR.layerId, layerId >>> 0);
      gl.uniform1ui(uR.picked, u.picked >>> 0);
      gl.uniform1ui(uR.pickedLayer, u.pickedLayer >>> 0);
      gl.uniform1i(uR.kind, u.kind === 'blocks' ? 1 : 0);
      gl.uniform1i(uR.colorMode, u.colorMode | 0);
      gl.uniform2f(uR.zRange, u.zRange[0], u.zRange[1]);
      gl.uniform2f(uR.chanDoc, u.chanDoc[0], u.chanDoc[1]);
      gl.uniform1f(uR.paletteN, u.paletteN);
      gl.uniform1f(uR.intensityScale, u.intensityScale);
      gl.uniform1f(uR.filterOn, u.mask ? 1 : 0);
      gl.uniform1f(uR.selOn, u.sel ? 1 : 0);
      gl.uniform1f(uR.ruleOn, u.rule ? 1 : 0);
      gl.uniform1f(uR.chanTexOn, u.chanTex ? 1 : 0);
      gl.uniform3f(uR.lightDir, u.lightDir[0], u.lightDir[1], u.lightDir[2]);
      gl.uniform3f(uR.cutNormal, u.cutNormal[0], u.cutNormal[1], u.cutNormal[2]);
      gl.uniform3fv(uR.faceN, faceFlat);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.depthMask(true);
      gl.enable(gl.DEPTH_TEST);
      return true;
    },
    clear() { for (const b of bakes.values()) gl.deleteTexture(b.tex); bakes.clear(); },
  };
}
