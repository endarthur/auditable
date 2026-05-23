// Tests for @gcu/proc — Phase A.
//
// All tests use the node-worker-shim. Each test gets a fresh
// ProcessManager so they don't share state.
//
// Fixture modules are written to OS tmpdir and imported by file:// URL.
// (data: URIs would work too but file:// keeps stack traces readable.)

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

import {
  ProcessManager, MODE, STATE, EXIT,
} from '../ext/proc/index.js';
import { createNodeWorker } from '../ext/proc/src/node-worker-shim.js';

// ── fixture helpers ──

const FIXTURES = [];

function fixture(name, source) {
  const file = path.join(
    os.tmpdir(),
    `proc-test-${crypto.randomBytes(4).toString('hex')}-${name}.mjs`,
  );
  fs.writeFileSync(file, source);
  FIXTURES.push(file);
  return pathToFileURL(file).href;
}

after(() => {
  for (const f of FIXTURES) {
    try { fs.unlinkSync(f); } catch (_) {}
  }
});

function makePm(opts = {}) {
  return new ProcessManager({ createWorker: createNodeWorker, ...opts });
}

// ── function mode ──

describe('function mode', () => {
  it('compute returns the function value', async () => {
    const pm = makePm();
    const r = await pm.compute((a, b) => a + b, [3, 4]);
    assert.equal(r, 7);
    pm.shutdown();
  });

  it('compute supports async functions', async () => {
    const pm = makePm();
    const r = await pm.compute(async (n) => {
      await new Promise((res) => setTimeout(res, 10));
      return n * 2;
    }, [21]);
    assert.equal(r, 42);
    pm.shutdown();
  });

  it('compute rethrows worker errors', async () => {
    const pm = makePm();
    await assert.rejects(
      pm.compute(() => { throw new Error('boom'); }),
      /boom/,
    );
    pm.shutdown();
  });

  it('spawn returns a Process with result + exit code', async () => {
    const pm = makePm();
    const proc = await pm.spawn((n) => n * n, { args: [9] });
    assert.equal(proc.mode, MODE.FUNCTION);
    assert.equal(proc.state, STATE.RUNNING);
    const code = await proc.wait();
    assert.equal(code, EXIT.OK);
    assert.equal(proc.state, STATE.DONE);
    assert.equal(proc.result, 81);
    pm.shutdown();
  });

  it('transfers ArrayBuffer round-trip (zero-copy hint accepted)', async () => {
    const pm = makePm();
    const buf = new Float64Array([1, 2, 3, 4]);
    const r = await pm.compute(
      (arr) => arr.map((x) => x * 2),
      [buf],
      { transfer: [buf.buffer] },
    );
    // Note: worker_threads.postMessage with transfer detaches the original;
    // we mainly check the result content survived.
    assert.equal(r.length, 4);
    assert.equal(r[3], 8);
    pm.shutdown();
  });
});

// ── module-call mode ──

describe('module-call mode', () => {
  it('calls a named export and returns its value', async () => {
    const url = fixture('add', `
      export function add(a, b) { return a + b; }
    `);
    const pm = makePm();
    const proc = await pm.spawn({ module: url, fn: 'add', args: [10, 20] });
    assert.equal(proc.mode, MODE.MODULE_CALL);
    const code = await proc.wait();
    assert.equal(code, EXIT.OK);
    assert.equal(proc.result, 30);
    pm.shutdown();
  });

  it('rejects with helpful error when fn is missing', async () => {
    const url = fixture('nofn', `export const x = 1;`);
    const pm = makePm();
    const proc = await pm.spawn({ module: url, fn: 'missing', args: [] });
    const code = await proc.wait();
    assert.notEqual(code, EXIT.OK);
    assert.ok(proc.error);
    assert.match(proc.error.message, /no exported function "missing"/);
    pm.shutdown();
  });

  it('rejects VFS-path modules with a Phase B pointer', async () => {
    const pm = makePm();
    assert.throws(
      () => pm.spawn({ module: '/local/path.js', fn: 'x' }),
      /Phase B/,
    );
    pm.shutdown();
  });
});

