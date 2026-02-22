// @auditable/shader — Shadertoy-compatible WebGL 2 shader helper
// Zero dependencies, pure WebGL 2.

// ── glsl tagged template literal ──

export function glsl(strings, ...values) {
  let result = strings[0];
  for (let i = 0; i < values.length; i++) result += values[i] + strings[i + 1];
  return result;
}

// ── GLSL tokenizer (for syntax highlighting) ──

const GLSL_KEYWORDS = new Set([
  'void','return','if','else','for','while','do','switch','case','default',
  'break','continue','discard','struct','in','out','inout','uniform',
  'varying','attribute','const','flat','smooth','centroid','layout',
  'highp','mediump','lowp','precision','invariant','true','false',
]);

const GLSL_TYPES = new Set([
  'float','int','uint','bool','double',
  'vec2','vec3','vec4','ivec2','ivec3','ivec4','uvec2','uvec3','uvec4',
  'bvec2','bvec3','bvec4','dvec2','dvec3','dvec4',
  'mat2','mat3','mat4','mat2x2','mat2x3','mat2x4',
  'mat3x2','mat3x3','mat3x4','mat4x2','mat4x3','mat4x4',
  'sampler2D','sampler3D','samplerCube','sampler2DShadow',
  'sampler2DArray','isampler2D','isampler3D','usampler2D','usampler3D',
]);

const GLSL_BUILTINS = new Set([
  'radians','degrees','sin','cos','tan','asin','acos','atan',
  'sinh','cosh','tanh','asinh','acosh','atanh',
  'pow','exp','log','exp2','log2','sqrt','inversesqrt',
  'abs','sign','floor','ceil','fract','mod','modf',
  'min','max','clamp','mix','step','smoothstep',
  'length','distance','dot','cross','normalize','faceforward',
  'reflect','refract','matrixCompMult','outerProduct','transpose',
  'determinant','inverse','lessThan','lessThanEqual',
  'greaterThan','greaterThanEqual','equal','notEqual','any','all','not',
  'texture','textureLod','textureProj','textureGrad','texelFetch',
  'dFdx','dFdy','fwidth',
  'mainImage',
]);

const SHADERTOY_UNIFORMS = [
  'iResolution','iTime','iTimeDelta','iFrame','iMouse',
  'iChannel0','iChannel1','iChannel2','iChannel3',
  'iChannelResolution','iChannelTime','iDate','iSampleRate',
  'fragColor','fragCoord',
];

function tokenizeGlsl(code) {
  const tokens = [];
  let i = 0;
  const len = code.length;

  while (i < len) {
    // line comment
    if (code[i] === '/' && code[i + 1] === '/') {
      const start = i;
      while (i < len && code[i] !== '\n') i++;
      tokens.push({ type: 'cmt', text: code.slice(start, i) });
      continue;
    }
    // block comment
    if (code[i] === '/' && code[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < len && !(code[i - 1] === '*' && code[i] === '/')) i++;
      if (i < len) i++;
      tokens.push({ type: 'cmt', text: code.slice(start, i) });
      continue;
    }
    // preprocessor
    if (code[i] === '#') {
      const start = i;
      while (i < len && code[i] !== '\n') i++;
      tokens.push({ type: 'atrule', text: code.slice(start, i) });
      continue;
    }
    // numbers
    if (/\d/.test(code[i]) || (code[i] === '.' && i + 1 < len && /\d/.test(code[i + 1]))) {
      const start = i;
      if (code[i] === '0' && (code[i + 1] === 'x' || code[i + 1] === 'X')) {
        i += 2;
        while (i < len && /[0-9a-fA-F]/.test(code[i])) i++;
      } else {
        while (i < len && /[0-9.eE+-]/.test(code[i])) i++;
      }
      // skip type suffix (u, f)
      if (i < len && /[uUfF]/.test(code[i])) i++;
      tokens.push({ type: 'num', text: code.slice(start, i) });
      continue;
    }
    // identifiers / keywords
    if (/[a-zA-Z_]/.test(code[i])) {
      const start = i;
      while (i < len && /\w/.test(code[i])) i++;
      const word = code.slice(start, i);
      if (GLSL_KEYWORDS.has(word)) {
        tokens.push({ type: 'kw', text: word });
      } else if (GLSL_TYPES.has(word)) {
        tokens.push({ type: 'const', text: word });
      } else if (GLSL_BUILTINS.has(word)) {
        tokens.push({ type: 'fn', text: word });
      } else if (i < len && code[i] === '(') {
        tokens.push({ type: 'fn', text: word });
      } else {
        tokens.push({ type: 'id', text: word });
      }
      continue;
    }
    // operators
    if ('=+-*/<>!&|^~%?:'.includes(code[i])) {
      tokens.push({ type: 'op', text: code[i] });
      i++;
      continue;
    }
    // punctuation
    if ('(){}[];,.'.includes(code[i])) {
      tokens.push({ type: 'punc', text: code[i] });
      i++;
      continue;
    }
    // whitespace / other
    tokens.push({ type: '', text: code[i] });
    i++;
  }

  return tokens;
}

