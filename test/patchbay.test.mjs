// @gcu/patchbay — engine + SDK + store (Phase A, pure, no DOM).
//
// Injects sideact's signal/computed/effect/batch directly (the same way the
// surface will) and exercises the dataflow engine, cable semantics, cycle
// guard, and the rack document round-trip.

import { test } from 'node:test';
import assert from 'node:assert';

import { signal, computed, effect, batch } from '../ext/sideact/src/signals.js';
import {
  defineModule, getModuleDef, hasModuleDef, clearModuleRegistry,
} from '../ext/patchbay/src/sdk.js';
import { createEngine } from '../ext/patchbay/src/engine.js';
import {
  serializeRack, deserializeRack, blankRack, FORMAT,
} from '../ext/patchbay/src/store.js';

const sr = { signal, computed, effect, batch };
// setTimeout(0) drains the entire microtask queue (incl. chained effects).
const tick = () => new Promise((r) => setTimeout(r, 0));

// Module types are a global registry; define the fixtures once.
clearModuleRegistry();
defineModule({
  type: 'test.knob',
  title: 'KNOB',
  knobs: { val: { default: 1, min: 0, max: 10 } },
  ports: { out: { v: 'number' } },
  process: (_inp, k) => ({ v: k.val }),
});
defineModule({
  type: 'test.add',
  title: 'ADD',
  ports: { in: { a: 'number', b: 'number' }, out: { sum: 'number' } },
  process: (inp) => ({ sum: inp.a + inp.b }),
});
defineModule({
  type: 'test.double',
  title: 'x2',
  ports: { in: { x: 'number' }, out: { y: 'number' } },
  process: (inp) => ({ y: inp.x * 2 }),
});

test('defineModule normalizes ports/knobs and registers', () => {
  assert.ok(hasModuleDef('test.add'));
  const def = getModuleDef('test.add');
  assert.equal(def.inPorts.length, 2);
  assert.equal(def.inPorts[0].name, 'a');
  assert.equal(def.inPorts[0].default, 0);
  assert.equal(def.outPorts[0].name, 'sum');
  assert.equal(def.outPorts[0].cable, 'trs');   // default cable type
  const knobDef = getModuleDef('test.knob');
  assert.equal(knobDef.knobs[0].name, 'val');
  assert.equal(knobDef.knobs[0].max, 10);
});

test('addInstance computes its output synchronously on creation', () => {
  const e = createEngine(sr);
  e.addInstance('k', 'test.knob', { knobs: { val: 4 } });
  // process effect runs synchronously at creation; the output write is sync.
  assert.equal(e.outputValue('k', 'v'), 4);
});

test('cable propagates a value through the graph', async () => {
  const e = createEngine(sr);
  e.addInstance('a', 'test.knob', { knobs: { val: 2 } });
  e.addInstance('b', 'test.knob', { knobs: { val: 3 } });
  e.addInstance('sum', 'test.add');
  assert.equal(e.outputValue('sum', 'sum'), 0);   // unwired: 0 + 0

  assert.deepEqual(e.connect({ id: 'a', port: 'v' }, { id: 'sum', port: 'a' }), { ok: true });
  assert.deepEqual(e.connect({ id: 'b', port: 'v' }, { id: 'sum', port: 'b' }), { ok: true });
  await tick();
  assert.equal(e.outputValue('sum', 'sum'), 5);
});

test('knob change re-propagates downstream', async () => {
  const e = createEngine(sr);
  e.addInstance('a', 'test.knob', { knobs: { val: 2 } });
  e.addInstance('b', 'test.knob', { knobs: { val: 3 } });
  e.addInstance('sum', 'test.add');
  e.connect({ id: 'a', port: 'v' }, { id: 'sum', port: 'a' });
  e.connect({ id: 'b', port: 'v' }, { id: 'sum', port: 'b' });
  await tick();
  assert.equal(e.outputValue('sum', 'sum'), 5);

  e.setKnob('a', 'val', 10);
  await tick();
  assert.equal(e.outputValue('sum', 'sum'), 13);
});

test('disconnect reverts an input to its default', async () => {
  const e = createEngine(sr);
  e.addInstance('a', 'test.knob', { knobs: { val: 2 } });
  e.addInstance('b', 'test.knob', { knobs: { val: 3 } });
  e.addInstance('sum', 'test.add');
  e.connect({ id: 'a', port: 'v' }, { id: 'sum', port: 'a' });
  e.connect({ id: 'b', port: 'v' }, { id: 'sum', port: 'b' });
  await tick();
  assert.equal(e.outputValue('sum', 'sum'), 5);

  e.disconnect({ id: 'sum', port: 'a' });
  await tick();
  assert.equal(e.outputValue('sum', 'sum'), 3);   // a → default 0, b still 3
  assert.equal(e.cables.length, 1);
});

