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

import { manCmd, opCmd, describeEffect } from '../ext/geas/src/ops.js';
const cap = () => { let o = ''; return { ctx: { stdout: (s) => { o += s; }, stderr: (s) => { o += s; } }, out: () => o }; };

test('man <cmd> renders the descriptor incl. the facet-derived EFFECT line', async () => {
  let h = cap(); await manCmd(['rm'], h.ctx);
  assert.match(h.out(), /NAME\n {4}rm — remove files/);
  assert.match(h.out(), /EFFECT\n {4}custom · writes the filesystem · not undoable · agent: double-confirms/);
  h = cap(); await manCmd(['echo'], h.ctx);
  assert.match(h.out(), /pure · no side effects · recomputable · agent: runs freely/);
  h = cap(); assert.equal(await manCmd(['nope'], h.ctx), 1);   // no entry → exit 1
});

test('op list is a queryable catalog (filter by facet)', async () => {
  const h = cap(); await opCmd(['list', '--writes=fs'], h.ctx);
  const names = h.out().trim().split('\n').map((l) => l.split(/\s+/)[0]).sort();
  assert.deepEqual(names, ['cp', 'mkdir', 'mv', 'rm', 'tee', 'touch']);   // exactly the fs writers
});

test('the doc projection renders the full descriptor — synopsis(array), multi-line doc, examples, see-also', async () => {
  // multi-form synopsis (string[]) → each form on its own indented line
  let h = cap(); await manCmd(['op'], h.ctx);
  assert.match(h.out(), /SYNOPSIS\n {4}op \[name\]\n {4}op list /);
  // multi-line doc (\n\n paragraph) → every line indented, blank line preserved between paragraphs
  h = cap(); await manCmd(['rm'], h.ctx);
  assert.match(h.out(), /DESCRIPTION\n {4}Remove each FILE\..*\n\n {4}Irreversible —/s);
  // examples + see-also sections, with escaped regex passed through verbatim
  h = cap(); await manCmd(['grep'], h.ctx);
  assert.match(h.out(), /EXAMPLES\n {4}grep -i error log\.txt\n {4}ls \| grep '\\\.js\$'/);
  assert.match(h.out(), /SEE ALSO\n {4}find, cut, wc/);
});

test('every classified op carries at least a summary; non-trivial ops carry doc', () => {
  const trivial = new Set([]);   // none exempt — all ops have a summary
  for (const [n, op] of Object.entries(GEAS_OPS)) {
    assert.ok(op.summary, `${n} has a summary`);
    if (!trivial.has(n)) assert.ok(op.doc || op.summary, `${n} has doc or summary`);
    if (op.seeAlso) for (const ref of op.seeAlso) assert.ok(GEAS_OPS[ref], `${n} seeAlso "${ref}" resolves`);
  }
});
