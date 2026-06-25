// @gcu/expr — the package's executable spec. Runs the fixture vectors through the
// tree-walk reference path, then the CORRECTNESS ORACLE: every vector compiled to
// positional closures must agree with the tree-walk (de-risks the one genuinely-new
// component — the closure compiler). Plus totality, deps, validate, and the GCU
// additions (geo / casts / tests / bracket / case-insensitivity).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, evaluate, evalBool, constraintValid, compile, compileBool, deps, validate, tokenize } from '../ext/expr/src/main.js';

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

test('lamina-dialect operators — && || == ~ !~ in (superset of parseFilter)', () => {
  const cols = ['grade', 'lito', 'code'];
  const row = { grade: 2, lito: 'OXIDE', code: 'DDH0042' };
  const f = (s) => compileBool(s, cols)([row.grade, row.lito, row.code]);
  // && / || / == aliases
  assert.equal(f('grade > 1 && lito == "OXIDE"'), true);
  assert.equal(f('grade > 5 || lito == "OXIDE"'), true);
  assert.equal(f('grade == 2'), true);
  // ~ / !~ contains
  assert.equal(f('code ~ "DDH"'), true);
  assert.equal(f('code !~ "RC"'), true);
  // in set membership (members quoted, as lamina's stats panel emits)
  assert.equal(f('lito in "OXIDE", "SULF"'), true);
  assert.equal(f('lito in "SULF", "TRANS"'), false);
  // tree-walk agrees
  assert.equal(evalBool('grade > 1 && lito in "OXIDE", "SULF"', row), true);
  // deps sees `in` members + column
  assert.deepEqual(deps('lito in "a", "b"'), ['lito']);
});

test('SQL-canonical surface — is not blank / not in / not contains / like / <> / scientific / single-quote', () => {
  // is not blank / is not filled
  assert.equal(evalBool('grade is not blank', { grade: 1 }), true);
  assert.equal(evalBool('grade is not blank', {}), false);
  assert.equal(evalBool('grade is not filled', {}), true);
  // not in / not contains / not like (postfix)
  assert.equal(evalBool('lito not in ("SULF", "TRANS")', { lito: 'OXIDE' }), true);
  assert.equal(evalBool('code not contains "RC"', { code: 'DDH1' }), true);
  assert.equal(evalBool('code not like "RC%"', { code: 'DDH1' }), true);
  // in with parens (canonical) and without (tolerated) agree
  assert.equal(evalBool('lito in ("OXIDE", "SULF")', { lito: 'OXIDE' }), true);
  assert.equal(evalBool('lito in "OXIDE", "SULF"', { lito: 'OXIDE' }), true);
  // like: % = any run, _ = one char, anchored
  assert.equal(evalBool('code like "DDH%"', { code: 'DDH0042' }), true);
  assert.equal(evalBool('code like "DD_0042"', { code: 'DDH0042' }), true);
  assert.equal(evalBool('code like "RC%"', { code: 'DDH0042' }), false);
  // <> not-equal + single-quoted string (both tolerated)
  assert.equal(evalBool("lito <> 'WASTE'", { lito: 'OXIDE' }), true);
  // scientific + leading-dot numbers
  assert.equal(evaluate('au * 1e4', { au: 0.0005 }), 5);
  assert.equal(evaluate('grade > .5', { grade: 0.7 }), true);
  assert.equal(evaluate('1.5e-3 * 1000', {}), 1.5);
});

test('tokenize — classified, positioned tokens for highlighting (tolerant)', () => {
  const toks = tokenize('grade between 1.2 and 3.8 and lito = "OXIDE"');
  const byKind = (k) => toks.filter((t) => t.kind === k).map((t) => t.value);
  assert.deepEqual(byKind('column'), ['grade', 'lito']);
  assert.deepEqual(byKind('keyword'), ['between', 'and', 'and']);
  assert.deepEqual(byKind('number'), ['1.2', '3.8']);
  assert.deepEqual(byKind('string'), ['"OXIDE"']);
  assert.deepEqual(byKind('operator'), ['=']);
  // positions are usable for an overlay
  const g = toks.find((t) => t.value === 'grade');
  assert.equal(g.start, 0); assert.equal(g.end, 5);
  // function vs column, and tolerant on a half-typed expression
  assert.deepEqual(tokenize('round(au,').filter((t) => t.kind === 'function').map((t) => t.value), ['round']);
  assert.ok(tokenize('grade > @@@').some((t) => t.kind === 'error'));
});

test('decimal-comma locale — comma-decimal field strings read numerically', () => {
  // a BR/EU CSV: the field arrives as the string "3,5"
  assert.equal(evaluate('grade * 2', { grade: '3,5' }, { decimal: ',' }), 7);
  assert.equal(compileBool('grade > 3', ['grade'], { decimal: ',' })(['3,5']), true);
  // default (dot) leaves "3,5" non-numeric → blank, never a throw
  assert.equal(evaluate('grade * 2', { grade: '3,5' }), null);
  // a real number value is untouched by comma mode (3.5 never becomes 35)
  assert.equal(evaluate('grade * 2', { grade: 3.5 }, { decimal: ',' }), 7);
  // string columns aren't coerced lazily — only where a number is needed
  assert.equal(evalBool('lito == "OXIDE"', { lito: 'OXIDE' }, { decimal: ',' }), true);
});

test('blank-propagation invariant — a missing grade never becomes 0', () => {
  // the load-bearing safety rule: arithmetic on a blank stays blank
  assert.equal(evaluate('grade * tonnes', { tonnes: 100 }), null);
  assert.equal(compile('grade * tonnes', ['grade', 'tonnes'])([null, 100]), null);
  // …unless explicitly cast
  assert.equal(evaluate('ifnum(grade, 0) * tonnes', { tonnes: 100 }), 0);
});
