// Tests for the v0.3 schema + validator + pretty-printer.
//
// Two layers:
//   1. Unit tests for schema helpers (forEachSsaRef, forEachRegion,
//      computeStats) on hand-built sample modules — no parser involved.
//   2. Sweep: lower a bank of representative cells (JS, adder, soft) →
//      run passes → run validateModule → assert no errors. Catches the
//      class of bug where the lowerer emits a malformed op shape that
//      the emitter happens to tolerate today but won't tomorrow.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  OP_SCHEMA,
  forEachSsaRef,
  forEachRegion,
  introducesScope,
  isSideEffecting,
  canBeAsync,
  requiredExtras,
  computeStats,
} from '../ext/air/src/schema.js';

import {
  validateModule,
  validateOrThrow,
  AirValidationError,
} from '../ext/air/src/validate.js';

import { prettyPrint, parseText } from '../ext/air/src/text.js';
import { ScopeChain } from '../ext/air/src/scope.js';

import { lowerJS } from '../ext/air/src/lower/js.js';
import { runPasses, PASSES } from '../ext/air/src/passes.js';
import { Parser, tsPlugin } from '../ext/acorn/acorn.esm.min.js';

const AcornTS = Parser.extend(tsPlugin());

function lowerJsCode(code) {
  const ast = AcornTS.parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  const m = lowerJS(ast, code);
  runPasses(m);
  return m;
}

// =============================================================================
// §1 — Schema integrity
// =============================================================================

describe('schema — integrity', () => {
  it('every op in OP_SCHEMA has the required fields', () => {
    for (const [name, schema] of Object.entries(OP_SCHEMA)) {
      assert.ok(schema.arity === 'fixed' || schema.arity === 'variadic',
        `${name}: arity must be 'fixed' or 'variadic', got ${schema.arity}`);
      assert.ok(schema.result === 'value' || schema.result === 'void',
        `${name}: result must be 'value' or 'void'`);
      assert.equal(typeof schema.side_effecting, 'boolean', `${name}: side_effecting must be boolean`);
      assert.equal(typeof schema.can_be_async, 'boolean', `${name}: can_be_async must be boolean`);
      if (schema.arity === 'fixed') {
        assert.ok(Array.isArray(schema.args), `${name}: fixed arity needs args[]`);
      } else {
        assert.equal(typeof schema.args, 'string', `${name}: variadic needs args string tag`);
      }
    }
  });

  it('async-capable ops are also side-effecting', () => {
    // If you can await mid-computation, the surrounding code observes
    // the suspension — so async implies side-effecting.
    for (const [name, schema] of Object.entries(OP_SCHEMA)) {
      if (schema.can_be_async) {
        assert.ok(schema.side_effecting,
          `${name}: can_be_async without side_effecting is suspicious`);
      }
    }
  });
});

// =============================================================================
// §2 — Schema helpers
// =============================================================================

