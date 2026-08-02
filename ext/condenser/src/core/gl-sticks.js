// @gcu/condenser — capsule impostors for drillhole sticks (micro-layers §6).
// gl-blocks' trick with a different intersection: one instanced quad per
// SEGMENT, billboarded to enclose the capsule's silhouette (spanned by the
// segment axis and the axis⊥view direction), fragment ray-capsule test with a
// real gl_FragDepth + surface normal (headlight shading). <2px → splat
// demotion; a cheap no-gl_FragDepth program serves fully-demoted far chunks.
// Radius is a live per-layer uniform (world meters) — the "stick thickness"
// knob. Mask / section / picked-glow / repaint identical to blocks.

import { makeProgram } from './gl-util.js';

// 4×4-Bayer screen-door opacity (see gl-mesh / gl-blocks): see-through without
// alpha blending — real depth writes stay correct, no back-to-front sort.
const SCREENDOOR = `
uniform float uOpacity;
const float _BAYER[16] = float[16](0.0,8.0,2.0,10.0,12.0,4.0,14.0,6.0,3.0,11.0,1.0,9.0,15.0,7.0,13.0,5.0);
bool _screendoor() { if (uOpacity >= 0.999) return false; int bi = (int(gl_FragCoord.x) & 3) + ((int(gl_FragCoord.y) & 3) << 2); return uOpacity < (_BAYER[bi] + 0.5) / 16.0; }`;

const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aA;          // segment start, frame-local
layout(location=1) in vec3 aB;          // segment end
layout(location=2) in float aChan;      // uint16 normalized (per-chunk range)
layout(location=3) in float aCat;       // uint8 raw
layout(location=4) in uint aRec;        // uint32 partitioned record id
uniform mat4 uViewProj;
uniform vec3 uEye;
uniform float uRadius;                  // stick radius, world meters
uniform float uPerspScale, uDemotePx, uPointPx, uFixedSplat, uOrtho;
uniform vec3 uFwd;
uniform int uColorMode;                 // 0 elevation | 1 channel | 2 category | 3 solid
uniform vec2 uZRange;
uniform vec2 uChanChunk;                // chunk chan min/span (dequantize)
uniform vec2 uChanDoc;                  // doc chan min/span (ramp)
uniform sampler2D uRamp;
uniform sampler2D uPalette;
uniform sampler2D uMask;
uniform float uFilterOn, uIsolate;
uniform sampler2D uSel;
uniform float uSelOn;
uniform sampler2D uCatVis;
uniform float uCatVisOn;
uniform sampler2D uRule;                // rule-code byte by record index (8192-wide)
uniform float uRuleOn;                  // rule mode: the code replaces the category
uniform uint uPicked;                   // picked RECORD (0xFFFFFFFF = none)
uniform uint uPickedLayer;              // …and the layer it belongs to
uniform uint uLayer;                    // this draw's layer (per-draw, not per-element)
uniform uvec2 uRepaint;
uniform vec4 uSecPlane;
uniform vec2 uSecCfg;
flat out vec3 vA;
flat out vec3 vB;
flat out vec4 vColor;
flat out float vMode;                   // 0 = capsule, 1 = splat
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
  // quad plane: the segment axis × the axis-perpendicular-to-view — encloses
  // the capsule silhouette. Axis ∥ view → any perpendicular works.
  vec3 v = cross(u, viewDir);
  float vl = length(v);
  v = vl > 1e-4 ? v / vl : normalize(abs(u.z) < 0.9 ? cross(u, vec3(0.0, 0.0, 1.0)) : cross(u, vec3(1.0, 0.0, 0.0)));
  float pxR = (len * 0.5 + uRadius) * uPerspScale / distEff;
  float demoted = max(pxR < uDemotePx ? 1.0 : 0.0, uFixedSplat);
  float m = 1.0;
  if (uFilterOn > 0.5) {
    int rec = int(aRec);
    m = texelFetch(uMask, ivec2(rec & 8191, rec >> 13), 0).r > 0.5 ? 1.0 : 0.0;
  }
  // section cull: keep any capsule that TOUCHES the slab (segment support along
  // the normal + radius) — the fragment shader clips exactly (see gl-blocks).
  float secSupp = demoted > 0.5 ? 0.0 : (abs(dot(axis, uSecPlane.xyz)) * 0.5 + uRadius);
  float secCull = (uSecCfg.x > 0.5 && abs(dot(center, uSecPlane.xyz) - uSecPlane.w) > uSecCfg.y + secSupp) ? 1.0 : 0.0;
  vCull = max((uIsolate > 0.5 && m < 0.5) ? 1.0 : 0.0, secCull);
  float cls = aCat;
  if (uRuleOn > 0.5) {
    int rr = int(aRec);
    cls = floor(texelFetch(uRule, ivec2(rr & 8191, rr >> 13), 0).r * 255.0 + 0.5);
  }
  if (uCatVisOn > 0.5 && texelFetch(uCatVis, ivec2(int(cls) & 255, 0), 0).r < 0.5) vCull = 1.0;
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;
  vec3 wp;
  if (demoted > 0.5) {                                   // splat: camera-facing square at the center
    float quadR = max(uPointPx * 0.5, min(pxR, uPointPx * 2.0)) * distEff / uPerspScale;
    vec3 sv = normalize(cross(viewDir, v));
    wp = center + (v * corner.x + sv * corner.y) * quadR;
  } else {
    wp = center + u * (corner.x * (len * 0.5 + uRadius)) + v * (corner.y * uRadius);
  }
  gl_Position = uViewProj * vec4(wp, 1.0);
  vA = aA; vB = aB; vMode = demoted; vCorner = corner; vWorldPos = wp;
  if (uColorMode == 0) {
    float t = clamp((center.z - uZRange.x) / max(uZRange.y, 1e-6), 0.0, 1.0);
    vColor = texture(uRamp, vec2(t, 0.5));
  } else if (uColorMode == 1) {
    float cv = uChanChunk.x + aChan * uChanChunk.y;
    float t = clamp((cv - uChanDoc.x) / max(uChanDoc.y, 1e-6), 0.0, 1.0);
    vColor = texture(uRamp, vec2(t, 0.5));
  } else if (uColorMode == 2) {
    vColor = texture(uPalette, vec2((cls + 0.5) / 256.0, 0.5));
  } else {
    vColor = vec4(0.62, 0.63, 0.66, 1.0);
  }
  if (uSelOn > 0.5) {
    int rs = int(aRec);
    if (texelFetch(uSel, ivec2(rs & 8191, rs >> 13), 0).r > 0.5) vColor = vec4(mix(vColor.rgb, vec3(1.0, 0.85, 0.3), 0.55), vColor.a);
  }
  if (uFilterOn > 0.5 && m < 0.5) vColor = vec4(vColor.rgb * 0.3, vColor.a);
  if (aRec == uPicked && uLayer == uPickedLayer) vColor = vec4(mix(vColor.rgb, vec3(1.0, 0.15, 0.7), 0.85) + 0.1, vColor.a);
  if ((uRepaint.x != 0xFFFFFFFFu || uRepaint.y != 0xFFFFFFFFu) && aRec != uRepaint.x && aRec != uRepaint.y) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
