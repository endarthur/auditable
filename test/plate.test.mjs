// @gcu/plate pure tests — the registry, the page/frame model, and the
// selection-resolution helper (the linking logic). The DOM-bound compositor +
// the interactive scatter are exercised by test/plate-strata-link-smoke.mjs
// (Playwright, not in `npm test`).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  registerPanelKind, getPanelKind, listPanelKinds,
  PAGE_SIZES, pageDims, contentRect, resolveFrame,
  resolveSelection, plotPanel,
} from '../ext/plate/index.js';

// ── registry ──
test('plot panel self-registers at module init', () => {
  assert.ok(listPanelKinds().includes('plot'));
  assert.equal(getPanelKind('plot').render, plotPanel.render);  // registry stores a {kind,...def} wrapper
  assert.equal(getPanelKind('plot').kind, 'plot');
  assert.equal(getPanelKind('nope'), null);
});

test('registerPanelKind validates name + render', () => {
  assert.throws(() => registerPanelKind('', { render() {} }), /needs a name/);
  assert.throws(() => registerPanelKind('x', {}), /needs render/);
  registerPanelKind('dummy', { render: () => ({}), defaultSpec: () => ({}) });
  assert.equal(getPanelKind('dummy').kind, 'dummy');
});

test('plot defaultSpec picks the first two numeric columns', () => {
  assert.deepEqual(plotPanel.defaultSpec({ numericColumns: ['a', 'b', 'c'] }), { x: 'a', y: 'b' });
  assert.deepEqual(plotPanel.defaultSpec({ numericColumns: ['only'] }), { x: 'only', y: 'only' });
  assert.deepEqual(plotPanel.defaultSpec({ numericColumns: [] }), { x: null, y: null });
});

// ── page model ──
test('pageDims honors orientation', () => {
  const p = pageDims('A4', 'portrait');
  assert.deepEqual(p, PAGE_SIZES.A4);
  const l = pageDims('A4', 'landscape');
  assert.deepEqual(l, { w: PAGE_SIZES.A4.h, h: PAGE_SIZES.A4.w });
});

test('pageDims falls back to A4 for unknown size, accepts explicit dims', () => {
  assert.deepEqual(pageDims('bogus'), PAGE_SIZES.A4);
  assert.deepEqual(pageDims({ w: 100, h: 200 }, 'portrait'), { w: 100, h: 200 });
});

test('contentRect subtracts margins (default 32)', () => {
  const r = contentRect({ w: 800, h: 600 });
  assert.deepEqual(r, { x: 32, y: 32, w: 736, h: 536 });
  const r2 = contentRect({ w: 800, h: 600 }, { left: 10, right: 10, top: 0, bottom: 0 });
  assert.deepEqual(r2, { x: 10, y: 0, w: 780, h: 600 });
});

test('resolveFrame: full fills the content rect; explicit overrides', () => {
  const c = { x: 32, y: 32, w: 700, h: 500 };
  assert.deepEqual(resolveFrame('full', c), c);
  assert.deepEqual(resolveFrame(undefined, c), c);
  assert.deepEqual(resolveFrame({ x: 0, y: 0, w: 100, h: 50 }, c), { x: 0, y: 0, w: 100, h: 50 });
  assert.deepEqual(resolveFrame({ w: 100 }, c), { x: 32, y: 32, w: 100, h: 500 });  // partial
});

// ── selection resolution (the linking logic) ──
const DATA = {
  columns: { grade: [0.5, 2.1, 3.4, 0.1], dom: ['ox', 'ox', 'sulf', 'ox'] },
  keys: ['0', '1', '2', '3'],
};

test('resolveSelection: kind:rows carries keys directly (stringified)', () => {
  const set = resolveSelection({ kind: 'rows', rows: [1, 2] }, DATA, null);
  assert.deepEqual([...set].sort(), ['1', '2']);
});

test('resolveSelection: none / cols / unknown / null → null (clear)', () => {
  assert.equal(resolveSelection({ kind: 'none' }, DATA, null), null);
  assert.equal(resolveSelection({ kind: 'cols', cols: ['grade'] }, DATA, null), null);
  assert.equal(resolveSelection(null, DATA, null), null);
});

test('resolveSelection: kind:filter evaluates the predicate over our own data', () => {
  // grade > 2 → rows 1 (2.1) and 2 (3.4)
  const pred = { form: 'spec', root: { op: '>', left: { col: 'grade' }, right: { lit: 2 } } };
  const evalPred = (p, get) => {
    // a stand-in evaluator for the test (the real one is strata's evaluatePredicate)
    const n = p.root;
    return get(n.left.col) > n.right.lit;
  };
  const set = resolveSelection({ kind: 'filter', predicate: pred }, DATA, evalPred);
  assert.deepEqual([...set].sort(), ['1', '2']);
});

test('resolveSelection: filter is inert without an injected evaluator', () => {
  const pred = { form: 'spec', root: { op: '>', left: { col: 'grade' }, right: { lit: 2 } } };
  assert.equal(resolveSelection({ kind: 'filter', predicate: pred }, DATA, null), null);
});

test('resolveSelection: a row that throws in the evaluator is skipped, not fatal', () => {
  const pred = { form: 'spec', root: {} };
  let calls = 0;
  const evalPred = () => { calls++; if (calls === 2) throw new Error('boom'); return calls === 1; };
  const set = resolveSelection({ kind: 'filter', predicate: pred }, DATA, evalPred);
  assert.deepEqual([...set], ['0']);  // row 0 true, row 1 threw (skipped), rows 2/3 false
});
