// @gcu/over — lexer + parser (the v0 row-map parse front-end). The schema pass,
// the `over` AIR lowerer, and the driver land next; this pins text → AST.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lex, OverLexError } from '../ext/over/src/lex.js';
import { parse, OverParseError } from '../ext/over/src/parse.js';
import { schemaPass, inferType, unify } from '../ext/over/src/schema.js';

const QF = [
  { name: 'FE', type: 'float' }, { name: 'SIO2', type: 'float' }, { name: 'AL2O3', type: 'float' },
  { name: 'P', type: 'float' }, { name: 'IJK', type: 'int' }, { name: 'LITHO', type: 'category' },
];
const sch = (src, input = QF) => schemaPass(parse(src), input);
const col = (r, name) => r.columns.find((c) => c.name === name);

const types = (src) => lex(src).map((t) => t.t);
const stmts = (src) => parse(src).statements;

// ── lexer ──
test('lex: tokens, comments, newlines', () => {
  assert.deepEqual(types('FE = 62  # the cutoff\nGO = true'),
    ['ident', 'op', 'num', 'newline', 'ident', 'op', 'ident', 'eof']);
});

test('lex: backtick column names carry text verbatim', () => {
  const t = lex('`Au (g/t)` = `domain 😅`');
  assert.equal(t[0].t, 'field'); assert.equal(t[0].v, 'Au (g/t)');
  assert.equal(t[2].t, 'field'); assert.equal(t[2].v, 'domain 😅');
});

test('lex: strings, numbers, two-char ops', () => {
  const t = lex('X = "HEMA" != 3.5e2 >= 0.1 ?? 0');
  assert.deepEqual(t.filter((x) => x.t === 'op').map((x) => x.v), ['=', '!=', '>=', '??']);
  assert.equal(t.find((x) => x.t === 'str').v, 'HEMA');
  assert.equal(t.find((x) => x.t === 'num').v, 350);
});

test('lex: and/or are operators; pragma is its own token', () => {
  const t = lex('%compat\nX = a and b or c');
  assert.equal(t[0].t, 'pragma'); assert.equal(t[0].v, 'compat');
  assert.deepEqual(t.filter((x) => x.t === 'op' && /and|or/.test(x.v)).map((x) => x.v), ['and', 'or']);
});

test('lex: unterminated string / backtick throw', () => {
  assert.throws(() => lex('X = "oops'), OverLexError);
  assert.throws(() => lex('`oops = 1'), OverLexError);
});

// ── parser: assignment + types ──
test('parse: simple assignment', () => {
  assert.deepEqual(stmts('GANGUE = SIO2 + AL2O3'), [{
    type: 'Assign', kind: 'field', target: { name: 'GANGUE' },
    value: { type: 'Binary', op: '+', left: { type: 'Field', name: 'SIO2' }, right: { type: 'Field', name: 'AL2O3' } },
  }]);
});

test('parse: relational yields a Binary (the 1/0-or-bool flag)', () => {
  assert.deepEqual(stmts('HIGRADE = FE >= 62')[0].value,
    { type: 'Binary', op: '>=', left: { type: 'Field', name: 'FE' }, right: { type: 'Num', value: 62 } });
});

test('parse: typed target + per-column default', () => {
  const a = stmts('P: float default 0 = P')[0];
  assert.deepEqual(a.target.spec, { vtype: 'float', default: { type: 'Num', value: 0 } });
});

test('parse: bool type target', () => {
  assert.equal(stmts('HIGRADE: bool = FE >= 62')[0].target.spec.vtype, 'bool');
});

test('parse: let is scratch (kind:let)', () => {
  const a = stmts('let ratio = SIO2 / FE')[0];
  assert.equal(a.kind, 'let'); assert.equal(a.target.name, 'ratio');
});

test('parse: backtick target + reference', () => {
  const a = stmts('`Au ok` = `Au (g/t)` * 1.01')[0];
  assert.equal(a.target.name, 'Au ok');
  assert.equal(a.value.left.name, 'Au (g/t)');
});

