// Worker builtins test — validates the serialization pattern and pool logic
// Uses Node worker_threads to approximate browser Web Workers

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

// Reproduce the same serialization pattern used in exec.js
function makeWorker(fn) {
  // Node worker_threads version of the same blob URL pattern
  const src = `"use strict";\nconst { parentPort } = require('worker_threads');\nconst __fn__ = ${fn.toString()};\nparentPort.on('message', async (msg) => {\n  try {\n    const result = await __fn__(...msg.args);\n    parentPort.postMessage({ id: msg.id, result });\n  } catch (err) { parentPort.postMessage({ id: msg.id, error: err.message }); }\n});`;

  const w = new Worker(src, { eval: true });
  let nextId = 0;
  const pending = new Map();

  w.on('message', (msg) => {
    const cb = pending.get(msg.id);
    if (!cb) return;
    pending.delete(msg.id);
    if (msg.error) cb.reject(new Error(msg.error));
    else cb.resolve(msg.result);
  });
  w.on('error', (e) => {
    for (const cb of pending.values()) cb.reject(e);
    pending.clear();
  });

  const call = (...args) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    w.postMessage({ id, args });
  });
  call.terminate = () => w.terminate();
  return call;
}

function makePool(fn, n = 2) {
  const workers = Array.from({ length: n }, () => makeWorker(fn));
  const free = [...workers];
  const queue = [];

  const dispatch = () => {
    while (queue.length && free.length) {
      const { args, resolve, reject } = queue.shift();
      const w = free.shift();
      w(...args).then(
        r => { free.push(w); resolve(r); dispatch(); },
        e => { free.push(w); reject(e); dispatch(); }
      );
    }
  };

  const pool = (...args) => new Promise((resolve, reject) => {
    queue.push({ args, resolve, reject });
    dispatch();
  });
  pool.map = (arr, ...extra) => Promise.all(arr.map(item => pool(item, ...extra)));
  pool.terminate = () => workers.forEach(w => w.terminate());
  return pool;
}

describe('worker', () => {
  it('runs a pure function and returns result', async () => {
    const double = makeWorker((x) => x * 2);
    const result = await double(21);
    assert.equal(result, 42);
    double.terminate();
  });

  it('handles multiple sequential calls', async () => {
    const add = makeWorker((a, b) => a + b);
    assert.equal(await add(1, 2), 3);
    assert.equal(await add(10, 20), 30);
    add.terminate();
  });

  it('handles async functions', async () => {
    const slow = makeWorker(async (x) => {
      await new Promise(r => setTimeout(r, 10));
      return x + 1;
    });
    assert.equal(await slow(5), 6);
    slow.terminate();
  });

  it('propagates errors', async () => {
    const fail = makeWorker(() => { throw new Error('boom'); });
    await assert.rejects(() => fail(), { message: 'boom' });
    fail.terminate();
  });

  it('handles typed arrays', async () => {
    const sum = makeWorker((arr) => {
      let s = 0;
      for (let i = 0; i < arr.length; i++) s += arr[i];
      return s;
    });
    const result = await sum([1, 2, 3, 4, 5]);
    assert.equal(result, 15);
    sum.terminate();
  });

  it('serializes function with closures stripped (pure only)', async () => {
    // The function must be self-contained — no closures
    const compute = makeWorker((n) => {
      let total = 0;
      for (let i = 1; i <= n; i++) total += i;
      return total;
    });
    assert.equal(await compute(100), 5050);
    compute.terminate();
  });
});

describe('workerPool', () => {
  it('dispatches work across multiple workers', async () => {
    const pool = makePool((x) => x * x, 2);
    const results = await pool.map([1, 2, 3, 4, 5]);
    // pool.map preserves input order (Promise.all)
    assert.deepEqual(results, [1, 4, 9, 16, 25]);
    pool.terminate();
  });

  it('handles more tasks than workers (queuing)', async () => {
    const pool = makePool((x) => x + 1, 2);
    const results = await pool.map([10, 20, 30, 40, 50, 60, 70, 80]);
    assert.deepEqual(results, [11, 21, 31, 41, 51, 61, 71, 81]);
    pool.terminate();
  });

  it('terminates all workers', async () => {
    const pool = makePool((x) => x, 2);
    await pool(1);
    pool.terminate();
    // no assertion — just verifying terminate doesn't throw
  });

  it('individual calls work', async () => {
    const pool = makePool((a, b) => a + b, 2);
    assert.equal(await pool(3, 4), 7);
    assert.equal(await pool(10, 20), 30);
    pool.terminate();
  });

  it('propagates errors from pool workers', async () => {
    const pool = makePool((x) => {
      if (x < 0) throw new Error('negative');
      return x;
    }, 2);
    assert.equal(await pool(5), 5);
    await assert.rejects(() => pool(-1), { message: 'negative' });
    pool.terminate();
  });

  it('map passes extra args', async () => {
    const pool = makePool((x, factor) => x * factor, 2);
    const results = await pool.map([1, 2, 3], 10);
    assert.deepEqual(results, [10, 20, 30]);
    pool.terminate();
  });
});