// ── module-service mode ──

describe('module-service mode', () => {
  it('boots and exchanges custom messages via ctx.send/on', async () => {
    const url = fixture('echo', `
      export default async function(ctx) {
        ctx.on(msg => {
          if (msg.type === 'ping') ctx.send({ type: 'pong', value: msg.value });
          if (msg.type === 'bye') ctx.exit(0);
        });
        // run forever until ctx.exit or signal
        await new Promise(r => ctx.signal.addEventListener('abort', r));
      }
    `);
    const pm = makePm();
    const proc = await pm.spawn({ module: url, mode: 'service' });
    assert.equal(proc.mode, MODE.SERVICE);

    const replies = [];
    proc.on(msg => replies.push(msg));

    proc.send({ type: 'ping', value: 'hello' });
    // Wait for the pong via a small spin.
    for (let i = 0; i < 100 && replies.length === 0; i++) {
      await new Promise(r => setTimeout(r, 10));
    }
    assert.equal(replies.length, 1);
    assert.deepEqual(replies[0], { type: 'pong', value: 'hello' });

    proc.send({ type: 'bye' });
    const code = await proc.wait();
    assert.equal(code, EXIT.OK);
    assert.equal(proc.state, STATE.DONE);
    pm.shutdown();
  });

  it('stdout/stderr stream from ctx into proc readable ports', async () => {
    const url = fixture('streams', `
      export default async function(ctx) {
        ctx.stdout('hello\\n');
        ctx.stderr('whoops\\n');
        ctx.exit(0);
      }
    `);
    const pm = makePm();
    const proc = await pm.spawn({ module: url, mode: 'service' });
    const out = await proc.stdout.text();
    const err = await proc.stderr.text();
    await proc.wait();
    assert.equal(out, 'hello\n');
    assert.equal(err, 'whoops\n');
    pm.shutdown();
  });

  it('default-export missing → error path', async () => {
    const url = fixture('nodef', `export const x = 1;`);
    const pm = makePm();
    const proc = await pm.spawn({ module: url, mode: 'service' });
    const code = await proc.wait();
    assert.notEqual(code, EXIT.OK);
    assert.match(proc.error?.message || '', /no default export/);
    pm.shutdown();
  });
});

// ── inline-service mode ──

describe('inline-service mode', () => {
  it('runs inlined user code that registered an entry', async () => {
    const inlineSource = `
      _procRegisterEntry(async function(ctx) {
        ctx.on(msg => {
          if (msg.type === 'hello') ctx.send({ type: 'world', got: msg.payload });
          if (msg.type === 'bye') ctx.exit(0);
        });
        await new Promise(r => ctx.signal.addEventListener('abort', r));
      });
    `;
    const pm = makePm();
    const proc = await pm.spawn({ inlineSource });
    assert.equal(proc.mode, MODE.INLINE_SERVICE);

    const replies = [];
    proc.on(msg => replies.push(msg));
    proc.send({ type: 'hello', payload: 42 });
    for (let i = 0; i < 100 && replies.length === 0; i++) {
      await new Promise(r => setTimeout(r, 10));
    }
    assert.deepEqual(replies[0], { type: 'world', got: 42 });

    proc.send({ type: 'bye' });
    const code = await proc.wait();
    assert.equal(code, EXIT.OK);
    pm.shutdown();
  });

  it('times out if user code never registers an entry', async () => {
    // Pass an inlineSource that does NOT call _procRegisterEntry. The
    // bootstrap should give up after 5s with a helpful error.
    // Override killGrace so we don't wait the full default after
    // the bootstrap reports its error.
    const inlineSource = `
      // Intentionally empty — never registers an entry.
      // The bootstrap's 5s timeout will fire.
    `;
    const pm = makePm({ killGrace: 100 });
    const proc = await pm.spawn({ inlineSource });
    const code = await proc.wait();
    assert.notEqual(code, EXIT.OK);
    assert.match(proc.error?.message || '', /_procRegisterEntry/);
    pm.shutdown();
  });

  it('inlineSource with mode other than "service" throws', () => {
    const pm = makePm();
    assert.throws(
      () => pm.spawn({ inlineSource: '/* */', mode: 'call' }),
      /only supported with mode: "service"/,
    );
    pm.shutdown();
  });
});

