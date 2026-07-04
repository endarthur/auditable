// @gcu/condenser — GPU ID-buffer picking. On click, the visible chunks re-render
// once into an offscreen target with the fragment shaders outputting the RECORD
// INDEX encoded as RGBA8 instead of a color, scissored to the cursor pixel; one
// readPixels + decode gives the exact element under the cursor. The SAME analytic
// geometry that renders decides the pick — the impostor's ray-AABB test and real
// depth writes resolve which block face is hit, pixel-perfect at any zoom. No CPU
// spatial index. The record index is THE join key (micro-spec §4): a pick is a
// row number in the source file.

import { makeProgram } from './gl-util.js';

const ENCODE = `
vec4 encodeRec(uint r) {
  return vec4(float(r & 255u), float((r >> 8) & 255u), float((r >> 16) & 255u), float((r >> 24) & 255u)) / 255.0;
}`;

// ── points ──
const PICK_VERT_PTS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=2) in float aClass;
layout(location=4) in uint aRec;
uniform mat4 uViewProj;
uniform vec3 uBoxMin, uBoxSpan;
uniform float uPointPx;
uniform vec4 uSecPlane;
uniform vec2 uSecCfg;
uniform sampler2D uMask;
uniform float uFilterOn, uIsolate;
uniform sampler2D uCatVis;
uniform float uCatVisOn;
flat out uint vRec;
flat out float vCull;
void main() {
  vec3 p = uBoxMin + aPos * uBoxSpan;
  gl_Position = uViewProj * vec4(p, 1.0);
  gl_PointSize = uPointPx;
  vRec = aRec;
  vCull = (uSecCfg.x > 0.5 && abs(dot(p, uSecPlane.xyz) - uSecPlane.w) > uSecCfg.y) ? 1.0 : 0.0;
  if (uFilterOn > 0.5 && uIsolate > 0.5) {
    int rec = int(aRec & 0x1FFFFFFFu);  // low 29 bits = the record (top 3 = layer)
    if (texelFetch(uMask, ivec2(rec & 8191, rec >> 13), 0).r < 0.5) vCull = 1.0;   // isolated-away isn't pickable
  }
  if (uCatVisOn > 0.5 && texelFetch(uCatVis, ivec2(int(aClass) & 255, 0), 0).r < 0.5) vCull = 1.0;
}`;
const PICK_FRAG_PTS = `#version 300 es
precision highp float;
flat in uint vRec;
flat in float vCull;
out vec4 outColor;
${ENCODE}
void main() {
  if (vCull > 0.5) discard;
  vec2 d = gl_PointCoord - 0.5;
  if (dot(d, d) > 0.25) discard;
  outColor = encodeRec(vRec);
}`;

// ── blocks (geometry identical to gl-blocks; color replaced by the encoded id) ──
const PICK_VERT_BLK = `#version 300 es
precision highp float;
layout(location=0) in vec3 aIjk;
layout(location=2) in float aCat;
layout(location=3) in uint aRec;
uniform mat4 uViewProj;
uniform vec3 uEye, uRight, uUp;
uniform vec3 uGridOrigin, uGridSize;
uniform float uPerspScale, uDemotePx, uPointPx, uFixedSplat, uOrtho;
uniform sampler2D uMask;
uniform float uFilterOn, uIsolate;
uniform sampler2D uCatVis;
uniform float uCatVisOn;
uniform vec4 uSecPlane;
uniform vec2 uSecCfg;
flat out vec3 vCenter;
flat out vec3 vHalf;
flat out uint vRec;
flat out float vMode;
flat out float vCull;
out vec2 vCorner;
out vec3 vWorldPos;
void main() {
  vec3 center = uGridOrigin + aIjk * uGridSize;
  vec3 half_ = uGridSize * 0.5;
  float r = length(half_);
  float dist = max(distance(uEye, center), 1e-3);
  float distEff = uOrtho > 0.5 ? 1.0 : dist;
  float pxR = r * uPerspScale / distEff;
  float demoted = max(pxR < uDemotePx ? 1.0 : 0.0, uFixedSplat);
  float quadR = uFixedSplat > 0.5
    ? uPointPx * 0.5 * distEff / uPerspScale
    : mix(r, max(uPointPx * 0.5, pxR) * distEff / uPerspScale, demoted);
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;
  vec3 wp = center + (uRight * corner.x + uUp * corner.y) * quadR;
  gl_Position = uViewProj * vec4(wp, 1.0);
  float m = 1.0;
  if (uFilterOn > 0.5) {
    int rec = int(aRec & 0x1FFFFFFFu);  // low 29 bits = the record (top 3 = layer)
    m = texelFetch(uMask, ivec2(rec & 8191, rec >> 13), 0).r > 0.5 ? 1.0 : 0.0;
  }
  float secCull = (uSecCfg.x > 0.5 && abs(dot(center, uSecPlane.xyz) - uSecPlane.w) > uSecCfg.y) ? 1.0 : 0.0;
  vCull = max((uIsolate > 0.5 && m < 0.5) ? 1.0 : 0.0, secCull);   // hidden (isolated or sectioned) isn't pickable
  if (uCatVisOn > 0.5 && texelFetch(uCatVis, ivec2(int(aCat) & 255, 0), 0).r < 0.5) vCull = 1.0;
  vCenter = center; vHalf = half_; vRec = aRec; vMode = demoted; vCorner = corner; vWorldPos = wp;
}`;
const PICK_FRAG_BLK = `#version 300 es
precision highp float;
flat in vec3 vCenter;
flat in vec3 vHalf;
flat in uint vRec;
flat in float vMode;
flat in float vCull;
in vec2 vCorner;
in vec3 vWorldPos;
uniform vec3 uEye;
uniform vec3 uFwd;
uniform float uOrthoRay;
uniform float uBackoff;
uniform mat4 uViewProj;
out vec4 outColor;
${ENCODE}
void main() {
  if (vCull > 0.5) discard;
  if (vMode > 0.5) {
    if (dot(vCorner, vCorner) > 1.0) discard;
    gl_FragDepth = gl_FragCoord.z;
    outColor = encodeRec(vRec);
    return;
  }
  vec3 ro = uOrthoRay > 0.5 ? vWorldPos - uFwd * uBackoff : uEye;
  vec3 rd = uOrthoRay > 0.5 ? uFwd : normalize(vWorldPos - uEye);
  vec3 inv = 1.0 / rd;
  vec3 t0 = (vCenter - vHalf - ro) * inv;
  vec3 t1 = (vCenter + vHalf - ro) * inv;
  vec3 tmin3 = min(t0, t1), tmax3 = max(t0, t1);
  float tin = max(max(tmin3.x, tmin3.y), tmin3.z);
  float tout = min(min(tmax3.x, tmax3.y), tmax3.z);
  if (tin > tout || tout < 0.0) discard;
  float t = tin > 0.0 ? tin : tout;
  vec4 clip = uViewProj * vec4(ro + rd * t, 1.0);
  gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
  outColor = encodeRec(vRec);
}`;

// ── sticks (capsule geometry identical to gl-sticks; color = the encoded id) ──
const PICK_VERT_STK = `#version 300 es
precision highp float;
layout(location=0) in vec3 aA;
layout(location=1) in vec3 aB;
layout(location=3) in float aCat;
layout(location=4) in uint aRec;
uniform mat4 uViewProj;
uniform vec3 uEye;
uniform float uRadius, uPerspScale, uDemotePx, uPointPx, uFixedSplat, uOrtho;
uniform vec3 uFwd;
uniform sampler2D uMask;
uniform float uFilterOn, uIsolate;
uniform sampler2D uCatVis;
uniform float uCatVisOn;
uniform vec4 uSecPlane;
uniform vec2 uSecCfg;
flat out vec3 vA;
flat out vec3 vB;
flat out uint vRec;
flat out float vMode;
flat out float vCull;
out vec2 vCorner;
out vec3 vWorldPos;
void main() {
  vec3 center = (aA + aB) * 0.5;
  vec3 axis = aB - aA;
  float len = max(length(axis), 1e-6);
  vec3 u = axis / len;
  float dist = max(distance(uEye, center), 1e-3);
  float distEff = uOrtho > 0.5 ? 1.0 : dist;
  vec3 viewDir = uOrtho > 0.5 ? uFwd : (center - uEye) / dist;
  vec3 v = cross(u, viewDir);
  float vl = length(v);
  v = vl > 1e-4 ? v / vl : normalize(abs(u.z) < 0.9 ? cross(u, vec3(0.0, 0.0, 1.0)) : cross(u, vec3(1.0, 0.0, 0.0)));
  float pxR = (len * 0.5 + uRadius) * uPerspScale / distEff;
  float demoted = max(pxR < uDemotePx ? 1.0 : 0.0, uFixedSplat);
  float m = 1.0;
  if (uFilterOn > 0.5) {
    int rec = int(aRec & 0x1FFFFFFFu);
    m = texelFetch(uMask, ivec2(rec & 8191, rec >> 13), 0).r > 0.5 ? 1.0 : 0.0;
  }
  float secCull = (uSecCfg.x > 0.5 && abs(dot(center, uSecPlane.xyz) - uSecPlane.w) > uSecCfg.y) ? 1.0 : 0.0;
  vCull = max((uIsolate > 0.5 && m < 0.5) ? 1.0 : 0.0, secCull);
  if (uCatVisOn > 0.5 && texelFetch(uCatVis, ivec2(int(aCat) & 255, 0), 0).r < 0.5) vCull = 1.0;
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;
  vec3 wp;
  if (demoted > 0.5) {
    float quadR = max(uPointPx * 0.5, min(pxR, uPointPx * 2.0)) * distEff / uPerspScale;
    vec3 sv = normalize(cross(viewDir, v));
    wp = center + (v * corner.x + sv * corner.y) * quadR;
  } else {
    wp = center + u * (corner.x * (len * 0.5 + uRadius)) + v * (corner.y * uRadius);
  }
  gl_Position = uViewProj * vec4(wp, 1.0);
  vA = aA; vB = aB; vRec = aRec; vMode = demoted; vCorner = corner; vWorldPos = wp;
}`;
const PICK_FRAG_STK = `#version 300 es
precision highp float;
flat in vec3 vA;
flat in vec3 vB;
flat in uint vRec;
flat in float vMode;
flat in float vCull;
in vec2 vCorner;
in vec3 vWorldPos;
uniform vec3 uEye;
uniform vec3 uFwd;
uniform float uOrthoRay;
uniform float uBackoff;
uniform float uRadius;
uniform mat4 uViewProj;
out vec4 outColor;
${ENCODE}
void main() {
  if (vCull > 0.5) discard;
  if (vMode > 0.5) {
    if (dot(vCorner, vCorner) > 1.0) discard;
    gl_FragDepth = gl_FragCoord.z;
    outColor = encodeRec(vRec);
    return;
  }
  vec3 ro = uOrthoRay > 0.5 ? vWorldPos - uFwd * uBackoff : uEye;
  vec3 rd = uOrthoRay > 0.5 ? uFwd : normalize(vWorldPos - uEye);
  vec3 ba = vB - vA;
  vec3 oa = ro - vA;
  float baba = dot(ba, ba), bard = dot(ba, rd), baoa = dot(ba, oa);
  float rdoa = dot(rd, oa), oaoa = dot(oa, oa);
  float a = baba - bard * bard;
  float b = baba * rdoa - baoa * bard;
  float c = baba * oaoa - baoa * baoa - uRadius * uRadius * baba;
  float h = b * b - a * c;
  float t = -1.0;
  if (h >= 0.0) {
    float tb = (-b - sqrt(h)) / max(a, 1e-9);
    float y = baoa + tb * bard;
    if (y > 0.0 && y < baba && tb > 0.0) t = tb;
  }
  if (t < 0.0) {
    for (int i = 0; i < 2; i++) {
      vec3 capC = i == 0 ? vA : vB;
      vec3 o2 = ro - capC;
      float b2 = dot(rd, o2);
      float c2 = dot(o2, o2) - uRadius * uRadius;
      float h2 = b2 * b2 - c2;
      if (h2 >= 0.0) {
        float t2 = -b2 - sqrt(h2);
        if (t2 > 0.0 && (t < 0.0 || t2 < t)) t = t2;
      }
    }
  }
  if (t < 0.0) discard;
  vec4 clip = uViewProj * vec4(ro + rd * t, 1.0);
  gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
  outColor = encodeRec(vRec);
}`;

const NO_HIT = 0xFFFFFFFF;                                 // the clear color decodes to this

export function createPickPipeline(gl) {
  const pts = makeProgram(gl, PICK_VERT_PTS, PICK_FRAG_PTS);
  const blk = makeProgram(gl, PICK_VERT_BLK, PICK_FRAG_BLK);
  const stk = makeProgram(gl, PICK_VERT_STK, PICK_FRAG_STK);
  const U = (p, n) => gl.getUniformLocation(p, n);
  const uPts = { viewProj: U(pts, 'uViewProj'), boxMin: U(pts, 'uBoxMin'), boxSpan: U(pts, 'uBoxSpan'), pointPx: U(pts, 'uPointPx'), secPlane: U(pts, 'uSecPlane'), secCfg: U(pts, 'uSecCfg'), mask: U(pts, 'uMask'), filterOn: U(pts, 'uFilterOn'), isolate: U(pts, 'uIsolate'), catVis: U(pts, 'uCatVis'), catVisOn: U(pts, 'uCatVisOn') };
  const uBlk = {
    viewProj: U(blk, 'uViewProj'), eye: U(blk, 'uEye'), right: U(blk, 'uRight'), up: U(blk, 'uUp'),
    gridOrigin: U(blk, 'uGridOrigin'), gridSize: U(blk, 'uGridSize'),
    perspScale: U(blk, 'uPerspScale'), demotePx: U(blk, 'uDemotePx'), pointPx: U(blk, 'uPointPx'), fixedSplat: U(blk, 'uFixedSplat'),
    ortho: U(blk, 'uOrtho'), fwd: U(blk, 'uFwd'), orthoRay: U(blk, 'uOrthoRay'), backoff: U(blk, 'uBackoff'),
    mask: U(blk, 'uMask'), filterOn: U(blk, 'uFilterOn'), isolate: U(blk, 'uIsolate'),
    catVis: U(blk, 'uCatVis'), catVisOn: U(blk, 'uCatVisOn'),
    secPlane: U(blk, 'uSecPlane'), secCfg: U(blk, 'uSecCfg'),
  };
  const uStk = {
    viewProj: U(stk, 'uViewProj'), eye: U(stk, 'uEye'), radius: U(stk, 'uRadius'),
    perspScale: U(stk, 'uPerspScale'), demotePx: U(stk, 'uDemotePx'), pointPx: U(stk, 'uPointPx'), fixedSplat: U(stk, 'uFixedSplat'),
    ortho: U(stk, 'uOrtho'), fwd: U(stk, 'uFwd'), orthoRay: U(stk, 'uOrthoRay'), backoff: U(stk, 'uBackoff'),
    mask: U(stk, 'uMask'), filterOn: U(stk, 'uFilterOn'), isolate: U(stk, 'uIsolate'),
    catVis: U(stk, 'uCatVis'), catVisOn: U(stk, 'uCatVisOn'),
    secPlane: U(stk, 'uSecPlane'), secCfg: U(stk, 'uSecCfg'),
  };
  let fbo = null, colorTex = null, depthRb = null, w = 0, h = 0;

  function ensure(width, height) {
    if (fbo && width === w && height === h) return;
    w = width; h = height;
    if (fbo) { gl.deleteFramebuffer(fbo); gl.deleteTexture(colorTex); gl.deleteRenderbuffer(depthRb); }
    colorTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, colorTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    depthRb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depthRb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRb);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Pick at device pixel (px, py) (GL origin, bottom-left). Draws each chunk's
   * CURRENT accumulated prefix (you pick what you can see), scissored to the
   * pixel. Returns the record index, or null.
   */
  function pick(px, py, chunks, cam, { pointPx, blocksAsPoints = false, layerStates = null, section = null, viewportW, viewportH }) {
    const stateOf = (id) => (layerStates && layerStates.get(id)) || { maskTex: null, isolate: false };
    const byLayer = (arr) => {
      const m = new Map();
      for (const c of arr) { const id = c._layer || 0; let g = m.get(id); if (!g) m.set(id, g = []); g.push(c); }
      return m;
    };
    // per layer: an exempt layer (st.sectioned === false) picks whole
    const setSec = (u, st) => {
      const s = st && st.sectioned === false ? null : section;
      gl.uniform4f(u.secPlane, s ? s.n[0] : 0, s ? s.n[1] : 0, s ? s.n[2] : 1, s ? s.d : 0);
      gl.uniform2f(u.secCfg, s ? 1 : 0, s ? s.half : 0);
    };
    // hidden classes aren't pickable (same texture the visual pass culls by)
    const setCatVis = (u, st) => {
      const t = st && st.catVisTex;
      gl.uniform1f(u.catVisOn, t ? 1 : 0);
      if (t) { gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(u.catVis, 5); }
    };
    ensure(viewportW, viewportH);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, w, h);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(px, py, 1, 1);
    gl.clearColor(1, 1, 1, 1);                             // decodes to NO_HIT
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    const s = cam.state;
    const dpp = pointPx * (window.devicePixelRatio || 1);

    const ptsChunks = chunks.filter((c) => c.kind === 'points' && c.cursor > 0);
    if (ptsChunks.length) {
      gl.useProgram(pts);
      gl.uniformMatrix4fv(uPts.viewProj, false, s.viewProj);
      gl.uniform1f(uPts.pointPx, dpp);
      for (const [id, group] of byLayer(ptsChunks)) {
      const st = stateOf(id);
      setSec(uPts, st);
      setCatVis(uPts, st);
      gl.uniform1f(uPts.filterOn, st.maskTex ? 1 : 0);
      gl.uniform1f(uPts.isolate, st.isolate ? 1 : 0);
      if (st.maskTex) { gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, st.maskTex); gl.uniform1i(uPts.mask, 4); }
      for (const c of group) {
        gl.bindVertexArray(c.vao);
        // wire the recIdx buffer as attr 4 (idempotent; the visual program ignores it)
        gl.bindBuffer(gl.ARRAY_BUFFER, c.buffers[c.buffers.length - 1]);
        gl.enableVertexAttribArray(4);
        gl.vertexAttribIPointer(4, 1, gl.UNSIGNED_INT, 0, 0);
        gl.uniform3f(uPts.boxMin, c.bboxLocal[0], c.bboxLocal[1], c.bboxLocal[2]);
        gl.uniform3f(uPts.boxSpan, c.bboxLocal[3] - c.bboxLocal[0], c.bboxLocal[4] - c.bboxLocal[1], c.bboxLocal[5] - c.bboxLocal[2]);
        gl.drawArrays(gl.POINTS, 0, c.cursor);
      }
      }
    }

    const blkChunks = chunks.filter((c) => c.kind === 'blocks' && c.cursor > 0);
    if (blkChunks.length) {
      gl.useProgram(blk);
      gl.uniformMatrix4fv(uBlk.viewProj, false, s.viewProj);
      gl.uniform3f(uBlk.eye, s.eye[0], s.eye[1], s.eye[2]);
      const v = s.view;
      gl.uniform3f(uBlk.right, v[0], v[4], v[8]);
      gl.uniform3f(uBlk.up, v[1], v[5], v[9]);
      gl.uniform1f(uBlk.perspScale, s.ortho ? (viewportH / 2) / s.halfH : (viewportH / 2) / Math.tan(s.fovY / 2));
      gl.uniform1f(uBlk.ortho, s.ortho ? 1 : 0);
      gl.uniform1f(uBlk.orthoRay, s.ortho ? 1 : 0);
      {
        const f = [s.target[0] - s.eye[0], s.target[1] - s.eye[1], s.target[2] - s.eye[2]];
        const fl = Math.hypot(...f) || 1;
        gl.uniform3f(uBlk.fwd, f[0] / fl, f[1] / fl, f[2] / fl);
        gl.uniform1f(uBlk.backoff, s.radius * 2);
      }
      gl.uniform1f(uBlk.demotePx, 2.0);
      gl.uniform1f(uBlk.pointPx, dpp);
      gl.uniform1f(uBlk.fixedSplat, blocksAsPoints ? 1 : 0);
      for (const [id, group] of byLayer(blkChunks)) {
      const st = stateOf(id);
      setSec(uBlk, st);
      setCatVis(uBlk, st);
      gl.uniform1f(uBlk.filterOn, st.maskTex ? 1 : 0);
      gl.uniform1f(uBlk.isolate, st.isolate ? 1 : 0);
      if (st.maskTex) { gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, st.maskTex); gl.uniform1i(uBlk.mask, 4); }
      for (const c of group) {
        gl.bindVertexArray(c.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, c.bIjk);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.UNSIGNED_SHORT, false, 0, 0);
        gl.vertexAttribDivisor(0, 1);
        gl.bindBuffer(gl.ARRAY_BUFFER, c.bCat);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 1, gl.UNSIGNED_BYTE, false, 0, 0);
        gl.vertexAttribDivisor(2, 1);
        gl.bindBuffer(gl.ARRAY_BUFFER, c.bRec);
        gl.enableVertexAttribArray(3);
        gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_INT, 0, 0);
        gl.vertexAttribDivisor(3, 1);
        gl.uniform3f(uBlk.gridOrigin, c.grid.originLocal[0], c.grid.originLocal[1], c.grid.originLocal[2]);
        gl.uniform3f(uBlk.gridSize, c.grid.size[0], c.grid.size[1], c.grid.size[2]);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, c.cursor);
      }
      }
    }

    const stkChunks = chunks.filter((c) => c.kind === 'sticks' && c.cursor > 0);
    if (stkChunks.length) {
      gl.useProgram(stk);
      gl.uniformMatrix4fv(uStk.viewProj, false, s.viewProj);
      gl.uniform3f(uStk.eye, s.eye[0], s.eye[1], s.eye[2]);
      gl.uniform1f(uStk.perspScale, s.ortho ? (viewportH / 2) / s.halfH : (viewportH / 2) / Math.tan(s.fovY / 2));
      gl.uniform1f(uStk.ortho, s.ortho ? 1 : 0);
      gl.uniform1f(uStk.orthoRay, s.ortho ? 1 : 0);
      {
        const f = [s.target[0] - s.eye[0], s.target[1] - s.eye[1], s.target[2] - s.eye[2]];
        const fl = Math.hypot(...f) || 1;
        gl.uniform3f(uStk.fwd, f[0] / fl, f[1] / fl, f[2] / fl);
        gl.uniform1f(uStk.backoff, s.radius * 2);
      }
      gl.uniform1f(uStk.demotePx, 2.0);
      gl.uniform1f(uStk.pointPx, dpp);
      gl.uniform1f(uStk.fixedSplat, blocksAsPoints ? 1 : 0);
      for (const [id, group] of byLayer(stkChunks)) {
      const st2 = stateOf(id);
      setSec(uStk, st2);
      setCatVis(uStk, st2);
      gl.uniform1f(uStk.radius, (st2 && st2.stickRadius) || 1);
      gl.uniform1f(uStk.filterOn, st2.maskTex ? 1 : 0);
      gl.uniform1f(uStk.isolate, st2.isolate ? 1 : 0);
      if (st2.maskTex) { gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, st2.maskTex); gl.uniform1i(uStk.mask, 4); }
      for (const c of group) {
        gl.bindVertexArray(c.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, c.bSeg);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
        gl.vertexAttribDivisor(0, 1);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
        gl.vertexAttribDivisor(1, 1);
        gl.bindBuffer(gl.ARRAY_BUFFER, c.bCat);
        gl.enableVertexAttribArray(3);
        gl.vertexAttribPointer(3, 1, gl.UNSIGNED_BYTE, false, 0, 0);
        gl.vertexAttribDivisor(3, 1);
        gl.bindBuffer(gl.ARRAY_BUFFER, c.bRec);
        gl.enableVertexAttribArray(4);
        gl.vertexAttribIPointer(4, 1, gl.UNSIGNED_INT, 0, 0);
        gl.vertexAttribDivisor(4, 1);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, c.cursor);
      }
      }
    }

    gl.disable(gl.SCISSOR_TEST);
    const px4 = new Uint8Array(4);
    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    const rec = (px4[0] | (px4[1] << 8) | (px4[2] << 16) | (px4[3] << 24)) >>> 0;
    return rec === NO_HIT ? null : rec;
  }

  return { pick };
}
