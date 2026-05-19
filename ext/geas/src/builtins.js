// Default built-ins for geas. Each is `async (argv, ctx) => exitCode`.
//
// The shell ships with a small POSIX-shape set covering the everyday
// operations a notebook user reaches for: I/O glue (echo, cat), navigation
// (pwd, cd, ls), env management (env, export, exit, :), and conditionals
// (test / [). More complete coverage lives in `@gcu/coreutils` (separate
// package, dispatched via ctx.onCommand when geas doesn't recognise a name).
//
// Built-ins MUST read input from ctx.stdin (a string in v0) and write
// output through `await ctx.stdout(...)` / `ctx.stderr(...)` rather than
// any other channel — that's how pipeline routing reaches them.

import { defaultTypedBuiltins } from './builtins-typed.js';
import { drainInput } from './typed.js';

// Construct a fresh map of the default builtins. Returns a new Map per call
// so consumers can mutate (add/override) without affecting other shells.
export function defaultBuiltins() {
  return new Map(Object.entries({
    ...defaultTypedBuiltins(),
    ':':      _colon,
    echo:     _echo,
    printf:   _printf,
    true:     _true,
    false:    _false,
    pwd:      _pwd,
    cd:       _cd,
    env:      _env,
    export:   _export,
    exit:     _exit,
    set:      _set,
    read:     _read,
    which:    _which,
    command:  _command,
    local:    _local,
    return:   _return,
    shift:    _shift,
    cat:      _cat,
    ls:       _ls,
    test:     _test,
    '[':      _testBracket,
    // Generators
    seq:      _seq,
    sleep:    _sleep,
    date:     _date,
    // Filesystem
    mkdir:    _mkdir,
    rm:       _rm,
    touch:    _touch,
    cp:       _cp,
    mv:       _mv,
    stat:     _stat,
    find:     _find,
    // Text wranglers
    head:     _head,
    tail:     _tail,
    wc:       _wc,
    grep:     _grep,
    sort:     _sort,
    uniq:     _uniq,
    cut:      _cut,
    tee:      _tee,
    xargs:    _xargs,
  }));
}

// ── individual builtins ──

async function _colon() { return 0; }

async function _echo(argv, ctx) {
  const args = argv.slice(1);
  let newline = true;
  let interpret = false;
  // `-n` no trailing newline; `-e` enable backslash interpretation
  // (bash default off); `-E` explicitly off. Flag combos like `-ne`
  // accepted. Anything else is treated as a positional argument.
  while (args.length && /^-[neE]+$/.test(args[0])) {
    if (args[0].includes('n')) newline = false;
    if (args[0].includes('e')) interpret = true;
    if (args[0].includes('E')) interpret = false;
    args.shift();
  }
  let text = args.join(' ');
  if (interpret) text = _printfBackslashArg(text);
  await ctx.stdout(text + (newline ? '\n' : ''));
  return 0;
}

async function _true() { return 0; }
async function _false() { return 1; }

async function _pwd(_argv, ctx) {
  await ctx.stdout((ctx.cwd || '/') + '\n');
  return 0;
}

async function _cd(argv, ctx) {
  let target = argv[1];
  if (!target || target === '~') {
    target = ctx.env.get('HOME') || '/';
  } else if (target === '-') {
    target = ctx.env.get('OLDPWD');
    if (!target) {
      await ctx.stderr('cd: OLDPWD not set\n');
      return 1;
    }
    await ctx.stdout(target + '\n');
  } else if (target.startsWith('~/')) {
    target = (ctx.env.get('HOME') || '') + target.slice(1);
  }
  // Make absolute via the existing cwd if needed.
  if (!target.startsWith('/')) {
    const base = ctx.cwd.endsWith('/') ? ctx.cwd : ctx.cwd + '/';
    target = base + target;
  }
  // Normalise simple `..` / `.` segments.
  target = _bNormalizePath(target);
  // Verify target exists if we have a VFS (otherwise trust the caller).
  if (ctx.vfs) {
    try {
      const st = await ctx.vfs.stat(target);
      if (st && st.type !== 'directory') {
        await ctx.stderr(`cd: not a directory: ${target}\n`);
        return 1;
      }
    } catch {
      await ctx.stderr(`cd: no such directory: ${target}\n`);
      return 1;
    }
  }
  ctx.env.set('OLDPWD', ctx.cwd);
  ctx.cwd = target;
  ctx.env.set('PWD', target);
  return 0;
}

async function _env(argv, ctx) {
  // `env` with no args lists the environment.
  // `env NAME=value... cmd args...` runs cmd with overlaid env (v0: just
  // sets in current env; no "run" semantics).
  const overlays = [];
  let i = 1;
  while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i])) {
    overlays.push(argv[i]);
    i++;
  }
  if (overlays.length === 0 && i >= argv.length) {
    // List.
    for (const [k, v] of ctx.env) {
      await ctx.stdout(`${k}=${v}\n`);
    }
    return 0;
  }
  // Apply overlays.
  for (const a of overlays) {
    const eq = a.indexOf('=');
    ctx.env.set(a.slice(0, eq), a.slice(eq + 1));
  }
  if (i < argv.length) {
    // env NAME=value cmd args… — run the remaining via the builtin lookup.
    const rest = argv.slice(i);
    const name = rest[0];
    if (ctx.builtins.has(name)) {
      return await ctx.builtins.get(name)(rest, ctx);
    }
    if (ctx.onCommand) {
      return await ctx.onCommand(name, rest, ctx);
    }
    await ctx.stderr(`env: ${name}: command not found\n`);
    return 127;
  }
  return 0;
}

async function _export(argv, ctx) {
  // `export NAME=value` — for v0 just sets in ctx.env (POSIX would mark
  // as "exportable to subprocesses"; we don't distinguish).
  // `export NAME` — marks an existing variable for export.
  // `export` (no args) — lists exported vars.
  if (argv.length === 1) {
    for (const [k, v] of ctx.env) await ctx.stdout(`export ${k}=${v}\n`);
    return 0;
  }
  for (const a of argv.slice(1)) {
    const eq = a.indexOf('=');
    if (eq >= 0) {
      ctx.env.set(a.slice(0, eq), a.slice(eq + 1));
    } else {
      // export of existing var — already in env, no-op
    }
  }
  return 0;
}

async function _exit(argv, _ctx) {
  const code = argv[1] !== undefined ? Number(argv[1]) : 0;
  // Thrown signal; _execProgram catches and stops the script.
  throw { exitCode: Number.isFinite(code) ? (code & 0xff) : 0, _exit: true };
}

async function _cat(argv, ctx) {
  const files = argv.slice(1);
  if (files.length === 0) {
    // No args: pipe stdin through. _bReadInput handles both string stdin
    // AND Typed stdin (via Typed.toString()), so a typed-pipe upstream
    // degrades gracefully.
    await ctx.stdout(await _bReadInput([], ctx));
    return 0;
  }
  if (!ctx.vfs) {
    await ctx.stderr('cat: no VFS configured\n');
    return 1;
  }
  let anyError = 0;
  for (const f of files) {
    const path = _bResolvePath(f, ctx);
    try {
      const text = await ctx.vfs.readFile(path, 'text');
      await ctx.stdout(text);
    } catch (e) {
      await ctx.stderr(`cat: ${f}: ${e.message || 'cannot read'}\n`);
      anyError = 1;
    }
  }
  return anyError;
}

async function _ls(argv, ctx) {
  if (!ctx.vfs) {
    await ctx.stderr('ls: no VFS configured\n');
    return 1;
  }
  // Parse args. v0 supports `-l` (long format) and `-a` (show dotfiles).
  let longFmt = false, showHidden = false;
  const paths = [];
  for (const a of argv.slice(1)) {
    if (a.startsWith('-') && a.length > 1 && !a.startsWith('--')) {
      if (a.includes('l')) longFmt = true;
      if (a.includes('a')) showHidden = true;
      continue;
    }
    paths.push(a);
  }
  if (paths.length === 0) paths.push(ctx.cwd || '/');

  let anyError = 0;
  for (let p of paths) {
    const path = _bResolvePath(p, ctx);
    try {
      const st = await ctx.vfs.stat(path);
      if (st.type === 'file') {
        await ctx.stdout(p + '\n');
        continue;
      }
      const entries = await ctx.vfs.readdir(path);
      const names = entries
        .map(e => typeof e === 'string' ? e : e.name)
        .filter(n => showHidden || !n.startsWith('.'))
        .sort();
      if (longFmt) {
        for (const n of names) {
          let line = n;
          try {
            const childPath = path.endsWith('/') ? path + n : path + '/' + n;
            const cst = await ctx.vfs.stat(childPath);
            const flag = cst.type === 'directory' ? 'd' : '-';
            const size = cst.size ?? 0;
            line = `${flag} ${String(size).padStart(8)}  ${n}`;
          } catch { /* fall through with bare name */ }
          await ctx.stdout(line + '\n');
        }
      } else {
        for (const n of names) await ctx.stdout(n + '\n');
      }
    } catch (e) {
      await ctx.stderr(`ls: ${p}: ${e.message || 'cannot access'}\n`);
      anyError = 1;
    }
  }
  return anyError;
}

// `test` / `[` — POSIX conditional. v0 covers the common operators; full
// POSIX-spec eval (including `-a` / `-o` / parens) is on the roadmap.
async function _testBracket(argv, ctx) {
  // The `[` builtin requires the last arg to be `]`. Strip it then defer.
  if (argv[argv.length - 1] !== ']') {
    await ctx.stderr('[: missing `]\'\n');
    return 2;
  }
  return await _test(argv.slice(0, -1), ctx);
}

