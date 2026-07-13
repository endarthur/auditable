// @gcu/dispatch — the session-trained NL → tool-call dispatcher.
// Fast-layer tests: vocab derivation, determinism, per-kind round-trips on
// held-out phrasings (none of these appear in the generated banks verbatim-
// guaranteed? no — but they are NOT the frozen incubator yardstick; the
// yardstick parity harness lives in ../gcu-dispatch/nlu/run-pkg.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveVocab, trainSession, createDispatcher, tokenize, normText } from '../ext/dispatch/src/main.js';

const vocab = deriveVocab({
  numCols: { FE: { lo: 45, hi: 68, dec: 1 }, SIO2: { lo: 1, hi: 14, dec: 1 }, AU: { lo: 0.1, hi: 5, dec: 2 } },
  catCols: { LITO: ['lithology', 'litho'] },
  catValues: { LITO: { HEMATITE: ['hematite'], WASTE: ['waste', 'the waste'] } },
  layers: { 'topo.tif': ['the topography', 'topo'], 'model.csv': ['the model', 'the block model'] },
});
const TOOLS = [
  { name: 'micro.colorBy', kind: 'column-pick', argName: 'column', pools: ['numeric', 'categorical'],
    frames: ['color by {col}', 'color the model by {col}', 'paint the blocks by {col}', 'map {col}', 'display {col}'] },
  { name: 'micro.filterBlocks', kind: 'comparison-filter', nouns: ['blocks', 'the model'] },
  { name: 'micro.sectionAt', kind: 'axis-position', axes: { Z: ['elevation', 'level'], X: ['easting', 'north-south'], Y: ['northing', 'east-west'] } },
  { name: 'micro.setDomainVisibility', kind: 'category-visibility', column: 'LITO' },
  { name: 'micro.zoomToLayer', kind: 'layer-pick', argName: 'layer', frames: ['zoom to {layer}', 'fit {layer}', 'go to {layer}', 'center on {layer}'] },
  { name: 'micro.setZExag', kind: 'number-arg', argName: 'factor', values: [1.5, 2, 3, 5], wordNumbers: true,
    frames: ['exaggerate z by {n}', 'vertical exaggeration {n}', 'z scale {n}'] },
  { name: 'micro.clearFilter', kind: 'no-arg', frames: ['clear the filter', 'remove the filter', 'unfilter', 'reset the filter'] },
];
const session = trainSession({ vocab, tools: TOOLS, seed: 7 });
const { dispatcher } = session;
const one = (q, opts) => { const r = dispatcher.dispatch(q, opts); return r.calls[0] || null; };

test('deriveVocab merges the element lexicon and keeps host config', () => {
  assert.ok(vocab.numCols.FE.syn.includes('iron'));
  assert.ok(vocab.numCols.AU.syn.includes('gold'));
  assert.equal(vocab.numCols.SIO2.dec, 1);
  assert.ok(vocab.catCols.LITO.includes('lithology'));
  assert.ok(vocab.layers['topo.tif'].includes('topo'));
});

test('trainSession is deterministic per seed', () => {
  const a = trainSession({ vocab, tools: TOOLS, seed: 7 });
  assert.equal(JSON.stringify(a.weights), JSON.stringify(session.weights));
});

test('column-pick: synonym resolves to the real column', () => {
  assert.deepEqual(one('color the blocks by iron'), { name: 'micro.colorBy', arguments: { column: 'FE' } });
  assert.deepEqual(one('display the silica'), { name: 'micro.colorBy', arguments: { column: 'SIO2' } });
});

test('comparison-filter: canonical clauses, compound, or-join', () => {
  const c = one('filter blocks with FE above 60');
  assert.equal(c.name, 'micro.filterBlocks');
  assert.deepEqual(c.arguments.clauses, [{ column: 'FE', op: '>', value: 60 }]);
  const c2 = one('gold over 2 or silica under 4');
  assert.equal(c2.arguments.clauses.length, 2);
  assert.equal(c2.arguments.join, 'or');
  assert.deepEqual(c2.arguments.clauses[0], { column: 'AU', op: '>', value: 2 });
});

test('axis-position: elevation maps to Z, thickness optional', () => {
  assert.deepEqual(one('section at elevation 980').arguments, { axis: 'Z', position: 980 });
  const t = one('give me a 25 meter thick section at elevation 1000');
  assert.equal(t.arguments.thickness, 25);
  assert.equal(t.arguments.position, 1000);
});

test('category-visibility: real boolean out', () => {
  assert.deepEqual(one('hide the waste').arguments, { column: 'LITO', value: 'WASTE', visible: false });
  assert.deepEqual(one('bring back hematite').arguments, { column: 'LITO', value: 'HEMATITE', visible: true });
});

test('layer-pick: session layer names resolve to files', () => {
  assert.deepEqual(one('zoom to the topography').arguments, { layer: 'topo.tif' });
});

test('number-arg: digits and word-numbers', () => {
  assert.deepEqual(one('exaggerate z by 3').arguments, { factor: 3 });
  assert.deepEqual(one('exaggerate z by two').arguments, { factor: 2 });
});

test('no-arg + refusal + empty calls degrade cleanly', () => {
  assert.deepEqual(one('clear the filter please'), { name: 'micro.clearFilter', arguments: {} });
  assert.equal(one('what is the average grade'), null);
  assert.equal(one('email this to the team'), null);
});

test('surface scoping restricts candidates', () => {
  const r = dispatcher.dispatch('color by iron', { surface: 'lamina' });
  assert.equal(r.calls.length, 0);                          // no lamina tools registered
  const r2 = dispatcher.dispatch('color by iron', { surface: 'micro' });
  assert.equal(r2.calls[0].name, 'micro.colorBy');
});

test('the contamination guard drops excluded texts from the corpus', () => {
  const excluded = new Set([normText('color by iron')]);
  const s2 = trainSession({ vocab, tools: TOOLS, seed: 7, excludeTexts: excluded });
  assert.ok(s2.stats.corpus > 0);
  // the guard reports what it excluded (only texts the banks actually generated)
  for (const x of s2.stats.excluded) assert.ok(excluded.has(x));
});

test('weights are a JSON round-trippable table (the browser/store path)', () => {
  const revived = createDispatcher({ vocab, tools: TOOLS, weights: JSON.parse(JSON.stringify(session.weights)) });
  assert.deepEqual(revived.dispatch('color by iron').calls[0].arguments, { column: 'FE' });
});

test('tokenize keeps ids and decimals whole', () => {
  assert.deepEqual(tokenize('QF-011 at 2.5'), ['qf-011', 'at', '2.5']);
});
