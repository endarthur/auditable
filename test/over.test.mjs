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

test('parse: chained comparison desugars to and', () => {
  const v = stmts('X = 0 < FE < 100')[0].value;
  assert.equal(v.op, 'and');
  assert.equal(v.left.op, '<');    // 0 < FE
  assert.equal(v.right.op, '<');   // FE < 100
  assert.equal(v.right.left.name, 'FE');
});

test('run: chained comparison (a < b < c)', () => {
  assert.deepEqual(run('MID = 40 < FE < 60').map((x) => x.MID), [false, true, false]);   // FE 64,58,30
  assert.deepEqual(run('OK = 0 <= P and P <= 0.2').map((x) => x.OK), [true, true, true]);
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
  assert.throws(() => compile('X = foo(FE) over LITHO'), /not a window function/);
});

// ── ordered windows (running aggregates) + where ──
const DH = [
  { BHID: 'A', DEPTH: 2, LEN: 2 },
  { BHID: 'A', DEPTH: 0, LEN: 0.5 },   // deliberately out of input order
  { BHID: 'A', DEPTH: 1, LEN: 1 },
  { BHID: 'B', DEPTH: 0, LEN: 3 },
];

test('parse: window order + where clauses', () => {
  const v = stmts('R = sum(LEN) over BHID order DEPTH where LEN > 0')[0].value;
  assert.equal(v.type, 'Window');
  assert.deepEqual(v.group, ['BHID']);
  assert.equal(v.order.name, 'DEPTH');
  assert.equal(v.where.op, '>');
});

test('run: ordered window is a running aggregate (downhole accumulation)', () => {
  // running sum of LEN within BHID, in DEPTH order — mapped back to input order
  const r = run('RUNLEN = sum(LEN) over BHID order DEPTH', DH).map((x) => x.RUNLEN);
  assert.deepEqual(r, [3.5, 0.5, 1.5, 3]);
});

test('run: unordered where filters the aggregate; all group rows see it', () => {
  const W = [{ G: 'X', V: 10 }, { G: 'X', V: -5 }, { G: 'X', V: 20 }, { G: 'Y', V: 8 }];
  assert.deepEqual(run('M = mean(V) over G where V > 0', W).map((x) => x.M), [15, 15, 15, 8]);
});

test('run: ordered where — excluded rows fall out of the window (NaN)', () => {
  const W = [{ G: 'X', V: 10 }, { G: 'X', V: -5 }, { G: 'X', V: 20 }, { G: 'Y', V: 8 }];
  assert.deepEqual(run('R = sum(V) over G order V where V > 0', W).map((x) => x.R), [10, NaN, 30, 8]);
});

test('run: prev / next lag-lead over an ordered window', () => {
  assert.deepEqual(run('P = prev(LEN) over BHID order DEPTH', DH).map((x) => x.P), [1, null, 0.5, null]);
  assert.deepEqual(run('N = next(LEN) over BHID order DEPTH', DH).map((x) => x.N), [null, 1, 2, null]);
});

test('run: first / last over an ordered window', () => {
  assert.deepEqual(run('F = first(LEN) over BHID order DEPTH', DH).map((x) => x.F), [0.5, 0.5, 0.5, 3]);
  assert.deepEqual(run('L = last(LEN) over BHID order DEPTH', DH).map((x) => x.L), [2, 2, 2, 3]);
});

test('run: downhole difference via prev (LEN - prev(LEN))', () => {
  assert.deepEqual(run('D = LEN - prev(LEN) over BHID order DEPTH', DH).map((x) => x.D), [1, NaN, 0.5, NaN]);
});

test('compile: a positional window without `order` errors', () => {
  assert.throws(() => compile('X = prev(FE) over LITHO'), /needs an .order/);
});

// ── lookup / equality join (SQL-y) ──
const ASSAYS = [{ LITHO: 'HEM', VOL: 100 }, { LITHO: 'ITA', VOL: 50 }, { LITHO: 'WST', VOL: 80 }];
const DENSITIES = [{ litho: 'HEM', density: 5.0 }, { litho: 'ITA', density: 4.2 }, { litho: 'WST', density: 3.0 }];

test('parse: lookup → Lookup node (qualified value + predicate)', () => {
  const v = stmts('D = lookup densities.density where densities.litho == LITHO')[0].value;
  assert.equal(v.type, 'Lookup');
  assert.deepEqual(v.value, { type: 'Qualified', table: 'densities', col: 'density' });
  assert.equal(v.predicate.op, '==');
});

