// Unit tests for @gcu/menu pure helpers.
// Render/interaction tests need a real browser (see ext/menu/demo.html).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateItems,
  isSeparator,
  isEnabled,
  hasSubmenu,
  firstEnabledIdx,
  lastEnabledIdx,
  nextEnabledIdx,
  findByPrefix,
} from '../ext/menu/src/helpers.js';

// ── evaluateItems ─────────────────────────────────────────────────────────

test('evaluateItems passes through arrays', () => {
  const arr = [{ label: 'A' }, '---', { label: 'B' }];
  assert.equal(evaluateItems(arr), arr);
});

test('evaluateItems calls factory functions and returns the array', () => {
  let calls = 0;
  const factory = () => { calls++; return [{ label: 'X', action: 1 }]; };
  const out = evaluateItems(factory);
  assert.equal(calls, 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].label, 'X');
});

test('evaluateItems re-evaluates the factory on each call', () => {
  let n = 0;
  const factory = () => [{ label: `count-${++n}` }];
  assert.equal(evaluateItems(factory)[0].label, 'count-1');
  assert.equal(evaluateItems(factory)[0].label, 'count-2');
  assert.equal(evaluateItems(factory)[0].label, 'count-3');
});

test('evaluateItems returns [] for non-arrays from factory (defensive)', () => {
  assert.deepEqual(evaluateItems(() => null), []);
  assert.deepEqual(evaluateItems(() => undefined), []);
  assert.deepEqual(evaluateItems(() => ({})), []);
  assert.deepEqual(evaluateItems(() => 'oops'), []);
});

// ── predicates ────────────────────────────────────────────────────────────

test('isSeparator detects the "---" sentinel', () => {
  assert.equal(isSeparator('---'), true);
  assert.equal(isSeparator({ label: 'A' }), false);
  assert.equal(isSeparator({}), false);
  assert.equal(isSeparator(undefined), false);
});

test('isEnabled is true for normal items, false for separators and disabled items', () => {
  assert.equal(isEnabled({ label: 'A' }), true);
  assert.equal(isEnabled({ label: 'A', disabled: false }), true);
  assert.equal(isEnabled({ label: 'A', disabled: true }), false);
  assert.equal(isEnabled('---'), false);
});

test('hasSubmenu detects items with children (array or factory)', () => {
  assert.equal(hasSubmenu({ label: 'A' }), false);
  assert.equal(hasSubmenu({ label: 'A', children: [] }), true);
  assert.equal(hasSubmenu({ label: 'A', children: [{ label: 'X' }] }), true);
  assert.equal(hasSubmenu({ label: 'A', children: () => [] }), true);
  assert.equal(hasSubmenu('---'), false);
});

// ── firstEnabledIdx / lastEnabledIdx ─────────────────────────────────────

test('firstEnabledIdx skips leading separators and disabled items', () => {
  assert.equal(firstEnabledIdx([{ label: 'A' }]), 0);
  assert.equal(firstEnabledIdx(['---', { label: 'A' }]), 1);
  assert.equal(firstEnabledIdx([{ label: 'A', disabled: true }, { label: 'B' }]), 1);
  assert.equal(firstEnabledIdx(['---', { label: 'A', disabled: true }, { label: 'B' }]), 2);
});

test('firstEnabledIdx returns -1 when nothing is enabled', () => {
  assert.equal(firstEnabledIdx([]), -1);
  assert.equal(firstEnabledIdx(['---', '---']), -1);
  assert.equal(firstEnabledIdx([{ label: 'A', disabled: true }]), -1);
  assert.equal(firstEnabledIdx([{ label: 'A', disabled: true }, '---', { label: 'B', disabled: true }]), -1);
});

test('lastEnabledIdx scans from the end', () => {
  assert.equal(lastEnabledIdx([{ label: 'A' }]), 0);
  assert.equal(lastEnabledIdx([{ label: 'A' }, '---']), 0);
  assert.equal(lastEnabledIdx([{ label: 'A' }, { label: 'B', disabled: true }]), 0);
  assert.equal(lastEnabledIdx([{ label: 'A' }, { label: 'B' }, { label: 'C' }]), 2);
  assert.equal(lastEnabledIdx([]), -1);
  assert.equal(lastEnabledIdx(['---']), -1);
});

// ── nextEnabledIdx (cyclic) ──────────────────────────────────────────────

test('nextEnabledIdx walks forward and wraps', () => {
  const items = [{ label: 'A' }, { label: 'B' }, { label: 'C' }];
  assert.equal(nextEnabledIdx(items, 0, +1), 1);
  assert.equal(nextEnabledIdx(items, 1, +1), 2);
  assert.equal(nextEnabledIdx(items, 2, +1), 0);   // wrap
});

