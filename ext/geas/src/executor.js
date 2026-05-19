// Executor — walks a parsed geas AST against a context, producing output
// and exit codes. v0 skeleton: covers the common-path shell semantics
// (simple commands, pipelines, and-or, lists, if/for/while/until/case,
// redirects, word expansion with $vars and $(cmd) substitution).
//
// Context shape (all fields are optional unless noted; defaults below):
//
//   vfs       — @gcu/vfs-shaped instance (readFile/writeFile/readdir/...).
//               Required if any redirect or filesystem builtin runs.
//   env       — Map<string,string>. Defaults to empty.
//   cwd       — string. Defaults to '/'.
//   stdin     — string | AsyncIterable<string>. Defaults to ''.
//   stdout    — async (text) => void. Defaults to throw if not provided.
//   stderr    — async (text) => void. Defaults to ctx.stdout if absent.
//   builtins  — Map<name, async (argv, subctx) => exitCode>. Empty default.
//   onCommand — async (name, argv, subctx) => exitCode. Called when a
//               command isn't a builtin; defaults to "127 command not found".
//   functions — Map<name, FunctionDef AST>. Populated by FunctionDef nodes.
//   lastStatus — number. Tracks $? across commands. Initialised to 0.
//
// What v0 does NOT do:
//   - Backgrounding via `&` (parsed, runs synchronously)
//   - Function call frames (FunctionDef stores the body; calling skips for now)
//   - Subshell isolation (Subshell runs in the same scope as a brace group)
//   - Glob expansion (patterns stay literal except inside `case`)
//   - Field splitting on $IFS (unquoted expansions stay single fields)
//   - Real streaming pipes (each stage's stdout buffers before the next runs)
//   - Process substitution `<(...)` / `>(...)`
//   - Job control / signals beyond Ctrl+C-style abort via thrown promises
//
// These are sized-by-need additions; the architecture leaves room.

import { NODE } from './ast-nodes.js';

export async function execute(ast, ctx) {
  const c = _normalize(ctx);
  return await _exec(ast, c);
}

function _normalize(ctx) {
  return {
    vfs:        ctx.vfs ?? null,
    env:        ctx.env instanceof Map ? ctx.env : new Map(Object.entries(ctx.env || {})),
    cwd:        ctx.cwd ?? '/',
    stdin:      ctx.stdin ?? '',
    stdout:     ctx.stdout ?? (() => { throw new Error('geas: no stdout sink configured'); }),
    stderr:     ctx.stderr ?? ctx.stdout ?? (() => { throw new Error('geas: no stderr sink configured'); }),
    builtins:   ctx.builtins instanceof Map ? ctx.builtins : new Map(Object.entries(ctx.builtins || {})),
    onCommand:  ctx.onCommand ?? (async (name) => 127),
    functions:  ctx.functions instanceof Map ? ctx.functions : new Map(Object.entries(ctx.functions || {})),
    lastStatus: ctx.lastStatus ?? 0,
    // Shell options (set via `set -e`, `set -u`, `set -o pipefail`, ...).
    // Live on ctx so builtins like `set` can flip them at runtime, and the
    // executor checks them at the right gates (errexit after every command
    // in a list / program; pipefail when deriving a pipeline's exit code;
    // nounset on var lookup).
    options:    ctx.options ?? { errexit: false, nounset: false, pipefail: false, xtrace: false },
    // True while evaluating an `if`/`while`/`until` condition, the left
    // side of `&&`/`||`, or a negated `! cmd`. errexit doesn't trigger
    // inside these contexts — only on the rightmost actually-evaluated
    // command of a list (POSIX 2.5.3 / Bash "Shell Builtin Commands" set).
    _inCondition: ctx._inCondition ?? false,
    positional: ctx.positional ?? [],
    // Internal signal markers — thrown by `break`/`continue`/`return`/`exit`.
    // Exposed on ctx so builtins can throw them too.
    _BREAK:     ctx._BREAK ?? Symbol.for('geas:break'),
    _CONTINUE:  ctx._CONTINUE ?? Symbol.for('geas:continue'),
    _RETURN:    ctx._RETURN ?? Symbol.for('geas:return'),
    _EXIT:      ctx._EXIT ?? Symbol.for('geas:exit'),
  };
}

// Run a child node with _inCondition forced true. Used by if/while/until
// conditions, the left side of &&/||, and the body of a negated pipeline.
// Restores _inCondition on return so siblings see the original value.
async function _withCondition(node, ctx) {
  const prev = ctx._inCondition;
  ctx._inCondition = true;
  try {
    return await _exec(node, ctx);
  } finally {
    ctx._inCondition = prev;
  }
}

// Does a command qualify for errexit-suppression by being a "tested" command?
// POSIX: negated pipelines (`! cmd`) never trigger errexit even on failure.
// Compound conditions handle their own context via _withCondition.
function _errexitExempt(cmd) {
  if (cmd && cmd.type === NODE.PIPELINE && cmd.negated) return true;
  return false;
}

// After executing a command in a list/program context, check whether
// errexit should trigger a script exit. Called by _execProgram, _execList,
// and the compound-body helpers (which themselves invoke _execList for
// their bodies, so the check happens transparently there too).
function _maybeErrexit(cmd, exitCode, ctx) {
  if (!ctx.options || !ctx.options.errexit) return;
  if (exitCode === 0) return;
  if (ctx._inCondition) return;
  if (_errexitExempt(cmd)) return;
  throw { exitCode, _exit: true };
}

async function _exec(node, ctx) {
  switch (node.type) {
    case NODE.PROGRAM:        return await _execProgram(node, ctx);
    case NODE.LIST:           return await _execList(node, ctx);
    case NODE.AND_OR:         return await _execAndOr(node, ctx);
    case NODE.PIPELINE:       return await _execPipeline(node, ctx);
    case NODE.SIMPLE_COMMAND: return await _execSimpleCommand(node, ctx);
    case NODE.IF_CLAUSE:      return await _execIf(node, ctx);
    case NODE.FOR_CLAUSE:     return await _execFor(node, ctx);
    case NODE.WHILE_CLAUSE:   return await _execWhile(node, ctx);
    case NODE.UNTIL_CLAUSE:   return await _execUntil(node, ctx);
    case NODE.CASE_CLAUSE:    return await _execCase(node, ctx);
    case NODE.BRACE_GROUP:    return await _execBraceGroup(node, ctx);
    case NODE.SUBSHELL:       return await _execSubshell(node, ctx);
    case NODE.FUNCTION_DEF:   return _execFunctionDef(node, ctx);
    default: throw new Error(`geas executor: unknown node type "${node.type}"`);
  }
}

