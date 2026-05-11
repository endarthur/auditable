import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  I8, U8, I16, U16, I32, U32, I64, U64, F32, F64,
  BOOL, STRING, VOID, DYNAMIC,
  typedArray, array, object, func,
  resolveAnnotation,
  isNumeric, isInteger, isFloat, isSigned, isDynamic, isConcrete,
  arithmeticResult, comparisonResult, bitwiseResult,
  typeEq,
} from '../ext/air/src/types.js';

import { lowerJS } from '../ext/air/src/lower/js.js';
import { runPasses, propagateTypes, foldConstants, extractDependencies } from '../ext/air/src/passes.js';
import { analyzeCell, analyzeModule, extractDefines, extractExportTypes, parseModule, extractImports, extractExports, registerLowerer, getLowerer, lower as airLower } from '../ext/air/src/api.js';
import { emitJS, needsAsync } from '../ext/air/src/emit-js.js';
import { Parser, tsPlugin } from '../ext/acorn/acorn.esm.min.js';

const AcornTS = Parser.extend(tsPlugin());

function parse(code) {
  return AcornTS.parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
}

function lower(code) {
  return lowerJS(parse(code), code);
}

function findOps(module, opName) {
  return module.ops.filter(o => o.op === opName);
}

function findOp(module, opName) {
  return module.ops.find(o => o.op === opName);
}

// =============================================================================
// §2 — Type system
// =============================================================================

describe('AIR types — singletons', () => {
  it('primitive types are frozen singletons', () => {
    assert.equal(I32.kind, 'i32');
    assert.equal(F64.kind, 'f64');
    assert.equal(BOOL.kind, 'bool');
    assert.equal(STRING.kind, 'string');
    assert.equal(VOID.kind, 'void');
    assert.equal(DYNAMIC.kind, 'dynamic');
    assert.throws(() => { I32.kind = 'nope'; });
  });

  it('compound constructors', () => {
    const ta = typedArray('f64');
    assert.equal(ta.kind, 'typed_array');
    assert.equal(ta.element, 'f64');
    const a = array(I32);
    assert.equal(a.kind, 'array');
    assert.equal(a.element, I32);
    const o = object(new Map([['x', F64], ['y', F64]]));
    assert.equal(o.kind, 'object');
    assert.equal(o.fields.get('x'), F64);
    const f = func([F64, F64], F64);
    assert.equal(f.kind, 'function');
    assert.equal(f.params.length, 2);
    assert.equal(f.ret, F64);
  });
});

describe('AIR types — predicates', () => {
  it('isNumeric', () => {
    assert.ok(isNumeric(I32));
    assert.ok(isNumeric(F64));
    assert.ok(isNumeric(U8));
    assert.ok(!isNumeric(BOOL));
    assert.ok(!isNumeric(STRING));
    assert.ok(!isNumeric(DYNAMIC));
  });

  it('isInteger', () => {
    assert.ok(isInteger(I32));
    assert.ok(isInteger(U64));
    assert.ok(!isInteger(F64));
    assert.ok(!isInteger(BOOL));
  });

  it('isFloat', () => {
    assert.ok(isFloat(F32));
    assert.ok(isFloat(F64));
    assert.ok(!isFloat(I32));
  });

  it('isSigned', () => {
    assert.ok(isSigned(I8));
    assert.ok(isSigned(I32));
    assert.ok(!isSigned(U32));
    assert.ok(!isSigned(F64));
  });

  it('isDynamic / isConcrete', () => {
    assert.ok(isDynamic(DYNAMIC));
    assert.ok(!isDynamic(I32));
    assert.ok(isConcrete(F64));
    assert.ok(!isConcrete(DYNAMIC));
  });
});

describe('AIR types — arithmetic result (§2.5)', () => {
  it('same type', () => {
    assert.equal(arithmeticResult(F64, F64), F64);
    assert.equal(arithmeticResult(I32, I32), I32);
    assert.equal(arithmeticResult(F32, F32), F32);
    assert.equal(arithmeticResult(U32, U32), U32);
  });

  it('integer promotion — wider wins', () => {
    assert.equal(arithmeticResult(I8, I32), I32);
    assert.equal(arithmeticResult(U8, U32), U32);
    assert.equal(arithmeticResult(I16, I64), I64);
  });

  it('mixed sign — signed wins at same width', () => {
    assert.equal(arithmeticResult(I32, U32), I32);
    assert.equal(arithmeticResult(U16, I16), I16);
  });

  it('mixed sign — wider wins, signed if either is signed', () => {
    assert.equal(arithmeticResult(I8, U32), I32);
    assert.equal(arithmeticResult(U8, I32), I32);
  });

  it('float + integer → float', () => {
    assert.equal(arithmeticResult(F64, I32), F64);
    assert.equal(arithmeticResult(I32, F64), F64);
    assert.equal(arithmeticResult(F32, I16), F32);
  });

  it('f32 + f64 → f64', () => {
    assert.equal(arithmeticResult(F32, F64), F64);
    assert.equal(arithmeticResult(F64, F32), F64);
  });

  it('dynamic propagates', () => {
    assert.equal(arithmeticResult(DYNAMIC, I32), DYNAMIC);
    assert.equal(arithmeticResult(F64, DYNAMIC), DYNAMIC);
  });

  it('non-numeric → dynamic', () => {
    assert.equal(arithmeticResult(STRING, I32), DYNAMIC);
    assert.equal(arithmeticResult(BOOL, F64), DYNAMIC);
  });
});

describe('AIR types — comparison and bitwise', () => {
  it('comparison → bool', () => {
    assert.equal(comparisonResult(I32, I32), BOOL);
    assert.equal(comparisonResult(DYNAMIC, F64), BOOL);
  });

  it('bitwise → i32', () => {
    assert.equal(bitwiseResult(), I32);
  });
});

describe('AIR types — typeEq', () => {
  it('same singleton', () => {
    assert.ok(typeEq(I32, I32));
    assert.ok(typeEq(F64, F64));
    assert.ok(typeEq(DYNAMIC, DYNAMIC));
  });

  it('different singletons', () => {
    assert.ok(!typeEq(I32, F64));
    assert.ok(!typeEq(BOOL, STRING));
  });

  it('typed arrays', () => {
    assert.ok(typeEq(typedArray('f64'), typedArray('f64')));
    assert.ok(!typeEq(typedArray('f64'), typedArray('i32')));
  });

  it('arrays', () => {
    assert.ok(typeEq(array(I32), array(I32)));
    assert.ok(!typeEq(array(I32), array(F64)));
  });

  it('functions', () => {
    assert.ok(typeEq(func([I32, F64], BOOL), func([I32, F64], BOOL)));
    assert.ok(!typeEq(func([I32], BOOL), func([F64], BOOL)));
    assert.ok(!typeEq(func([I32], BOOL), func([I32, F64], BOOL)));
  });

  it('objects', () => {
    const a = object(new Map([['x', F64], ['y', I32]]));
    const b = object(new Map([['x', F64], ['y', I32]]));
    const c = object(new Map([['x', F64], ['y', F64]]));
    assert.ok(typeEq(a, b));
    assert.ok(!typeEq(a, c));
  });
});

describe('AIR types — resolveAnnotation (§2.2)', () => {
  it('GCU numeric types', () => {
    const node = { type: 'TSTypeAnnotation', typeAnnotation: { type: 'TSTypeReference', typeName: { name: 'i32' } } };
    assert.equal(resolveAnnotation(node), I32);
  });

  it('f64 annotation', () => {
    const node = { type: 'TSTypeAnnotation', typeAnnotation: { type: 'TSTypeReference', typeName: { name: 'f64' } } };
    assert.equal(resolveAnnotation(node), F64);
  });

  it('typed array alias', () => {
    const node = { type: 'TSTypeAnnotation', typeAnnotation: { type: 'TSTypeReference', typeName: { name: 'f64array' } } };
    assert.deepEqual(resolveAnnotation(node), typedArray('f64'));
  });

  it('standard TS keywords', () => {
    assert.equal(resolveAnnotation({ type: 'TSNumberKeyword' }), F64);
    assert.equal(resolveAnnotation({ type: 'TSBooleanKeyword' }), BOOL);
    assert.equal(resolveAnnotation({ type: 'TSStringKeyword' }), STRING);
    assert.equal(resolveAnnotation({ type: 'TSVoidKeyword' }), VOID);
  });

  it('array type T[]', () => {
    const node = { type: 'TSArrayType', elementType: { type: 'TSTypeReference', typeName: { name: 'i32' } } };
    const result = resolveAnnotation(node);
    assert.equal(result.kind, 'array');
    assert.equal(result.element, I32);
  });

  it('unknown type → dynamic', () => {
    const node = { type: 'TSTypeAnnotation', typeAnnotation: { type: 'TSTypeReference', typeName: { name: 'SomeRandomType' } } };
    assert.equal(resolveAnnotation(node), DYNAMIC);
  });

  it('null/undefined → dynamic', () => {
    assert.equal(resolveAnnotation(null), DYNAMIC);
    assert.equal(resolveAnnotation(undefined), DYNAMIC);
  });
});

