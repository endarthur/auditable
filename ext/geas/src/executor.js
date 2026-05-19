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
    // Internal signal markers — thrown by `break`/`continue`/`return`/`exit`.
    // Exposed on ctx so builtins can throw them too.
    _BREAK:     ctx._BREAK ?? Symbol.for('geas:break'),
    _CONTINUE:  ctx._CONTINUE ?? Symbol.for('geas:continue'),
    _RETURN:    ctx._RETURN ?? Symbol.for('geas:return'),
    _EXIT:      ctx._EXIT ?? Symbol.for('geas:exit'),
  };
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
    }
  } catch (e) {
    // `exit` builtin throws { exitCode, _exit: true }; catch here to stop
    // running subsequent top-level commands.
    if (e && e._exit) return { exitCode: e.exitCode };
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
    // v0: `&` runs synchronously, same as `;`.
  }
  return { exitCode };
}

async function _execAndOr(node, ctx) {
  const left = await _exec(node.left, ctx);
  ctx.lastStatus = left.exitCode;
  if (node.op === '&&' && left.exitCode !== 0) return left;
  if (node.op === '||' && left.exitCode === 0) return left;
  const right = await _exec(node.right, ctx);
  ctx.lastStatus = right.exitCode;
  return right;
}

// ── pipelines ──

async function _execPipeline(node, ctx) {
  if (node.commands.length === 1) {
    const r = await _exec(node.commands[0], ctx);
    let exitCode = r.exitCode;
    if (node.negated) exitCode = exitCode === 0 ? 1 : 0;
    return { exitCode };
  }

  // v0: buffered pipes. Each stage runs to completion, its stdout collected
  // into a string that becomes the next stage's stdin. Streaming pipes are
  // a v1+ concern.
  let pipeIn = ctx.stdin;
  let lastExit = 0;
  for (let i = 0; i < node.commands.length; i++) {
    const isLast = i === node.commands.length - 1;
    let bufOut = [];
    const subCtx = {
      ...ctx,
      stdin: pipeIn,
      stdout: isLast ? ctx.stdout : (text) => { bufOut.push(text); },
    };
    const r = await _exec(node.commands[i], subCtx);
    lastExit = r.exitCode;
    if (!isLast) pipeIn = bufOut.join('');
  }
  if (node.negated) lastExit = lastExit === 0 ? 1 : 0;
  return { exitCode: lastExit };
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
    subCtx = { ...ctx };
    if (assignmentBindings.length > 0) {
      subCtx.env = new Map(ctx.env);
      for (const [n, v] of assignmentBindings) subCtx.env.set(n, v);
    }
    await _applyRedirects(node.redirects, subCtx);
  }

  // 3. Expand command name + args.
  const argv = [];
  for (const w of node.words) {
    const expanded = await _expandWord(w, subCtx);
    argv.push(expanded);
  }
  const cmdName = argv[0];

  // 4. Dispatch.
  let exitCode = 127;
  try {
    if (ctx.builtins.has(cmdName)) {
      const r = await ctx.builtins.get(cmdName)(argv, subCtx);
      exitCode = typeof r === 'number' ? r : 0;
    } else if (ctx.functions.has(cmdName)) {
      // Functions: execute the body in a context with $1..$N bound. v0
      // doesn't do full call-frame isolation — just runs the body with
      // positional params overlaid.
      const fnBody = ctx.functions.get(cmdName).body;
      const r = await _exec(fnBody, subCtx);
      exitCode = r.exitCode;
    } else {
      exitCode = await ctx.onCommand(cmdName, argv, subCtx);
    }
  } catch (e) {
    // The `exit` builtin throws { exitCode, _exit: true } to signal full
    // script termination — re-throw so _execProgram catches it instead of
    // smoothing it over into a normal exit code. Plain { exitCode } throws
    // (no _exit marker) are treated as the command's exit code.
    if (e && e._exit) throw e;
    if (e && typeof e.exitCode === 'number') exitCode = e.exitCode;
    else throw e;
  }
  ctx.lastStatus = exitCode;
  return { exitCode };
}

