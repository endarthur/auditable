// @gcu/expr — the package's executable spec. Runs the fixture vectors through the
// tree-walk reference path, then the CORRECTNESS ORACLE: every vector compiled to
// positional closures must agree with the tree-walk (de-risks the one genuinely-new
// component — the closure compiler). Plus totality, deps, validate, and the GCU
// additions (geo / casts / tests / bracket / case-insensitivity).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, evaluate, evalBool, constraintValid, compile, compileBool, deps, validate } from '../ext/expr/src/main.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/expr.json', import.meta.url), 'utf8'));

test('expr fixture vectors — tree-walk reference path', () => {
  for (const v of fx.vectors) {
    if (v.verb === 'constrain') assert.equal(constraintValid(v.expr, v.values, v.target), v.expectedConstraintValid, v.expr);
    else if (v.verb === 'calculate') assert.equal(evaluate(v.expr, v.values), v.expected, v.expr);
    else assert.equal(evalBool(v.expr, v.values), v.expected, v.expr);   // bool / relevant
  }
});

test('ORACLE — compiled positional closures ≡ tree-walk, every vector', () => {
  for (const v of fx.vectors) {
    if (v.verb === 'constrain') continue;                    // constraintValid is tree-walk-only
    const columns = Object.keys(v.values);                   // name → index binding
    const fields = columns.map((c) => v.values[c]);          // the positional row the cursor would hand us
    const ast = parse(v.expr);
    const tree = evaluate(ast, v.values);
    const comp = compile(ast, columns)(fields);
    assert.deepEqual(comp, tree, `compiled≠treewalk for: ${v.expr}`);
    // boolean face agrees too
    assert.equal(compileBool(ast, columns)(fields), tree === true, `compileBool≠ for: ${v.expr}`);
  }
});

test('totality — bad syntax throws at parse; eval never throws', () => {
  assert.throws(() => parse('fe_pct >'), /parse error/);
  assert.throws(() => parse('fe_pct between 0 100'), /expected 'and'/);
  assert.throws(() => parse('a and and b'), /parse error/);
  assert.throws(() => parse('round()'), /round\(\) expects/);
  // eval is total — blank, never a throw
  assert.equal(evaluate('1 / 0', {}), null);
  assert.equal(evaluate('missing + 1', {}), null);
  assert.equal(evalBool('missing > 5', {}), false);
  assert.equal(evaluate('sqrt(x)', { x: -4 }), null);
  // a malformed regex in matches → false, not a throw
  assert.equal(evalBool('s matches "("', { s: 'x' }), false);
  // the compiled path is equally total
  assert.equal(compile('a / b', ['a', 'b'])([5, 0]), null);
  assert.equal(compileBool('a > b', ['a', 'b'])([null, 1]), false);
});

test('deps — free column references', () => {
  assert.deepEqual(deps('fe_pct between 0 and 100').sort(), ['fe_pct']);
  assert.deepEqual(deps('fe_pct > 60 and lithology = "itabirite"').sort(), ['fe_pct', 'lithology']);
  assert.deepEqual(deps('(a + b) * 2').sort(), ['a', 'b']);
  assert.deepEqual(deps('clamp(grade, lo, hi)').sort(), ['grade', 'hi', 'lo']);
  assert.deepEqual(deps('["Cu (ppm)"] > 30').sort(), ['Cu (ppm)']);
  assert.deepEqual(deps('if(g > 1, a, b)').sort(), ['a', 'b', 'g']);
});

test('validate — parse + unknown-column check', () => {
  assert.equal(validate('a > 1', ['a', 'b']).ok, true);
  const bad = validate('a > 1 and zzz < 5', ['a', 'b']);
  assert.equal(bad.ok, false);
  assert.equal(bad.errors[0].kind, 'column');
  assert.equal(bad.errors[0].name, 'zzz');
  const pe = validate('a >', ['a']);
  assert.equal(pe.ok, false);
  assert.equal(pe.errors[0].kind, 'parse');
  // case-insensitive column resolution
  assert.equal(validate('AU > 0.5', ['au']).ok, true);
  assert.equal(validate('au > 0.5', ['AU']).ok, true);
  // no columns supplied → parse-only (no column errors)
  assert.equal(validate('anything > here').ok, true);
});

test('compile — case-insensitive field binding + zero per-row allocation shape', () => {
  const f = compileBool('AU > 0.5 and OK-Indic = 1', ['au', 'ok-indic']);
  assert.equal(f([0.9, 1]), true);
  assert.equal(f([0.2, 1]), false);
  assert.equal(f([0.9, 0]), false);
  // unknown column compiles to blank (validate is where you'd catch it)
  assert.equal(compile('ghost + 1', ['a'])([5]), null);
});

test('blank-propagation invariant — a missing grade never becomes 0', () => {
  // the load-bearing safety rule: arithmetic on a blank stays blank
  assert.equal(evaluate('grade * tonnes', { tonnes: 100 }), null);
  assert.equal(compile('grade * tonnes', ['grade', 'tonnes'])([null, 100]), null);
  // …unless explicitly cast
  assert.equal(evaluate('ifnum(grade, 0) * tonnes', { tonnes: 100 }), 0);
});
