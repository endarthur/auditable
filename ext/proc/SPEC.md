# @gcu/proc — specification

a process model for the browser. spawn Web Workers as PID-tracked processes with proper lifecycle, I/O channels, pools, signal handling, a `@gcu/vfs` proxy, a TTY proxy for interactive TUI workers, shell-mode execution with worker-side `ctx.pm` for sub-process spawning, and supervised named daemons. zero hard dependencies; `@gcu/vfs` is an optional peer.

This document specifies the surface of **0.5.0** — Phase A (the standalone core: function, module-call, module-service, inline-service modes) + Phase B (the VFS proxy: mixed direct-replicated and proxied backends, VFS injection into all four modes) + Phase C (the TTY proxy: caller-provided terminal forwarded into service-mode workers) + Phase D (shell-mode execution: `pm.exec` / `pm.shell` / `pm.spawn(string, { shell })` plus `ctx.pm` worker-side ProcessManager proxy for sub-process spawning) + Phase E (named daemons with auto-restart and `pm.request` / `ctx.onRequest`). Remote/mesh execution remains in §11 — Roadmap.

The full multi-phase design lives in `spec_inbox/os/proc-spec.md`. This document is the authoritative spec for what ships in 0.5.x.

## 1. Motivation

The browser is single-threaded. Web Workers exist but they're bare — no lifecycle management, no process table, no I/O abstraction, no way to kill a stuck computation cleanly. Every app that uses workers reinvents spawn/wait/kill.

`@gcu/proc` Phase A provides a process abstraction on top of Web Workers:

- **PID-tracked lifecycle**: each spawned worker has a stable PID, a state machine (`running` → `done` | `killed` | `error`), and an exit code.
- **I/O channels**: `stdin`, `stdout`, `stderr` per process, MessagePort-backed, with `onData` callbacks and `.text()` collectors.
- **Signal handling**: cooperative `INT` (AbortController), forceful `KILL` (`worker.terminate()`).
- **Pools**: keep workers alive across dispatches; free-queue scheduling.
- **Three modes**: function, module-call, module-service.

Phase A is the smallest useful surface. Replacing auditable's `worker()` / `workerPool()` builtins and hosting geas's worker harness drives the API shape.

## 2. Design principles

- **Workers are processes.** One Worker per process. The browser owns scheduling, memory isolation, and termination — we don't fight it.
- **The process table is the truth.** PIDs, states, exit codes, parent relationships, all on the main thread.
- **Zero mandatory dependencies.** Phase A imports nothing.
- **Symmetric host/worker context.** The same `ctx` shape is available on both sides where it makes sense: `signal`, `send`/`on`, `stdout`/`stderr`.
- **Reserved wire namespace.** Lifecycle messages use `type: "_proc_*"` so they cannot collide with user-protocol messages.

## 3. Modes

### 3.1 function mode

