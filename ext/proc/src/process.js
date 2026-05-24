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
  constructor({ pid, mode, worker, cleanup, command, vfs, tty, manager, principal, vfsCheckPermission }) {
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
    this._vfs = vfs || null;        // host VFS for _proc_vfs_call dispatch
    this._tty = tty || null;        // host tty for _proc_tty_* event forwarding
    this._ttyUnsubs = [];           // event-subscription cleanup fns
    this._manager = manager || null; // host ProcessManager for _proc_pm_call dispatch (Phase D)
    this._principal = principal || null;         // principal sandbox (0.5.1+)
    this._vfsCheckPermission = vfsCheckPermission || null;
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

    // Phase C TTY proxy: if a host tty was supplied, subscribe to its
    // input events and forward them to the worker as _proc_tty_* messages.
    // Worker→host writes are handled in _onMessage's _proc_tty_write case.
    if (this._tty) this._wireTty(this._tty);
  }

  _wireTty(tty) {
    const post = (m) => this._post(m);
    if (typeof tty.onKey === 'function') {
      try {
        const u = tty.onKey((key) => post({ type: '_proc_tty_key', key }));
        if (typeof u === 'function') this._ttyUnsubs.push(u);
      } catch (_) { /* host onKey threw — skip */ }
    }
    if (typeof tty.onMouse === 'function') {
      try {
        const u = tty.onMouse((event) => post({ type: '_proc_tty_mouse', event }));
        if (typeof u === 'function') this._ttyUnsubs.push(u);
      } catch (_) {}
    }
    if (typeof tty.onResize === 'function') {
      try {
        const u = tty.onResize((sz) => {
          const rows = (sz && sz.rows) || 24;
          const cols = (sz && sz.cols) || 80;
          post({ type: '_proc_tty_resize', rows, cols });
        });
        if (typeof u === 'function') this._ttyUnsubs.push(u);
      } catch (_) {}
    }
  }

  // Send a custom-protocol message to the worker. Available in any
  // service-flavored mode (module-service, inline-service, shell-service).
  send(data, transfer) {
    if (this.mode !== MODE.SERVICE && this.mode !== MODE.INLINE_SERVICE && this.mode !== MODE.SHELL) {
      throw new Error('proc.send() requires a service mode (module-service, inline-service, or shell-service)');
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
      case '_proc_vfs_call':
        // Phase B VFS proxy: the worker is asking us to run a method on
        // a host-side backend. Dispatch async; reply with the result or
        // a serialized error.
        this._handleVfsCall(msg);
        return;
      case '_proc_tty_write':
        // Phase C TTY proxy: worker is asking the host tty to render data
        // (bytes, escape sequences, etc). Fire-and-forget; no reply.
        if (this._tty && typeof this._tty.write === 'function') {
          try { this._tty.write(msg.data); } catch { /* swallow */ }
        }
        return;
      case '_proc_pm_call':
        // Phase D: worker is asking the host ProcessManager to do
        // something (spawn, list, kill, subscribeExit). Dispatch async,
        // reply with the result or a serialized error.
        this._handlePmCall(msg);
        return;
      default:
        // Unknown lifecycle messages are ignored — gives the protocol
        // room to grow.
        return;
    }
  }

  async _handlePmCall(msg) {
    const reply = (payload) => {
      try { this._post({ type: '_proc_pm_reply', id: msg.id, ...payload }); }
      catch (_) { /* worker may already be gone */ }
    };
    if (!this._manager) {
      reply({ ok: false, error: { message: 'proc: process has no host ProcessManager configured' } });
      return;
    }
    const method = typeof msg.method === 'string' ? msg.method : '';
    const args = Array.isArray(msg.args) ? msg.args : [];
    try {
      if (method === 'spawn') {
        let [payload, opts] = args;
        // Function payloads come over the wire as { __fn__: source }; we
        // can't reconstruct an actual function here (we'd need eval, and
        // the function's closures wouldn't survive anyway). Reject with
        // a helpful error — string commands (the geas `&` case) are the
        // supported path for Phase D.
        if (payload && typeof payload === 'object' && typeof payload.__fn__ === 'string') {
          reply({ ok: false, error: { message: 'proc: ctx.pm.spawn(fn) is not supported in Phase D — pass a string command (with opts.shell) or a {module, mode} object' } });
          return;
        }
        // Principal inheritance (0.5.1+): sub-process picks up the
        // parent's principal unless the caller explicitly overrode via
        // opts.principal. This is what keeps sandbox boundaries from
        // leaking when a sandboxed worker spawns a child.
        const childOpts = { ...(opts || {}) };
        if (childOpts.principal == null && this._principal != null) {
          childOpts.principal = this._principal;
        }
        const subProc = await this._manager.spawn(payload, childOpts);
        reply({ ok: true, value: { pid: subProc.pid } });
        return;
      }
      if (method === 'list') {
        reply({ ok: true, value: this._manager.list() });
        return;
      }
      if (method === 'kill') {
        const [pid, signal] = args;
        this._manager.kill(pid, signal || 'INT');
        reply({ ok: true, value: null });
        return;
      }
      if (method === 'subscribeExit') {
        // Worker is awaiting a sub-process. When the target Process exits,
        // we send _proc_pm_exit so the worker's wait() resolves.
        const pid = args[0];
        const target = this._manager.get(pid);
        if (!target) {
          reply({ ok: true, value: null });
          // Fire an immediate exit event so the worker doesn't hang.
          try { this._post({ type: '_proc_pm_exit', pid, exitCode: -1 }); } catch (_) {}
          return;
        }
        if (target.state !== STATE.RUNNING) {
          reply({ ok: true, value: null });
          try { this._post({ type: '_proc_pm_exit', pid, exitCode: target.exitCode }); } catch (_) {}
          return;
        }
        target.wait().then((exitCode) => {
          try { this._post({ type: '_proc_pm_exit', pid, exitCode }); } catch (_) {}
        });
        reply({ ok: true, value: null });
        return;
      }
      reply({ ok: false, error: { message: 'proc: unknown ctx.pm method "' + method + '"' } });
    } catch (err) {
      reply({ ok: false, error: { message: err && err.message ? err.message : String(err) } });
    }
  }

  async _handleVfsCall(msg) {
    const reply = (payload) => {
      try { this._post({ type: '_proc_vfs_reply', id: msg.id, ...payload }); }
      catch (_) { /* worker may already be gone */ }
    };
    if (!this._vfs || !this._vfs._mounts) {
      reply({ ok: false, error: { message: 'proc: process has no host VFS configured' } });
      return;
    }
    const backend = this._vfs._mounts.get(msg.mountPath);
    if (!backend) {
      reply({ ok: false, error: { message: 'proc: no mount at "' + msg.mountPath + '"', code: 'ENOENT', path: msg.mountPath } });
      return;
    }
    const method = typeof msg.method === 'string' ? msg.method : '';
    if (typeof backend[method] !== 'function') {
      reply({ ok: false, error: { message: 'proc: backend has no method "' + method + '"', code: 'ENOTSUP', path: msg.mountPath } });
      return;
    }
    try {
      const args = Array.isArray(msg.args) ? msg.args : [];
      // Principal sandbox check (0.5.1+). VFS methods take the path as
      // first arg; for two-path methods like rename / cp, check both.
      if (this._principal && this._vfsCheckPermission) {
        const checkPaths = (method === 'rename' || method === 'cp')
          ? [args[0], args[1]]                       // src + dst both checked
          : [args[0]];
        for (const p of checkPaths) {
          if (typeof p === 'string') {
            // Re-anchor: the worker's path is relative to the mount; the
            // host check needs the full path the principal was scoped to.
            const fullPath = msg.mountPath === '/' ? p : (msg.mountPath.replace(/\/$/, '') + p);
            this._vfsCheckPermission(method, fullPath, this._principal);
          }
        }
      }
      const value = await backend[method](...args);
      reply({ ok: true, value });
    } catch (err) {
      const errPayload = {
        message: err && err.message ? err.message : String(err),
      };
      if (err && err.code) errPayload.code = err.code;
      if (err && err.path) errPayload.path = err.path;
      reply({ ok: false, error: errPayload });
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

    // Phase C: drop our tty event subscriptions so the host tty doesn't
    // keep firing into a dead Process.
    for (const u of this._ttyUnsubs) {
      try { u(); } catch { /* swallow */ }
    }
    this._ttyUnsubs = [];

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