test('run: equality lookup enriches a row', () => {
  const out = compile('DENS = lookup densities.density where densities.litho == LITHO').run(ASSAYS, { densities: DENSITIES }).rows;
  assert.deepEqual(out.map((x) => x.DENS), [5.0, 4.2, 3.0]);
});

test('run: lookup left-joins (unmatched → absent); composes once assigned', () => {
  const out = compile('D = lookup densities.density where densities.litho == LITHO\nTONNES = D * VOL').run(ASSAYS, { densities: DENSITIES }).rows;
  assert.deepEqual(out.map((x) => x.TONNES), [500, 210, 240]);
  const miss = compile('D = lookup densities.density where densities.litho == LITHO').run([{ LITHO: 'XXX' }], { densities: DENSITIES }).rows;
  assert.equal(miss[0].D, null);
});

test('run: two value columns from one join share the index', () => {
  const out = compile('A = lookup t.a where t.k == K\nB = lookup t.b where t.k == K').run([{ K: 1 }], { t: [{ k: 1, a: 10, b: 20 }] }).rows;
  assert.equal(out[0].A, 10); assert.equal(out[0].B, 20);
  assert.equal(compile('A = lookup t.a where t.k == K\nB = lookup t.b where t.k == K').lookups, 1);   // deduped to one index
});

test('compile: a missing reference table throws at run', () => {
  assert.throws(() => compile('D = lookup missing.v where missing.k == K').run([{ K: 1 }], {}), /not.*provided/);
});

test('compile: malformed lookup is rejected', () => {
  assert.throws(() => compile('D = lookup t where t.k == K'), /TABLE\.column/);        // value not qualified
  assert.throws(() => compile('D = lookup t.v where t.k == K or t.j == J'), /joined by .and/);  // or not allowed
  assert.throws(() => compile('D = lookup t.v where K == J'), /compare t\.<col>/);     // no ref column
});

test('lookup inside a window aggregate is rejected (no ctx there)', () => {
  assert.throws(() => compile('M = mean(lookup t.v where t.k == K) over G').run([{ K: 1, G: 'a' }], { t: [] }),
    /not allowed inside/);
});

// ── interval (range) join — the geology join, via predicate shape ──
const DOMAINS = [
  { hole: 'DDH1', from: 0, to: 10, code: 'OX' },
  { hole: 'DDH1', from: 10, to: 25, code: 'TR' },
  { hole: 'DDH1', from: 25, to: 50, code: 'SU' },
  { hole: 'DDH2', from: 0, to: 30, code: 'OX' },
];
const SAMPLES = [
  { hole: 'DDH1', DEPTH: 5 },    // [0,10)  → OX
  { hole: 'DDH1', DEPTH: 10 },   // boundary → [10,25) TR
  { hole: 'DDH1', DEPTH: 40 },   // [25,50) → SU
  { hole: 'DDH2', DEPTH: 15 },   // [0,30)  → OX
  { hole: 'DDH1', DEPTH: 60 },   // past the last interval → absent
  { hole: 'DDH3', DEPTH: 5 },    // no such hole → absent
];

test('run: a chained range predicate makes it an interval join (domain by depth)', () => {
  const src = 'CODE = lookup domains.code where domains.hole == hole and domains.from <= DEPTH < domains.to';
  const t = compile(src);
  assert.equal(t.lookups, 1);
  assert.deepEqual(t.run(SAMPLES, { domains: DOMAINS }).rows.map((x) => x.CODE), ['OX', 'TR', 'SU', 'OX', null, null]);
});

test('run: interval join — a depth in a gap returns absent', () => {
  const G = [{ h: 'A', f: 0, t: 5, v: 'lo' }, { h: 'A', f: 10, t: 15, v: 'hi' }];   // gap [5,10)
  const probe = (d) => compile('V = lookup g.v where g.h == H and g.f <= D < g.t').run([{ H: 'A', D: d }], { g: G }).rows[0].V;
  assert.equal(probe(3), 'lo');
  assert.equal(probe(7), null);    // in the gap
  assert.equal(probe(12), 'hi');
});

test('compile: a lopsided range predicate is rejected', () => {
  assert.throws(() => compile('X = lookup t.v where t.k == K and t.lo <= D'), /one lower.*one upper/);   // only a lower bound
});