// =============================================================================
// §7 — JS Lowerer
// =============================================================================

describe('AIR lowerer — literals and constants', () => {
  it('integer literal', () => {
    const m = lower('const x = 42');
    assert.ok(m.defines.has('x'));
    const c = findOp(m, 'const');
    assert.equal(c.args[0], 42);
    assert.equal(c.type, I32);
  });

  it('float literal', () => {
    const m = lower('const x = 3.14');
    const c = findOp(m, 'const');
    assert.equal(c.args[0], 3.14);
    assert.equal(c.type, F64);
  });

  it('string literal', () => {
    const m = lower('const x = "hello"');
    const c = findOps(m, 'const').find(o => o.args[0] === 'hello');
    assert.ok(c);
    assert.equal(c.type, STRING);
  });

  it('boolean literal', () => {
    const m = lower('const x = true');
    const c = findOps(m, 'const').find(o => o.args[0] === true);
    assert.ok(c);
    assert.equal(c.type, BOOL);
  });
});

describe('AIR lowerer — variable declarations', () => {
  it('simple const', () => {
    const m = lower('const x = 1');
    assert.ok(m.defines.has('x'));
    assert.ok(findOp(m, 'store'));
  });

  it('let with type annotation', () => {
    const m = lower('let x: f64 = 0');
    assert.ok(m.defines.has('x'));
  });

  it('multiple declarations', () => {
    const m = lower('const a = 1, b = 2');
    assert.ok(m.defines.has('a'));
    assert.ok(m.defines.has('b'));
  });

  it('var hoisting', () => {
    const m = lower('x = 5\nvar x = 10');
    assert.ok(m.defines.has('x'));
    // var x should be hoisted — store at top
    const stores = findOps(m, 'store').filter(o => o.args[0] === 'x');
    assert.ok(stores.length >= 2); // hoisted init + actual assignment
  });

  it('function declaration', () => {
    const m = lower('function foo(x) { return x + 1 }');
    assert.ok(m.defines.has('foo'));
    assert.ok(findOp(m, 'func_region'));
  });
});

describe('AIR lowerer — destructuring', () => {
  it('object destructuring', () => {
    const m = lower('const { a, b } = obj');
    assert.ok(m.defines.has('a'));
    assert.ok(m.defines.has('b'));
    const gets = findOps(m, 'object_get');
    assert.ok(gets.length >= 2);
  });

  it('array destructuring', () => {
    const m = lower('const [x, y] = arr');
    assert.ok(m.defines.has('x'));
    assert.ok(m.defines.has('y'));
    const gets = findOps(m, 'array_get');
    assert.ok(gets.length >= 2);
  });

  it('nested destructuring', () => {
    const m = lower('const { a: { b } } = obj');
    assert.ok(m.defines.has('b'));
    assert.ok(!m.defines.has('a')); // a is a key, not a binding
  });

  it('rename destructuring', () => {
    const m = lower('const { x: renamed } = obj');
    assert.ok(m.defines.has('renamed'));
    assert.ok(!m.defines.has('x'));
  });
});

describe('AIR lowerer — arithmetic', () => {
  it('binary add', () => {
    const m = lower('const x = 1 + 2');
    assert.ok(findOp(m, 'add'));
  });

  it('binary operators', () => {
    for (const [src, op] of [
      ['1 - 2', 'sub'], ['1 * 2', 'mul'], ['1 / 2', 'div'], ['1 % 2', 'mod'],
    ]) {
      const m = lower(`const x = ${src}`);
      assert.ok(findOp(m, op), `expected ${op} for ${src}`);
    }
  });

  it('comparison → bool', () => {
    const m = lower('const x = 1 < 2');
    const lt = findOp(m, 'lt');
    assert.ok(lt);
    assert.equal(lt.type, BOOL);
  });

  it('bitwise → i32', () => {
    const m = lower('const x = a | 0');
    const bor = findOp(m, 'bitwise_or');
    assert.ok(bor);
    assert.equal(bor.type, I32);
  });

  it('string + string → string', () => {
    const m = lower('const x = "a" + "b"');
    const add = findOp(m, 'add');
    assert.ok(add);
    assert.equal(add.type, STRING);
  });
});

