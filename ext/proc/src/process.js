// @gcu/proc — Process class.
//
// One Process per worker. Owns the worker handle, state machine, I/O
// channels, and the wire-protocol routing. The ProcessManager creates
// these; consumers receive them from pm.spawn().

import {
  MSG, MODE, STATE, EXIT,
  serializeError, deserializeError, attachMessage,
} from './protocol.js';
import { ReadablePort, WritablePort } from './channel.js';

export class Process {
  constructor({ pid, mode, worker, cleanup, command }) {
    this.pid = pid;
    this.mode = mode;
    this.command = command || '';
    this.state = STATE.RUNNING;
    this.startTime = new Date();
    this.duration = null;
    this.exitCode = null;
    this.result = undefined;
    this.error = null;

    this._worker = worker;
    this._cleanup = cleanup || (() => {});
    this._exitWaiters = [];
    this._msgHandlers = new Set();
    this._readySignal = null;          // resolved by READY message
    this._readyPromise = new Promise((r) => { this._readySignal = r; });
    this._terminated = false;
    this._killTimer = null;
    this._timeoutTimer = null;

    this.stdout = new ReadablePort();
    this.stderr = new ReadablePort();
    this.stdin = new WritablePort((m) => this._post(m));

    this._detachMessage = attachMessage(worker, (msg) => this._onMessage(msg));
    if (typeof worker.addEventListener === 'function') {
      worker.addEventListener('error', (e) => this._onWorkerError(e));
    } else if (typeof worker.on === 'function') {
      worker.on('error', (e) => this._onWorkerError(e));
    }
  }

  // Send a custom-protocol message to the worker. Available in any
  // service-flavored mode (module-service or inline-service).
  send(data, transfer) {
    if (this.mode !== MODE.SERVICE && this.mode !== MODE.INLINE_SERVICE) {
      throw new Error('proc.send() requires a service mode (module-service or inline-service)');
    }
    this._post({ type: MSG.MSG, data }, transfer);
  }

  // Subscribe to custom-protocol messages from the worker. Returns an
  // unsubscribe function.
  on(handler) {
    if (typeof handler !== 'function') throw new TypeError('proc.on(handler)');
    this._msgHandlers.add(handler);
    return () => this._msgHandlers.delete(handler);
  }

  // Wait until the worker posts READY (bootstrap loaded). Used by
  // ProcessManager so it can return a Process that's confirmed alive.
  ready() {
    return this._readyPromise;
  }

  // Resolves when the process leaves the running state. Returns exitCode.
  wait() {
    if (this.state !== STATE.RUNNING) return Promise.resolve(this.exitCode);
    return new Promise((resolve) => { this._exitWaiters.push(resolve); });
  }

  // Send a signal. INT is cooperative (fires the worker's AbortController);
  // KILL is forceful (worker.terminate()). Default: INT.
  kill(signal = 'INT') {
    if (this.state !== STATE.RUNNING) return;
    if (signal === 'KILL') {
      this._forceKill();
      return;
    }
    // Cooperative kill — let the worker bail out, escalate to KILL after
    // the grace period.
    try {
      this._post({ type: MSG.KILL, signal });
    } catch { /* worker may already be gone */ }
    if (!this._killTimer) {
      this._killTimer = setTimeout(() => this._forceKill(), this._killGrace || 1000);
    }
  }

  // ── Internals ──

  _post(message, transfer) {
    if (this._terminated) return;
    try {
      this._worker.postMessage(message, transfer || []);
    } catch (err) {
      // postMessage can throw if the worker terminated mid-flight; treat
      // as a clean teardown rather than crashing the manager.
      this._onWorkerError(err);
    }
  }

  _onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case MSG.READY:
        if (this._readySignal) {
          const r = this._readySignal;
          this._readySignal = null;
          r();
        }
        return;
      case MSG.STDOUT:
        this.stdout._deliver(msg.data || '');
        return;
      case MSG.STDERR:
        this.stderr._deliver(msg.data || '');
        return;
      case MSG.RESULT:
        this.result = msg.value;
        return;
      case MSG.ERROR:
        this.error = deserializeError(msg.error);
        return;
      case MSG.EXIT:
        this._finish(msg.code);
        return;
      case MSG.MSG: {
        const data = msg.data;
        for (const h of this._msgHandlers) {
          try { h(data); } catch { /* swallow */ }
        }
        return;
      }
      default:
        // Unknown lifecycle messages are ignored — gives the protocol
        // room to grow.
        return;
    }
  }

  _onWorkerError(err) {
    if (this.state !== STATE.RUNNING) return;
    this.error = err instanceof Error ? err : new Error(String(err && err.message || err));
    this._finish(EXIT.ERROR, STATE.ERROR);
  }

  _forceKill() {
    if (this._terminated) return;
    try { this._worker.terminate(); } catch { /* ignore */ }
    this._finish(EXIT.KILL, STATE.KILLED);
  }

  _finish(code, forcedState) {
    if (this._terminated) return;
    this._terminated = true;

    // Resolve state. If a forced state was passed (timeout, kill, error)
    // honor it; otherwise infer from the exit code.
    if (forcedState) {
      this.state = forcedState;
    } else if (this.error) {
      this.state = STATE.ERROR;
    } else if (code === EXIT.OK) {
      this.state = STATE.DONE;
    } else if (code === EXIT.INT) {
      this.state = STATE.KILLED;
    } else if (code === EXIT.TIMEOUT) {
      this.state = STATE.TIMEOUT;
    } else {
      this.state = STATE.ERROR;
    }
    this.exitCode = code;
    this.duration = Date.now() - this.startTime.getTime();

    if (this._killTimer) { clearTimeout(this._killTimer); this._killTimer = null; }
    if (this._timeoutTimer) { clearTimeout(this._timeoutTimer); this._timeoutTimer = null; }

    if (this._detachMessage) {
      try { this._detachMessage(); } catch { /* ignore */ }
    }
    try { this._worker.terminate(); } catch { /* worker may already be dead */ }
    try { this._cleanup(); } catch { /* ignore */ }

    // Close I/O streams so consumers' text() / async iterators resolve.
    this.stdout._close();
    this.stderr._close();

    // Resolve the ready promise so callers awaiting it don't hang.
    if (this._readySignal) {
      const r = this._readySignal;
      this._readySignal = null;
      r();
    }

    // Resolve all wait() callers.
    const waiters = this._exitWaiters;
    this._exitWaiters = [];
    for (const w of waiters) {
      try { w(this.exitCode); } catch { /* ignore */ }
    }
  }
}