// ── signals ──

describe('signals', () => {
  it('INT cooperative: entry observes ctx.signal and exits 130', async () => {
    const url = fixture('coop', `
      export default async function(ctx) {
        await new Promise(r => ctx.signal.addEventListener('abort', r));
      }
    `);
    const pm = makePm();
    const proc = await pm.spawn({ module: url, mode: 'service' });
    proc.kill('INT');
    const code = await proc.wait();
    assert.equal(code, EXIT.INT);   // 130
    assert.equal(proc.state, STATE.KILLED);
    pm.shutdown();
  });

  it('INT escalates to KILL after grace period when ignored', async () => {
    const url = fixture('stubborn', `
      export default async function(ctx) {
        // Ignore signal entirely.
        await new Promise(() => {});
      }
    `);
    const pm = makePm({ killGrace: 100 });
    const proc = await pm.spawn({ module: url, mode: 'service' });
    proc.kill('INT');
    const code = await proc.wait();
    assert.equal(code, EXIT.KILL);  // 137
    assert.equal(proc.state, STATE.KILLED);
    pm.shutdown();
  });

  it('KILL force-terminates immediately', async () => {
    const url = fixture('forever', `
      export default async function(ctx) {
        await new Promise(() => {});
      }
    `);
    const pm = makePm();
    const proc = await pm.spawn({ module: url, mode: 'service' });
    proc.kill('KILL');
    const code = await proc.wait();
    assert.equal(code, EXIT.KILL);
    assert.equal(proc.state, STATE.KILLED);
    pm.shutdown();
  });
});

// ── pool ──

describe('pool', () => {
  it('dispatches tasks across keepalive workers and reuses them', async () => {
    const pm = makePm();
    const pool = pm.createPool(2);
    const results = await Promise.all([
      pool.exec((n) => n * 2, [1]),
      pool.exec((n) => n * 2, [2]),
      pool.exec((n) => n * 2, [3]),
      pool.exec((n) => n * 2, [4]),
    ]);
    assert.deepEqual(results.sort((a, b) => a - b), [2, 4, 6, 8]);
    // 4 tasks, 2 workers → at most 2 PIDs in the pool.
    assert.equal(pool.list().length, 2);
    pool.terminate();
    pm.shutdown();
  });

  it('map distributes across workers', async () => {
    const pm = makePm();
    const pool = pm.createPool(3);
    const out = await pool.map([1, 2, 3, 4, 5], (n) => n * n);
    assert.deepEqual(out, [1, 4, 9, 16, 25]);
    pool.terminate();
    pm.shutdown();
  });

  it('asCallable gives the legacy worker()/workerPool() shape', async () => {
    const pm = makePm();
    const pool = pm.createPool(2);
    const call = pool.asCallable((n) => n + 100);
    assert.equal(await call(1), 101);
    assert.deepEqual(await call.map([1, 2, 3]), [101, 102, 103]);
    call.terminate();
    pm.shutdown();
  });

  // pool.terminate while a task is in-flight on a worker.
  //
  // This corner case has needed three separate fixes to stop hanging
  // under varying conditions. Captured here because the layered
  // workarounds are the easiest thing to mis-edit later. Test #14 in
  // the work-log has the full investigation trail.
  //
  // (1) `.catch(() => {})` immediately after each pool.exec — owns the
  //     rejection synchronously so node:test's unhandled-rejection hook
  //     doesn't fire in the microtask gap between pw.currentReject(err)
  //     and assert.rejects attaching its observer.
  //
  // (2) `await pool._spawnPromise` BEFORE the first exec — pool.exec
  //     awaits this internally, but under heavy-load conditions (the
  //     orchestrator spawning many test subprocesses that all create
  //     worker_threads.Worker concurrently) the implicit await leaves
  //     a window where pool.terminate doesn't observe the rejection
  //     fire on time. Explicit pre-await closes the window.
  //
  // (3) `await new Promise(r => setTimeout(r, 50))` AFTER pool.terminate
  //     — gives the rejection-propagation microtasks room to drain
  //     before assert.rejects looks for them, same heavy-load reason as
  //     (2). Also tracked as task #14.
  //
  // None of these are required in real-world cell usage (the worker is
  // torn down between calls via the invalidation hook, not mid-call) —
  // they exist to make this stress-shaped test pass deterministically
  // even when proc.test runs alongside other worker_threads-using test
  // files in npm test's subprocess pool.
  it('rejects all pending and queued tasks on terminate', async () => {
    const pm = makePm();
    const pool = pm.createPool(1);
    await pool._spawnPromise;                    // (2)
    const inflight = pool.exec(() => new Promise(() => {}), []);
    inflight.catch(() => {});                    // (1)
    const queued = pool.exec(() => 1, []);
    queued.catch(() => {});                      // (1)
    await new Promise(r => setTimeout(r, 20));   // let dispatch post the inflight task
    pool.terminate();
    await new Promise(r => setTimeout(r, 50));   // (3)
    await assert.rejects(inflight, /terminated/);
    await assert.rejects(queued, /terminated/);
    pm.shutdown();
  });
});