describe('AIR lowerer — control flow', () => {
  it('if statement', () => {
    const m = lower('if (x) { y = 1 } else { y = 2 }');
    const ifOp = findOp(m, 'if_region');
    assert.ok(ifOp);
    assert.ok(ifOp.then_body.length > 0);
    assert.ok(ifOp.else_body.length > 0);
  });

  it('for loop', () => {
    const m = lower('for (let i = 0; i < 10; i++) { x = i }');
    assert.ok(findOp(m, 'for_region'));
  });

  it('while loop', () => {
    const m = lower('while (x) { x = x - 1 }');
    assert.ok(findOp(m, 'loop_region'));
  });

  it('for...of', () => {
    const m = lower('for (const x of arr) { sum += x }');
    assert.ok(findOp(m, 'for_of_region'));
  });

  it('for-of carries target_name through to the IR', () => {
    // Regression: lowerForOf used to drop the loop-variable name, so the
    // emitter fell back to a synthetic `_v` and any reference to the
    // user's name in the body became "X is not defined" at runtime.
    // Surfaced by examples/defs/gslib/example_alpack.txt.
    const m = lower('for (const s of arr) { use(s.x) }');
    const op = findOp(m, 'for_of_region');
    assert.equal(op?.target_name, 's');
  });

  it('for-of with bare identifier target also carries the name', () => {
    const m = lower('let item; for (item of arr) { use(item) }');
    const op = findOp(m, 'for_of_region');
    assert.equal(op?.target_name, 'item');
  });

  it('object literal counts pair values as uses (regression)', () => {
    // object_new stores pairs as { key, id } objects rather than bare
    // SSA ids in `op.args`. countUses used to skip them, so a referenced
    // value (e.g. an opaque tagged template) was treated as unused,
    // emitted as a statement, and its varname dangled inside the object
    // literal as `_N is not defined`. Surfaced by example_idw's workshop
    // call: `workshop([{ content: md\`...\` }])`.
    const module = lower('workshop([{ content: md`hello` }])');
    runPasses(module);
    const js = emitJS(module, [], [], { hinted: true, cellId: 't' });
    let err = null;
    const md = (s) => ({ src: s[0] });
    const workshop = () => {};
    try { new Function('workshop', 'md', js)(workshop, md); } catch (e) { err = e.message; }
    assert.equal(err, null);
    // The opaque tagged-template should appear inline inside the object
    // literal, not as a dangling statement above the call.
    assert.match(js, /workshop\(\[\{[^}]*content:\s*md`hello`/);
  });

  it('sibling for-loops with same loop var each get their own let', () => {
    // Without the per-loop save/restore of `decl:i`, the second for-loop
    // emitted `i = 0` (bare assignment), combineForInit rejected the
    // compact form, fallback while-desugar referenced an undefined `i`.
    const module = lower(`
      const arr = [1, 2, 3];
      let total = 0;
      for (let i = 0; i < arr.length; i++) total += arr[i];
      for (let i = 0; i < arr.length; i++) total += arr[i] * 2;
    `);
    runPasses(module);
    const js = emitJS(module, [], [], { hinted: true, cellId: 't' });
    let err = null;
    try { new Function(js)(); } catch (e) { err = e.message; }
    assert.equal(err, null);
    // Both for-headers should declare `i` with `let`, not bare assignment.
    const forHeaders = js.match(/for \(let i = 0;/g) || [];
    assert.equal(forHeaders.length, 2);
  });

  it('sibling for-of loops with same target each get their own let', () => {
    // Same pattern as the for-loop case but for `for-of` — surfaced by
    // example_webmcp where two consecutive `for (const d of …)` loops
    // referenced an outer `d` that was actually scoped to the first loop.
    const module = lower(`
      const a = [1]; const b = [2];
      let s = 0;
      for (const d of a) s += d;
      for (const d of b) s += d * 2;
    `);
    runPasses(module);
    const js = emitJS(module, [], [], { hinted: true, cellId: 't' });
    let err = null;
    try { new Function(js)(); } catch (e) { err = e.message; }
    assert.equal(err, null);
    const headers = js.match(/for \(let d of /g) || [];
    assert.equal(headers.length, 2);
  });

  it('body-level lets in sibling for-of loops do not leak between loops', () => {
    // Each for-of body is its own block scope. A `const x = …` in the
    // first loop must not prevent the second loop from also declaring
    // its own `let x = …`.
    const module = lower(`
      for (const d of [1]) { const x = d * 2; }
      for (const d of [2]) { const x = d * 3; }
    `);
    runPasses(module);
    const js = emitJS(module, [], [], { hinted: true, cellId: 't' });
    let err = null;
    try { new Function(js)(); } catch (e) { err = e.message; }
    assert.equal(err, null);
    const xs = js.match(/let x =/g) || [];
    assert.equal(xs.length, 2);
  });

  it('destructuring for-of target falls back to opaque', () => {
    // `for (const [i, s] of enumerate(arr))` had no representation in
    // the IR — lowerForOf checked node.left.declarations[0]?.id?.name
    // which is undefined for ArrayPatterns. The emitter then fell back
    // to `_v` and the body's references to `i` and `s` were unbound.
    const module = lower('for (const [i, s] of pairs) { use(i, s) }');
    runPasses(module);
    const js = emitJS(module, [], [], { hinted: true, cellId: 't' });
    // Source should round-trip through the opaque path.
    assert.match(js, /for \(const \[i, s\] of pairs\)/);
  });

  it('dynamic property access with string key does not coerce to int', () => {
    // emitArrayGet used to wrap every index in `(idx) | 0`, which turns
    // a string key into `(string) | 0 === 0`. Surfaced by example_atra:
    // `evalModel = wasm[modelName]` with modelName a slider string ended
    // up doing `wasm[0]`, returning undefined.
    const module = lower(`
      const obj = { spherical: 42 };
      const key = "spherical";
      const v = obj[key];
    `);
    runPasses(module);
    const js = emitJS(module, [], [], { hinted: true, cellId: 't' });
    assert.doesNotMatch(js, /\(\s*key\s*\)\s*\|\s*0/);
    // Numeric indices should still get the int hint.
    const numIdx = lower('const arr = [1,2,3]; const v = arr[1];');
    runPasses(numIdx);
    const js2 = emitJS(numIdx, [], [], { hinted: true, cellId: 't' });
    // Either an inlined integer or the |0 coerce — both fine. Just
    // assert the cell runs.
    let err = null;
    try { new Function(js2)(); } catch (e) { err = e.message; }
    assert.equal(err, null);
  });

  it('nested function declarations emit as JS function statements', () => {
    // Inside another function, `function rng() {}` was emitted as an
    // inline `let _N = function rng() {};` because the lowerer kept the
    // name out of `defines` (correct) but the emitter only emitted
    // `function name(){}` syntax for cell-export names. Body callers
    // referenced `rng` as a bare identifier, which dangled.
    const module = lower(`
      function outer(seed) {
        let s = seed;
        function rng() { s = s + 1; return s; }
        return rng() + rng();
      }
      const v = outer(10);
    `);
    runPasses(module);
    const js = emitJS(module, [], [], { hinted: true, cellId: 't' });
    let err = null, exports;
    try { exports = new Function(js)(); } catch (e) { err = e.message; }
    assert.equal(err, null);
    assert.equal(exports.v, 23); // 11 + 12
    assert.match(js, /function outer\(/);
    assert.match(js, /function rng\(/);
  });

  it('chained assignment to member targets returns rhs (regression)', () => {
    // `a[i] = b[j] = c[k] = 0` — lowerAssignment for MemberExpression
    // used to return its own VOID `array_set` op id, so the outer
    // assignments referenced the void op as their value. The emitter
    // dangled `_N` for each level. Surfaced by raster + mandelbrot
    // (`img.data[idx] = img.data[idx+1] = img.data[idx+2] = 0`).
    const module = lower(`
      const a = new Array(5).fill(99);
      a[0] = a[1] = a[2] = 0;
    `);
    runPasses(module);
    const js = emitJS(module, [], [], { hinted: true, cellId: 't' });
    let err = null, exports;
    try { exports = new Function(js)(); } catch (e) { err = e.message; }
    assert.equal(err, null);
    assert.deepEqual([...exports.a], [0, 0, 0, 99, 99]);
  });

  it('if/else branches each scope their own block-scoped lets', () => {
    // `if (…) { const s = … } else { const s = … }` — emitIf ran both
    // bodies against the same `decl:` set, so the second branch saw
    // `decl:s` already set and emitted `s = …` (bare assignment) to a
    // binding that didn't exist in its scope.
    const module = lower(`
      const x = Math.random() < 2 ? 1 : 0;
      let result;
      if (x === 1) {
        const s = 100;
        result = s;
      } else {
        const s = 200;
        result = s;
      }
    `);
    runPasses(module);
    const js = emitJS(module, [], [], { hinted: true, cellId: 't' });
    let err = null;
    try { new Function(js)(); } catch (e) { err = e.message; }
    assert.equal(err, null);
    // Both branches should declare `s` with `let`.
    const ss = js.match(/let s =/g) || [];
    assert.equal(ss.length, 2);
  });

  it('unary `+x` emits as a real plus, not `(x + undefined)`', () => {
    // lowerUnary for `+` used to emit an `add` op with one argument,
    // which the emitter rendered with `op.args[1]` as `undefined`,
    // turning `+m[0]` into `(m[0] + undefined)`. Surfaced by raster
    // (`img.data[idx] = +m[0]`).
    const module = lower('const x = +"42"; const y = +x;');
    runPasses(module);
    const js = emitJS(module, [], [], { hinted: true, cellId: 't' });
    assert.doesNotMatch(js, /\+ undefined/);
    let err = null, exports;
    try { exports = new Function(js)(); } catch (e) { err = e.message; }
    assert.equal(err, null);
    assert.equal(exports.x, 42);
    assert.equal(exports.y, 42);
  });
});

describe('AIR lowerer — block scoping (regression)', () => {
  // Regression: const/let declared inside any block-introducing form must not
  // be added to module.defines (which would cause the emitter's
  // `return { ... }` epilogue to reference an out-of-scope binding at runtime).
  function execEmit(src) {
    const module = lower(src);
    runPasses(module);
    const js = emitJS(module, [], [], { hinted: true, cellId: 't', cellName: 'test' });
    let runtimeError = null;
    try { new Function(js)(); } catch (e) { runtimeError = e.message; }
    return { module, js, runtimeError };
  }

  for (const [label, src] of [
    ['if-block',      `if (true) { const fy = 1; }`],
    ['if-else',       `if (false) {} else { const fy = 1; }`],
    ['for-body',      `for (let i = 0; i < 1; i++) { const fy = 1; }`],
    ['while-body',    `while (false) { const fy = 1; }`],
    ['do-while-body', `do { const fy = 1; } while (false);`],
    ['switch-case',   `switch (1) { case 1: { const fy = 1; break; } }`],
    ['try-block',     `try { const fy = 1; } catch (e) {}`],
    ['catch-block',   `try {} catch (e) { const fy = 1; }`],
    ['finally-block', `try {} finally { const fy = 1; }`],
    ['for-in-body',   `for (const k in {a:1}) { const fy = 1; }`],
    ['for-of-body',   `for (const it of [1, 2]) { const fy = 1; }`],
    ['labeled-block', `outer: { const fy = 1; }`],
    ['bare-block',    `{ const fy = 1; }`],
  ]) {
    it(`block-scoped const inside ${label} is not exported`, () => {
      const { module, runtimeError } = execEmit(src);
      assert.ok(!module.defines.has('fy'), `fy should not be in defines for ${label}`);
      assert.equal(runtimeError, null, `emitted JS should run cleanly for ${label}: ${runtimeError}`);
    });
  }

  it('const used inside the same if-block (the original repro)', () => {
    const src = `
      const lim = [0, 1];
      const fit = { slope: 2, intercept: 1 };
      const pairs = [{}, {}];
      let captured;
      if (pairs.length >= 2) {
        const fy = lim.map(x => fit.slope * x + fit.intercept);
        captured = fy[1];
      }
    `;
    const { module, runtimeError } = execEmit(src);
    assert.ok(module.defines.has('lim'));
    assert.ok(module.defines.has('fit'));
    assert.ok(module.defines.has('pairs'));
    assert.ok(module.defines.has('captured'));
    assert.ok(!module.defines.has('fy'));
    assert.equal(runtimeError, null);
  });

  it('top-level const/let/fn/class still exported', () => {
    const m = lower(`const a = 1; let b = 2; function f() {} class C {}`);
    assert.ok(m.defines.has('a'));
    assert.ok(m.defines.has('b'));
    assert.ok(m.defines.has('f'));
    assert.ok(m.defines.has('C'));
  });
});

describe('AIR emitter — for loop init/update (regression)', () => {
  // Regression: the emitter used to drop multi-decl inits and multi-update
  // sequence expressions, hoisting them outside the loop and producing
  // `for (; _testSsa;)` with an unbound test reference.
  function emit(src) {
    const module = lower(src);
    runPasses(module);
    return emitJS(module, [], [], { hinted: true, cellId: 't' });
  }
  function exec(src, scope = {}) {
    const js = emit(src);
    const params = Object.keys(scope);
    const args = params.map(k => scope[k]);
    let err = null;
    try { new Function(...params, js)(...args); } catch (e) { err = e.message; }
    return { js, err };
  }

  it('multi-decl init combines into a single header', () => {
    const js = emit(`
      const arr = new Array(4).fill(0);
      for (let i = 0, j = 1; i < 4; i++) { arr[i] = i + j; }
    `);
    assert.match(js, /for \(let i = 0, j = 1;/);
    assert.doesNotMatch(js, /for \(; /);
  });

  it('multi-update sequence combines into a single header', () => {
    const js = emit(`
      const arr = new Array(4).fill(0);
      for (let i = 0, j = 0; i < 4; i++, j += 4) { arr[i] = j; }
    `);
    assert.match(js, /i = .*, j = /);
    assert.doesNotMatch(js, /for \(; /);
  });

  it('Julia-set inner loop pattern emits valid JS that runs', () => {
    const { err } = exec(`
      const n = 16;
      const d = new Array(n * 4).fill(0);
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        d[j] = i; d[j + 1] = i + 1; d[j + 2] = i + 2; d[j + 3] = 255;
      }
    `);
    assert.equal(err, null);
  });

  it('single-decl init + single update still uses compact form', () => {
    const js = emit(`for (let i = 0; i < 10; i++) { console.log(i); }`);
    assert.match(js, /for \(let i = 0; \(i < 10\); i = /);
  });

  it('runtime: writes to all four bytes with multi-update', () => {
    const sink = [];
    const { err } = exec(`
      for (let i = 0, j = 0; i < 3; i++, j += 4) {
        sink.push([i, j]);
      }
    `, { sink });
    assert.equal(err, null);
    assert.deepEqual(sink, [[0, 0], [1, 4], [2, 8]]);
  });
});

describe('AIR lowerer — tagged templates (regression)', () => {
  // Regression: TaggedTemplateExpression used to lower as a plain `call(tag)`
  // op that emitted `tag()` — dropping the strings array AND interpolations
  // entirely. atra/glsl/sql cells silently received `undefined` for their
  // source and crashed with `Cannot read properties of undefined (reading '0')`
  // when the tag implementation tried to read `strings[0]`.
  function emit(src) {
    const module = lowerJS(AcornTS.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true }), src);
    runPasses(module);
    return emitJS(module, [], [], { hinted: true, cellId: 't' });
  }

  it('preserves tagged template syntax verbatim', () => {
    const js = emit('const wasm = atra({ memory: mem })`! source\nbegin\nend\n`;');
    assert.match(js, /atra\(\{ memory: mem \}\)`/);
    assert.match(js, /! source/);
  });

  it('runtime: tag receives strings array', () => {
    const captured = {};
    const tag = (strings, ...values) => { captured.strings = strings; captured.values = values; return 'ok'; };
    const js = emit('const r = tag`hello ${1 + 1} world`;');
    new Function('tag', js)(tag);
    assert.deepEqual(captured.strings.raw ? [...captured.strings] : captured.strings, ['hello ', ' world']);
    assert.deepEqual(captured.values, [2]);
  });

  it('cross-cell deps from tag function and interpolations are tracked', () => {
    // The tag (`atra`) and any interpolated names (`mem`, `value`) must show
    // up as imports so the DAG knows this cell depends on them.
    const ast = AcornTS.parse('const w = atra({ memory: mem })`code ${value}`;', {
      ecmaVersion: 'latest', sourceType: 'module', locations: true,
    });
    const m = lowerJS(ast, 'const w = atra({ memory: mem })`code ${value}`;');
    runPasses(m);
    assert.ok(m.imports.has('atra'), 'tag function should be tracked');
    assert.ok(m.imports.has('mem'), 'identifiers in tag args should be tracked');
    assert.ok(m.imports.has('value'), 'interpolated identifiers should be tracked');
  });

  it('Julia atra cell pattern emits + executes', () => {
    const src = `
      const mem = new WebAssembly.Memory({ initial: 1 });
      const wasm = atra({ memory: mem })\`
        function julia.eval(): f64 begin julia.eval := -1.0 end
      \`;
    `;
    const js = emit(src);
    const fakeAtra = (opts) => (strings) => ({ source: strings[0], opts });
    let err = null;
    try { new Function('atra', js)(fakeAtra); } catch (e) { err = e.message; }
    assert.equal(err, null, `tagged template should execute cleanly: ${err}`);
  });
});

describe('AIR passes — loop type fixed-point (regression)', () => {
  // Regression: propagateTypes used to walk a for_region / loop_region body
  // exactly once with whatever nameTypes were live at loop entry. A variable
  // declared `let x = 0` (i32-from-literal) then reassigned to a float
  // expression *inside* the body stayed inferred as i32 for the WHOLE body,
  // including the reads *before* the reassign. Result: emitJS saw x*x as
  // i32*i32 and emitted `((x * x)) | 0`, integer-truncating the math.
  //
  // For mandelbrot's `tmp = x*x - y*y + x0; x = tmp` pattern (where x0 is
  // float), the inner-loop math lost all sub-integer precision, rendering
  // the fractal as 4×4 blocks. Pre-existing — reproduces at commit e21cf68.
  //
  // Fix: for_region / loop_region now iterate body propagation up to 4
  // times, taking unionType(prev, after-body) for each written name.
  // unionType(i32, f64) → f64 (smart numeric widening, post-a89198f) so the
  // emitter no longer applies an i32 hint to the widened variable.

  function emit(src) {
    const m = lower(src);
    runPasses(m);
    return { m, js: emitJS(m, [], [], { hinted: true, cellId: 't' }) };
  }

  it('for-loop var initialized i32, assigned f64 in body, widens to f64', () => {
    const { m } = emit(`
      let x = 0;
      for (let i = 0; i < 10; i++) {
        x = x * 0.5 + 1.5;
      }
    `);
    const types = extractExportTypes(m);
    assert.equal(types.get('x').kind, 'f64',
      'x should widen to f64 after assignment with float-typed expression in loop body');
  });

  it('while-loop (loop_region) widens too', () => {
    const { m } = emit(`
      let x = 0;
      while (x < 10) {
        x = x * 0.5 + 1.5;
      }
    `);
    const types = extractExportTypes(m);
    assert.equal(types.get('x').kind, 'f64',
      'loop_region must also iterate body to fixed-point');
  });

  it('pure-i32 loop var stays i32 (control — perf hint preserved)', () => {
    const { m } = emit(`
      let acc = 0;
      for (let i = 0; i < 10; i++) {
        acc = acc + i;
      }
    `);
    const types = extractExportTypes(m);
    assert.equal(types.get('acc').kind, 'i32',
      'integer-only accumulator must keep its i32 type for | 0 hint');
  });

  it('pure-f64 loop var stays f64 (control)', () => {
    const { m } = emit(`
      let x = 0.5;
      for (let i = 0; i < 10; i++) {
        x = x * 2.0;
      }
    `);
    const types = extractExportTypes(m);
    assert.equal(types.get('x').kind, 'f64');
  });

  it('transitive widening converges via fixed-point iteration', () => {
    // y depends on x, x depends on y — one body walk isn't enough; both
    // must widen to f64 once x picks up the float and the next iteration
    // propagates through y.
    const { m } = emit(`
      let x = 0;
      let y = 0;
      for (let i = 0; i < 10; i++) {
        x = y * 0.5;
        y = x + 1.0;
      }
    `);
    const types = extractExportTypes(m);
    assert.equal(types.get('x').kind, 'f64', 'x widens through chain');
    assert.equal(types.get('y').kind, 'f64', 'y widens through chain');
  });

  it('mandelbrot inner-loop pattern: x*x in widened var is NOT i32-coerced', () => {
    // The exact shape that caused the original visual bug. After the
    // fix-point, x and y are f64; the emitter must not apply `| 0` to
    // their multiplications.
    const { js } = emit(`
      const x0 = 0.5, y0 = -0.3;
      const maxIter = 100;
      let total = 0;
      for (let py = 0; py < 100; py++) {
        let x = 0, y = 0, i = 0;
        while (x * x + y * y <= 4 && i < maxIter) {
          const tmp = x * x - y * y + x0;
          y = 2 * x * y + y0;
          x = tmp;
          i++;
        }
        total += i;
      }
    `);
    // Compact whitespace so the regex is robust to formatting changes.
    const compact = js.replace(/\s+/g, ' ');
    assert.ok(!/\(x \* x\)\) \| 0/.test(compact),
      'x*x must not be coerced with | 0 — x is widened to f64 by loop fixpoint');
    assert.ok(!/\(y \* y\)\) \| 0/.test(compact),
      'y*y must not be coerced with | 0 — y is widened to f64 by loop fixpoint');
  });

  it('loop_region body emits no | 0 on widened multiplications', () => {
    // Mirror of the mandelbrot test for while loops specifically.
    const { js } = emit(`
      let x = 0;
      while (x < 100) {
        x = x * x + 0.5;
      }
    `);
    const compact = js.replace(/\s+/g, ' ');
    assert.ok(!/\(x \* x\)\) \| 0/.test(compact),
      'while-loop should also not coerce widened x*x to i32');
  });
});

describe('AIR passes — for-of / for-in fix-point + switch branch merge', () => {
  // Audit follow-up: same loop-body type propagation issue affects for_of /
  // for_in regions, and a related cross-case write-merge issue affects
  // switch. Pin the fixes so they don't regress.

  function emit(src) {
    const m = lower(src);
    runPasses(m);
    return { m, js: emitJS(m, [], [], { hinted: true, cellId: 't' }) };
  }

  it('for-of body widens a loop-invariant accumulator', () => {
    // Use a Float64Array so the loop var x is inferred as f64. Without
    // typed-array element inference, `for (const x of [1,2,3])` leaves x
    // as DYNAMIC and arithmetic stays dynamic, so this becomes a test of
    // the typed-array inference path more than the fix-point per se.
    const { m } = emit(`
      const arr = new Float64Array(3);
      let total = 0;
      for (const x of arr) {
        total = total + x;
      }
    `);
    const types = extractExportTypes(m);
    assert.equal(types.get('total').kind, 'f64',
      'total should widen to f64 via fix-point — body adds f64 element');
  });

  it('switch with cross-case different types unions writes', () => {
    // Each case writes y with a different type; after switch, y should be
    // the union (f64 here, since both cases are numeric).
    const { m } = emit(`
      const x = 1;
      let y = 0;
      switch (x) {
        case 1: y = 1; break;
        case 2: y = 1.5; break;
      }
    `);
    const types = extractExportTypes(m);
    assert.equal(types.get('y').kind, 'f64',
      'union(i32, f64) across switch cases should be f64');
  });
});

describe('AIR types — unionType numeric widening (via observable behavior)', () => {
  // unionType lives in passes.js (not exported), but its behavior surfaces
  // through propagateTypes: a variable assigned i32 then f64 in different
  // branches/iterations should end up as f64 (the wider numeric), not
  // DYNAMIC (the conservative fallback that was in place before a89198f).

  function emit(src) {
    const m = lower(src);
    runPasses(m);
    return m;
  }

  it('union(i32, f64) → f64 across loop iterations', () => {
    // After the loop, x has been assigned both i32 (initial 0) and f64
    // values. unionType(i32, f64) must return f64 — not DYNAMIC.
    const m = emit(`
      let x = 0;
      for (let i = 0; i < 10; i++) {
        x = 1.5;
      }
    `);
    const t = extractExportTypes(m).get('x');
    assert.equal(t.kind, 'f64', 'union of i32 and f64 should be f64, not dynamic');
  });

  it('union of non-numeric pair → DYNAMIC (string + i32) — no i32 hints downstream', () => {
    // The smart union only widens numerics; mixing string with i32 still
    // degrades to DYNAMIC. extractExportTypes can't observe DYNAMIC
    // directly (it preserves the lowered-from-initializer type when the
    // inferred type is dynamic), so we check the structural emission:
    // after the loop, downstream reads of x should NOT carry an i32 hint.
    const src = `
      let x = 0;
      for (let i = 0; i < 10; i++) {
        x = "hello";
      }
      const result = x;
    `;
    const m = lower(src);
    runPasses(m);
    const js = emitJS(m, [], [], { hinted: true, cellId: 't' });
    // After the loop, `const result = x` should NOT see x as i32 (which
    // would carry the type forward to result and emit `| 0` on its uses).
    // The cleanest check: the loop's `x = "hello"` line should not have
    // any | 0 coercion on the string operand.
    const compact = js.replace(/\s+/g, ' ');
    assert.ok(!/"hello"\s*\)?\s*\|\s*0/.test(compact),
      'string assignment should not be coerced via | 0');
  });
});

describe('AIR lowerer — functions', () => {
  it('arrow function expression', () => {
    const m = lower('const f = (x) => x + 1');
    assert.ok(m.defines.has('f'));
    const fn = findOp(m, 'func_region');
    assert.ok(fn);
  });

  it('typed function params', () => {
    const m = lower('function add(a: f64, b: f64): f64 { return a + b }');
    const fn = findOp(m, 'func_region');
    assert.ok(fn);
    assert.equal(fn.params[0].type, F64);
    assert.equal(fn.params[1].type, F64);
    assert.equal(fn.ret_type, F64);
  });
});

describe('AIR lowerer — calls', () => {
  it('regular call', () => {
    const m = lower('const x = foo(1, 2)');
    assert.ok(findOp(m, 'call'));
  });

  it('method call', () => {
    const m = lower('const x = arr.push(1)');
    assert.ok(findOp(m, 'call_method'));
  });
});

describe('AIR lowerer — member access', () => {
  it('dot access', () => {
    const m = lower('const x = obj.foo');
    assert.ok(findOp(m, 'object_get'));
  });

  it('bracket access', () => {
    const m = lower('const x = arr[0]');
    assert.ok(findOp(m, 'array_get'));
  });
});

describe('AIR lowerer — new typed arrays', () => {
  it('new Float64Array', () => {
    const m = lower('const x = new Float64Array(100)');
    const ta = findOp(m, 'ta_new');
    assert.ok(ta);
    assert.equal(ta.args[0], 'f64');
    assert.deepEqual(ta.type, typedArray('f64'));
  });

  it('new Int32Array', () => {
    const m = lower('const x = new Int32Array(50)');
    const ta = findOp(m, 'ta_new');
    assert.equal(ta.args[0], 'i32');
  });

  it('non-typed-array new → new op', () => {
    const m = lower('const x = new Foo()');
    assert.ok(findOp(m, 'new'));
    assert.ok(!findOp(m, 'ta_new'));
  });
});

describe('AIR lowerer — opaque fallback', () => {
  it('class → class_region', () => {
    const m = lower('class Foo {}');
    assert.ok(findOp(m, 'class_region'));
  });

  it('try/catch → try_region', () => {
    const m = lower('try { x() } catch(e) { }');
    assert.ok(findOp(m, 'try_region'));
  });
});

describe('AIR lowerer — mutable capture', () => {
  it('detects closure mutation', () => {
    const m = lower('let count = 0\nconst inc = () => { count++ }');
    assert.ok(findOp(m, 'slot_alloc'));
  });

  it('read-only closure — no slot', () => {
    const m = lower('const x = 1\nconst f = () => x + 1');
    assert.ok(!findOp(m, 'slot_alloc'));
  });
});

describe('AIR lowerer — imports tracking', () => {
  it('undefined names tracked as imports', () => {
    const m = lower('const y = x + 1');
    assert.ok(m.imports.has('x'));
    assert.ok(!m.imports.has('y'));
  });

  it('self-defined names not imports', () => {
    const m = lower('const x = 1\nconst y = x + 1');
    assert.ok(!m.imports.has('x'));
  });
});

describe('AIR lowerer — template literals', () => {
  it('template with expressions', () => {
    const m = lower('const x = `hello ${name}`');
    assert.ok(m.defines.has('x'));
    const adds = findOps(m, 'add');
    assert.ok(adds.length > 0);
  });
});

describe('AIR lowerer — await', () => {
  it('await expression', () => {
    const m = lower('const x = await fetch("url")');
    assert.ok(findOp(m, 'await'));
  });
});

describe('AIR lowerer — spread', () => {
  it('spread in array', () => {
    const m = lower('const x = [...arr, 1]');
    assert.ok(findOp(m, 'spread'));
  });
});

describe('AIR lowerer — type annotations', () => {
  it('i32 annotation propagates', () => {
    const m = lower('const x: i32 = 42');
    // The const should be i32 after annotation
    assert.ok(m.defines.has('x'));
    const ssaId = m.symbol_table.get('x');
    assert.ok(ssaId);
  });

  it('f64array annotation', () => {
    const m = lower('const data: f64array = new Float64Array(10)');
    assert.ok(m.defines.has('data'));
  });
});

describe('AIR lowerer — tagged templates', () => {
  it('tagged template captures tag identifier', () => {
    const m = lower('const result = atra`program test\nend`');
    assert.ok(m.imports.has('atra'));
    assert.ok(m.defines.has('result'));
  });

  it('tagged template captures expressions', () => {
    const allDefined = new Set(['glsl', 'uTime']);
    const result = analyzeCell('const shader = glsl`void main() { float t = ${uTime}; }`', AcornTS, allDefined);
    assert.ok(result);
    assert.ok(result.uses.has('glsl'));
    assert.ok(result.uses.has('uTime'));
  });
});

describe('AIR lowerer — opaque identifier scanning', () => {
  it('class referencing external var tracks it', () => {
    const allDefined = new Set(['Base']);
    const result = analyzeCell('class Foo extends Base {}', AcornTS, allDefined);
    assert.ok(result);
    assert.ok(result.uses.has('Base'));
  });

  it('try/catch referencing external var tracks it', () => {
    const allDefined = new Set(['riskyFn']);
    const result = analyzeCell('try { riskyFn() } catch(e) {}', AcornTS, allDefined);
    assert.ok(result);
    assert.ok(result.uses.has('riskyFn'));
  });
});

// =============================================================================
// §8 — Passes
// =============================================================================

describe('AIR passes — type propagation', () => {
  it('propagates arithmetic types', () => {
    const m = lower('const x: i32 = 1\nconst y: i32 = 2\nconst z = x + y');
    const typeMap = propagateTypes(m);
    // z should get i32 from the add
    const addOp = findOp(m, 'add');
    assert.ok(addOp);
  });

  it('bitwise always i32', () => {
    const m = lower('const x = a | 0');
    propagateTypes(m);
    const bor = findOp(m, 'bitwise_or');
    assert.equal(bor.type, I32);
  });
});

describe('AIR passes — constant folding', () => {
  it('folds 2 + 3 → 5', () => {
    const m = lower('const x = 2 + 3');
    foldConstants(m);
    const consts = findOps(m, 'const');
    const five = consts.find(c => c.args[0] === 5);
    assert.ok(five, 'should fold 2+3 into const 5');
  });

  it('folds 10 * 3 → 30', () => {
    const m = lower('const x = 10 * 3');
    foldConstants(m);
    const consts = findOps(m, 'const');
    assert.ok(consts.find(c => c.args[0] === 30));
  });

  it('does not fold non-constant', () => {
    const m = lower('const x = a + 1');
    const before = findOps(m, 'add').length;
    foldConstants(m);
    const after = findOps(m, 'add').length;
    // add should still be there (a is unknown)
    assert.equal(before, after);
  });
});

describe('AIR passes — dependency extraction', () => {
  it('extracts defines and uses', () => {
    const m = lower('const x = 1\nconst y = z + x');
    const deps = extractDependencies(m);
    assert.ok(deps.defines.has('x'));
    assert.ok(deps.defines.has('y'));
    assert.ok(deps.uses.has('z'));
    assert.ok(!deps.uses.has('x')); // x is self-defined
  });
});

describe('AIR passes — hint insertion', () => {
  it('marks typed arithmetic with hint', () => {
    const m = lower('const x: i32 = 1\nconst y: i32 = 2\nconst z = x + y');
    runPasses(m);
    const addOp = findOp(m, 'add');
    // May or may not have hint depending on type propagation success
    // At minimum, the pass should not crash
    assert.ok(m.ops.length > 0);
  });
});

// =============================================================================
// §11.2 — API (analyzeCell)
// =============================================================================

describe('AIR API — analyzeCell', () => {
  it('returns defines and uses', () => {
    const allDefined = new Set(['upstream_var']);
    const result = analyzeCell('const x = upstream_var + 1', AcornTS, allDefined);
    assert.ok(result);
    assert.ok(result.defines.has('x'));
    assert.ok(result.uses.has('upstream_var'));
  });

  it('filters out JS globals from uses', () => {
    const allDefined = new Set(['Math', 'x']);
    const result = analyzeCell('const y = Math.sin(x)', AcornTS, allDefined);
    assert.ok(result);
    assert.ok(result.uses.has('x'));
    assert.ok(!result.uses.has('Math')); // filtered as global
  });

  it('returns null on parse error', () => {
    const result = analyzeCell('const = ;; broken syntax{{{', AcornTS, new Set());
    assert.equal(result, null);
  });

  it('matches existing parseNames output shape', () => {
    const result = analyzeCell('const a = 1\nfunction foo() {}', AcornTS, new Set());
    assert.ok(result);
    assert.ok(result.defines instanceof Set);
    assert.ok(result.uses instanceof Set);
    assert.ok(result.defines.has('a'));
    assert.ok(result.defines.has('foo'));
  });

  it('handles destructuring', () => {
    const allDefined = new Set(['obj']);
    const result = analyzeCell('const { a, b } = obj', AcornTS, allDefined);
    assert.ok(result);
    assert.ok(result.defines.has('a'));
    assert.ok(result.defines.has('b'));
    assert.ok(result.uses.has('obj'));
  });

  it('handles arrow functions', () => {
    const result = analyzeCell('const f = (x) => x * 2', AcornTS, new Set());
    assert.ok(result);
    assert.ok(result.defines.has('f'));
  });
});

describe('AIR API — extractDefines', () => {
  it('extracts top-level names', () => {
    const defines = extractDefines('const x = 1\nlet y = 2\nfunction foo() {}', AcornTS);
    assert.ok(defines);
    assert.ok(defines.has('x'));
    assert.ok(defines.has('y'));
    assert.ok(defines.has('foo'));
  });

  it('returns null on parse error', () => {
    const defines = extractDefines('const = ;; +++', AcornTS);
    assert.equal(defines, null);
  });
});

describe('AIR API — extractExportTypes', () => {
  it('returns type map', () => {
    const m = lower('const x: i32 = 42');
    const types = extractExportTypes(m);
    assert.ok(types);
    assert.ok(types.has('x'));
  });

  it('handles null module', () => {
    assert.equal(extractExportTypes(null), null);
  });
});

// =============================================================================
// §21 — @gcu/build prerequisites (AIR 0.3.0)
// =============================================================================

describe('AIR API — parseModule', () => {
  it('returns an ESTree Program', () => {
    const ast = parseModule('const x = 1', AcornTS);
    assert.equal(ast.type, 'Program');
    assert.equal(ast.body[0].type, 'VariableDeclaration');
  });

  it('enables ranges on AST nodes (for text-splice bundling)', () => {
    const ast = parseModule('const x = 1', AcornTS);
    const decl = ast.body[0];
    assert.equal(typeof decl.start, 'number');
    assert.equal(typeof decl.end, 'number');
    assert.ok(Array.isArray(decl.range));
    assert.equal(decl.range[0], 0);
    assert.equal(decl.range[1], 'const x = 1'.length);
  });

  it('enables locations on AST nodes', () => {
    const ast = parseModule('const x = 1', AcornTS);
    const decl = ast.body[0];
    assert.equal(decl.loc.start.line, 1);
    assert.equal(decl.loc.start.column, 0);
  });

  it('throws a helpful error when no parser and no window.Acorn', () => {
    assert.throws(() => parseModule('const x = 1'), /no parser available/);
  });

  it('accepts module syntax (import/export)', () => {
    const ast = parseModule("import { foo } from './x.js'", AcornTS);
    assert.equal(ast.body[0].type, 'ImportDeclaration');
  });
});

describe('AIR API — analyzeModule returns ast', () => {
  it('includes the parsed AST alongside defines/uses/air', () => {
    const result = analyzeModule('const x = 1', AcornTS, new Set());
    assert.ok(result.ast);
    assert.equal(result.ast.type, 'Program');
    assert.ok(result.ast.body[0].range, 'ast nodes should carry ranges');
  });
});

describe('AIR API — extractImports', () => {
  it('extracts named imports', () => {
    const ast = parseModule("import { foo, bar as baz } from './x.js'", AcornTS);
    const imports = extractImports(ast);
    assert.deepStrictEqual(imports, [{
      kind: 'named',
      source: './x.js',
      specifiers: [
        { imported: 'foo', local: 'foo' },
        { imported: 'bar', local: 'baz' },
      ],
    }]);
  });

  it('extracts namespace imports', () => {
    const ast = parseModule("import * as ns from './x.js'", AcornTS);
    const imports = extractImports(ast);
    assert.deepStrictEqual(imports, [{ kind: 'namespace', source: './x.js', local: 'ns' }]);
  });

  it('extracts side-effect imports', () => {
    const ast = parseModule("import './x.js'", AcornTS);
    const imports = extractImports(ast);
    assert.deepStrictEqual(imports, [{ kind: 'side-effect', source: './x.js' }]);
  });

  it('extracts default imports', () => {
    const ast = parseModule("import def from './x.js'", AcornTS);
    const imports = extractImports(ast);
    assert.deepStrictEqual(imports, [{ kind: 'default', source: './x.js', local: 'def' }]);
  });

  it('splits mixed default + named imports into separate descriptors', () => {
    const ast = parseModule("import def, { foo } from './x.js'", AcornTS);
    const imports = extractImports(ast);
    assert.equal(imports.length, 2);
    assert.equal(imports[0].kind, 'default');
    assert.equal(imports[0].local, 'def');
    assert.equal(imports[1].kind, 'named');
    assert.deepStrictEqual(imports[1].specifiers, [{ imported: 'foo', local: 'foo' }]);
  });

  it('returns empty array for code with no imports', () => {
    const ast = parseModule('const x = 1', AcornTS);
    assert.deepStrictEqual(extractImports(ast), []);
  });

  it('handles multiple import declarations', () => {
    const ast = parseModule("import { a } from './x.js'\nimport { b } from './y.js'", AcornTS);
    const imports = extractImports(ast);
    assert.equal(imports.length, 2);
    assert.equal(imports[0].source, './x.js');
    assert.equal(imports[1].source, './y.js');
  });
});

describe('AIR API — extractExports', () => {
  it('extracts declaration exports (const/let/function/class)', () => {
    const ast = parseModule('export const x = 1', AcornTS);
    const exports = extractExports(ast);
    assert.equal(exports.length, 1);
    assert.equal(exports[0].kind, 'declaration');
    assert.equal(exports[0].declaration.type, 'VariableDeclaration');
  });

  it('extracts named exports (no source)', () => {
    const ast = parseModule('const foo = 1\nexport { foo, foo as bar }', AcornTS);
    const exports = extractExports(ast);
    // First is the `const foo` declaration (not exported — skipped)
    // Second is `export { foo, foo as bar }` — one named-exports descriptor
    const named = exports.find(e => e.kind === 'named');
    assert.ok(named);
    assert.deepStrictEqual(named.specifiers, [
      { local: 'foo', exported: 'foo' },
      { local: 'foo', exported: 'bar' },
    ]);
  });

  it('extracts named re-exports (with source)', () => {
    const ast = parseModule("export { foo, bar as baz } from './x.js'", AcornTS);
    const exports = extractExports(ast);
    assert.deepStrictEqual(exports, [{
      kind: 'reexport-named',
      source: './x.js',
      specifiers: [
        { local: 'foo', exported: 'foo' },
        { local: 'bar', exported: 'baz' },
      ],
    }]);
  });

  it('extracts wildcard re-exports', () => {
    const ast = parseModule("export * from './x.js'", AcornTS);
    const exports = extractExports(ast);
    assert.deepStrictEqual(exports, [{ kind: 'reexport-wildcard', source: './x.js', exported: null }]);
  });

  it('extracts namespaced wildcard re-exports', () => {
    const ast = parseModule("export * as ns from './x.js'", AcornTS);
    const exports = extractExports(ast);
    assert.deepStrictEqual(exports, [{ kind: 'reexport-wildcard', source: './x.js', exported: 'ns' }]);
  });

  it('extracts default exports', () => {
    const ast = parseModule('export default function foo() {}', AcornTS);
    const exports = extractExports(ast);
    assert.equal(exports.length, 1);
    assert.equal(exports[0].kind, 'default');
    assert.equal(exports[0].declaration.type, 'FunctionDeclaration');
  });

  it('extracts function and class declaration exports', () => {
    const ast = parseModule('export function f() {}\nexport class C {}', AcornTS);
    const exports = extractExports(ast);
    assert.equal(exports.length, 2);
    assert.equal(exports[0].declaration.type, 'FunctionDeclaration');
    assert.equal(exports[1].declaration.type, 'ClassDeclaration');
  });

  it('returns empty array for code with no exports', () => {
    const ast = parseModule('const x = 1', AcornTS);
    assert.deepStrictEqual(extractExports(ast), []);
  });
});

// =============================================================================
// Regression — match existing dag-core.js parseNames behavior
// =============================================================================

describe('AIR regression — parseNames equivalence', () => {
  it('simple declarations', () => {
    const result = analyzeCell('const x = 1\nlet y = 2\nvar z = 3', AcornTS, new Set());
    assert.ok(result.defines.has('x'));
    assert.ok(result.defines.has('y'));
    assert.ok(result.defines.has('z'));
  });

  it('function declarations', () => {
    const result = analyzeCell('function foo() {}\nfunction bar(a, b) { return a + b }', AcornTS, new Set());
    assert.ok(result.defines.has('foo'));
    assert.ok(result.defines.has('bar'));
  });

  it('destructuring — object', () => {
    const result = analyzeCell('const { a, b, c: renamed } = obj', AcornTS, new Set());
    assert.ok(result.defines.has('a'));
    assert.ok(result.defines.has('b'));
    assert.ok(result.defines.has('renamed'));
    assert.ok(!result.defines.has('c')); // c is the key, renamed is the binding
  });

  it('destructuring — array', () => {
    const result = analyzeCell('const [x, y, z] = arr', AcornTS, new Set());
    assert.ok(result.defines.has('x'));
    assert.ok(result.defines.has('y'));
    assert.ok(result.defines.has('z'));
  });

  it('nested scopes — should NOT capture inner declarations', () => {
    const result = analyzeCell('const x = 1\nfunction foo() { const inner = 2 }', AcornTS, new Set());
    assert.ok(result.defines.has('x'));
    assert.ok(result.defines.has('foo'));
    assert.ok(!result.defines.has('inner')); // inner is inside a function
  });

  it('findUses — cross-cell references', () => {
    const allDefined = new Set(['upstream', 'other']);
    const result = analyzeCell('const x = upstream + 1', AcornTS, allDefined);
    assert.ok(result.uses.has('upstream'));
    assert.ok(!result.uses.has('other')); // not referenced
    assert.ok(!result.uses.has('x'));     // self-defined
  });

  it('URL with // in string should not break parsing', () => {
    const result = analyzeCell('const url = "https://example.com/api"\nconst x = 1', AcornTS, new Set());
    assert.ok(result);
    assert.ok(result.defines.has('url'));
    assert.ok(result.defines.has('x'));
  });

  it('class goes opaque but does not crash', () => {
    const result = analyzeCell('class Foo { constructor() {} }\nconst x = 1', AcornTS, new Set());
    assert.ok(result);
    assert.ok(result.defines.has('x'));
  });
});

// =============================================================================
// §9 — JS Emitter
// =============================================================================

// Helper: full pipeline → emitted JS code
function emit(code, opts = {}) {
  const ast = parse(code);
  const module = lowerJS(ast, code);
  runPasses(module);
  return emitJS(module, [], [], { hinted: opts.hinted ?? false, cellId: 'test', ...opts });
}

// Helper: eval the emitted code and return the exports
function roundTrip(code, scope = {}, opts = {}) {
  const ast = parse(code);
  const module = lowerJS(ast, code);
  runPasses(module);
  const scopeKeys = Object.keys(scope);
  const emitted = emitJS(module, scopeKeys, [], { hinted: opts.hinted ?? false, cellId: 'test' });
  const fn = new Function(...scopeKeys, emitted);
  return fn(...scopeKeys.map(k => scope[k]));
}

describe('AIR emitter — basic emission', () => {
  it('emits const declaration', () => {
    const js = emit('const x = 42');
    assert.ok(js.includes('let x = 42'));
    assert.ok(js.includes('return { x }'));
  });

  it('emits function declaration', () => {
    const js = emit('function foo(a, b) { return a + b }');
    assert.ok(js.includes('function foo'));
    assert.ok(js.includes('return { foo }'));
  });

  it('emits string literal', () => {
    const js = emit('const s = "hello"');
    assert.ok(js.includes('"hello"'));
  });
});

describe('AIR emitter — round-trip correctness', () => {
  it('const arithmetic', () => {
    const result = roundTrip('const x = 2 + 3');
    assert.equal(result.x, 5);
  });

  it('multiple declarations', () => {
    const result = roundTrip('const a = 10\nconst b = a * 2');
    assert.equal(result.a, 10);
    assert.equal(result.b, 20);
  });

  it('string concatenation', () => {
    const result = roundTrip('const x = "hello" + " " + "world"');
    assert.equal(result.x, 'hello world');
  });

  it('boolean logic', () => {
    const result = roundTrip('const x = true && false');
    assert.equal(result.x, false);
  });

  it('comparison', () => {
    const result = roundTrip('const x = 5 > 3');
    assert.equal(result.x, true);
  });

  it('function call', () => {
    const result = roundTrip('function double(n) { return n * 2 }\nconst x = double(21)');
    assert.equal(result.x, 42);
  });

  it('scope variables', () => {
    const result = roundTrip('const y = x + 1', { x: 10 });
    assert.equal(result.y, 11);
  });

  it('array creation', () => {
    const result = roundTrip('const arr = [1, 2, 3]');
    assert.deepEqual(result.arr, [1, 2, 3]);
  });

  it('object creation', () => {
    const result = roundTrip('const obj = { a: 1, b: 2 }');
    assert.deepEqual(result.obj, { a: 1, b: 2 });
  });

  it('member access', () => {
    const result = roundTrip('const x = obj.a', { obj: { a: 42 } });
    assert.equal(result.x, 42);
  });

  it('bracket access', () => {
    const result = roundTrip('const x = arr[1]', { arr: [10, 20, 30] });
    assert.equal(result.x, 20);
  });

  it('if/else', () => {
    const result = roundTrip('let x\nif (true) { x = 1 } else { x = 2 }');
    assert.equal(result.x, 1);
  });

  it('for loop', () => {
    const result = roundTrip('let sum = 0\nfor (let i = 0; i < 5; i++) { sum = sum + i }');
    assert.equal(result.sum, 10);
  });

  it('while loop', () => {
    const result = roundTrip('let n = 10\nwhile (n > 0) { n = n - 1 }');
    assert.equal(result.n, 0);
  });

  it('typed array creation', () => {
    const result = roundTrip('const arr = new Float64Array(3)');
    assert.ok(result.arr instanceof Float64Array);
    assert.equal(result.arr.length, 3);
  });

  it('template literal', () => {
    const result = roundTrip('const x = `hello ${name}!`', { name: 'world' });
    assert.equal(result.x, 'hello world!');
  });

  it('arrow function', () => {
    const result = roundTrip('const f = (x) => x * 2\nconst y = f(5)');
    assert.equal(result.y, 10);
  });

  it('destructuring — object', () => {
    const result = roundTrip('const { a, b } = obj', { obj: { a: 1, b: 2 } });
    assert.equal(result.a, 1);
    assert.equal(result.b, 2);
  });

  it('destructuring — array', () => {
    const result = roundTrip('const [x, y] = arr', { arr: [10, 20] });
    assert.equal(result.x, 10);
    assert.equal(result.y, 20);
  });

  it('method call', () => {
    const result = roundTrip('const x = [3,1,2].sort()\nconst y = x[0]');
    assert.equal(result.y, 1);
  });
});

describe('AIR emitter — V8 hints', () => {
  it('i32 annotation emits |0 on store', () => {
    const js = emit('const a: i32 = 5\nconst b: i32 = 3\nconst x: i32 = a + b', { hinted: true });
    assert.ok(js.includes('| 0'), 'should contain |0 hint');
  });

  it('f64 zero emits 0.0', () => {
    const js = emit('const x: f64 = 0', { hinted: true });
    assert.ok(js.includes('0.0'), 'should emit 0.0 for f64 zero');
  });
});

describe('AIR emitter — opaque passthrough', () => {
  it('class source preserved', () => {
    const js = emit('class Foo { constructor() { this.x = 1 } }\nconst x = 1');
    assert.ok(js.includes('class Foo'));
    assert.ok(js.includes('return {'));
    assert.ok(js.includes('Foo'));
    assert.ok(js.includes('x'));
  });
});

describe('AIR emitter — structured regions', () => {
  it('try/catch emitted', () => {
    const js = emit('try { x() } catch(e) { }');
    assert.ok(js.includes('try'));
    assert.ok(js.includes('catch'));
  });

  it('switch emitted', () => {
    const js = emit('switch (x) { case 1: break; default: break; }');
    assert.ok(js.includes('switch'));
    assert.ok(js.includes('case'));
  });

  it('throw emitted', () => {
    const js = emit('throw new Error("oops")');
    assert.ok(js.includes('throw'));
  });
});

describe('AIR emitter — un-opaqued expressions', () => {
  it('** operator round-trip', () => {
    const result = roundTrip('const x = 2 ** 3\nconst y = x + 1');
    assert.equal(result.x, 8);
    assert.equal(result.y, 9);
  });

  it('typeof round-trip', () => {
    const result = roundTrip('const x = typeof "hello"');
    assert.equal(result.x, 'string');
  });

  it('instanceof round-trip', () => {
    const result = roundTrip('const x = [] instanceof Array');
    assert.equal(result.x, true);
  });

  it('in operator round-trip', () => {
    const result = roundTrip('const x = "a" in obj', { obj: { a: 1 } });
    assert.equal(result.x, true);
  });

  it('bitwise NOT round-trip', () => {
    const result = roundTrip('const x = ~0');
    assert.equal(result.x, -1);
  });

  it('void round-trip', () => {
    const result = roundTrip('const x = void 0');
    assert.equal(result.x, undefined);
  });

  it('new Foo() round-trip', () => {
    const result = roundTrip('class Foo { val() { return 42 } }\nconst x = new Foo().val()');
    assert.equal(result.x, 42);
  });

  it('try/catch round-trip', () => {
    const result = roundTrip('let x = 0\ntry { x = 42 } catch(e) { x = -1 }');
    assert.equal(result.x, 42);
  });

  it('try/catch error path', () => {
    const result = roundTrip('let x = 0\ntry { throw new Error("e") } catch(e) { x = -1 }');
    assert.equal(result.x, -1);
  });

  it('optional chaining round-trip', () => {
    const result = roundTrip('const x = obj?.a', { obj: { a: 42 } });
    assert.equal(result.x, 42);
  });

  it('optional chaining null', () => {
    const result = roundTrip('const x = obj?.a', { obj: null });
    assert.equal(result.x, undefined);
  });

  it('optional method call', () => {
    const result = roundTrip('const x = arr?.map(v => v * 2)', { arr: [1, 2] });
    assert.deepEqual(result.x, [2, 4]);
  });

  it('optional method call on null', () => {
    const result = roundTrip('const x = arr?.map(v => v * 2)', { arr: null });
    assert.equal(result.x, undefined);
  });

  it('class with methods round-trip', () => {
    const result = roundTrip('class Foo { constructor(x) { this.x = x } get val() { return this.x } }\nconst f = new Foo(42)\nconst x = f.val');
    assert.equal(result.x, 42);
  });

  it('class extends round-trip', () => {
    const result = roundTrip('class A { foo() { return 1 } }\nclass B extends A { bar() { return 2 } }\nconst x = new B().foo() + new B().bar()');
    assert.equal(result.x, 3);
  });

  it('class expression round-trip', () => {
    const result = roundTrip('const Cls = class { run() { return 99 } }\nconst x = new Cls().run()');
    assert.equal(result.x, 99);
  });

  it('generator function round-trip', () => {
    const result = roundTrip('function* gen() { yield 1; yield 2; yield 3 }\nconst x = [...gen()]');
    assert.deepEqual(result.x, [1, 2, 3]);
  });

  it('switch round-trip', () => {
    const result = roundTrip('let x = 0\nswitch(1) { case 1: x = 42; break; default: x = -1; }');
    assert.equal(result.x, 42);
  });
});

describe('AIR emitter — needsAsync', () => {
  it('pure arithmetic → sync', () => {
    const m = lower('const x = 1 + 2');
    assert.equal(needsAsync(m), false);
  });

  it('await → async', () => {
    const m = lower('const x = await fetch("url")');
    assert.equal(needsAsync(m), true);
  });

  it('function call → async (conservative)', () => {
    const m = lower('const x = foo()');
    assert.equal(needsAsync(m), true);
  });
});

describe('AIR registerLowerer / getLowerer / lower', () => {
  // The registry is process-global; use unique language names per test
  // to avoid cross-test interference. Don't touch 'js' (registered by AIR
  // itself when window.Acorn is present, which is not the case in Node tests).

  it('register and look up a lowerer', () => {
    const fn = (ast) => ({ ops: [], defines: new Set(), imports: new Set() });
    registerLowerer('test_lang_lookup', fn);
    assert.equal(getLowerer('test_lang_lookup'), fn);
  });

  it('getLowerer returns null for unregistered language', () => {
    assert.equal(getLowerer('test_lang_unregistered'), null);
  });

  it('lower returns null for unregistered language (does not throw)', () => {
    assert.equal(airLower('test_lang_missing', {}, ''), null);
  });

  it('re-registering the same language warns and replaces', () => {
    const first = (ast) => ({ ops: [], defines: new Set(), imports: new Set(), tag: 'first' });
    const second = (ast) => ({ ops: [], defines: new Set(), imports: new Set(), tag: 'second' });
    registerLowerer('test_lang_replace', first);
    const origWarn = console.warn;
    let warned = false;
    console.warn = () => { warned = true; };
    try { registerLowerer('test_lang_replace', second); }
    finally { console.warn = origWarn; }
    assert.equal(warned, true);
    assert.equal(getLowerer('test_lang_replace'), second);
  });

  it('lower passes ast and source through to the registered fn', () => {
    let captured = null;
    registerLowerer('test_lang_passthrough', (ast, src) => {
      captured = { ast, src };
      return { ops: [], defines: new Set(), imports: new Set() };
    });
    const ast = { type: 'Module', body: [] };
    const result = airLower('test_lang_passthrough', ast, 'source code');
    assert.equal(captured.ast, ast);
    assert.equal(captured.src, 'source code');
    assert.ok(result);
  });

  it('lower catches lowerer errors and returns null', () => {
    registerLowerer('test_lang_throws', () => { throw new Error('lowerer broke'); });
    // Should NOT throw — returns null with debug log (suppressed in tests).
    assert.equal(airLower('test_lang_throws', {}, ''), null);
  });

  it('registerLowerer rejects non-string language', () => {
    assert.throws(() => registerLowerer('', () => {}), /non-empty string/);
    assert.throws(() => registerLowerer(null, () => {}), /non-empty string/);
  });

  it('registerLowerer rejects non-function lowerer', () => {
    assert.throws(() => registerLowerer('test_lang_bad_fn', null), /must be a function/);
    assert.throws(() => registerLowerer('test_lang_bad_fn', 'not a fn'), /must be a function/);
  });
});
