// @gcu/strata working model — values, table+overlay, ingest, loom provider.
// Pure; zero DOM. The recon-injected path imports recon's real sniff.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { coerceValue, fmtCell, NULL_TOKENS } from '../ext/strata/src/values.js';
import { createTable } from '../ext/strata/src/table.js';
import { tableFromCsv, builtinSniff, detectCsvDelimiter } from '../ext/strata/src/ingest.js';
import { createTableProvider } from '../ext/strata/src/provider.js';
import { compileFormula, extractDeps, FORMULA_ERROR } from '../ext/strata/src/formula.js';
import { createView } from '../ext/strata/src/view.js';
import { groupBy, AGG_OPS } from '../ext/strata/src/aggregate.js';
import { writeStrata, readStrata } from '../ext/strata/src/document.js';
import { sniff } from '../ext/recon/src/main.js';
import { createWriter, readZip, listZip } from '../ext/archive/index.js';

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

test('table: undo/redo over overlay edits', () => {
  const t = sampleTable();
  assert.equal(t.canUndo(), false);
  t.setCell(1, 1, 9.9);
  assert.equal(t.getCell(1, 1).value, 9.9);
  assert.equal(t.canUndo(), true);

  assert.equal(t.undo(), true);                 // back to base
  assert.equal(t.getCell(1, 1).value, 1.5);
  assert.equal(t.isEdited(1, 1), false);
  assert.equal(t.dirtyCount(), 0);
  assert.equal(t.canUndo(), false);
  assert.equal(t.canRedo(), true);

  assert.equal(t.redo(), true);                 // re-apply the edit
  assert.equal(t.getCell(1, 1).value, 9.9);
  assert.equal(t.dirtyCount(), 1);
  assert.equal(t.canRedo(), false);             // nothing left to redo
  assert.equal(t.redo(), false);                // redo on empty stack is a no-op
});

test('table: undo stack is per-edit; redo cleared by a new edit', () => {
  const t = sampleTable();
  t.setCell(0, 0, 10);
  t.setCell(0, 1, 20);
  t.undo();                                     // undo the grade edit
  assert.equal(t.getCell(0, 1).value, 0.5);     // row-0 grade base
  assert.equal(t.getCell(0, 0).value, 10);      // first edit still there
  t.setCell(2, 1, 30);                          // a new edit clears redo
  assert.equal(t.canRedo(), false);
  t.undo(); t.undo();                           // undo the new edit, then the id edit
  assert.equal(t.getCell(2, 1).value, 2.5);
  assert.equal(t.getCell(0, 0).value, 1);
  assert.equal(t.dirtyCount(), 0);
});

test('table: a transaction collapses a batch into ONE undo step', () => {
  const t = sampleTable();
  t.beginTxn();
  t.setCell(0, 1, 7);
  t.setCell(1, 1, 8);
  t.setCell(2, 1, 9);
  t.endTxn();
  assert.deepEqual(t.column(1), [7, 8, 9]);
  assert.equal(t.undo(), true);                 // one undo reverts all three
  assert.deepEqual(t.column(1), [0.5, 1.5, 2.5]);
  assert.equal(t.dirtyCount(), 0);
  assert.equal(t.redo(), true);                 // one redo restores all three
  assert.deepEqual(t.column(1), [7, 8, 9]);
});

test('table: revert is undoable', () => {
  const t = sampleTable();
  t.setCell(0, 1, 5.5);
  t.revert(0, 1);
  assert.equal(t.getCell(0, 1).value, 0.5);     // reverted to base
  t.undo();                                     // undo the revert → edit is back
  assert.equal(t.getCell(0, 1).value, 5.5);
});

test('provider: header carries the active sort indicator', () => {
  const t = sampleTable();
  const v = createView(t);
  const p = createTableProvider(t, v);
  assert.equal(p.header(1).sort, undefined);
  v.setSort({ by: 'grade', dir: 'desc' });
  assert.equal(p.header(1).sort, 'desc');       // grade column
  assert.equal(p.header(0).sort, undefined);    // id column unaffected
  v.setSort(null);
  assert.equal(p.header(1).sort, undefined);
});

