// @gcu/dxf block resolver — the opt-in derived view.
//
// The canonical Document keeps blocks compact (a BlockDef + lightweight INSERTs), the
// spine-principle "small auditable thing". explode() is the DERIVED "give me the legion"
// view: it composes each INSERT's transform over its block definition to produce flat
// world geometry, recursing through nested inserts with a cyclic-reference guard. You
// opt into it; nothing bakes it at import.

const DEG = Math.PI / 180;

// 4×4 affine, row-major. World = Translate(insertion) · RotZ · Scale · Translate(−base).
const ident = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function matMul(a, b) {
  const m = new Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) { let s = 0; for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c]; m[r * 4 + c] = s; }
  return m;
}

function apply(m, [x, y, z]) {
  return [m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11]];
}

function insertMatrix(t, base = [0, 0, 0]) {
  const c = Math.cos(t.rotation * DEG), s = Math.sin(t.rotation * DEG);
  const [sx, sy, sz] = t.scale, [px, py, pz] = t.position, [bx, by, bz] = base;
  const T = [1, 0, 0, px, 0, 1, 0, py, 0, 0, 1, pz, 0, 0, 0, 1];
  const R = [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const S = [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, 0, 0, 0, 1];
  const B = [1, 0, 0, -bx, 0, 1, 0, -by, 0, 0, 1, -bz, 0, 0, 0, 1];
  return matMul(matMul(matMul(T, R), S), B);
}

const scaleX = (m) => Math.hypot(m[0], m[4], m[8]);   // uniform-scale factor for radius

function transformFeature(f, M) {
  const g = f.geometry;
  if (g.kind === 'polyline' || g.kind === 'face') {
    const v = new Float64Array(g.vertices.length);
    for (let i = 0; i < v.length; i += 3) { const w = apply(M, [g.vertices[i], g.vertices[i + 1], g.vertices[i + 2]]); v[i] = w[0]; v[i + 1] = w[1]; v[i + 2] = w[2]; }
    return { ...f, geometry: { ...g, vertices: v } };       // bulges survive: rotation + uniform scale preserve tan(θ/4)
  }
  if (g.kind === 'circle') return { ...f, geometry: { ...g, center: apply(M, g.center), radius: g.radius * scaleX(M) } };
  if (g.kind === 'point') return { ...f, geometry: { ...g, position: apply(M, g.position) } };
  return f;
}

function walk(features, blocks, M, stack, warnings, out) {
  for (const f of features) {
    const g = f.geometry;
    if (g && g.kind === 'insert') {
      const name = g.block;
      if (stack.includes(name)) { warnings.push({ entity: 'INSERT', reason: `cyclic block reference: ${name}` }); continue; }
      const blk = blocks[name];
      if (!blk) { warnings.push({ entity: 'INSERT', reason: `undefined block: ${name}` }); continue; }
      if (g.transform.scale[0] !== g.transform.scale[1]) warnings.push({ entity: 'INSERT', reason: `non-uniform scale on '${name}' distorts arcs/circles` });
      walk(blk.features, blocks, matMul(M, insertMatrix(g.transform, blk.base)), [...stack, name], warnings, out);
    } else if (g) out.push(transformFeature(f, M));
    else out.push(f);                                        // null-geometry punt passes through
  }
}

// Resolve every INSERT into transformed flat geometry. Returns a new Document with no
// inserts (exploded:true), accumulating any cyclic / undefined-block / non-uniform-scale
// warnings onto the existing log.
export function explode(doc, _opts = {}) {
  const warnings = [], out = [];
  walk(doc.features, doc.blocks || {}, ident(), [], warnings, out);
  return { ...doc, features: out, exploded: true, warnings: [...(doc.warnings || []), ...warnings] };
}
