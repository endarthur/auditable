// @gcu/strata working model — values, table+overlay, ingest, loom provider.
// Pure; zero DOM. The recon-injected path imports recon's real sniff.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { coerceValue, fmtCell, NULL_TOKENS } from '../ext/strata/src/values.js';
import { createTable } from '../ext/strata/src/table.js';
import { tableFromCsv, builtinSniff, detectDelimiter } from '../ext/strata/src/ingest.js';
import { createTableProvider } from '../ext/strata/src/provider.js';
import { sniff } from '../ext/recon/src/main.js';

// ── values ──

test('coerceValue: types + null vocabulary', () => {
  assert.equal(coerceValue('3.5', 'number'), 3.5);
  assert.equal(coerceValue('  42 ', 'number'), 42);
  assert.equal(coerceValue('abc', 'number'), null);   // non-numeric → null
  assert.equal(coerceValue('-9999', 'number'), null);  // mining null sentinel
  assert.equal(coerceValue('NA', 'number'), null);
  assert.equal(coerceValue('', 'string'), null);
  assert.equal(coerceValue('OXIDE', 'string'), 'OXIDE');
  assert.equal(coerceValue('ox', 'category'), 'ox');
  assert.ok(NULL_TOKENS.has('nan'));
});

test('fmtCell: faithful numbers, empty null', () => {
  assert.equal(fmtCell(null), '');
  assert.equal(fmtCell(0.035), '0.035');   // full precision, not toFixed(2)
  assert.equal(fmtCell(2.594), '2.594');
  assert.equal(fmtCell('BIF'), 'BIF');
});

// ── table + overlay ──

function sampleTable() {
  return createTable({
    schema: [{ name: 'id', type: 'number' }, { name: 'grade', type: 'number' }, { name: 'lito', type: 'category' }],
    columns: [[1, 2, 3], [0.5, 1.5, 2.5], ['ox', 'sulf', 'ox']],
    nrows: 3,
  });
}

test('table: base reads, overlay write, provenance, dirty count', () => {
  const t = sampleTable();
  assert.deepEqual(t.getCell(1, 1), { value: 1.5, edited: false, base: 1.5 });
  assert.equal(t.dirtyCount(), 0);

  t.setCell(1, 1, 9.9);
  assert.deepEqual(t.getCell(1, 1), { value: 9.9, edited: true, base: 1.5 }); // base preserved
  assert.equal(t.baseValue(1, 1), 1.5);   // immutable base untouched
  assert.equal(t.isEdited(1, 1), true);
  assert.equal(t.dirtyCount(), 1);
});

test('table: editing back to base clears the patch (no phantom dirty)', () => {
  const t = sampleTable();
  t.setCell(0, 0, 99);
  assert.equal(t.dirtyCount(), 1);
  t.setCell(0, 0, 1);             // back to base value
  assert.equal(t.dirtyCount(), 0);
  assert.equal(t.isEdited(0, 0), false);
});

test('table: revert + effective column merges base⊕overlay', () => {
  const t = sampleTable();
  t.setCell(0, 1, 7.7);
  t.setCell(2, 1, 8.8);
  assert.deepEqual(t.column(1), [7.7, 1.5, 8.8]);   // patched rows applied
  assert.deepEqual(t.columnByName('grade'), [7.7, 1.5, 8.8]);
  assert.deepEqual(t._base[1], [0.5, 1.5, 2.5]);     // base array never mutated
  t.revert(0, 1);
  assert.deepEqual(t.column(1), [0.5, 1.5, 8.8]);
});

test('table: commitRaw coerces by column type', () => {
  const t = sampleTable();
  t.commitRaw(0, 1, '12.5');
  assert.equal(t.getCell(0, 1).value, 12.5);
  t.commitRaw(0, 1, 'bogus');     // non-numeric → null
  assert.equal(t.getCell(0, 1).value, null);
});

