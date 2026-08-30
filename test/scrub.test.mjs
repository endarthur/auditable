// scrub-core: literal detection + stepping for scrubbable numbers (Alt+drag)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findNumberSpan, applySteps } from '../src/js/scrub-core.js';

describe('findNumberSpan', () => {
  it('finds an integer under the cursor', () => {
    const s = findNumberSpan('const x = 50;', 11);
    assert.deepEqual(s, { start: 10, end: 12, text: '50' });
  });

  it('finds a decimal and includes the full span', () => {
    const s = findNumberSpan('ui.slider("r", 0.75, { min: 0.25 })', 17);
    assert.equal(s.text, '0.75');
  });

  it('cursor at either edge of the literal still hits', () => {
    assert.equal(findNumberSpan('x = 123', 4).text, '123');
    assert.equal(findNumberSpan('x = 123', 7).text, '123');
  });

  it('returns null when not over a number', () => {
    assert.equal(findNumberSpan('const name = "abc"', 3), null);
  });

  it('does not treat digits inside identifiers specially (still spans them)', () => {
    // x2 = 5 — cursor over the 5, not the 2 of x2
    const s = findNumberSpan('x2 = 5', 5);
    assert.equal(s.text, '5');
  });

  it('joins a leading minus when it reads as a sign', () => {
    assert.equal(findNumberSpan('set x to -5', 10).text, '-5');
    assert.equal(findNumberSpan('f(-2.5)', 4).text, '-2.5');
  });

  it('leaves the minus out when it reads as an operator', () => {
    assert.equal(findNumberSpan('a - 5', 4).text, '5');
    assert.equal(findNumberSpan('arr[i] - 5', 9).text, '5');
    assert.equal(findNumberSpan('f() - 5', 6).text, '5');
  });

  it('exponent forms span whole', () => {
    assert.equal(findNumberSpan('n = 1.5e3', 6).text, '1.5e3');
    assert.equal(findNumberSpan('n = 2E-4', 5).text, '2E-4');
  });
});

describe('applySteps', () => {
  it('integers step by 1 and stay integers', () => {
    assert.equal(applySteps('50', 3), '53');
    assert.equal(applySteps('50', -60), '-10');
  });

  it('decimals step by their last place', () => {
    assert.equal(applySteps('0.75', 3), '0.78');
    assert.equal(applySteps('0.75', -80), '-0.05');
    assert.equal(applySteps('1.5', 1), '1.6');
  });

  it('no float dust', () => {
    assert.equal(applySteps('0.1', 2), '0.3');
  });

  it('shift multiplies the step ×10', () => {
    assert.equal(applySteps('50', 2, 10), '70');
    assert.equal(applySteps('0.75', 1, 10), '0.85');
  });

  it('exponent form steps the mantissa, keeps the exponent verbatim', () => {
    assert.equal(applySteps('1.5e3', 1), '1.6e3');
    assert.equal(applySteps('2E-4', -1), '1E-4');
  });

  it('negative literals step continuously through zero', () => {
    assert.equal(applySteps('-5', 6), '1');
    assert.equal(applySteps('-0.05', 6), '0.01');
  });

  it('zero steps is identity (modulo canonical form)', () => {
    assert.equal(applySteps('0.75', 0), '0.75');
    assert.equal(applySteps('50', 0), '50');
  });
});