// ── top-level ──

async function _execProgram(node, ctx) {
  let exitCode = 0;
  try {
    for (const cmd of node.commands) {
      const r = await _exec(cmd, ctx);
      exitCode = r.exitCode;
      ctx.lastStatus = exitCode;
      _maybeErrexit(cmd, exitCode, ctx);
    }
  } catch (e) {
    // `exit` builtin throws { exitCode, _exit: true }; catch here to stop
    // running subsequent top-level commands. The errexit path also throws
    // an _exit signal, which routes the same way. nounset (`set -u`)
    // tags its throw with `_unbound` so we can surface the variable name.
    if (e && e._exit) {
      if (e._unbound) {
        try { await ctx.stderr(`geas: ${e._unbound}: unbound variable\n`); } catch {}
      }
      return { exitCode: e.exitCode };
    }
    throw e;
  }
  return { exitCode };
}

async function _execList(node, ctx) {
  let exitCode = 0;
  for (const item of node.items) {
    const r = await _exec(item.cmd, ctx);
    exitCode = r.exitCode;
    ctx.lastStatus = exitCode;
    _maybeErrexit(item.cmd, exitCode, ctx);
    // v0: `&` runs synchronously, same as `;`.
  }
  return { exitCode };
}

async function _execAndOr(node, ctx) {
  // The left side of && / || is a "tested" command (its exit code drives
  // the chain decision), so errexit doesn't trigger on it. The right side
  // inherits the caller's _inCondition — at the top level that's false,
  // so the rightmost actually-evaluated command CAN trigger errexit; for
  // nested chains like `A && B && C` the outer wraps the inner left in a
  // condition, which transitively suppresses A and B but leaves C exposed.
  const left = await _withCondition(node.left, ctx);
  ctx.lastStatus = left.exitCode;
  if (node.op === '&&' && left.exitCode !== 0) return left;
  if (node.op === '||' && left.exitCode === 0) return left;
  const right = await _exec(node.right, ctx);
  ctx.lastStatus = right.exitCode;
  return right;
}

// ── pipelines ──

async function _execPipeline(node, ctx) {
  // A `! pipeline` is a "tested" command for errexit purposes — POSIX says
  // commands whose status is being inverted with `!` do NOT trigger
  // errexit. Force _inCondition for the body's evaluation so anything
  // inside (including non-final pipefail-derived non-zero exits) is
  // suppressed, then invert the final exit. The outer _maybeErrexit()
  // also short-circuits on negated pipelines via _errexitExempt.
  if (node.negated) {
    const inner = await _withCondition({ ...node, negated: false }, ctx);
    return { exitCode: inner.exitCode === 0 ? 1 : 0 };
  }

  if (node.commands.length === 1) {
    const r = await _exec(node.commands[0], ctx);
    return { exitCode: r.exitCode };
  }

  // v0: buffered pipes. Each stage runs to completion, its stdout collected
  // and passed to the next stage as stdin. The buffer can be either string
  // chunks (POSIX-shape) OR a single Typed value (GCU-shape typed pipe):
  //
  //   - If a stage emits a Typed value via ctx.stdout({__geas_typed, ...}),
  //     the next stage's stdin is that Typed object directly.
  //   - If a stage emits text, the next stage's stdin is the concatenated
  //     string.
  //   - If both happen in the same stage (mixed), text wins (Typed values
  //     are dropped). Stages should emit either-or, not both.
  //
  // Consumers that don't understand the Typed kind get text via the value's
  // toString() — see typed.js for the protocol contract.
  let pipeIn = ctx.stdin;
  const exits = [];
  for (let i = 0; i < node.commands.length; i++) {
    const isLast = i === node.commands.length - 1;
    let bufOut = [];
    let bufTyped = null;
    const subCtx = {
      ...ctx,
      stdin: pipeIn,
      stdout: isLast ? ctx.stdout : (value) => {
        if (value && typeof value === 'object' && value.__geas_typed === true) {
          bufTyped = value;
        } else {
          bufOut.push(typeof value === 'string' ? value : String(value));
        }
      },
    };
    const r = await _exec(node.commands[i], subCtx);
    exits.push(r.exitCode);
    if (!isLast) {
      // Prefer Typed if the stage emitted one — otherwise concat text.
      pipeIn = bufTyped !== null ? bufTyped : bufOut.join('');
    }
  }
  // POSIX pipefail: pipeline exit code is the rightmost non-zero stage,
  // or 0 if all succeeded. Without pipefail, only the last stage's exit
  // counts. (We use first non-zero here — bash returns "last non-zero",
  // which is the same when only one stage fails; for multi-failure
  // cases, "first non-zero" tends to be more useful for diagnosis.)
  const lastExit = exits[exits.length - 1];
  const finalExit = ctx.options.pipefail
    ? (exits.find(c => c !== 0) ?? 0)
    : lastExit;
  return { exitCode: finalExit };
}

// ── simple commands ──