// ── ingest: built-in sniffer ──

const CSV = 'id,grade,lito\n1,0.5,ox\n2,1.5,sulf\n3,,ox\n';

test('ingest: built-in sniffer infers types + parses', () => {
  assert.equal(detectDelimiter('a,b,c'), ',');
  assert.equal(detectDelimiter('a\tb\tc'), '\t');
  const s = builtinSniff(CSV.trim().split('\n'));
  assert.equal(s.delimiter, ',');
  assert.deepEqual(s.columns.map((c) => c.type), ['number', 'number', 'string']);

  const t = tableFromCsv(CSV);
  assert.equal(t.nrows, 3);
  assert.equal(t.cols, 3);
  assert.equal(t.getCell(0, 1).value, 0.5);
  assert.equal(t.getCell(2, 1).value, null);  // empty grade → null
  assert.equal(t.getCell(1, 2).value, 'sulf');
});

test('ingest: empty input → empty table', () => {
  const t = tableFromCsv('');
  assert.equal(t.nrows, 0);
  assert.equal(t.cols, 0);
});

// ── ingest: recon-injected rich path ──

test('ingest: recon sniff yields units/roles/analytes in the schema', () => {
  const csv = 'X,Y,Z,Au_gpt,LITO\n1005,2005,302.5,1.2,BIF\n1015,2005,302.5,0.8,SHALE\n';
  const t = tableFromCsv(csv, { sniff });
  const au = t.schema.find((s) => s.name === 'Au_gpt');
  assert.equal(au.type, 'number');
  assert.equal(au.unit, 'g/t');
  assert.equal(au.analyte, 'Au');
  const x = t.schema.find((s) => s.name === 'X');
  assert.equal(x.role, 'coord-x');
  const lito = t.schema.find((s) => s.name === 'LITO');
  assert.equal(lito.type, 'category');
  assert.equal(t.getCell(0, 3).value, 1.2);
});

// ── provider (the loom contract) ──

test('provider: dims/header/rowHeader and contract-shaped cells', () => {
  const t = sampleTable();
  const p = createTableProvider(t);
  assert.deepEqual(p.dims(), { rows: 3, cols: 3 });
  assert.deepEqual(p.header(1), { label: 'grade', type: 'number' });
  assert.equal(p.rowHeader(0), 1);

  const cell = p.cellAt(1, 1);
  assert.equal(cell.value, 1.5);
  assert.equal(cell.state, 'raw');       // matches loom CellState.RAW
  assert.equal(cell.type, 'number');     // matches loom CellType.NUMBER
  assert.equal(cell.style.text, '1.5');
});

test('provider: header shows unit suffix; commit routes to overlay as EDITED', () => {
  const t = tableFromCsv('X,Au_gpt\n1005,1.2\n1015,0.8\n', { sniff });
  const p = createTableProvider(t);
  const au = t.schema.findIndex((s) => s.name === 'Au_gpt');
  assert.equal(p.header(au).label, 'Au_gpt (g/t)');

  assert.equal(p.cellAt(0, au).state, 'raw');
  p.commit(0, au, '5.5');
  const after = p.cellAt(0, au);
  assert.equal(after.value, 5.5);
  assert.equal(after.state, 'edited');
  assert.equal(t.baseValue(0, au), 1.2);   // base untouched
});

test('provider: out-of-range + empty cells return null', () => {
  const p = createTableProvider(sampleTable());
  assert.equal(p.cellAt(-1, 0), null);
  assert.equal(p.cellAt(99, 0), null);
  assert.equal(p.cellAt(0, 99), null);
});

test('provider: onReady registers + unsubscribes (reserved async seam)', () => {
  const p = createTableProvider(sampleTable());
  let n = 0;
  const off = p.onReady(() => { n++; });
  p._notifyReady();
  assert.equal(n, 1);
  off();
  p._notifyReady();
  assert.equal(n, 1);    // unsubscribed
});
