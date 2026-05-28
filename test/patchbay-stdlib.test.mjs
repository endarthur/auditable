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

test('panel controls: toggle / switch / fader / trigger drive outputs', async () => {
  const e = createEngine(sr);
  // toggle
  e.addInstance('tg', 'panel.toggle', { controls: { state: 1 } });
  await tick();
  assert.equal(e.outputValue('tg', 'q'), 1);
  e.setControl('tg', 'state', 0); await tick();
  assert.equal(e.outputValue('tg', 'q'), 0);

  // fader → value
  e.addInstance('fd', 'panel.fader', { controls: { level: 0.25 } });
  await tick();
  assert.equal(e.outputValue('fd', 'v'), 0.25);

  // switch router: selects 1 of 4 inputs
  e.addInstance('s1', 'src.const', { knobs: { value: 11 } });
  e.addInstance('s2', 'src.const', { knobs: { value: 22 } });
  e.addInstance('sw', 'panel.switch', { controls: { pos: 0 } });
  e.connect({ id: 's1', port: 'v' }, { id: 'sw', port: 'a' });
  e.connect({ id: 's2', port: 'v' }, { id: 'sw', port: 'b' });
  await tick();
  assert.equal(e.outputValue('sw', 'out'), 11);   // pos 0 → a
  e.setControl('sw', 'pos', 1); await tick();
  assert.equal(e.outputValue('sw', 'out'), 22);   // pos 1 → b

  // trigger: button 1 → pulse 1, 0 → pulse 0
  e.addInstance('tr', 'panel.trigger');
  await tick();
  assert.equal(e.outputValue('tr', 'pulse'), 0);
  e.setControl('tr', 'fire', 1); await tick();
  assert.equal(e.outputValue('tr', 'pulse'), 1);
  e.setControl('tr', 'fire', 0); await tick();
  assert.equal(e.outputValue('tr', 'pulse'), 0);
});

test('controls round-trip through the rack doc (button persists released)', async () => {
  const { serializeRack, deserializeRack } = await import('../ext/patchbay/src/store.js');
  const e1 = createEngine(sr);
  e1.addInstance('fd', 'panel.fader', { controls: { level: 0.8 } });
  e1.addInstance('tr', 'panel.trigger', { controls: { fire: 1 } });   // held at save time
  const doc = JSON.parse(JSON.stringify(serializeRack(e1, { hp: 64, rows: [{ kind: '3U' }] })));
  const e2 = createEngine(sr);
  deserializeRack(doc, e2);
  await tick();
  assert.equal(e2.controlValue('fd', 'level'), 0.8);
  assert.equal(e2.controlValue('tr', 'fire'), 0);   // momentary persists released
});

test('math.abs and math.minmax compute', async () => {
  const e = createEngine(sr);
  e.addInstance('s', 'src.const', { knobs: { value: -3 } });
  e.addInstance('ab', 'math.abs');
  e.connect({ id: 's', port: 'v' }, { id: 'ab', port: 'x' });
  await tick();
  assert.equal(e.outputValue('ab', 'y'), 3);

  e.addInstance('a', 'src.const', { knobs: { value: 7 } });
  e.addInstance('b', 'src.const', { knobs: { value: 2 } });
  e.addInstance('mm', 'math.minmax');
  e.connect({ id: 'a', port: 'v' }, { id: 'mm', port: 'a' });
  e.connect({ id: 'b', port: 'v' }, { id: 'mm', port: 'b' });
  await tick();
  assert.equal(e.outputValue('mm', 'lo'), 2);
  assert.equal(e.outputValue('mm', 'hi'), 7);
});

test('proc.sh holds on the trigger rising edge', async () => {
  const e = createEngine(sr);
  e.addInstance('in', 'src.const', { knobs: { value: 0.4 } });
  e.addInstance('tg', 'src.const', { knobs: { value: 0 } });
  e.addInstance('sh', 'proc.sh');
  e.connect({ id: 'in', port: 'v' }, { id: 'sh', port: 'in' });
  e.connect({ id: 'tg', port: 'v' }, { id: 'sh', port: 'trig' });
  await tick();
  assert.equal(e.outputValue('sh', 'out'), 0);          // not triggered yet

  e.setKnob('tg', 'value', 1); await tick();            // rising edge → capture 0.4
  assert.equal(e.outputValue('sh', 'out'), 0.4);
  e.setKnob('in', 'value', 0.9); await tick();          // input moves, but no new edge
  assert.equal(e.outputValue('sh', 'out'), 0.4);        // still held
  e.setKnob('tg', 'value', 0); await tick();
  e.setKnob('tg', 'value', 1); await tick();            // new rising edge → capture 0.9
  assert.equal(e.outputValue('sh', 'out'), 0.9);
});

test('proc.counter counts rising edges and resets', async () => {
  const e = createEngine(sr);
  e.addInstance('tg', 'src.const', { knobs: { value: 0 } });
  e.addInstance('rs', 'src.const', { knobs: { value: 0 } });
  e.addInstance('ct', 'proc.counter');
  e.connect({ id: 'tg', port: 'v' }, { id: 'ct', port: 'trig' });
  e.connect({ id: 'rs', port: 'v' }, { id: 'ct', port: 'reset' });
  const pulse = async () => { e.setKnob('tg', 'value', 1); await tick(); e.setKnob('tg', 'value', 0); await tick(); };
  await pulse(); await pulse(); await pulse();
  assert.equal(e.outputValue('ct', 'count'), 3);
  e.setKnob('rs', 'value', 1); await tick();
  assert.equal(e.outputValue('ct', 'count'), 0);
});

test('src.noise / proc.slew / disp.xy / disp.meter instantiate without throwing', () => {
  const e = createEngine(sr);
  assert.doesNotThrow(() => {
    e.addInstance('n', 'src.noise');
    e.addInstance('sl', 'proc.slew');
    e.addInstance('xy', 'disp.xy');
    e.addInstance('mt', 'disp.meter');
  });
  e.destroy();   // clears the noise/slew intervals
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
