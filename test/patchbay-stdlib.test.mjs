// @gcu/patchbay — built-in module stdlib (Phase D). Uses a stub A-Bus to verify
// the I/O modules' setup-seam bridging (subscribe → output, input → signal,
// VFS read/write) plus the compute modules.

import { test } from 'node:test';
import assert from 'node:assert';

import { signal, computed, effect, batch } from '../ext/sideact/src/signals.js';
import { hasModuleDef } from '../ext/patchbay/src/sdk.js';
import { createEngine } from '../ext/patchbay/src/engine.js';
// Importing stdlib registers every built-in module type (idempotent).
import { STDLIB_MODULES } from '../ext/patchbay/src/stdlib.js';

const sr = { signal, computed, effect, batch };
const tick = () => new Promise((r) => setTimeout(r, 0));

function stubBus() {
  const subs = [];
  const emitted = [];
  const files = {};
  return {
    subscribe(filter, handler) {
      const s = { filter, handler };
      subs.push(s);
      return () => { const i = subs.indexOf(s); if (i >= 0) subs.splice(i, 1); };
    },
    signal(desc, args) { emitted.push({ iface: desc.interface, member: desc.member, args }); },
    async call(desc, args) {
      if (desc.interface === 'VFS' && desc.member === 'Read') return files[args[0]];
      if (desc.interface === 'VFS' && desc.member === 'Write') { files[args[0]] = args[1]; return; }
      return undefined;
    },
    _emit(iface, member, args) {
      for (const s of subs) {
        if ((!s.filter.interface || s.filter.interface === iface) &&
            (!s.filter.member || s.filter.member === member)) s.handler({ interface: iface, member, args });
      }
    },
    _emitted: emitted, _files: files, _subs: subs,
  };
}

test('every stdlib module type is registered', () => {
  for (const m of STDLIB_MODULES) assert.ok(hasModuleDef(m.type), 'missing ' + m.type);
});

test('compute: add + scale', async () => {
  const e = createEngine(sr);
  e.addInstance('c1', 'src.const', { knobs: { value: 2 } });
  e.addInstance('c2', 'src.const', { knobs: { value: 3 } });
  e.addInstance('a', 'math.add');
  e.connect({ id: 'c1', port: 'v' }, { id: 'a', port: 'a' });
  e.connect({ id: 'c2', port: 'v' }, { id: 'a', port: 'b' });
  await tick();
  assert.equal(e.outputValue('a', 'sum'), 5);

  e.addInstance('s', 'math.scale', { knobs: { gain: 4 } });
  e.connect({ id: 'a', port: 'sum' }, { id: 's', port: 'x' });
  await tick();
  assert.equal(e.outputValue('s', 'y'), 20);
});

test('math.limit clamps to [lo, hi]', async () => {
  const e = createEngine(sr);
  e.addInstance('src', 'src.const', { knobs: { value: 1 } });
  e.addInstance('lim', 'math.limit', { knobs: { lo: 0.2, hi: 0.8 } });
  e.connect({ id: 'src', port: 'v' }, { id: 'lim', port: 'x' });
  await tick();
  assert.equal(e.outputValue('lim', 'y'), 0.8);   // 1 clamped to hi
  e.setKnob('src', 'value', 0.1);
  await tick();
  assert.equal(e.outputValue('lim', 'y'), 0.2);   // 0.1 clamped to lo
  e.setKnob('src', 'value', 0.5);
  await tick();
  assert.equal(e.outputValue('lim', 'y'), 0.5);   // in range, passes through
});

test('logic.compare and gates evaluate truthiness', async () => {
  const e = createEngine(sr);
  e.addInstance('a', 'src.const', { knobs: { value: 0.9 } });
  e.addInstance('b', 'src.const', { knobs: { value: 0.3 } });
  e.addInstance('cmp', 'logic.compare');
  e.connect({ id: 'a', port: 'v' }, { id: 'cmp', port: 'a' });
  e.connect({ id: 'b', port: 'v' }, { id: 'cmp', port: 'b' });
  await tick();
  assert.equal(e.outputValue('cmp', 'gt'), 1);   // 0.9 > 0.3

  e.addInstance('and', 'logic.and');
  e.connect({ id: 'a', port: 'v' }, { id: 'and', port: 'a' });   // 0.9 → true
  e.connect({ id: 'b', port: 'v' }, { id: 'and', port: 'b' });   // 0.3 → false
  await tick();
  assert.equal(e.outputValue('and', 'q'), 0);

  e.addInstance('or', 'logic.or');
  e.connect({ id: 'a', port: 'v' }, { id: 'or', port: 'a' });
  e.connect({ id: 'b', port: 'v' }, { id: 'or', port: 'b' });
  await tick();
  assert.equal(e.outputValue('or', 'q'), 1);

  e.addInstance('not', 'logic.not');
  e.connect({ id: 'b', port: 'v' }, { id: 'not', port: 'a' });   // !false → true
  await tick();
  assert.equal(e.outputValue('not', 'q'), 1);
});