// ── aggregating join: AGG(args) where PREDICATE (the natural seam) ──
// composites down a hole; raw assays to aggregate over the overlaps.
const COMPS = [
  { hole: 'DDH1', FROM: 0, TO: 10 },
  { hole: 'DDH1', FROM: 10, TO: 20 },
  { hole: 'DDH2', FROM: 0, TO: 10 },
  { hole: 'DDH3', FROM: 0, TO: 10 },   // no assays for this hole
];
const RAW = [
  { hole: 'DDH1', from: 0, to: 4, fe: 60 },     // → comp [0,10): 4 m @ 60
  { hole: 'DDH1', from: 4, to: 10, fe: 50 },    // → comp [0,10): 6 m @ 50
  { hole: 'DDH1', from: 8, to: 16, fe: 40 },    // straddles [0,10) (2 m) and [10,20) (6 m)
  { hole: 'DDH1', from: 16, to: 24, fe: 30 },   // → comp [10,20): 4 m @ 30
  { hole: 'DDH2', from: 0, to: 10, fe: 70 },    // → comp [0,10): 10 m @ 70
];

test('parse: AGG(args) where … → JoinAgg node (no `over`)', () => {
  const v = stmts('N = count() where assays.hole == hole')[0].value;
  assert.equal(v.type, 'JoinAgg');
  assert.equal(v.agg.type, 'Call'); assert.equal(v.agg.name, 'count');
  assert.equal(v.predicate.op, '==');
});

test('run: count() over the overlapping assays (one index)', () => {
  const t = compile('N = count() where assays.hole == hole and assays.from < TO and assays.to > FROM');
  assert.equal(t.joins, 1);
  // [0,10) overlaps the first three; [10,20) overlaps the straddler + the 4th; DDH2 one; DDH3 none.
  assert.deepEqual(t.run(COMPS, { assays: RAW }).rows.map((x) => x.N), [3, 2, 1, 0]);
});

test('run: max(assays.fe) over the overlaps (matched-row ref)', () => {
  const out = compile('MAXFE = max(assays.fe) where assays.hole == hole and assays.from < TO and assays.to > FROM')
    .run(COMPS, { assays: RAW }).rows;
  assert.deepEqual(out.map((x) => x.MAXFE), [60, 40, 70, NaN]);   // no match → absent (NaN)
});

test('run: wmean(assays.fe, overlap) is length-weighted compositing', () => {
  const out = compile('GRADE = wmean(assays.fe, overlap) where assays.hole == hole and assays.from < TO and assays.to > FROM')
    .run(COMPS, { assays: RAW }).rows;
  // [0,10): (4·60 + 6·50 + 2·40)/(4+6+2) = (240+300+80)/12 = 620/12
  assert.ok(Math.abs(out[0].GRADE - 620 / 12) < 1e-9);
  // [10,20): (6·40 + 4·30)/10 = (240+120)/10 = 36
  assert.ok(Math.abs(out[1].GRADE - 36) < 1e-9);
  assert.equal(out[2].GRADE, 70);        // DDH2: single 10 m @ 70
  assert.ok(Number.isNaN(out[3].GRADE)); // DDH3: no overlaps → absent
});

test('run: equality-only join aggregates the whole matched group', () => {
  const out = compile('AVG = mean(assays.fe) where assays.hole == hole').run(COMPS, { assays: RAW }).rows;
  assert.ok(Math.abs(out[0].AVG - (60 + 50 + 40 + 30) / 4) < 1e-9);   // all DDH1 assays (no interval)
  assert.equal(out[2].AVG, 70);
  assert.ok(Number.isNaN(out[3].AVG));
});

test('run: a join aggregate composes once assigned', () => {
  const out = compile([
    'G = wmean(assays.fe, overlap) where assays.hole == hole and assays.from < TO and assays.to > FROM',
    'LEN = TO - FROM',
    'METAL = G * LEN',
  ].join('\n')).run(COMPS, { assays: RAW }).rows;
  assert.ok(Math.abs(out[0].METAL - (620 / 12) * 10) < 1e-9);
});

test('compile: malformed join aggregates are rejected', () => {
  assert.throws(() => compile('X = median(assays.fe) where assays.hole == hole'), /must be count\/sum/);  // not an aggregate
  assert.throws(() => compile('X = count(assays.fe) where assays.hole == hole'), /count\(\) takes no/);    // count + arg
  assert.throws(() => compile('X = wmean(assays.fe) where assays.hole == hole'), /value and a weight/);    // wmean needs 2
  assert.throws(() => compile('X = mean(assays.fe) where K == hole'), /must compare a table column/);      // no qualified ref
});

