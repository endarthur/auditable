// hook bus — pure module tests, no DOM shim
//
// Covers spec §6: on returns unsubscribe, once self-removes, off removes,
// emit calls in order, emit continues on throw, emitAsync awaits in order,
// listenerCount returns 0 for unknown events, _clearAll drops everything,
// unknown event emit is no-op, leak-free under stress.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  on, once, off, emit, emitAsync, listenerCount, _clearAll,
  setDagCellInterceptor, getDagCellInterceptor,
} from '../src/js/hooks.js';

describe('hooks bus', () => {
  beforeEach(() => _clearAll());

  it('on returns an unsubscribe handle', () => {
    let count = 0;
    const unsub = on('x', () => { count++; });
    emit('x');
    assert.equal(count, 1);
    unsub();
    emit('x');
    assert.equal(count, 1);
  });

  it('once fires exactly once and self-removes', () => {
    let count = 0;
    once('x', () => { count++; });
    emit('x');
    emit('x');
    emit('x');
    assert.equal(count, 1);
  });

  it('off removes a specific listener', () => {
    let a = 0, b = 0;
    const fa = () => { a++; };
    const fb = () => { b++; };
    on('x', fa);
    on('x', fb);
    off('x', fa);
    emit('x');
    assert.equal(a, 0);
    assert.equal(b, 1);
  });

  it('emit calls listeners in registration order', () => {
    const order = [];
    on('x', () => order.push('first'));
    on('x', () => order.push('second'));
    on('x', () => order.push('third'));
    emit('x');
    assert.deepEqual(order, ['first', 'second', 'third']);
  });

  it('emit continues even if a listener throws', () => {
    const order = [];
    const origError = console.error;
    console.error = () => {};  // suppress expected error log
    try {
      on('x', () => order.push(1));
      on('x', () => { throw new Error('boom'); });
      on('x', () => order.push(3));
      emit('x');
    } finally { console.error = origError; }
    assert.deepEqual(order, [1, 3]);
  });

  it('emit passes args through', () => {
    let received = null;
    on('x', (a, b, c) => { received = [a, b, c]; });
    emit('x', 1, 'two', { three: 3 });
    assert.deepEqual(received, [1, 'two', { three: 3 }]);
  });

  it('emitAsync awaits each listener in registration order', async () => {
    const order = [];
    on('x', async () => { await new Promise(r => setTimeout(r, 10)); order.push('first'); });
    on('x', async () => { order.push('second'); });
    await emitAsync('x');
    assert.deepEqual(order, ['first', 'second']);
  });

  it('listenerCount returns 0 for unknown events', () => {
    assert.equal(listenerCount('never-emitted'), 0);
  });

  it('listenerCount tracks adds and removes', () => {
    assert.equal(listenerCount('x'), 0);
    const unsub = on('x', () => {});
    assert.equal(listenerCount('x'), 1);
    on('x', () => {});
    assert.equal(listenerCount('x'), 2);
    unsub();
    assert.equal(listenerCount('x'), 1);
  });

  it('emit on unknown event is a no-op', () => {
    emit('never-registered');  // must not throw
    assert.ok(true);
  });

  it('on rejects empty event names', () => {
    assert.throws(() => on('', () => {}), /non-empty string/);
    assert.throws(() => on(null, () => {}), /non-empty string/);
  });

  it('on rejects non-function listeners', () => {
    assert.throws(() => on('x', null), /must be a function/);
    assert.throws(() => on('x', 'not a fn'), /must be a function/);
  });

  it('handles 1000 listeners and 1000 emits without leaks', () => {
    const unsubs = [];
    let count = 0;
    for (let i = 0; i < 1000; i++) unsubs.push(on('x', () => { count++; }));
    for (let i = 0; i < 1000; i++) emit('x');
    assert.equal(count, 1000 * 1000);
    for (const u of unsubs) u();
    assert.equal(listenerCount('x'), 0);
  });
});

describe('dag cell interceptor', () => {
  beforeEach(() => setDagCellInterceptor(null));

  it('null by default', () => {
    assert.equal(getDagCellInterceptor(), null);
  });

  it('set and get a function', () => {
    const fn = (cell, idx) => idx;
    setDagCellInterceptor(fn);
    assert.equal(getDagCellInterceptor(), fn);
  });

  it('clear with null', () => {
    setDagCellInterceptor((c, i) => i);
    setDagCellInterceptor(null);
    assert.equal(getDagCellInterceptor(), null);
  });

  it('rejects non-function non-null', () => {
    assert.throws(() => setDagCellInterceptor('not a fn'), /function or null/);
    assert.throws(() => setDagCellInterceptor({}), /function or null/);
  });
});
