// @gcu/condenser — the streaming-mesh (triangle soup) pipeline (micro-layers
// §7 tier 2). The points pipeline's shape over TRIANGLES: u16 positions
// dequantized against the chunk bbox, prefix slices (first/k in TRIANGLE
// units), budgeted accumulation. The fragment shader is gl-mesh's: derivative
// flat shading, two-sided, Bayer screen-door opacity, per-pixel section cut.

import { makeProgram } from './gl-util.js';

const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;        // u16 normalized against the chunk bbox
uniform mat4 uViewProj;
uniform vec3 uBoxMin;
uniform vec3 uBoxSpan;
uniform vec4 uSecPlane;
out vec3 vWorldPos;
out float vSecDist;
void main() {
  vec3 p = uBoxMin + aPos * uBoxSpan;
  gl_Position = uViewProj * vec4(p, 1.0);
  vWorldPos = p;
  vSecDist = dot(p, uSecPlane.xyz) - uSecPlane.w;
}`;

const FRAG = `#version 300 es
precision highp float;
in vec3 vWorldPos;
in float vSecDist;
uniform vec2 uSecCfg;
uniform vec4 uTint;
uniform vec3 uLightDir;
uniform vec3 uEye;
out vec4 outColor;
const float BAYER[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
void main() {
  if (uSecCfg.x > 0.5 && abs(vSecDist) > uSecCfg.y) discard;
  if (uTint.a < 0.999) {
    int bi = (int(gl_FragCoord.x) & 3) + ((int(gl_FragCoord.y) & 3) << 2);
    if (uTint.a < (BAYER[bi] + 0.5) / 16.0) discard;
  }
  vec3 n = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
  vec3 vd = normalize(uEye - vWorldPos);
  if (dot(n, vd) < 0.0) n = -n;
  float shade = 0.42 + 0.58 * max(dot(n, uLightDir), 0.0);
  outColor = vec4(uTint.rgb * shade, 1.0);
}`;

// sectioned variant: flatten in-slab fragment depth onto the camera-side slab
// face so the streamed-mesh trace draws over the true-cut block wall (gl-mesh's
// FRAG_OVERLAY, same math — see the rationale there)
const FRAG_OVERLAY = `#version 300 es
precision highp float;
in vec3 vWorldPos;
in float vSecDist;
uniform vec4 uSecPlane;
uniform vec2 uSecCfg;
uniform vec4 uTint;
uniform vec3 uLightDir;
uniform vec3 uEye;
uniform mat4 uViewProj;
uniform vec3 uFwd;
uniform float uOrtho;
out vec4 outColor;
const float BAYER[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
void main() {
  if (abs(vSecDist) > uSecCfg.y) discard;
  if (uTint.a < 0.999) {
    int bi = (int(gl_FragCoord.x) & 3) + ((int(gl_FragCoord.y) & 3) << 2);
    if (uTint.a < (BAYER[bi] + 0.5) / 16.0) discard;
  }
  vec3 n = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
  vec3 vd = normalize(uEye - vWorldPos);
  if (dot(n, vd) < 0.0) n = -n;
  float shade = 0.42 + 0.58 * max(dot(n, uLightDir), 0.0);
  outColor = vec4(uTint.rgb * shade, 1.0);
  gl_FragDepth = gl_FragCoord.z;
  float dcEye = dot(uEye, uSecPlane.xyz) - uSecPlane.w;
  if (abs(dcEye) > uSecCfg.y) {
    float side = sign(dcEye);
    vec3 q; bool front = false;
    if (uOrtho > 0.5) {
      float den = dot(uFwd, uSecPlane.xyz);
      if (abs(den) > 1e-9) {
        float s = (vSecDist - side * uSecCfg.y) / den;
        if (s > 0.0) { q = vWorldPos - uFwd * s; front = true; }
      }
    } else {
      vec3 rdm = vWorldPos - uEye;
      float den = dot(rdm, uSecPlane.xyz);
      if (abs(den) > 1e-9) {
        float tF = (side * uSecCfg.y - dcEye) / den;
        if (tF > 0.0 && tF < 1.0) { q = uEye + rdm * tF; front = true; }
      }
    }
    if (front) {
      vec4 clipQ = uViewProj * vec4(q, 1.0);
      gl_FragDepth = clamp(clipQ.z / clipQ.w * 0.5 + 0.5, 0.0, 1.0) - 3e-5;
    }
  }
}`;

export function createSoupPipeline(gl) {
  const mk = (frag) => {
    const prog = makeProgram(gl, VERT, frag);
    const U = (n) => gl.getUniformLocation(prog, n);
    return { prog, uni: {
      viewProj: U('uViewProj'), boxMin: U('uBoxMin'), boxSpan: U('uBoxSpan'),
      secPlane: U('uSecPlane'), secCfg: U('uSecCfg'),
      tint: U('uTint'), lightDir: U('uLightDir'), eye: U('uEye'),
      fwd: U('uFwd'), ortho: U('uOrtho'),
    } };
  };
  const base = mk(FRAG), overlay = mk(FRAG_OVERLAY);
  let uni = base.uni;                                      // drawSlice uses the ACTIVE program's locations

  function upload(chunk) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, chunk.tri, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.UNSIGNED_SHORT, true, 0, 0);
    gl.bindVertexArray(null);
    return {
      kind: 'soup', vao, buffers: [b],
      count: chunk.count, bboxLocal: chunk.bboxLocal, cursor: 0,
    };
  }

  function begin(cam, { tint = [0.62, 0.64, 0.66], opacity = 1, section = null }) {
    const s = cam.state;
    const pp = section ? overlay : base;
    uni = pp.uni;
    gl.useProgram(pp.prog);
    gl.uniformMatrix4fv(uni.viewProj, false, s.viewProj);
    gl.uniform3f(uni.eye, s.eye[0], s.eye[1], s.eye[2]);
    const v = s.view;
    let lx = s.eye[0] - s.target[0], ly = s.eye[1] - s.target[1], lz = s.eye[2] - s.target[2];
    const ll = Math.hypot(lx, ly, lz) || 1;
    lx = lx / ll + v[1] * 0.4; ly = ly / ll + v[5] * 0.4; lz = lz / ll + v[9] * 0.4;
    const l2 = Math.hypot(lx, ly, lz) || 1;
    gl.uniform3f(uni.lightDir, lx / l2, ly / l2, lz / l2);
    gl.uniform4f(uni.tint, tint[0], tint[1], tint[2], Math.max(0.02, Math.min(1, opacity)));
    gl.uniform4f(uni.secPlane, section ? section.n[0] : 0, section ? section.n[1] : 0, section ? section.n[2] : 1, section ? section.d : 0);
    gl.uniform2f(uni.secCfg, section ? 1 : 0, section ? section.half : 0);
    if (uni.fwd) {
      const f = [s.target[0] - s.eye[0], s.target[1] - s.eye[1], s.target[2] - s.eye[2]];
      const fl = Math.hypot(...f) || 1;
      gl.uniform3f(uni.fwd, f[0] / fl, f[1] / fl, f[2] / fl);
      gl.uniform1f(uni.ortho, s.ortho ? 1 : 0);
    }
  }

  // first/k in TRIANGLES — the prefix invariant rides the shuffled build order
  function drawSlice(c, first, k) {
    gl.bindVertexArray(c.vao);
    gl.uniform3f(uni.boxMin, c.bboxLocal[0], c.bboxLocal[1], c.bboxLocal[2]);
    gl.uniform3f(uni.boxSpan, c.bboxLocal[3] - c.bboxLocal[0], c.bboxLocal[4] - c.bboxLocal[1], c.bboxLocal[5] - c.bboxLocal[2]);
    gl.drawArrays(gl.TRIANGLES, first * 3, k * 3);
  }

  return { upload, begin, drawSlice };
}