// POSIX test grammar (precedence low → high):
//
//   expr      := or-expr
//   or-expr   := and-expr ( '-o' and-expr )*
//   and-expr  := not-expr ( '-a' not-expr )*
//   not-expr  := '!' not-expr | atom
//   atom      := '(' expr ')' | unary-atom | binary-atom | nonempty-atom
//
// Recursive descent. The compiled predicate is a `(ctx) → Promise<bool>`
// that the outer _test runs once, then translates bool → exit code
// (0 = true, 1 = false, 2 = parse error).
const _TEST_UNARY_OPS = new Set([
  '-z', '-n', '-e', '-f', '-d', '-s', '-r', '-w', '-x',
]);
const _TEST_BINARY_OPS = new Set([
  '=', '!=', '-eq', '-ne', '-lt', '-le', '-gt', '-ge',
]);

async function _test(argv, ctx) {
  const args = argv.slice(1);
  if (args.length === 0) return 1;
  // 1-arg fast path: true iff non-empty. Skipping the parser here lets
  // `[ ( ]` or `[ -a ]` etc. work as plain non-empty tests (POSIX-friendly
  // — single-arg test never invokes operator parsing).
  if (args.length === 1) return args[0].length > 0 ? 0 : 1;
  let predicate;
  try {
    predicate = _testCompile(args);
  } catch (e) {
    await ctx.stderr(`test: ${e.message}\n`);
    return 2;
  }
  try {
    const r = await predicate(ctx);
    return r ? 0 : 1;
  } catch (e) {
    await ctx.stderr(`test: ${e.message || e}\n`);
    return 2;
  }
}

function _testCompile(tokens) {
  const state = { tokens, i: 0 };
  const expr = _testParseOr(state);
  if (state.i !== tokens.length) {
    throw new Error(`unexpected token "${tokens[state.i]}"`);
  }
  return expr;
}

function _testParseOr(state) {
  let left = _testParseAnd(state);
  while (state.tokens[state.i] === '-o') {
    state.i++;
    const right = _testParseAnd(state);
    const l = left, r = right;
    left = async (ctx) => (await l(ctx)) || (await r(ctx));
  }
  return left;
}

function _testParseAnd(state) {
  let left = _testParseNot(state);
  while (state.tokens[state.i] === '-a') {
    state.i++;
    const right = _testParseNot(state);
    const l = left, r = right;
    left = async (ctx) => (await l(ctx)) && (await r(ctx));
  }
  return left;
}

function _testParseNot(state) {
  if (state.tokens[state.i] === '!') {
    state.i++;
    const inner = _testParseNot(state);
    return async (ctx) => !(await inner(ctx));
  }
  return _testParseAtom(state);
}

function _testParseAtom(state) {
  const t = state.tokens[state.i];
  if (t === undefined) throw new Error('missing operand');
  if (t === '(') {
    state.i++;
    const inner = _testParseOr(state);
    if (state.tokens[state.i] !== ')') throw new Error("missing ')'");
    state.i++;
    return inner;
  }
  // 3-arg binary atom: lookahead at i+1.
  const next = state.tokens[state.i + 1];
  if (next !== undefined && _TEST_BINARY_OPS.has(next)) {
    const a = state.tokens[state.i];
    const op = state.tokens[state.i + 1];
    const b = state.tokens[state.i + 2];
    if (b === undefined) throw new Error(`${op}: missing right operand`);
    state.i += 3;
    return async (ctx) => (await _testBinary(a, op, b, ctx)) === 0;
  }
  // 2-arg unary atom.
  if (_TEST_UNARY_OPS.has(t)) {
    const op = state.tokens[state.i];
    const val = state.tokens[state.i + 1];
    if (val === undefined) throw new Error(`${op}: missing argument`);
    state.i += 2;
    return async (ctx) => (await _testUnary(op, val, ctx)) === 0;
  }
  // 1-arg atom: true iff non-empty. Consumes one token regardless of
  // its content (so a bare `X` or `Y` inside a larger expr works).
  state.i++;
  return async () => t.length > 0;
}

async function _testUnary(op, val, ctx) {
  switch (op) {
    case '-z': return val.length === 0 ? 0 : 1;
    case '-n': return val.length > 0 ? 0 : 1;
    case '-e': case '-f': case '-d': case '-s': case '-r': case '-w': case '-x': {
      if (!ctx.vfs) return 1;
      try {
        const st = await ctx.vfs.stat(_bResolvePath(val, ctx));
        if (op === '-e' || op === '-r' || op === '-w' || op === '-x') return 0;
        if (op === '-f') return st.type === 'file' ? 0 : 1;
        if (op === '-d') return st.type === 'directory' ? 0 : 1;
        if (op === '-s') return (st.size ?? 0) > 0 ? 0 : 1;
      } catch { return 1; }
    }
    case '!': {
      // ! VAL — true iff VAL is empty
      return val.length === 0 ? 0 : 1;
    }
  }
  return 2;
}

async function _testBinary(a, op, b, _ctx) {
  switch (op) {
    case '=':   return a === b ? 0 : 1;
    case '!=':  return a !== b ? 0 : 1;
    case '-eq': return _num(a) === _num(b) ? 0 : 1;
    case '-ne': return _num(a) !== _num(b) ? 0 : 1;
    case '-lt': return _num(a) <   _num(b) ? 0 : 1;
    case '-le': return _num(a) <=  _num(b) ? 0 : 1;
    case '-gt': return _num(a) >   _num(b) ? 0 : 1;
    case '-ge': return _num(a) >=  _num(b) ? 0 : 1;
  }
  return 2;
}

function _num(x) { return Number(x); }

// ── helpers ──

function _bResolvePath(p, ctx) {
  if (p.startsWith('/')) return _bNormalizePath(p);
  const base = ctx.cwd && ctx.cwd.endsWith('/') ? ctx.cwd : (ctx.cwd || '/') + '/';
  return _bNormalizePath(base + p);
}

function _bNormalizePath(p) {
  const parts = p.split('/');
  const stack = [];
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (stack.length) stack.pop(); continue; }
    stack.push(seg);
  }
  return '/' + stack.join('/');
}

// Argv option parsing helper. Handles `-abc` (combined short flags),
// `-n VALUE` (option arg), `--` (end of options), `-` (stdin placeholder
// kept as a positional). Returns { opts, positionals }.
function _bParseArgs(argv, spec) {
  const opts = {};
  const positionals = [];
  for (const key of Object.keys(spec)) {
    opts[key] = spec[key].default ?? (spec[key].arg ? null : false);
  }
  let i = 1;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (a === '-' || !a.startsWith('-') || a.length === 1) {
      positionals.push(a);
      i++;
      continue;
    }
    // Multi-char short cluster: split each.
    const cluster = a.slice(1);
    let consumedNext = false;
    for (let k = 0; k < cluster.length; k++) {
      const ch = cluster[k];
      const matched = Object.keys(spec).find(name => spec[name].short === ch);
      if (!matched) {
        // Unknown flag — let the caller decide. Mark as positional and stop.
        positionals.push('-' + cluster.slice(k));
        break;
      }
      if (spec[matched].arg) {
        // Take the rest of the cluster as the value, or the next argv.
        const rest = cluster.slice(k + 1);
        if (rest.length > 0) { opts[matched] = rest; }
        else { opts[matched] = argv[i + 1]; consumedNext = true; }
        break;
      }
      opts[matched] = true;
    }
    i += consumedNext ? 2 : 1;
  }
  return { opts, positionals };
}

// Read all of stdin or, when paths are given, the concatenated contents
// of those VFS files. Common to head / tail / wc / grep / sort / uniq /
// cut / tee / xargs.
//
// Typed-pipe contract: if stdin drains to a Typed object, fall back to
// its text rendering via toString(). Builtins that don't know about
// types transparently get the canonical text representation.
async function _bReadInput(paths, ctx) {
  if (!paths || paths.length === 0) {
    const v = await drainInput(ctx);
    return typeof v === 'string' ? v : String(v);
  }
  if (!ctx.vfs) throw new Error('VFS not configured');
  const chunks = [];
  for (const p of paths) {
    chunks.push(await ctx.vfs.readFile(_bResolvePath(p, ctx), 'text'));
  }
  return chunks.join('');
}

// ── filesystem builtins ──

async function _mkdir(argv, ctx) {
  if (!ctx.vfs) { await ctx.stderr('mkdir: no VFS configured\n'); return 1; }
  const { opts, positionals } = _bParseArgs(argv, { p: { short: 'p' } });
  if (positionals.length === 0) {
    await ctx.stderr('mkdir: missing operand\n');
    return 1;
  }
  let anyError = 0;
  for (const p of positionals) {
    const path = _bResolvePath(p, ctx);
    try {
      await ctx.vfs.mkdir(path, opts.p ? { recursive: true } : undefined);
    } catch (e) {
      await ctx.stderr(`mkdir: ${p}: ${e.message || 'cannot create'}\n`);
      anyError = 1;
    }
  }
  return anyError;
}

async function _rm(argv, ctx) {
  if (!ctx.vfs) { await ctx.stderr('rm: no VFS configured\n'); return 1; }
  const { opts, positionals } = _bParseArgs(argv, {
    r: { short: 'r' }, f: { short: 'f' },
  });
  // POSIX combines -R into -r; bash accepts both. We honour either bit.
  const recursive = opts.r;
  const force = opts.f;
  if (positionals.length === 0 && !force) {
    await ctx.stderr('rm: missing operand\n');
    return 1;
  }
  let anyError = 0;
  for (const p of positionals) {
    const path = _bResolvePath(p, ctx);
    try {
      const st = await ctx.vfs.stat(path);
      if (st.type === 'directory') {
        if (!recursive) {
          await ctx.stderr(`rm: ${p}: is a directory\n`);
          anyError = 1;
          continue;
        }
        // Recursive delete: walk entries, unlink files, rmdir folders.
        await _rmRecursive(ctx.vfs, path);
      } else {
        await ctx.vfs.unlink(path);
      }
    } catch (e) {
      if (!force) {
        await ctx.stderr(`rm: ${p}: ${e.message || 'cannot remove'}\n`);
        anyError = 1;
      }
    }
  }
  return anyError;
}

