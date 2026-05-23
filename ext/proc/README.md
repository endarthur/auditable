# @gcu/proc

A process model for the browser. Spawn Web Workers as PID-tracked processes with proper lifecycle, I/O channels, pools, and signal handling. Zero dependencies.

```js
import { ProcessManager } from '@gcu/proc';

const pm = new ProcessManager();

// function mode — replaces auditable's worker() builtin
const result = await pm.compute(
  (data) => data.map(x => x * 2),
  [new Float64Array([1, 2, 3, 4])]
);

// pool — replaces auditable's workerPool() builtin
const pool = pm.createPool(4);
const results = await pool.map(items, (item) => heavyWork(item));
pool.terminate();

// module-service mode — for long-lived workers with a custom protocol
const proc = await pm.spawn({ module: 'my-service.js', mode: 'service' });
proc.send({ type: 'init', config: {...} });
proc.on(msg => { if (msg.type === 'ready') {...} });
proc.kill('INT');  // cooperative cancellation
```

## Modes

**function**: serialize a function to source, run it in a worker, return the result, terminate. Closures are stripped — same constraint as auditable's existing `worker()` builtin. Auto-detects TypedArray/ArrayBuffer transfer.

**module-call**: import an ES module by URL, call an exported function, return its result, terminate. URL modules only in 0.1.x (VFS-path modules require Phase B).

**module-service**: import an ES module by URL, the module's `default` export receives a `ctx` and runs until killed. Used for long-lived workers with a custom protocol (geas, future daemons). The `ctx` provides `stdin`/`stdout`/`stderr`, `signal` (AbortSignal), and `send`/`on` for the custom message channel.

## Status

**Phase A (0.1.x)** — function / module-call / module-service modes. Zero dependencies. This is what 0.1.0 ships.

Later phases — VFS proxy (B), TTY proxy (C), shell-mode + coreutils (D), daemons + service registry (E), remote/mesh execution (F) — are scoped in `SPEC.md §11` and `spec_inbox/os/proc-spec.md`. Each phase is independently landable.

Out-of-scope features in 0.1.x throw with a pointer to the phase that would unlock them — no silent stubs.

## Node usage (tests)

```js
import { ProcessManager } from '@gcu/proc';
import { createNodeWorker } from '@gcu/proc/node';

const pm = new ProcessManager({ createWorker: createNodeWorker });
```

The Node shim writes the worker bootstrap to a temp `.mjs` file and spawns a `worker_threads.Worker`. The bootstrap source itself handles the worker-side runtime detect, so the same code runs in browser workers and Node worker_threads.

## License

MIT.