async function _execSimpleCommand(node, ctx) {
  // 1. Expand assignments. If there are no words (no command name), apply
  //    them to ctx.env permanently. Otherwise, scope them to this command
  //    only (POSIX semantics).
  const assignmentBindings = [];
  for (const a of node.assignments) {
    const value = await _expandWord(a.value, ctx);
    assignmentBindings.push([a.name, value]);
  }
  if (node.words.length === 0) {
    for (const [n, v] of assignmentBindings) ctx.env.set(n, v);
    return { exitCode: 0 };
  }

  // 2. Set up sub-context for per-command assignments + redirects.
  //    Only create a fresh subCtx when we actually need isolation —
  //    otherwise pass the parent ctx through directly so builtins that
  //    mutate state (cd → ctx.cwd, exit → throws) see the right object.
  //    POSIX: per-command assignments scope only to that command; redirects
  //    only affect that command's stdio. Plain builtins with no
  //    assignments/redirects can (and should) mutate the parent ctx.
  let subCtx = ctx;
  const needsScope =
    assignmentBindings.length > 0 ||
    (node.redirects && node.redirects.length > 0);
  if (needsScope) {
    subCtx = { ...ctx, _redirectFlush: null };
    if (assignmentBindings.length > 0) {
      subCtx.env = new Map(ctx.env);
      for (const [n, v] of assignmentBindings) subCtx.env.set(n, v);
    }
    await _applyRedirects(node.redirects, subCtx);
  }

  // 3. Expand command name + args. Argv expansion (unlike redirect targets)
  //    is subject to field splitting on $IFS and pathname (glob) expansion,
  //    so a single Word can produce zero, one, or many argv entries.
  const argv = [];
  for (const w of node.words) {
    const fields = await _expandWordToFields(w, subCtx);
    for (const f of fields) argv.push(f);
  }
  // POSIX: if all words expand to nothing (e.g. `$EMPTY $UNDEFINED`),
  // there's no command to run — exit 0 (assignments + redirects above
  // are the side effect).
  if (argv.length === 0) return { exitCode: 0 };
  const cmdName = argv[0];

  // 4. Dispatch.
  let exitCode = 127;
  try {
    try {
      if (ctx.builtins.has(cmdName)) {
        const r = await ctx.builtins.get(cmdName)(argv, subCtx);
        exitCode = typeof r === 'number' ? r : 0;
      } else if (ctx.functions.has(cmdName)) {
        const fnDef = ctx.functions.get(cmdName);
        exitCode = await _callFunction(fnDef, argv.slice(1), subCtx);
      } else {
        exitCode = await ctx.onCommand(cmdName, argv, subCtx);
      }
    } catch (e) {
      // The `exit` builtin throws { exitCode, _exit: true } to signal full
      // script termination — re-throw so _execProgram catches it instead of
      // smoothing it over into a normal exit code. `return` throws
      // { exitCode, _return: true } to unwind to the function boundary —
      // also re-throw so _callFunction sees it. Plain { exitCode } throws
      // (no _exit/_return marker) are treated as the command's exit code.
      if (e && (e._exit || e._return)) throw e;
      if (e && typeof e.exitCode === 'number') exitCode = e.exitCode;
      else throw e;
    }
  } finally {
    // Redirects buffered their writes; flush them now that the command
    // has produced all its output. Runs even if the command exited via
    // `_exit` or threw — `> file` should land its bytes either way.
    if (subCtx !== ctx) await _flushRedirects(subCtx);
  }
  ctx.lastStatus = exitCode;
  return { exitCode };
}

// ── compound commands ──

// Wrap a compound clause's execution in its trailing-redirect scope.
// POSIX allows `if/for/while/until/case ... done > file` to redirect
// the whole compound's stdout. We isolate via a sub-ctx (same shape as
// brace groups: shared env, separate redirect-flush queue), run the
// caller-supplied body, and flush at the boundary.
async function _withCompoundRedirects(node, ctx, body) {
  if (!node.redirects || node.redirects.length === 0) return await body(ctx);
  const subCtx = { ...ctx, _redirectFlush: null };
  await _applyRedirects(node.redirects, subCtx);
  try {
    return await body(subCtx);
  } finally {
    await _flushRedirects(subCtx);
  }
}

async function _execIf(node, ctx) {
  return await _withCompoundRedirects(node, ctx, async (ctx) => {
    const cond = await _withCondition(node.cond, ctx);
    if (cond.exitCode === 0) return await _exec(node.then, ctx);
    for (const elif of node.elifs) {
      const c = await _withCondition(elif.cond, ctx);
      if (c.exitCode === 0) return await _exec(elif.then, ctx);
    }
    if (node.else) return await _exec(node.else, ctx);
    return { exitCode: 0 };
  });
}

async function _execFor(node, ctx) {
  return await _withCompoundRedirects(node, ctx, async (ctx) => {
    // POSIX: `for x` (no `in`) iterates over "$@" — the positional params.
    // v0 doesn't have positional params plumbed through; treat as no-op
    // iteration in that case.
    //
    // Field expansion: each word can yield multiple values via $list-splitting
    // or glob expansion (`for f in *.csv`), so flatten with the splitting
    // surface rather than the single-string one.
    const values = [];
    if (node.words) {
      for (const w of node.words) {
        const fields = await _expandWordToFields(w, ctx);
        for (const f of fields) values.push(f);
      }
    }
    let exitCode = 0;
    for (const v of values) {
      ctx.env.set(node.name, v);
      try {
        const r = await _exec(node.body, ctx);
        exitCode = r.exitCode;
      } catch (e) {
        if (e === ctx._BREAK) return { exitCode };
        if (e === ctx._CONTINUE) continue;
        throw e;
      }
    }
    return { exitCode };
  });
}

async function _execWhile(node, ctx) {
  return await _withCompoundRedirects(node, ctx, async (ctx) => {
    let exitCode = 0;
    // POSIX safety net: cap iterations to a large but bounded number so a
    // pure infinite loop in a notebook cell doesn't hang the worker. Real
    // shells don't do this; we choose to because we're running in someone's
    // browser. Override by setting ctx.maxWhileIters.
    const maxIters = ctx.maxWhileIters ?? 1_000_000;
    let n = 0;
    while (true) {
      if (++n > maxIters) {
        throw new Error(`geas: while-loop exceeded ${maxIters} iterations (set ctx.maxWhileIters to raise)`);
      }
      const cond = await _withCondition(node.cond, ctx);
      if (cond.exitCode !== 0) break;
      try {
        const r = await _exec(node.body, ctx);
        exitCode = r.exitCode;
      } catch (e) {
        if (e === ctx._BREAK) break;
        if (e === ctx._CONTINUE) continue;
        throw e;
      }
    }
    return { exitCode };
  });
}

async function _execUntil(node, ctx) {
  return await _withCompoundRedirects(node, ctx, async (ctx) => {
    let exitCode = 0;
    const maxIters = ctx.maxWhileIters ?? 1_000_000;
    let n = 0;
    while (true) {
      if (++n > maxIters) {
        throw new Error(`geas: until-loop exceeded ${maxIters} iterations`);
      }
      const cond = await _withCondition(node.cond, ctx);
      if (cond.exitCode === 0) break;
      try {
        const r = await _exec(node.body, ctx);
        exitCode = r.exitCode;
      } catch (e) {
        if (e === ctx._BREAK) break;
        if (e === ctx._CONTINUE) continue;
        throw e;
      }
    }
    return { exitCode };
  });
}

async function _execCase(node, ctx) {
  return await _withCompoundRedirects(node, ctx, async (ctx) => {
    const word = await _expandWord(node.word, ctx);
    for (const item of node.items) {
      for (const pat of item.patterns) {
        const patStr = await _expandWord(pat, ctx);
        if (_globMatch(patStr, word)) {
          if (item.body) {
            const r = await _exec(item.body, ctx);
            return r;
          }
          return { exitCode: 0 };
        }
      }
    }
    return { exitCode: 0 };
  });
}

