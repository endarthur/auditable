// moncad renderer — the WebGL2 geometry layer (SPEC §6).
//
// Geometry lives on the GPU; pan/zoom is a single transform uniform, not a redraw. Lines
// are instanced screen-width quads (constant pixel width at any zoom); points are
// instanced circles. Text/glyphs/UI live on the Canvas2D overlay, not here — the hard
// GPU problems are sidestepped, not solved. Upload once via setLines/setPoints; draw()
// only touches uniforms.

const LINE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_quad;     // along 0..1, side -1..1
layout(location=1) in vec4 a_seg;      // p0.xy, p1.xy  (local-world)
layout(location=2) in float a_width;   // device px
layout(location=3) in vec4 a_color;
uniform vec2 u_res; uniform vec2 u_center; uniform float u_scale;
out vec4 v_color;
vec2 toScreen(vec2 w){ return vec2(u_res.x*0.5 + (w.x-u_center.x)*u_scale, u_res.y*0.5 - (w.y-u_center.y)*u_scale); }
void main(){
  vec2 s0 = toScreen(a_seg.xy), s1 = toScreen(a_seg.zw);
  vec2 dv = s1 - s0; float L = length(dv);
  vec2 d = L > 0.0 ? dv / L : vec2(1.0, 0.0);
  vec2 n = vec2(-d.y, d.x);
  vec2 pos = mix(s0, s1, a_quad.x) + n * (a_quad.y * a_width * 0.5);
  gl_Position = vec4(pos.x / u_res.x * 2.0 - 1.0, 1.0 - pos.y / u_res.y * 2.0, 0.0, 1.0);
  v_color = a_color;
}`;

const LINE_FS = `#version 300 es
precision highp float;
in vec4 v_color; out vec4 frag;
void main(){ frag = v_color; }`;

const POINT_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_quad;     // -1..1, -1..1
layout(location=1) in vec2 a_pos;      // local-world
layout(location=2) in float a_size;    // device px diameter
layout(location=3) in vec4 a_color;
uniform vec2 u_res; uniform vec2 u_center; uniform float u_scale;
out vec2 v_uv; out vec4 v_color;
vec2 toScreen(vec2 w){ return vec2(u_res.x*0.5 + (w.x-u_center.x)*u_scale, u_res.y*0.5 - (w.y-u_center.y)*u_scale); }
void main(){
  vec2 s = toScreen(a_pos) + a_quad * (a_size * 0.5);
  gl_Position = vec4(s.x / u_res.x * 2.0 - 1.0, 1.0 - s.y / u_res.y * 2.0, 0.0, 1.0);
  v_uv = a_quad; v_color = a_color;
}`;

const POINT_FS = `#version 300 es
precision highp float;
in vec2 v_uv; in vec4 v_color; out vec4 frag;
void main(){ if (dot(v_uv, v_uv) > 1.0) discard; frag = v_color; }`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src); gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('moncad shader: ' + gl.getShaderInfoLog(sh));
  return sh;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('moncad link: ' + gl.getProgramInfoLog(p));
  return { p, u: { res: gl.getUniformLocation(p, 'u_res'), center: gl.getUniformLocation(p, 'u_center'), scale: gl.getUniformLocation(p, 'u_scale') } };
}

// Build a VAO with a shared unit quad (loc 0) + an interleaved per-instance buffer whose
// attributes (described by `attrs`) advance once per instance (divisor 1).
function makeBatch(gl, quad, stride, attrs) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const qb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, qb);
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const inst = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, inst);
  for (const [loc, size, offset] of attrs) {
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
    gl.vertexAttribDivisor(loc, 1);
  }
  gl.bindVertexArray(null);
  return { vao, inst };
}

const LINE_QUAD = new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]);   // TRIANGLE_STRIP: along×side
const POINT_QUAD = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);

export class Renderer {
  constructor(gl) {
    this.gl = gl;
    this.line = program(gl, LINE_VS, LINE_FS);
    this.point = program(gl, POINT_VS, POINT_FS);
    // line instance: a_seg(vec4)@0, a_width(float)@16, a_color(vec4)@20 — stride 36
    this.lineBatch = makeBatch(gl, LINE_QUAD, 36, [[1, 4, 0], [2, 1, 16], [3, 4, 20]]);
    this.gridBatch = makeBatch(gl, LINE_QUAD, 36, [[1, 4, 0], [2, 1, 16], [3, 4, 20]]);   // reference grid, drawn first
    // point instance: a_pos(vec2)@0, a_size(float)@8, a_color(vec4)@12 — stride 28
    this.pointBatch = makeBatch(gl, POINT_QUAD, 28, [[1, 2, 0], [2, 1, 8], [3, 4, 12]]);
    this.nLines = 0; this.nPoints = 0; this.nGrid = 0;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  // data: Float32Array, 9 floats per segment [p0x,p0y,p1x,p1y, width, r,g,b,a]
  setLines(data) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBatch.inst);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    this.nLines = (data.length / 9) | 0;
  }

  // data: Float32Array, 9 floats per segment (same as lines) — the reference grid
  setGrid(data) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.gridBatch.inst);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    this.nGrid = (data.length / 9) | 0;
  }

  // data: Float32Array, 7 floats per point [cx,cy, size, r,g,b,a]
  setPoints(data) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBatch.inst);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    this.nPoints = (data.length / 7) | 0;
  }

  draw(view, bg = [0.071, 0.071, 0.071, 1]) {
    const gl = this.gl, u = view.uniforms();
    gl.viewport(0, 0, view.width, view.height);
    gl.clearColor(bg[0], bg[1], bg[2], bg[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const setU = (prog) => {
      gl.useProgram(prog.p);
      gl.uniform2f(prog.u.res, u.res[0], u.res[1]);
      gl.uniform2f(prog.u.center, u.center[0], u.center[1]);
      gl.uniform1f(prog.u.scale, u.scale);
    };
    if (this.nGrid) { setU(this.line); gl.bindVertexArray(this.gridBatch.vao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.nGrid); }   // behind geometry
    if (this.nLines) { setU(this.line); gl.bindVertexArray(this.lineBatch.vao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.nLines); }
    if (this.nPoints) { setU(this.point); gl.bindVertexArray(this.pointBatch.vao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.nPoints); }
    gl.bindVertexArray(null);
  }
}