describe('schema — forEachSsaRef', () => {
  it('finds refs in fixed-arity SSA args (add)', () => {
    const op = { op: 'add', args: ['%1', '%2'], id: '%3' };
    const found = [];
    forEachSsaRef(op, id => found.push(id));
    assert.deepEqual(found, ['%1', '%2']);
  });

  it('skips literal slots in const', () => {
    const op = { op: 'const', args: ['hello'], id: '%0' };
    const found = [];
    forEachSsaRef(op, id => found.push(id));
    assert.deepEqual(found, []);
  });

  it('finds refs inside object_new pair_list (the historical bug)', () => {
    // This is the exact countUses bug from the d937e72 era — values inside
    // object_new are inside { key, id } pairs, not bare ssa strings.
    const op = {
      op: 'object_new',
      args: [{ key: 'x', id: '%5' }, { spread: true, id: '%9' }],
      id: '%10',
    };
    const found = [];
    forEachSsaRef(op, id => found.push(id));
    assert.deepEqual(found, ['%5', '%9']);
  });

  it('finds refs in method_call (skips method name string)', () => {
    const op = { op: 'call_method', args: ['%1', 'push', '%2', '%3'], id: '%4' };
    const found = [];
    forEachSsaRef(op, id => found.push(id));
    assert.deepEqual(found, ['%1', '%2', '%3']);
  });

  it('finds refs in ta_new (skips kind string)', () => {
    const op = { op: 'ta_new', args: ['f64', '%1', '%2'], id: '%3' };
    const found = [];
    forEachSsaRef(op, id => found.push(id));
    assert.deepEqual(found, ['%1', '%2']);
  });

  it('finds the iterable in for_of_region args', () => {
    const op = {
      op: 'for_of_region',
      args: ['%5'],
      target_name: 'i',
      body: [],
      id: '%10',
    };
    const found = [];
    forEachSsaRef(op, id => found.push(id));
    assert.deepEqual(found, ['%5']);
  });

  it('finds phi then_val/else_val refs', () => {
    const op = {
      op: 'if_region',
      args: ['%1'],
      then_body: [],
      else_body: [],
      phis: [
        { var: 'x', then_val: '%2', else_val: '%3' },
        { var: 'y', then_val: '%4', else_val: '%5' },
      ],
      id: '%10',
    };
    const found = new Set();
    forEachSsaRef(op, id => found.add(id));
    assert.deepEqual([...found].sort(), ['%1', '%2', '%3', '%4', '%5']);
  });

  it('does not recurse into region bodies (caller controls traversal)', () => {
    // The body contains an op with refs; forEachSsaRef on the parent must
    // NOT find them — only the direct args/extras/phis. forEachRegion is
    // for descending.
    const op = {
      op: 'if_region',
      args: ['%1'],
      then_body: [{ op: 'add', args: ['%99', '%100'], id: '%50' }],
      else_body: [],
      id: '%10',
    };
    const found = [];
    forEachSsaRef(op, id => found.push(id));
    assert.deepEqual(found, ['%1']);  // %99 and %100 are inside the body
  });
});

describe('schema — forEachRegion', () => {
  it('iterates declared regions', () => {
    const op = {
      op: 'for_region',
      args: [],
      init: [{ op: 'const', args: [0], id: '%1' }],
      test: [{ op: 'lt', args: ['%1', '%2'], id: '%3' }],
      test_val: '%3',
      update: [],
      body: [{ op: 'store', args: ['x', '%1'] }],
      phis: [],
      id: '%10',
    };
    const seen = [];
    forEachRegion(op, (name, ops, scope) => seen.push({ name, count: ops.length, scope }));
    assert.deepEqual(seen, [
      { name: 'init', count: 1, scope: 'loop' },
      { name: 'test', count: 1, scope: 'loop' },
      { name: 'update', count: 0, scope: 'loop' },
      { name: 'body', count: 1, scope: 'loop' },
    ]);
  });

  it('iterates switch case bodies as synthetic regions', () => {
    const op = {
      op: 'switch_region',
      args: ['%1'],
      cases: [
        { test_val: '%2', test_ops: [], body: [{ op: 'break', args: [] }] },
        { test_val: null, test_ops: [], body: [] },  // default
      ],
      id: '%10',
    };
    const seen = [];
    forEachRegion(op, (name, ops) => seen.push({ name, count: ops.length }));
    assert.deepEqual(seen.map(s => s.name), [
      'cases[0].test_ops', 'cases[0].body',
      'cases[1].test_ops', 'cases[1].body',
    ]);
  });
});

describe('schema — predicates', () => {
  it('introducesScope is true for region ops, false for arithmetic', () => {
    assert.equal(introducesScope({ op: 'for_region' }), true);
    assert.equal(introducesScope({ op: 'func_region' }), true);
    assert.equal(introducesScope({ op: 'if_region' }), true);
    assert.equal(introducesScope({ op: 'add' }), false);
    assert.equal(introducesScope({ op: 'const' }), false);
  });

  it('isSideEffecting matches the pure/impure split', () => {
    assert.equal(isSideEffecting({ op: 'add' }), false);
    assert.equal(isSideEffecting({ op: 'const' }), false);
    assert.equal(isSideEffecting({ op: 'array_get' }), false);
    assert.equal(isSideEffecting({ op: 'array_set' }), true);
    assert.equal(isSideEffecting({ op: 'call' }), true);
    assert.equal(isSideEffecting({ op: 'store' }), true);
    assert.equal(isSideEffecting({ op: 'await' }), true);
  });

  it('canBeAsync matches needsAsync expectations', () => {
    assert.equal(canBeAsync({ op: 'await' }), true);
    assert.equal(canBeAsync({ op: 'call' }), true);
    assert.equal(canBeAsync({ op: 'opaque' }), true);
    assert.equal(canBeAsync({ op: 'add' }), false);
    assert.equal(canBeAsync({ op: 'const' }), false);
  });

  it('requiredExtras reports correctly', () => {
    // for_of_region — target_name is REQUIRED (no '?' suffix in schema)
    assert.deepEqual(requiredExtras('for_of_region'), ['target_name']);
    // for_in_region — target_name is OPTIONAL (with '?' suffix)
    assert.deepEqual(requiredExtras('for_in_region'), []);
    // func_region — params is mandatory (every function has a param list,
    // possibly empty); name/ret_type/is_async/is_generator/is_decl are not.
    assert.deepEqual(requiredExtras('func_region'), ['params']);
  });
});

