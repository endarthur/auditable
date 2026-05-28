// @gcu/patchbay — renderer geometry + draw smoke (Phase B). Stubs a 2D canvas
// context so the canvas drawing path runs headless. The pointer/gesture layer
// (interact.js) is DOM-driven and verified in-browser at the surface stage.

import { test } from 'node:test';
import assert from 'node:assert';

import { signal, computed, effect, batch } from '../ext/sideact/src/signals.js';
import { defineModule, clearModuleRegistry } from '../ext/patchbay/src/sdk.js';
import { createEngine } from '../ext/patchbay/src/engine.js';
import { createRenderer, HP, RAIL_LEFT, RAIL_H, ROW_H } from '../ext/patchbay/src/render.js';
import { createPb } from '../ext/patchbay/src/pb.js';

const sr = { signal, computed, effect, batch };

clearModuleRegistry();
defineModule({
  type: 'knob', title: 'KNOB', hp: 10,
  knobs: { val: { default: 0.5 } }, ports: { out: { v: 'number' } },
  process: (_i, k) => ({ v: k.val }),
});
defineModule({
  type: 'add', title: 'ADD', hp: 8,
  ports: { in: { a: 'number', b: 'number' }, out: { sum: 'number' } },
  process: (i) => ({ sum: i.a + i.b }),
});

function stubCtx() {
  const grad = { addColorStop() {} };
  const calls = { fillRect: 0, stroke: 0, fillText: 0, arc: 0 };
  return {
    _calls: calls,
    setTransform() {}, save() {}, restore() {},
    beginPath() {}, moveTo() {}, lineTo() {}, arcTo() {}, closePath() {},
    arc() { calls.arc++; }, fill() {}, stroke() { calls.stroke++; },
    fillRect() { calls.fillRect++; }, fillText() { calls.fillText++; },
    createLinearGradient() { return grad; }, createRadialGradient() { return grad; },
    measureText() { return { width: 10 }; },
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '',
    font: '', textAlign: '', textBaseline: '',
  };
}
function stubCanvas() {
  const ctx = stubCtx();
  return {
    _ctx: ctx, width: 800, height: 600, clientWidth: 800, clientHeight: 600,
    getContext() { return ctx; },
  };
}

function build() {
  const canvas = stubCanvas();
  const engine = createEngine(sr);
  const renderer = createRenderer({ canvas, engine });
  renderer.resize();
  return { canvas, engine, renderer };
}

test('moduleRect derives pixel rect from row + hpPos', () => {
  const { engine, renderer } = build();
  engine.addInstance('k', 'knob', { row: 0, hpPos: 4 });
  const r = renderer.moduleRect(engine.instances.get('k'));
  assert.equal(r.x, RAIL_LEFT + 4 * HP);
  assert.equal(r.w, 10 * HP);
  // Faceplate covers both rails: content height + a rail strip top & bottom.
  assert.equal(r.h, ROW_H + 2 * RAIL_H);
  assert.equal(r.y, 100 - RAIL_H);
});

test('layout places control cells above ports with a display band between', () => {
  const { engine, renderer } = build();
  engine.addInstance('k', 'knob');
  const lay = renderer.layoutFor(engine.instances.get('k').def);
  assert.equal(lay.ports.length, 1);             // v (out)
  assert.equal(lay.cells.length, 1);             // the 'val' knob
  assert.ok(lay.cells.every((c) => c.y < lay.ports[0].y));
  assert.ok(lay.display.h > 0);
});

test('findPortAt locates a port at its world position', () => {
  const { engine, renderer } = build();
  engine.addInstance('k', 'knob', { row: 0, hpPos: 4 });
  const pos = renderer.portWorldPos(engine.instances.get('k'), 'v', 'out');
  const hit = renderer.findPortAt(pos.x, pos.y, 'mouse');
  assert.deepEqual(hit, { id: 'k', port: 'v', side: 'out' });
});

test('overlaps + snapTarget enforce the grid', () => {
  const { engine, renderer } = build();
  engine.addInstance('a', 'knob', { row: 0, hpPos: 0 });   // occupies HP 0..10
  const b = (engine.addInstance('b', 'add', { row: 0, hpPos: 20 }), engine.instances.get('b'));
  assert.equal(renderer.overlaps(b, 0, 5), true);    // would collide with 'a'
  assert.equal(renderer.overlaps(b, 0, 11), false);  // clear
  const snap = renderer.snapTarget(b, RAIL_LEFT + 30 * HP, renderer.rowYs()[0]);
  assert.equal(snap.row, 0);
  assert.equal(snap.valid, true);
});

test('draw() runs headless without throwing and issues canvas calls', () => {
  const { canvas, engine, renderer } = build();
  engine.addInstance('a', 'knob', { row: 0, hpPos: 4 });
  engine.addInstance('s', 'add', { row: 0, hpPos: 16 });
  engine.connect({ id: 'a', port: 'v' }, { id: 's', port: 'a' });
  renderer.fitToViewport();
  assert.doesNotThrow(() => renderer.draw({ railsOn: true }));
  assert.ok(canvas._ctx._calls.fillRect > 0);
  assert.ok(canvas._ctx._calls.fillText > 0);
});

test('pb display primitives all draw without throwing', () => {
  const canvas = stubCanvas();
  const engine = createEngine(sr);
  const pb = createPb(canvas._ctx);
  const renderer = createRenderer({ canvas, engine, pb });
  renderer.resize();
  defineModule({
    type: 'meter', title: 'METER', hp: 14,
    ports: { in: { x: 'number' }, out: { v: 'number' } },
    process: (i) => ({ v: i.x }),
    display(pbApi, out, st) {
      st.buf = st.buf || [0, 1, 0.5, 0.8, 0.2];
      pbApi.led(out.v, { label: 'on' });
      pbApi.bargraph(out.v, { steps: 8 });
      pbApi.numeric(out.v, { digits: 4, decimals: 1 });
      pbApi.lcd('PIT 3');
      pbApi.scope(st.buf);
      pbApi.dot(out.v, 0.5);
      pbApi.spectrum(st.buf);
      pbApi.indicator('ok');
    },
  });
  engine.addInstance('m', 'meter', { row: 0, hpPos: 0 });
  renderer.fitToViewport();
  assert.doesNotThrow(() => renderer.draw({ railsOn: true }));
});
