// Unit tests for @gcu/dialog pure helpers.
// Render/interaction tests need a real browser (see ext/dialog/demo.html).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { backdropZ, dialogZ, validateValue, focusableSelector }
  from '../ext/dialog/src/helpers.js';

// ── z-index arithmetic ────────────────────────────────────────────────────

test('backdropZ and dialogZ stack correctly', () => {
  // Stack 0: base, base+1
  assert.equal(backdropZ(9100, 0), 9100);
  assert.equal(dialogZ(9100, 0),   9101);
  // Stack 1: base+2, base+3 — backdrop above previous dialog
  assert.equal(backdropZ(9100, 1), 9102);
  assert.equal(dialogZ(9100, 1),   9103);
  // Stack 2: base+4, base+5
  assert.equal(backdropZ(9100, 2), 9104);
  assert.equal(dialogZ(9100, 2),   9105);
});

test('dialogZ at level N is always above backdropZ at level N+1 by 0', () => {
  // The whole point: each new dialog's backdrop fully covers the previous
  // dialog. Verify dialog-N < backdrop-(N+1).
  for (let n = 0; n < 5; n++) {
    assert.ok(dialogZ(9100, n) < backdropZ(9100, n + 1));
  }
});

test('z arithmetic works with arbitrary base values', () => {
  assert.equal(backdropZ(0, 3), 6);
  assert.equal(dialogZ(0, 3), 7);
  assert.equal(backdropZ(100000, 1), 100002);
  assert.equal(dialogZ(100000, 1), 100003);
});

// ── validateValue (prompt validation) ─────────────────────────────────────

test('validateValue with no validator: empty is invalid (mirrors native prompt)', () => {
  assert.deepEqual(validateValue('', undefined),    { valid: false, error: null });
  assert.deepEqual(validateValue('   ', undefined), { valid: false, error: null });
  assert.deepEqual(validateValue('hi', undefined),  { valid: true,  error: null });
});

test('validateValue with a validator returning null is valid', () => {
  const v = () => null;
  assert.deepEqual(validateValue('',    v), { valid: true, error: null });
  assert.deepEqual(validateValue('any', v), { valid: true, error: null });
});

test('validateValue with a validator returning a string is invalid + carries error', () => {
  const v = (s) => s.length < 3 ? 'Too short' : null;
  assert.deepEqual(validateValue('a',    v), { valid: false, error: 'Too short' });
  assert.deepEqual(validateValue('ab',   v), { valid: false, error: 'Too short' });
  assert.deepEqual(validateValue('abc',  v), { valid: true,  error: null });
  assert.deepEqual(validateValue('abcd', v), { valid: true,  error: null });
});

test('validateValue empty-allowed: validator("") returning null permits empty', () => {
  // Consumer explicitly allows empty by returning null for it.
  const v = () => null;
  assert.deepEqual(validateValue('', v), { valid: true, error: null });
});

test('validateValue runs the validator on every value', () => {
  let calls = 0;
  const v = () => { calls++; return null; };
  validateValue('a', v);
  validateValue('b', v);
  validateValue('c', v);
  assert.equal(calls, 3);
});

test('validateValue tolerates non-string returns from validator (treats as valid)', () => {
  // Defensive: only string returns are treated as errors.
  assert.deepEqual(validateValue('x', () => undefined),  { valid: true, error: null });
  assert.deepEqual(validateValue('x', () => false),      { valid: true, error: null });
  assert.deepEqual(validateValue('x', () => null),       { valid: true, error: null });
});

// ── focusableSelector ─────────────────────────────────────────────────────

test('focusableSelector returns a non-empty string with the expected fragments', () => {
  const sel = focusableSelector();
  assert.equal(typeof sel, 'string');
  assert.ok(sel.length > 0);
  // Sanity: the most common focusable types must be in the selector.
  assert.ok(sel.includes('button'));
  assert.ok(sel.includes('input'));
  assert.ok(sel.includes('select'));
  assert.ok(sel.includes('textarea'));
  assert.ok(sel.includes('tabindex'));
  assert.ok(sel.includes('contenteditable'));
});

test('focusableSelector excludes disabled buttons/inputs and tabindex="-1"', () => {
  // Verify the selector text contains the right negations. We test the spec
  // of the selector here, not its DOM behavior — that needs a real browser.
  const sel = focusableSelector();
  assert.ok(sel.includes(':not([disabled])'));
  assert.ok(sel.includes('tabindex="-1"'));
});