// ── precedence ──
test('parse: * binds tighter than +', () => {
  const v = stmts('X = a + b * c')[0].value;
  assert.equal(v.op, '+'); assert.equal(v.right.op, '*');
});

test('parse: and binds tighter than or; ?? lowest', () => {
  const v = stmts('X = a and b or c')[0].value;
  assert.equal(v.op, 'or'); assert.equal(v.left.op, 'and');
  const w = stmts('X = a or b ?? c')[0].value;
  assert.equal(w.op, '??'); assert.equal(w.left.op, 'or');
});

test('parse: unary minus, absent, calls', () => {
  assert.deepEqual(stmts('X = -FE')[0].value, { type: 'Unary', op: '-', operand: { type: 'Field', name: 'FE' } });
  assert.deepEqual(stmts('X = FE ?? absent')[0].value.right, { type: 'Absent' });
  const c = stmts('BEST = maxia(FE_OK, FE_ID)')[0].value;
  assert.equal(c.type, 'Call'); assert.equal(c.name, 'maxia'); assert.equal(c.args.length, 2);
});

// ── control flow + projection ──
test('parse: if / elseif / else / end', () => {
  const s = stmts('if (FE >= 64)\n  T = "HEMATITE"\nelseif (FE >= 58)\n  T = "ITABIRITE"\nelse\n  T = "WASTE"\nend')[0];
  assert.equal(s.type, 'If');
  assert.equal(s.clauses.length, 2);
  assert.equal(s.clauses[0].test.op, '>=');
  assert.equal(s.clauses[0].body[0].value.value, 'HEMATITE');
  assert.equal(s.alternate[0].value.value, 'WASTE');
});

test('parse: projection + control', () => {
  assert.deepEqual(stmts('saveonly(IJK, FE, `Au (g/t)`)')[0],
    { type: 'Project', name: 'saveonly', fields: ['IJK', 'FE', 'Au (g/t)'] });
  assert.deepEqual(stmts('delete')[0], { type: 'Control', name: 'delete' });
});

// ── match ──
test('parse: match with relop arms + default', () => {
  const m = stmts('ORETYPE = match FE { >=64: "HEMATITE", >=58: "ITABIRITE", _: "WASTE" }')[0].value;
  assert.equal(m.type, 'Match');
  assert.equal(m.subject.name, 'FE');
  assert.equal(m.arms.length, 2);
  assert.deepEqual(m.arms[0], { rel: '>=', test: { type: 'Num', value: 64 }, value: { type: 'Str', value: 'HEMATITE' } });
  assert.equal(m.default.value, 'WASTE');
});

// ── pragma + whole transforms ──
test('parse: dialect pragma; default native', () => {
  assert.equal(parse('%compat\nX = 1').dialect, 'compat');
  assert.equal(parse('X = 1').dialect, 'native');
  assert.throws(() => parse('%nonsense\nX = 1'), OverParseError);
});

test('parse: the spec\'s end-to-end transform', () => {
  const src = [
    'if (FE == absent) FE = default(FE) end',
    'CONTAM = (SIO2 + AL2O3 + P) / FE',
    'if (FE >= 60 and CONTAM <= 0.12)',
    '   CLASS = "ORE"',
    'else',
    '   CLASS = "WASTE"',
    'end',
    'saveonly(IJK, FE, SIO2, AL2O3, P, CONTAM, CLASS)',
  ].join('\n');
  const s = stmts(src);
  assert.equal(s.length, 4);
  assert.equal(s[0].type, 'If');
  assert.equal(s[1].type, 'Assign'); assert.equal(s[1].target.name, 'CONTAM');
  assert.equal(s[2].type, 'If'); assert.equal(s[2].clauses[0].test.op, 'and');
  assert.deepEqual(s[3], { type: 'Project', name: 'saveonly', fields: ['IJK', 'FE', 'SIO2', 'AL2O3', 'P', 'CONTAM', 'CLASS'] });
});

test('parse: trailing junk is an error', () => {
  assert.throws(() => parse('X = 1 )'), OverParseError);
});