async function _rmRecursive(vfs, dir) {
  const entries = await vfs.readdir(dir);
  for (const e of entries) {
    const name = typeof e === 'string' ? e : e.name;
    const child = dir.endsWith('/') ? dir + name : dir + '/' + name;
    const st = await vfs.stat(child);
    if (st.type === 'directory') await _rmRecursive(vfs, child);
    else await vfs.unlink(child);
  }
  await vfs.rmdir(dir);
}

// ── cp / mv / stat — thin wrappers over the VFS surface ──
//
// cp [-r] SRC... DST
//   Single SRC, DST is file → copy SRC's bytes to DST (overwrite ok).
//   Multiple SRC or DST is a directory → copy each SRC into DST/<basename>.
//   -r recurses through directory sources, recreating the tree.
//
// mv SRC... DST
//   Same destination rules as cp. Uses vfs.rename when source and dest
//   resolve to the same backend; falls back to copy-then-unlink across
//   backends (the VFS layer typically handles this transparently when
//   you call rename, so we lean on that and fall back only on error).
//
// stat PATH...
//   Prints type, size, and path. Default format is one line per file.
async function _cp(argv, ctx) {
  if (!ctx.vfs) { await ctx.stderr('cp: no VFS configured\n'); return 1; }
  const { opts, positionals } = _bParseArgs(argv, {
    r: { short: 'r' }, R: { short: 'R' }, f: { short: 'f' },
  });
  const recursive = opts.r || opts.R;
  if (positionals.length < 2) {
    await ctx.stderr('cp: missing operand (need SRC... DST)\n');
    return 1;
  }
  const dst = positionals[positionals.length - 1];
  const srcs = positionals.slice(0, -1);
  const dstPath = _bResolvePath(dst, ctx);
  let dstIsDir = false;
  try {
    const st = await ctx.vfs.stat(dstPath);
    dstIsDir = st.type === 'directory';
  } catch { /* dst doesn't exist; treat as a file target if single src */ }
  if (srcs.length > 1 && !dstIsDir) {
    await ctx.stderr(`cp: ${dst}: not a directory (need multi-source destination)\n`);
    return 1;
  }
  let anyError = 0;
  for (const src of srcs) {
    const srcPath = _bResolvePath(src, ctx);
    const target = dstIsDir
      ? _bJoinPath(dstPath, _bBasename(srcPath))
      : dstPath;
    try {
      await _cpEntry(ctx, srcPath, target, recursive);
    } catch (e) {
      await ctx.stderr(`cp: ${src}: ${e.message || 'cannot copy'}\n`);
      anyError = 1;
    }
  }
  return anyError;
}

async function _cpEntry(ctx, srcPath, dstPath, recursive) {
  const st = await ctx.vfs.stat(srcPath);
  if (st.type === 'directory') {
    if (!recursive) throw new Error('is a directory (use -r)');
    await ctx.vfs.mkdir(dstPath, { recursive: true });
    const entries = await ctx.vfs.readdir(srcPath);
    for (const e of entries) {
      const name = typeof e === 'string' ? e : e.name;
      await _cpEntry(ctx, _bJoinPath(srcPath, name), _bJoinPath(dstPath, name), recursive);
    }
    return;
  }
  // File: copy bytes. Try binary first, fall back to text if the
  // backend doesn't support a raw binary read (some don't).
  let content;
  try {
    content = await ctx.vfs.readFile(srcPath);
  } catch {
    content = await ctx.vfs.readFile(srcPath, 'text');
  }
  await ctx.vfs.writeFile(dstPath, content);
}

async function _mv(argv, ctx) {
  if (!ctx.vfs) { await ctx.stderr('mv: no VFS configured\n'); return 1; }
  const { positionals } = _bParseArgs(argv, {
    f: { short: 'f' }, n: { short: 'n' },
  });
  if (positionals.length < 2) {
    await ctx.stderr('mv: missing operand (need SRC... DST)\n');
    return 1;
  }
  const dst = positionals[positionals.length - 1];
  const srcs = positionals.slice(0, -1);
  const dstPath = _bResolvePath(dst, ctx);
  let dstIsDir = false;
  try {
    const st = await ctx.vfs.stat(dstPath);
    dstIsDir = st.type === 'directory';
  } catch { /* dst doesn't exist */ }
  if (srcs.length > 1 && !dstIsDir) {
    await ctx.stderr(`mv: ${dst}: not a directory (need multi-source destination)\n`);
    return 1;
  }
  let anyError = 0;
  for (const src of srcs) {
    const srcPath = _bResolvePath(src, ctx);
    const target = dstIsDir
      ? _bJoinPath(dstPath, _bBasename(srcPath))
      : dstPath;
    try {
      // VFS.rename handles same-backend moves natively and may also
      // handle cross-backend (some implementations do copy+unlink
      // internally). If it fails, fall back to recursive copy + remove.
      try {
        await ctx.vfs.rename(srcPath, target);
        continue;
      } catch { /* fall through to copy+unlink */ }
      await _cpEntry(ctx, srcPath, target, /*recursive*/ true);
      // Unlink source (recursive for directories).
      const st = await ctx.vfs.stat(srcPath);
      if (st.type === 'directory') await _rmRecursive(ctx.vfs, srcPath);
      else await ctx.vfs.unlink(srcPath);
    } catch (e) {
      await ctx.stderr(`mv: ${src}: ${e.message || 'cannot move'}\n`);
      anyError = 1;
    }
  }
  return anyError;
}

async function _stat(argv, ctx) {
  if (!ctx.vfs) { await ctx.stderr('stat: no VFS configured\n'); return 1; }
  const { opts, positionals } = _bParseArgs(argv, {
    c: { short: 'c', arg: true }, // -c FORMAT: a stripped-down strftime-like spec
  });
  if (positionals.length === 0) {
    await ctx.stderr('stat: missing operand\n');
    return 1;
  }
  let anyError = 0;
  for (const p of positionals) {
    const path = _bResolvePath(p, ctx);
    try {
      const st = await ctx.vfs.stat(path);
      const line = opts.c
        ? _statFormat(opts.c, st, p)
        : _statDefault(st, p);
      await ctx.stdout(line + '\n');
    } catch (e) {
      await ctx.stderr(`stat: ${p}: ${e.message || 'cannot stat'}\n`);
      anyError = 1;
    }
  }
  return anyError;
}

function _statDefault(st, displayPath) {
  // GNU stat prints a multi-line block; we use a single-line shape
  // that's friendlier to shell pipelines (still parseable). Format:
  //   "<type> <size> <path>"
  // type is one of 'file', 'directory', 'link' (when VFS exposes it).
  const type = st.type || 'unknown';
  const size = st.size ?? 0;
  return `${type.padEnd(9)} ${String(size).padStart(10)}  ${displayPath}`;
}

function _statFormat(fmt, st, displayPath) {
  // POSIX-ish format codes — a subset of GNU's `stat -c`:
  //   %n  filename
  //   %s  size in bytes
  //   %F  type ("regular file", "directory", ...)
  //   %y  mtime (when VFS exposes it; falls back to '-')
  //   %%  literal %
  return fmt.replace(/%./g, (m) => {
    switch (m) {
      case '%n': return displayPath;
      case '%s': return String(st.size ?? 0);
      case '%F': return st.type === 'directory' ? 'directory'
                       : st.type === 'file'      ? 'regular file'
                       : (st.type || 'unknown');
      case '%y': return st.mtime ?? '-';
      case '%%': return '%';
      default:   return m;
    }
  });
}

function _bJoinPath(a, b) {
  return a.endsWith('/') ? a + b : a + '/' + b;
}

