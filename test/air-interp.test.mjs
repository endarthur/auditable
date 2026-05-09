// AIR interpreter (v0) tests.
//
// Two layers:
//
// 1. Direct interpreter tests — hand-built AIR ops, exec, assert results.
//    Verifies each op type's runtime semantics in isolation.
//
// 2. Sanity-check vs emit-js — for each cell in the bank, lower → run
//    passes → emit JS via emit-js + execute, AND interpret the AIR
//    directly. Assert results match. Catches divergence between the two
//    execution paths (emit-js bugs surface as mismatches).
//
// The bank deliberately avoids:
//   - Logical operators with side-effecting RHS (`a && f()`) — known
//     divergence: JS lowerer emits flat logical_and, interpreter executes
//     RHS unconditionally. See interp.js header for details.
//   - opaque ops (test cells lower fully)
//   - yield (generators not yet supported)
//   - Class instance fields (not supported in v0)
//   - Adder/Soft specifics — JS-only sanity check for now

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { lowerJS } from '../ext/air/src/lower/js.js';
import { runPasses } from '../ext/air/src/passes.js';
import { emitJS, needsAsync } from '../ext/air/src/emit-js.js';
import { Interpreter, interpret, AirInterpError } from '../ext/air/src/interp.js';
import { Parser, tsPlugin } from '../ext/acorn/acorn.esm.min.js';

const AcornTS = Parser.extend(tsPlugin());

function lowerJsCode(code) {
  const ast = AcornTS.parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  const m = lowerJS(ast, code);
  runPasses(m);
  return m;
}

// Run a cell through emit-js + execute → return the exports map.
// Imports that aren't in `scope` fall through to JS globals (Math,
// console, Array, etc.) so cells that use ambient builtins work.
async function runViaEmit(code, scope = {}) {
  const m = lowerJsCode(code);
  const importNames = [...m.imports];
  const js = emitJS(m, importNames, [], { hinted: false, cellId: 'test' });
  const isAsync = needsAsync(m);
  const FunctionCtor = isAsync
    ? Object.getPrototypeOf(async function(){}).constructor
    : Function;
  const fn = new FunctionCtor(...importNames, js);
  const args = importNames.map(n => (n in scope) ? scope[n] : globalThis[n]);
  const result = await fn(...args);
  return result || {};
}

// Run the same cell through the interpreter → return the exports map.
// The interpreter's `load` op already falls through to globalThis for
// names not in the cell scope, so we don't need to seed globals here.
async function runViaInterp(code, scope = {}) {
  const m = lowerJsCode(code);
  const interp = new Interpreter(m, { scope });
  await interp.run();
  const out = {};
  for (const name of m.defines) {
    if (interp.scope.has(name)) out[name] = interp.scope.get(name);
  }
  return out;
}

// =============================================================================
// §1 — Direct unit tests (hand-built AIR)
// =============================================================================

describe('interp — direct unit tests', () => {
  it('const + add', async () => {
    const m = {
      ops: [
        { id: '%0', op: 'const', args: [3] },
        { id: '%1', op: 'const', args: [4] },
        { id: '%2', op: 'add', args: ['%0', '%1'] },
        { id: '%3', op: 'store', args: ['x', '%2'] },
      ],
      defines: new Set(['x']),
      imports: new Set(),
    };
    const interp = new Interpreter(m);
    await interp.run();
    assert.equal(interp.scope.get('x'), 7);
  });

  it('object_new + array_new', async () => {
    const m = {
      ops: [
        { id: '%0', op: 'const', args: [1] },
        { id: '%1', op: 'const', args: [2] },
        { id: '%2', op: 'object_new', args: [
          { key: 'a', id: '%0' },
          { key: 'b', id: '%1' },
        ]},
        { id: '%3', op: 'array_new', args: ['%0', '%1', '%2'] },
        { id: '%4', op: 'store', args: ['out', '%3'] },
      ],
      defines: new Set(['out']),
      imports: new Set(),
    };
    const interp = new Interpreter(m);
    await interp.run();
    assert.deepEqual(interp.scope.get('out'), [1, 2, { a: 1, b: 2 }]);
  });

  it('opaque throws AirInterpError by default', async () => {
    const m = {
      ops: [{ id: '%0', op: 'opaque', args: ['/* foo */ undefined'] }],
      defines: new Set(),
      imports: new Set(),
    };
    await assert.rejects(
      () => new Interpreter(m).run(),
      AirInterpError,
    );
  });

  it('opaque is eval-ed when allowOpaque is true', async () => {
    const m = {
      ops: [
        { id: '%0', op: 'opaque', args: ['1 + 2'] },
        { id: '%1', op: 'store', args: ['x', '%0'] },
      ],
      defines: new Set(['x']),
      imports: new Set(),
    };
    const interp = new Interpreter(m, { allowOpaque: true });
    await interp.run();
    assert.equal(interp.scope.get('x'), 3);
  });

  it('yield throws (generators unsupported in v0)', async () => {
    const m = {
      ops: [
        { id: '%0', op: 'const', args: [42] },
        { id: '%1', op: 'yield', args: ['%0'] },
      ],
      defines: new Set(),
      imports: new Set(),
    };
    await assert.rejects(() => new Interpreter(m).run(), /yield\/generators not supported/);
  });
});