// ── compound commands ──

async function _execIf(node, ctx) {
  const cond = await _exec(node.cond, ctx);
  if (cond.exitCode === 0) return await _exec(node.then, ctx);
  for (const elif of node.elifs) {
    const c = await _exec(elif.cond, ctx);
    if (c.exitCode === 0) return await _exec(elif.then, ctx);
  }
  if (node.else) return await _exec(node.else, ctx);
  return { exitCode: 0 };
}

async function _execFor(node, ctx) {
  // POSIX: `for x` (no `in`) iterates over "$@" — the positional params.
  // v0 doesn't have positional params plumbed through; treat as no-op
  // iteration in that case.
  const values = node.words
    ? await Promise.all(node.words.map(w => _expandWord(w, ctx)))
    : [];
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
}

async function _execWhile(node, ctx) {
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
    const cond = await _exec(node.cond, ctx);
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
}

async function _execUntil(node, ctx) {
  let exitCode = 0;
  const maxIters = ctx.maxWhileIters ?? 1_000_000;
  let n = 0;
  while (true) {
    if (++n > maxIters) {
      throw new Error(`geas: until-loop exceeded ${maxIters} iterations`);
    }
    const cond = await _exec(node.cond, ctx);
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
}

async function _execCase(node, ctx) {
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
}

async function _execBraceGroup(node, ctx) {
  const subCtx = { ...ctx };
  await _applyRedirects(node.redirects, subCtx);
  return await _exec(node.body, subCtx);
}

async function _execSubshell(node, ctx) {
  // POSIX: subshells run in a copy of the parent's environment so
  // mutations don't leak out. v0 approximates by giving a shallow copy
  // of env + cwd. Function definitions and lastStatus reset semantics
  // are deferred until there's a need.
  const subCtx = { ...ctx, env: new Map(ctx.env) };
  await _applyRedirects(node.redirects, subCtx);
  return await _exec(node.body, subCtx);
}

function _execFunctionDef(node, ctx) {
  ctx.functions.set(node.name, node);
  return { exitCode: 0 };
}

// ── redirects ──

async function _applyRedirects(redirects, ctx) {
  if (!redirects || redirects.length === 0) return;
  for (const r of redirects) {
    const target = await _expandWord(r.target, ctx);
    switch (r.op) {
      case '>':
      case '>|': {
        _requireVfs(ctx, 'redirect >');
        const path = _resolvePath(target, ctx);
        const chunks = [];
        ctx.stdout = (text) => { chunks.push(String(text)); };
        // Flush on next tick? No — POSIX: a write redirect truncates first
        // then writes as the command produces. We can't easily intercept
        // post-execution finalisation here, so buffer everything and write
        // on the next applied redirect's overwrite. The caller is expected
        // to await the command's completion before observing the file.
        // v0 compromise: write everything at the end of the command via a
        // commit hook. For now, we use a setter that writes immediately on
        // each call, opening in truncate mode on first call:
        let firstWrite = true;
        ctx.stdout = async (text) => {
          if (firstWrite) {
            await ctx.vfs.writeFile(path, String(text));
            firstWrite = false;
          } else {
            // Append. Real POSIX would keep the fd open; we read+rewrite.
            // Inefficient but simple for v0.
            let prior;
            try { prior = await ctx.vfs.readFile(path, 'text'); } catch { prior = ''; }
            await ctx.vfs.writeFile(path, prior + String(text));
          }
        };
        break;
      }
      case '>>': {
        _requireVfs(ctx, 'redirect >>');
        const path = _resolvePath(target, ctx);
        ctx.stdout = async (text) => {
          let prior;
          try { prior = await ctx.vfs.readFile(path, 'text'); } catch { prior = ''; }
          await ctx.vfs.writeFile(path, prior + String(text));
        };
        break;
      }
      case '<': {
        _requireVfs(ctx, 'redirect <');
        const path = _resolvePath(target, ctx);
        ctx.stdin = await ctx.vfs.readFile(path, 'text');
        break;
      }
      case '<<':
      case '<<-': {
        // Here-doc body was attached at parse time.
        let body = r.body ?? '';
        if (!r.bodyQuoted) {
          // Expand $vars and $(cmd) in body text.
          body = await _expandTextString(body, ctx);
        }
        ctx.stdin = body;
        break;
      }
      // For 2>, 2>&1, etc., fd-targeted redirects:
      default: {
        if (r.op === '>' && r.fd === 2) {
          // (Handled above when r.fd is null; here for fd=2)
        }
        if (r.op === '>' || r.op === '>|') {
          if (r.fd === 2) {
            _requireVfs(ctx, 'redirect 2>');
            const path = _resolvePath(target, ctx);
            ctx.stderr = async (text) => { await ctx.vfs.writeFile(path, String(text)); };
          }
        }
        if (r.op === '>&' || r.op === '<&') {
          // Duplicate fd. `2>&1` is the common case (stderr → stdout).
          if (r.fd === 2 && target === '1') ctx.stderr = ctx.stdout;
          if (r.fd === 1 && target === '2') ctx.stdout = ctx.stderr;
          // Other dup combinations are rare; skip for v0.
        }
      }
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

export async function _expandWord(word, ctx) {
  if (!word || !word.parts) return word?.value ?? '';
  let out = '';
  for (const part of word.parts) {
    out += await _expandPart(part, ctx);
  }
  return out;
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
  return ctx.env.get(name) ?? '';
}

async function _expandParam(part, ctx) {
  const set = ctx.env.has(part.name);
  const val = set ? ctx.env.get(part.name) : '';
  const isNull = !val;
  switch (part.op) {
    case '#':  return String(val.length);
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
    // Prefix/suffix removal — v0 implements basic literal-only matching.
    case '#':
    case '##':
    case '%':
    case '%%': {
      const pat = part.word ? await _expandWord(part.word, ctx) : '';
      return _patternRemove(val, pat, part.op);
    }
    default: return val;
  }
}

function _patternRemove(s, pat, op) {
  // Convert POSIX glob to regex anchored at start (# / ##) or end (% / %%).
  const re = _globToRegExp(pat);
  if (op === '#') {
    const m = s.match(new RegExp('^' + re.source));
    if (!m) return s;
    // Shortest match: try progressively longer until one fits, take the first.
    // Simpler approach: lazy regex.
    const lazy = new RegExp('^(' + re.source + '?)');
    const mm = s.match(lazy);
    return mm ? s.slice(mm[0].length) : s;
  }
  if (op === '##') {
    const greedy = new RegExp('^(' + re.source + ')');
    const m = s.match(greedy);
    return m ? s.slice(m[0].length) : s;
  }
  if (op === '%') {
    // Suffix shortest: scan from end forward, find shortest match.
    for (let i = s.length; i >= 0; i--) {
      const suffix = s.slice(i);
      if (new RegExp('^' + re.source + '$').test(suffix)) return s.slice(0, i);
    }
    return s;
  }
  if (op === '%%') {
    // Suffix longest: scan from start, find longest match.
    for (let i = 0; i <= s.length; i++) {
      const suffix = s.slice(i);
      if (new RegExp('^' + re.source + '$').test(suffix)) return s.slice(0, i);
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

function _evalArith(body, ctx) {
  // v0: very basic. Substitute $vars and bare names → values, then eval as
  // JS expression. POSIX arith is a separate sub-language; full impl later.
  let src = body;
  src = src.replace(/\$([a-zA-Z_]\w*)/g, (_, n) => ctx.env.get(n) ?? '0');
  src = src.replace(/\b([a-zA-Z_]\w*)\b/g, (m, n) => {
    // Bare names also get var-substituted in arith context.
    return ctx.env.get(n) ?? '0';
  });
  // Restrict to digits / operators / parens / whitespace before eval'ing.
  if (!/^[\d\s+\-*/%()<>=!&|^~]+$/.test(src)) return '0';
  try { return String(Number(eval(src)) | 0); } catch { return '0'; }
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
