// @gcu/condenser — box impostors for block models (micro-spec §2.3).
// One screen-aligned quad per block (instanced TRIANGLE_STRIP — no point-sprite
// size cap): the vertex shader expands a camera-basis billboard sized to the
// block's bounding sphere; the fragment shader ray-intersects the block's ACTUAL
// AABB analytically (slab test), discards on miss, writes correct gl_FragDepth
// and the face normal on hit → pixel-perfect cube silhouettes and correct
// inter-block occlusion at one quad per block. Face-normal flat shading; EDL
// does the rest on top.
//
// LOD demotion: a block whose projected radius falls below ~2 px renders as a
// plain circular splat (no ray test) — near field looks like blocks, far field
// looks like the dense cloud it visually is (§2.3).
//
// WebGL2 has no baseInstance, so accumulation slices [first, first+k) work by
// re-pointing the instance attributes at byte offsets before each draw — the
// chunk's VAO records the new pointers (cheap: 3 pointer calls per chunk-draw).
//
// Positions are IJK-exact (§2.5): center = uGridOrigin + aIjk · uGridSize, with
// uGridOrigin the frame-local centroid of block (0,0,0).

import { makeProgram } from './gl-util.js';

const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aIjk;        // uint16 raw (integer lattice)
layout(location=1) in float aChan;      // uint16 normalized (per-chunk range)
layout(location=2) in float aCat;       // uint8 raw
layout(location=3) in uint aRec;        // uint32 record index (the join key)
uniform mat4 uViewProj;
uniform vec3 uEye, uRight, uUp;
uniform vec3 uGridOrigin, uGridSize;
uniform float uPerspScale;              // persp: px/world at distance 1; ortho: px/world flat
uniform float uOrtho;                   // 1 = orthographic (skip the /dist)
uniform float uDemotePx, uPointPx;
uniform int uColorMode;                 // 0 elevation | 1 grade | 2 category | 3 solid
uniform vec2 uZRange;
uniform vec2 uChanChunk;                // this chunk's [min, span] (dequantize aChan)
uniform vec2 uChanDoc;                  // document [min, span] (ramp normalization)
uniform sampler2D uRamp;
uniform sampler2D uPalette;
uniform sampler2D uMask;                // filter bitmask by record index (8192-wide)
uniform float uFilterOn, uIsolate;
uniform float uForceSplat;              // 1 = whole chunk demoted (cheap far-field path)
uniform float uFixedSplat;              // 1 = points view: fixed-px splats regardless of block size
uniform uint uPicked;                   // record index to highlight (0xFFFFFFFF = none)
uniform uvec2 uRepaint;                 // repaint pass: draw ONLY these two records (both 0xFFFFFFFF = off)
uniform vec4 uSecPlane;                 // section plane: xyz = unit normal, w = offset (frame-local)
uniform vec2 uSecCfg;                   // x: 0 = off, 1 = slab; y: slab half-thickness
flat out vec3 vCenter;
flat out vec3 vHalf;
flat out vec4 vColor;
flat out float vMode;                   // 0 = impostor, 1 = splat
flat out float vCull;
out vec2 vCorner;
out vec3 vWorldPos;
void main() {
  vec3 center = uGridOrigin + aIjk * uGridSize;
  vec3 half_ = uGridSize * 0.5;
  float r = length(half_);
  float dist = max(distance(uEye, center), 1e-3);
  float distEff = uOrtho > 0.5 ? 1.0 : dist;              // ortho: size is distance-free
  float pxR = r * uPerspScale / distEff;
  float demoted = max(max(pxR < uDemotePx ? 1.0 : 0.0, uForceSplat), uFixedSplat);
  // filter mask: dim (default) or cull (isolate)
  float m = 1.0;
  if (uFilterOn > 0.5) {
    int rec = int(aRec & 0x1FFFFFFFu);  // low 29 bits = the record (top 3 = layer)
    m = texelFetch(uMask, ivec2(rec & 8191, rec >> 13), 0).r > 0.5 ? 1.0 : 0.0;
  }
  float secCull = (uSecCfg.x > 0.5 && abs(dot(center, uSecPlane.xyz) - uSecPlane.w) > uSecCfg.y) ? 1.0 : 0.0;   // centroid-in-slab
  vCull = max((uIsolate > 0.5 && m < 0.5) ? 1.0 : 0.0, secCull);
  float quadR = uFixedSplat > 0.5
    ? uPointPx * 0.5 * distEff / uPerspScale
    : mix(r, max(uPointPx * 0.5, pxR) * distEff / uPerspScale, demoted);
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;
  vec3 wp = center + (uRight * corner.x + uUp * corner.y) * quadR;
  gl_Position = uViewProj * vec4(wp, 1.0);
  vCenter = center; vHalf = half_; vMode = demoted; vCorner = corner; vWorldPos = wp;
  if (uColorMode == 0) {
    float t = clamp((center.z - uZRange.x) / max(uZRange.y, 1e-6), 0.0, 1.0);
    vColor = texture(uRamp, vec2(t, 0.5));
  } else if (uColorMode == 1) {
    float v = uChanChunk.x + aChan * uChanChunk.y;
    float t = clamp((v - uChanDoc.x) / max(uChanDoc.y, 1e-6), 0.0, 1.0);
    vColor = texture(uRamp, vec2(t, 0.5));
  } else if (uColorMode == 2) {
    vColor = texture(uPalette, vec2((aCat + 0.5) / 256.0, 0.5));
  } else {
    vColor = vec4(0.62, 0.63, 0.66, 1.0);
  }
  if (uFilterOn > 0.5 && m < 0.5) vColor = vec4(vColor.rgb * 0.3, vColor.a);   // context mode: dim non-matching (still legible)
  if (aRec == uPicked) vColor = vec4(mix(vColor.rgb, vec3(1.0, 0.15, 0.7), 0.85) + 0.1, vColor.a);   // picked: hot magenta — the hue viridis doesn't have
  if ((uRepaint.x != 0xFFFFFFFFu || uRepaint.y != 0xFFFFFFFFu) && aRec != uRepaint.x && aRec != uRepaint.y) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);   // repaint pass: everything else clips out
}`;

const FRAG = `#version 300 es
precision highp float;
flat in vec3 vCenter;
flat in vec3 vHalf;
flat in vec4 vColor;
flat in float vMode;
flat in float vCull;
in vec2 vCorner;
in vec3 vWorldPos;
uniform vec3 uEye;
uniform vec3 uFwd;                      // view direction (ortho rays are parallel)
uniform float uOrthoRay;                // 1 = ortho: origin per fragment, direction = uFwd
uniform float uBackoff;                 // how far behind the quad the ortho ray starts
uniform vec3 uLightDir;
uniform mat4 uViewProj;
out vec4 outColor;
void main() {
  if (vCull > 0.5) discard;             // isolate mode: filtered-out block
  if (vMode > 0.5) {                    // demoted splat: circular mask, rasterizer depth
    if (dot(vCorner, vCorner) > 1.0) discard;
    gl_FragDepth = gl_FragCoord.z;
    outColor = vColor;
    return;
  }
  // ray-AABB slab test in frame-local space (perspective: from the eye;
  // orthographic: parallel rays -- origin backed off along the view direction)
  vec3 ro = uOrthoRay > 0.5 ? vWorldPos - uFwd * uBackoff : uEye;
  vec3 rd = uOrthoRay > 0.5 ? uFwd : normalize(vWorldPos - uEye);
  vec3 inv = 1.0 / rd;                  // IEEE inf on axis-parallel rays is fine here
  vec3 t0 = (vCenter - vHalf - ro) * inv;
  vec3 t1 = (vCenter + vHalf - ro) * inv;
  vec3 tmin3 = min(t0, t1), tmax3 = max(t0, t1);
  float tin = max(max(tmin3.x, tmin3.y), tmin3.z);
  float tout = min(min(tmax3.x, tmax3.y), tmax3.z);
  if (tin > tout || tout < 0.0) discard;
  float t = tin > 0.0 ? tin : tout;     // inside the box → exit face
  vec3 p = ro + rd * t;
  // face normal = the slab that produced tin
  vec3 n = vec3(0.0);
  if (tin == tmin3.x) n = vec3(-sign(rd.x), 0.0, 0.0);
  else if (tin == tmin3.y) n = vec3(0.0, -sign(rd.y), 0.0);
  else n = vec3(0.0, 0.0, -sign(rd.z));
  vec4 clip = uViewProj * vec4(p, 1.0);
  gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
  float shade = 0.55 + 0.45 * max(dot(n, uLightDir), 0.0);
  outColor = vec4(vColor.rgb * shade, vColor.a);
}`;

// Far-field fragment: splat only, NO gl_FragDepth anywhere → early-z stays
// enabled for these draws — the perf lever for distant chunks (§2.3 mitigation).
const FRAG_CHEAP = `#version 300 es
precision highp float;
flat in vec3 vCenter;
flat in vec3 vHalf;
flat in vec4 vColor;
flat in float vMode;
flat in float vCull;
in vec2 vCorner;
in vec3 vWorldPos;
uniform vec3 uEye;
uniform vec3 uLightDir;
uniform mat4 uViewProj;
out vec4 outColor;
void main() {
  if (vCull > 0.5) discard;
  if (dot(vCorner, vCorner) > 1.0) discard;
  outColor = vColor;
}`;

// Golden-angle hue walk → visually distinct category colors (code → color).
export function categoryPalettePixels(n = 256) {
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const h = (i * 137.508) % 360, s = 0.55, l = 0.58;
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    out[i * 4] = Math.round((r + m) * 255); out[i * 4 + 1] = Math.round((g + m) * 255); out[i * 4 + 2] = Math.round((b + m) * 255); out[i * 4 + 3] = 255;
  }
  return out;
}

export function createBlocksPipeline(gl) {
  const mkProg = (frag) => {
    const prog = makeProgram(gl, VERT, frag);
    const U = (n) => gl.getUniformLocation(prog, n);
    return { prog, uni: {
      viewProj: U('uViewProj'), eye: U('uEye'), right: U('uRight'), up: U('uUp'),
      gridOrigin: U('uGridOrigin'), gridSize: U('uGridSize'),
      perspScale: U('uPerspScale'), demotePx: U('uDemotePx'), pointPx: U('uPointPx'),
      colorMode: U('uColorMode'), zRange: U('uZRange'), chanChunk: U('uChanChunk'), chanDoc: U('uChanDoc'),
      ramp: U('uRamp'), palette: U('uPalette'), lightDir: U('uLightDir'),
      mask: U('uMask'), filterOn: U('uFilterOn'), isolate: U('uIsolate'), forceSplat: U('uForceSplat'), fixedSplat: U('uFixedSplat'), picked: U('uPicked'), repaint: U('uRepaint'),
      secPlane: U('uSecPlane'), secCfg: U('uSecCfg'),
      ortho: U('uOrtho'), fwd: U('uFwd'), orthoRay: U('uOrthoRay'), backoff: U('uBackoff'),
    } };
  };
  const full = mkProg(FRAG), cheap = mkProg(FRAG_CHEAP);
  let active = full;

  // Upload one BlockChunk → buffers + a VAO whose instance pointers get re-aimed
  // per slice. CPU arrays are free to die after this returns.
  function upload(chunk) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const mkBuf = (data) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); return b; };
    const bIjk = mkBuf(chunk.ijk), bChan = mkBuf(chunk.chan), bCat = mkBuf(chunk.cat);
    const bRec = mkBuf(chunk.recIdx);                      // filter-mask lookup + pick pass
    gl.bindVertexArray(null);
    return {
      kind: 'blocks', vao, buffers: [bIjk, bChan, bCat, bRec],
      bIjk, bChan, bCat, bRec,
      count: chunk.count, bboxLocal: chunk.bboxLocal, cursor: 0,
      grid: chunk.grid, chanRange: chunk.chanRange,
    };
  }

  // Aim the instance attributes at element `first` and draw k instances.
  // useCheap: the whole chunk projects below the demotion threshold, so the
  // no-gl_FragDepth program (early-z enabled) draws it as forced splats.
  function drawSlice(c, first, k, useCheap = false) {
    const pp = useCheap ? cheap : full;
    if (pp !== active) { gl.useProgram(pp.prog); active = pp; }
    const uni = active.uni;
    gl.uniform1f(uni.forceSplat, useCheap ? 1 : 0);
    gl.bindVertexArray(c.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, c.bIjk);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.UNSIGNED_SHORT, false, 0, first * 6);
    gl.vertexAttribDivisor(0, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, c.bChan);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.UNSIGNED_SHORT, true, 0, first * 2);
    gl.vertexAttribDivisor(1, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, c.bCat);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.UNSIGNED_BYTE, false, 0, first);
    gl.vertexAttribDivisor(2, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, c.bRec);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_INT, 0, first * 4);
    gl.vertexAttribDivisor(3, 1);
    gl.uniform3f(uni.gridOrigin, c.grid.originLocal[0], c.grid.originLocal[1], c.grid.originLocal[2]);
    gl.uniform3f(uni.gridSize, c.grid.size[0], c.grid.size[1], c.grid.size[2]);
    const span = c.chanRange[1] - c.chanRange[0];
    gl.uniform2f(uni.chanChunk, c.chanRange[0], span > 0 ? span : 0);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, k);
  }

  // Per-frame program state (called once before the chunk loop) — set on BOTH
  // programs so drawSlice can switch freely between full and cheap.
  function begin(cam, { pointPx, colorMode, zRange, chanDoc, ramp, palette, viewportH, maskTex = null, isolate = false, pointsView = false, picked = 0xFFFFFFFF, section = null }) {
    const s = cam.state;
    for (const pp of [full, cheap]) {
      gl.useProgram(pp.prog);
      const uni = pp.uni;
      gl.uniformMatrix4fv(uni.viewProj, false, s.viewProj);
      gl.uniform3f(uni.eye, s.eye[0], s.eye[1], s.eye[2]);
      const v = s.view;                                    // camera basis = view-matrix rotation rows
      gl.uniform3f(uni.right, v[0], v[4], v[8]);
      gl.uniform3f(uni.up, v[1], v[5], v[9]);
      // headlight, slightly above the view direction
      let lx = s.eye[0] - s.target[0], ly = s.eye[1] - s.target[1], lz = s.eye[2] - s.target[2];
      const ll = Math.hypot(lx, ly, lz) || 1;
      lx = lx / ll + v[1] * 0.4; ly = ly / ll + v[5] * 0.4; lz = lz / ll + v[9] * 0.4;
      const l2 = Math.hypot(lx, ly, lz) || 1;
      gl.uniform3f(uni.lightDir, lx / l2, ly / l2, lz / l2);
      gl.uniform1f(uni.perspScale, s.ortho ? (viewportH / 2) / s.halfH : (viewportH / 2) / Math.tan(s.fovY / 2));
      gl.uniform1f(uni.ortho, s.ortho ? 1 : 0);
      gl.uniform1f(uni.orthoRay, s.ortho ? 1 : 0);
      {
        const f = [s.target[0] - s.eye[0], s.target[1] - s.eye[1], s.target[2] - s.eye[2]];
        const fl = Math.hypot(...f) || 1;
        gl.uniform3f(uni.fwd, f[0] / fl, f[1] / fl, f[2] / fl);
        gl.uniform1f(uni.backoff, s.radius * 2);
      }
      gl.uniform1f(uni.demotePx, 2.0);
      gl.uniform1f(uni.pointPx, pointPx * (window.devicePixelRatio || 1));
      gl.uniform1i(uni.colorMode, colorMode);
      gl.uniform2f(uni.zRange, zRange[0], zRange[1]);
      gl.uniform2f(uni.chanDoc, chanDoc[0], chanDoc[1]);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, ramp); gl.uniform1i(uni.ramp, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, palette); gl.uniform1i(uni.palette, 1);
      gl.uniform1f(uni.fixedSplat, pointsView ? 1 : 0);
      gl.uniform1ui(uni.picked, picked >>> 0);
      gl.uniform2ui(uni.repaint, 0xFFFFFFFF, 0xFFFFFFFF);
      gl.uniform4f(uni.secPlane, section ? section.n[0] : 0, section ? section.n[1] : 0, section ? section.n[2] : 1, section ? section.d : 0);
      gl.uniform2f(uni.secCfg, section ? 1 : 0, section ? section.half : 0);
      gl.uniform1f(uni.filterOn, maskTex ? 1 : 0);
      gl.uniform1f(uni.isolate, isolate ? 1 : 0);
      if (maskTex) { gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, maskTex); gl.uniform1i(uni.mask, 4); }
    }
    active = full;
    gl.useProgram(full.prog);
  }

  // The pick-repaint pass (gl.js): both programs get the target pair, then the
  // lazily-tracked active program is restored so drawSlice's cache stays honest.
  function setRepaint(a, b) {
    for (const pp of [full, cheap]) { gl.useProgram(pp.prog); gl.uniform2ui(pp.uni.repaint, a >>> 0, b >>> 0); }
    if (active) gl.useProgram(active.prog);
  }

  return { upload, drawSlice, begin, setRepaint };
}