// =============================================================================
// §2 — Sanity-check bank: emit-js vs interpreter, results must match
// =============================================================================

const BANK = [
  // Arithmetic + literals
  ['const x = 1 + 2 * 3;', { x: 7 }],
  ['const x = 100 / 4;', { x: 25 }],
  ['const x = 2 ** 10;', { x: 1024 }],
  ['const x = -5 + 7;', { x: 2 }],
  ['const x = 17 % 5;', { x: 2 }],

  // Comparisons → bool
  ['const x = 5 > 3;', { x: true }],
  ['const x = 5 === 5;', { x: true }],
  ['const x = 5 !== "5";', { x: true }],

  // Bitwise + shift
  ['const x = 0xff & 0x0f;', { x: 0x0f }],
  ['const x = 1 << 4;', { x: 16 }],
  ['const x = 0xff ^ 0xaa;', { x: 0x55 }],

  // String concat
  ['const x = "hello, " + "world";', { x: 'hello, world' }],
  ['const x = `value=${21 * 2}`;', { x: 'value=42' }],

  // Array + object
  ['const xs = [1, 2, 3]; const total = xs[0] + xs[1] + xs[2];', { xs: [1, 2, 3], total: 6 }],
  ['const o = { a: 1, b: 2 }; const r = o.a + o.b;', { o: { a: 1, b: 2 }, r: 3 }],
  ['const a = { x: 1 }; const b = { ...a, y: 2 };', { a: { x: 1 }, b: { x: 1, y: 2 } }],

  // Typed array
  ['const buf = new Float64Array(4); buf[0] = 3.14; const v = buf[0];', { v: 3.14 }],

  // if/else (pure RHS)
  ['let y; if (5 > 3) { y = "big"; } else { y = "small"; } const r = y;', { y: 'big', r: 'big' }],

  // Ternary (pure)
  ['const y = 5 > 3 ? "big" : "small";', { y: 'big' }],
  ['const z = 0 ? 1 : 2;', { z: 2 }],

  // Logical with PURE rhs (avoids the divergence)
  ['const a = true && false;', { a: false }],
  ['const b = false || 42;', { b: 42 }],
  ['const c = null ?? "default";', { c: 'default' }],
  ['const d = 1 && 2 && 3;', { d: 3 }],

  // For loop
  ['let sum = 0; for (let i = 0; i < 10; i++) sum = sum + i;', { sum: 45 }],

  // For-of
  ['let total = 0; for (const x of [1, 2, 3, 4]) total = total + x;', { total: 10 }],

  // While
  ['let n = 1; let acc = 1; while (n < 6) { acc = acc * n; n = n + 1; }', { n: 6, acc: 120 }],

  // Function declaration + call
  ['function sq(x) { return x * x; } const r = sq(7);', { r: 49 }],

  // Arrow function
  ['const sq = (x) => x * x; const r = sq(8);', { r: 64 }],

  // Closure
  ['function mk(n) { return (k) => n + k; } const add5 = mk(5); const r = add5(3);', { r: 8 }],

  // Recursion
  ['function fib(n) { return n < 2 ? n : fib(n-1) + fib(n-2); } const r = fib(10);', { r: 55 }],

  // Method call
  ['const xs = [1, 2, 3]; xs.push(4); const len = xs.length;', { xs: [1, 2, 3, 4], len: 4 }],

  // Try/catch
  ['let r; try { throw new Error("x"); } catch (e) { r = e.message; }', { r: 'x' }],

  // Try/finally
  ['let log = []; try { log.push(1); } finally { log.push(2); }', { log: [1, 2] }],

  // Class — disabled in v0: `this` falls through to opaque in the JS
  // lowerer (it's a ThisExpression, not handled as a special op). Fixing
  // requires lower/js.js to emit ThisExpression as load('this') and the
  // interpreter to bind scope['this'] in method bodies. Tracked as a
  // post-v0 follow-up. Methods that don't reference `this` work fine.
  // [
  //   'class Point { constructor(x, y) { this.x = x; this.y = y; } norm() { return this.x*this.x + this.y*this.y; } } const p = new Point(3, 4); const n = p.norm();',
  //   { n: 25 },
  // ],

  // Builtins (from globalThis)
  ['const r = Math.sqrt(16);', { r: 4 }],
  ['const r = Math.max(1, 7, 3);', { r: 7 }],
];

describe('interp — sanity check vs emit-js', () => {
  for (const [code, expected] of BANK) {
    const head = code.length > 50 ? code.slice(0, 47) + '…' : code;
    it(head, async () => {
      const emitResult  = await runViaEmit(code);
      const interpResult = await runViaInterp(code);

      // Compare each expected key — both paths must produce the same value
      for (const [key, val] of Object.entries(expected)) {
        assert.deepEqual(emitResult[key], val,
          `emit-js mismatch for ${key}: expected ${JSON.stringify(val)}, got ${JSON.stringify(emitResult[key])}`);
        assert.deepEqual(interpResult[key], val,
          `interp mismatch for ${key}: expected ${JSON.stringify(val)}, got ${JSON.stringify(interpResult[key])}`);
      }
    });
  }
});