async function _execBraceGroup(node, ctx) {
  // Brace groups share the caller's scope (unlike subshells) — only
  // redirects are scoped. We still need a fresh _redirectFlush queue
  // so the group's redirects flush at the group boundary, not earlier.
  const subCtx = { ...ctx, _redirectFlush: null };
  await _applyRedirects(node.redirects, subCtx);
  let result;
  try {
    result = await _exec(node.body, subCtx);
  } finally {
    await _flushRedirects(subCtx);
  }
  return result;
}

async function _execSubshell(node, ctx) {
  // POSIX: subshells run in a copy of the parent's environment, so any
  // mutation — env vars, cwd, function definitions, set-options, last
  // status — stays inside. We clone every mutable container; `options`
  // gets a shallow spread (it's a flat bool record). Positional params
  // are immutable arrays so a reference-share is fine.
  const subCtx = {
    ...ctx,
    env:       new Map(ctx.env),
    functions: new Map(ctx.functions),
    options:   { ...ctx.options },
    lastStatus: ctx.lastStatus,
    _redirectFlush: null,
    // The subshell starts a fresh execution context — its body is at
    // "top level" inside the subshell. Outer flags like `_inCondition`
    // (set when the subshell is the left side of `||`, the test of
    // an `if`, etc.) shouldn't suppress errexit inside.
    _inCondition: false,
  };
  await _applyRedirects(node.redirects, subCtx);
  let result;
  try {
    try {
      result = await _exec(node.body, subCtx);
    } catch (e) {
      // POSIX: an `exit` inside a subshell terminates only the subshell.
      // errexit (`set -e`) inside the subshell similarly halts only the
      // subshell. Both signal via `_exit` — convert to a regular exit
      // code for the subshell as a whole so it doesn't propagate out.
      if (e && e._exit) result = { exitCode: e.exitCode };
      else throw e;
    }
  } finally {
    await _flushRedirects(subCtx);
  }
  return result;
}

function _execFunctionDef(node, ctx) {
  ctx.functions.set(node.name, node);
  return { exitCode: 0 };
}

// ── function call frames ──
//
// Each call pushes a frame onto ctx._localFrames. The frame remembers
// the prior values of any variable later declared `local` inside the
// function, so we can restore them on return. Positional parameters
// ($1..$N, $#, $@, $*) are similarly save-and-restored.
//
// Non-local variable assignments inside a function leak to the parent
// (POSIX dynamic scoping). `local NAME[=val]` shadows the parent
// binding for the frame's lifetime. `return [N]` exits the function
// with status N; signalled via { _return: true } and caught here so
// it never propagates past the call boundary.
async function _callFunction(fnDef, args, ctx) {
  const frame = { savedBindings: new Map() };
  if (!ctx._localFrames) ctx._localFrames = [];
  ctx._localFrames.push(frame);
  const savedPositional = ctx.positional || [];
  ctx.positional = args;
  let exitCode = 0;
  try {
    const r = await _exec(fnDef.body, ctx);
    exitCode = r.exitCode;
  } catch (e) {
    if (e && e._return) {
      exitCode = e.exitCode;
    } else {
      // Re-throw _exit (which terminates the whole script) and any other
      // non-return signal, but make sure the finally still runs to
      // unwind locals and positional.
      throw e;
    }
  } finally {
    for (const [name, prior] of frame.savedBindings) {
      if (prior === undefined) ctx.env.delete(name);
      else ctx.env.set(name, prior);
    }
    ctx._localFrames.pop();
    ctx.positional = savedPositional;
  }
  return exitCode;
}

// ── redirects ──

async function _applyRedirects(redirects, ctx) {
  if (!redirects || redirects.length === 0) return;
  // Each write redirect buffers its chunks into a local array; the
  // single VFS write happens in `_flushRedirects` at the command (or
  // brace/subshell) boundary. The previous per-call read+rewrite cost
  // O(n²) for hot loops like `for i in ...; do echo $i >> file; done`.
  const ensureFlushQueue = () => {
    if (!ctx._redirectFlush) ctx._redirectFlush = [];
    return ctx._redirectFlush;
  };
  for (const r of redirects) {
    const target = await _expandWord(r.target, ctx);
    const isWrite = r.op === '>' || r.op === '>|' || r.op === '>>';
    const fd = r.fd;
    if (isWrite) {
      _requireVfs(ctx, `redirect ${r.op}`);
      const path = _resolvePath(target, ctx);
      const buf = [];
      const sink = (text) => {
        buf.push(typeof text === 'string' ? text : String(text));
      };
      // POSIX defaults: `>` / `>|` route fd 1 (stdout) to the file;
      // `2>` routes fd 2; other fd numbers are not modeled in v0.
      if (fd === 2) ctx.stderr = sink;
      else          ctx.stdout = sink;
      const appendMode = r.op === '>>';
      ensureFlushQueue().push(async () => {
        const out = buf.join('');
        if (appendMode) {
          let prior = '';
          try { prior = await ctx.vfs.readFile(path, 'text'); } catch { /* missing file → start fresh */ }
          await ctx.vfs.writeFile(path, prior + out);
        } else {
          // `>` truncates: even with zero output, the file is created/emptied.
          await ctx.vfs.writeFile(path, out);
        }
      });
      continue;
    }
    if (r.op === '<') {
      _requireVfs(ctx, 'redirect <');
      const path = _resolvePath(target, ctx);
      ctx.stdin = await ctx.vfs.readFile(path, 'text');
      continue;
    }
    if (r.op === '<<' || r.op === '<<-') {
      // Here-doc body was attached at parse time.
      let body = r.body ?? '';
      if (!r.bodyQuoted) body = await _expandTextString(body, ctx);
      ctx.stdin = body;
      continue;
    }
    if (r.op === '>&' || r.op === '<&') {
      // Duplicate fd. `2>&1` (stderr → stdout) and `1>&2` are the common cases.
      if (fd === 2 && target === '1') ctx.stderr = ctx.stdout;
      else if (fd === 1 && target === '2') ctx.stdout = ctx.stderr;
      // Other dup combinations are rare; skip for v0.
    }
  }
}

// Drain a context's pending redirect-flush callbacks. Called at the
// boundary of any scope that applied redirects (simple command, brace
// group, subshell). Failures during flush emit a stderr diagnostic but
// don't unwind further — the command's exit code is already decided.
async function _flushRedirects(ctx) {
  if (!ctx._redirectFlush || ctx._redirectFlush.length === 0) return;
  const queue = ctx._redirectFlush;
  ctx._redirectFlush = null;
  for (const flush of queue) {
    try { await flush(); }
    catch (e) {
      try { await ctx.stderr(`geas: redirect: ${e.message || e}\n`); } catch { /* ignore */ }
    }
  }
}

