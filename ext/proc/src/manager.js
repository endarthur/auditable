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
    if (opts.coreutils !== undefined) {
      throw new Error('proc: { coreutils } requires @gcu/proc Phase D (not in 0.2.x)');
    }

    // VFS proxy (Phase B, since 0.2.0). When a VFS instance is provided,
    // spawned workers can access it: function/module-call modes get vfs
    // as the last arg when opts.vfs is true at spawn-time; module-service
    // mode always sees ctx.vfs. The worker needs to load @gcu/vfs to
    // instantiate the worker-side VFS — caller picks the deployment shape:
    //   - vfsBundleSource: inlined into the worker blob (file:// friendly).
    //   - vfsModuleUrl:    awaited via import(url) in the worker (HTTP).
    // Exactly one of the two must be supplied with vfs.
    if (opts.vfs !== undefined) {
      if (!opts.vfsBundleSource && !opts.vfsModuleUrl) {
        throw new Error('proc: { vfs } requires either { vfsBundleSource } (inline) or { vfsModuleUrl } (URL) so the worker can load @gcu/vfs');
      }
      if (opts.vfsBundleSource && opts.vfsModuleUrl) {
        throw new Error('proc: pass either vfsBundleSource OR vfsModuleUrl, not both');
      }
      if (!opts.vfs._mounts || typeof opts.vfs._mounts.entries !== 'function') {
        throw new Error('proc: { vfs } must be a @gcu/vfs VFS instance (with _mounts)');
      }
    }
    this._vfs = opts.vfs || null;
    this._vfsBundleSource = opts.vfsBundleSource || null;
    this._vfsModuleUrl = opts.vfsModuleUrl || null;

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

  // Walk the configured VFS's mount table and produce a serializable
  // description the worker can use to reconstruct a peer VFS:
  //   [{ path, mode: 'direct', config }, { path, mode: 'proxy' }, ...]
  // Backends that override toConfig() to return a {type, ...opts} object
  // get the 'direct' treatment — the worker instantiates the same class
  // pointing at the same underlying storage. Backends whose toConfig()
  // returns null get 'proxy' — every operation RPCs to the main thread.
  _buildVfsMountTable() {
    if (!this._vfs) return null;
    const out = [];
    for (const [mountPath, backend] of this._vfs._mounts) {
      let config = null;
      try { config = backend.toConfig && backend.toConfig(); }
      catch (_) { config = null; }
      if (config && typeof config === 'object' && typeof config.type === 'string') {
        out.push({ path: mountPath, mode: 'direct', config });
      } else {
        out.push({ path: mountPath, mode: 'proxy' });
      }
    }
    return out;
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

    // Hard errors for out-of-scope inputs.
    if (opts.remote !== undefined) {
      throw new Error('proc: { remote } requires @gcu/proc Phase F (not in 0.4.x)');
    }
    // String payload now routes to shell-service mode (Phase D, 0.4.0+).
    // Validation happens in _buildInitMessage.

    // Phase C TTY proxy: only honored in service modes (module-service /
    // inline-service) — function/module-call modes return a value and
    // terminate; interactive TUI semantics don't apply there.
    if (opts.tty !== undefined) {
      if (typeof payload === 'function') {
        throw new Error('proc: { tty } is not supported in function mode — use module-service or inline-service');
      }
      if (payload && typeof payload === 'object' && payload.module && payload.fn) {
        throw new Error('proc: { tty } is not supported in module-call mode — use module-service or inline-service');
      }
      // Sanity-check the shape — caller-provided host tty must at least
      // have write, size, and onKey.
      if (typeof opts.tty.write !== 'function' ||
          typeof opts.tty.size !== 'function' ||
          typeof opts.tty.onKey !== 'function') {
        throw new TypeError('proc: opts.tty must implement write(data), size(), and onKey(cb)');
      }
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

  // Phase D: long-running shell process. Sugar over service-mode spawn
  // with the shell-service entry pre-wired. opts:
  //   - shell: { bundleSource | moduleUrl, factoryName, factoryOpts }
  //   - tty?, vfs? — forwarded into spawn
  // Returns a Process with extra .exec(cmd) and .execStream(cmd, {onStdout,
  // onStderr}) methods.
  async shell(opts = {}) {
    if (!opts.shell) throw new TypeError('pm.shell: opts.shell is required ({ bundleSource | moduleUrl, factoryName })');
    const initPayload = { shellCommand: '' };
    // Long-running: not one-shot. The bootstrap parks on incoming
    // shell:exec messages instead of running a single command.
    const proc = await this.spawn(initPayload, {
      ...opts,
      shellOneShot: false,
    });
    // Attach .exec / .execStream sugar.
    let nextId = 0;
    const pending = new Map();
    proc.on((data) => {
      if (!data || typeof data !== 'object') return;
      if (data.type === 'shell:done') {
        const slot = pending.get(data.id);
        if (!slot) return;
        pending.delete(data.id);
        slot.resolve({ exitCode: data.exitCode, stdout: data.stdout, stderr: data.stderr });
      }
    });
    proc.exec = (command) => {
      if (proc.state !== STATE.RUNNING) return Promise.reject(new Error('pm.shell: process ' + proc.state));
      const id = ++nextId;
      const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      proc.send({ type: 'shell:exec', id, source: command });
      return promise;
    };
    proc.execStream = async (command, { onStdout, onStderr } = {}) => {
      // Subscribe to the proc's own stdout/stderr (the bootstrap pipes
      // the shell's captured output through ctx.stdout/ctx.stderr too).
      // Note: outputs from concurrent .exec calls are interleaved on the
      // shared ctx — execStream is best used one-command-at-a-time.
      const unsubs = [];
      if (typeof onStdout === 'function') unsubs.push(proc.stdout.onData(onStdout));
      if (typeof onStderr === 'function') unsubs.push(proc.stderr.onData(onStderr));
      try {
        const r = await proc.exec(command);
        return r.exitCode;
      } finally {
        for (const u of unsubs) try { u(); } catch (_) {}
      }
    };
    return proc;
  }

  // Phase D: one-shot command execution. Spawns a shell, runs ONE
  // command, terminates the shell, returns { exitCode, stdout, stderr }.
  // Heavy worker-spawn cost per call (~tens of ms) — use pm.shell for
  // anything that runs many commands.
  async exec(command, opts = {}) {
    if (typeof command !== 'string') throw new TypeError('pm.exec(command, opts): command must be a string');
    if (!opts.shell) throw new TypeError('pm.exec: opts.shell is required');
    const proc = await this.spawn(command, { ...opts, shellOneShot: true });
    const code = await proc.wait();
    if (code !== EXIT.OK && proc.error) {
      // Shell returned non-zero AND threw — propagate the error.
      throw proc.error;
    }
    // proc.result is the {exitCode, stdout, stderr} triple posted by
    // the bootstrap's runOne.
    return proc.result || { exitCode: code, stdout: '', stderr: '' };
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

    // VFS injection: callers opt in per-spawn with opts.vfs === true. Only
    // legal when the manager was constructed with a vfs. Module-service
    // mode always gets ctx.vfs regardless of opts.vfs (handled in the
    // bootstrap, not gated here).
    const vfsRequested = opts.vfs === true;
    if (vfsRequested && !this._vfs) {
      throw new Error('proc.spawn: opts.vfs is true but ProcessManager was constructed without a vfs');
    }
    const vfsExtras = this._vfs
      ? {
          vfs: vfsRequested,                                // arg-injection for fn/module-call
          vfsConfig: this._buildVfsMountTable(),            // mount table description
          vfsModuleUrl: this._vfsModuleUrl || undefined,    // where to import @gcu/vfs from in the worker
        }
      : {};

    // TTY proxy: caller-provided host tty. Embed the initial size in the
    // init message so the worker's ctx.tty.size() has a value before any
    // resize event arrives.
    const ttyExtras = opts.tty
      ? { tty: true, ttySize: (() => {
          try { return opts.tty.size() || { rows: 24, cols: 80 }; }
          catch (_) { return { rows: 24, cols: 80 }; }
        })() }
      : {};

    if (typeof payload === 'function') {
      return {
        wire: {
          type: MSG.INIT,
          mode: MODE.FUNCTION,
          source: payload.toString(),
          args: opts.args || [],
          keepalive: !!opts.keepalive,
          ...vfsExtras,
        },
        transfer,
        mode: MODE.FUNCTION,
        command: payload.name || '<fn>',
      };
    }

    // Shell-service mode: string payload OR { shellCommand, shell, ... }
    // object payload. Caller must supply opts.shell with bundleSource|
    // moduleUrl + factoryName (e.g. 'createShell'). The worker imports the
    // shell library, calls factoryName with factoryOpts merged with the
    // injected ctx (vfs / tty), and runs the exec protocol.
    if (typeof payload === 'string' || (payload && typeof payload === 'object' && typeof payload.shellCommand === 'string')) {
      const shellCfg = opts.shell;
      if (!shellCfg || typeof shellCfg !== 'object') {
        throw new TypeError('proc.spawn(string): opts.shell is required ({ bundleSource | moduleUrl, factoryName, factoryOpts? })');
      }
      if (!shellCfg.bundleSource && !shellCfg.moduleUrl) {
        throw new TypeError('proc.spawn(string): opts.shell needs either bundleSource (inline) or moduleUrl (URL)');
      }
      const command = typeof payload === 'string' ? payload : payload.shellCommand;
      const oneShot = opts.shellOneShot !== false;   // default: spawn-and-exec-and-exit
      return {
        wire: {
          type: MSG.INIT,
          mode: MODE.SHELL,
          shellModuleUrl:    shellCfg.moduleUrl || undefined,
          shellFactoryName:  shellCfg.factoryName || 'createShell',
          shellFactoryOpts:  shellCfg.factoryOpts || {},
          shellCommand:      command,
          shellOneShot:      oneShot,
          ...vfsExtras,
          ...ttyExtras,
        },
        transfer: [],
        mode: MODE.SHELL,
        command: '$ ' + command.slice(0, 60),
        shellBundleSource: shellCfg.bundleSource || null,
      };
    }

    if (payload && typeof payload === 'object' && typeof payload.module === 'string') {
      const explicitMode = payload.mode || opts.mode;
      // Default: module + fn → module-call. module alone → service.
      const mode = explicitMode
        ? (explicitMode === 'service' ? MODE.SERVICE : MODE.MODULE_CALL)
        : (payload.fn ? MODE.MODULE_CALL : MODE.SERVICE);

      if (mode === MODE.MODULE_CALL) {
        // VFS-path module loading is a future feature (would require a
        // VFS-RPC import that doesn't exist yet — could land later in
        // 0.2.x). Keep rejecting for now.
        if (payload.module.startsWith('/')) {
          throw new Error('proc: VFS-path modules not supported yet — pass a URL or data: URI for the module.');
        }
        return {
          wire: {
            type: MSG.INIT,
            mode: MODE.MODULE_CALL,
            url: payload.module,
            fn: payload.fn || 'default',
            args: payload.args || opts.args || [],
            ...vfsExtras,
          },
          transfer,
          mode: MODE.MODULE_CALL,
          command: payload.module + ' ' + (payload.fn || 'default'),
        };
      }

      // service mode
      if (payload.module.startsWith('/')) {
        throw new Error('proc: VFS-path modules not supported yet — pass a URL or data: URI for the module.');
      }
      return {
        wire: {
          type: MSG.INIT,
          mode: MODE.SERVICE,
          url: payload.module,
          ...vfsExtras,
          ...ttyExtras,
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
          ...vfsExtras,
          ...ttyExtras,
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
    // Build the worker source. Three things can get concatenated onto the
    // bootstrap, in this order:
    //   1. The @gcu/vfs bundle source — needed if the manager was created
    //      with { vfs, vfsBundleSource }. Concatenated FIRST so its
    //      classes are top-level by the time the bootstrap and user code
    //      reference them.
    //   2. The bootstrap itself.
    //   3. The user's inline-service source, if any.
    let bootstrap = '';
    if (this._vfsBundleSource) {
      // Strip any trailing `export { ... }` from the bundle — it'd be a
      // syntax error in a classic worker.
      const stripped = this._vfsBundleSource.replace(/export\s*\{[^}]*\};?\s*$/, '');
      bootstrap += stripped + '\n;\n';
    }
    if (initMsg.shellBundleSource) {
      // Phase D: inline a shell library (e.g. the geas bundle). Same
      // strip-the-export-footer treatment so the library's symbols land
      // at top level.
      const stripped = initMsg.shellBundleSource.replace(/export\s*\{[^}]*\};?\s*$/, '');
      bootstrap += stripped + '\n;\n';
    }
    bootstrap += BOOTSTRAP_SOURCE;
    if (initMsg.inlineSource) {
      bootstrap += '\n;\n' + initMsg.inlineSource + '\n';
    }
    const { worker, cleanup } = this._createWorker(bootstrap);

    const proc = new Process({
      pid,
      mode: initMsg.mode,
      worker,
      cleanup,
      command: initMsg.command,
      vfs: this._vfs,                // for _proc_vfs_call dispatch (Phase B)
      tty: opts.tty || null,         // for _proc_tty_* event forwarding (Phase C)
      manager: this,                 // for _proc_pm_call dispatch (Phase D)
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
