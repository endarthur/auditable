// @gcu/loom pure foundation — model + geometry. Zero DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PENDING, CellState, CellType,
  colLetter, colIndex, fmtVal, inferType, normSel, selEquals,
} from '../ext/loom/src/model.js';
import {
  colW, colXAt, colAtX, visibleColRange, totalWidth,
  rowAtY, rowYAt, visibleRowRange, totalHeight, cellAt,
} from '../ext/loom/src/geometry.js';
import { createMemoryProvider } from '../ext/loom/src/memory-provider.js';

// ── model ──

test('colLetter / colIndex round-trip', () => {
  const cases = [0, 1, 25, 26, 27, 51, 52, 701, 702, 16383];
  for (const n of cases) {
    assert.equal(colIndex(colLetter(n)), n, `round-trip ${n}`);
  }
  assert.equal(colLetter(0), 'A');
  assert.equal(colLetter(25), 'Z');
  assert.equal(colLetter(26), 'AA');
  assert.equal(colIndex('A'), 0);
  assert.equal(colIndex('AA'), 26);
  assert.equal(colIndex(''), -1);
  assert.equal(colIndex('a1'), -1);
});

test('fmtVal formats by JS type', () => {
  assert.equal(fmtVal(null), '');
  assert.equal(fmtVal(undefined), '');
  assert.equal(fmtVal(42), '42');
  assert.equal(fmtVal(3.14159), '3.14');
  assert.equal(fmtVal(true), 'TRUE');
  assert.equal(fmtVal(false), 'FALSE');
  assert.equal(fmtVal('hi'), 'hi');
  assert.equal(fmtVal(Infinity), 'Infinity');
  assert.equal(fmtVal(NaN), 'NaN');
});

test('inferType maps values to CellType', () => {
  assert.equal(inferType(null), CellType.NULL);
  assert.equal(inferType(undefined), CellType.NULL);
  assert.equal(inferType(1.5), CellType.NUMBER);
  assert.equal(inferType(true), CellType.BOOL);
  assert.equal(inferType(new Date()), CellType.DATE);
  assert.equal(inferType('x'), CellType.STRING);
});

test('PENDING is a distinct sentinel, not a value', () => {
  assert.equal(typeof PENDING, 'symbol');
  assert.notEqual(PENDING, null);
  assert.notEqual(PENDING, undefined);
});

test('CellState enum covers the documented provenance states', () => {
  for (const k of ['RAW', 'EDITED', 'DERIVED', 'ERROR', 'PENDING', 'OUT_OF_ORDER']) {
    assert.ok(CellState[k], `has ${k}`);
  }
});

test('normSel orders corners; selEquals compares rects', () => {
  assert.equal(normSel(null), null);
  assert.deepEqual(normSel({ r0: 5, c0: 3, r1: 1, c1: 0 }), { r0: 1, c0: 0, r1: 5, c1: 3 });
  assert.ok(selEquals({ r0: 5, c0: 3, r1: 1, c1: 0 }, { r0: 1, c0: 0, r1: 5, c1: 3 }));
  assert.ok(!selEquals({ r0: 0, c0: 0, r1: 0, c1: 0 }, { r0: 0, c0: 0, r1: 1, c1: 0 }));
  assert.ok(!selEquals(null, { r0: 0, c0: 0, r1: 0, c1: 0 }));
});

// ── geometry: uniform (no custom widths) ──

const uniform = { defaultColW: 100, rowH: 24, colWidths: {}, totalRows: 1000, totalCols: 50 };

test('uniform column geometry', () => {
  assert.equal(colW(uniform, 0), 100);
  assert.equal(colW(uniform, 7), 100);
  assert.equal(colXAt(uniform, 0), 0);
  assert.equal(colXAt(uniform, 3), 300);
  assert.equal(colAtX(uniform, 0), 0);
  assert.equal(colAtX(uniform, 99), 0);
  assert.equal(colAtX(uniform, 100), 1);
  assert.equal(colAtX(uniform, 350), 3);
  assert.equal(totalWidth(uniform), 5000);
});

test('uniform visibleColRange clamps to grid', () => {
  assert.deepEqual(visibleColRange(uniform, 0, 250), [0, 2]);
  assert.deepEqual(visibleColRange(uniform, 150, 250), [1, 4]);
  // scroll past the end clamps to last col
  assert.deepEqual(visibleColRange(uniform, 100000, 250), [49, 49]);
});