// =============================================================================
// §3 — Validator
// =============================================================================

describe('validator — happy path', () => {
  it('clean module from JS lowerer has no errors', () => {
    const m = lowerJsCode('const x = 1 + 2; const y = x * 3;');
    const errors = validateModule(m);
    assert.deepEqual(errors, [], `unexpected errors:\n${errors.join('\n')}`);
  });

  it('module with for-of has no errors', () => {
    const m = lowerJsCode(`
      const xs = [1, 2, 3];
      let total = 0;
      for (const x of xs) total = total + x;
    `);
    const errors = validateModule(m);
    assert.deepEqual(errors, []);
  });

  it('module with if/else + nested function has no errors', () => {
    const m = lowerJsCode(`
      function f(n) {
        if (n > 0) return n + 1;
        else return -1;
      }
      const r = f(5);
    `);
    const errors = validateModule(m);
    assert.deepEqual(errors, []);
  });

  it('module with object literal has no errors', () => {
    const m = lowerJsCode('const o = { a: 1, b: "x", ...rest };');
    const errors = validateModule(m);
    assert.deepEqual(errors, []);
  });
});

describe('validator — catches bugs', () => {
  it('rejects unknown op', () => {
    const m = { ops: [{ op: 'frobnicate', args: [], id: '%0' }], defines: new Set(), imports: new Set() };
    const errors = validateModule(m);
    assert.ok(errors.some(e => /unknown op/.test(e)));
  });

  it('rejects arity mismatch (unary as binary)', () => {
    const m = { ops: [
      { op: 'const', args: [1], id: '%0' },
      { op: 'add', args: ['%0'], id: '%1' },  // missing rhs
    ], defines: new Set(), imports: new Set() };
    const errors = validateModule(m);
    assert.ok(errors.some(e => /expected 2 args, got 1/.test(e)),
      `expected arity error, got: ${errors.join('\n')}`);
  });

  it('rejects missing required extra (for_of_region without target_name)', () => {
    const m = { ops: [
      { op: 'load', args: ['xs'], id: '%0' },
      { op: 'for_of_region', args: ['%0'], body: [], id: '%1' },  // missing target_name
    ], defines: new Set(), imports: new Set() };
    const errors = validateModule(m);
    assert.ok(errors.some(e => /missing required extra 'target_name'/.test(e)),
      `expected required-extras error, got: ${errors.join('\n')}`);
  });

  it('rejects dangling SSA ref', () => {
    const m = { ops: [
      { op: 'const', args: [1], id: '%0' },
      { op: 'add', args: ['%0', '%99'], id: '%1' },  // %99 doesn't exist
    ], defines: new Set(), imports: new Set() };
    const errors = validateModule(m);
    assert.ok(errors.some(e => /dangling ref %99/.test(e)),
      `expected dangling-ref error, got: ${errors.join('\n')}`);
  });

  it('rejects pair_list with no key/spread', () => {
    const m = { ops: [
      { op: 'const', args: [1], id: '%0' },
      { op: 'object_new', args: [{ id: '%0' }], id: '%1' },  // no key, no spread
    ], defines: new Set(), imports: new Set() };
    const errors = validateModule(m);
    assert.ok(errors.some(e => /missing 'key' or 'spread'/.test(e)));
  });

  it('validateOrThrow includes textual IR in error', () => {
    const m = { ops: [{ op: 'frobnicate', args: [], id: '%0' }], defines: new Set(), imports: new Set() };
    let caught;
    try { validateOrThrow(m, prettyPrint); }
    catch (e) { caught = e; }
    assert.ok(caught instanceof AirValidationError);
    assert.match(caught.message, /unknown op 'frobnicate'/);
    assert.match(caught.message, /IR:/);
    assert.match(caught.message, /module \{/);
  });
});

// =============================================================================
// §4 — Pretty-printer
// =============================================================================

describe('pretty-printer', () => {
  it('renders a simple module', () => {
    const m = lowerJsCode('const x = 1; const y = x + 2;');
    const text = prettyPrint(m);
    assert.match(text, /^module \{/);
    assert.match(text, /\n\}$/);
    assert.match(text, /defines: \[/);
  });

  it('renders region ops with nested blocks', () => {
    const m = lowerJsCode('if (x > 0) { y = 1; } else { y = 2; }');
    const text = prettyPrint(m);
    assert.match(text, /if_region/);
    assert.match(text, /then_body: \[/);
    assert.match(text, /else_body: \[/);
  });

  it('renders for-of with target_name as extra', () => {
    const m = lowerJsCode('for (const x of [1,2,3]) { y = x; }');
    const text = prettyPrint(m);
    assert.match(text, /for_of_region/);
    assert.match(text, /target_name: "x"/);
  });

  it('renders a const op as a single line', () => {
    const m = lowerJsCode('const x = 42;');
    const text = prettyPrint(m);
    assert.match(text, /%\d+ = const 42/);
  });
});

// =============================================================================
// §5 — Coverage stats
// =============================================================================

describe('coverage stats', () => {
  it('counts opCount, opaqueCount, dynCount', () => {
    const m = lowerJsCode('const x: i32 = 1; const y = x + 2;');
    const stats = computeStats(m);
    assert.ok(stats.opCount > 0);
    assert.equal(typeof stats.byKind['add'], 'number');
    assert.equal(stats.opaqueCount, 0);
  });

  it('opaque ops are counted', () => {
    // `with` is the one construct that always opaques in JS lowerer
    let m;
    try {
      m = lowerJsCode('with (Math) { x = sin(0.5); }');
    } catch {
      // some JS strict-mode parsers reject `with` — fall back to a
      // hand-built opaque
      m = { ops: [{ op: 'opaque', args: ['/* test */'], id: '%0' }], defines: new Set(), imports: new Set() };
    }
    const stats = computeStats(m);
    assert.ok(stats.opaqueCount >= 1);
  });
});

// =============================================================================
// §6.6 — ctx.symbols scope-aware tracking (regression for v0.3 step 7)
// =============================================================================

describe('ctx.symbols — function-scope shadowing', () => {
  // Bypass passes — we want to test the lowerer's symbol-table state, not
  // what propagateTypes (which has its own correctly-scoped nameTypes)
  // patches up afterward. The bug surface is the *exported* type for
  // top-level defines: ctx.symbols.get(name) at the end of lowerJS feeds
  // the export type. Under flat Map, an inner-fn shadow clobbered the
  // outer ssa, so the export type came from the inner shadow.
  function lowerOnly(code) {
    const ast = AcornTS.parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
    return lowerJS(ast, code);
  }

  it('top-level export type survives inner-fn shadowing', () => {
    // Spec §2.3 fix. Without push/pop at the function boundary, the
    // inner `const x = "shadowed"` would have left ctx.symbols.get('x')
    // pointing at the inner ssa (with string type), making the exported
    // top-level x appear to be string instead of i32.
    const m = lowerOnly(`
      const x: i32 = 1;
      function f() {
        const x = "shadowed";
        return x;
      }
    `);
    const xExp = m.exports.get('x');
    assert.ok(xExp, 'x should be exported');
    assert.equal(xExp.type.kind, 'i32',
      `expected outer x export type to be i32, got ${xExp.type?.kind}`);
  });

  it('class method body does not leak its locals into outer exports', () => {
    const m = lowerOnly(`
      const flag: bool = true;
      class C {
        m() {
          const flag = "method-local";
          return flag;
        }
      }
    `);
    const flagExp = m.exports.get('flag');
    assert.ok(flagExp);
    assert.equal(flagExp.type.kind, 'bool');
  });

  it('arrow-fn body does not leak locals into outer exports', () => {
    const m = lowerOnly(`
      const z: i32 = 7;
      const f = () => {
        const z = "shadowed";
        return z;
      };
    `);
    assert.equal(m.exports.get('z').type.kind, 'i32');
  });

  it('inner fn locals do not pollute outer defines set', () => {
    const m = lowerOnly(`
      function f() {
        const inner = 42;
        return inner;
      }
    `);
    assert.equal(m.defines.has('inner'), false);
    assert.equal(m.defines.has('f'), true);
  });

  it('for-loop init does not leak to outer scope', () => {
    // for (let i = 0; …) is block-scoped — `i` should not be in outer
    // exports nor clobber an outer-scoped `i`.
    const m = lowerOnly(`
      const i: i32 = 100;
      for (let i = 0; i < 10; i++) {}
    `);
    // Outer i should still be exported as i32 (the for's i didn't clobber it).
    assert.equal(m.exports.get('i').type.kind, 'i32');
  });

  it('catch param does not leak to outer scope', () => {
    const m = lowerOnly(`
      const e: bool = true;
      try { f(); } catch (e) { handle(e); }
    `);
    assert.equal(m.exports.get('e').type.kind, 'bool');
  });

  it('nested block scope does not leak', () => {
    const m = lowerOnly(`
      const x: i32 = 1;
      { const x = "inner"; }
    `);
    // Top-level `const x: i32 = 1` adds x to defines/symbols. The
    // nested `{ const x = ... }` is block-scoped — it should not be in
    // the outer ctx.symbols binding.
    assert.equal(m.exports.get('x').type.kind, 'i32');
  });
});

// =============================================================================
// §6 — Integration: lower → passes → validate, full sweep
// =============================================================================

const SAMPLE_CELLS = [
  // arithmetic
  'const x = 1 + 2 * 3;',
  // typed annotation
  'const x: i32 = 5; const y = x * 2;',
  // string concat
  'const greet = "hello, " + name;',
  // template literal
  'const s = `value=${n}`;',
  // tagged template
  'const s = html`<p>${n}</p>`;',
  // array
  'const xs = [1, 2, 3]; const sum = xs[0] + xs[1] + xs[2];',
  // typed array
  'const buf = new Float64Array(100);',
  // object literal with spread
  'const a = { x: 1 }; const b = { ...a, y: 2 };',
  // function
  'function sq(x) { return x * x; } const r = sq(5);',
  // arrow
  'const sq = x => x * x;',
  // if/else
  'let y = 0; if (x > 0) { y = x; } else { y = -x; }',
  // while
  'let i = 0; while (i < 10) { i = i + 1; }',
  // for
  'for (let i = 0; i < 10; i++) { sum = sum + i; }',
  // for-of
  'for (const x of xs) { total = total + x; }',
  // for-in
  'for (const k in obj) { keys.push(k); }',
  // try/catch/finally
  'try { f(); } catch (e) { console.log(e); } finally { cleanup(); }',
  // class
  'class Point { constructor(x, y) { this.x = x; this.y = y; } sq() { return this.x*this.x + this.y*this.y; } } const p = new Point(3, 4);',
  // labeled
  'outer: for (let i=0; i<10; i++) { if (i===5) break outer; }',
  // switch
  'switch (kind) { case 1: x = 10; break; case 2: x = 20; break; default: x = 0; }',
  // async/await
  'async function f() { return await fetch("x"); }',
  // generator
  'function* range(n) { for (let i=0; i<n; i++) yield i; }',
  // chained =
  'let a, b, c; a = b = c = 5;',
  // unary +
  'const n = +"42";',
  // destructuring
  'const { x, y, ...rest } = obj;',
  'const [a, b, ...rest] = arr;',
  // optional chaining
  'const v = obj?.a?.b?.c;',
  // nullish coalesce
  'const v = a ?? b ?? c;',
];

// =============================================================================
// §6.45 — parseText round-trip
// =============================================================================
//
// We don't require structural identity for the round-trip — pretty-print
// elides ssa-id continuity for inlinable values, omits empty regions,
// and drops some default extras. What we DO require: parse(print(m)) is
// itself a valid module that re-renders to the same text. That's the
// useful round-trip for golden-file testing and on-disk IR snapshots.

describe('parseText round-trip', () => {
  function roundtrip(jsCode) {
    const m = lowerJsCode(jsCode);
    const text1 = prettyPrint(m);
    const m2 = parseText(text1);
    const text2 = prettyPrint(m2);
    return { text1, text2 };
  }

  it('const + add', () => {
    const { text1, text2 } = roundtrip('const x = 1 + 2;');
    assert.equal(text1, text2,
      `round-trip diverged:\n--- pass1 ---\n${text1}\n--- pass2 ---\n${text2}`);
  });

  it('typed annotation', () => {
    const { text1, text2 } = roundtrip('const n: i32 = 42; const r = n * 2;');
    assert.equal(text1, text2);
  });

  it('object literal with spread', () => {
    const { text1, text2 } = roundtrip('const a = { x: 1 }; const b = { ...a, y: 2 };');
    assert.equal(text1, text2);
  });

  it('typed array', () => {
    const { text1, text2 } = roundtrip('const buf = new Float64Array(100);');
    assert.equal(text1, text2);
  });

  it('method call', () => {
    const { text1, text2 } = roundtrip('const xs = []; xs.push(1, 2, 3);');
    assert.equal(text1, text2);
  });

  it('if/else', () => {
    const { text1, text2 } = roundtrip('let y = 0; if (x > 0) { y = 1; } else { y = -1; }');
    assert.equal(text1, text2);
  });

  it('for loop', () => {
    const { text1, text2 } = roundtrip('for (let i = 0; i < 10; i++) { sum = sum + i; }');
    assert.equal(text1, text2);
  });

  it('for-of with target_name', () => {
    const { text1, text2 } = roundtrip('for (const x of xs) { total = total + x; }');
    assert.equal(text1, text2);
  });

  it('rejects unknown ops', () => {
    assert.throws(() => parseText(`module { %0 = frobnicate }`),
      /unknown op 'frobnicate'/);
  });

  it('rejects malformed input', () => {
    assert.throws(() => parseText(`module { %0 = const`),
      /AirParseError|expected/i);
  });
});

// =============================================================================
// §6.5 — ScopeChain
// =============================================================================

describe('ScopeChain', () => {
  it('set/get/has at root', () => {
    const s = new ScopeChain();
    assert.equal(s.has('x'), false);
    assert.equal(s.get('x'), undefined);
    s.set('x', 42);
    assert.equal(s.has('x'), true);
    assert.equal(s.get('x'), 42);
  });

  it('push creates a child whose parent is the original', () => {
    const root = new ScopeChain();
    root.set('x', 1);
    const child = root.push();
    assert.equal(child.parent, root);
    assert.equal(child.has('x'), true);
    assert.equal(child.get('x'), 1);
  });

  it('inner scope shadows outer', () => {
    const root = new ScopeChain();
    root.set('x', 'outer');
    const child = root.push();
    child.set('x', 'inner');
    assert.equal(child.get('x'), 'inner');
    assert.equal(root.get('x'), 'outer');  // parent untouched
  });

  it('pop returns parent', () => {
    const root = new ScopeChain();
    const child = root.push();
    assert.equal(child.pop(), root);
  });

  it('pop on root throws', () => {
    const root = new ScopeChain();
    assert.throws(() => root.pop(), /cannot pop/);
  });

  it('hasInOuter sees ancestors but not self', () => {
    const root = new ScopeChain();
    root.set('x', 1);
    const child = root.push();
    child.set('y', 2);
    assert.equal(child.hasInOuter('x'), true);   // declared in root
    assert.equal(child.hasInOuter('y'), false);  // declared in child only
    assert.equal(child.has('y'), true);
  });

  it('flatten gathers visible bindings with inner-wins', () => {
    const root = new ScopeChain();
    root.set('x', 'outer');
    root.set('z', 'only-outer');
    const child = root.push();
    child.set('x', 'inner');
    child.set('y', 'only-inner');
    const flat = child.flatten();
    assert.equal(flat.get('x'), 'inner');
    assert.equal(flat.get('y'), 'only-inner');
    assert.equal(flat.get('z'), 'only-outer');
  });

  it('depth reports nesting level', () => {
    const root = new ScopeChain();
    assert.equal(root.depth(), 0);
    assert.equal(root.push().depth(), 1);
    assert.equal(root.push().push().push().depth(), 3);
  });

  it('delete walks up the chain to consume', () => {
    const root = new ScopeChain();
    root.set('x', 1);
    const child = root.push();
    assert.equal(child.delete('x'), true);   // found in root, deleted
    assert.equal(child.has('x'), false);
    assert.equal(root.has('x'), false);      // really gone from root
    assert.equal(child.delete('y'), false);  // never bound
  });

  it('delete prefers innermost binding', () => {
    const root = new ScopeChain();
    root.set('x', 'outer');
    const child = root.push();
    child.set('x', 'inner');
    assert.equal(child.delete('x'), true);
    // Inner gone, outer still visible
    assert.equal(child.get('x'), 'outer');
    assert.equal(root.get('x'), 'outer');
  });

  it('falsy values can be bound and retrieved', () => {
    const s = new ScopeChain();
    s.set('a', null);
    s.set('b', 0);
    s.set('c', false);
    s.set('d', undefined);
    assert.equal(s.has('a'), true); assert.equal(s.get('a'), null);
    assert.equal(s.has('b'), true); assert.equal(s.get('b'), 0);
    assert.equal(s.has('c'), true); assert.equal(s.get('c'), false);
    assert.equal(s.has('d'), true); assert.equal(s.get('d'), undefined);
  });
});

// =============================================================================
// §6.7 — PASSES metadata table
// =============================================================================

describe('PASSES metadata table', () => {
  it('every pass has the required fields', () => {
    for (const p of PASSES) {
      assert.equal(typeof p.name, 'string', `pass missing name`);
      assert.equal(typeof p.fn, 'function', `${p.name}: fn must be function`);
      assert.ok(p.iterates === 'once' || p.iterates === 'fixed_point',
        `${p.name}: iterates must be 'once' or 'fixed_point'`);
      assert.ok(Array.isArray(p.requires), `${p.name}: requires must be array`);
      assert.ok(Array.isArray(p.produces), `${p.name}: produces must be array`);
      assert.ok(Array.isArray(p.invalidates), `${p.name}: invalidates must be array`);
    }
  });

  it('the runtime passes match the declared table', () => {
    // Spot-check: runPasses calls each PASSES entry. Smoke + unit tests
    // exercise this end-to-end; this just ensures the table isn't out of
    // sync with what we ship.
    const expectedNames = new Set([
      'propagateTypes', 'foldConstants', 'specializeRuntimeHelpers',
      'insertHints', 'extractDependencies',
    ]);
    const actualNames = new Set(PASSES.map(p => p.name));
    assert.deepEqual(actualNames, expectedNames);
  });

  it('every requires entry is produced by some earlier pass (or is "opts" input)', () => {
    const produced = new Set();
    for (const p of PASSES) {
      for (const r of p.requires) {
        assert.ok(produced.has(r),
          `${p.name}: requires '${r}' but no earlier pass produces it`);
      }
      for (const x of p.produces) produced.add(x);
    }
  });

  it('invalidates entries flag pairs that need re-running', () => {
    // specializeRuntimeHelpers invalidates typeMap; runPasses re-runs
    // propagateTypes after specialize. Asserting the table reflects this
    // catches a desync if someone adds a pass without updating the runner.
    const specialize = PASSES.find(p => p.name === 'specializeRuntimeHelpers');
    assert.ok(specialize);
    assert.ok(specialize.invalidates.includes('typeMap'),
      'specializeRuntimeHelpers must declare it invalidates typeMap');
  });
});

describe('validator — sweep over sample cells', () => {
  for (const code of SAMPLE_CELLS) {
    const head = code.length > 50 ? code.slice(0, 47) + '…' : code;
    it(`clean: ${head}`, () => {
      const m = lowerJsCode(code);
      const errors = validateModule(m);
      assert.deepEqual(errors, [], `unexpected errors on:\n${code}\n\n${errors.join('\n')}`);
    });
  }
});
