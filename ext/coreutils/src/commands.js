// commands.js — the coreutils-lite command set, each a pure async function over a
// @gcu/vfs-shaped filesystem: (args, { vfs, cwd }) → { stdout, stderr, code }.
// No pipes, no job control, no globbing — the genuinely-useful 90% of a few commands,
// worker-free so they run anywhere (file:// included).

import { resolvePath, join, parseArgs, ok, fail } from './util.js';

export async function ls(args, { vfs, cwd }) {
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

export async function cat(args, { vfs, cwd }) {
  const { positional } = parseArgs(args);
  if (!positional.length) return fail('cat: missing file operand');
  let out = '';
  for (const f of positional) {
    try { out += await vfs.readFile(resolvePath(cwd, f), 'utf8'); }
    catch { return fail(`cat: ${f}: No such file or directory`); }
  }
  return ok(out);
}

export async function echo(args) {
  // Literal echo (no -n / escape handling — keep it predictable).
  return ok(args.join(' '));
}

export async function mkdir(args, { vfs, cwd }) {
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

export async function rm(args, { vfs, cwd }) {
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

export async function cp(args, { vfs, cwd }) {
  const { flags, positional } = parseArgs(args);
  if (positional.length < 2) return fail('cp: missing destination operand');
  try {
    await vfs.cp(resolvePath(cwd, positional[0]), resolvePath(cwd, positional[1]), { recursive: flags.has('r') || flags.has('R') });
  } catch (e) { return fail(`cp: ${e.message}`); }
  return ok();
}

export async function mv(args, { vfs, cwd }) {
  const { positional } = parseArgs(args);
  if (positional.length < 2) return fail('mv: missing destination operand');
  try { await vfs.rename(resolvePath(cwd, positional[0]), resolvePath(cwd, positional[1])); }
  catch (e) { return fail(`mv: ${e.message}`); }
  return ok();
}

export async function touch(args, { vfs, cwd }) {
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

export async function head(args, ctx) { return headTail(args, ctx, 'head'); }
export async function tail(args, ctx) { return headTail(args, ctx, 'tail'); }
