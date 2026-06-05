// @gcu/over — lexer + parser (the v0 row-map parse front-end). The schema pass,
// the `over` AIR lowerer, and the driver land next; this pins text → AST.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lex, OverLexError } from '../ext/over/src/lex.js';
import { parse, OverParseError } from '../ext/over/src/parse.js';
import { schemaPass, inferType, unify } from '../ext/over/src/schema.js';
import { compile } from '../ext/over/src/api.js';

const ROWS = [
  { IJK: 1, FE: 64, SIO2: 3, AL2O3: 1, P: 0.05, LITHO: 'OX' },
  { IJK: 2, FE: 58, SIO2: 6, AL2O3: 2, P: 0.10, LITHO: 'OX' },
  { IJK: 3, FE: 30, SIO2: 20, AL2O3: 8, P: 0.20, LITHO: 'SU' },
];
const run = (src, rows = ROWS, opts = {}) => compile(src, opts).run(rows).rows;

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

// ── execution (OVER actually transforms rows) ──
test('run: mutate adds a column, passes others through', () => {
  const r = run('FE_N = FE / 100');
  assert.equal(r[0].FE_N, 0.64); assert.equal(r[0].FE, 64);
});

test('run: match classifies', () => {
  const r = run('ORETYPE = match FE { >=64:"HEMATITE", >=58:"ITABIRITE", _:"WASTE" }');
  assert.deepEqual(r.map((x) => x.ORETYPE), ['HEMATITE', 'ITABIRITE', 'WASTE']);
});

test('run: if/elseif/else classification', () => {
  const src = 'if (FE >= 64)\n T = "HEM"\nelseif (FE >= 58)\n T = "ITA"\nelse\n T = "WASTE"\nend';
  assert.deepEqual(run(src).map((x) => x.T), ['HEM', 'ITA', 'WASTE']);
});

test('run: relational → bool; bool coerces to 1/0 in arithmetic', () => {
  assert.deepEqual(run('HI = FE >= 62').map((x) => x.HI), [true, false, false]);
  assert.deepEqual(run('WT = (FE >= 62) * 10').map((x) => x.WT), [10, 0, 0]);
});

test('run: absent propagates; ?? coalesces; == absent is a presence check', () => {
  const rows = [{ FE: null }, { FE: 5 }];
  assert.deepEqual(run('X = FE + 1', rows).map((x) => x.X), [NaN, 6]);   // numeric absent → NaN (the keystone)
  assert.deepEqual(run('X = FE ?? 0', rows).map((x) => x.X), [0, 5]);
  assert.deepEqual(run('X = FE == absent', rows).map((x) => x.X), [true, false]);   // isAbsent recognizes null + NaN
  assert.deepEqual(run('X = FE == absent', [{ FE: NaN }, { FE: 5 }]).map((x) => x.X), [true, false]);
});

test('run: delete drops rows (filter)', () => {
  const r = run('if (FE < 50) delete end');
  assert.deepEqual(r.map((x) => x.FE), [64, 58]);
});

test('run: exit stops the stream', () => {
  const r = run('STOP = FE\nif (FE < 60) exit end');
  assert.deepEqual(r.map((x) => x.STOP), [64, 58]);   // row 3 never reached
});

test('run: saveonly projects the output', () => {
  const r = run('G = SIO2 + AL2O3\nsaveonly(FE, G)');
  assert.deepEqual(Object.keys(r[0]), ['FE', 'G']);
  assert.equal(r[0].G, 4);
});

test('run: let is scratch — computed but not output', () => {
  const r = run('let ratio = SIO2 / FE\nRATIO = ratio * 100');
  assert.ok('RATIO' in r[0]); assert.ok(!('ratio' in r[0]));
  assert.ok(Math.abs(r[0].RATIO - 300 / 64) < 1e-9);
});

test('run: per-column default fills absent', () => {
  const rows = [{ P: null }, { P: 0.1 }];
  assert.deepEqual(run('P: float default 0 = P ?? default(P)', rows).map((x) => x.P), [0, 0.1]);
});

test('run: maxia ignores absent (the EXTRA twin)', () => {
  const rows = [{ A: 1, B: null }, { A: null, B: 2 }, { A: 3, B: 4 }];
  assert.deepEqual(run('BEST = maxia(A, B)', rows).map((x) => x.BEST), [1, 2, 4]);
});

