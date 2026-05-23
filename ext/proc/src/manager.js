// @gcu/proc — ProcessManager.
//
// Top-level orchestrator. Owns the process table, applies maxProcesses,
// dispatches to createWorker, builds Process instances, applies timeouts.

import { MSG, MODE, STATE, EXIT, makePidGen, detectTransfer } from './protocol.js';
import { Process } from './process.js';
import { Pool } from './pool.js';
import { BOOTSTRAP_SOURCE } from './worker-bootstrap.js';

// Default browser worker creation — blob URL + new Worker(url).
//
// Classic worker (no { type: 'module' }) so we can spawn from blob:file://
// origins. Chromium blocks module-mode workers loaded from blob URLs that
// originate on file:// — the surface iframes in Auditable Works run from
// blob:file://*/uuid, and a module worker there fails to load entirely.
//
// The bootstrap source is structured to work as a classic script: no
// top-level await, no top-level import statements, no export — runtime
// detection and any user-module imports happen inside an async IIFE,
// where dynamic import() is supported in both classic and module workers.
function defaultCreateWorker(source) {
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
    throw new Error('proc: no Worker/Blob/URL globals — pass opts.createWorker (e.g. createNodeWorker)');
  }
  const blob = new Blob([source], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url);
  return {
    worker,
    cleanup: () => { try { URL.revokeObjectURL(url); } catch (_) {} },
  };
}

export class ProcessManager {
  constructor(opts = {}) {
    // Hard errors for not-yet-implemented features. See SPEC.md §12.
    if (opts.vfs !== undefined) {
      throw new Error('proc: { vfs } requires @gcu/proc Phase B (not in 0.1.x)');
    }
    if (opts.coreutils !== undefined) {
      throw new Error('proc: { coreutils } requires @gcu/proc Phase D (not in 0.1.x)');
    }

    this._createWorker = opts.createWorker || defaultCreateWorker;
    this._maxProcesses = opts.maxProcesses || (
      typeof navigator !== 'undefined' && navigator.hardwareConcurrency
    ) || 4;
    this._killGrace = opts.killGrace || 1000;
    this._nextPid = makePidGen(1);
    this._processes = new Map();    // pid → Process
    this._queue = [];                // queued spawns waiting on slot
    this._shutdown = false;
  }

  // Spawn a process. Returns Promise<Process> that resolves once the
  // worker has booted (sent READY).
  //
  // payload shapes:
  //   - function:      spawn(fn, { args, transfer, timeout, killGrace })
  //   - module-call:   spawn({ module, fn, args }, { transfer, timeout })
  //   - module-service:spawn({ module, mode: 'service' }, { timeout })
  spawn(payload, opts = {}) {
    if (this._shutdown) {
      return Promise.reject(new Error('proc: manager is shut down'));
    }

    // Hard errors for Phase A out-of-scope inputs.
    if (typeof payload === 'string') {
      throw new Error('proc: shell mode (string command) requires @gcu/proc Phase D (not in 0.1.x)');
    }
    if (opts.tty !== undefined) {
      throw new Error('proc: { tty } requires @gcu/proc Phase C (not in 0.1.x)');
    }
    if (opts.remote !== undefined) {
      throw new Error('proc: { remote } requires @gcu/proc Phase F (not in 0.1.x)');
    }

    const initMsg = this._buildInitMessage(payload, opts);

    // Queue if over the limit.
    if (this._activeCount() >= this._maxProcesses) {
      return new Promise((resolve, reject) => {
        this._queue.push({ initMsg, opts, resolve, reject, payload });
      });
    }
    return this._actuallySpawn(initMsg, opts, payload);
  }

  // Sugar over function-mode spawn: returns the function's return value
  // (or rethrows its error) instead of a Process.
  async compute(fn, args = [], opts = {}) {
    const proc = await this.spawn(fn, { ...opts, args });
    const code = await proc.wait();
    if (code !== EXIT.OK) {
      if (proc.error) throw proc.error;
      throw new Error('proc.compute: exit code ' + code);
    }
    return proc.result;
  }

  // Create a Pool of `n` keepalive workers. Each task dispatched via
  // pool.exec / pool.map runs on the next free worker (free-queue, not
  // round-robin).
  createPool(n, opts = {}) {
    if (this._shutdown) throw new Error('proc: manager is shut down');
    const size = n || this._maxProcesses;
    return new Pool(this, size);
  }

  list() {
    const out = [];
    for (const p of this._processes.values()) {
      out.push({
        pid: p.pid,
        state: p.state,
        mode: p.mode,
        startTime: p.startTime,
        duration: p.duration,
        command: p.command,
      });
    }
    return out;
  }

  get(pid) {
    return this._processes.get(pid) || null;
  }

  kill(pid, signal = 'INT') {
    const proc = this._processes.get(pid);
    if (proc) proc.kill(signal);
  }

  killAll(signal = 'KILL') {
    for (const p of this._processes.values()) {
      if (p.state === STATE.RUNNING) p.kill(signal);
    }
  }

  async waitAll() {
    const procs = Array.from(this._processes.values());
    await Promise.all(procs.map((p) => p.wait()));
  }

  shutdown() {
    this._shutdown = true;
    // Reject queued spawns.
    for (const q of this._queue) {
      try { q.reject(new Error('proc: manager is shut down')); } catch (_) {}
    }
    this._queue.length = 0;
    this.killAll('KILL');
  }

  // ── Internals ──

  _activeCount() {
    let n = 0;
    for (const p of this._processes.values()) {
      if (p.state === STATE.RUNNING) n++;
    }
    return n;
  }