function _bBasename(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

// ── find — recursive directory walk with predicates ──
//
// find [PATH...] [EXPR...]
//
// Walks each PATH (default: cwd), evaluates EXPR against every entry,
// prints matches one per line. Supported predicates:
//
//   -name PAT       basename glob (* ? [...])
//   -path PAT       full-path glob
//   -iname PAT      case-insensitive -name
//   -type f|d       file vs directory
//   -maxdepth N     don't descend beyond N levels (PATH itself is depth 0)
//   -mindepth N     skip entries shallower than N
//   -size [+-]N[ckMG]  size comparison (c=bytes, k=KiB, M=MiB, G=GiB; default c)
//   -empty          shorthand for `( -type f -size 0c ) -or ( -type d -empty-dir )`
//                   (v0: only the file case; empty directories not detected)
//   -print          explicit print (default action)
//   -print0         null-separated output (-exec scripts love it)
//
// Logical combinators (precedence: ! > -and > -or; -and is implicit):
//
//   ! EXPR | -not EXPR
//   EXPR -and EXPR | EXPR EXPR
//   EXPR -or EXPR
//   ( EXPR )       (each paren needs to be its own argv element)
//
// Notable v0 omissions: -exec, -execdir, -prune, -newer/-mtime, -user,
// regex predicates beyond glob. These are sized-by-need additions.
async function _find(argv, ctx) {
  if (!ctx.vfs) { await ctx.stderr('find: no VFS configured\n'); return 1; }
  // Split argv into start paths + predicate tokens. POSIX: paths come
  // first, predicates start at the first arg beginning with `-`, `!`,
  // `(`, or matching a known token. (We keep it simple — assume the
  // first arg starting with `-`/`!`/`(`/`,` is the predicate start.)
  const args = argv.slice(1);
  const paths = [];
  let predStart = 0;
  while (predStart < args.length) {
    const a = args[predStart];
    if (a.startsWith('-') || a === '!' || a === '(' || a === ')' || a === ',') break;
    paths.push(a);
    predStart++;
  }
  if (paths.length === 0) paths.push('.');
  const predTokens = args.slice(predStart);
  let predicate;
  try {
    predicate = _findCompile(predTokens);
  } catch (e) {
    await ctx.stderr(`find: ${e.message}\n`);
    return 1;
  }
  const sep = predicate.print0 ? '\0' : '\n';
  let anyError = 0;
  for (const startPath of paths) {
    const abs = _bResolvePath(startPath, ctx);
    try {
      const st = await ctx.vfs.stat(abs);
      await _findWalk({
        absPath: abs,
        displayPath: startPath,
        type: st.type,
        size: st.size ?? 0,
        depth: 0,
      }, predicate, ctx, sep);
    } catch (e) {
      await ctx.stderr(`find: ${startPath}: ${e.message || 'cannot access'}\n`);
      anyError = 1;
    }
  }
  return anyError;
}

async function _findWalk(entry, predicate, ctx, sep) {
  // Apply predicate to this entry. The compiled predicate is a function:
  //   (entry) => { match: bool, print: bool }
  // When `print` is true (explicit -print/-print0 in the expr, or the
  // default action because no print-equivalent appeared), we emit the
  // path. We do this BEFORE descending so directory output matches
  // POSIX find pre-order traversal.
  if (entry.depth >= predicate.minDepth) {
    const r = predicate.fn(entry);
    if (r) {
      await ctx.stdout(entry.displayPath + sep);
    }
  }
  if (entry.type !== 'directory') return;
  if (predicate.maxDepth >= 0 && entry.depth >= predicate.maxDepth) return;
  let names;
  try {
    const entries = await ctx.vfs.readdir(entry.absPath);
    names = entries.map(e => typeof e === 'string' ? e : e.name).sort();
  } catch {
    return;
  }
  for (const name of names) {
    const childAbs = entry.absPath.endsWith('/') ? entry.absPath + name : entry.absPath + '/' + name;
    const childDisp = entry.displayPath.endsWith('/') ? entry.displayPath + name : entry.displayPath + '/' + name;
    let stat;
    try { stat = await ctx.vfs.stat(childAbs); }
    catch { continue; }
    await _findWalk({
      absPath: childAbs,
      displayPath: childDisp,
      type: stat.type,
      size: stat.size ?? 0,
      depth: entry.depth + 1,
    }, predicate, ctx, sep);
  }
}

// Compile a predicate-token list into { fn, maxDepth, minDepth, print0 }.
// fn(entry) returns true iff the entry should be printed. maxDepth/
// minDepth/print0 are pulled out of the token stream rather than
// being encoded in fn — depth gates traversal, separators format output.
// An empty token list matches everything (POSIX `find .` behaviour).
function _findCompile(tokens) {
  const state = { tokens, i: 0, maxDepth: -1, minDepth: 0, print0: false };
  if (tokens.length === 0) {
    return { fn: () => true, maxDepth: -1, minDepth: 0, print0: false };
  }
  const fn = _findParseOr(state);
  if (state.i !== state.tokens.length) {
    throw new Error(`unexpected token "${state.tokens[state.i]}"`);
  }
  return {
    fn,
    maxDepth: state.maxDepth,
    minDepth: state.minDepth,
    print0: state.print0,
  };
}

// Grammar (recursive descent):
//   or   := and ( -or and )*
//   and  := not ( ( -and | <implicit> ) not )*
//   not  := ( '!' | -not ) not | primary
//   primary := '(' or ')' | predicate | action
function _findParseOr(s) {
  let left = _findParseAnd(s);
  while (s.i < s.tokens.length && (s.tokens[s.i] === '-or' || s.tokens[s.i] === '-o')) {
    s.i++;
    const right = _findParseAnd(s);
    const l = left, r = right;
    left = (e) => l(e) || r(e);
  }
  return left;
}

function _findParseAnd(s) {
  let left = _findParseNot(s);
  while (s.i < s.tokens.length) {
    const t = s.tokens[s.i];
    if (t === '-or' || t === '-o' || t === ')' || t === ',') break;
    if (t === '-and' || t === '-a') s.i++;
    const right = _findParseNot(s);
    const l = left, r = right;
    left = (e) => l(e) && r(e);
  }
  return left;
}

function _findParseNot(s) {
  const t = s.tokens[s.i];
  if (t === '!' || t === '-not') {
    s.i++;
    const inner = _findParseNot(s);
    return (e) => !inner(e);
  }
  return _findParsePrimary(s);
}

function _findParsePrimary(s) {
  const t = s.tokens[s.i];
  if (t === undefined) throw new Error('unexpected end of expression');
  if (t === '(') {
    s.i++;
    const inner = _findParseOr(s);
    if (s.tokens[s.i] !== ')') throw new Error("missing ')'");
    s.i++;
    return inner;
  }
  // Predicates & actions: each consumes its tokens and returns a
  // matcher. Actions set s.hadPrint when relevant.
  switch (t) {
    case '-name': {
      const pat = s.tokens[++s.i]; s.i++;
      const re = _findGlobToRe(pat, false);
      return (e) => re.test(_basename(e.displayPath));
    }
    case '-iname': {
      const pat = s.tokens[++s.i]; s.i++;
      const re = _findGlobToRe(pat, true);
      return (e) => re.test(_basename(e.displayPath));
    }
    case '-path': case '-wholename': {
      const pat = s.tokens[++s.i]; s.i++;
      const re = _findGlobToRe(pat, false);
      return (e) => re.test(e.displayPath);
    }
    case '-type': {
      const tp = s.tokens[++s.i]; s.i++;
      return (e) => (tp === 'f' && e.type === 'file') || (tp === 'd' && e.type === 'directory');
    }
    case '-size': {
      const spec = s.tokens[++s.i]; s.i++;
      const cmp = _findCompileSize(spec);
      return (e) => cmp(e.size);
    }
    case '-empty': {
      s.i++;
      return (e) => e.type === 'file' && e.size === 0;
    }
    case '-maxdepth': {
      s.maxDepth = parseInt(s.tokens[++s.i], 10); s.i++;
      return () => true;
    }
    case '-mindepth': {
      s.minDepth = parseInt(s.tokens[++s.i], 10); s.i++;
      return () => true;
    }
    case '-print': {
      s.i++;
      return () => true;
    }
    case '-print0': {
      s.i++;
      s.print0 = true;
      return () => true;
    }
    case '-true': { s.i++; return () => true; }
    case '-false': { s.i++; return () => false; }
    default:
      throw new Error(`unknown predicate "${t}"`);
  }
}

function _basename(p) {
  const slash = p.lastIndexOf('/');
  return slash < 0 ? p : p.slice(slash + 1);
}

function _findGlobToRe(pattern, ignoreCase) {
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
        if (cls.startsWith('!') || cls.startsWith('^')) cls = '^' + cls.slice(1);
        re += '[' + cls + ']';
        i = close;
      }
    }
    else if ('.+^$(){}|\\'.includes(ch)) re += '\\' + ch;
    else re += ch;
  }
  return new RegExp('^' + re + '$', ignoreCase ? 'i' : '');
}

function _findCompileSize(spec) {
  // POSIX -size spec: [+-]N[bckwMG]. We honour c (bytes), k (KiB),
  // M (MiB), G (GiB). Defaults to 512-byte blocks per POSIX, but we
  // diverge: default unit is bytes — matches everyone's mental model.
  const m = String(spec).match(/^([+-])?(\d+)([ckMG]?)$/);
  if (!m) return () => false;
  const sign = m[1];
  const n = parseInt(m[2], 10);
  const unit = m[3] || 'c';
  const mult = unit === 'k' ? 1024 : unit === 'M' ? 1024 * 1024 : unit === 'G' ? 1024 * 1024 * 1024 : 1;
  const threshold = n * mult;
  if (sign === '+') return (sz) => sz > threshold;
  if (sign === '-') return (sz) => sz < threshold;
  return (sz) => sz === threshold;
}

async function _touch(argv, ctx) {
  if (!ctx.vfs) { await ctx.stderr('touch: no VFS configured\n'); return 1; }
  const { positionals } = _bParseArgs(argv, { c: { short: 'c' } });
  if (positionals.length === 0) {
    await ctx.stderr('touch: missing operand\n');
    return 1;
  }
  let anyError = 0;
  for (const p of positionals) {
    const path = _bResolvePath(p, ctx);
    try {
      try { await ctx.vfs.stat(path); /* exists — POSIX would update mtime; v0 no-op */ }
      catch { await ctx.vfs.writeFile(path, ''); }
    } catch (e) {
      await ctx.stderr(`touch: ${p}: ${e.message || 'cannot touch'}\n`);
      anyError = 1;
    }
  }
  return anyError;
}

// ── text wranglers ──

async function _head(argv, ctx) {
  // BSD/GNU shorthand: `head -N` means `head -n N`. _bParseArgs has no
  // way to express "digit run is a flag value," so normalize first.
  const normalized = argv.map(a => /^-\d+$/.test(a) ? ['-n', a.slice(1)] : [a]).flat();
  const { opts, positionals } = _bParseArgs(normalized, { n: { short: 'n', arg: true, default: '10' } });
  const n = Math.max(0, parseInt(opts.n, 10) || 0);
  // Streaming path when reading from a pipe queue: pull chunks, emit
  // complete lines as they arrive, throw _pipeClosed back upstream once
  // we have N. This is what makes `find /huge | head -1` early-return
  // — upstream's next push sees a closed queue, bails, returns 0.
  const stdinIsQueue = positionals.length === 0
    && ctx.stdin
    && typeof ctx.stdin === 'object'
    && typeof ctx.stdin[Symbol.asyncIterator] === 'function';
  if (stdinIsQueue) {
    return await _headStream(ctx.stdin, n, ctx);
  }
  try {
    const text = await _bReadInput(positionals, ctx);
    const lines = text.split('\n');
    const trailingNL = text.endsWith('\n');
    const effective = trailingNL ? lines.slice(0, -1) : lines;
    const take = effective.slice(0, n);
    await ctx.stdout(take.join('\n') + (take.length > 0 ? '\n' : ''));
    return 0;
  } catch (e) {
    await ctx.stderr(`head: ${e.message}\n`);
    return 1;
  }
}