test('run: the spec end-to-end transform', () => {
  const src = [
    'if (FE == absent) FE = default(FE) end',
    'CONTAM = (SIO2 + AL2O3 + P) / FE',
    'if (FE >= 60 and CONTAM <= 0.12)',
    '   CLASS = "ORE"',
    'else',
    '   CLASS = "WASTE"',
    'end',
    'saveonly(IJK, FE, CONTAM, CLASS)',
  ].join('\n');
  const r = run(src, [
    { IJK: 1, FE: 64, SIO2: 3, AL2O3: 1, P: 0.05 },
    { IJK: 2, FE: 58, SIO2: 6, AL2O3: 2, P: 0.10 },
  ]);
  assert.deepEqual(Object.keys(r[0]), ['IJK', 'FE', 'CONTAM', 'CLASS']);
  assert.deepEqual(r.map((x) => x.CLASS), ['ORE', 'WASTE']);
  assert.ok(Math.abs(r[0].CONTAM - (3 + 1 + 0.05) / 64) < 1e-9);
});

test('compile: preview schema + emitted source are exposed', () => {
  const t = compile('FE_N = FE / 100\nsaveonly(FE, FE_N)', { inputSchema: QF });
  assert.deepEqual(t.outputColumns.map((c) => c.name), ['FE', 'FE_N']);
  assert.equal(typeof t.source, 'string');
  assert.match(t.source, /_over\.div/);
});

// ── windows (the `over` feature) ──
test('parse: window postfix binds tighter than arithmetic', () => {
  const v = stmts('FE_N = FE / mean(FE) over LITHO')[0].value;
  assert.equal(v.op, '/');
  assert.equal(v.right.type, 'Window');
  assert.equal(v.right.agg.name, 'mean');
  assert.deepEqual(v.right.group, ['LITHO']);
  assert.equal(stmts('Z = mean(FE) over all')[0].value.group, 'all');
});

test('schema: window columns type by their aggregate', () => {
  const r = sch('M = mean(FE) over LITHO\nN = count() over all\nS = sum(IJK) over LITHO');
  assert.equal(col(r, 'M').vtype, 'float');
  assert.equal(col(r, 'N').vtype, 'int');
  assert.equal(col(r, 'S').vtype, 'int');     // sum of an int column
});

test('run: grouped mean (domain-relative grade)', () => {
  const r = run('FE_N = FE / mean(FE) over LITHO');   // OX mean 61, SU mean 30
  assert.ok(Math.abs(r[0].FE_N - 64 / 61) < 1e-9);
  assert.ok(Math.abs(r[1].FE_N - 58 / 61) < 1e-9);
  assert.equal(r[2].FE_N, 1);
});

test('run: count() / sum() over a group', () => {
  assert.deepEqual(run('N = count() over LITHO').map((x) => x.N), [2, 2, 1]);
  assert.deepEqual(run('S = sum(FE) over LITHO').map((x) => x.S), [122, 122, 30]);
});

test('run: whole-table aggregate (over all)', () => {
  const r = run('D = FE - mean(FE) over all');         // mean = 152/3
  const m = 152 / 3;
  assert.ok(Math.abs(r[0].D - (64 - m)) < 1e-9);
  assert.ok(Math.abs(r[2].D - (30 - m)) < 1e-9);
});

test('run: a z-score composes two whole-table windows', () => {
  const r = run('Z = (FE - mean(FE) over all) / (std(FE) over all)');
  const xs = [64, 58, 30], m = (64 + 58 + 30) / 3;
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length);
  assert.ok(Math.abs(r[0].Z - (64 - m) / sd) < 1e-9);
});

test('run: window aggregates ignore absent', () => {
  const rows = [{ G: 'A', V: 10 }, { G: 'A', V: null }, { G: 'A', V: 20 }];
  assert.deepEqual(run('M = mean(V) over G', rows).map((x) => x.M), [15, 15, 15]);
});

test('compile: a non-aggregate over a group is rejected', () => {
  assert.throws(() => compile('X = foo(FE) over LITHO'), /not a window aggregate/);
});
