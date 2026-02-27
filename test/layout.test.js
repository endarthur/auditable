import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// shim document for state.js
globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };

const { atra } = await import('../ext/atra/src/atra.js');

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
