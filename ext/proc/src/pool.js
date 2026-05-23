// @gcu/proc — Pool.
//
// A pool keeps N workers alive across many task dispatches. Each worker
// boots in function mode with { keepalive: true } so the bootstrap
// doesn't terminate after the first result. Subsequent tasks are sent as
// new _proc_init messages on the same worker.
//
// Dispatch is free-queue, not round-robin: the first free worker takes
// the next task. This avoids dispatching to a busy worker just because
// it's next in rotation.

import { MSG, MODE, detectTransfer } from './protocol.js';
import { Process } from './process.js';
import { BOOTSTRAP_SOURCE } from './worker-bootstrap.js';

export class Pool {
  constructor(manager, size) {
    this._manager = manager;
    this._size = size;
    this._workers = [];          // PoolWorker objects
    this._free = [];             // currently-idle PoolWorker objects
    this._queue = [];            // { fn, args, opts, resolve, reject }
    this._terminated = false;
    this._spawnPromise = this._spawnAll();
  }

  async _spawnAll() {
    const promises = [];
    for (let i = 0; i < this._size; i++) {
      promises.push(this._spawnOne());
    }
    await Promise.all(promises);
  }

  async _spawnOne() {
    const { worker, cleanup } = this._manager._createWorker(BOOTSTRAP_SOURCE);
    const pid = this._manager._nextPid();
    const proc = new Process({
      pid,
      mode: MODE.FUNCTION,
      worker,
      cleanup,
      command: '<pool>',
    });
    this._manager._processes.set(pid, proc);
    await proc.ready();

    const pw = { proc, busy: false, currentResolve: null, currentReject: null };

    // Intercept RESULT/ERROR/EXIT before Process's default handler so we
    // can recycle the worker for the next task. Process.onMessage's
    // default behavior would mark the worker as exited on RESULT — but in
    // pool mode the worker stays alive after each result.
    const orig = proc._onMessage.bind(proc);
    proc._onMessage = (msg) => {
      if (!msg || typeof msg !== 'object') { orig(msg); return; }

      if (msg.type === MSG.RESULT) {
        const r = pw.currentResolve;
        pw.currentResolve = null;
        pw.currentReject = null;
        pw.busy = false;
        // Update proc.result for diag (Process's orig() also sets it, but
        // calling orig() with RESULT is fine since RESULT doesn't change
        // state by itself in Process — only EXIT does).
        proc.result = msg.value;
        if (r) r(msg.value);
        this._returnToFree(pw);
        return;
      }

      if (msg.type === MSG.ERROR) {
        const j = pw.currentReject;
        pw.currentResolve = null;
        pw.currentReject = null;
        pw.busy = false;
        // Capture the error on proc.error for diag, but DON'T let Process
        // transition to ERROR state (we want to keep the worker alive).
        try {
          proc.error = msg.error && msg.error.message
            ? Object.assign(new Error(msg.error.message), { stack: msg.error.stack })
            : new Error('pool worker error');
        } catch (_) {}
        if (j) j(proc.error);
        this._returnToFree(pw);
        return;
      }

      if (msg.type === MSG.EXIT) {
        // Worker died unexpectedly. Reject the current task (if any) and
        // remove from the pool.
        const j = pw.currentReject;
        pw.currentResolve = null;
        pw.currentReject = null;
        pw.busy = false;
        orig(msg);
        if (j) j(new Error('pool worker exited unexpectedly (code ' + msg.code + ')'));
        this._removeWorker(pw);
        return;
      }

      orig(msg);
    };

    this._workers.push(pw);
    this._free.push(pw);
    this._dispatch();
  }

  // Run a function on a free pool worker. Returns the function's result.
  async exec(fn, args = [], opts = {}) {
    if (this._terminated) throw new Error('pool: terminated');
    await this._spawnPromise;
    return new Promise((resolve, reject) => {
      this._queue.push({ fn, args, opts, resolve, reject });
      this._dispatch();
    });
  }

  // Map across an array. Each item is passed as the first arg; extra
  // args from opts.extra are appended.
  async map(items, fn, opts = {}) {
    const extra = opts.extra || [];
    return Promise.all(items.map((item) => this.exec(fn, [item, ...extra], opts)));
  }

  // Replicate auditable's workerPool() builtin shape: callable that
  // takes args and returns the result. Each call goes to a free worker.
  // Used by the legacy worker()/workerPool() compatibility shim.
  asCallable(fn) {
    const call = (...args) => this.exec(fn, args);
    call.map = (arr, ...extra) => this.map(arr, fn, { extra });
    call.terminate = () => this.terminate();
    return call;
  }

  list() {
    return this._workers.map((pw) => ({
      pid: pw.proc.pid,
      busy: pw.busy,
      state: pw.proc.state,
    }));
  }

  terminate() {
    if (this._terminated) return;
    this._terminated = true;
    for (const pw of this._workers) {
      try { pw.proc.kill('KILL'); } catch (_) {}
      if (pw.currentReject) {
        try { pw.currentReject(new Error('pool: terminated')); } catch (_) {}
      }
    }
    this._workers.length = 0;
    this._free.length = 0;
    const queued = this._queue;
    this._queue = [];
    for (const q of queued) {
      try { q.reject(new Error('pool: terminated')); } catch (_) {}
    }
  }

  // ── Internals ──

  _dispatch() {
    while (this._queue.length && this._free.length) {
      const pw = this._free.shift();
      const task = this._queue.shift();
      pw.busy = true;
      pw.currentResolve = task.resolve;
      pw.currentReject = task.reject;
      const transfer = task.opts.transfer && task.opts.transfer.length
        ? task.opts.transfer
        : detectTransfer(task.args);
      try {
        pw.proc._worker.postMessage({
          type: MSG.INIT,
          mode: MODE.FUNCTION,
          source: task.fn.toString(),
          args: task.args,
          keepalive: true,
        }, transfer);
      } catch (err) {
        pw.busy = false;
        pw.currentResolve = null;
        pw.currentReject = null;
        this._free.push(pw);
        task.reject(err);
      }
    }
  }

  _returnToFree(pw) {
    if (this._terminated) return;
    if (this._workers.indexOf(pw) < 0) return;
    if (this._free.indexOf(pw) < 0) this._free.push(pw);
    this._dispatch();
  }

  _removeWorker(pw) {
    const i = this._workers.indexOf(pw);
    if (i >= 0) this._workers.splice(i, 1);
    const fi = this._free.indexOf(pw);
    if (fi >= 0) this._free.splice(fi, 1);
  }
}