// ── ingest: built-in sniffer ──

const CSV = 'id,grade,lito\n1,0.5,ox\n2,1.5,sulf\n3,,ox\n';

test('ingest: built-in sniffer infers types + parses', () => {
  assert.equal(detectCsvDelimiter('a,b,c'), ',');
  assert.equal(detectCsvDelimiter('a\tb\tc'), '\t');
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

test('provider: setHighlight tints rows (brushing) + maps through a view + clears', () => {
  const t = sampleTable();
  const p = createTableProvider(t);
  assert.equal(p.highlightCount, 0);
  assert.ok(!(p.cellAt(0, 0).style && p.cellAt(0, 0).style.highlight));
  // Highlight base rows 0 and 2 — every cell in those rows carries it.
  p.setHighlight([0, 2]);
  assert.equal(p.highlightCount, 2);
  assert.equal(p.cellAt(0, 0).style.highlight, true);
  assert.equal(p.cellAt(0, 2).style.highlight, true);
  assert.ok(!(p.cellAt(1, 0).style && p.cellAt(1, 0).style.highlight));
  // Clearing removes it.
  p.setHighlight(null);
  assert.equal(p.highlightCount, 0);
  assert.ok(!(p.cellAt(0, 0).style && p.cellAt(0, 0).style.highlight));
  // Through a sorted view, highlight follows the BASE ordinal, not display pos.
  const v = createView(t);
  v.setSort({ by: 'grade', dir: 'desc' });   // grades 0.5/1.5/2.5 desc → display 0 = base 2
  const pv = createTableProvider(t, v);
  pv.setHighlight([2]);                        // base ordinal 2
  assert.equal(pv.cellAt(0, 0).style.highlight, true);   // base 2 now at display row 0
  assert.ok(!(pv.cellAt(1, 0).style && pv.cellAt(1, 0).style.highlight));
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

// ── document: .strata zip round-trip (real @gcu/archive) ──

test('document: write produces a zip with the five members', async () => {
  const t = sampleTable();
  const bytes = await writeStrata(t, { createWriter, name: 'sample', created: '2026-06-02T00:00:00Z' });
  assert.ok(bytes instanceof Uint8Array && bytes.length > 0);
  const names = listZip(bytes).map((e) => e.path).sort();
  for (const m of ['columns.json', 'document.json', 'overlay.json', 'provenance.json', 'schema.json']) {
    assert.ok(names.includes(m), `has ${m}`);
  }
  const doc = JSON.parse(new TextDecoder().decode(readZip(bytes, 'document.json')));
  assert.equal(doc.strata, 1);
  assert.equal(doc.name, 'sample');
  assert.equal(doc.rowCount, 3);
  assert.deepEqual(doc.columns, [
    { name: 'id', encoding: 'json' }, { name: 'grade', encoding: 'json' }, { name: 'lito', encoding: 'json' },
  ]);
});

test('document: round-trip preserves base, schema, and the overlay', async () => {
  const t = tableFromCsv('X,Au_gpt,LITO\n1005,1.2,BIF\n1015,0.8,SHALE\n1025,,OX\n', { sniff });
  t.commitRaw(0, 1, '5.5');     // edit Au_gpt row 0
  assert.equal(t.dirtyCount(), 1);

  const bytes = await writeStrata(t, { createWriter, name: 'rt', source: 'test.csv' });
  const { table: t2, document } = readStrata(bytes, { readZip });

  // schema (incl. recon extensions) survived
  assert.equal(document.name, 'rt');
  const au = t2.schema.find((s) => s.name === 'Au_gpt');
  assert.equal(au.unit, 'g/t');
  assert.equal(au.analyte, 'Au');

  // base survived (the edited cell's BASE, not the patched value)
  assert.equal(t2.baseValue(0, 1), 1.2);
  assert.equal(t2.baseValue(2, 1), null);   // empty cell stayed null

  // overlay survived → merged read shows the edit, base recoverable
  assert.equal(t2.dirtyCount(), 1);
  assert.deepEqual(t2.getCell(0, 1), { value: 5.5, edited: true, base: 1.2 });
  assert.equal(t2.getCell(1, 1).value, 0.8);

  // effective column merges correctly post-load
  assert.deepEqual(t2.columnByName('Au_gpt'), [5.5, 0.8, null]);
});

test('document: a clean (unedited) table round-trips with an empty overlay', async () => {
  const t = sampleTable();
  const bytes = await writeStrata(t, { createWriter });
  const { table: t2 } = readStrata(bytes, { readZip });
  assert.equal(t2.dirtyCount(), 0);
  assert.deepEqual(t2.column(1), [0.5, 1.5, 2.5]);
});

test('document: rejects non-strata bytes and a future format version', async () => {
  const z = createWriter('memory', { format: 'zip' });
  await z.addFile('hello.txt', new TextEncoder().encode('hi'));
  const notStrata = await z.close();
  assert.throws(() => readStrata(notStrata, { readZip }), /not a .strata document/);

  const z2 = createWriter('memory', { format: 'zip' });
  await z2.addFile('document.json', new TextEncoder().encode(JSON.stringify({ strata: 99, rowCount: 0, columns: [] })));
  const future = await z2.close();
  assert.throws(() => readStrata(future, { readZip }), /newer than this build/);
});

test('document: missing injected archive throws a clear error', async () => {
  await assert.rejects(() => writeStrata(sampleTable(), {}), /createWriter.*required/);
  assert.throws(() => readStrata(new Uint8Array([1, 2, 3]), {}), /readZip.*required/);
});

// ── formula + derived columns ──

test('formula: extractDeps finds column refs only; compile evaluates', () => {
  assert.deepEqual(extractDeps('grade * tonnes + 1', ['grade', 'tonnes', 'lito']), ['grade', 'tonnes']);
  assert.deepEqual(extractDeps('Math.max(a, b)', ['a', 'b']), ['a', 'b']); // Math not a column
  const { deps, fn } = compileFormula('grade * tonnes', ['grade', 'tonnes']);
  assert.deepEqual(deps, ['grade', 'tonnes']);
  assert.equal(fn(2, 3), 6);
  assert.throws(() => compileFormula('grade * * 2', ['grade']), /compile error/);
});

function gtTable() {
  return createTable({
    schema: [{ name: 'grade', type: 'number' }, { name: 'tonnes', type: 'number' }],
    columns: [[2, 4, 6], [10, 20, 30]],
    nrows: 3,
  });
}

test('derived: a formula column computes from base, marked derived', () => {
  const t = gtTable();
  const c = t.addDerivedColumn({ name: 'metal', formula: 'grade * tonnes', unit: 'kg' });
  assert.equal(c, 2);
  assert.equal(t.cols, 3);
  assert.equal(t.isDerived(2), true);
  assert.deepEqual(t.column(2), [20, 80, 180]);
  assert.deepEqual(t.getCell(1, 2), { value: 80, edited: false, base: null, derived: true });
  assert.equal(t.dirtyCount(), 0);          // derived columns are not edits
});

test('derived: recomputes when an upstream base cell is edited', () => {
  const t = gtTable();
  t.addDerivedColumn({ name: 'metal', formula: 'grade * tonnes' });
  assert.equal(t.getCell(0, 2).value, 20);
  t.commitRaw(0, 0, '5');                    // grade[0] 2 → 5
  assert.equal(t.getCell(0, 2).value, 50);   // 5 * 10, recomputed
  assert.equal(t.dirtyCount(), 1);           // the base edit, not the derived
});

test('derived: derived-on-derived chains, and a derived cell is not editable', () => {
  const t = gtTable();
  t.addDerivedColumn({ name: 'metal', formula: 'grade * tonnes' });
  const c2 = t.addDerivedColumn({ name: 'metal2x', formula: 'metal * 2' });
  assert.deepEqual(t.column(c2), [40, 160, 360]);
  t.setCell(0, c2, 999);                     // edit on a derived col is ignored
  assert.equal(t.getCell(0, c2).value, 40);
  assert.equal(t.dirtyCount(), 0);
});

test('derived: a per-row formula error surfaces as FORMULA_ERROR', () => {
  const t = gtTable();
  const c = t.addDerivedColumn({ name: 'bad', formula: 'grade.nope.deep' });
  assert.equal(t.column(c)[0], FORMULA_ERROR);
  assert.equal(t.displayAt(0, c), '#ERR');
});

test('derived: a self/forward reference is a free-variable error, not a crash', () => {
  // Deps are fixed at add time and forward refs are impossible, so a true cycle
  // can't form via addDerivedColumn (the cycle guard is forward-insurance for a
  // future formula-EDIT path that could re-point a column). A name that isn't a
  // column when compiled is a free variable → per-row FORMULA_ERROR.
  const t = gtTable();
  const c = t.addDerivedColumn({ name: 'selfish', formula: 'selfish + 1' });
  assert.equal(t.column(c)[0], FORMULA_ERROR);
});

test('provider: derived cell renders state derived; error cell renders #ERR', () => {
  const t = gtTable();
  t.addDerivedColumn({ name: 'metal', formula: 'grade * tonnes' });
  t.addDerivedColumn({ name: 'bad', formula: 'grade.x.y' });
  const p = createTableProvider(t);
  const d = p.cellAt(0, 2);
  assert.equal(d.state, 'derived');
  assert.equal(d.value, 20);
  const e = p.cellAt(0, 3);
  assert.equal(e.state, 'error');
  assert.equal(e.style.text, '#ERR');
  // commit on a derived column is ignored
  p.commit(0, 2, '123');
  assert.equal(t.getCell(0, 2).value, 20);
});

// ── view: sort / filter pipeline ──

function viewTable() {
  return createTable({
    schema: [{ name: 'id', type: 'number' }, { name: 'grade', type: 'number' }, { name: 'dom', type: 'category' }],
    columns: [[1, 2, 3, 4], [2.5, 0.8, 4.2, 1.1], ['ox', 'sulf', 'ox', 'sulf']],
    nrows: 4,
  });
}

test('view: identity by default', () => {
  const v = createView(viewTable());
  assert.equal(v.length, 4);
  assert.deepEqual(v.rows(), [0, 1, 2, 3]);
  assert.equal(v.active, false);
});

test('view: sort ascending/descending, nulls last', () => {
  const t = viewTable();
  t.setCell(1, 1, null); // grade[1] → null
  const v = createView(t);
  v.setSort({ by: 'grade', dir: 'asc' });
  // grades: id1=2.5, id2=null, id3=4.2, id4=1.1 → asc: 1.1(id4),2.5(id1),4.2(id3),null(id2)
  assert.deepEqual(v.rows(), [3, 0, 2, 1]);
  v.setSort({ by: 'grade', dir: 'desc' });
  assert.deepEqual(v.rows(), [2, 0, 3, 1]); // 4.2,2.5,1.1,null(last)
});

test('view: filter is a boolean formula (same engine as derived columns)', () => {
  const v = createView(viewTable());
  v.setFilter('grade > 2');
  assert.deepEqual(v.rows(), [0, 2]); // 2.5, 4.2
  v.setFilter('dom == "sulf" && grade < 2');
  assert.deepEqual(v.rows(), [1, 3]); // id2(0.8) + id4(1.1), both sulf & <2
  v.setFilter(null);
  assert.deepEqual(v.rows(), [0, 1, 2, 3]);
});

test('view: filter then sort compose (pipeline order)', () => {
  const v = createView(viewTable());
  v.setFilter('dom == "ox"');     // id1(2.5), id3(4.2) → rows 0,2
  v.setSort({ by: 'grade', dir: 'desc' });
  assert.deepEqual(v.rows(), [2, 0]); // 4.2 then 2.5
});

test('view: edits do not auto-re-sort; reapply is explicit (§4.3)', () => {
  const t = viewTable();
  const v = createView(t);
  v.setSort({ by: 'grade', dir: 'asc' }); // [1,3,0,2] = 0.8,1.1,2.5,4.2
  assert.deepEqual(v.rows(), [1, 3, 0, 2]);
  t.commitRaw(1, 1, '99'); // grade[1] 0.8 → 99, but the view stays put
  assert.deepEqual(v.rows(), [1, 3, 0, 2]);
  v.reapply();             // explicit re-apply re-sorts
  assert.deepEqual(v.rows(), [3, 0, 2, 1]); // 1.1,2.5,4.2,99
});

test('view: a filter syntax error throws (caller surfaces it)', () => {
  const v = createView(viewTable());
  assert.throws(() => v.setFilter('grade >'), /sift|unexpected/);  // @gcu/sift parse error
});

test('provider+view: display rows map to underlying rows; row header shows base #', () => {
  const t = viewTable();
  const v = createView(t);
  v.setSort({ by: 'grade', dir: 'desc' }); // [2,0,3,1]
  const p = createTableProvider(t, v);
  assert.equal(p.dims().rows, 4);
  // display row 0 = underlying row 2 (grade 4.2)
  assert.equal(p.cellAt(0, 1).value, 4.2);
  assert.equal(p.rowHeader(0), 3); // underlying row 2 → base row number 3
  // committing display row 0 edits underlying row 2
  p.commit(0, 1, '7.7');
  assert.equal(t.getCell(2, 1).value, 7.7);
  assert.equal(t.getCell(2, 1).edited, true);
});

// ── aggregate: group-by ──

function assayTable() {
  return createTable({
    schema: [{ name: 'dom', type: 'category' }, { name: 'grade', type: 'number', unit: 'g/t' }, { name: 'tonnes', type: 'number', unit: 't' }],
    columns: [
      ['ox', 'ox', 'sulf', 'ox', 'sulf'],
      [1.0, 3.0, 2.0, null, 4.0],
      [10, 20, 30, 40, 50],
    ],
    nrows: 5,
  });
}

test('groupBy: count + mean/sum/min/max per group, with unit propagation', () => {
  const t = assayTable();
  const g = groupBy(t, {
    by: 'dom',
    aggs: [{ op: 'count', as: 'n' }, { op: 'mean', col: 'grade' }, { op: 'sum', col: 'tonnes' },
           { op: 'min', col: 'grade' }, { op: 'max', col: 'grade' }],
  });
  assert.equal(g.nrows, 2);                       // ox, sulf
  assert.deepEqual(g.schema.map((s) => s.name), ['dom', 'n', 'mean_grade', 'sum_tonnes', 'min_grade', 'max_grade']);
  // unit propagation: mean/min/max of grade keep g/t; sum of tonnes keeps t; count unitless
  assert.equal(g.schema.find((s) => s.name === 'mean_grade').unit, 'g/t');
  assert.equal(g.schema.find((s) => s.name === 'sum_tonnes').unit, 't');
  assert.equal(g.schema.find((s) => s.name === 'n').unit, undefined);

  // ox: grades 1,3,(null) → count 3, mean 2 (null skipped), tonnes 10+20+40=70, min 1, max 3
  const oxRow = g.columnByName('dom').indexOf('ox');
  assert.equal(g.columnByName('n')[oxRow], 3);
  assert.equal(g.columnByName('mean_grade')[oxRow], 2);
  assert.equal(g.columnByName('sum_tonnes')[oxRow], 70);
  assert.equal(g.columnByName('min_grade')[oxRow], 1);
  assert.equal(g.columnByName('max_grade')[oxRow], 3);
  // sulf: grades 2,4 → mean 3, tonnes 80
  const sulfRow = g.columnByName('dom').indexOf('sulf');
  assert.equal(g.columnByName('mean_grade')[sulfRow], 3);
  assert.equal(g.columnByName('sum_tonnes')[sulfRow], 80);
});

test('groupBy: the result is a normal StrataTable (composes)', () => {
  const g = groupBy(assayTable(), { by: 'dom', aggs: [{ op: 'count', as: 'n' }] });
  // can derive on it, view it, group it again
  g.addDerivedColumn({ name: 'pct', formula: 'n * 20' });
  assert.equal(g.getCell(0, g.cols - 1).value, g.getCell(0, 1).value * 20);
  const v = createView(g);
  v.setSort({ by: 'n', dir: 'desc' });
  assert.equal(v.length, 2);
});

test('groupBy: respects a rowIndices subset (the filtered set)', () => {
  const t = assayTable();
  const v = createView(t);
  v.setFilter('grade != null && grade >= 2'); // rows: idx1(ox,3), idx2(sulf,2), idx4(sulf,4)
  const g = groupBy(t, { by: 'dom', aggs: [{ op: 'count', as: 'n' }, { op: 'mean', col: 'grade' }] }, v.rows());
  const ox = g.columnByName('dom').indexOf('ox');
  const sulf = g.columnByName('dom').indexOf('sulf');
  assert.equal(g.columnByName('n')[ox], 1);   // only idx1
  assert.equal(g.columnByName('n')[sulf], 2); // idx2, idx4
  assert.equal(g.columnByName('mean_grade')[sulf], 3); // (2+4)/2
});

test('groupBy: multi-key + error guards', () => {
  const t = createTable({
    schema: [{ name: 'a', type: 'category' }, { name: 'b', type: 'category' }, { name: 'v', type: 'number' }],
    columns: [['x', 'x', 'y'], ['p', 'q', 'p'], [1, 2, 3]],
    nrows: 3,
  });
  const g = groupBy(t, { by: ['a', 'b'], aggs: [{ op: 'sum', col: 'v' }] });
  assert.equal(g.nrows, 3); // (x,p),(x,q),(y,p)
  assert.deepEqual(AGG_OPS, ['count', 'sum', 'mean', 'min', 'max']);
  assert.throws(() => groupBy(t, { by: 'nope', aggs: [{ op: 'count' }] }), /unknown key/);
  assert.throws(() => groupBy(t, { by: 'a', aggs: [{ op: 'bogus' }] }), /unknown op/);
  assert.throws(() => groupBy(t, { by: 'a', aggs: [{ op: 'sum' }] }), /needs a column/);
});

test('document: derived columns round-trip as formula (not stored data)', async () => {
  const t = gtTable();
  t.addDerivedColumn({ name: 'metal', formula: 'grade * tonnes', unit: 'kg' });
  t.commitRaw(1, 0, '7');                     // edit grade[1] 4 → 7 (metal[1] → 140)

  const bytes = await writeStrata(t, { createWriter, name: 'd' });
  // derived data must NOT be in columns.json — only its formula in schema.json
  const cols = JSON.parse(new TextDecoder().decode(readZip(bytes, 'columns.json')));
  assert.ok(!('metal' in cols), 'derived column not stored as data');
  const fields = JSON.parse(new TextDecoder().decode(readZip(bytes, 'schema.json'))).fields;
  assert.equal(fields.find((f) => f.name === 'metal').formula, 'grade * tonnes');

  const { table: t2 } = readStrata(bytes, { readZip });
  assert.equal(t2.isDerived(2), true);
  assert.deepEqual(t2.column(2), [20, 140, 180]);   // recomputed incl. the edit
  assert.equal(t2.getCell(1, 0).value, 7);          // overlay survived
  assert.equal(t2.dirtyCount(), 1);
});
