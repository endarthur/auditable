# @gcu/proc — Phase A specification

a process model for the browser. spawn Web Workers as PID-tracked processes with proper lifecycle, I/O channels, pools, and signal handling. zero dependencies.

This document specifies **Phase A only**: the standalone core (function, module-call, and module-service modes). VFS proxy, TTY proxy, daemons + service registry, shell-mode integration with `@gcu/coreutils`, and remote/mesh execution are deferred to later phases. They are listed under §11 — Roadmap.

The full multi-phase design lives in `spec_inbox/os/proc-spec.md`. This document is the authoritative spec for what ships in 0.1.0.

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

## 4. Wire protocol

All messages between host and worker use a plain object with a `type` field. Lifecycle messages use the reserved prefix `_proc_`. Custom messages (the user's protocol) ride on `_proc_msg`.

### 4.1 Host → Worker

| Type | Payload | Sent when |
|---|---|---|
| `_proc_init` | `{ mode, source?, args?, transfer?, url?, fn? }` | First message after worker boots. Bootstrap dispatches by `mode`. |
| `_proc_stdin` | `{ data, eof? }` | Host writes to process's stdin (Phase A: not heavily exercised). |
| `_proc_kill` | `{ signal: "INT" \| "TERM" }` | Cooperative kill — fires worker's AbortController. `KILL` is not on the wire; it's a `worker.terminate()`. |
| `_proc_msg` | `{ data }` | Custom protocol message from `proc.send(data)`. Bootstrap delivers `data` to `ctx.on` handlers in module-service mode. |

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

Tests use the `@gcu/proc/node` shim. No browser harness needed for Phase A.

## 11. Roadmap

Phase A ships function / module-call / module-service modes. Phases B-E remain in `spec_inbox/os/proc-spec.md` for design reference; here are the headlines:

- **Phase B — VFS proxy**: `{ vfs }` in ProcessManager constructor enables workers to access `@gcu/vfs` instances. Hybrid strategy: backends that work in workers (IDB, OPFS, fetch) get replicated; backends that don't (Memory, Comment, FSAA) get proxied via postMessage. Principal carries across into the worker.
- **Phase C — TTY proxy**: `{ tty }` in spawn options forwards `@gcu/term` input/output between main thread and worker. Lets TUI apps (pagers, editors) run in a worker without freezing the UI.
- **Phase D — Shell-mode integration**: `{ coreutils }` enables `pm.spawn("awk -F, ...")`. Replaces geas's worker-shim execution path. Real `&` / `jobs` / `fg` / `bg` in geas via the process table.
- **Phase E — Daemons + service registry**: `pm.daemon(name, handler, opts)`. Long-running named services with request/response (`pm.request(name, msg)`), restart policies (`never` / `on-crash` / `always`), exponential backoff. Builds on module-service mode.
- **Phase F — Remote / mesh execution**: `{ remote: { peer, via: mesh } }` in spawn options. Same Process surface, different execution backend.

## 12. Out of scope for Phase A

These are explicitly NOT in 0.1.0 and should produce hard errors (not silent stubs) if invoked:

- `{ vfs }` in ProcessManager constructor → throws "vfs requires @gcu/proc Phase B."
- `{ coreutils }` → throws "shell mode requires @gcu/proc Phase D."
- `pm.spawn(string)` (shell mode) → throws "shell mode requires @gcu/proc Phase D."
- `pm.daemon(...)` → throws "daemons require @gcu/proc Phase E."
- `{ tty }` in spawn options → throws "tty proxy requires @gcu/proc Phase C."
- `{ remote }` in spawn options → throws "remote execution requires @gcu/proc Phase F."
- `module-call` with a VFS path (not a URL) → throws "VFS-path modules require @gcu/proc Phase B."

Each error mentions the phase that would unlock it.

## 13. Versioning

Pre-1.0. Wire protocol (`_proc_*` namespace, message shapes) and public API (`ProcessManager`, `Process`, `Pool`) may shift before 1.0. Tag `0.1.x` covers Phase A; `0.2.x` is reserved for Phase B (VFS proxy) and may break the constructor signature if needed.

## 14. License

MIT.