// ── schema pass ──
test('unify: numeric + bool coercion; mixed → dynamic', () => {
  assert.equal(unify('int', 'float'), 'float');
  assert.equal(unify('bool', 'int'), 'int');
  assert.equal(unify('bool', 'float'), 'float');
  assert.equal(unify('string', 'category'), 'string');
  assert.equal(unify('string', 'int'), 'dynamic');
  assert.equal(unify('int', 'int'), 'int');
});

test('schema: a new column is typed by inference; input passes through', () => {
  const r = sch('GANGUE = SIO2 + AL2O3');
  assert.equal(r.columns.length, QF.length + 1);
  assert.equal(col(r, 'GANGUE').vtype, 'float');
});

test('schema: explicit bool spec vs inferred relational (native bool / compat float)', () => {
  assert.equal(col(sch('HIGRADE: bool = FE >= 62'), 'HIGRADE').vtype, 'bool');
  assert.equal(col(sch('HIGRADE = FE >= 62'), 'HIGRADE').vtype, 'bool');
  assert.equal(col(sch('%compat\nHIGRADE = FE >= 62'), 'HIGRADE').vtype, 'float');
});

test('schema: let is scratch — present in lets, absent from output', () => {
  const r = sch('let ratio = SIO2 / FE\nX = ratio * 2');
  assert.ok(r.lets.find((l) => l.name === 'ratio' && l.vtype === 'float'));
  assert.equal(col(r, 'ratio'), undefined);
  assert.equal(col(r, 'X').vtype, 'float');
});

test('schema: match value-types unify to string', () => {
  assert.equal(col(sch('ORETYPE = match FE { >=64:"H", >=58:"I", _:"W" }'), 'ORETYPE').vtype, 'string');
});

test('schema: a column declared across if-branches lands, type unified', () => {
  const r = sch('if (FE >= 60)\n  CLASS = "ORE"\nelse\n  CLASS = "WASTE"\nend');
  assert.equal(col(r, 'CLASS').vtype, 'string');
});

test('schema: saveonly restricts + orders the output exactly', () => {
  const r = sch('CONTAM = (SIO2 + AL2O3 + P) / FE\nsaveonly(IJK, FE, CONTAM)');
  assert.deepEqual(r.columns.map((c) => c.name), ['IJK', 'FE', 'CONTAM']);
  assert.equal(col(r, 'CONTAM').vtype, 'float');
});

test('schema: erase drops a column', () => {
  assert.equal(col(sch('erase(P)'), 'P'), undefined);
});

test('schema: use-before-def warns', () => {
  const r = sch('X = NOSUCH + 1');
  assert.ok(r.warnings.some((w) => /NOSUCH/.test(w)));
});

test('schema: compat name rules warn (lowercase / too long)', () => {
  const r = sch('%compat\nlongname = 1');
  assert.ok(r.warnings.some((w) => /longname/.test(w)));
});

test('schema: the spec end-to-end transform resolves before any row', () => {
  const src = [
    'if (FE == absent) FE = default(FE) end',
    'CONTAM = (SIO2 + AL2O3 + P) / FE',
    'if (FE >= 60 and CONTAM <= 0.12)',
    '   CLASS = "ORE"',
    'else',
    '   CLASS = "WASTE"',
    'end',
    'saveonly(IJK, FE, SIO2, AL2O3, P, CONTAM, CLASS)',
  ].join('\n');
  const r = sch(src, [
    { name: 'IJK', type: 'int' }, { name: 'FE', type: 'float' }, { name: 'SIO2', type: 'float' },
    { name: 'AL2O3', type: 'float' }, { name: 'P', type: 'float' },
  ]);
  assert.deepEqual(r.columns.map((c) => c.name), ['IJK', 'FE', 'SIO2', 'AL2O3', 'P', 'CONTAM', 'CLASS']);
  assert.equal(col(r, 'CONTAM').vtype, 'float');
  assert.equal(col(r, 'CLASS').vtype, 'string');
});