test('compile: a join table missing at run throws', () => {
  assert.throws(() => compile('X = count() where assays.hole == hole').run(COMPS, {}), /not.*provided/);
});

test('schema: a join aggregate types as int (count) / float (rest)', () => {
  const c = compile('N = count() where t.k == K\nA = mean(t.v) where t.k == K', { inputSchema: [{ name: 'K', type: 'string' }] });
  const by = Object.fromEntries(c.outputColumns.map((x) => [x.name, x.vtype]));
  assert.equal(by.N, 'int'); assert.equal(by.A, 'float');
});

// ── check: the validation report (observational) ──
test('parse: check with + without a label', () => {
  const a = stmts('check "from before to": FROM < TO')[0];
  assert.equal(a.type, 'Check'); assert.equal(a.label, 'from before to'); assert.equal(a.test.op, '<');
  const b = stmts('check FROM < TO')[0];
  assert.equal(b.type, 'Check'); assert.equal(b.label, null);
});

test('run: a check reports pass/fail + samples the offending rows, leaving rows unchanged', () => {
  const rows = [{ FROM: 0, TO: 10 }, { FROM: 10, TO: 5 }, { FROM: 20, TO: 30 }];   // row 2 is inverted
  const res = compile('check "from before to": FROM < TO').run(rows);
  assert.equal(res.checks.length, 1);
  const c = res.checks[0];
  assert.equal(c.rule, 'from before to');
  assert.equal(c.passed, 2); assert.equal(c.failed, 1);
  assert.deepEqual(c.sample, [{ FROM: 10, TO: 5 }]);            // the failing INPUT row
  assert.deepEqual(res.rows, rows);                            // observational — rows pass through
});

test('run: an unlabeled rule is labeled by its predicate text', () => {
  const res = compile('check FROM < TO').run([{ FROM: 5, TO: 1 }]);
  assert.equal(res.checks[0].rule, 'FROM < TO');
});

test('run: a check in an if-branch only counts when the branch runs', () => {
  const src = 'if TYPE == "ore"\n  check "ore has grade": present(FE)\nend';
  const res = compile(src).run([{ TYPE: 'ore', FE: 62 }, { TYPE: 'waste' }, { TYPE: 'ore' }]);   // 3rd: ore, no FE
  assert.equal(res.checks[0].passed, 1); assert.equal(res.checks[0].failed, 1);   // waste row never checked
});

test('run: a check can use a window (downhole gap detection)', () => {
  const rows = [
    { hole: 'A', FROM: 0, TO: 10 }, { hole: 'A', FROM: 10, TO: 20 },   // contiguous
    { hole: 'A', FROM: 25, TO: 30 },                                   // gap [20,25)
  ];
  const src = 'PREV_TO = prev(TO) over hole order FROM\ncheck "no gap": FROM == PREV_TO or present(PREV_TO) == false';
  const res = compile(src).run(rows);
  const c = res.checks[0];
  assert.equal(c.failed, 1);                       // the gapped interval
  assert.equal(c.sample[0].FROM, 25);
});

test('run: a check can use a join aggregate (every composite has assays)', () => {
  const res = compile('check "has assays": count() where assays.hole == hole and assays.from < TO and assays.to > FROM')
    .run(COMPS, { assays: RAW });
  assert.equal(res.checks[0].failed, 1);           // DDH3 has none
  assert.equal(res.checks[0].sample[0].hole, 'DDH3');
});

test('compile: check counts + a missing-column rule still warns (no output column)', () => {
  const c = compile('Y = FROM + 1\ncheck FROM < NOPE', { inputSchema: [{ name: 'FROM', type: 'int' }] });
  assert.equal(c.checks, 1);
  assert.ok(c.warnings.some((w) => /NOPE/.test(w)));               // use-before-def warning
  assert.deepEqual(c.outputColumns.map((x) => x.name), ['FROM', 'Y']);   // check adds no column
});

// ── require (the enforcing check) + bin ──
test('parse: require → Check node with error severity', () => {
  const a = stmts('require "from before to": FROM < TO')[0];
  assert.equal(a.type, 'Check'); assert.equal(a.severity, 'error'); assert.equal(a.label, 'from before to');
  assert.equal(stmts('check FROM < TO')[0].severity, 'warn');
});

