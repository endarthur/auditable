// Public API surface for @gcu/geas.
//
// v0.0.1 (Medium scope): lexer + parser only. Executor, builtins, terminal
// adapters, and the worker harness come in later iterations.
//
// Note on shape: uses `import { x } from './foo.js'; export { x };` rather
// than `export { x } from './foo.js'` so the concat-style build can strip
// both lines and leave api.js's contribution empty in the bundle — the
// footer in build.js then provides a single canonical export.

import { tokenize } from './lexer.js';
import { parse } from './parser.js';
import { parseWordParts } from './word-parts.js';
import { execute, normalizeContext } from './executor.js';
import { NODE } from './ast-nodes.js';
import { createHeadlessAdapter } from './adapters/headless.js';
import { createTermAdapter, adapterHooks, makeLineEditor } from './adapters/term.js';
import { createXtermAdapter } from './adapters/xterm.js';
import { defaultBuiltins } from './builtins.js';
import { mkTyped, isTyped } from './typed.js';
import { createGeasClient } from './worker/client.js';
import { setupGeasWorker } from './worker/worker-shim.js';
import { serveVFS, createVfsClient } from './worker/vfs-proxy.js';
import { serveHost, createHostClient } from './worker/host-proxy.js';
import { createLoopback } from './worker/loopback.js';
import { procToWorker, geasProcEntry } from './worker/proc-adapter.js';

// createShell({vfs, env, cwd, stdout, stderr, builtins, onCommand})
//
// Convenience factory that builds a long-lived shell context with the
// default geas built-ins pre-loaded (echo / pwd / cd / env / cat / ls /
// test / [ / true / false / : / export / exit). The returned object has:
//
//   .exec(source)      — parse + execute a script, return {exitCode,...}
//   .env               — Map (mutable; survives across exec calls)
//   .cwd               — string (mutable via cd builtin)
//   .lastStatus        — number, $? after the most recent command
//   .builtins          — Map (add/override entries before/between execs)
//   .functions         — Map of user-defined functions (populated by `name()`)
//
// Caller-supplied stdout/stderr/onCommand/extra builtins overlay the
// defaults. Pass a VFS instance to enable filesystem builtins + redirects.
export function createShell(opts = {}) {
  // Normalize ONCE and hold the result — every exec reuses this same
  // ctx, so cwd / env / functions / lastStatus all persist between
  // commands (a fresh-normalize-per-exec would drop `cd`'s effect,
  // since cwd is a primitive copied by value).
  const ctx = normalizeContext({
    vfs:        opts.vfs ?? null,
    host:       opts.host ?? null,
    env:        opts.env instanceof Map ? opts.env : new Map(Object.entries(opts.env || {})),
    cwd:        opts.cwd ?? '/',
    stdin:      '',
    stdout:     opts.stdout ?? (() => { throw new Error('createShell: stdout required'); }),
    stderr:     opts.stderr ?? opts.stdout ?? (() => { throw new Error('createShell: stderr required'); }),
    builtins:   _mergeBuiltins(opts.builtins),
    // POSIX shell convention: an unrecognised command prints
    // "{name}: command not found" to stderr and exits 127. The executor's
    // bare default just returns 127; createShell is the user-facing
    // factory, so this is the right place for the matching stderr write.
    onCommand:  opts.onCommand ?? (async (name, _argv, subCtx) => {
      await subCtx.stderr(`${name}: command not found\n`);
      return 127;
    }),
    functions:  new Map(),
    lastStatus: 0,
    // Interactive read hook. When `read` runs with no stdin available
    // and this is set, it awaits a line from here instead of returning
    // EOF. Shape: (opts) => Promise<{ line?, eof?, timeout? }>. opts
    // carries prompt, silent, nChars, delim, timeout, raw — the read
    // flags that affect line acquisition.
    readLine:   typeof opts.readLine === 'function' ? opts.readLine : null,
  });
  return {
    get env()        { return ctx.env; },
    get cwd()        { return ctx.cwd; },
    get lastStatus() { return ctx.lastStatus; },
    get builtins()   { return ctx.builtins; },
    get functions()  { return ctx.functions; },
    async exec(source) {
      const ast = parse(source);
      return await execute(ast, ctx);
    },
  };
}

function _mergeBuiltins(extra) {
  const base = defaultBuiltins();
  if (!extra) return base;
  const it = extra instanceof Map ? extra.entries() : Object.entries(extra);
  for (const [k, v] of it) base.set(k, v);
  return base;
}

export {
  tokenize, parse, parseWordParts, execute, NODE,
  createHeadlessAdapter, createTermAdapter, createXtermAdapter, adapterHooks, makeLineEditor,
  defaultBuiltins, mkTyped, isTyped,
  createGeasClient, setupGeasWorker, serveVFS, createVfsClient, createLoopback,
  serveHost, createHostClient,
  procToWorker, geasProcEntry,
};