// ── GLSL completions ──

function glslCompletions() {
  const items = [];
  for (const w of GLSL_KEYWORDS)      items.push({ text: w, kind: 'kw' });
  for (const w of GLSL_TYPES)         items.push({ text: w, kind: 'const' });
  for (const w of GLSL_BUILTINS)      items.push({ text: w, kind: 'fn' });
  for (const w of SHADERTOY_UNIFORMS) items.push({ text: w, kind: 'var' });
  return items;
}

// ── Self-registration ──

if (typeof window !== 'undefined') {
  if (!window._taggedLanguages) window._taggedLanguages = {};
  window._taggedLanguages.glsl = { tokenize: tokenizeGlsl, completions: glslCompletions };
}

// ── GLSL constants ──

const FULLSCREEN_VS = `#version 300 es
out vec2 vUV;
void main() {
  // fullscreen triangle from gl_VertexID — no VBO needed
  vUV = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(vUV * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG_PREAMBLE = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor_out;

uniform vec3  iResolution;
uniform float iTime;
uniform float iTimeDelta;
uniform int   iFrame;
uniform vec4  iMouse;
`;

const SHADERTOY_MAIN = `
void main() {
  mainImage(fragColor_out, vUV * iResolution.xy);
}`;

// ── ShaderError — adjusts line numbers to user code ──

class ShaderError extends Error {
  constructor(log, preambleLines) {
    // try to adjust line numbers: "ERROR: 0:LINE:" → subtract preamble
    const adjusted = log.replace(/ERROR:\s*(\d+):(\d+):/g, (m, col, line) => {
      const userLine = parseInt(line) - preambleLines;
      return userLine > 0 ? `ERROR: ${col}:${userLine}:` : m;
    });
    super(adjusted);
    this.name = 'ShaderError';
    this.rawLog = log;
  }
}

// ── Helpers ──

function detectMode(code) {
  // strip single-line and multi-line comments
  const stripped = code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  if (/\bvoid\s+main\s*\(/.test(stripped)) return 'raw';
  return 'shadertoy';
}

function inferType(value) {
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return 'float';
  if (Array.isArray(value)) {
    if (value.length === 2) return 'vec2';
    if (value.length === 3) return 'vec3';
    if (value.length === 4) return 'vec4';
  }
  return null;
}

function glslType(type) {
  if (type === 'bool') return 'int'; // pass booleans as int
  return type;
}

function assembleFragment(code, mode, customDecls) {
  let src = FRAG_PREAMBLE;
  if (customDecls) src += customDecls + '\n';
  src += '\n' + code + '\n';
  if (mode === 'shadertoy') src += SHADERTOY_MAIN;
  return src;
}

function countPreambleLines(customDecls) {
  let n = FRAG_PREAMBLE.split('\n').length;
  if (customDecls) n += customDecls.split('\n').length;
  return n + 1; // +1 for the blank line before user code
}

// ── GL compile/link ──

function compileShader(gl, type, source) {
  const s = gl.createShader(type);
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new ShaderError(log, 0);
  }
  return s;
}

function linkProgram(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error('Link error: ' + log);
  }
  return p;
}

// ── Mouse tracking (Shadertoy convention) ──

function setupMouse(canvas) {
  const mouse = { x: 0, y: 0, z: 0, w: 0 };
  let down = false;

  const rect = () => canvas.getBoundingClientRect();

  const onMove = (e) => {
    if (!down) return;
    const r = rect();
    mouse.x = e.clientX - r.left;
    mouse.y = r.height - (e.clientY - r.top); // flip Y
  };

  const onDown = (e) => {
    down = true;
    const r = rect();
    mouse.x = e.clientX - r.left;
    mouse.y = r.height - (e.clientY - r.top);
    mouse.z = mouse.x;
    mouse.w = mouse.y;
  };

  const onUp = () => {
    down = false;
    mouse.z = -Math.abs(mouse.z);
    mouse.w = -Math.abs(mouse.w);
  };

  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mousedown', onDown);
  canvas.addEventListener('mouseup', onUp);

  const destroy = () => {
    canvas.removeEventListener('mousemove', onMove);
    canvas.removeEventListener('mousedown', onDown);
    canvas.removeEventListener('mouseup', onUp);
  };

  return { mouse, destroy };
}

// ── Uniform setters ──

function makeSetter(gl, loc, type) {
  switch (type) {
    case 'float': return (v) => gl.uniform1f(loc, v);
    case 'vec2':  return (v) => gl.uniform2fv(loc, v);
    case 'vec3':  return (v) => gl.uniform3fv(loc, v);
    case 'vec4':  return (v) => gl.uniform4fv(loc, v);
    case 'bool':  return (v) => gl.uniform1i(loc, v ? 1 : 0);
    case 'int':   return (v) => gl.uniform1i(loc, v);
    default:      return (v) => gl.uniform1f(loc, v);
  }
}