test('row geometry + visibleRowRange', () => {
  assert.equal(rowAtY(uniform, 0), 0);
  assert.equal(rowAtY(uniform, 23), 0);
  assert.equal(rowAtY(uniform, 24), 1);
  assert.equal(rowAtY(uniform, 250), 10);
  assert.equal(rowYAt(uniform, 10), 240);
  assert.equal(totalHeight(uniform), 24000);
  assert.deepEqual(visibleRowRange(uniform, 0, 100), [0, 5]);
  assert.deepEqual(visibleRowRange(uniform, 240, 100), [10, 15]);
});

test('cellAt maps a scroll-space point', () => {
  assert.deepEqual(cellAt(uniform, 0, 0), { row: 0, col: 0 });
  assert.deepEqual(cellAt(uniform, 350, 250), { row: 10, col: 3 });
});

// ── geometry: with custom column widths (the sparse path) ──

const custom = { defaultColW: 100, rowH: 24, colWidths: { 1: 200, 4: 50 }, totalRows: 10, totalCols: 10 };

test('custom-width colXAt accounts for prior deltas', () => {
  assert.equal(colXAt(custom, 0), 0);
  assert.equal(colXAt(custom, 1), 100);   // col 0 default
  assert.equal(colXAt(custom, 2), 300);   // 100 + 200 (col1 custom)
  assert.equal(colXAt(custom, 3), 400);   // + col2 default
  assert.equal(colXAt(custom, 4), 500);   // + col3 default
  assert.equal(colXAt(custom, 5), 550);   // + col4 custom (50)
});

test('custom-width colAtX inverts colXAt across gaps and customs', () => {
  // round-trip: every column's left edge maps back to that column
  for (let c = 0; c < custom.totalCols; c++) {
    assert.equal(colAtX(custom, colXAt(custom, c)), c, `left edge of col ${c}`);
    // a point mid-column maps to the same column
    assert.equal(colAtX(custom, colXAt(custom, c) + 10), c, `mid col ${c}`);
  }
});

test('custom-width totalWidth sums all columns', () => {
  // 10 cols: 8 default(100) + col1(200) + col4(50) = 800 + 250 = 1050
  assert.equal(totalWidth(custom), 1050);
});

// ── memory provider (the trivial reference provider) ──

function sampleProvider() {
  return createMemoryProvider({
    columns: [{ name: 'id' }, { name: 'grade' }, { name: 'domain' }],
    rows: [
      [1, 2.5, 'ox'],
      [2, 0.8, 'sulf'],
      [3, 4.21, 'ox'],
    ],
  });
}

test('memory provider: dims + inferred types + headers', () => {
  const p = sampleProvider();
  assert.deepEqual(p.dims(), { rows: 3, cols: 3 });
  assert.equal(p.columns[0].type, CellType.NUMBER);  // id
  assert.equal(p.columns[1].type, CellType.NUMBER);  // grade
  assert.equal(p.columns[2].type, CellType.STRING);  // domain
  assert.deepEqual(p.header(1), { label: 'grade', type: CellType.NUMBER });
  assert.equal(p.rowHeader(0), 1);
});

test('memory provider: raw cells, then commit marks EDITED over an untouched base', () => {
  const p = sampleProvider();
  const raw = p.cellAt(1, 1);
  assert.equal(raw.value, 0.8);
  assert.equal(raw.state, CellState.RAW);
  assert.equal(raw.type, CellType.NUMBER);

  // commit coerces by column type and goes to the overlay, not the base
  p.commit(1, 1, '9.5');
  const ed = p.cellAt(1, 1);
  assert.equal(ed.value, 9.5);                 // coerced to number
  assert.equal(ed.state, CellState.EDITED);
  // base row untouched (overlay-is-the-spine)
  assert.equal(p._overlay.get('1:1'), 9.5);
  // a sibling cell is still RAW
  assert.equal(p.cellAt(0, 1).state, CellState.RAW);
});

test('memory provider: out-of-range + empty cells return null', () => {
  const p = sampleProvider();
  assert.equal(p.cellAt(-1, 0), null);
  assert.equal(p.cellAt(99, 0), null);
  assert.equal(p.cellAt(0, 99), null);
});

test('memory provider: row-of-objects input maps to columns', () => {
  const p = createMemoryProvider({
    columns: [{ name: 'a', type: CellType.NUMBER }, { name: 'b' }],
    rows: [{ a: 1, b: 'x' }, { a: 2, b: 'y' }],
  });
  assert.equal(p.cellAt(0, 0).value, 1);
  assert.equal(p.cellAt(1, 1).value, 'y');
});