test('nextEnabledIdx walks backward and wraps', () => {
  const items = [{ label: 'A' }, { label: 'B' }, { label: 'C' }];
  assert.equal(nextEnabledIdx(items, 0, -1), 2);   // wrap
  assert.equal(nextEnabledIdx(items, 2, -1), 1);
  assert.equal(nextEnabledIdx(items, 1, -1), 0);
});

test('nextEnabledIdx skips separators and disabled items', () => {
  const items = [
    { label: 'A' },
    '---',
    { label: 'B', disabled: true },
    { label: 'C' },
    '---',
    { label: 'D', disabled: true },
  ];
  // From A (idx 0): next forward is C (idx 3), skipping separator and disabled B.
  assert.equal(nextEnabledIdx(items, 0, +1), 3);
  // From C (idx 3): wraps past disabled D and separator → A.
  assert.equal(nextEnabledIdx(items, 3, +1), 0);
  // Backward from C → A.
  assert.equal(nextEnabledIdx(items, 3, -1), 0);
  // Backward from A wraps to C.
  assert.equal(nextEnabledIdx(items, 0, -1), 3);
});

test('nextEnabledIdx returns the start index when nothing else is enabled', () => {
  const items = [{ label: 'A' }, { label: 'B', disabled: true }, '---'];
  assert.equal(nextEnabledIdx(items, 0, +1), 0);   // only A is enabled
  assert.equal(nextEnabledIdx(items, 0, -1), 0);
});

test('nextEnabledIdx returns -1 for empty arrays', () => {
  assert.equal(nextEnabledIdx([], 0, +1), -1);
  assert.equal(nextEnabledIdx([], 0, -1), -1);
});

// ── findByPrefix (typeahead) ─────────────────────────────────────────────

test('findByPrefix matches case-insensitively from a starting index', () => {
  const items = [
    { label: 'New File' },
    { label: 'Open' },
    { label: 'Open Recent' },
    { label: 'Save' },
  ];
  // From idx -1 (no current focus), 'o' → first 'Open' at 1.
  assert.equal(findByPrefix(items, 'o', -1), 1);
  // From idx 1 ('Open'), 'o' again → next match 'Open Recent' at 2.
  assert.equal(findByPrefix(items, 'o', 1), 2);
  // From idx 2, 'o' wraps to 'Open' at 1.
  assert.equal(findByPrefix(items, 'o', 2), 1);
  // Multi-char buffer: 'op' from -1 → 'Open' at 1; 'ope' same; 'open r' → 'Open Recent'.
  assert.equal(findByPrefix(items, 'op',     -1), 1);
  assert.equal(findByPrefix(items, 'open r', -1), 2);
});

test('findByPrefix is case-insensitive on both sides', () => {
  const items = [{ label: 'Save' }, { label: 'SAVE AS' }, { label: 'sandbox' }];
  assert.equal(findByPrefix(items, 'sa', -1), 0);   // matches 'Save'
  assert.equal(findByPrefix(items, 'SA', -1), 0);   // upper buffer, lower label
  assert.equal(findByPrefix(items, 'san', -1), 2);  // 'sandbox'
});

test('findByPrefix skips separators and disabled items', () => {
  const items = [
    { label: 'Apple' },
    '---',
    { label: 'Apricot', disabled: true },
    { label: 'Avocado' },
  ];
  // From -1, 'a' → 'Apple' at 0; from 0 → wraps past separator and disabled Apricot to Avocado.
  assert.equal(findByPrefix(items, 'a', -1), 0);
  assert.equal(findByPrefix(items, 'a',  0), 3);
});

test('findByPrefix returns -1 for no match', () => {
  const items = [{ label: 'Apple' }, { label: 'Banana' }];
  assert.equal(findByPrefix(items, 'z',  -1), -1);
  assert.equal(findByPrefix(items, '',   -1), -1);   // empty buffer never matches
  assert.equal(findByPrefix([],   'a',   -1), -1);
});

test('findByPrefix tolerates items missing labels', () => {
  const items = [{ label: 'A' }, { /* no label */ action: 'x' }, { label: 'B' }];
  assert.equal(findByPrefix(items, 'b', -1), 2);   // skips the labelless item
});

// ── interplay: factory + idx helpers ─────────────────────────────────────

test('factory items work with idx helpers after evaluateItems', () => {
  const factory = () => [
    { label: 'New' },
    '---',
    { label: 'Save', disabled: true },
    { label: 'Save As' },
  ];
  const items = evaluateItems(factory);
  assert.equal(firstEnabledIdx(items), 0);
  assert.equal(lastEnabledIdx(items), 3);
  assert.equal(nextEnabledIdx(items, 0, +1), 3);   // skips separator + disabled
});