function _requireVfs(ctx, what) {
  if (!ctx.vfs) throw new Error(`geas: ${what} requires a VFS in context`);
}

function _resolvePath(p, ctx) {
  if (p.startsWith('/')) return p;
  // Simple POSIX join: cwd + '/' + path. Doesn't normalise '../' etc.
  // The VFS itself can handle that on its end.
  return ctx.cwd.endsWith('/') ? ctx.cwd + p : ctx.cwd + '/' + p;
}

// ── word expansion ──
//
// Two surfaces:
//   _expandWord(word, ctx) → string
//     Concatenates parts, NO field splitting or globbing. Used for
//     redirect targets, case patterns, heredoc delimiters — anywhere
//     POSIX says expansion produces a single field.
//
//   _expandWordToFields(word, ctx) → string[]
//     Full POSIX expansion: substitution → field splitting on $IFS →
//     pathname expansion (glob). Used for argv positions (command name
//     + args) and `for ... in` lists, where one word can yield 0-N fields.

export async function _expandWord(word, ctx) {
  if (!word || !word.parts) return word?.value ?? '';
  let out = '';
  for (const part of word.parts) {
    out += await _expandPart(part, ctx);
  }
  return out;
}

// Field-aware expansion. Walks parts producing "fragments" — pairs of
// (text, splittable?) — then runs IFS-based field splitting only at
// splittable boundaries. Literal/quoted text never splits, even if it
// contains spaces. Finally glob-expands each resulting field against
// ctx.vfs when the field contains pattern metacharacters.
async function _expandWordToFields(word, ctx) {
  if (!word || !word.parts) {
    return word?.value !== undefined ? [word.value] : [];
  }
  const frags = [];
  for (const part of word.parts) await _expandPartToFrags(part, ctx, frags, /*inQuote*/ false);
  // Pair each field with a "had any quoted contribution" flag so we know
  // whether to attempt glob expansion. POSIX: glob chars introduced via
  // quoted text are LITERAL (`"/a/*.txt"` doesn't expand). v0 simplifies
  // to per-field rather than per-character — if any contributing fragment
  // was quoted, skip globbing for that whole field. The common cases
  // (`*.txt` unquoted, `"/dir/*.txt"` quoted) work; the mixed case
  // (`"/dir"/*.txt`) errs on the safe side of not-globbing.
  const fieldsWithMeta = _splitFieldsWithMeta(frags, _getIFS(ctx));
  if (!ctx.vfs) return fieldsWithMeta.map(f => f.text);
  const out = [];
  for (const f of fieldsWithMeta) {
    if (f.anyQuoted || !_hasGlobChars(f.text)) { out.push(f.text); continue; }
    const matches = await _globExpand(f.text, ctx);
    if (matches.length === 0) out.push(f.text);
    else for (const m of matches) out.push(m);
  }
  return out;
}

// Fragment shape: { t: text, s: splittable, q: quoted-source }
// - s (splittable): true iff IFS-splitting should happen across this frag's chars
// - q (quoted-source): true iff this frag contributed by a quoted (dq/sq/escape)
//                     source; used downstream to suppress globbing on the
//                     resulting field.
async function _expandPartToFrags(part, ctx, frags, inQuote) {
  switch (part.kind) {
    case 'lit':    frags.push({ t: part.value, s: false, q: inQuote });            return;
    case 'sq':     frags.push({ t: part.value, s: false, q: true });               return;
    case 'escape': frags.push({ t: part.value, s: false, q: true });               return;
    case 'dq': {
      // Everything inside dq is quoted + non-splittable. Empty `""` still
      // contributes a sentinel frag so `cat ""` keeps its empty argv slot.
      // Exception: a dq containing only `"$@"` with no positional args
      // legitimately produces ZERO fields (POSIX), so we don't emit the
      // sentinel when the inside had content but resolved to no frags.
      const before = frags.length;
      for (const p of part.parts) await _expandPartToFrags(p, ctx, frags, /*inQuote*/ true);
      if (part.parts.length === 0 && frags.length === before) {
        frags.push({ t: '', s: false, q: true });
      }
      return;
    }
    case 'var': {
      // `$@` and `$*` are special: each positional becomes its own field.
      // POSIX:
      //   $@ unquoted   → each positional, then IFS-split each (rare)
      //   "$@"          → each positional, NO splitting (the common case)
      //   $* unquoted   → IFS-joined into one field, then IFS-split
      //   "$*"          → IFS-joined into one field, NO splitting
      // We use a splittable space frag between each positional to force
      // field boundaries through the splitter regardless of quoting.
      if (part.name === '@') {
        const pos = ctx.positional || [];
        for (let k = 0; k < pos.length; k++) {
          if (k > 0) frags.push({ t: ' ', s: true, q: false }); // boundary
          frags.push({ t: pos[k], s: false, q: inQuote });
        }
        return;
      }
      frags.push({ t: _lookupVar(part.name, ctx), s: !inQuote, q: inQuote });
      return;
    }
    case 'param':  frags.push({ t: await _expandParam(part, ctx),     s: !inQuote, q: inQuote }); return;
    case 'cmd':    frags.push({ t: await _runCmdSub(part.body, ctx),  s: !inQuote, q: inQuote }); return;
    case 'arith':  frags.push({ t: _evalArith(part.body, ctx),        s: !inQuote, q: inQuote }); return;
  }
}

