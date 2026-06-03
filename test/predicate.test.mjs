// @gcu/strata predicate — the structured safe boolean-expr spec: parse, evaluate,
// columns, validate, round-trip. Pure; zero DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePredicate, evaluatePredicate, predicateColumns, validatePredicate, predicateToString,
} from '../ext/strata/src/predicate.js';

// A row accessor over a plain object.
const rowGet = (row) => (col) => row[col];
const evalOn = (str, row) => evaluatePredicate(parsePredicate(str), rowGet(row));

test('parse: comparison → spec shape', () => {
  assert.deepEqual(parsePredicate('grade > 2'),
    { form: 'spec', root: { op: '>', left: { col: 'grade' }, right: { lit: 2 } } });
});

test('parse: && / || flatten and nest', () => {
  const p = parsePredicate('a > 1 && b < 2 && c == 3');
  assert.equal(p.root.op, 'and');
  assert.equal(p.root.args.length, 3);            // flattened, not nested pairs
  const o = parsePredicate('a || b && c');         // && binds tighter than ||
  assert.equal(o.root.op, 'or');
  assert.equal(o.root.args[1].op, 'and');
});

test('parse: null-checks lower to isnull / notnull', () => {
  assert.deepEqual(parsePredicate('grade == null').root, { op: 'isnull', arg: { col: 'grade' } });
  assert.deepEqual(parsePredicate('grade != null').root, { op: 'notnull', arg: { col: 'grade' } });
});

test('parse: a bare term becomes truthy (filter on a boolean column)', () => {
  assert.deepEqual(parsePredicate('flag').root, { op: 'truthy', arg: { col: 'flag' } });
});

test('parse: arithmetic + precedence + parens', () => {
  assert.deepEqual(parsePredicate('grade * tonnes > 100').root,
    { op: '>', left: { op: '*', left: { col: 'grade' }, right: { col: 'tonnes' } }, right: { lit: 100 } });
  // parens override precedence
  const p = parsePredicate('(a || b) && c');
  assert.equal(p.root.op, 'and');
  assert.equal(p.root.args[0].op, 'or');
});

test('parse: rejects disallowed syntax (the safety boundary)', () => {
  assert.throws(() => parsePredicate('Math.log(x) > 0'), /function calls|unexpected/);
  assert.throws(() => parsePredicate('a.b == 1'), /unexpected/);
  assert.throws(() => parsePredicate('grade >'), /unexpected end/);
  assert.throws(() => parsePredicate('grade > > 2'), /unexpected/);
});

test('evaluate: comparisons + logic + strings', () => {
  assert.equal(evalOn('grade > 2', { grade: 2.5 }), true);
  assert.equal(evalOn('grade > 2', { grade: 1.5 }), false);
  assert.equal(evalOn('dom == "ox"', { dom: 'ox' }), true);
  assert.equal(evalOn('dom == "ox"', { dom: 'sulf' }), false);
  assert.equal(evalOn('dom == "sulf" && grade < 2', { dom: 'sulf', grade: 1.1 }), true);
  assert.equal(evalOn('grade <= 2 || dom == "ox"', { grade: 5, dom: 'ox' }), true);
  assert.equal(evalOn('!(grade > 2)', { grade: 1 }), true);
});

test('evaluate: null semantics — comparisons exclude nulls; isnull/notnull check', () => {
  assert.equal(evalOn('grade > 2', { grade: null }), false);    // null never matches a comparison
  assert.equal(evalOn('grade != 2', { grade: null }), false);   // even !=
  assert.equal(evalOn('grade == null', { grade: null }), true);
  assert.equal(evalOn('grade != null', { grade: null }), false);
  assert.equal(evalOn('grade != null', { grade: 3 }), true);
  assert.equal(evalOn('grade != null && grade >= 2', { grade: 3 }), true);
  assert.equal(evalOn('grade != null && grade >= 2', { grade: null }), false);
});

test('evaluate: arithmetic + truthy + missing column', () => {
  assert.equal(evalOn('grade * tonnes > 100', { grade: 4, tonnes: 30 }), true);
  assert.equal(evalOn('flag', { flag: true }), true);
  assert.equal(evalOn('flag', { flag: false }), false);
  assert.equal(evalOn('flag', { flag: 0 }), false);
  assert.equal(evalOn('missing > 1', {}), false);   // undefined → null → excluded
});

test('predicateColumns: the referenced columns', () => {
  assert.deepEqual(predicateColumns(parsePredicate('grade * tonnes > 100 && dom == "ox"')).sort(),
    ['dom', 'grade', 'tonnes']);
});

test('evaluatePredicate: structured spec (no string) — in/between/programmatic', () => {
  const inSpec = { form: 'spec', root: { op: 'in', left: { col: 'dom' }, set: ['ox', 'sulf'] } };
  assert.equal(evaluatePredicate(inSpec, rowGet({ dom: 'ox' })), true);
  assert.equal(evaluatePredicate(inSpec, rowGet({ dom: 'trans' })), false);
  const btw = { op: 'between', arg: { col: 'g' }, lo: { lit: 1 }, hi: { lit: 5 } };
  assert.equal(evaluatePredicate(btw, rowGet({ g: 3 })), true);
  assert.equal(evaluatePredicate(btw, rowGet({ g: 9 })), false);
});

test('validatePredicate: accepts good specs, rejects malformed', () => {
  assert.equal(validatePredicate(parsePredicate('grade > 2')), true);
  assert.throws(() => validatePredicate({ op: 'and', args: 'nope' }), /args/);
  assert.throws(() => validatePredicate({ op: 'bogus', left: { col: 'a' }, right: { lit: 1 } }), /unknown op|not a boolean/);
});

test('predicateToString: round-trips the common shapes', () => {
  for (const s of ['grade > 2', 'dom == "ox" && grade < 2', '(a || b) && c', 'grade != null']) {
    const once = predicateToString(parsePredicate(s));
    // re-parsing the rendered string yields the same spec
    assert.deepEqual(parsePredicate(once), parsePredicate(s), `round-trip: ${s} → ${once}`);
  }
});
