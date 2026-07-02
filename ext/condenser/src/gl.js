// @gcu/condenser — the WebGL2 splat renderer. Raw GL, no scene graph: per-chunk
// VAOs over the quantized buffers (positions stay uint16 on the GPU — denormalized
// in the vertex shader against per-chunk bbox uniforms), circular point splats,
// color-by as a mode uniform + LUT texture (switching color source is a uniform/
// texture swap, never a buffer re-upload — micro-spec §2.2).
//
// Prefix-LOD (M1 form): a global per-frame element budget split across visible
// chunks proportionally; each chunk draws its FIRST k elements — correct as a
// uniform subsample because chunks.js shuffled them (the §2.1.4 invariant).

const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;        // uint16 normalized -> 0..1
layout(location=1) in float aIntensity; // uint16 normalized
layout(location=2) in float aClass;     // uint8, raw (0..255)
layout(location=3) in vec3 aRgb;        // uint8 normalized
uniform mat4 uViewProj;
uniform vec3 uBoxMin, uBoxSpan;
uniform float uPointPx;
uniform int uColorMode;                 // 0 elevation | 1 intensity | 2 classification | 3 rgb
uniform vec2 uZRange;                   // document local z min/span (elevation ramp)
uniform float uIntensityScale;          // 1 / (p98-ish max, normalized units)
uniform sampler2D uRamp;                // 256x1 continuous ramp
uniform sampler2D uPalette;             // 32x1 classification palette
out vec4 vColor;
void main() {
  vec3 p = uBoxMin + aPos * uBoxSpan;
  gl_Position = uViewProj * vec4(p, 1.0);
  gl_PointSize = uPointPx;
  if (uColorMode == 0) {
    float t = clamp((p.z - uZRange.x) / max(uZRange.y, 1e-6), 0.0, 1.0);
    vColor = texture(uRamp, vec2(t, 0.5));
  } else if (uColorMode == 1) {
    float t = clamp(aIntensity * uIntensityScale, 0.0, 1.0);
    vColor = texture(uRamp, vec2(t, 0.5));
  } else if (uColorMode == 2) {
    vColor = texture(uPalette, vec2((aClass + 0.5) / 32.0, 0.5));
  } else {
    vColor = vec4(aRgb, 1.0);
  }
}`;

const FRAG = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 outColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  if (dot(d, d) > 0.25) discard;        // circular splat
  outColor = vColor;
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('condenser shader: ' + gl.getShaderInfoLog(s));
  return s;
}
export function makeProgram(gl, vsrc, fsrc) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsrc));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('condenser link: ' + gl.getProgramInfoLog(p));
  return p;
}

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

// Upload one chunk's buffers → a VAO. CPU copies are the caller's to release.
export function uploadChunk(gl, chunk) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = (data, loc, size, type, normalized, isInt = false) => {
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
  gl.bindVertexArray(null);
  return { vao, buffers, count: chunk.count, bboxLocal: chunk.bboxLocal };
}

/**
 * createRenderer(canvas) — owns the GL context, program, LUTs, and the chunk
 * list; draw(cam, opts) renders one frame (into the current framebuffer — the
 * EDL pass wraps it). Chunks arrive via addChunk() as the stream lands.
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
    intensityScale: U('uIntensityScale'), ramp: U('uRamp'), palette: U('uPalette'),
  };
  const ramp = lutTexture(gl, rampPixels(), 256);
  const palette = lutTexture(gl, palettePixels(), 32);
  const chunks = [];
  let docBbox = null, intensityMax = 1;

  return {
    gl,
    get chunkCount() { return chunks.length; },
    get elementCount() { return chunks.reduce((s, c) => s + c.count, 0); },
    addChunk(chunk) {
      chunks.push(uploadChunk(gl, chunk));
      let m = 0; const a = chunk.intensity;
      for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i];
      intensityMax = Math.max(intensityMax, m);
    },
    setDocBbox(b) { docBbox = b; },
    clearChunks() { for (const c of chunks) { gl.deleteVertexArray(c.vao); c.buffers.forEach((b) => gl.deleteBuffer(b)); } chunks.length = 0; intensityMax = 1; },
    resize() {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      return [w, h];
    },
    // Draw one frame into the CURRENT framebuffer (caller sets viewport target).
    draw(cam, { budget = 3_000_000, pointPx = 2.5, colorMode = 0 } = {}) {
      const total = chunks.reduce((s, c) => s + c.count, 0) || 1;
      const frac = Math.min(1, budget / total);            // M1 prefix-LOD: uniform fraction per chunk
      gl.enable(gl.DEPTH_TEST);
      gl.clearColor(background[0], background[1], background[2], background[3]);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(prog);
      gl.uniformMatrix4fv(uni.viewProj, false, cam.state.viewProj);
      gl.uniform1f(uni.pointPx, pointPx * (window.devicePixelRatio || 1));
      gl.uniform1i(uni.colorMode, colorMode);
      const b = docBbox || Float64Array.of(0, 0, 0, 1, 1, 1);
      gl.uniform2f(uni.zRange, b[2], Math.max(b[5] - b[2], 1e-6));
      gl.uniform1f(uni.intensityScale, 65535 / (intensityMax || 1));
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, ramp); gl.uniform1i(uni.ramp, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, palette); gl.uniform1i(uni.palette, 1);
      let drawn = 0;
      for (const c of chunks) {
        const k = Math.max(1, Math.floor(c.count * frac));
        gl.uniform3f(uni.boxMin, c.bboxLocal[0], c.bboxLocal[1], c.bboxLocal[2]);
        gl.uniform3f(uni.boxSpan, c.bboxLocal[3] - c.bboxLocal[0], c.bboxLocal[4] - c.bboxLocal[1], c.bboxLocal[5] - c.bboxLocal[2]);
        gl.bindVertexArray(c.vao);
        gl.drawArrays(gl.POINTS, 0, k);
        drawn += k;
      }
      gl.bindVertexArray(null);
      return drawn;
    },
  };
}