async function _headStream(queue, n, ctx) {
  let leftover = '';
  let emitted = 0;
  const out = [];
  try {
    for await (const chunk of queue) {
      const text = typeof chunk === 'string' ? chunk : String(chunk);
      const combined = leftover + text;
      const parts = combined.split('\n');
      leftover = parts.pop(); // tail without trailing \n stays in leftover
      for (const line of parts) {
        out.push(line);
        emitted++;
        if (emitted >= n) break;
      }
      if (emitted >= n) {
        // Close the queue so upstream's next push sees _pipeClosed.
        if (typeof queue.close === 'function') queue.close();
        break;
      }
    }
    if (emitted < n && leftover.length > 0) {
      out.push(leftover);
      emitted++;
    }
  } catch (e) {
    if (!e || !e._pipeClosed) {
      await ctx.stderr(`head: ${e.message || e}\n`);
      return 1;
    }
  }
  if (out.length > 0) await ctx.stdout(out.join('\n') + '\n');
  return 0;
}

async function _tail(argv, ctx) {
  const normalized = argv.map(a => /^-\d+$/.test(a) ? ['-n', a.slice(1)] : [a]).flat();
  const { opts, positionals } = _bParseArgs(normalized, { n: { short: 'n', arg: true, default: '10' } });
  const n = Math.max(0, parseInt(opts.n, 10) || 0);
  try {
    const text = await _bReadInput(positionals, ctx);
    const lines = text.split('\n');
    const trailingNL = text.endsWith('\n');
    const effective = trailingNL ? lines.slice(0, -1) : lines;
    const take = effective.slice(Math.max(0, effective.length - n));
    await ctx.stdout(take.join('\n') + (take.length > 0 ? '\n' : ''));
    return 0;
  } catch (e) {
    await ctx.stderr(`tail: ${e.message}\n`);
    return 1;
  }
}

async function _wc(argv, ctx) {
  const { opts, positionals } = _bParseArgs(argv, {
    l: { short: 'l' }, w: { short: 'w' }, c: { short: 'c' },
  });
  // Default (no flags) prints lines, words, bytes.
  const showAll = !opts.l && !opts.w && !opts.c;
  try {
    const text = await _bReadInput(positionals, ctx);
    const lines = text.endsWith('\n')
      ? text.split('\n').length - 1
      : (text.length === 0 ? 0 : text.split('\n').length);
    const words = text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
    const bytes = text.length;
    const parts = [];
    if (opts.l || showAll) parts.push(String(lines).padStart(8));
    if (opts.w || showAll) parts.push(String(words).padStart(8));
    if (opts.c || showAll) parts.push(String(bytes).padStart(8));
    await ctx.stdout(parts.join('') + '\n');
    return 0;
  } catch (e) {
    await ctx.stderr(`wc: ${e.message}\n`);
    return 1;
  }
}

async function _grep(argv, ctx) {
  const { opts, positionals } = _bParseArgs(argv, {
    i: { short: 'i' }, v: { short: 'v' }, n: { short: 'n' },
    F: { short: 'F' }, c: { short: 'c' },
  });
  if (positionals.length === 0) {
    await ctx.stderr('grep: missing pattern\n');
    return 2;
  }
  const pattern = positionals[0];
  const files = positionals.slice(1);
  let regex;
  try {
    regex = opts.F
      ? new RegExp(_escapeRe(pattern), opts.i ? 'i' : '')
      : new RegExp(pattern, opts.i ? 'i' : '');
  } catch (e) {
    await ctx.stderr(`grep: bad pattern: ${e.message}\n`);
    return 2;
  }
  try {
    const text = await _bReadInput(files, ctx);
    const lines = text.split('\n');
    const trailing = text.endsWith('\n');
    const effective = trailing ? lines.slice(0, -1) : lines;
    let count = 0;
    const out = [];
    for (let i = 0; i < effective.length; i++) {
      const line = effective[i];
      const matched = regex.test(line);
      if (opts.v ? !matched : matched) {
        count++;
        if (!opts.c) {
          out.push(opts.n ? `${i + 1}:${line}` : line);
        }
      }
    }
    if (opts.c) await ctx.stdout(`${count}\n`);
    else if (out.length > 0) await ctx.stdout(out.join('\n') + '\n');
    return count > 0 ? 0 : 1;
  } catch (e) {
    await ctx.stderr(`grep: ${e.message}\n`);
    return 2;
  }
}

function _escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function _sort(argv, ctx) {
  const { opts, positionals } = _bParseArgs(argv, {
    r: { short: 'r' }, n: { short: 'n' }, u: { short: 'u' },
  });
  try {
    const text = await _bReadInput(positionals, ctx);
    const trailing = text.endsWith('\n');
    let lines = (trailing ? text.slice(0, -1) : text).split('\n');
    if (opts.n) {
      lines.sort((a, b) => {
        const na = parseFloat(a), nb = parseFloat(b);
        if (Number.isNaN(na) && Number.isNaN(nb)) return a.localeCompare(b);
        if (Number.isNaN(na)) return -1;
        if (Number.isNaN(nb)) return 1;
        return na - nb;
      });
    } else {
      lines.sort();
    }
    if (opts.r) lines.reverse();
    if (opts.u) lines = [...new Set(lines)];
    await ctx.stdout(lines.join('\n') + (lines.length > 0 ? '\n' : ''));
    return 0;
  } catch (e) {
    await ctx.stderr(`sort: ${e.message}\n`);
    return 1;
  }
}

async function _uniq(argv, ctx) {
  const { opts, positionals } = _bParseArgs(argv, {
    c: { short: 'c' }, d: { short: 'd' }, u: { short: 'u' },
  });
  try {
    const text = await _bReadInput(positionals, ctx);
    const trailing = text.endsWith('\n');
    const lines = (trailing ? text.slice(0, -1) : text).split('\n');
    const out = [];
    let prev = null, runCount = 0;
    const emit = () => {
      if (prev === null) return;
      if (opts.d && runCount < 2) return;
      if (opts.u && runCount >= 2) return;
      if (opts.c) out.push(`${String(runCount).padStart(4)} ${prev}`);
      else out.push(prev);
    };
    for (const l of lines) {
      if (l === prev) { runCount++; continue; }
      emit();
      prev = l;
      runCount = 1;
    }
    emit();
    await ctx.stdout(out.join('\n') + (out.length > 0 ? '\n' : ''));
    return 0;
  } catch (e) {
    await ctx.stderr(`uniq: ${e.message}\n`);
    return 1;
  }
}

async function _cut(argv, ctx) {
  const { opts, positionals } = _bParseArgs(argv, {
    d: { short: 'd', arg: true, default: '\t' },
    f: { short: 'f', arg: true },
    c: { short: 'c', arg: true },
  });
  if (!opts.f && !opts.c) {
    await ctx.stderr('cut: must specify -f or -c\n');
    return 1;
  }
  const ranges = _parseRanges(opts.f || opts.c);
  try {
    const text = await _bReadInput(positionals, ctx);
    const trailing = text.endsWith('\n');
    const lines = (trailing ? text.slice(0, -1) : text).split('\n');
    const out = [];
    for (const line of lines) {
      if (opts.f) {
        const fields = line.split(opts.d);
        const picked = ranges.flatMap(([a, b]) => {
          const lo = Math.max(1, a) - 1;
          const hi = (b === Infinity ? fields.length : b);
          return fields.slice(lo, hi);
        });
        out.push(picked.join(opts.d));
      } else {
        const picked = ranges.flatMap(([a, b]) => {
          const lo = Math.max(1, a) - 1;
          const hi = (b === Infinity ? line.length : b);
          return [line.slice(lo, hi)];
        });
        out.push(picked.join(''));
      }
    }
    await ctx.stdout(out.join('\n') + (out.length > 0 ? '\n' : ''));
    return 0;
  } catch (e) {
    await ctx.stderr(`cut: ${e.message}\n`);
    return 1;
  }
}

// "1,3-5,7-" → [[1,1], [3,5], [7,Infinity]]
function _parseRanges(spec) {
  return spec.split(',').map(part => {
    if (part.includes('-')) {
      const [a, b] = part.split('-');
      return [
        a === '' ? 1 : parseInt(a, 10),
        b === '' ? Infinity : parseInt(b, 10),
      ];
    }
    const n = parseInt(part, 10);
    return [n, n];
  });
}

async function _tee(argv, ctx) {
  if (!ctx.vfs && argv.length > 1) {
    await ctx.stderr('tee: no VFS configured for file targets\n');
    return 1;
  }
  const { opts, positionals } = _bParseArgs(argv, { a: { short: 'a' } });
  // _bReadInput handles Typed stdin via toString fallback.
  const input = await _bReadInput([], ctx);
  await ctx.stdout(input);
  let anyError = 0;
  for (const p of positionals) {
    try {
      const path = _bResolvePath(p, ctx);
      if (opts.a) {
        let prior;
        try { prior = await ctx.vfs.readFile(path, 'text'); } catch { prior = ''; }
        await ctx.vfs.writeFile(path, prior + input);
      } else {
        await ctx.vfs.writeFile(path, input);
      }
    } catch (e) {
      await ctx.stderr(`tee: ${p}: ${e.message || 'cannot write'}\n`);
      anyError = 1;
    }
  }
  return anyError;
}