// Field-split fragments on IFS. Whitespace IFS chars (' ', '\t', '\n')
// are POSIX "whitespace IFS" — runs of them treat as one separator and
// leading/trailing runs are stripped. Non-whitespace IFS chars each
// separate one field (allowing empty fields). For v0 we honour both.
// Variant that returns [{text, anyQuoted}] so the caller knows whether to
// glob-expand each field. Per-field, anyQuoted is the OR of contributing
// fragments' q flag — once a quoted source has touched the field, glob
// chars in that field are treated as literal.
function _splitFieldsWithMeta(frags, ifs) {
  if (frags.length === 0) return [];
  // Build a marker-tagged string: '' marks where a splittable run
  // began, '' where it ended. Then walk, splitting only between
  // markers' contents on IFS chars.
  //
  // Simpler approach: produce fields by streaming. Maintain `cur` string
  // accumulator + emit when a splittable fragment yields an IFS char that
  // closes the current field.
  const wsIFS = new Set();
  const otherIFS = new Set();
  for (const c of ifs) {
    if (c === ' ' || c === '\t' || c === '\n') wsIFS.add(c);
    else otherIFS.add(c);
  }
  const out = [];
  let cur = '';
  let curAnyQuoted = false;
  let curHasContent = false;
  let seenSplittable = false;
  let pendingWsBoundary = false;
  const emit = () => {
    out.push({ text: cur, anyQuoted: curAnyQuoted });
    cur = ''; curAnyQuoted = false; curHasContent = false;
  };
  for (const frag of frags) {
    if (!frag.s) {
      if (pendingWsBoundary && curHasContent) emit();
      pendingWsBoundary = false;
      cur += frag.t;
      if (frag.t.length > 0) curHasContent = true;
      if (frag.q) curAnyQuoted = true;
      continue;
    }
    seenSplittable = true;
    for (const ch of frag.t) {
      if (wsIFS.has(ch)) {
        if (curHasContent) pendingWsBoundary = true;
        continue;
      }
      if (otherIFS.has(ch)) {
        if (curHasContent || !pendingWsBoundary) emit();
        else { cur = ''; curAnyQuoted = false; curHasContent = false; }
        pendingWsBoundary = false;
        continue;
      }
      if (pendingWsBoundary && curHasContent) emit();
      pendingWsBoundary = false;
      cur += ch;
      curHasContent = true;
      // splittable frag → unquoted-sourced; do NOT set curAnyQuoted
    }
  }
  if (curHasContent) emit();
  // Edge case (same as before): a Word with only non-splittable empty
  // frags (e.g. `""`) must still produce one empty field.
  if (out.length === 0 && !seenSplittable) {
    return [{ text: cur, anyQuoted: curAnyQuoted }];
  }
  return out;
}

function _getIFS(ctx) {
  return ctx.env.get('IFS') ?? ' \t\n';
}

// ── pathname expansion (glob) ──

function _hasGlobChars(s) {
  return /[*?\[]/.test(s);
}

async function _globExpand(pattern, ctx) {
  // VFS.glob handles absolute patterns natively. For relative, resolve
  // against ctx.cwd first, then strip the cwd prefix back off the results
  // so the returned fields stay relative — matching shell convention.
  const isRel = !pattern.startsWith('/');
  const fullPattern = isRel
    ? (ctx.cwd.endsWith('/') ? ctx.cwd : ctx.cwd + '/') + pattern
    : pattern;
  let matches = [];
  try {
    matches = await ctx.vfs.glob(fullPattern);
  } catch {
    return [];
  }
  if (isRel) {
    const prefix = ctx.cwd.endsWith('/') ? ctx.cwd : ctx.cwd + '/';
    matches = matches.map(p => p.startsWith(prefix) ? p.slice(prefix.length) : p);
  }
  return matches.sort();
}

async function _expandPart(part, ctx) {
  switch (part.kind) {
    case 'lit':    return part.value;
    case 'sq':     return part.value;
    case 'escape': return part.value;
    case 'dq': {
      let out = '';
      for (const p of part.parts) out += await _expandPart(p, ctx);
      return out;
    }
    case 'var':   return _lookupVar(part.name, ctx);
    case 'param': return await _expandParam(part, ctx);
    case 'cmd':   return await _runCmdSub(part.body, ctx);
    case 'arith': return _evalArith(part.body, ctx);
    default: return '';
  }
}

function _lookupVar(name, ctx) {
  // Special parameters.
  if (name === '?') return String(ctx.lastStatus);
  if (name === '#') return String((ctx.positional || []).length);
  if (name === '@') return (ctx.positional || []).join(' ');
  if (name === '*') return (ctx.positional || []).join(' ');
  if (name === '$') return String(typeof process !== 'undefined' ? process.pid : 0);
  if (/^\d+$/.test(name)) {
    const idx = Number(name);
    if (idx === 0) return ctx.env.get('0') ?? 'geas';
    return (ctx.positional || [])[idx - 1] ?? '';
  }
  if (ctx.env.has(name)) return ctx.env.get(name);
  // POSIX nounset (`set -u`): unbound named variable is a fatal error.
  // Throws an _exit signal so _execProgram halts the script. Special
  // params, positional, and the parameter-expansion forms `${X:-d}` /
  // `${X-d}` / `${X:+v}` / `${X+v}` route around _lookupVar (they go
  // through _expandParam directly), which preserves POSIX semantics.
  if (ctx.options && ctx.options.nounset) {
    throw { exitCode: 1, _exit: true, _unbound: name };
  }
  return '';
}

async function _expandParam(part, ctx) {
  const set = ctx.env.has(part.name);
  const val = set ? ctx.env.get(part.name) : '';
  const isNull = !val;
  switch (part.op) {
    case ':-': return (!set || isNull) ? await _expandWord(part.word, ctx) : val;
    case '-':  return (!set)           ? await _expandWord(part.word, ctx) : val;
    case ':=': {
      if (!set || isNull) {
        const def = await _expandWord(part.word, ctx);
        ctx.env.set(part.name, def);
        return def;
      }
      return val;
    }
    case '=': {
      if (!set) {
        const def = await _expandWord(part.word, ctx);
        ctx.env.set(part.name, def);
        return def;
      }
      return val;
    }
    case ':?': {
      if (!set || isNull) {
        const msg = part.word ? await _expandWord(part.word, ctx) : `${part.name}: parameter null or not set`;
        await ctx.stderr(msg + '\n');
        throw { exitCode: 1 };
      }
      return val;
    }
    case '?': {
      if (!set) {
        const msg = part.word ? await _expandWord(part.word, ctx) : `${part.name}: parameter not set`;
        await ctx.stderr(msg + '\n');
        throw { exitCode: 1 };
      }
      return val;
    }
    case ':+': return (set && !isNull) ? await _expandWord(part.word, ctx) : '';
    case '+':  return (set)             ? await _expandWord(part.word, ctx) : '';
    // `#` is overloaded: `${#name}` (parser emits word=null) is length;
    // `${name#pat}` and friends are prefix/suffix removal using
    // _patternRemove's scan-based glob matcher.
    case '#':
    case '##':
    case '%':
    case '%%': {
      if (part.op === '#' && part.word == null) return String(val.length);
      const pat = part.word ? await _expandWord(part.word, ctx) : '';
      return _patternRemove(val, pat, part.op);
    }
    default: return val;
  }
}

function _patternRemove(s, pat, op) {
  // POSIX glob → regex via _globToRegExp. Match is scan-based rather
  // than relying on regex backtracking: appending `?` to make a regex
  // "lazy" only works for trailing quantifiers, and a bare `[abc]?`
  // means "optional class" not "shortest match." Direct scanning gives
  // unambiguous shortest/longest semantics for arbitrary glob shapes.
  const re = _globToRegExp(pat);
  const anchored = new RegExp('^' + re.source + '$');
  if (op === '#') {
    // Prefix shortest: empty prefix outward.
    for (let i = 0; i <= s.length; i++) {
      if (anchored.test(s.slice(0, i))) return s.slice(i);
    }
    return s;
  }
  if (op === '##') {
    // Prefix longest: full-string inward.
    for (let i = s.length; i >= 0; i--) {
      if (anchored.test(s.slice(0, i))) return s.slice(i);
    }
    return s;
  }
  if (op === '%') {
    // Suffix shortest: empty suffix outward.
    for (let i = s.length; i >= 0; i--) {
      if (anchored.test(s.slice(i))) return s.slice(0, i);
    }
    return s;
  }
  if (op === '%%') {
    // Suffix longest: full-string inward.
    for (let i = 0; i <= s.length; i++) {
      if (anchored.test(s.slice(i))) return s.slice(0, i);
    }
    return s;
  }
  return s;
}

async function _runCmdSub(body, ctx) {
  // Parse + execute the body in a sub-context with a buffered stdout.
  // Lazy import to avoid a circular dep (parser already imports nothing
  // from executor, but we keep the surface minimal).
  const { parse } = await import('./parser.js');
  const ast = parse(body);
  const chunks = [];
  const subCtx = { ...ctx, stdout: (t) => { chunks.push(String(t)); } };
  await _exec(ast, subCtx);
  // POSIX: trailing newlines are stripped from $(...) result.
  return chunks.join('').replace(/\n+$/, '');
}

// ── arithmetic expansion ──
//
// Real recursive-descent parser over POSIX arith. Replaces the previous
// `eval()`-after-substitution hack — the eval was gated by a strict
// charset regex, but that regex blocked legitimate POSIX syntax like
// `$((x = 5))` or `$((x ? a : b))`, and the eval itself was a code
// smell even when gated.
//
// Precedence ladder (low → high): assignment, ternary, logical-or,
// logical-and, bitwise-or, bitwise-xor, bitwise-and, equality,
// comparison, shift, additive, multiplicative, unary, primary.
//
// All arithmetic is 32-bit integer (POSIX). Division truncates toward
// zero. Division/modulo by zero → 0 (silent; POSIX-undefined). Variables
// can be referenced bare (`x`) or with `$` (`$x`); both look up in
// ctx.env. Unbound names treat as 0.
function _evalArith(body, ctx) {
  let tokens;
  try {
    tokens = _arithTokenize(body);
  } catch {
    return '0';
  }
  const state = { tokens, i: 0 };
  let val;
  try {
    val = _arithAssign(state, ctx);
    if (state.i !== tokens.length) return '0';
  } catch {
    return '0';
  }
  return String(val | 0);
}

const _ARITH_OPS = [
  // Longest-first so '<<=' beats '<<' beats '<'.
  '<<=', '>>=',
  '&&', '||', '<<', '>>', '<=', '>=', '==', '!=',
  '+=', '-=', '*=', '/=', '%=', '|=', '&=', '^=',
  '+', '-', '*', '/', '%', '!', '~', '&', '|', '^',
  '<', '>', '=', '(', ')', '?', ':', ',',
];

function _arithTokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n') { i++; continue; }
    if (ch >= '0' && ch <= '9') {
      let j = i, val;
      if (ch === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        j = i + 2;
        while (j < src.length && /[0-9a-fA-F]/.test(src[j])) j++;
        val = parseInt(src.slice(i, j), 16);
      } else if (ch === '0' && /[0-7]/.test(src[i + 1] || '')) {
        j = i;
        while (j < src.length && /[0-7]/.test(src[j])) j++;
        val = parseInt(src.slice(i, j), 8);
      } else {
        while (j < src.length && /\d/.test(src[j])) j++;
        val = parseInt(src.slice(i, j), 10);
      }
      tokens.push({ type: 'num', val: Number.isFinite(val) ? val : 0 });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) j++;
      tokens.push({ type: 'var', val: src.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '$') {
      // POSIX: `$var` inside arith is just `var` — the $ is optional.
      let j = i + 1;
      while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) j++;
      if (j === i + 1) throw new Error('arith: lone $');
      tokens.push({ type: 'var', val: src.slice(i + 1, j) });
      i = j;
      continue;
    }
    let matched = null;
    for (const op of _ARITH_OPS) {
      if (src.startsWith(op, i)) { matched = op; break; }
    }
    if (matched) {
      tokens.push({ type: 'op', val: matched });
      i += matched.length;
      continue;
    }
    throw new Error(`arith: unexpected char "${ch}"`);
  }
  return tokens;
}