Run a pure function. The function is serialized to source (closures stripped — same constraint as auditable's existing `worker()`). Args are structured-cloned (or transferred via `transfer`). The function runs once and the worker terminates.

```js
const proc = await pm.spawn(function(data) {
  return data.map(x => x * 2);
}, { args: [largeArray], transfer: [largeArray.buffer] });

const result = await proc.wait();   // returns exit code
const value = proc.result;          // the function's return value
```

For the common case, `pm.compute(fn, args?, opts?)` is sugar that returns the value directly:

```js
const value = await pm.compute(fn, [largeArray], { transfer: [largeArray.buffer] });
```

If the function throws, `compute()` rethrows on the main thread; `spawn()` sets process state to `error` and `proc.wait()` returns a non-zero exit code with `proc.error` populated.

**TypedArray transfer auto-detection** (preserved from existing `worker()` behavior): the bootstrap inspects each arg; if `arg instanceof ArrayBuffer` or `arg?.buffer instanceof ArrayBuffer`, it auto-adds the buffer to `transfer` unless caller already did. Same for the return value — if it's a TypedArray or ArrayBuffer, transferred back zero-copy.

### 3.2 module-call mode

Import an ES module by URL, call an exported function, return its result. The worker terminates after the call.

```js
const proc = await pm.spawn({
  module: "https://esm.sh/some-library",
  fn: "processData",
  args: [params],
});
```

Phase A: **URL modules only**. VFS-path modules (`{ module: "/scripts/kriging.js" }`) require Phase B's VFS proxy and are out of scope.

`data:` URIs are accepted (useful for tests).

### 3.3 module-service mode

Import an ES module by URL. The module's default export is the entrypoint: an async function that receives a `ctx` and runs forever (until killed). Used for long-lived workers with a custom protocol — geas, future daemons.

```js
// host
const proc = await pm.spawn({
  module: "geas-worker.js",
  mode: "service",
});
proc.send({ type: "init", env: {}, cwd: "/" });
proc.on(msg => {
  if (msg.type === "init-done") { /* ... */ }
});

// inside geas-worker.js
export default async function geasEntry(ctx) {
  ctx.on(msg => {
    if (msg.type === "init") {
      // ... do stuff ...
      ctx.send({ type: "init-done" });
    }
  });
  await new Promise(resolve => ctx.signal.addEventListener("abort", resolve));
}
```

The worker exits cleanly when `ctx.signal` fires (INT) or the entrypoint resolves. KILL is a `worker.terminate()` and bypasses the entrypoint entirely.

**Why a "mode" field for module spawns?** Two reasons:
1. URLs alone don't tell `pm` whether to call `exports[fn](...)` and wait for a return value, or hand control to a default-export entrypoint and let it run forever.
2. Explicit modes mean we don't have to guess from the module's shape (presence of `default` vs. named `fn`).

`{module, fn}` defaults to `mode: "call"`. `{module}` without `fn` defaults to `mode: "service"`. Callers can be explicit with `mode: "call" | "service"`.

### 3.4 inline-service mode

Same shape as module-service but the user code is **concatenated into the bootstrap blob** instead of loaded via a URL import. The inlined code calls `_procRegisterEntry(fn)` at module top level, and the bootstrap awaits that registration before running.

```js
// host
const proc = await pm.spawn({
  inlineSource: workerSourceString,    // ESM source, will be concatenated
});

// the workerSourceString, after concatenation, runs at module top level:
_procRegisterEntry(async function(ctx) {
  ctx.on(msg => { /* … */ });
  await new Promise(r => ctx.signal.addEventListener("abort", r));
});
```

**When to use:** module-service mode does `import(workerBlobUrl)` from inside the bootstrap blob, which is fine over HTTP but blocked by Chromium when the page is loaded from `file://` (each blob URL gets a unique opaque origin and module-mode workers can't import another blob URL). Inline mode sidesteps this by putting the bootstrap and the user code in the *same* blob — no cross-blob import.

The user-facing `mode` is still `"service"`; the inline path is selected by passing `inlineSource` instead of `module`. Wire-level, the bootstrap dispatches on `mode: "inline-service"`.

`_procRegisterEntry(fn)` is exposed as a top-level binding in the worker module *and* on `globalThis`. Inlined user code can call either form. If the inlined code doesn't register an entry within 5 seconds, the bootstrap fails with a diagnostic error and exits non-zero — no silent hang.

In 0.1.x, only the service shape is inline-able. Inline + module-call (`{ inlineSource, fn }`) is not implemented — would mean "the inlined module exports a function the bootstrap calls"; deferred until a real consumer wants it.

### 3.5 VFS proxy (0.2.0)

When `ProcessManager` is constructed with a `vfs` instance, spawned workers can read and write through it. The wiring varies by mode:

```js
// host
import { VFS, MemoryBackend, IDBBackend } from '@gcu/vfs';

const vfs = new VFS();
vfs._mounts.set('/data', new IDBBackend({ name: 'mydata' }));    // worker-capable
vfs._mounts.set('/mem',  new MemoryBackend());                   // proxy-only

const pm = new ProcessManager({
  vfs,
  vfsBundleSource: GCU_VFS_SOURCE,  // OR vfsModuleUrl: 'https://…/vfs.js'
});

// function mode — opt in per-spawn, vfs is the last arg
const lines = await pm.compute(
  async (path, vfs) => (await vfs.readFile(path, 'utf8')).split('\n').length,
  ['/data/big.csv'],
  { vfs: true },
);

// module-service mode — ctx.vfs is set unconditionally when manager has vfs
const proc = await pm.spawn({ module: workerUrl, mode: 'service' });
// inside the entry:  await ctx.vfs.writeFile('/mem/log.txt', '…');
```

**Hybrid backend strategy.** At spawn time, the manager walks `vfs._mounts` and asks each backend for a `toConfig()`. If it returns a structured-cloneable `{ type, ...opts }`, the mount is flagged **direct** — the worker instantiates the same `Backend` subclass with the same config, talking to the underlying storage (IDB DB, OPFS root, fetch URL) without round-tripping. If `toConfig()` returns `null` (the base `Backend` default), the mount is flagged **proxy** — every operation RPCs back to the main thread via `_proc_vfs_call` / `_proc_vfs_reply` and runs against the host's backend instance.

Today's direct-replicable backends in `@gcu/vfs`: `IDBBackend`, `OPFSBackend`, `FetchBackend`, `RESTBackend`. Always-proxied: `MemoryBackend` (lives in main thread's heap), `CommentBackend` (DOM-bound), `FSAABackend` (permission handle), `AbusBackend` (broker-bound), any custom backend that doesn't override `toConfig()`. `FetchBackend` and `RESTBackend` flip to proxy when their `headers` config is a function rather than a plain object (functions don't structured-clone).

**VFS bundle delivery.** The worker needs `@gcu/vfs` to be in scope before it can instantiate backends. Caller picks the deployment shape (same trade-off as URL vs. inline service mode in §3.4):

