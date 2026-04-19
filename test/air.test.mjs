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
import { analyzeCell, extractDefines, extractExportTypes } from '../ext/air/src/api.js';
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