function _arithLookup(name, ctx) {
  if (!ctx.env.has(name)) return 0;
  const v = ctx.env.get(name);
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? (n | 0) : 0;
}

const _ARITH_ASSIGN_OPS = new Set([
  '=', '+=', '-=', '*=', '/=', '%=', '|=', '&=', '^=', '<<=', '>>=',
]);

// Assignment is right-associative. We peek for `var <assign-op>` and
// take the assignment branch only when both fit; otherwise fall through
// to the ternary level.
function _arithAssign(state, ctx) {
  const t = state.tokens[state.i];
  const next = state.tokens[state.i + 1];
  if (t && t.type === 'var' && next && next.type === 'op' && _ARITH_ASSIGN_OPS.has(next.val)) {
    const name = t.val;
    const op = next.val;
    state.i += 2;
    const rhs = _arithAssign(state, ctx);
    let val;
    if (op === '=') {
      val = rhs;
    } else {
      const cur = _arithLookup(name, ctx);
      switch (op) {
        case '+=':  val = (cur + rhs) | 0; break;
        case '-=':  val = (cur - rhs) | 0; break;
        case '*=':  val = (cur * rhs) | 0; break;
        case '/=':  val = rhs === 0 ? 0 : (Math.trunc(cur / rhs) | 0); break;
        case '%=':  val = rhs === 0 ? 0 : (cur % rhs) | 0; break;
        case '|=':  val = (cur | rhs) | 0; break;
        case '&=':  val = (cur & rhs) | 0; break;
        case '^=':  val = (cur ^ rhs) | 0; break;
        case '<<=': val = (cur << rhs) | 0; break;
        case '>>=': val = (cur >> rhs) | 0; break;
      }
    }
    val = val | 0;
    ctx.env.set(name, String(val));
    return val;
  }
  return _arithTernary(state, ctx);
}