// ── set — shell options ──
//
// POSIX set covers two responsibilities: flipping shell options (`-e` /
// `-u` / `-o pipefail` / …) and rewriting the positional parameters
// (`set -- a b c` makes `$1=a $2=b $3=c`). With no arguments, lists
// environment variables (the POSIX behaviour; bash also includes shell
// variables — close enough for v0).
async function _set(argv, ctx) {
  if (!ctx.options) ctx.options = { errexit: false, nounset: false, pipefail: false, xtrace: false };
  const knownLong = { errexit: 'errexit', nounset: 'nounset', pipefail: 'pipefail', xtrace: 'xtrace' };
  const knownShort = { e: 'errexit', u: 'nounset', x: 'xtrace' };
  let i = 1;
  let resetPositional = false;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') { i++; resetPositional = true; break; }
    if (a === '-' || a === '+') { i++; continue; }
    if (a.startsWith('-o') || a.startsWith('+o')) {
      const off = a[0] === '+';
      let opt = a.length > 2 ? a.slice(2) : (argv[++i] || '');
      if (!opt) {
        // List: `set -o` prints each shell option's state.
        for (const k of Object.keys(knownLong)) {
          await ctx.stdout(`${k.padEnd(12)} ${ctx.options[k] ? 'on' : 'off'}\n`);
        }
        i++;
        continue;
      }
      if (!knownLong[opt]) {
        await ctx.stderr(`set: ${opt}: invalid option name\n`);
        return 2;
      }
      ctx.options[knownLong[opt]] = !off;
      i++;
      continue;
    }
    if ((a.startsWith('-') || a.startsWith('+')) && a.length > 1) {
      const off = a[0] === '+';
      for (let k = 1; k < a.length; k++) {
        const ch = a[k];
        if (!knownShort[ch]) {
          await ctx.stderr(`set: -${ch}: unknown option\n`);
          return 2;
        }
        ctx.options[knownShort[ch]] = !off;
      }
      i++;
      continue;
    }
    // First non-option argument: stop parsing flags and treat the rest
    // as positional parameters (POSIX-shape, even without an explicit `--`).
    resetPositional = true;
    break;
  }
  if (resetPositional) {
    ctx.positional = argv.slice(i);
    return 0;
  }
  if (argv.length === 1) {
    const keys = [...ctx.env.keys()].sort();
    for (const k of keys) await ctx.stdout(`${k}=${ctx.env.get(k)}\n`);
  }
  return 0;
}

// ── printf — POSIX format strings ──
//
// printf FORMAT [ARGS...]
//
// Supports %s %d %i %u %o %x %X %e %E %f %F %g %G %c %b %% — plus flags
// (- + space # 0), width (number), precision (.N). The format string is
// reused if there are extra args; if there are no specifiers in the
// format, it's printed once. Backslash escapes in the format are
// interpreted (\n \t \r \\ \a \b \f \v \xHH \0OOO).
async function _printf(argv, ctx) {
  if (argv.length < 2) {
    await ctx.stderr('printf: usage: printf format [arguments]\n');
    return 1;
  }
  const fmt = argv[1];
  const args = argv.slice(2);
  let out = '';
  let argIdx = 0;
  // Apply the format at least once. If specifiers consumed arguments and
  // more remain, reapply (POSIX "reuse" semantics). Guard against
  // formats with zero specifiers so we don't loop.
  let pass = 0;
  while (pass === 0 || argIdx < args.length) {
    const result = _printfApply(fmt, args, argIdx);
    out += result.text;
    pass++;
    if (result.consumed === 0) break;
    argIdx += result.consumed;
    if (pass > 10000) break; // belt-and-braces guard
  }
  await ctx.stdout(out);
  return 0;
}

function _printfApply(fmt, args, startIdx) {
  let out = '';
  let consumed = 0;
  let hadSpecifier = false;
  let i = 0;
  while (i < fmt.length) {
    const c = fmt[i];
    if (c === '\\' && i + 1 < fmt.length) {
      const r = _printfReadEscape(fmt, i);
      out += r.text;
      i = r.next;
      continue;
    }
    if (c === '%') {
      const spec = _printfParseSpec(fmt, i);
      if (spec.literal) { out += '%'; i = spec.end; continue; }
      hadSpecifier = true;
      const arg = args[startIdx + consumed];
      consumed++;
      out += _printfFormat(spec, arg);
      i = spec.end;
      continue;
    }
    out += c;
    i++;
  }
  return { text: out, consumed: hadSpecifier ? consumed : 0 };
}

function _printfReadEscape(fmt, i) {
  const next = fmt[i + 1];
  switch (next) {
    case 'n': return { text: '\n', next: i + 2 };
    case 't': return { text: '\t', next: i + 2 };
    case 'r': return { text: '\r', next: i + 2 };
    case '\\': return { text: '\\', next: i + 2 };
    case '"': return { text: '"', next: i + 2 };
    case "'": return { text: "'", next: i + 2 };
    case 'a': return { text: '\x07', next: i + 2 };
    case 'b': return { text: '\b', next: i + 2 };
    case 'f': return { text: '\f', next: i + 2 };
    case 'v': return { text: '\v', next: i + 2 };
    case '0': {
      let oct = '';
      let j = i + 2;
      while (oct.length < 3 && /[0-7]/.test(fmt[j] || '')) { oct += fmt[j]; j++; }
      return { text: String.fromCharCode(parseInt(oct || '0', 8)), next: j };
    }
    case 'x': {
      let hex = '';
      let j = i + 2;
      while (hex.length < 2 && /[0-9a-fA-F]/.test(fmt[j] || '')) { hex += fmt[j]; j++; }
      if (hex.length === 0) return { text: '\\x', next: j };
      return { text: String.fromCharCode(parseInt(hex, 16)), next: j };
    }
    default: return { text: '\\' + (next ?? ''), next: i + 2 };
  }
}

function _printfParseSpec(fmt, start) {
  let i = start + 1;
  if (fmt[i] === '%') return { literal: true, end: i + 1 };
  const flags = { left: false, plus: false, space: false, hash: false, zero: false };
  while (i < fmt.length && '-+ #0'.includes(fmt[i])) {
    if (fmt[i] === '-') flags.left = true;
    else if (fmt[i] === '+') flags.plus = true;
    else if (fmt[i] === ' ') flags.space = true;
    else if (fmt[i] === '#') flags.hash = true;
    else if (fmt[i] === '0') flags.zero = true;
    i++;
  }
  let width = -1;
  while (/[0-9]/.test(fmt[i] || '')) {
    width = width < 0 ? 0 : width;
    width = width * 10 + Number(fmt[i]);
    i++;
  }
  let precision = -1;
  if (fmt[i] === '.') {
    i++;
    precision = 0;
    while (/[0-9]/.test(fmt[i] || '')) {
      precision = precision * 10 + Number(fmt[i]);
      i++;
    }
  }
  const conv = fmt[i] || '';
  i++;
  return { literal: false, flags, width, precision, conv, end: i };
}

function _printfFormat(spec, rawArg) {
  const { flags, width, precision, conv } = spec;
  const arg = rawArg ?? '';
  let s;
  let isNumeric = true;
  switch (conv) {
    case 's': {
      s = String(arg);
      if (precision >= 0) s = s.slice(0, precision);
      isNumeric = false;
      break;
    }
    case 'b': {
      s = _printfBackslashArg(String(arg));
      if (precision >= 0) s = s.slice(0, precision);
      isNumeric = false;
      break;
    }
    case 'c': {
      s = String(arg).charAt(0);
      isNumeric = false;
      break;
    }
    case 'd': case 'i': {
      let n = parseInt(arg, 10);
      if (Number.isNaN(n)) n = 0;
      const neg = n < 0;
      let v = String(Math.abs(n));
      if (precision >= 0) v = v.padStart(precision, '0');
      if (neg) s = '-' + v;
      else if (flags.plus) s = '+' + v;
      else if (flags.space) s = ' ' + v;
      else s = v;
      break;
    }
    case 'u': {
      let n = parseInt(arg, 10);
      if (!Number.isFinite(n) || n < 0) n = 0;
      s = String(n);
      if (precision >= 0) s = s.padStart(precision, '0');
      break;
    }
    case 'o': {
      let n = parseInt(arg, 10);
      if (Number.isNaN(n)) n = 0;
      s = n.toString(8);
      if (flags.hash && s[0] !== '0') s = '0' + s;
      if (precision >= 0) s = s.padStart(precision, '0');
      break;
    }
    case 'x': case 'X': {
      let n = parseInt(arg, 10);
      if (Number.isNaN(n)) n = 0;
      s = n.toString(16);
      if (conv === 'X') s = s.toUpperCase();
      if (precision >= 0) s = s.padStart(precision, '0');
      if (flags.hash && n !== 0) s = (conv === 'X' ? '0X' : '0x') + s;
      break;
    }
    case 'e': case 'E': {
      let n = parseFloat(arg);
      if (Number.isNaN(n)) n = 0;
      const p = precision >= 0 ? precision : 6;
      s = n.toExponential(p);
      if (conv === 'E') s = s.toUpperCase();
      if (flags.plus && n >= 0) s = '+' + s;
      else if (flags.space && n >= 0) s = ' ' + s;
      break;
    }
    case 'f': case 'F': {
      let n = parseFloat(arg);
      if (Number.isNaN(n)) n = 0;
      const p = precision >= 0 ? precision : 6;
      s = n.toFixed(p);
      if (flags.plus && n >= 0) s = '+' + s;
      else if (flags.space && n >= 0) s = ' ' + s;
      break;
    }
    case 'g': case 'G': {
      let n = parseFloat(arg);
      if (Number.isNaN(n)) n = 0;
      const p = precision >= 0 ? (precision === 0 ? 1 : precision) : 6;
      s = n.toPrecision(p);
      if (conv === 'G') s = s.toUpperCase();
      break;
    }
    default: s = '%' + conv;
  }
  if (width > 0 && s.length < width) {
    const padCh = (flags.zero && !flags.left && isNumeric) ? '0' : ' ';
    if (flags.left) s = s.padEnd(width, ' ');
    else if (padCh === '0' && (s[0] === '-' || s[0] === '+' || s[0] === ' ')) {
      s = s[0] + s.slice(1).padStart(width - 1, '0');
    } else {
      s = s.padStart(width, padCh);
    }
  }
  return s;
}