  _buildInitMessage(payload, opts) {
    const transfer = opts.transfer && opts.transfer.length
      ? opts.transfer
      : detectTransfer(opts.args || []);

    if (typeof payload === 'function') {
      return {
        wire: {
          type: MSG.INIT,
          mode: MODE.FUNCTION,
          source: payload.toString(),
          args: opts.args || [],
          keepalive: !!opts.keepalive,
        },
        transfer,
        mode: MODE.FUNCTION,
        command: payload.name || '<fn>',
      };
    }

    if (payload && typeof payload === 'object' && typeof payload.module === 'string') {
      const explicitMode = payload.mode || opts.mode;
      // Default: module + fn → module-call. module alone → service.
      const mode = explicitMode
        ? (explicitMode === 'service' ? MODE.SERVICE : MODE.MODULE_CALL)
        : (payload.fn ? MODE.MODULE_CALL : MODE.SERVICE);

      if (mode === MODE.MODULE_CALL) {
        // Phase A: URL modules only. Anything that looks like a VFS path
        // (starts with '/') is rejected with a Phase B pointer.
        if (payload.module.startsWith('/')) {
          throw new Error('proc: VFS-path modules require @gcu/proc Phase B (not in 0.1.x). Use a URL or data: URI for now.');
        }
        return {
          wire: {
            type: MSG.INIT,
            mode: MODE.MODULE_CALL,
            url: payload.module,
            fn: payload.fn || 'default',
            args: payload.args || opts.args || [],
          },
          transfer,
          mode: MODE.MODULE_CALL,
          command: payload.module + ' ' + (payload.fn || 'default'),
        };
      }

      // service mode
      if (payload.module.startsWith('/')) {
        throw new Error('proc: VFS-path modules require @gcu/proc Phase B (not in 0.1.x). Use a URL or data: URI for now.');
      }
      return {
        wire: {
          type: MSG.INIT,
          mode: MODE.SERVICE,
          url: payload.module,
        },
        transfer: [],
        mode: MODE.SERVICE,
        command: payload.module,
      };
    }

    // Inline-source mode: caller hands us the worker module source as a
    // string. We concatenate it into the bootstrap blob so there is no
    // cross-blob import — needed for Chromium under file:// where every
    // blob URL has a unique opaque origin and module-mode workers can't
    // import(anotherBlobUrl). Wire mode: 'inline-service'. The inlined
    // user code must call _procRegisterEntry(fn) at module top level.
    if (payload && typeof payload === 'object' && typeof payload.inlineSource === 'string') {
      const explicitMode = payload.mode || opts.mode;
      if (explicitMode && explicitMode !== 'service') {
        throw new Error('proc: inlineSource is only supported with mode: "service" in 0.1.x');
      }
      return {
        wire: {
          type: MSG.INIT,
          mode: MODE.INLINE_SERVICE,
        },
        transfer: [],
        mode: MODE.INLINE_SERVICE,
        command: payload.command || '<inline>',
        inlineSource: payload.inlineSource,
      };
    }

    throw new TypeError('proc.spawn: payload must be a function, { module, ... } object, or { inlineSource, ... } object');
  }

  async _actuallySpawn(initMsg, opts, payload) {
    const pid = this._nextPid();
    // For inline-service mode, concatenate user code into the bootstrap
    // so there's no cross-blob import. See SPEC.md §3.4.
    const bootstrap = initMsg.inlineSource
      ? BOOTSTRAP_SOURCE + '\n;\n' + initMsg.inlineSource + '\n'
      : BOOTSTRAP_SOURCE;
    const { worker, cleanup } = this._createWorker(bootstrap);

    const proc = new Process({
      pid,
      mode: initMsg.mode,
      worker,
      cleanup,
      command: initMsg.command,
    });
    proc._killGrace = opts.killGrace || this._killGrace;

    this._processes.set(pid, proc);
    proc.wait().then(() => this._onProcessExit(pid));

    // Optional timeout: schedule INT then KILL.
    if (opts.timeout && opts.timeout > 0) {
      proc._timeoutTimer = setTimeout(() => {
        if (proc.state !== STATE.RUNNING) return;
        // Mark this as a timeout-kill so the final state reflects it.
        proc.kill('INT');
        setTimeout(() => {
          if (proc.state === STATE.RUNNING || proc.state === STATE.KILLED) {
            // Override to TIMEOUT/124 if still alive or just killed via the
            // INT grace path.
            if (proc.state === STATE.RUNNING) proc.kill('KILL');
            // Patch the final state in next tick (after _finish ran from KILL).
            queueMicrotask(() => {
              if (proc.state === STATE.KILLED && proc.exitCode === EXIT.KILL) {
                proc.state = STATE.TIMEOUT;
                proc.exitCode = EXIT.TIMEOUT;
              }
            });
          }
        }, proc._killGrace);
      }, opts.timeout);
    }

    // Wait for READY before resolving so the caller can immediately use the
    // process (post messages, etc.) without races.
    await proc.ready();
    if (proc.state !== STATE.RUNNING) {
      // The worker died during boot. Surface the error.
      if (proc.error) throw proc.error;
      throw new Error('proc: worker exited during boot (pid ' + pid + ', exit ' + proc.exitCode + ')');
    }

    // Post the init message now that the worker is ready.
    try {
      worker.postMessage(initMsg.wire, initMsg.transfer);
    } catch (err) {
      proc._onWorkerError(err);
      throw err;
    }

    return proc;
  }

  _onProcessExit(pid) {
    // Don't remove from the table — list() should still see the entry —
    // but drain the queue.
    if (this._queue.length === 0) return;
    if (this._shutdown) return;
    const next = this._queue.shift();
    this._actuallySpawn(next.initMsg, next.opts, next.payload)
      .then(next.resolve, next.reject);
  }
}