test('run: a passing require does not throw; reports with error severity', () => {
  const res = compile('require "from before to": FROM < TO').run([{ FROM: 0, TO: 10 }, { FROM: 1, TO: 2 }]);
  assert.equal(res.checks[0].severity, 'error');
  assert.equal(res.checks[0].failed, 0);
});

test('run: a failing require throws OverCheckError carrying the full report', () => {
  let err;
  try { compile('require "from before to": FROM < TO').run([{ FROM: 0, TO: 10 }, { FROM: 10, TO: 5 }]); }
  catch (e) { err = e; }
  assert.ok(err, 'expected a throw');
  assert.equal(err.name, 'OverCheckError');
  assert.match(err.message, /1 required rule\(s\) failed/);
  assert.equal(err.checks[0].failed, 1);
  assert.equal(err.checks[0].sample[0].TO, 5);
});

test('run: a failing check (warn) alongside a passing require does NOT throw', () => {
  const res = compile('check "warnme": FROM < 0\nrequire "ok": FROM < TO').run([{ FROM: 5, TO: 10 }]);
  assert.equal(res.checks[0].failed, 1);    // the warn failed
  assert.equal(res.checks[1].failed, 0);    // the require passed → no throw
});

test('run: bin → 0-based class index; binlabel → readable range; absent → absent', () => {
  const out = compile('B = bin(GRADE, 40, 50, 60)\nL = binlabel(GRADE, 40, 50, 60)')
    .run([{ GRADE: 30 }, { GRADE: 45 }, { GRADE: 55 }, { GRADE: 70 }, { GRADE: null }]).rows;
  assert.deepEqual(out.map((x) => x.B), [0, 1, 2, 3, NaN]);
  assert.deepEqual(out.map((x) => x.L), ['< 40', '40 - 50', '50 - 60', '>= 60', null]);
});

test('run: bin → chain → window (mean grade per class; windows group by input cols)', () => {
  const classed = compile('CLASS = bin(FE, 50)').run([{ FE: 40 }, { FE: 45 }, { FE: 60 }, { FE: 70 }]).rows;
  const out = compile('M = mean(FE) over CLASS').run(classed).rows;   // CLASS is now an input column
  assert.equal(out[0].M, 42.5);    // class 0: (40+45)/2
  assert.equal(out[2].M, 65);      // class 1: (60+70)/2
});

test('schema: bin types int, binlabel types string', () => {
  const c = compile('B = bin(G, 1, 2)\nL = binlabel(G, 1, 2)', { inputSchema: [{ name: 'G', type: 'float' }] });
  const by = Object.fromEntries(c.outputColumns.map((x) => [x.name, x.vtype]));
  assert.equal(by.B, 'int'); assert.equal(by.L, 'string');
});

// ── the notebook tag ──
test('tag: over`…`(rows) compiles + applies; rows carry .columns', async () => {
  const { over } = await import('../ext/over/src/tag.js');
  const t = over`
    FE_N    = FE / mean(FE) over LITHO
    ORETYPE = match FE { >=62:"HEMATITE", >=58:"ITABIRITE", _:"WASTE" }
    saveonly(FE, FE_N, ORETYPE)
  `;
  const out = t(ROWS);
  assert.deepEqual(out.map((r) => r.ORETYPE), ['HEMATITE', 'ITABIRITE', 'WASTE']);
  assert.ok(Math.abs(out[0].FE_N - 64 / 61) < 1e-9);
  assert.deepEqual(out.columns.map((c) => c.name), ['FE', 'FE_N', 'ORETYPE']);   // non-enumerable
  assert.equal(typeof t.source, 'string');
});

test('tag: transforms chain (a result feeds the next over)', async () => {
  const { over } = await import('../ext/over/src/tag.js');
  const a = over`G = SIO2 + AL2O3`(ROWS);                  // G = [4, 8, 28]
  const b = over`if (G >= 5) delete end\nsaveonly(IJK, G)`(a);
  assert.deepEqual(b.map((r) => r.IJK), [1]);              // only the row with G < 5 survives
});

test('tag: tokenizer classifies keywords / functions / columns', async () => {
  const { tokenizeOver } = await import('../ext/over/src/tag.js');
  const toks = tokenizeOver('FE_N = mean(FE) over LITHO  # note');
  const byType = (ty) => toks.filter((t) => t.type === ty).map((t) => t.text);
  assert.ok(byType('fn').includes('mean'));
  assert.ok(byType('kw').includes('over'));
  assert.ok(byType('cmt').some((t) => /# note/.test(t)));
});
