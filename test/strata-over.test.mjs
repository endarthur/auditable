// @gcu/strata × @gcu/over — the transform bridge: a StrataTable through an OVER
// transform → a new StrataTable (the pure adapter; over's `compile` injected).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTable, transformWithOver, previewOverTransform } from '../ext/strata/src/main.js';
import { compile } from '../ext/over/src/api.js';

const tbl = () => createTable({
  schema: [
    { name: 'hole', type: 'category' },
    { name: 'FE', type: 'number', unit: '%' },
    { name: 'AU', type: 'number', unit: 'g/t' },
  ],
  columns: [
    ['DDH1', 'DDH1', 'DDH2'],
    [64, 58, null],          // DDH2 FE is absent
    [1.2, 0.8, 2.1],
  ],
  nrows: 3,
});

test('transformWithOver: strata → OVER → a new StrataTable (map / match / project)', () => {
  const { table } = transformWithOver(tbl(), `
    GRADE_X10 = FE * 10
    ORE = match FE { >=60: "ore", _: "waste" }
    saveonly(hole, FE, GRADE_X10, ORE)
  `, { compile });

  assert.deepEqual(table.schema.map((s) => s.name), ['hole', 'FE', 'GRADE_X10', 'ORE']);
  assert.equal(table.nrows, 3);
  assert.deepEqual(table.columnByName('GRADE_X10'), [640, 580, null]);   // null*10 → NaN → strata null
  assert.deepEqual(table.columnByName('ORE'), ['ore', 'waste', 'waste']); // absent FE → waste
  const types = Object.fromEntries(table.schema.map((s) => [s.name, s.type]));
  assert.equal(types.GRADE_X10, 'number');
  assert.equal(types.ORE, 'string');
});

test('transformWithOver: the result IS a table — derivable / transformable again', () => {
  const first = transformWithOver(tbl(), 'X = FE * 2\nsaveonly(hole, X)', { compile }).table;
  const second = transformWithOver(first, 'Y = X + 1', { compile }).table;
  assert.deepEqual(second.columnByName('Y'), [129, 117, null]);   // (64*2)+1, (58*2)+1, null
});

test('transformWithOver: passthrough columns keep their unit/role; output carries the report', () => {
  const res = transformWithOver(tbl(), `
    BAD = FE + AU
    check "fe present": present(FE)
  `, { compile });
  // unit checking surfaced (% + g/t)
  assert.ok(res.warnings.some((w) => /incompatible units/.test(w)));
  // the check report came back
  const chk = res.checks.find((c) => c.rule === 'fe present');
  assert.equal(chk.failed, 1);
  // a passthrough column kept its declared unit
  const fe = res.table.schema.find((s) => s.name === 'FE');
  assert.equal(fe.unit, '%');
});

test('transformWithOver: a lookup join reads another StrataTable as a reference', () => {
  const densities = createTable({
    schema: [{ name: 'litho', type: 'category' }, { name: 'rho', type: 'number', unit: 't/m3' }],
    columns: [['HEM', 'ITA'], [5.0, 4.2]],
    nrows: 2,
  });
  const main = createTable({ schema: [{ name: 'LITHO', type: 'category' }], columns: [['HEM', 'ITA', 'HEM']], nrows: 3 });
  const { table } = transformWithOver(main, 'D = lookup densities.rho where densities.litho == LITHO', { compile, tables: { densities } });
  assert.deepEqual(table.columnByName('D'), [5.0, 4.2, 5.0]);
});

test('previewOverTransform: resolves the output schema BEFORE running (no rows touched)', () => {
  const p = previewOverTransform(tbl(), 'X = FE * 2\nN = AU + 1\nsaveonly(hole, X, N)', { compile });
  assert.deepEqual(p.columns.map((c) => c.name), ['hole', 'X', 'N']);
});

test('transformWithOver: a failing `require` propagates OVER\'s gate (throws with the report)', () => {
  let err;
  try { transformWithOver(tbl(), 'require "fe present": present(FE)', { compile }); }
  catch (e) { err = e; }
  assert.ok(err, 'expected a throw');
  assert.equal(err.name, 'OverCheckError');
  assert.equal(err.checks[0].failed, 1);
});

test('transformWithOver: missing compile injection is a clear error', () => {
  assert.throws(() => transformWithOver(tbl(), 'X = FE'), /inject .*compile/);
});
