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
  let i = 1;
  while (i < argv.length && argv[i].startsWith('-') && argv[i] !== '--' && argv[i].length > 1) {
    const flag = argv[i];
    if (flag === '-r') { raw = true; i++; continue; }
    if (flag === '-p') { prompt = argv[i + 1] ?? ''; i += 2; continue; }
    if (flag.startsWith('-p') && flag.length > 2) { prompt = flag.slice(2); i++; continue; }
    if (flag === '-s') { i++; continue; }
    if (flag === '-n' || flag === '-d' || flag === '-t') { i += 2; continue; }
    if (flag === '--') { i++; break; }
    await ctx.stderr(`read: ${flag}: unknown option\n`);
    return 2;
  }
  const vars = argv.slice(i);
  const varNames = vars.length > 0 ? vars : ['REPLY'];
  if (prompt) {
    try { await ctx.stderr(prompt); } catch { /* ignore */ }
  }
  if (typeof ctx.stdin !== 'string' || ctx.stdin.length === 0) return 1;
  // Consume one line from stdin. Mutate ctx.stdin so subsequent reads in
  // the same command context (e.g. `while read; do ...; done < file`)
  // continue from where we left off.
  const nlIdx = ctx.stdin.indexOf('\n');
  let line;
  if (nlIdx < 0) {
    line = ctx.stdin;
    ctx.stdin = '';
  } else {
    line = ctx.stdin.slice(0, nlIdx);
    ctx.stdin = ctx.stdin.slice(nlIdx + 1);
  }
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
    // Single var: get the whole line minus IFS-whitespace trimming.
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
