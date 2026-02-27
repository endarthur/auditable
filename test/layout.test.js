import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// shim document for state.js
globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };

const { atra } = await import('../ext/atra/src/atra.js');
const { atraCompletions } = await import('../ext/atra/src/highlight.js');

// ═════════════════════════════════════════════════════════════════════
// Layout parsing — atra.parse()
// ═════════════════════════════════════════════════════════════════════

describe('layout parsing', () => {
  it('parses a simple layout', () => {
    const ast = atra.parse(`
layout Vec3
  x, y, z: f64
end layout
`);
    assert.ok(ast.layouts);
    assert.ok(ast.layouts.Vec3);
    assert.equal(ast.layouts.Vec3.x, 0);
    assert.equal(ast.layouts.Vec3.y, 8);
    assert.equal(ast.layouts.Vec3.z, 16);
    assert.equal(ast.layouts.Vec3.__size, 24);
    assert.equal(ast.layouts.Vec3.__align, 8);
  });

  it('parses nested layouts', () => {
    const ast = atra.parse(`
layout Vec3
  x, y, z: f64
end layout

layout Sphere
  center: Vec3
  radius: f64
end layout
`);
    assert.ok(ast.layouts.Vec3);
    assert.ok(ast.layouts.Sphere);
    assert.equal(ast.layouts.Sphere.center, 0);
    assert.equal(ast.layouts.Sphere.radius, 24);
    assert.equal(ast.layouts.Sphere.__size, 32);
  });

  it('parses mixed-type layouts with alignment', () => {
    const ast = atra.parse(`
layout Rec
  id: i32
  value: f64
end layout
`);
    // i32 at offset 0, f64 needs 8-byte alignment → offset 8
    assert.equal(ast.layouts.Rec.id, 0);
    assert.equal(ast.layouts.Rec.value, 8);
    assert.equal(ast.layouts.Rec.__size, 16);
    assert.equal(ast.layouts.Rec.__align, 8);
  });

  it('returns null layouts when no layouts defined', () => {
    const ast = atra.parse(`
function f(x: f64): f64
begin
  f := x
end
`);
    assert.equal(ast.layouts, null);
  });

  it('parses layout with end (no trailing layout keyword)', () => {
    const ast = atra.parse(`
layout Point
  x, y: f64
end
`);
    assert.ok(ast.layouts.Point);
    assert.equal(ast.layouts.Point.__size, 16);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Packed layout parsing
// ═════════════════════════════════════════════════════════════════════

describe('packed layout parsing', () => {
  it('parses a packed layout with no alignment padding', () => {
    const ast = atra.parse(`
layout packed Rec
  id: i32
  value: f64
end layout
`);
    assert.ok(ast.layouts.Rec);
    assert.equal(ast.layouts.Rec.id, 0);
    assert.equal(ast.layouts.Rec.value, 4);   // no padding, immediately after i32
    assert.equal(ast.layouts.Rec.__size, 12);  // 4 + 8, no trailing padding
    assert.equal(ast.layouts.Rec.__align, 1);  // packed → align 1
  });

  it('parses a packed layout with multiple fields', () => {
    const ast = atra.parse(`
layout packed Flags
  a: i32
  b: f64
  c: i32
  d: f64
end layout
`);
    assert.equal(ast.layouts.Flags.a, 0);
    assert.equal(ast.layouts.Flags.b, 4);
    assert.equal(ast.layouts.Flags.c, 12);
    assert.equal(ast.layouts.Flags.d, 16);
    assert.equal(ast.layouts.Flags.__size, 24);
    assert.equal(ast.layouts.Flags.__align, 1);
  });

  it('nested packed layout has no padding between embedded layout and next field', () => {
    const ast = atra.parse(`
layout packed Inner
  x: i32
  y: f64
end layout

layout packed Outer
  inner: Inner
  z: i32
end layout
`);
    assert.equal(ast.layouts.Inner.__size, 12);
    assert.equal(ast.layouts.Outer.inner, 0);
    assert.equal(ast.layouts.Outer.z, 12);  // immediately after Inner (12 bytes)
    assert.equal(ast.layouts.Outer.__size, 16);
    assert.equal(ast.layouts.Outer.__align, 1);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Packed layout codegen
// ═════════════════════════════════════════════════════════════════════

describe('packed layout codegen', () => {
  it('reads/writes packed layout fields at correct offsets', () => {
    const mem = new WebAssembly.Memory({ initial: 1 });
    const dv = new DataView(mem.buffer);
    // Packed Rec: id (i32 at 0), value (f64 at 4, NOT 8)
    dv.setInt32(0, 42, true);
    dv.setFloat64(4, 3.14, true);

    const m = atra({ memory: mem })`
layout packed Rec
  id: i32
  value: f64
end layout

function getId(r: layout Rec): i32
begin
  getId := r.id
end

function getValue(r: layout Rec): f64
begin
  getValue := r.value
end

subroutine setRec(r: layout Rec, i: i32, v: f64)
begin
  r.id := i
  r.value := v
end
`;
    assert.equal(m.getId(0), 42);
    assert.ok(Math.abs(m.getValue(0) - 3.14) < 1e-10);

    m.setRec(0, 99, 2.71);
    assert.equal(dv.getInt32(0, true), 99);
    assert.ok(Math.abs(dv.getFloat64(4, true) - 2.71) < 1e-10);
  });

  it('packed __size is correct', () => {
    const mem = new WebAssembly.Memory({ initial: 1 });
    const m = atra({ memory: mem })`
layout packed Rec
  id: i32
  value: f64
end layout

function recSize(): i32
begin
  recSize := Rec.__size
end
`;
    assert.equal(m.recSize(), 12);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Layout codegen — field read/write
// ═════════════════════════════════════════════════════════════════════

describe('layout codegen', () => {
  it('reads layout fields from memory', () => {
    const mem = new WebAssembly.Memory({ initial: 1 });
    const f64 = new Float64Array(mem.buffer);
    // Write Vec3 at offset 0: x=1.0, y=2.0, z=3.0
    f64[0] = 1.0;
    f64[1] = 2.0;
    f64[2] = 3.0;

    const m = atra({ memory: mem })`
layout Vec3
  x, y, z: f64
end layout

function getX(v: layout Vec3): f64
begin
  getX := v.x
end

function getY(v: layout Vec3): f64
begin
  getY := v.y
end

function getZ(v: layout Vec3): f64
begin
  getZ := v.z
end
`;
    assert.equal(m.getX(0), 1.0);
    assert.equal(m.getY(0), 2.0);
    assert.equal(m.getZ(0), 3.0);
  });

  it('writes layout fields to memory', () => {
    const mem = new WebAssembly.Memory({ initial: 1 });
    const f64 = new Float64Array(mem.buffer);

    const m = atra({ memory: mem })`
layout Vec3
  x, y, z: f64
end layout

subroutine setVec(v: layout Vec3, a: f64, b: f64, c: f64)
begin
  v.x := a
  v.y := b
  v.z := c
end
`;
    m.setVec(0, 10.0, 20.0, 30.0);
    assert.equal(f64[0], 10.0);
    assert.equal(f64[1], 20.0);
    assert.equal(f64[2], 30.0);
  });

  it('handles nested layout field access', () => {
    const mem = new WebAssembly.Memory({ initial: 1 });
    const f64 = new Float64Array(mem.buffer);
    // Sphere at offset 0: center.x=1, center.y=2, center.z=3, radius=5
    f64[0] = 1.0; f64[1] = 2.0; f64[2] = 3.0; f64[3] = 5.0;

    const m = atra({ memory: mem })`
layout Vec3
  x, y, z: f64
end layout

layout Sphere
  center: Vec3
  radius: f64
end layout

function getCenterX(s: layout Sphere): f64
begin
  getCenterX := s.center.x
end

function getRadius(s: layout Sphere): f64
begin
  getRadius := s.radius
end
`;
    assert.equal(m.getCenterX(0), 1.0);
    assert.equal(m.getRadius(0), 5.0);
  });

  it('handles nested layout field writes', () => {
    const mem = new WebAssembly.Memory({ initial: 1 });
    const f64 = new Float64Array(mem.buffer);

    const m = atra({ memory: mem })`
layout Vec3
  x, y, z: f64
end layout

layout Sphere
  center: Vec3
  radius: f64
end layout

subroutine setSphere(s: layout Sphere, cx: f64, cy: f64, cz: f64, r: f64)
begin
  s.center.x := cx
  s.center.y := cy
  s.center.z := cz
  s.radius := r
end
`;
    m.setSphere(0, 7.0, 8.0, 9.0, 42.0);
    assert.equal(f64[0], 7.0);
    assert.equal(f64[1], 8.0);
    assert.equal(f64[2], 9.0);
    assert.equal(f64[3], 42.0);
  });

  it('emits Layout.__size as i32 constant', () => {
    const mem = new WebAssembly.Memory({ initial: 1 });

    const m = atra({ memory: mem })`
layout Vec3
  x, y, z: f64
end layout

function vec3Size(): i32
begin
  vec3Size := Vec3.__size
end
`;
    assert.equal(m.vec3Size(), 24);
  });

  it('emits Layout.__align as i32 constant', () => {
    const mem = new WebAssembly.Memory({ initial: 1 });

    const m = atra({ memory: mem })`
layout Vec3
  x, y, z: f64
end layout

function vec3Align(): i32
begin
  vec3Align := Vec3.__align
end
`;
    assert.equal(m.vec3Align(), 8);
  });

  it('emits Layout.field as offset constant', () => {
    const mem = new WebAssembly.Memory({ initial: 1 });

    const m = atra({ memory: mem })`
layout Vec3
  x, y, z: f64
end layout

function yOffset(): i32
begin
  yOffset := Vec3.y
end
`;
    assert.equal(m.yOffset(), 8);
  });

  it('supports layout-typed locals', () => {
    const mem = new WebAssembly.Memory({ initial: 1 });
    const f64 = new Float64Array(mem.buffer);
    // Two Vec3s at offsets 0 and 24
    f64[0] = 1.0; f64[1] = 2.0; f64[2] = 3.0; // first
    f64[3] = 4.0; f64[4] = 5.0; f64[5] = 6.0; // second

    const m = atra({ memory: mem })`
layout Vec3
  x, y, z: f64
end layout

function sumX(arr: i32, n: i32): f64
var s: layout Vec3, total: f64, i: i32
begin
  total := 0.0
  for i := 0, n
    s := arr + i * Vec3.__size
    total := total + s.x
  end for
  sumX := total
end
`;
    assert.equal(m.sumX(0, 2), 5.0); // 1.0 + 4.0
  });

  it('handles i32 fields in layouts', () => {
    const mem = new WebAssembly.Memory({ initial: 1 });
    const i32 = new Int32Array(mem.buffer);
    i32[0] = 42;
    i32[1] = 99;

    const m = atra({ memory: mem })`
layout Pair
  a, b: i32
end layout

function getA(p: layout Pair): i32
begin
  getA := p.a
end

function getB(p: layout Pair): i32
begin
  getB := p.b
end
`;
    assert.equal(m.getA(0), 42);
    assert.equal(m.getB(0), 99);
  });

  it('handles mixed i32/f64 fields with alignment', () => {
    const mem = new WebAssembly.Memory({ initial: 1 });
    const dv = new DataView(mem.buffer);
    // Rec: id (i32 at 0), value (f64 at 8 due to alignment)
    dv.setInt32(0, 7, true);
    dv.setFloat64(8, 3.14, true);

    const m = atra({ memory: mem })`
layout Rec
  id: i32
  value: f64
end layout

function getId(r: layout Rec): i32
begin
  getId := r.id
end

function getValue(r: layout Rec): f64
begin
  getValue := r.value
end
`;
    assert.equal(m.getId(0), 7);
    assert.equal(Math.abs(m.getValue(0) - 3.14) < 1e-10, true);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Array field parsing
// ═════════════════════════════════════════════════════════════════════

describe('array field parsing', () => {
  it('parses a layout with f64[3] field', () => {
    const ast = atra.parse(`
layout Particle
  pos: f64[3]
  mass: f64
end layout
`);
    assert.ok(ast.layouts.Particle);
    const p = ast.layouts.Particle;
    // pos is an array field: 3 * 8 = 24 bytes
    assert.deepStrictEqual(p.pos, { offset: 0, count: 3, elemSize: 8 });
    assert.equal(p.mass, 24);
    assert.equal(p.__size, 32);
  });

  it('parses a layout with layout array field', () => {
    const ast = atra.parse(`
layout Vec3
  x, y, z: f64
end layout

layout Mesh
  vertices: Vec3[4]
  count: i32
end layout
`);
    const m = ast.layouts.Mesh;
    // vertices: 4 * 24 = 96 bytes
    assert.deepStrictEqual(m.vertices, { offset: 0, count: 4, elemSize: 24 });
    assert.equal(m.count, 96);
    assert.equal(m.__size, 104); // 96 + 4 = 100, aligned to 8 → 104
  });

  it('parses packed layout with array field', () => {
    const ast = atra.parse(`
layout packed Rec
  id: i32
  data: f64[3]
end layout
`);
    const r = ast.layouts.Rec;
    assert.equal(r.id, 0);
    assert.deepStrictEqual(r.data, { offset: 4, count: 3, elemSize: 8 });
    assert.equal(r.__size, 28); // 4 + 24
    assert.equal(r.__align, 1);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Array field codegen
// ═════════════════════════════════════════════════════════════════════

describe('array field codegen', () => {
  it('reads/writes individual array elements via Wasm', () => {
    const mem = new WebAssembly.Memory({ initial: 1 });
    const f64 = new Float64Array(mem.buffer);
    // Particle at offset 0: pos[0]=1.0, pos[1]=2.0, pos[2]=3.0, mass=10.0
    f64[0] = 1.0; f64[1] = 2.0; f64[2] = 3.0; f64[3] = 10.0;

    const m = atra({ memory: mem })`
layout Particle
  pos: f64[3]
  mass: f64
end layout

function getPos(p: layout Particle, i: i32): f64
begin
  getPos := p.pos[i]
end

function getMass(p: layout Particle): f64
begin
  getMass := p.mass
end

subroutine setPos(p: layout Particle, i: i32, v: f64)
begin
  p.pos[i] := v
end
`;
    assert.equal(m.getPos(0, 0), 1.0);
    assert.equal(m.getPos(0, 1), 2.0);
    assert.equal(m.getPos(0, 2), 3.0);
    assert.equal(m.getMass(0), 10.0);

    m.setPos(0, 1, 99.0);
    assert.equal(f64[1], 99.0);
  });

  it('handles layout array field (Vec3[4])', () => {
    const mem = new WebAssembly.Memory({ initial: 1 });
    const f64 = new Float64Array(mem.buffer);
    // 4 Vec3s at offset 0: each is 24 bytes (3 f64s)
    // v[0] = (1, 2, 3), v[1] = (4, 5, 6), v[2] = (7, 8, 9), v[3] = (10, 11, 12)
    for (let i = 0; i < 12; i++) f64[i] = i + 1;

    const m = atra({ memory: mem })`
layout Vec3
  x, y, z: f64
end layout

layout Mesh
  vertices: Vec3[4]
  count: i32
end layout

function getVertexX(mesh: layout Mesh, i: i32): f64
var v: layout Vec3
begin
  v := mesh.vertices[i]
  getVertexX := v.x
end

function getVertexZ(mesh: layout Mesh, i: i32): f64
var v: layout Vec3
begin
  v := mesh.vertices[i]
  getVertexZ := v.z
end
`;
    // v[0].x = 1, v[1].x = 4, v[2].x = 7, v[3].x = 10
    assert.equal(m.getVertexX(0, 0), 1.0);
    assert.equal(m.getVertexX(0, 1), 4.0);
    assert.equal(m.getVertexX(0, 2), 7.0);
    assert.equal(m.getVertexX(0, 3), 10.0);
    // v[0].z = 3, v[2].z = 9
    assert.equal(m.getVertexZ(0, 0), 3.0);
    assert.equal(m.getVertexZ(0, 2), 9.0);
  });

  it('i32 array field works', () => {
    const mem = new WebAssembly.Memory({ initial: 1 });
    const i32 = new Int32Array(mem.buffer);
    i32[0] = 10; i32[1] = 20; i32[2] = 30; i32[3] = 40;

    const m = atra({ memory: mem })`
layout IntArray
  data: i32[4]
end layout

function getItem(a: layout IntArray, i: i32): i32
begin
  getItem := a.data[i]
end

subroutine setItem(a: layout IntArray, i: i32, v: i32)
begin
  a.data[i] := v
end
`;
    assert.equal(m.getItem(0, 0), 10);
    assert.equal(m.getItem(0, 3), 40);
    m.setItem(0, 2, 99);
    assert.equal(i32[2], 99);
  });

  it('__layouts metadata includes array field count and elemSize', () => {
    const mem = new WebAssembly.Memory({ initial: 1 });
    const m = atra({ memory: mem })`
layout Particle
  pos: f64[3]
  mass: f64
end layout

function dummy(): i32
begin
  dummy := Particle.__size
end
`;
    assert.ok(m.__layouts);
    assert.ok(m.__layouts.Particle);
    assert.deepStrictEqual(m.__layouts.Particle.pos, { offset: 0, count: 3, elemSize: 8 });
    assert.equal(m.__layouts.Particle.mass, 24);
    assert.equal(m.__layouts.Particle.__size, 32);
  });
});

// ═════════════════════════════════════════════════════════════════════
// __layouts metadata on tagged template result
// ═════════════════════════════════════════════════════════════════════

describe('__layouts metadata', () => {
  it('attaches __layouts to tagged template result', () => {
    const mem = new WebAssembly.Memory({ initial: 1 });
    const m = atra({ memory: mem })`
layout Vec3
  x, y, z: f64
end layout

function dummy(): i32
begin
  dummy := Vec3.__size
end
`;
    assert.ok(m.__layouts);
    assert.ok(m.__layouts.Vec3);
    assert.equal(m.__layouts.Vec3.x, 0);
    assert.equal(m.__layouts.Vec3.y, 8);
    assert.equal(m.__layouts.Vec3.z, 16);
    assert.equal(m.__layouts.Vec3.__size, 24);
    assert.equal(m.__layouts.Vec3.__align, 8);
  });

  it('attaches __layouts via atra.run()', () => {
    const mem = new WebAssembly.Memory({ initial: 1 });
    const m = atra.run(`
layout Vec3
  x, y, z: f64
end layout

function dummy(): i32
begin
  dummy := Vec3.__size
end
`, { memory: mem });
    assert.ok(m.__layouts);
    assert.equal(m.__layouts.Vec3.__size, 24);
  });

  it('no __layouts when no layouts defined', () => {
    const m = atra`
function f(x: f64): f64
begin
  f := x + 1.0
end
`;
    assert.equal(m.__layouts, undefined);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Editor completions for layouts
// ═════════════════════════════════════════════════════════════════════

describe('layout completions', () => {
  const layoutCode = `layout Vec3
  x, y, z: f64
end layout

layout packed Rec
  id: i32
  value: f64
end layout

function f(v:`;

  it('offers layout names in type context', () => {
    const cursor = layoutCode.length;
    const items = atraCompletions(layoutCode, cursor, '');
    const texts = items.map(i => i.text);
    assert.ok(texts.includes('layout'), 'should include layout keyword');
    assert.ok(texts.includes('Vec3'), 'should include Vec3');
    assert.ok(texts.includes('Rec'), 'should include Rec');
    assert.ok(texts.includes('f64'), 'should include primitive types');
  });

  it('offers field names after LayoutName.', () => {
    const code = `layout Vec3\n  x, y, z: f64\nend layout\n`;
    const prefix = 'Vec3.';
    const cursor = code.length + prefix.length;
    const items = atraCompletions(code + prefix, cursor, prefix);
    const texts = items.map(i => i.text);
    assert.ok(texts.includes('Vec3.x'), 'should include Vec3.x');
    assert.ok(texts.includes('Vec3.y'), 'should include Vec3.y');
    assert.ok(texts.includes('Vec3.z'), 'should include Vec3.z');
    assert.ok(texts.includes('Vec3.__size'), 'should include Vec3.__size');
    assert.ok(texts.includes('Vec3.__align'), 'should include Vec3.__align');
  });

  it('includes layout names in expression completions', () => {
    const code = `layout Vec3\n  x, y, z: f64\nend layout\nfunction f(): i32\nbegin\n  f := `;
    const cursor = code.length;
    const items = atraCompletions(code, cursor, '');
    const texts = items.map(i => i.text);
    assert.ok(texts.includes('Vec3'), 'should include Vec3 in expression context');
  });
});