// ── process table + limits ──

describe('process table', () => {
  it('list / get / killAll work', async () => {
    const pm = makePm();
    const a = await pm.spawn((n) => new Promise(r => setTimeout(() => r(n), 100)), { args: [1] });
    const b = await pm.spawn((n) => new Promise(r => setTimeout(() => r(n), 100)), { args: [2] });
    assert.equal(pm.list().length, 2);
    assert.ok(pm.get(a.pid));
    assert.ok(pm.get(b.pid));
    pm.killAll('KILL');
    await Promise.all([a.wait(), b.wait()]);
    assert.equal(a.state, STATE.KILLED);
    assert.equal(b.state, STATE.KILLED);
    pm.shutdown();
  });

  it('maxProcesses queues spawns beyond the cap', async () => {
    const pm = makePm({ maxProcesses: 1 });
    const a = await pm.spawn(() => new Promise(r => setTimeout(() => r('a'), 80)));
    const bPromise = pm.spawn(() => 'b');
    // After ~10ms, only `a` should be active.
    await new Promise(r => setTimeout(r, 10));
    assert.equal(pm.list().filter(p => p.state === STATE.RUNNING).length, 1);
    const aCode = await a.wait();
    assert.equal(aCode, EXIT.OK);
    const b = await bPromise;
    const bCode = await b.wait();
    assert.equal(bCode, EXIT.OK);
    pm.shutdown();
  });
});

// ── out-of-scope phase rejection ──

describe('out-of-scope features fail loud (no silent stubs)', () => {
  it('{ vfs } throws Phase B', () => {
    assert.throws(
      () => new ProcessManager({ vfs: {}, createWorker: createNodeWorker }),
      /Phase B/,
    );
  });

  it('{ coreutils } throws Phase D', () => {
    assert.throws(
      () => new ProcessManager({ coreutils: {}, createWorker: createNodeWorker }),
      /Phase D/,
    );
  });

  it('string payload throws Phase D', () => {
    const pm = makePm();
    assert.throws(() => pm.spawn('ls /tmp'), /Phase D/);
    pm.shutdown();
  });

  it('{ tty } throws Phase C', () => {
    const pm = makePm();
    assert.throws(() => pm.spawn(() => 1, { tty: {} }), /Phase C/);
    pm.shutdown();
  });

  it('{ remote } throws Phase F', () => {
    const pm = makePm();
    assert.throws(() => pm.spawn(() => 1, { remote: {} }), /Phase F/);
    pm.shutdown();
  });
});
