// op (proto, in geas) — the effect-class facet model + the geas builtin classification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EFFECT_PRESETS, GEAS_OPS, effectFacets, validateEffect, gateOf, undoOf, cacheable } from '../ext/geas/src/ops.js';

test('every preset + every classified geas builtin is a coherent effect tuple', () => {
  for (const n of Object.keys(EFFECT_PRESETS)) assert.equal(validateEffect(n), null, `preset ${n}`);
  for (const [n, op] of Object.entries(GEAS_OPS)) assert.equal(validateEffect(op.effect), null, `op ${n}`);
});

test('the validator rejects nonsense facet tuples (the over-generation guard)', () => {
  assert.ok(validateEffect({ writes: 'doc', pure: true }));            // pure can't write
  assert.ok(validateEffect({ writes: 'net', reverse: 'recompute' }));  // network can't recompute
  assert.ok(validateEffect({ writes: 'bogus' }));
});

test('behaviour derives from the facets — the coreutils textbook cases', () => {
  const gate = (n) => gateOf(effectFacets(GEAS_OPS[n].effect));
  assert.equal(gate('echo'), 'free');     // pure
  assert.equal(gate('ls'), 'free');       // read
  assert.equal(gate('cp'), 'confirm');    // write (fs)
  assert.equal(gate('rm'), 'double');     // destructive → double-confirm, derived not declared
  assert.equal(cacheable(effectFacets('pure')), true);
  assert.equal(cacheable(effectFacets('read')), false);
  assert.equal(undoOf(effectFacets('edit')), 'snapshot');
});