function _arithTernary(state, ctx) {
  const cond = _arithLogicalOr(state, ctx);
  const t = state.tokens[state.i];
  if (t && t.val === '?') {
    state.i++;
    const ifTrue = _arithAssign(state, ctx);
    const colon = state.tokens[state.i];
    if (!colon || colon.val !== ':') throw new Error("arith: expected ':'");
    state.i++;
    const ifFalse = _arithAssign(state, ctx);
    return cond !== 0 ? ifTrue : ifFalse;
  }
  return cond;
}

function _arithLogicalOr(state, ctx) {
  let left = _arithLogicalAnd(state, ctx);
  while (state.tokens[state.i] && state.tokens[state.i].val === '||') {
    state.i++;
    const right = _arithLogicalAnd(state, ctx);
    left = (left !== 0 || right !== 0) ? 1 : 0;
  }
  return left;
}

function _arithLogicalAnd(state, ctx) {
  let left = _arithBitOr(state, ctx);
  while (state.tokens[state.i] && state.tokens[state.i].val === '&&') {
    state.i++;
    const right = _arithBitOr(state, ctx);
    left = (left !== 0 && right !== 0) ? 1 : 0;
  }
  return left;
}

function _arithBitOr(state, ctx) {
  let left = _arithBitXor(state, ctx);
  while (state.tokens[state.i] && state.tokens[state.i].val === '|') {
    state.i++;
    left = (left | _arithBitXor(state, ctx)) | 0;
  }
  return left;
}

function _arithBitXor(state, ctx) {
  let left = _arithBitAnd(state, ctx);
  while (state.tokens[state.i] && state.tokens[state.i].val === '^') {
    state.i++;
    left = (left ^ _arithBitAnd(state, ctx)) | 0;
  }
  return left;
}

function _arithBitAnd(state, ctx) {
  let left = _arithEq(state, ctx);
  while (state.tokens[state.i] && state.tokens[state.i].val === '&') {
    state.i++;
    left = (left & _arithEq(state, ctx)) | 0;
  }
  return left;
}

function _arithEq(state, ctx) {
  let left = _arithCmp(state, ctx);
  while (state.tokens[state.i] && (state.tokens[state.i].val === '==' || state.tokens[state.i].val === '!=')) {
    const op = state.tokens[state.i].val;
    state.i++;
    const right = _arithCmp(state, ctx);
    left = (op === '==' ? left === right : left !== right) ? 1 : 0;
  }
  return left;
}

function _arithCmp(state, ctx) {
  let left = _arithShift(state, ctx);
  while (state.tokens[state.i] && ['<', '<=', '>', '>='].includes(state.tokens[state.i].val)) {
    const op = state.tokens[state.i].val;
    state.i++;
    const right = _arithShift(state, ctx);
    let r;
    switch (op) {
      case '<':  r = left <  right; break;
      case '<=': r = left <= right; break;
      case '>':  r = left >  right; break;
      case '>=': r = left >= right; break;
    }
    left = r ? 1 : 0;
  }
  return left;
}

function _arithShift(state, ctx) {
  let left = _arithAdd(state, ctx);
  while (state.tokens[state.i] && (state.tokens[state.i].val === '<<' || state.tokens[state.i].val === '>>')) {
    const op = state.tokens[state.i].val;
    state.i++;
    const right = _arithAdd(state, ctx);
    left = (op === '<<' ? left << right : left >> right) | 0;
  }
  return left;
}

function _arithAdd(state, ctx) {
  let left = _arithMul(state, ctx);
  while (state.tokens[state.i] && (state.tokens[state.i].val === '+' || state.tokens[state.i].val === '-')) {
    const op = state.tokens[state.i].val;
    state.i++;
    const right = _arithMul(state, ctx);
    left = (op === '+' ? left + right : left - right) | 0;
  }
  return left;
}

function _arithMul(state, ctx) {
  let left = _arithUnary(state, ctx);
  while (state.tokens[state.i] && ['*', '/', '%'].includes(state.tokens[state.i].val)) {
    const op = state.tokens[state.i].val;
    state.i++;
    const right = _arithUnary(state, ctx);
    if ((op === '/' || op === '%') && right === 0) return 0;
    let r;
    switch (op) {
      case '*': r = left * right; break;
      case '/': r = Math.trunc(left / right); break;
      case '%': r = left % right; break;
    }
    left = r | 0;
  }
  return left;
}

function _arithUnary(state, ctx) {
  const t = state.tokens[state.i];
  if (t && t.type === 'op') {
    if (t.val === '-') { state.i++; return (-_arithUnary(state, ctx)) | 0; }
    if (t.val === '+') { state.i++; return _arithUnary(state, ctx); }
    if (t.val === '!') { state.i++; return _arithUnary(state, ctx) === 0 ? 1 : 0; }
    if (t.val === '~') { state.i++; return (~_arithUnary(state, ctx)) | 0; }
  }
  return _arithPrimary(state, ctx);
}

function _arithPrimary(state, ctx) {
  const t = state.tokens[state.i];
  if (!t) throw new Error('arith: unexpected end');
  if (t.type === 'num') { state.i++; return t.val | 0; }
  if (t.type === 'var') { state.i++; return _arithLookup(t.val, ctx); }
  if (t.type === 'op' && t.val === '(') {
    state.i++;
    const r = _arithAssign(state, ctx);
    const close = state.tokens[state.i];
    if (!close || close.val !== ')') throw new Error("arith: expected ')'");
    state.i++;
    return r;
  }
  throw new Error(`arith: unexpected token "${t.val}"`);
}

// Expand $vars and $(cmd) inside a raw string (for here-doc bodies that
// weren't quoted). Reuses parseWordParts to get structure.
async function _expandTextString(text, ctx) {
  const { parseWordParts } = await import('./word-parts.js');
  const parts = parseWordParts(text);
  let out = '';
  for (const p of parts) out += await _expandPart(p, ctx);
  return out;
}

// ── glob matching (for case patterns) ──

function _globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else if (ch === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close < 0) { re += '\\['; }
      else {
        let cls = pattern.slice(i + 1, close);
        if (cls.startsWith('!')) cls = '^' + cls.slice(1);
        re += '[' + cls + ']';
        i = close;
      }
    }
    else if ('.+^$()|\\'.includes(ch)) re += '\\' + ch;
    else re += ch;
  }
  return new RegExp(re);
}

function _globMatch(pattern, value) {
  const re = new RegExp('^(' + _globToRegExp(pattern).source + ')$');
  return re.test(value);
}