- `vfsBundleSource`: inlined into the worker blob ahead of the bootstrap. `file://` friendly; consumer is responsible for reading the bundle source from disk or template.
- `vfsModuleUrl`: dynamically imported by the worker via `await import(url)`. HTTP friendly; smaller worker blob; doesn't work on `file://` because of cross-blob-origin restrictions.

The bootstrap detects which is present and either uses the pre-inlined symbols (`VFS`, `Backend`, `BACKEND_TYPES`) or imports them from the URL. Both yield the same `Backend` superclass that `ProxyBackend` extends — so the proxy machinery is module-source agnostic.

**Argument injection.** In function and module-call modes, VFS is appended as the *last* arg only when the caller passes `{ vfs: true }` to `spawn()`. Module-service and inline-service modes always set `ctx.vfs` when the manager has a vfs configured.

**Errors round-trip.** Host-side `VFSError` instances are serialized to `{ message, code, path }` and reconstructed as a regular `Error` on the worker side with the same fields. Consumer-facing behavior: `try { await vfs.readFile('/nope') } catch (e) { e.code === 'ENOENT' }` works the same in worker and host.

**Limits / TODO for 0.2.x or later.**
- Streaming reads (`createReadStream` over RPC) are not implemented — backends call the default `null` shim. A future point release can add a dedicated channel.
- Principal-based sandboxing isn't wired yet (see §11 — Phase B+).
- VFS-path module loading (`spawn({ module: '/scripts/x.js', fn: 'run' })`) still throws — the dynamic-import-from-VFS plumbing isn't in 0.2.0.

### 3.6 TTY proxy (0.3.0)

Service-mode workers (`module-service` and `inline-service`) can receive a TTY from the host so they can run interactive UI — pagers, line editors, TUI apps — without freezing the main thread. The proxy is shape-agnostic: caller provides any object that satisfies the host-side shape; proc exposes a worker-side proxy with the same shape.

```js
// host: provide any object that quacks like a terminal
const tty = {
  write(data) { xterm.write(data); },                     // bytes / escapes
  size() { return { rows: xterm.rows, cols: xterm.cols }; },
  onKey(cb)    { xterm.onKey(({ key }) => cb(key)); return () => /* unsub */ {}; },
  onMouse(cb)  { /* optional */ return () => {}; },
  onResize(cb) { /* optional */ return () => {}; },
};

const proc = await pm.spawn({ module: workerUrl, mode: 'service' }, { tty });

// inside the worker (module-service entry):
export default async function(ctx) {
  ctx.tty.write('Press a key to continue...\\r\\n');
  for await (const key of ctx.tty.keys()) {
    if (key.name === 'q') break;
    ctx.tty.write('You pressed: ' + (key.name || key.raw) + '\\r\\n');
  }
  ctx.exit(0);
}
```