test('ctrl.alarm trips with hysteresis (Schmitt)', async () => {
  const e = createEngine(sr);
  e.addInstance('x', 'src.const', { knobs: { value: 0.5 } });
  e.addInstance('al', 'ctrl.alarm', { knobs: { level: 0.7, hyst: 0.1 } });
  e.connect({ id: 'x', port: 'v' }, { id: 'al', port: 'x' });
  await tick();
  assert.equal(e.outputValue('al', 'trip'), 0);          // 0.5 < 0.7, not tripped

  e.setKnob('x', 'value', 0.75); await tick();
  assert.equal(e.outputValue('al', 'trip'), 1);          // ≥ level → trip

  e.setKnob('x', 'value', 0.65); await tick();
  assert.equal(e.outputValue('al', 'trip'), 1);          // in deadband (≥ level−hyst) → stays tripped

  e.setKnob('x', 'value', 0.55); await tick();
  assert.equal(e.outputValue('al', 'trip'), 0);          // < level−hyst → re-armed
});

test('ctrl.pid / ctrl.timer / disp.gauge instantiate without throwing', () => {
  const e = createEngine(sr);
  assert.doesNotThrow(() => {
    e.addInstance('pid', 'ctrl.pid');
    e.addInstance('tmr', 'ctrl.timer', { params: { mode: 'TON', delay: 500 } });
    e.addInstance('g', 'disp.gauge');
  });
  e.destroy();   // clears the PID interval
});

test('io.abus-in: a subscribed signal drives the output port', async () => {
  const bus = stubBus();
  const e = createEngine(sr, { bus });
  e.addInstance('in', 'io.abus-in', { params: { topic: 'Sensor.Reading' } });
  bus._emit('Sensor', 'Reading', [42]);
  assert.equal(e.outputValue('in', 'value'), 42);
  bus._emit('Sensor', 'Reading', [99]);
  assert.equal(e.outputValue('in', 'value'), 99);
});

test('io.abus-out: an input value is published to the bus', async () => {
  const bus = stubBus();
  const e = createEngine(sr, { bus });
  e.addInstance('k', 'src.const', { knobs: { value: 0.7 } });
  e.addInstance('out', 'io.abus-out', { params: { topic: 'Ctrl.Level' } });
  e.connect({ id: 'k', port: 'v' }, { id: 'out', port: 'value' });
  await tick();
  const last = bus._emitted[bus._emitted.length - 1];
  assert.equal(last.iface, 'Ctrl');
  assert.equal(last.member, 'Level');
  assert.equal(last.args[0], 0.7);
});

test('io.vfs-read: reads a file and re-reads on VFS.Changed', async () => {
  const bus = stubBus();
  bus._files['/data/x.txt'] = 'hello';
  const e = createEngine(sr, { bus });
  e.addInstance('r', 'io.vfs-read', { params: { path: '/data/x.txt' } });
  await tick();
  assert.equal(e.outputValue('r', 'content'), 'hello');

  bus._files['/data/x.txt'] = 'world';
  bus._emit('VFS', 'Changed', ['/data/x.txt']);
  await tick();
  assert.equal(e.outputValue('r', 'content'), 'world');
});

test('io.vfs-write: writes input changes (and skips the initial run)', async () => {
  const bus = stubBus();
  const e = createEngine(sr, { bus });
  e.addInstance('k', 'src.const', { knobs: { value: 0.5 } });
  e.addInstance('w', 'io.vfs-write', { params: { path: '/out/y.txt' } });
  await tick();
  assert.equal('/out/y.txt' in bus._files, false);   // no initial clobber

  e.connect({ id: 'k', port: 'v' }, { id: 'w', port: 'content' });
  await tick();
  assert.equal(bus._files['/out/y.txt'], '0.5');
});

test('io modules without a bus or config no-op safely', () => {
  const e = createEngine(sr);   // no ctx.bus
  assert.doesNotThrow(() => {
    e.addInstance('in', 'io.abus-in', { params: { topic: '' } });
    e.addInstance('r', 'io.vfs-read', { params: { path: '' } });
  });
});
