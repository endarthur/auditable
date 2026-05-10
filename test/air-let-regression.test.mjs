// Regression tests for two AIR emit-js bugs that masked each other.
//
// Bug 1: findMutableCaptured used hasInOuter, which returned true for any
// outer block — including parent blocks within the same function. So
// `s += ...` inside a `for` block of a function looked like a closure
// capture, and AIR allocated a slot for the local. Slots emit as
// `let s;` at module level — promoting the local to an implicit global,
// killing V8 auto-vectorization (~11× slowdown on hot numeric loops).
//
// Bug 2 (exposed by Bug 1's fix): compound assignment `s += rhs`
// hard-coded the result type to typeOf(s), ignoring rhs. With Bug 1
// hidden, this was harmless because slots typed everything as DYNAMIC.
// With Bug 1 fixed, `let s = 0; s += float * float` typed the add as
// i32 + DYNAMIC = i32, and emit-js wrapped the f64 sum in `| 0`,
// producing wrong results (returns 0 for any non-integer sum).
//
// Bug 3 (exposed by Bug 2's fix): passes.js's add/sub/mul/div case only
// updated op.type when both operands were numeric. If the lowerer set
// op.type to i32 (e.g. `(s0 + s1)` after a for-loop, where stale
// ctx.symbols caused i32 typing), and passes.js later refined the loads
// to DYNAMIC, the add stayed at i32 and got the `| 0` wrap.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Acorn from 'acorn';
import tsPlugin from 'acorn-typescript';
import { analyzeCell } from '../ext/air/src/api.js';
import { emitJS } from '../ext/air/src/emit-js.js';

const Parser = Acorn.Parser.extend(tsPlugin());

function compileViaAir(source, exportName) {
  const result = analyzeCell(source, Parser, new Set());
  const emitted = emitJS(result.air, [], [], { cellId: 'test', cellName: 'reg' });
  // AIR emits its own `return { name1, name2, ... };` at the end — call
  // the wrapper and pluck out the named export.
  const exports = new Function(emitted)();
  return exports[exportName];
}

test('AIR-emitted ddot produces correct f64 result (regression)', () => {
  const source = `
    function ddot(x, y, n) {
      let s = 0;
      for (let i = 0; i < n; i++) s += x[i] * y[i];
      return s;
    }
  `;
  const ddot = compileViaAir(source, 'ddot');
  const n = 100;
  const x = new Float64Array(n), y = new Float64Array(n);
  for (let i = 0; i < n; i++) { x[i] = Math.sin(i * 0.1); y[i] = Math.cos(i * 0.1); }
  let ref = 0;
  for (let i = 0; i < n; i++) ref += x[i] * y[i];
  const got = ddot(x, y, n);
  assert.ok(Math.abs(got - ref) < 1e-12, `ddot mismatch: got ${got}, ref ${ref}`);
});

test('AIR-emitted unrolled-4 ddot produces correct f64 result', () => {
  const source = `
    function ddot_u4(x, y, n) {
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      const n4 = n - (n & 3);
      let i = 0;
      for (; i < n4; i += 4) {
        s0 += x[i  ] * y[i  ];
        s1 += x[i+1] * y[i+1];
        s2 += x[i+2] * y[i+2];
        s3 += x[i+3] * y[i+3];
      }
      let s = (s0 + s1) + (s2 + s3);
      for (; i < n; i++) s += x[i] * y[i];
      return s;
    }
  `;
  const ddot = compileViaAir(source, 'ddot_u4');
  const n = 1000;
  const x = new Float64Array(n), y = new Float64Array(n);
  for (let i = 0; i < n; i++) { x[i] = Math.sin(i * 0.1); y[i] = Math.cos(i * 0.1); }
  let ref = 0;
  for (let i = 0; i < n; i++) ref += x[i] * y[i];
  const got = ddot(x, y, n);
  assert.ok(Math.abs(got - ref) < 1e-9, `ddot_u4 mismatch: got ${got}, ref ${ref}`);
});

test('AIR-emitted code does NOT hoist function-local lets to module scope', () => {
  const source = `
    function f() {
      let local = 0;
      for (let i = 0; i < 10; i++) local += i;
      return local;
    }
  `;
  const result = analyzeCell(source, Parser, new Set());
  const emitted = emitJS(result.air, [], [], { cellId: 'test', cellName: 'hoist-check' });
  // The buggy emitter emitted `let local;` at module scope (before `function f()`).
  // Verify by checking the position of `let local` relative to `function f`.
  const fnIdx = emitted.indexOf('function f');
  const letIdx = emitted.indexOf('let local');
  assert.ok(fnIdx >= 0 && letIdx >= 0, 'expected both `function f` and `let local` in output');
  assert.ok(letIdx > fnIdx,
    'function-local `let local` should appear INSIDE the function body, not before it');
});

test('AIR-emitted code does NOT i32-truncate f64 accumulators', () => {
  // End-to-end check: a sum of fractional values should NOT round to 0.
  // The bug signature was `s = ((s + arr[i]) | 0);` truncating each
  // intermediate sum to int32, producing 0 for any sum < 1.
  const source = `
    function fsum(arr, n) {
      let s = 0;
      for (let i = 0; i < n; i++) s += arr[i];
      return s;
    }
  `;
  const fsum = compileViaAir(source, 'fsum');
  const arr = new Float64Array([0.1, 0.2, 0.3, 0.4]);
  const got = fsum(arr, 4);
  // Reference: 0.1+0.2+0.3+0.4 ≈ 1.0 (with rounding noise)
  assert.ok(Math.abs(got - 1.0) < 1e-9,
    `expected fractional sum ≈ 1.0, got ${got} (suggests i32 truncation)`);
});

test('compound `+=` types correctly when LHS is i32 and RHS is DYNAMIC', () => {
  // Direct test: the bug was that compound assignment hard-coded its result
  // type to typeOf(LHS) without considering RHS.
  const source = `
    function f(dyn) {
      let acc = 0;
      acc += dyn;
      return acc;
    }
  `;
  const result = analyzeCell(source, Parser, new Set());
  // Find the compound-assignment add op inside the function body.
  const fnRegion = result.air.ops.find(op => op.op === 'func_region');
  assert.ok(fnRegion, 'expected func_region op');
  const addOp = fnRegion.body.find(op => op.op === 'add');
  assert.ok(addOp, 'expected add op in body');
  assert.equal(addOp.type.kind, 'dynamic',
    `i32 + DYNAMIC should type as DYNAMIC, got ${JSON.stringify(addOp.type)}`);
});
