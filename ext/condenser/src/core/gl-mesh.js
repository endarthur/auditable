// @gcu/condenser — the context-mesh pipeline (micro-layers §7, tier 1).
// Static indexed triangles: one VAO + element buffer per mesh, drawn whole on
// clear frames (no prefix, no budget — the tier is bounded at open). Flat
// shading comes from screen-space derivatives (no normals buffer), two-sided
// (geological wireframes are rarely consistently wound). The section cut is
// PER-PIXEL — a triangle crossing the plane is clipped at it, not dropped —
// which is exactly the sectioned-solid view. Opacity is 4×4-Bayer screen-door:
// depth-correct, blend-free, safe under progressive accumulation and EDL.

import { makeProgram } from './gl-util.js';

const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;        // frame-local vertex
layout(location=1) in vec3 aColor;      // per-vertex rgb (heightfield drape); ignored when uVColor=0
layout(location=2) in vec3 aNormal;     // per-vertex normal (smooth relief); ignored when uVNormal=0
uniform mat4 uViewProj;
uniform vec4 uSecPlane;
out vec3 vWorldPos;
out vec3 vColor;
out vec3 vNormal;
out float vSecDist;
void main() {
  gl_Position = uViewProj * vec4(aPos, 1.0);
  vWorldPos = aPos;
  vColor = aColor;
  vNormal = aNormal;
  vSecDist = dot(aPos, uSecPlane.xyz) - uSecPlane.w;
}`;

// Per-vertex drape (uVColor) + smooth normals (uVNormal) are OPT-IN — default 0
// keeps the flat-shaded solid-tint behavior byte-for-byte. The heightfield
// surface sets both: vColor from a colormap, vNormal from the grid gradient, and
// the normal's z is divided by uZExag (inverse-transpose of the display z-scale)
// so lighting matches the vertically-exaggerated relief.
const SHADE_COMMON = `
uniform vec4 uTint;                     // rgb + opacity
uniform vec3 uLightDir;
uniform vec3 uEye;
uniform float uVColor;                  // 0/1 use vColor
uniform float uVNormal;                 // 0/1 use vNormal (else flat derivative)
uniform float uZExag;                   // vertical exaggeration (for the normal correction)
const float BAYER[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
vec3 shadeSurface() {
  vec3 n = (uVNormal > 0.5)
    ? normalize(vec3(vNormal.xy, vNormal.z / max(uZExag, 1e-4)))   // exaggeration-correct
    : normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));          // flat shading
  vec3 vd = normalize(uEye - vWorldPos);
  if (dot(n, vd) < 0.0) n = -n;                                    // two-sided
  float shade = 0.42 + 0.58 * max(dot(n, uLightDir), 0.0);
  vec3 base = (uVColor > 0.5) ? vColor : uTint.rgb;
  return base * shade;
}`;

const FRAG = `#version 300 es
precision highp float;
in vec3 vWorldPos;
in vec3 vColor;
in vec3 vNormal;
in float vSecDist;
uniform vec2 uSecCfg;                   // x: on, y: half-thickness
${SHADE_COMMON}
out vec4 outColor;
void main() {
  if (uSecCfg.x > 0.5 && abs(vSecDist) > uSecCfg.y) discard;   // per-pixel plane cut
  if (uTint.a < 0.999) {
    int bi = (int(gl_FragCoord.x) & 3) + ((int(gl_FragCoord.y) & 3) << 2);
    if (uTint.a < (BAYER[bi] + 0.5) / 16.0) discard;
  }
  outColor = vec4(shadeSurface(), 1.0);
}`;

// TRACE-OVER-THE-WALL variant, used while the layer is sectioned: with blocks
// cutting TRUE at the slab plane (gl-blocks), the mesh inside the slab sits
// BEHIND the painted cut wall and would be fully occluded — and the mesh AT the
// plane is edge-on (invisible). This program pulls each in-slab fragment's DEPTH
// onto the camera-side slab face (minus an epsilon), so the whole in-slab mesh
// projects onto the section and draws over the wall — the wireframe-trace-on-a-
// section-plot look. Color/shading unchanged; costs early-z only while sectioned.
const FRAG_OVERLAY = `#version 300 es
precision highp float;
in vec3 vWorldPos;
in vec3 vColor;
in vec3 vNormal;
in float vSecDist;
uniform vec4 uSecPlane;
uniform vec2 uSecCfg;
uniform mat4 uViewProj;
uniform vec3 uFwd;
uniform float uOrtho;
${SHADE_COMMON}
out vec4 outColor;
void main() {
  if (abs(vSecDist) > uSecCfg.y) discard;
  if (uTint.a < 0.999) {
    int bi = (int(gl_FragCoord.x) & 3) + ((int(gl_FragCoord.y) & 3) << 2);
    if (uTint.a < (BAYER[bi] + 0.5) / 16.0) discard;
  }
  outColor = vec4(shadeSurface(), 1.0);
  gl_FragDepth = gl_FragCoord.z;
  float dcEye = dot(uEye, uSecPlane.xyz) - uSecPlane.w;
  if (abs(dcEye) > uSecCfg.y) {                            // eye outside the slab → a wall may occlude
    float side = sign(dcEye);
    vec3 q; bool front = false;
    if (uOrtho > 0.5) {                                    // parallel rays: march back along the view dir
      float den = dot(uFwd, uSecPlane.xyz);
      if (abs(den) > 1e-9) {
        float s = (vSecDist - side * uSecCfg.y) / den;
        if (s > 0.0) { q = vWorldPos - uFwd * s; front = true; }
      }
    } else {
      vec3 rdm = vWorldPos - uEye;
      float den = dot(rdm, uSecPlane.xyz);
      if (abs(den) > 1e-9) {
        float tF = (side * uSecCfg.y - dcEye) / den;       // where the eye ray crosses the near face
        if (tF > 0.0 && tF < 1.0) { q = uEye + rdm * tF; front = true; }
      }
    }
    if (front) {
      vec4 clipQ = uViewProj * vec4(q, 1.0);
      gl_FragDepth = clamp(clipQ.z / clipQ.w * 0.5 + 0.5, 0.0, 1.0) - 3e-5;
    }
  }
}`;

export function createMeshPipeline(gl) {
  const mk = (frag) => {
    const prog = makeProgram(gl, VERT, frag);
    const U = (n) => gl.getUniformLocation(prog, n);
    return { prog, uni: {
      viewProj: U('uViewProj'), secPlane: U('uSecPlane'), secCfg: U('uSecCfg'),
      tint: U('uTint'), lightDir: U('uLightDir'), eye: U('uEye'),
      fwd: U('uFwd'), ortho: U('uOrtho'),
      vColor: U('uVColor'), vNormal: U('uVNormal'), zExag: U('uZExag'),
    } };
  };
  const base = mk(FRAG), overlay = mk(FRAG_OVERLAY);

  function upload(chunk) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const bufs = [];
    const bPos = gl.createBuffer(); bufs.push(bPos);
    gl.bindBuffer(gl.ARRAY_BUFFER, bPos);
    gl.bufferData(gl.ARRAY_BUFFER, chunk.pos, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    if (chunk.color) {                                     // heightfield drape: per-vertex rgb (loc 1)
      const bCol = gl.createBuffer(); bufs.push(bCol);
      gl.bindBuffer(gl.ARRAY_BUFFER, bCol);
      gl.bufferData(gl.ARRAY_BUFFER, chunk.color, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    }
    if (chunk.normal) {                                    // smooth relief: per-vertex normal (loc 2)
      const bNrm = gl.createBuffer(); bufs.push(bNrm);
      gl.bindBuffer(gl.ARRAY_BUFFER, bNrm);
      gl.bufferData(gl.ARRAY_BUFFER, chunk.normal, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 0, 0);
    }
    const bIdx = gl.createBuffer(); bufs.push(bIdx);       // stays bound in the VAO
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bIdx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, chunk.idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return {
      kind: 'mesh', vao, buffers: bufs,
      count: chunk.count, idxCount: chunk.idx.length,
      hasColor: !!chunk.color, hasNormal: !!chunk.normal,
      bboxLocal: chunk.bboxLocal, cursor: 0,
    };
  }

  // per-layer uniforms — tint [r,g,b] 0..1, opacity 0..1, section may be null.
  // Sectioned → the overlay program (depth flattened onto the slab face so the
  // trace draws over the true-cut block wall); unsectioned → the base program.
  function begin(cam, { tint = [0.62, 0.64, 0.66], opacity = 1, section = null, vcolor = false, vnormal = false }) {
    const s = cam.state;
    const { prog, uni } = section ? overlay : base;
    gl.useProgram(prog);
    gl.uniformMatrix4fv(uni.viewProj, false, s.viewProj);
    gl.uniform1f(uni.vColor, vcolor ? 1 : 0);              // heightfield drape colors
    gl.uniform1f(uni.vNormal, vnormal ? 1 : 0);            // smooth grid normals
    gl.uniform1f(uni.zExag, s.zExag || 1);                 // normal correction under exaggeration
    gl.uniform3f(uni.eye, s.eye[0], s.eye[1], s.eye[2]);
    // the headlight of blocks/sticks: eye direction + a little up
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

  function draw(c) {
    gl.bindVertexArray(c.vao);
    gl.drawElements(gl.TRIANGLES, c.idxCount, gl.UNSIGNED_INT, 0);
  }

  return { upload, begin, draw };
}
