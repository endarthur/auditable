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

// Construct a fresh map of the default builtins. Returns a new Map per call
// so consumers can mutate (add/override) without affecting other shells.
export function defaultBuiltins() {
  return new Map(Object.entries({
    ...defaultTypedBuiltins(),
    ':':      _colon,
    echo:     _echo,
    true:     _true,
    false:    _false,
    pwd:      _pwd,
    cd:       _cd,
    env:      _env,
    export:   _export,
    exit:     _exit,
    cat:      _cat,
    ls:       _ls,
    test:     _test,
    '[':      _testBracket,
    // Filesystem
    mkdir:    _mkdir,
    rm:       _rm,
    touch:    _touch,
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
  // Support `-n` (no trailing newline) and `-e` (interpret backslash
  // escapes — for v0 just accept and ignore, treat literally).
  while (args.length && /^-[neE]+$/.test(args[0])) {
    if (args[0].includes('n')) newline = false;
    args.shift();
  }
  await ctx.stdout(args.join(' ') + (newline ? '\n' : ''));
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

async function _test(argv, ctx) {
  const args = argv.slice(1);
  // Zero-arg test → false
  if (args.length === 0) return 1;
  // One-arg test: true iff non-empty
  if (args.length === 1) return args[0].length > 0 ? 0 : 1;

  // Two-arg test: unary operator
  if (args.length === 2) {
    return await _testUnary(args[0], args[1], ctx);
  }

  // Three-arg test: binary
  if (args.length === 3) {
    return await _testBinary(args[0], args[1], args[2], ctx);
  }

  // Four-arg: `! <three-arg>` or grouping not handled in v0.
  if (args.length === 4 && args[0] === '!') {
    const r = await _testBinary(args[1], args[2], args[3], ctx);
    return r === 0 ? 1 : 0;
  }

  await ctx.stderr(`test: too many arguments (v0 limit)\n`);
  return 2;
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
// Typed-pipe contract: if ctx.stdin is a Typed object, fall back to its
// text rendering via toString(). Builtins that don't know about types
// transparently get the canonical text representation.
async function _bReadInput(paths, ctx) {
  if (!paths || paths.length === 0) {
    if (ctx.stdin == null) return '';
    if (typeof ctx.stdin === 'string') return ctx.stdin;
    return String(ctx.stdin);
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
  const { opts, positionals } = _bParseArgs(argv, { n: { short: 'n', arg: true, default: '10' } });
  const n = Math.max(0, parseInt(opts.n, 10) || 0);
  try {
    const text = await _bReadInput(positionals, ctx);
    const lines = text.split('\n');
    // Preserve trailing newline state: if text ends with '\n', the last
    // element is '' and we drop it for the "lines" count.
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

async function _tail(argv, ctx) {
  const { opts, positionals } = _bParseArgs(argv, { n: { short: 'n', arg: true, default: '10' } });
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

// xargs: build commands from stdin tokens. v0 supports -n (batch size)
// and uses the dispatch in ctx to invoke the named command.
async function _xargs(argv, ctx) {
  const { opts, positionals } = _bParseArgs(argv, {
    n: { short: 'n', arg: true },
    I: { short: 'I', arg: true },
  });
  const cmdArgv = positionals.length === 0 ? ['echo'] : positionals;
  const stdin = typeof ctx.stdin === 'string' ? ctx.stdin : '';
  const tokens = stdin.split(/\s+/).filter(Boolean);
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