**Service-mode only.** Function and module-call modes throw if `{ tty }` is passed — those modes are for compute, not interactive UI. (`ctx` isn't exposed there anyway.)

**Required host shape.** At minimum: `write(data)`, `size()`, `onKey(cb)`. Optional: `onMouse(cb)`, `onResize(cb)`. Each `on*` returns an unsubscribe function (called by proc on process exit so listeners don't leak).

**Worker-side `ctx.tty` shape.**

| API | Behavior |
|---|---|
| `tty.write(data)` | Fire-and-forget: posts `_proc_tty_write` to host, which calls `hostTty.write(data)`. No round-trip. |
| `tty.size()` | Returns `{rows, cols}` from a cached copy. The initial value rides on the init message; subsequent resize events update the cache. No round-trip. |
| `tty.keys()` | Async iterator yielding key events as they arrive from the host. Pulls drain a per-process queue; misses get buffered. |
| `tty.mouse()` | Async iterator for mouse events. Same shape as keys. |
| `tty.onResize(cb)` | Subscribe to resize events. Returns an unsubscribe. Cached size is updated before the callback fires. |

**Latency.** PostMessage round-trip is sub-millisecond. TUI applications redraw on input events, not at 60fps, so the proxy hop is imperceptible for typical interactive use. The only case where it matters is rapid bulk output — but that's `ctx.tty.write(largeBuffer)`, already a single message regardless.

**Lifecycle.** Process subscriptions to the host tty are cleaned up in `_finish` (worker exited, killed, errored, or timed out). The host tty itself is never modified — proc only reads via the `on*` hooks and writes via `tty.write`.

### 3.7 Shell-service mode + ctx.pm (0.4.0)

A fifth mode (`shell-service`) wraps a caller-supplied shell library so command strings can be spawned as worker processes. The shell library is anything that exposes a factory returning `{ exec(source) → Promise<{exitCode, …}> }`. Geas is the obvious choice but proc is shell-agnostic.

```js
// host
const pm = new ProcessManager();

// One-shot — spawn, exec, terminate.
const { exitCode, stdout, stderr } = await pm.exec('ls /home', {
  shell: {
    bundleSource: GEAS_SOURCE,           // OR moduleUrl
    factoryName:  'createShell',         // optional, defaults to 'createShell'
    factoryOpts:  { env: { HOME: '/home' } },
  },
});

// Long-running — keeps shell state across exec calls.
const shell = await pm.shell({
  shell: { bundleSource: GEAS_SOURCE },
});
await shell.exec('cd /tmp');
const r = await shell.exec('pwd');      // r.stdout === '/tmp' — state persists
shell.kill();

// Streaming output (useful when piping into a terminal).
await shell.execStream('long-running-cmd', {
  onStdout: (chunk) => terminal.write(chunk),
  onStderr: (chunk) => terminal.write('\x1b[2m' + chunk + '\x1b[0m'),
});

// String-as-payload spawn — same as pm.exec but returns a Process you
// can inspect / kill before it finishes.
const proc = await pm.spawn('grep Fe /data/big.csv', { shell: {...} });
await proc.wait();
console.log(proc.result);   // { exitCode, stdout, stderr }
```

**Shell-library contract.** The factory is called with `factoryOpts` merged with proc-injected bits: `vfs` (from Phase B if configured), `tty` (from Phase C if passed), `pm` (the worker-side proc proxy, see below), `stdout`, `stderr` (callbacks that pipe to `ctx.stdout` / `ctx.stderr`). Library is free to ignore any keys it doesn't need.

The returned shell instance only needs to implement `async exec(source) → { exitCode, ... }`. Output is collected via the `stdout` / `stderr` callbacks (so the shell can stream rather than batch) and bundled into the `{ exitCode, stdout, stderr }` triple by the bootstrap.

**ctx.pm — worker-side ProcessManager proxy.** Service-mode workers (any service mode, including `shell-service`) get `ctx.pm`, an RPC proxy to the host's `ProcessManager`:

```js
// Inside a service-mode worker entry (or a shell library):
const sub = await ctx.pm.spawn('sort /data/big.csv', { shell: {...} });
sub.pid;                       // host-side PID
const code = await sub.wait(); // resolves when the remote process exits
sub.kill('INT');               // signals the remote process

const procs = await ctx.pm.list();  // host's process table
ctx.pm.kill(somePid, 'INT');        // kill by PID
```

This is what unlocks `&` / `jobs` / `fg` / `bg` in shell consumers: when geas sees `cmd &`, its shell can call `ctx.pm.spawn(cmd, ...)` to background a sub-process; `jobs` becomes `ctx.pm.list()`.

**Limitations in 0.4.0:**
- `ctx.pm.spawn(fn, ...)` (function payloads) throws — function source can't be reconstructed across the worker boundary cleanly. String commands (`pm.exec`/`pm.spawn(string)`) and module-mode payloads (`{module, mode}`) work.
- The remote-Process stand-in (returned by `ctx.pm.spawn`) doesn't proxy `stdout` / `stderr` back to the spawning worker — output goes to the host's `onStdout` / `onStderr` callbacks. Adequate for backgrounding; a future point release can add stream-back via dedicated MessagePorts.
- The shell library must run in a single worker (no built-in distribution). For parallel workloads, the shell can use `ctx.pm.spawn` to fan out — each sub-process is its own worker.

### 3.8 Daemons + service registry (0.5.0)

A daemon is a long-running named service: `pm.daemon(name, opts)` registers (or adopts) it, the supervisor restarts it per policy, and `pm.request(name, msg)` lets any caller send a request and await a reply.

```js
// Register a daemon (any service-mode payload works as the body).
const indexd = await pm.daemon('indexd', {
  module: '/services/indexd.js',
  mode:   'service',
  vfs:    true,                  // Phase B injection
  restart:       'on-crash',     // 'never' | 'on-crash' (default) | 'always'
  maxRestarts:   5,              // default 5
  restartWindow: 60_000,         // default 60s — uptime that resets the restart counter
});

// Call it from anywhere — works across cells, surfaces, sub-processes.
const hits = await pm.request('indexd', { type: 'search', q: 'magnetite' });

// Service registry queries.
pm.services();          // [{ name, pid, state, uptime, restarts }]
pm.service('indexd');   // → the Process (or null)
await pm.stopService('indexd');  // permanent stop; subsequent pm.daemon('indexd', ...) starts fresh
```

**Daemon-side request handler.** `ctx.onRequest(handler)` is sugar over `ctx.on` that handles `{type:'request', id, req}` messages by calling `handler(req)` and posting `{type:'reply', id, ok, value|error}` back.

```js
// inside the daemon's service-mode entry
export default async function(ctx) {
  const index = new Map();
  ctx.vfs.on('write', ({ path }) => { /* update index */ });

  ctx.onRequest(async (req) => {
    if (req.type === 'search') return { hits: searchIndex(index, req.q) };
    if (req.type === 'reindex') { await reindex(index, ctx.vfs); return { ok: true }; }
    throw new Error('unknown request: ' + req.type);
  });

  // Daemons typically park forever — supervisor restarts them on crash.
  await new Promise((r) => ctx.signal.addEventListener('abort', r));
}
```

**Restart-policy decision rules.**

| `restart` | clean exit (code 0) | crash (code ≠ 0 or thrown error) |
|---|---|---|
| `'never'`     | leave dead       | leave dead       |
| `'on-crash'`  | leave dead       | restart with backoff |
| `'always'`    | restart with backoff | restart with backoff |

**Backoff and restart-counter reset.** Backoff is `100ms × 2^(n-1)` capped at 30 s. The counter resets to zero once a daemon has run uninterrupted for `restartWindow` (default 60 s). If `maxRestarts` (default 5) is exceeded within that window, the service is marked `'failed'` and stays dead until the caller invokes `pm.daemon(name, opts)` again to start fresh.

**Name-collision behavior.** Re-registering an already-alive daemon silently returns the existing `Process` — `pm.daemon('indexd', …)` from a re-running cell adopts the existing instance rather than spawning a sibling. Re-registering a dead/failed/stopped daemon starts fresh with the new opts. This is intentional: daemons survive cell re-runs.

**Lifetime caveats worth flagging in any consumer doc:**
- A daemon outlives the cell/scope that created it — it persists until `pm.stopService(name)` is called or the `ProcessManager` shuts down (typically: tab close).
- A daemon's in-memory state vanishes with the worker. Daemons that need durability must write to VFS (Phase B) explicitly.
- Daemons that auto-restart can mask intermittent bugs — the service "just works" while logs are full of crashes. Watch `pm.services()[i].restarts > 0` in production.

**Security note.** A daemon listening on `pm.request` can be called by any cell. If the daemon writes to VFS paths a calling cell wouldn't be allowed to write directly, it's effectively a privilege-escalation surface. The principal-based VFS sandbox follow-up (see §11) becomes more urgent once daemons are in the mix — until it lands, treat daemons as fully-trusted.

## 4. Wire protocol

All messages between host and worker use a plain object with a `type` field. Lifecycle messages use the reserved prefix `_proc_`. Custom messages (the user's protocol) ride on `_proc_msg`.

### 4.1 Host → Worker

| Type | Payload | Sent when |
|---|---|---|
| `_proc_init` | `{ mode, source?, args?, transfer?, url?, fn? }` | First message after worker boots. Bootstrap dispatches by `mode` (`function` / `module-call` / `module-service` / `inline-service`). For inline-service the manager has concatenated the user source into the bootstrap blob; the bootstrap waits for `_procRegisterEntry(fn)` to fire before running. |
| `_proc_stdin` | `{ data, eof? }` | Host writes to process's stdin (Phase A: not heavily exercised). |
| `_proc_kill` | `{ signal: "INT" \| "TERM" }` | Cooperative kill — fires worker's AbortController. `KILL` is not on the wire; it's a `worker.terminate()`. |
| `_proc_msg` | `{ data }` | Custom protocol message from `proc.send(data)`. Bootstrap delivers `data` to `ctx.on` handlers in module-service mode. |
| `_proc_vfs_reply` | `{ id, ok, value? \| error? }` | Reply to a previously-sent `_proc_vfs_call`. Host dispatches the call to the relevant backend and posts the result (or a serialized error with `{ message, code?, path? }`). |
| `_proc_tty_key` | `{ key }` | Phase C: a key event from the host's TTY. Worker delivers it to the next `ctx.tty.keys()` pull (or queues). |
| `_proc_tty_mouse` | `{ event }` | Phase C: a mouse event. Same buffering as keys. |
| `_proc_tty_resize` | `{ rows, cols }` | Phase C: terminal resized. Worker updates the cached `ctx.tty.size()` and fans out to `onResize(cb)` subscribers. |
| `_proc_pm_reply` | `{ id, ok, value? \| error? }` | Phase D: reply to a previously-sent `_proc_pm_call` (`ctx.pm.spawn` / `list` / `kill` / `subscribeExit`). |
| `_proc_pm_exit` | `{ pid, exitCode }` | Phase D: a remote process the worker was awaiting (via `ctx.pm.spawn(...).wait()`) has exited. Worker's wait-promise resolves with the exit code. |

### 4.2 Worker → Host

| Type | Payload | Sent when |
|---|---|---|
| `_proc_ready` | `{}` | Bootstrap has loaded and is waiting for `_proc_init`. (Phase A: bootstrap sends this immediately on script load — host uses it to confirm the worker is alive before posting init.) |
| `_proc_result` | `{ value }` | Function or module-call returned. Transferable. |
| `_proc_error` | `{ error: { message, stack? } }` | Function or module-call threw, or service entrypoint rejected. Errors are serialized to `{ message, stack }` because `Error` instances structured-clone fine in modern browsers but stack traces sometimes get lost across Node's worker_threads. |
| `_proc_exit` | `{ code }` | After result/error. Bootstrap closes the worker after posting this. |
| `_proc_stdout` | `{ data }` | `ctx.stdout(text)` from inside the worker. |
| `_proc_stderr` | `{ data }` | `ctx.stderr(text)` from inside the worker. |
| `_proc_msg` | `{ data }` | `ctx.send(data)` from inside the worker (module-service mode). |
| `_proc_vfs_call` | `{ id, mountPath, method, args }` | Worker's `ProxyBackend` invoking a backend method on the host. Host dispatches to the relevant mount's backend and posts `_proc_vfs_reply` with the matching `id`. |
| `_proc_tty_write` | `{ data }` | Phase C: fire-and-forget. Host invokes `hostTty.write(data)` directly. No reply. |
| `_proc_pm_call` | `{ id, method, args }` | Phase D: `ctx.pm` RPC. `method` is `spawn` / `list` / `kill` / `subscribeExit`. Host dispatches to the local `ProcessManager` and posts `_proc_pm_reply`. |

### 4.3 Custom message wrapping

`proc.send(userMsg, transfer?)` and `ctx.send(userMsg, transfer?)` both wrap the message as `{ type: "_proc_msg", data: userMsg }` on the wire. The receiving side unwraps before delivering to `proc.on` / `ctx.on` handlers.

This is why geas can keep its existing protocol (`{type:'init'}`, `{type:'exec'}`, `{type:'vfs-call'}`, etc.) verbatim — those types live inside `_proc_msg.data` and never collide with proc's lifecycle namespace.

## 5. API

### 5.1 ProcessManager

```js
import { ProcessManager } from "@gcu/proc";

const pm = new ProcessManager({
  maxProcesses: 8,         // optional, defaults to navigator.hardwareConcurrency || 4
  createWorker,            // optional, environment hook (see §7)
  // VFS (Phase B / 0.2.0): the worker can read/write through this
  // VFS instance. Provide exactly one of vfsBundleSource or vfsModuleUrl.
  vfs,                     // optional, a @gcu/vfs VFS instance
  vfsBundleSource,         // string — @gcu/vfs source, inlined into the worker blob
  vfsModuleUrl,            // string — URL the worker imports for @gcu/vfs
});

pm.spawn(payload, opts?);  // returns Promise<Process> (resolves when worker is ready)
pm.compute(fn, args?, opts?);  // sugar over function-mode spawn; returns the result value
pm.createPool(n, opts?);   // returns Pool

pm.list();                 // returns array of { pid, state, mode, startTime, duration }
pm.get(pid);               // returns Process or null
pm.kill(pid, signal?);     // kill by PID; signal defaults to "INT"
pm.killAll(signal?);       // kill all running processes
await pm.waitAll();        // wait for all processes to complete
pm.shutdown();             // KILL everything and refuse new spawns
```

### 5.2 Process

```js
proc.pid;                  // number — unique within this PM
proc.mode;                 // "function" | "module-call" | "module-service"
proc.state;                // "running" | "done" | "killed" | "error"
proc.startTime;            // Date
proc.duration;             // number (ms), populated after exit
proc.exitCode;             // number, populated after exit
proc.result;               // any, populated on success (function / module-call modes)
proc.error;                // Error-shaped object, populated on error

// I/O
proc.stdin;                // WritablePort { write(data), close() }
proc.stdout;               // ReadablePort { onData(cb), text(), [Symbol.asyncIterator]() }
proc.stderr;               // ReadablePort
proc.send(msg, transfer?); // custom protocol — module-service mode only
proc.on(handler);          // subscribe to custom-protocol messages; returns unsubscribe fn

// lifecycle
await proc.wait();         // returns exit code (0 on success, non-zero on error/kill)
proc.kill(signal?);        // "INT" (cooperative) | "KILL" (forceful, default for shutdown)
```

`proc.wait()` resolves when the process leaves the running state — for any reason (success, error, kill). It returns the exit code. Convention: `0` = success, `1` = unhandled error, `137` = SIGKILL.

### 5.3 Pool

```js
const pool = pm.createPool(4);  // 4 workers

// dispatch a function-mode task
await pool.exec(fn, args, opts?);

// map across an array
await pool.map(items, fn, opts?);  // each item becomes [item, ...extraArgs] in fn

pool.terminate();
pool.list();               // workers' PIDs + states
```

Pool workers boot in function mode but are reused: instead of terminating after the function returns, they post `_proc_result` and stay ready for the next call. The bootstrap recognizes the pool variant via an `_proc_init` flag (`{ keepalive: true }`).

### 5.4 ReadablePort / WritablePort

I/O channels are thin wrappers around MessagePort-shaped messages on the worker channel.

```js
// from the host side
const port = proc.stdout;
port.onData(text => console.log(text));    // streaming callback
const all = await port.text();              // collect everything to EOF
for await (const chunk of port) { ... }     // async iterator

// from inside the worker
ctx.stdout("hello\n");                      // emits "_proc_stdout"
ctx.stderr("oops\n");                       // emits "_proc_stderr"
```

`port.text()` and the async iterator both resolve / end when the process exits (no explicit EOF needed — exit closes the channel).

`WritablePort` (stdin) buffers writes until the worker reads from it. Phase A's bootstrap doesn't implement stdin reading in function/module-call modes; module-service workers manage their own stdin handling via `ctx.stdin`.

### 5.5 Worker-side context

In function and module-call modes, the user's function/exported-fn receives `args` directly. There is no `ctx` — these are one-shot computations.

In module-service mode, the module's `default` export is `async function(ctx)`. The `ctx`:

```js
ctx.signal              // AbortSignal — fires on INT
ctx.stdin               // { read() → Promise<{value, done}>, [Symbol.asyncIterator]() }
ctx.stdout(text)        // emits _proc_stdout
ctx.stderr(text)        // emits _proc_stderr
ctx.send(msg, transfer?)// emits _proc_msg (custom protocol)
ctx.on(handler)         // subscribes to incoming _proc_msg; returns unsubscribe fn
ctx.exit(code = 0)      // posts _proc_exit and shuts down
```

`ctx.exit(0)` is how a service entrypoint can shut itself down cleanly without waiting for KILL. Calling `return` from the entrypoint also triggers a clean exit with code 0.

## 6. State machine

```
                  ┌─────────┐
   spawn() ──────▶│ running │
                  └─────────┘
                       │
              ┌────────┼─────────┬────────────┐
              ▼        ▼         ▼            ▼
          ┌──────┐ ┌─────────┐ ┌───────┐  ┌───────┐
          │ done │ │ killed  │ │ error │  │ timeout│
          └──────┘ └─────────┘ └───────┘  └───────┘
            exit 0   exit 137   exit 1     exit 124
                     (or 130 for INT)
```

- `running`: worker is up; for function/module-call modes, waiting for result; for module-service, the entrypoint is executing.
- `done`: clean exit (function returned, module-call returned, or service entrypoint returned/called `ctx.exit(0)`).
- `killed`: `proc.kill("INT")` was honored (entrypoint resolved on `signal.aborted`) or `proc.kill("KILL")` called `worker.terminate()`.
- `error`: function threw, module-call rejected, or service entrypoint rejected.
- `timeout`: `opts.timeout` elapsed; bootstrap sent INT, then KILL after a grace period (default 1 s).

Exit codes follow Unix convention:
- `0` — clean exit
- `1` — unhandled error
- `124` — timeout
- `130` — SIGINT honored
- `137` — SIGKILL (terminate without cleanup)

## 7. Environment hook (`createWorker`)

The default `createWorker` builds a browser Worker via blob URL:

```js
function defaultCreateWorker(bootstrapSource) {
  const blob = new Blob([bootstrapSource], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url, { type: "module" });
  return {
    worker,
    cleanup: () => URL.revokeObjectURL(url),
  };
}
```

For tests and headless runtimes, callers supply their own. `@gcu/proc/node` exports `createNodeWorker(bootstrapSource)` which writes the source to a temp `.mjs` file and spawns a `worker_threads.Worker`. The shim adapts the `worker_threads.Worker` interface (`on('message', ...)`, `postMessage`, `terminate`) to look like browser `Worker` (`addEventListener`, `postMessage`, `terminate`). On terminate, the temp file is unlinked.

The bootstrap source itself runs in either environment via a small runtime detection at the top:

```js
let _send, _onMessage;
if (typeof self !== "undefined" && typeof importScripts !== "undefined") {
  // Browser worker
  _send = (m, t) => self.postMessage(m, t);
  _onMessage = fn => self.addEventListener("message", e => fn(e.data));
} else {
  // Node worker_threads ES module
  const wt = await import("node:worker_threads");
  _send = (m, t) => wt.parentPort.postMessage(m, t);
  _onMessage = fn => wt.parentPort.on("message", fn);
}
```

Both branches happen at module top level; top-level await is fine in module workers.

## 8. Signals

### 8.1 INT (cooperative)

`proc.kill("INT")` (or `proc.kill()` with no arg) posts `{type: "_proc_kill", signal: "INT"}`. The bootstrap fires its `AbortController.abort()`. In module-service mode, the user's entrypoint observes `ctx.signal.aborted` and bails out (typical pattern: `await new Promise(r => ctx.signal.addEventListener("abort", r))` at the end of the entrypoint). The bootstrap then sends `_proc_exit` with code 130 and closes.

A worker that ignores `ctx.signal` will never honor INT. After `opts.killGrace` ms (default 1000), the manager escalates to KILL.

### 8.2 KILL (forceful)

`proc.kill("KILL")` (and the timeout escalation) call `worker.terminate()` directly. No cleanup, no exit message. The manager marks state `killed`, exit code `137`. Any pending `proc.wait()` resolves immediately.

### 8.3 Timeouts

`opts.timeout` (ms) schedules an INT after `timeout` ms; if the process is still running `opts.killGrace` ms after that, escalates to KILL. The state ends up `timeout` (exit code 124) if it was the timeout that ended the process.

## 9. Invalidation

A common pattern from auditable's existing `worker()` builtin: a cell creates workers, and when the cell re-runs they need to be torn down. Phase A doesn't bake this in (proc is environment-agnostic) but exposes it as a one-liner in the consumer:

```js
// in src/js/cell-builtins/workers.js
const proc = await pm.spawn(fn, opts);
invalidation.then(() => proc.kill("KILL"));
```

## 10. Tests

A single test file at the project root, following project convention:

```
test/proc.test.mjs
```

Coverage:

1. **Function mode** — basic spawn, args, return value, transfer (TypedArray round-trip), error propagation.
2. **Module-call mode** — data: URI module, exported fn called, return value, error propagation.
3. **Module-service mode** — boot, ctx.send/on round-trip, ctx.signal honored on INT, ctx.exit(0).
4. **Pool** — createPool, exec, map, free-queue dispatch (workers reused, not round-robin), terminate.
5. **Compute** — sugar over function mode, error-rethrows-on-main.
6. **State machine** — running → done, running → killed (INT cooperative, INT timeout escalation, KILL forceful), running → error.
7. **I/O channels** — ctx.stdout streams to proc.stdout.onData, .text() collects to EOF, async iterator.
8. **Custom protocol** — proc.send / proc.on round-trip via _proc_msg.
9. **Process table** — pm.list, pm.get, pm.killAll.
10. **Limits** — maxProcesses queues spawns beyond cap.

Tests use the `@gcu/proc/node` shim. No browser harness needed for the Phase A or B unit tests.

## 11. Roadmap

Phases A (0.1.x), B (0.2.x), C (0.3.x), D (0.4.x), and E (0.5.x) have shipped. One more phase remains; here are the headlines:

- **Phase F — Remote / mesh execution**: `{ remote: { peer, via: mesh } }` in spawn options. Same Process surface, different execution backend.

**Urgent-now 0.2.x point-release follow-up (more urgent post-Phase-E):**

- **Principal-based VFS sandbox.** With daemons in the mix, any cell that can `pm.request` a daemon now has whatever capabilities the daemon was constructed with. Today daemons are fully-trusted. Principal carrying lets the spawning context's permissions ride along into the daemon's VFS calls, and the host re-validates on every proxy call (defense in depth). Same machinery applies to shell-service workers' `ctx.vfs` access. This is now the most impactful next change before Phase F.

**Phase B follow-ups (0.2.x point releases as consumers ask for them):**

- Principal-based VFS sandbox enforcement — serialize a principal into the spawn init message; both worker-side VFS and host-side proxy server enforce it. Host re-validates on every proxy call (defense in depth).
- Streaming reads (`createReadStream` over the RPC) — useful for piping large files into worker processing without buffering the whole file in the proxy protocol.
- VFS-path module loading — `spawn({ module: '/scripts/x.js', fn: 'run' })` reads the module source through the host VFS, hands it to the worker bootstrap. Currently throws because the dynamic-import-from-VFS plumbing isn't in 0.2.0.

## 12. Out of scope for 0.5.x

These are explicitly NOT in 0.5.0 and should produce hard errors (not silent stubs) if invoked:

- `{ tty }` in function or module-call mode → throws (TTY is service-mode only).
- `{ tty }` without `write`/`size`/`onKey` methods → throws shape-validation error.
- `{ remote }` in spawn options → throws "remote execution requires @gcu/proc Phase F."
- `module-call` with a VFS path (not a URL) → throws "VFS-path modules not supported yet" (deferred to a 0.2.x point release, see §11).
- `pm.spawn(string)` without `opts.shell` → throws (shell config is required for the string-payload path).
- `pm.exec` without `opts.shell` → same.
- `ctx.pm.spawn(fn, ...)` (function payloads from a worker) → throws "not supported in Phase D"; pass a string or `{module, mode}` instead.
- `pm.daemon(name, opts)` with `opts.restart` outside `'never' | 'on-crash' | 'always'` → throws.
- `pm.request(name, ...)` when the daemon is not running → throws.

Each error mentions the phase that would unlock it.

## 13. Versioning

Pre-1.0. Wire protocol (`_proc_*` namespace, message shapes) and public API (`ProcessManager`, `Process`, `Pool`) may shift before 1.0. Tag history: `0.1.x` = Phase A, `0.2.x` = A + B, `0.3.x` = A + B + C, `0.4.x` = A + B + C + D, `0.5.x` = A + B + C + D + E. Point releases under each minor add follow-ups without breaking the constructor or wire protocol. Phase F onward will land in `0.6.x` and may break the constructor signature if needed.

## 14. License

MIT.