function _printfBackslashArg(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const r = _printfReadEscape(s, i);
      out += r.text;
      i = r.next - 1;
    } else {
      out += s[i];
    }
  }
  return out;
}

// ── read — line input ──
//
// read [-r] [-p prompt] [-d delim] [-n nchars] [-s] [-t timeout] [VAR...]
//
// v0 reads a single line from ctx.stdin, splits on $IFS, and binds the
// resulting fields to the named variables (last var absorbs any trailing
// content). Without VARs, reads into $REPLY. `-r` skips backslash
// processing. `-p PROMPT` writes the prompt to stderr before reading.
// `-s`/`-n`/`-t`/`-d` are accepted for compatibility but not all honoured
// (they need an async input channel from the adapter — coming with the
// worker-side interactive read protocol).
async function _read(argv, ctx) {
  let raw = false, prompt = '';
  let nChars = -1;        // -n N: read at most N chars (default: full line)
  let delim = '\n';       // -d D: terminate on first char of D (bash uses D[0])
  let optS = false;       // -s: silent — passed to the interactive readLine hook
  let optT = null;        // -t SECONDS: timeout, also handled by the hook
  let i = 1;
  while (i < argv.length && argv[i].startsWith('-') && argv[i] !== '--' && argv[i].length > 1) {
    const flag = argv[i];
    if (flag === '-r') { raw = true; i++; continue; }
    if (flag === '-p') { prompt = argv[i + 1] ?? ''; i += 2; continue; }
    if (flag.startsWith('-p') && flag.length > 2) { prompt = flag.slice(2); i++; continue; }
    if (flag === '-s') { optS = true; i++; continue; }
    if (flag === '-n') {
      const n = parseInt(argv[i + 1], 10);
      if (!Number.isFinite(n) || n < 0) {
        await ctx.stderr(`read: -n: invalid count\n`);
        return 2;
      }
      nChars = n;
      i += 2;
      continue;
    }
    if (flag === '-d') {
      delim = argv[i + 1] ?? '\n';
      i += 2;
      continue;
    }
    if (flag === '-t') {
      const t = parseFloat(argv[i + 1]);
      if (!Number.isFinite(t) || t < 0) {
        await ctx.stderr(`read: -t: invalid timeout\n`);
        return 2;
      }
      optT = t;
      i += 2;
      continue;
    }
    if (flag === '--') { i++; break; }
    await ctx.stderr(`read: ${flag}: unknown option\n`);
    return 2;
  }
  const vars = argv.slice(i);
  const varNames = vars.length > 0 ? vars : ['REPLY'];
  // `read` is line-oriented and needs to mutate the consumed stdin. If
  // stdin arrived as a stream queue (from a pipeline), drain to text
  // first; subsequent `read` calls in the same command keep slicing
  // ctx.stdin string.
  if (typeof ctx.stdin !== 'string') {
    const v = await drainInput(ctx);
    ctx.stdin = typeof v === 'string' ? v : String(v);
  }
  // No stdin queued? Fall through to the interactive `readLine` hook
  // if the host wired one up — that's the path the worker shim uses
  // to bridge to the adapter's line editor (prompt, echo, backspace).
  // Without a hook, EOF is the only answer.
  if (ctx.stdin.length === 0) {
    if (typeof ctx.readLine !== 'function') {
      // Show prompt before reporting EOF — matches bash's `read -p P`
      // shape, which prints the prompt unconditionally.
      if (prompt) {
        try { await ctx.stderr(prompt); } catch { /* ignore */ }
      }
      return 1;
    }
    let res;
    try {
      res = await ctx.readLine({
        prompt,
        silent: optS,
        nChars: nChars >= 0 ? nChars : null,
        delim: delim === '\n' ? null : delim,
        timeout: optT,
        raw,
      });
    } catch (e) {
      await ctx.stderr(`read: ${e.message || e}\n`);
      return 1;
    }
    if (!res || res.eof) return 1;
    if (res.timeout) return 142; // bash convention for -t timeout expiry
    const lineFromHost = typeof res.line === 'string' ? res.line : '';
    return await _readBindVars(lineFromHost, ctx, varNames, raw);
  }
  if (prompt) {
    try { await ctx.stderr(prompt); } catch { /* ignore */ }
  }
  // Consume one record from stdin. Mutate ctx.stdin so subsequent reads
  // in the same command context (e.g. `while read; do ...; done < file`)
  // continue from where we left off.
  let line;
  if (nChars >= 0) {
    // -n: read up to N characters, ignoring delim. nChars=0 reads
    // nothing but still returns 0 (consistent with bash).
    const take = Math.min(nChars, ctx.stdin.length);
    line = ctx.stdin.slice(0, take);
    ctx.stdin = ctx.stdin.slice(take);
  } else {
    // -d (default '\n'): terminate on first occurrence of delim[0].
    // Empty delim ('') means read everything until EOF.
    const ch = delim.length > 0 ? delim[0] : '';
    const idx = ch === '' ? -1 : ctx.stdin.indexOf(ch);
    if (idx < 0) {
      line = ctx.stdin;
      ctx.stdin = '';
    } else {
      line = ctx.stdin.slice(0, idx);
      ctx.stdin = ctx.stdin.slice(idx + 1);
    }
  }
  return await _readBindVars(line, ctx, varNames, raw);
}

// Apply the post-acquire processing common to both stdin-slice and
// interactive-readLine paths: optional backslash de-escape (skipped
// under -r), then IFS-aware splitting into var bindings.
async function _readBindVars(line, ctx, varNames, raw) {
  if (!raw) {
    let processed = '';
    for (let k = 0; k < line.length; k++) {
      if (line[k] === '\\' && k + 1 < line.length) {
        processed += line[k + 1];
        k++;
      } else {
        processed += line[k];
      }
    }
    line = processed;
  }
  const ifs = ctx.env.get('IFS') ?? ' \t\n';
  if (varNames.length === 1) {
    const trimmed = _readTrimIfsWs(line, ifs);
    ctx.env.set(varNames[0], trimmed);
  } else {
    const fields = _readSplitFields(line, ifs, varNames.length);
    for (let k = 0; k < varNames.length; k++) {
      ctx.env.set(varNames[k], fields[k] ?? '');
    }
  }
  return 0;
}

function _readTrimIfsWs(line, ifs) {
  const wsSet = new Set();
  for (const c of ifs) if (c === ' ' || c === '\t' || c === '\n') wsSet.add(c);
  if (wsSet.size === 0) return line;
  let start = 0, end = line.length;
  while (start < end && wsSet.has(line[start])) start++;
  while (end > start && wsSet.has(line[end - 1])) end--;
  return line.slice(start, end);
}

function _readSplitFields(line, ifs, maxFields) {
  const wsSet = new Set(), otherSet = new Set();
  for (const c of ifs) {
    if (c === ' ' || c === '\t' || c === '\n') wsSet.add(c);
    else otherSet.add(c);
  }
  const out = [];
  let i = 0;
  while (i < line.length && wsSet.has(line[i])) i++;
  let cur = '';
  while (i < line.length) {
    if (out.length === maxFields - 1) {
      cur = line.slice(i);
      // Trim trailing whitespace-IFS from the last absorbed field (POSIX read).
      if (wsSet.size > 0) {
        let end = cur.length;
        while (end > 0 && wsSet.has(cur[end - 1])) end--;
        cur = cur.slice(0, end);
      }
      out.push(cur);
      return out;
    }
    const c = line[i];
    if (wsSet.has(c)) {
      out.push(cur);
      cur = '';
      i++;
      while (i < line.length && wsSet.has(line[i])) i++;
      continue;
    }
    if (otherSet.has(c)) {
      out.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur || out.length < maxFields) out.push(cur);
  while (out.length < maxFields) out.push('');
  return out;
}

// ── local / return / shift — function-frame builtins ──
//
// local NAME[=value] ... — only valid inside a function. Shadows any
// caller binding of NAME for the duration of the current frame; on
// frame pop, the executor restores the prior value (or deletes the
// name if it was previously unset). `local NAME` without `=` keeps
// the existing visible value but still marks it for shadowed
// restoration (so the caller is insulated from later mutation).
async function _local(argv, ctx) {
  if (!ctx._localFrames || ctx._localFrames.length === 0) {
    await ctx.stderr('local: can only be used inside a function\n');
    return 1;
  }
  const frame = ctx._localFrames[ctx._localFrames.length - 1];
  let anyError = 0;
  for (const arg of argv.slice(1)) {
    const eq = arg.indexOf('=');
    const name = eq < 0 ? arg : arg.slice(0, eq);
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      await ctx.stderr(`local: ${name}: not a valid identifier\n`);
      anyError = 1;
      continue;
    }
    if (!frame.savedBindings.has(name)) {
      frame.savedBindings.set(name, ctx.env.has(name) ? ctx.env.get(name) : undefined);
    }
    if (eq >= 0) {
      ctx.env.set(name, arg.slice(eq + 1));
    } else if (!ctx.env.has(name)) {
      // `local NAME` with no = and no prior binding: initialize empty,
      // matching bash/dash. (POSIX is silent; this is the consensus.)
      ctx.env.set(name, '');
    }
  }
  return anyError;
}