flat in vec3 vA;
flat in vec3 vB;
flat in vec4 vColor;
flat in float vMode;
flat in float vCull;
in vec2 vCorner;
in vec3 vWorldPos;
uniform vec3 uEye;
uniform vec3 uFwd;
uniform float uOrthoRay;
uniform float uBackoff;
uniform float uRadius;
uniform vec3 uLightDir;
uniform mat4 uViewProj;
uniform vec4 uSecPlane;
uniform vec2 uSecCfg;
out vec4 outColor;
${SCREENDOOR}
void main() {
  if (vCull > 0.5) discard;
  if (_screendoor()) discard;           // per-layer opacity (screen-door)
  if (vMode > 0.5) {                    // demoted splat
    if (dot(vCorner, vCorner) > 1.0) discard;
    gl_FragDepth = gl_FragCoord.z;
    outColor = vColor;
    return;
  }
  vec3 ro = uOrthoRay > 0.5 ? vWorldPos - uFwd * uBackoff : uEye;
  vec3 rd = uOrthoRay > 0.5 ? uFwd : normalize(vWorldPos - uEye);
  // ray-capsule (body cylinder + cap spheres)
  vec3 ba = vB - vA;
  vec3 oa = ro - vA;
  float baba = dot(ba, ba), bard = dot(ba, rd), baoa = dot(ba, oa);
  float rdoa = dot(rd, oa), oaoa = dot(oa, oa);
  float a = baba - bard * bard;
  float b = baba * rdoa - baoa * bard;
  float c = baba * oaoa - baoa * baoa - uRadius * uRadius * baba;
  float h = b * b - a * c;
  float t = -1.0;
  vec3 n = vec3(0.0);
  if (h >= 0.0) {
    float tb = (-b - sqrt(h)) / max(a, 1e-9);
    float y = baoa + tb * bard;
    if (y > 0.0 && y < baba && tb > 0.0) {
      t = tb;
      vec3 p = ro + rd * t;
      n = (p - vA - ba * (y / baba)) / uRadius;
    }
  }
  if (t < 0.0) {                        // the caps: try both, keep the nearest forward hit
    for (int i = 0; i < 2; i++) {
      vec3 capC = i == 0 ? vA : vB;
      vec3 o2 = ro - capC;
      float b2 = dot(rd, o2);
      float c2 = dot(o2, o2) - uRadius * uRadius;
      float h2 = b2 * b2 - c2;
      if (h2 >= 0.0) {
        float t2 = -b2 - sqrt(h2);
        if (t2 > 0.0 && (t < 0.0 || t2 < t)) {
          t = t2;
          n = (ro + rd * t2 - capC) / uRadius;
        }
      }
    }
  }
  if (t < 0.0) discard;
  // TRUE SECTION on the capsule (convex, so one inside-test at the slab face is
  // exact): a hit outside the slab either becomes the flat cut CROSS-SECTION at
  // the face, or the capsule never overlaps the slab and the pixel is gone.
  float cutFace = 0.0;
  if (uSecCfg.x > 0.5) {
    float den = dot(rd, uSecPlane.xyz);
    float dc = dot(ro, uSecPlane.xyz) - uSecPlane.w;
    if (abs(dc + t * den) > uSecCfg.y) {
      if (abs(den) < 1e-9) discard;
      float sIn = min((-uSecCfg.y - dc) / den, (uSecCfg.y - dc) / den);
      if (sIn <= t) discard;                               // hit past the slab exit
      vec3 q = ro + rd * sIn;                              // at the slab face: still inside?
      vec3 qa = q - vA;
      float yq = clamp(dot(qa, ba) / baba, 0.0, 1.0);
      if (length(qa - ba * yq) > uRadius) discard;
      t = sIn;
      n = uSecPlane.xyz * -sign(den);
      cutFace = 1.0;
    }
  }
  vec3 p = ro + rd * t;
  vec4 clip = uViewProj * vec4(p, 1.0);
  gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
  float shade = (0.55 + 0.45 * max(dot(n, uLightDir), 0.0)) * (cutFace > 0.5 ? 0.85 : 1.0);
  outColor = vec4(vColor.rgb * shade, vColor.a);
}`;

const FRAG_CHEAP = `#version 300 es
precision highp float;
flat in vec3 vA;
flat in vec3 vB;
flat in vec4 vColor;
flat in float vMode;
flat in float vCull;
in vec2 vCorner;
in vec3 vWorldPos;
uniform vec3 uEye;
uniform vec3 uLightDir;
uniform mat4 uViewProj;
out vec4 outColor;
${SCREENDOOR}
void main() {
  if (vCull > 0.5) discard;
  if (_screendoor()) discard;
  if (dot(vCorner, vCorner) > 1.0) discard;
  outColor = vColor;
}`;

export function createSticksPipeline(gl) {
  const mkProg = (frag) => {
    const prog = makeProgram(gl, VERT, frag);
    const U = (n) => gl.getUniformLocation(prog, n);
    return { prog, uni: {
      viewProj: U('uViewProj'), eye: U('uEye'), radius: U('uRadius'), opacity: U('uOpacity'),
      perspScale: U('uPerspScale'), demotePx: U('uDemotePx'), pointPx: U('uPointPx'), fixedSplat: U('uFixedSplat'),
      colorMode: U('uColorMode'), zRange: U('uZRange'), chanChunk: U('uChanChunk'), chanDoc: U('uChanDoc'),
      ramp: U('uRamp'), palette: U('uPalette'), lightDir: U('uLightDir'),
      mask: U('uMask'), filterOn: U('uFilterOn'), isolate: U('uIsolate'), picked: U('uPicked'), pickedLayer: U('uPickedLayer'), layer: U('uLayer'), repaint: U('uRepaint'),
      catVis: U('uCatVis'), catVisOn: U('uCatVisOn'), sel: U('uSel'), selOn: U('uSelOn'),
      rule: U('uRule'), ruleOn: U('uRuleOn'),
      secPlane: U('uSecPlane'), secCfg: U('uSecCfg'),
      ortho: U('uOrtho'), fwd: U('uFwd'), orthoRay: U('uOrthoRay'), backoff: U('uBackoff'),
    } };
  };
  const full = mkProg(FRAG), cheap = mkProg(FRAG_CHEAP);
  let active = full;

  function upload(chunk) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const mkBuf = (data) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); return b; };
    const bSeg = mkBuf(chunk.seg), bChan = mkBuf(chunk.chan), bCat = mkBuf(chunk.cat), bRec = mkBuf(chunk.recIdx);
    gl.bindVertexArray(null);
    return {
      kind: 'sticks', vao, buffers: [bSeg, bChan, bCat, bRec],
      bSeg, bChan, bCat, bRec,
      count: chunk.count, bboxLocal: chunk.bboxLocal, cursor: 0,
      chanRange: chunk.chanRange,
    };
  }

  function drawSlice(c, first, k, useCheap = false) {
    const pp = useCheap ? cheap : full;
    if (pp !== active) { gl.useProgram(pp.prog); active = pp; }
    const uni = active.uni;
    gl.uniform1f(uni.fixedSplat, useCheap ? 1 : 0);
    gl.bindVertexArray(c.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, c.bSeg);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, first * 24);
    gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, first * 24 + 12);
    gl.vertexAttribDivisor(1, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, c.bChan);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.UNSIGNED_SHORT, true, 0, first * 2);
    gl.vertexAttribDivisor(2, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, c.bCat);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.UNSIGNED_BYTE, false, 0, first);
    gl.vertexAttribDivisor(3, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, c.bRec);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribIPointer(4, 1, gl.UNSIGNED_INT, 0, first * 4);
    gl.vertexAttribDivisor(4, 1);
    const span = c.chanRange[1] - c.chanRange[0];
    gl.uniform2f(uni.chanChunk, c.chanRange[0], span > 0 ? span : 0);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, k);
  }

  function begin(cam, { pointPx, colorMode, zRange, chanDoc, ramp, palette, viewportH, maskTex = null, isolate = false, pointsView = false, picked = 0xFFFFFFFF, pickedLayer = 0xFFFFFFFF, layer = 0, section = null, radius = 1, catVisTex = null, selTex = null, ruleTex = null, opacity = 1 }) {
    const s = cam.state;
    for (const pp of [full, cheap]) {
      gl.useProgram(pp.prog);
      const uni = pp.uni;
      gl.uniformMatrix4fv(uni.viewProj, false, s.viewProj);
      gl.uniform3f(uni.eye, s.eye[0], s.eye[1], s.eye[2]);
      const v = s.view;
      let lx = s.eye[0] - s.target[0], ly = s.eye[1] - s.target[1], lz = s.eye[2] - s.target[2];
      const ll = Math.hypot(lx, ly, lz) || 1;
      lx = lx / ll + v[1] * 0.4; ly = ly / ll + v[5] * 0.4; lz = lz / ll + v[9] * 0.4;
      const l2 = Math.hypot(lx, ly, lz) || 1;
      gl.uniform3f(uni.lightDir, lx / l2, ly / l2, lz / l2);
      gl.uniform1f(uni.radius, radius);
      gl.uniform1f(uni.opacity, Math.max(0.02, Math.min(1, opacity)));   // per-layer screen-door opacity
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
      gl.uniform1ui(uni.pickedLayer, pickedLayer >>> 0);
      gl.uniform1ui(uni.layer, layer >>> 0);              // this draw's layer — the id no longer hides in aRec
      gl.uniform2ui(uni.repaint, 0xFFFFFFFF, 0xFFFFFFFF);
      gl.uniform4f(uni.secPlane, section ? section.n[0] : 0, section ? section.n[1] : 0, section ? section.n[2] : 1, section ? section.d : 0);
      gl.uniform2f(uni.secCfg, section ? 1 : 0, section ? section.half : 0);
      gl.uniform1f(uni.filterOn, maskTex ? 1 : 0);
      gl.uniform1f(uni.isolate, isolate ? 1 : 0);
      if (maskTex) { gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, maskTex); gl.uniform1i(uni.mask, 4); }
      gl.uniform1f(uni.catVisOn, catVisTex ? 1 : 0);
      if (catVisTex) { gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, catVisTex); gl.uniform1i(uni.catVis, 5); }
      gl.uniform1f(uni.selOn, selTex ? 1 : 0);
      if (selTex) { gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, selTex); gl.uniform1i(uni.sel, 6); }
      gl.uniform1f(uni.ruleOn, ruleTex ? 1 : 0);
      if (ruleTex) { gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, ruleTex); gl.uniform1i(uni.rule, 7); }
    }
    active = full;
    gl.useProgram(full.prog);
  }

  function setRepaint(a, b) {
    for (const pp of [full, cheap]) { gl.useProgram(pp.prog); gl.uniform2ui(pp.uni.repaint, a >>> 0, b >>> 0); }
    if (active) gl.useProgram(active.prog);
  }

  return { upload, drawSlice, begin, setRepaint };
}