test('cycle and self-patch are rejected', () => {
  const e = createEngine(sr);
  e.addInstance('d1', 'test.double');
  e.addInstance('d2', 'test.double');
  assert.deepEqual(e.connect({ id: 'd1', port: 'y' }, { id: 'd2', port: 'x' }), { ok: true });
  assert.equal(e.connect({ id: 'd2', port: 'y' }, { id: 'd1', port: 'x' }).reason, 'cycle');
  assert.equal(e.connect({ id: 'd1', port: 'y' }, { id: 'd1', port: 'x' }).reason, 'cycle');
});

test('missing instance / unknown port are rejected', () => {
  const e = createEngine(sr);
  e.addInstance('a', 'test.knob');
  e.addInstance('sum', 'test.add');
  assert.equal(e.connect({ id: 'nope', port: 'v' }, { id: 'sum', port: 'a' }).reason, 'missing-instance');
  assert.equal(e.connect({ id: 'a', port: 'zzz' }, { id: 'sum', port: 'a' }).reason, 'no-output');
  assert.equal(e.connect({ id: 'a', port: 'v' }, { id: 'sum', port: 'zzz' }).reason, 'no-input');
});

test('an input takes a single cable; reconnect replaces it', async () => {
  const e = createEngine(sr);
  e.addInstance('a', 'test.knob', { knobs: { val: 2 } });
  e.addInstance('b', 'test.knob', { knobs: { val: 9 } });
  e.addInstance('sum', 'test.add');
  e.connect({ id: 'a', port: 'v' }, { id: 'sum', port: 'a' });
  e.connect({ id: 'b', port: 'v' }, { id: 'sum', port: 'a' });   // replaces a→sum.a
  assert.equal(e.cables.length, 1);
  assert.equal(e.cables[0].from.id, 'b');
  await tick();
  assert.equal(e.inputValue('sum', 'a'), 9);
});

test('removeInstance tears down its cables', () => {
  const e = createEngine(sr);
  e.addInstance('a', 'test.knob', { knobs: { val: 2 } });
  e.addInstance('sum', 'test.add');
  e.connect({ id: 'a', port: 'v' }, { id: 'sum', port: 'a' });
  assert.equal(e.cables.length, 1);
  e.removeInstance('a');
  assert.equal(e.cables.length, 0);
  assert.equal(e.instances.has('a'), false);
});

test('blankRack is a valid empty document', () => {
  const doc = blankRack();
  assert.equal(doc.format, FORMAT);
  assert.equal(doc.modules.length, 0);
  assert.equal(doc.rack.rows.length, 2);
});

test('serialize → deserialize round-trips a rack', async () => {
  const e1 = createEngine(sr);
  e1.addInstance('a', 'test.knob', { knobs: { val: 7 }, row: 0, hpPos: 4 });
  e1.addInstance('b', 'test.knob', { knobs: { val: 5 }, row: 0, hpPos: 14 });
  e1.addInstance('sum', 'test.add', { row: 1, hpPos: 8 });
  e1.connect({ id: 'a', port: 'v' }, { id: 'sum', port: 'a' });
  e1.connect({ id: 'b', port: 'v' }, { id: 'sum', port: 'b' });
  const doc = serializeRack(e1, { hp: 64, rows: [{ kind: '3U' }, { kind: '3U' }] });

  // Survives a JSON round-trip.
  const json = JSON.stringify(doc);
  const e2 = createEngine(sr);
  const rack = deserializeRack(json, e2);

  assert.equal(rack.hp, 64);
  assert.equal(e2.instances.size, 3);
  assert.equal(e2.cables.length, 2);
  assert.equal(e2.instances.get('a').knobs.val.read(), 7);
  assert.equal(e2.instances.get('sum').hpPos, 8);
  await tick();
  assert.equal(e2.outputValue('sum', 'sum'), 12);   // 7 + 5 reproduced
});

test('deserialize rejects a non-patchbay document', () => {
  const e = createEngine(sr);
  assert.throws(() => deserializeRack({ format: 'something-else' }, e), /not a patchbay document/);
});