// return [N] — exit the current function with status N (defaults to
// the last command's exit code). Outside a function, behaves as `exit`
// would (POSIX leaves this undefined; we follow bash's pragmatic shape).
async function _return(argv, ctx) {
  const raw = argv[1];
  const n = raw !== undefined ? Number(raw) : ctx.lastStatus;
  const code = Number.isFinite(n) ? (n & 0xff) : 0;
  // Outside any function frame, treat as exit (POSIX-undefined; bash
  // says "error", but exit-shape is more useful in scripts that get
  // sourced via `.`).
  if (!ctx._localFrames || ctx._localFrames.length === 0) {
    throw { exitCode: code, _exit: true };
  }
  throw { exitCode: code, _return: true };
}

// shift [N] — drop the first N positional parameters (default 1).
// Returns 1 if N is larger than the current count (no shift performed),
// matching POSIX. Useful with `local x=$1; shift` to consume args.
async function _shift(argv, ctx) {
  const n = argv[1] !== undefined ? parseInt(argv[1], 10) : 1;
  if (!Number.isFinite(n) || n < 0) {
    await ctx.stderr('shift: invalid count\n');
    return 1;
  }
  const cur = ctx.positional || [];
  if (n > cur.length) return 1;
  ctx.positional = cur.slice(n);
  return 0;
}

// ── which / command — name lookup ──

async function _which(argv, ctx) {
  let anyError = 0;
  for (const name of argv.slice(1)) {
    if (ctx.builtins.has(name)) {
      await ctx.stdout(`${name}: shell built-in\n`);
    } else if (ctx.functions.has(name)) {
      await ctx.stdout(`${name}: shell function\n`);
    } else {
      anyError = 1;
    }
  }
  return anyError;
}

async function _command(argv, ctx) {
  // command [-v|-V] NAME [args...] — runs NAME bypassing function lookup,
  // or with -v/-V prints how the name would be resolved.
  let mode = null;
  let i = 1;
  while (i < argv.length && argv[i].startsWith('-') && argv[i] !== '--' && argv[i].length > 1) {
    if (argv[i] === '-v') { mode = 'v'; i++; continue; }
    if (argv[i] === '-V') { mode = 'V'; i++; continue; }
    if (argv[i] === '--') { i++; break; }
    i++;
  }
  if (i >= argv.length) return 0;
  const name = argv[i];
  if (mode) {
    if (ctx.builtins.has(name)) {
      await ctx.stdout(mode === 'V' ? `${name} is a shell builtin\n` : `${name}\n`);
      return 0;
    }
    if (ctx.functions.has(name)) {
      await ctx.stdout(mode === 'V' ? `${name} is a shell function\n` : `${name}\n`);
      return 0;
    }
    return 1;
  }
  const rest = argv.slice(i);
  if (ctx.builtins.has(name)) {
    return await ctx.builtins.get(name)(rest, ctx);
  }
  return await ctx.onCommand(name, rest, ctx);
}

// ── seq / sleep / date ──

async function _seq(argv, ctx) {
  const positional = [];
  let sep = '\n';
  let i = 1;
  while (i < argv.length) {
    if (argv[i] === '-s' && i + 1 < argv.length) { sep = argv[++i]; i++; continue; }
    if (argv[i].startsWith('-s') && argv[i].length > 2) { sep = argv[i].slice(2); i++; continue; }
    positional.push(argv[i]);
    i++;
  }
  if (positional.length === 0) {
    await ctx.stderr('seq: missing operand\n');
    return 1;
  }
  let first = 1, increment = 1, last = 0;
  if (positional.length === 1) { last = Number(positional[0]); }
  else if (positional.length === 2) { first = Number(positional[0]); last = Number(positional[1]); }
  else { first = Number(positional[0]); increment = Number(positional[1]); last = Number(positional[2]); }
  if (!Number.isFinite(first) || !Number.isFinite(last) || !Number.isFinite(increment)) {
    await ctx.stderr('seq: invalid number\n');
    return 1;
  }
  if (increment === 0) {
    await ctx.stderr('seq: increment must be non-zero\n');
    return 1;
  }
  const out = [];
  if (increment > 0) {
    for (let n = first; n <= last + 1e-12; n += increment) out.push(_seqFormatNum(n));
  } else {
    for (let n = first; n >= last - 1e-12; n += increment) out.push(_seqFormatNum(n));
  }
  if (out.length === 0) return 0;
  await ctx.stdout(out.join(sep) + '\n');
  return 0;
}

function _seqFormatNum(n) {
  if (Number.isInteger(n)) return String(n);
  // Round to ~6 sig-figs for fractional sequences; trims runaway FP noise.
  const r = Math.round(n * 1e6) / 1e6;
  return String(r);
}

async function _sleep(argv, ctx) {
  const arg = argv[1];
  if (arg == null) {
    await ctx.stderr('sleep: missing operand\n');
    return 1;
  }
  const m = String(arg).match(/^(\d+(?:\.\d+)?)([smhd])?$/);
  if (!m) {
    await ctx.stderr(`sleep: invalid duration "${arg}"\n`);
    return 1;
  }
  const n = parseFloat(m[1]);
  const unit = m[2] || 's';
  const mult = unit === 'm' ? 60 : unit === 'h' ? 3600 : unit === 'd' ? 86400 : 1;
  await new Promise(r => setTimeout(r, n * mult * 1000));
  return 0;
}

async function _date(argv, ctx) {
  let fmt = '%a %b %e %T %Y'; // POSIX default
  for (const a of argv.slice(1)) {
    if (a.startsWith('+')) fmt = a.slice(1);
  }
  const d = new Date();
  await ctx.stdout(_formatDate(d, fmt) + '\n');
  return 0;
}

function _formatDate(d, fmt) {
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  const dayShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayFull = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const monShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monFull = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return fmt.replace(/%./g, (m) => {
    switch (m) {
      case '%Y': return String(d.getFullYear());
      case '%y': return pad(d.getFullYear() % 100);
      case '%m': return pad(d.getMonth() + 1);
      case '%d': return pad(d.getDate());
      case '%H': return pad(d.getHours());
      case '%I': return pad(((d.getHours() + 11) % 12) + 1);
      case '%M': return pad(d.getMinutes());
      case '%S': return pad(d.getSeconds());
      case '%p': return d.getHours() < 12 ? 'AM' : 'PM';
      case '%a': return dayShort[d.getDay()];
      case '%A': return dayFull[d.getDay()];
      case '%b': case '%h': return monShort[d.getMonth()];
      case '%B': return monFull[d.getMonth()];
      case '%e': return String(d.getDate()).padStart(2, ' ');
      case '%j': return pad(_dayOfYear(d), 3);
      case '%T': return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      case '%R': return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      case '%D': return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${pad(d.getFullYear() % 100)}`;
      case '%F': return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      case '%s': return String(Math.floor(d.getTime() / 1000));
      case '%n': return '\n';
      case '%t': return '\t';
      case '%%': return '%';
      case '%z': {
        const off = -d.getTimezoneOffset();
        const sign = off >= 0 ? '+' : '-';
        const h = pad(Math.floor(Math.abs(off) / 60));
        const mm = pad(Math.abs(off) % 60);
        return `${sign}${h}${mm}`;
      }
      default: return m;
    }
  });
}

function _dayOfYear(d) {
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d - start) / 86400000);
}

// xargs: build commands from stdin tokens. v0 supports -n (batch size)
// and uses the dispatch in ctx to invoke the named command.
async function _xargs(argv, ctx) {
  const { opts, positionals } = _bParseArgs(argv, {
    n: { short: 'n', arg: true },
    I: { short: 'I', arg: true },
    zero: { short: '0' },
  });
  const cmdArgv = positionals.length === 0 ? ['echo'] : positionals;
  // Drain via the typed-aware helper — handles streaming-queue input
  // (the common pipeline shape) plus plain string / typed values.
  const stdinDrained = await drainInput(ctx);
  const stdin = typeof stdinDrained === 'string' ? stdinDrained : String(stdinDrained);
  // `-0` reads NUL-separated input — the canonical pairing for
  // `find -print0 | xargs -0`, which is the only safe way to pass
  // filenames containing whitespace or quotes through xargs.
  const tokens = opts.zero
    ? stdin.split('\0').filter(Boolean)
    : stdin.split(/\s+/).filter(Boolean);
  const batchSize = opts.n ? Math.max(1, parseInt(opts.n, 10)) : tokens.length;
  let lastExit = 0;
  for (let i = 0; i < tokens.length; i += batchSize) {
    const batch = tokens.slice(i, i + batchSize);
    let argvCall;
    if (opts.I) {
      // Substitute the placeholder in cmdArgv.
      argvCall = cmdArgv.map(a => a === opts.I ? batch.join(' ') : a);
    } else {
      argvCall = [...cmdArgv, ...batch];
    }
    const name = argvCall[0];
    if (ctx.builtins.has(name)) {
      const r = await ctx.builtins.get(name)(argvCall, ctx);
      lastExit = typeof r === 'number' ? r : 0;
    } else if (ctx.onCommand) {
      lastExit = await ctx.onCommand(name, argvCall, ctx);
    } else {
      await ctx.stderr(`xargs: ${name}: command not found\n`);
      lastExit = 127;
    }
    if (tokens.length === 0) break;
  }
  return lastExit;
}
