// @gcu/proc — Node worker_threads adapter.
//
// Lets ProcessManager spawn workers in Node (for tests and headless
// runtimes). The browser default uses blob URLs + new Worker(); Node
// uses worker_threads, which has a slightly different interface:
//
//   - new Worker(filename, { workerData })       not (blob url, { type: 'module' })
//   - worker.on('message', fn)                   not worker.addEventListener('message', fn)
//   - parentPort (inside) instead of self
//
// This shim wraps worker_threads.Worker to match the browser Worker
// interface that proc's manager/process expect. The bootstrap source
// itself handles the worker-side runtime detect (see worker-bootstrap.js).
//
// Usage:
//   import { createNodeWorker } from '@gcu/proc/node';
//   const pm = new ProcessManager({ createWorker: createNodeWorker });

import { Worker as NodeWorker } from 'node:worker_threads';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export function createNodeWorker(source) {
  // Write the bootstrap source to a temp .mjs file so worker_threads can
  // load it as a module (top-level await, dynamic import).
  const tmpDir = os.tmpdir();
  const tmpPath = path.join(tmpDir, `proc-worker-${crypto.randomBytes(8).toString('hex')}.mjs`);
  fs.writeFileSync(tmpPath, source);

  const nodeWorker = new NodeWorker(tmpPath);

  // Track listeners so we can detach on removeEventListener — Node's
  // EventEmitter `off` works on the same function reference, but the
  // browser caller may not have direct access to the wrapped fn.
  const wrappers = new Map();

  const adapter = {
    postMessage(message, transfer) {
      nodeWorker.postMessage(message, transfer || []);
    },
    addEventListener(type, fn) {
      if (type === 'message') {
        const wrapped = (data) => fn({ data });
        wrappers.set(fn, wrapped);
        nodeWorker.on('message', wrapped);
      } else if (type === 'error') {
        const wrapped = (err) => fn(err);
        wrappers.set(fn, wrapped);
        nodeWorker.on('error', wrapped);
      } else if (type === 'messageerror') {
        const wrapped = (err) => fn(err);
        wrappers.set(fn, wrapped);
        nodeWorker.on('messageerror', wrapped);
      }
    },
    removeEventListener(type, fn) {
      const wrapped = wrappers.get(fn);
      if (!wrapped) return;
      wrappers.delete(fn);
      if (type === 'message') nodeWorker.off('message', wrapped);
      else if (type === 'error') nodeWorker.off('error', wrapped);
      else if (type === 'messageerror') nodeWorker.off('messageerror', wrapped);
    },
    terminate() {
      try { nodeWorker.terminate(); } catch (_) { /* ignore */ }
      // worker_threads.Worker.terminate() returns a Promise that resolves
      // when the worker actually exits — until then the worker holds an
      // event loop ref and the parent process can't exit. unref() drops
      // that ref so node:test (and any other host) can finalize without
      // waiting on the async tear-down. Safe because we're already done
      // with the worker by the time terminate() is called.
      try { nodeWorker.unref(); } catch (_) { /* ignore */ }
    },
  };

  return {
    worker: adapter,
    cleanup: () => {
      try { fs.unlinkSync(tmpPath); } catch (_) { /* race with another cleanup or already gone */ }
    },
  };
}
