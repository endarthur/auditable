// ⚠ GENERATED FILE — DO NOT EDIT. Source: src/  Build: @gcu/build src/main.js
// @gcu/coreutils — Lite, worker-free coreutils (ls/cat/echo/mkdir/rm/cp/mv/touch/head/tail) over a @gcu/vfs-shaped filesystem. The genuinely-useful handful, runnable anywhere (file:// too) without a shell process. Host-agnostic: run(argv, {vfs, cwd}) → {stdout, stderr, code}. Zero dependencies.

// ── src/util.js ──

// util.js — path resolution + minimal getopt for the coreutils-lite commands.

// Resolve `p` against `cwd`, normalizing `.`/`..`. Absolute paths ignore cwd.
function resolvePath(cwd, p) {
  const base = p && p.startsWith('/') ? p : (cwd || '/') + '/' + (p || '');
  const parts = [];
  for (const seg of base.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (parts.length) parts.pop(); }
    else parts.push(seg);
  }
  return '/' + parts.join('/');
}

// Join a directory and a child name into a normalized absolute path.
function join(dir, name) {
  return (dir === '/' ? '' : dir.replace(/\/$/, '')) + '/' + name;
}

// Split argv into { flags:Set<char>, opts:{char:value}, positional:[] }.
// Supports clustered flags (-rf), value options (-n 5 or -n5), and `--`.
// `optsWithValue` lists the single-char options that take a value.
function parseArgs(args, optsWithValue = []) {
  const flags = new Set();
  const opts = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { positional.push(...args.slice(i + 1)); break; }
    // a flag/option group: starts with '-', not just '-', not a negative number
    if (a.length > 1 && a[0] === '-' && !/^-\d/.test(a)) {
      const body = a.slice(1);
      for (let j = 0; j < body.length; j++) {
        const ch = body[j];
        if (optsWithValue.includes(ch)) {
          const rest = body.slice(j + 1);
          opts[ch] = rest !== '' ? rest : args[++i];
          break; // value option consumes the remainder of this token
        }
        flags.add(ch);
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, opts, positional };
}

const ok = (stdout = '') => ({ stdout, stderr: '', code: 0 });
const fail = (stderr, code = 1) => ({ stdout: '', stderr, code });

// ── src/commands.js ──

// commands.js — the coreutils-lite command set, each a pure async function over a
// @gcu/vfs-shaped filesystem: (args, { vfs, cwd }) → { stdout, stderr, code }.
// No pipes, no job control, no globbing — the genuinely-useful 90% of a few commands,
// worker-free so they run anywhere (file:// included).


async function ls(args, { vfs, cwd }) {
  const { flags, positional } = parseArgs(args);
  const target = resolvePath(cwd, positional[0] || '');
  let st;
  try { st = await vfs.stat(target); } catch { return fail(`ls: ${positional[0] || '.'}: No such file or directory`); }
  if (st.type !== 'directory') return ok(positional[0] || target);

  const names = await vfs.readdir(target);
  if (!flags.has('l')) {
    const out = [];
    for (const n of names) {
      let dir = false;
      try { dir = (await vfs.stat(join(target, n))).type === 'directory'; } catch { /* race */ }
      out.push(dir ? n + '/' : n);
    }
    return ok(out.join('\n'));
  }
  const rows = [];
  for (const n of names) {
    let info;
    try { info = await vfs.stat(join(target, n)); } catch { continue; }
    const t = info.type === 'directory' ? 'd' : '-';
    rows.push(`${t} ${String(info.size || 0).padStart(8)} ${n}`);
  }
  return ok(rows.join('\n'));
}

async function cat(args, { vfs, cwd }) {
  const { positional } = parseArgs(args);
  if (!positional.length) return fail('cat: missing file operand');
  let out = '';
  for (const f of positional) {
    try { out += await vfs.readFile(resolvePath(cwd, f), 'utf8'); }
    catch { return fail(`cat: ${f}: No such file or directory`); }
  }
  return ok(out);
}

async function echo(args) {
  // Literal echo (no -n / escape handling — keep it predictable).
  return ok(args.join(' '));
}

async function mkdir(args, { vfs, cwd }) {
  const { flags, positional } = parseArgs(args);
  if (!positional.length) return fail('mkdir: missing operand');
  for (const d of positional) {
    const full = resolvePath(cwd, d);
    if (flags.has('p')) {
      let cur = '';
      for (const seg of full.split('/').filter(Boolean)) {
        cur += '/' + seg;
        try { await vfs.mkdir(cur); } catch (e) { if (e.code !== 'EEXIST') return fail(`mkdir: ${d}: ${e.message}`); }
      }
    } else {
      try { await vfs.mkdir(full); }
      catch (e) { return fail(`mkdir: ${d}: ${e.code === 'EEXIST' ? 'File exists' : e.message}`); }
    }
  }
  return ok();
}

async function rmrf(vfs, dir) {
  for (const n of await vfs.readdir(dir)) {
    const child = join(dir, n);
    const st = await vfs.stat(child);
    if (st.type === 'directory') await rmrf(vfs, child);
    else await vfs.unlink(child);
  }
  await vfs.rmdir(dir);
}

async function rm(args, { vfs, cwd }) {
  const { flags, positional } = parseArgs(args);
  if (!positional.length) return fail('rm: missing operand');
  const recursive = flags.has('r') || flags.has('R');
  for (const p of positional) {
    const full = resolvePath(cwd, p);
    let st;
    try { st = await vfs.stat(full); }
    catch { if (flags.has('f')) continue; return fail(`rm: ${p}: No such file or directory`); }
    if (st.type === 'directory') {
      if (!recursive) return fail(`rm: ${p}: is a directory`);
      await rmrf(vfs, full);
    } else {
      await vfs.unlink(full);
    }
  }
  return ok();
}

async function cp(args, { vfs, cwd }) {
  const { flags, positional } = parseArgs(args);
  if (positional.length < 2) return fail('cp: missing destination operand');
  try {
    await vfs.cp(resolvePath(cwd, positional[0]), resolvePath(cwd, positional[1]), { recursive: flags.has('r') || flags.has('R') });
  } catch (e) { return fail(`cp: ${e.message}`); }
  return ok();
}

async function mv(args, { vfs, cwd }) {
  const { positional } = parseArgs(args);
  if (positional.length < 2) return fail('mv: missing destination operand');
  try { await vfs.rename(resolvePath(cwd, positional[0]), resolvePath(cwd, positional[1])); }
  catch (e) { return fail(`mv: ${e.message}`); }
  return ok();
}

async function touch(args, { vfs, cwd }) {
  const { positional } = parseArgs(args);
  if (!positional.length) return fail('touch: missing file operand');
  for (const f of positional) {
    const full = resolvePath(cwd, f);
    if (!(await vfs.exists(full))) await vfs.writeFile(full, '');
  }
  return ok();
}

async function headTail(args, { vfs, cwd }, which) {
  const { opts, positional } = parseArgs(args, ['n']);
  const n = parseInt(opts.n, 10) || 10;
  if (!positional.length) return fail(`${which}: missing file operand`);
  const out = [];
  for (const f of positional) {
    let text;
    try { text = await vfs.readFile(resolvePath(cwd, f), 'utf8'); }
    catch { return fail(`${which}: ${f}: No such file or directory`); }
    const lines = text.split('\n');
    const body = lines.length && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
    out.push((which === 'head' ? body.slice(0, n) : body.slice(-n)).join('\n'));
  }
  return ok(out.join('\n'));
}

async function head(args, ctx) { return headTail(args, ctx, 'head'); }
async function tail(args, ctx) { return headTail(args, ctx, 'tail'); }

// ── src/main.js ──

// @gcu/coreutils — a lite, worker-free coreutils subset over a @gcu/vfs-shaped
// filesystem. The seed of the full @gcu/coreutils extraction geas anticipates; for
// now, the genuinely-useful handful (ls/cat/echo/mkdir/rm/cp/mv/touch/head/tail) that
// any VFS-backed GCU surface can run without geas's process machinery — so they work
// on file:// too. Host-agnostic contract: run(argv, { vfs, cwd }) → { stdout, stderr,
// code }. Package management is NOT here — it's the host's concern.


const COMMANDS = { ls, cat, echo, mkdir, rm, cp, mv, touch, head, tail };
const names = Object.keys(COMMANDS);

// Run one command. argv = [cmd, ...args]; env = { vfs, cwd? } (cwd defaults to '/').
async function run(argv, env = {}) {
  const cmd = argv[0];
  const fn = COMMANDS[cmd];
  if (!fn) return { stdout: '', stderr: `${cmd}: command not found`, code: 127 };
  if (!env.vfs) return { stdout: '', stderr: `${cmd}: no filesystem`, code: 1 };
  try {
    return await fn(argv.slice(1), { vfs: env.vfs, cwd: env.cwd || '/' });
  } catch (e) {
    return { stdout: '', stderr: `${cmd}: ${(e && e.message) || e}`, code: 1 };
  }
}

export {
  COMMANDS,
  names,
  run,
  ls,
  cat,
  echo,
  mkdir,
  rm,
  cp,
  mv,
  touch,
  head,
  tail,
};