// ── Main entry point ──

export function shader(canvas, code, opts = {}) {
  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('WebGL 2 not supported');

  const customUniforms = opts.uniforms || {};

  // build custom uniform declarations
  const customTypes = {};
  let customDecls = '';
  for (const [name, value] of Object.entries(customUniforms)) {
    const type = inferType(value);
    if (!type) throw new Error(`Cannot infer GLSL type for uniform "${name}": ${JSON.stringify(value)}`);
    customTypes[name] = type;
    customDecls += `uniform ${glslType(type)} ${name};\n`;
  }
  customDecls = customDecls.trimEnd();

  const mode = detectMode(code);
  const preambleLines = countPreambleLines(customDecls || null);

  // compile vertex shader (shared, never changes)
  const vs = compileShader(gl, gl.VERTEX_SHADER, FULLSCREEN_VS);

  // compile initial fragment shader
  let fragSource = assembleFragment(code, mode, customDecls || null);
  let fs, program;
  try {
    fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSource);
  } catch (e) {
    if (e instanceof ShaderError) {
      throw new ShaderError(e.rawLog, preambleLines);
    }
    throw e;
  }
  program = linkProgram(gl, vs, fs);

  // empty VAO (WebGL 2 requirement for vertexless drawing)
  const vao = gl.createVertexArray();

  // look up builtin uniform locations
  function getLocations(prog) {
    return {
      iResolution: gl.getUniformLocation(prog, 'iResolution'),
      iTime:       gl.getUniformLocation(prog, 'iTime'),
      iTimeDelta:  gl.getUniformLocation(prog, 'iTimeDelta'),
      iFrame:      gl.getUniformLocation(prog, 'iFrame'),
      iMouse:      gl.getUniformLocation(prog, 'iMouse'),
    };
  }

  // look up custom uniform locations + build setters
  function getCustomSetters(prog) {
    const setters = {};
    for (const [name, type] of Object.entries(customTypes)) {
      const loc = gl.getUniformLocation(prog, name);
      setters[name] = makeSetter(gl, loc, type);
    }
    return setters;
  }

  let locs = getLocations(program);
  let customSetters = getCustomSetters(program);

  // current custom uniform values (mutable via set())
  const customValues = {};
  for (const [name, value] of Object.entries(customUniforms)) {
    customValues[name] = value;
  }

  // mouse tracking
  const { mouse, destroy: destroyMouse } = setupMouse(canvas);

  // animation state
  let startTime = performance.now() / 1000;
  let lastTime = startTime;
  let frame = 0;
  let rafId = null;
  let running = false;

  function render(now) {
    now /= 1000;
    const time = now - startTime;
    const delta = now - lastTime;
    lastTime = now;

    // resize if canvas dimensions changed
    if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
      canvas.width = canvas.clientWidth;
      canvas.height = canvas.clientHeight;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);

    gl.useProgram(program);
    gl.bindVertexArray(vao);

    // set builtin uniforms
    if (locs.iResolution) gl.uniform3f(locs.iResolution, canvas.width, canvas.height, 1.0);
    if (locs.iTime) gl.uniform1f(locs.iTime, time);
    if (locs.iTimeDelta) gl.uniform1f(locs.iTimeDelta, delta);
    if (locs.iFrame) gl.uniform1i(locs.iFrame, frame);
    if (locs.iMouse) gl.uniform4f(locs.iMouse, mouse.x, mouse.y, mouse.z, mouse.w);

    // set custom uniforms
    for (const [name, setter] of Object.entries(customSetters)) {
      setter(customValues[name]);
    }

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    frame++;
    rafId = requestAnimationFrame(render);
  }

  function start() {
    if (running) return;
    running = true;
    rafId = requestAnimationFrame(render);
  }

  function stop() {
    if (!running) return;
    running = false;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  // controller object
  const controller = {
    gl,
    canvas,

    set(name, value) {
      if (!(name in customValues)) {
        const available = Object.keys(customValues).join(', ');
        throw new Error(`Unknown uniform "${name}". Available: ${available || '(none)'}`);
      }
      customValues[name] = value;
    },

    stop,
    start,

    compile(newCode) {
      const newMode = detectMode(newCode);
      const newSource = assembleFragment(newCode, newMode, customDecls || null);
      let newFs;
      try {
        newFs = compileShader(gl, gl.FRAGMENT_SHADER, newSource);
      } catch (e) {
        // preserve old shader on failure
        if (e instanceof ShaderError) {
          throw new ShaderError(e.rawLog, preambleLines);
        }
        throw e;
      }
      const newProgram = linkProgram(gl, vs, newFs);
      // swap
      gl.deleteShader(fs);
      gl.deleteProgram(program);
      fs = newFs;
      program = newProgram;
      locs = getLocations(program);
      customSetters = getCustomSetters(program);
    },

    destroy() {
      stop();
      destroyMouse();
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteProgram(program);
      gl.deleteVertexArray(vao);
    },
  };

  // start the loop
  start();
  return controller;
}
