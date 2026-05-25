// Archive-format builtins for geas — POSIX-baseline flag surface wrapping
// @gcu/archive. Designed to extract cleanly into @gcu/coreutils when that
// package becomes its own thing (see ext/geas/README.md "@gcu/coreutils
// extraction" roadmap).
//
// Each builtin is `async (argv, ctx) => exitCode`, matching geas's contract.
// ctx exposes: stdin, stdout, stderr, vfs, cwd, env.
//
// Flag coverage matches archive-spec §4.4 — POSIX-baseline only. Not a
// reimplementation of GNU tar; users wanting --exclude-from / --xform / etc.
// can compose with grep / find pipelines.
//
// @gcu/archive resolution: geas's build.js prepends the pre-built archive
// bundle (ext/archive/index.js) so `archive` and `walkVfsTree` are in scope
// here at runtime in the geas worker. For node-test usage (where this file
// is loaded directly, not through the concat build), we fall back to a
// dynamic import — the relative path resolves via Node's ESM loader.

let _archive = null;
let _walk = null;
let _resolved = false;
async function _resolveArchive() {
  if (_resolved) return;
  _resolved = true;
  // First check: globalThis already has it from the concat-prepended bundle.
  if (typeof archive !== 'undefined' && archive && typeof archive.list === 'function') {
    // eslint-disable-next-line no-undef
    _archive = archive;
  }
  if (typeof walkVfsTree === 'function') {
    // eslint-disable-next-line no-undef
    _walk = walkVfsTree;
  }
  if (_archive && _walk) return;
  // Fallback for test / standalone usage: dynamic import.
  try {
    const mod = await import('../../archive/index.js');
    if (!_archive && mod.archive && typeof mod.archive.list === 'function') _archive = mod.archive;
    if (!_walk && typeof mod.walkVfsTree === 'function') _walk = mod.walkVfsTree;
  } catch { /* ignore — surfaces as a clear error below */ }
}

// Print + return 127 (POSIX command-not-found-ish) when archive is missing.
// Used at the top of every builtin.
async function _requireArchive(ctx, name) {
  await _resolveArchive();
  if (!_archive) {
    await ctx.stderr(`${name}: @gcu/archive not loaded in this build\n`);
    return null;
  }
  return _archive;
}

async function _loadWalk() {
  await _resolveArchive();
  return _walk;
}

// ── Helpers shared with the geas builtins module ────────────────────────
// Re-declared locally to avoid a circular import; identical to the ones in
// builtins.js (geas's main file).

function _arResolvePath(p, ctx) {
  if (p == null) return p;
  if (p.startsWith('/')) return _arNormalizePath(p);
  const base = ctx.cwd && ctx.cwd.endsWith('/') ? ctx.cwd : (ctx.cwd || '/') + '/';
  return _arNormalizePath(base + p);
}

function _arNormalizePath(p) {
  const parts = String(p).split('/');
  const stack = [];
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (stack.length) stack.pop(); continue; }
    stack.push(seg);
  }
  return '/' + stack.join('/');
}

function _arBasename(p) {
  const parts = String(p).split('/');
  return parts[parts.length - 1] || parts[parts.length - 2] || '';
}

// Strip a recognized archive extension off a basename. Used by tar -x and
// unzip when no -C / -d is given (extract here, sibling-named directory).
const _ARCHIVE_EXT_RE = /\.(zip|tar|tar\.gz|tgz|tar\.zst|tzst|tar\.xz|txz|tar\.bz2|tbz2|gz|zst)$/i;
function _stripArchiveExt(name) {
  return name.replace(_ARCHIVE_EXT_RE, '');
}

// Append text to ctx.stdout. Adds a trailing newline if missing — keeps the
// `> output.txt` redirection case clean.
async function _print(ctx, s) {
  if (s == null) return;
  const str = String(s);
  await ctx.stdout(str.endsWith('\n') ? str : str + '\n');
}

// Format a list entry the way `tar -tv` / `unzip -l` do — size right-aligned
// + path. Doesn't try to mimic mode bits / dates; archives often don't carry
// reliable mtimes anyway.
function _formatListing(entries, opts = {}) {
  const verbose = !!opts.verbose;
  if (!verbose) return entries.map(e => e.path).join('\n');
  const lines = [];
  for (const e of entries) {
    if (e.type === 'directory') {
      lines.push(`         <dir>  ${e.path}`);
    } else {
      const size = String(e.size ?? 0).padStart(12);
      lines.push(`${size}  ${e.path}`);
    }
  }
  return lines.join('\n');
}

// Parse a flag cluster like `czf` or `xzvf` — returns a Set of single-char
// flag names. The caller drives flag-aware logic (decode args, set mode, etc.).
function _clusterToSet(s) {
  const set = new Set();
  for (const ch of s) set.add(ch);
  return set;
}

// ── tar ─────────────────────────────────────────────────────────────────
//
// Usage:
//   tar -c[zf] FILE [-C DIR] [PATHS...]   create
//   tar -x[zf] FILE [-C DIR]              extract
//   tar -t[zf] FILE [-v]                  list
//
// Recognized flags:
//   -c create   -x extract   -t list
//   -z gzip     -j bz2 (read-only)   -J xz (read-only)   --zstd zstd (read-only)
//   -f FILE     -C DIR     -v verbose
//
// The first non-flag positional after the flag cluster is treated as the
// FILE if -f was given but no value followed it inline (the BSD/GNU "tar
// czf out.tar.gz dir/" calling convention). The rest are PATHS for create
// mode or ignored for extract/list mode in v0.
//
// Easter egg: -x AND -c together is the impossible flag combination from
// xkcd #1168 ("To disarm the bomb, simply enter a valid tar command…").
// We fetch the comic image (hotlink-permitted) into /tmp/tar.png and tell
// the user to open it. Documented as intentional — strip with care.

async function _tar(argv, ctx) {
  // Two phases of parsing — first separate long options (--zstd, --xkcd,
  // etc.) and the leading flag cluster, then walk the remaining positionals
  // for -f/-C values and paths.
  let isLong = (a) => a.startsWith('--');
  let mode = null;       // 'c' | 'x' | 't'
  let useGz = false;
  let useBz2 = false;
  let useXz = false;
  let useZst = false;
  let file = null;
  let chdir = null;
  let verbose = false;
  let bomb = false;       // xkcd egg trigger
  let positionals = [];

  let i = 1;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (a === '--zstd')  { useZst = true; i++; continue; }
    if (a === '--xkcd')  { bomb = true; i++; continue; }   // explicit alias
    if (a === '-' || !a.startsWith('-') || a.length === 1) {
      positionals.push(a); i++; continue;
    }
    // Short flag cluster — every char is one flag. Some flags consume the
    // next positional argument (f for the file, C for the chdir target).
    const cluster = a.slice(1);
    const flags = _clusterToSet(cluster);
    if (flags.has('c')) mode = 'c';
    if (flags.has('x')) mode = (mode === 'c') ? null : 'x';
    if (flags.has('t')) mode = (mode === 'c' || mode === 'x') ? null : 't';
    if (flags.has('c') && flags.has('x')) bomb = true;     // xkcd trigger
    if (flags.has('z')) useGz = true;
    if (flags.has('j')) useBz2 = true;
    if (flags.has('J')) useXz = true;
    if (flags.has('v')) verbose = true;
    // -f and -C each consume the next argv. POSIX tar also allows them
    // inlined (-fout.tar) but for v0 we require the value as a separate arg.
    if (flags.has('f')) { file = argv[++i] || null; }
    if (flags.has('C')) { chdir = argv[++i] || null; }
    i++;
  }

  if (bomb) return _tarXkcd(ctx);

  if (!ctx.vfs) { await ctx.stderr('tar: no VFS configured\n'); return 1; }
  if (!file)    { await ctx.stderr('tar: missing -f FILE\n');    return 2; }
  if (!mode)    { await ctx.stderr('tar: missing -c / -x / -t mode\n'); return 2; }

  const archive = await _requireArchive(ctx, 'tar'); if (!archive) return 127;

  // Pre-flight: tar.xz / tar.bz2 / tar.zst writes aren't possible yet.
  if (mode === 'c' && (useXz || useBz2 || useZst)) {
    await ctx.stderr('tar: -j / -J / --zstd encode not available in this build\n');
    return 1;
  }

  const filePath = _arResolvePath(file, ctx);
  const cwdPath  = chdir ? _arResolvePath(chdir, ctx) : (ctx.cwd || '/');

  try {
    if (mode === 't') {
      const entries = await archive.list({ vfs: ctx.vfs, path: filePath });
      await _print(ctx, _formatListing(entries, { verbose }));
      return 0;
    }
    if (mode === 'x') {
      // No -C → extract into cwd. We pass the cwd directly; the sink will
      // create entries underneath it. Auto-rename on collision keeps it safe.
      const result = await archive.extract(
        { vfs: ctx.vfs, path: filePath },
        { vfs: ctx.vfs, path: cwdPath },
        { overwrite: 'rename' }
      );
      if (verbose) await _print(ctx, (result.paths || []).join('\n'));
      return 0;
    }
    if (mode === 'c') {
      // Determine the compress format from the file extension. -z forces
      // tar.gz regardless of name; otherwise we look at the path.
      const lower = filePath.toLowerCase();
      let format = 'tar';
      if (useGz || lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) format = 'tar.gz';
      // Sources to include — one per positional. Each can be a file or a dir.
      const sources = positionals.length > 0 ? positionals : ['.'];
      // The archive lib's compress walks ONE source path. For multiple, we
      // build a writer and add each source's tree manually.
      const writer = archive.createWriter(
        { vfs: ctx.vfs, path: filePath },
        { format }
      );
      for (const src of sources) {
        const srcAbs = _arResolvePath(src, ctx);
        // Walk the source. Filenames inside the archive are RELATIVE to the
        // source — for `tar -czf out.tar.gz dir/`, entries are dir/foo not
        // /abs/path/dir/foo.
        const walkVfsTree = await _loadWalk();
        if (!walkVfsTree) throw new Error('@gcu/archive walker not available');
        const entries = await walkVfsTree(ctx.vfs, srcAbs);
        // Prefix entries with the source's basename so `dir/x.txt` lands
        // as `dir/x.txt`, not just `x.txt`.
        const prefix = _arBasename(srcAbs);
        for (const e of entries) {
          const archivePath = prefix ? `${prefix}/${e.path}` : e.path;
          if (e.type === 'directory') await writer.addDirectory(archivePath);
          else                         await writer.addFile(archivePath, e.bytes);
          if (verbose) await _print(ctx, archivePath);
        }
      }
      await writer.close();
      return 0;
    }
  } catch (e) {
    await ctx.stderr(`tar: ${e.message || e}\n`);
    return 1;
  }
  return 0;
}

// Use _loadWalk() (the candidate-chain resolver above) for tar/zip's
// create paths.

// xkcd #1168 — "tar". Hotlink xkcd.com is allowed for the comic image asset
// (https://xkcd.com/about/hotlinking — see "ok to hotlink"). We grab the
// PNG, write it to /tmp/tar.png, and point the user at it. If fetch fails
// (CORS, offline, fetch unavailable in the worker), we degrade gracefully
// to just the comic dialogue.
async function _tarXkcd(ctx) {
  const url = 'https://imgs.xkcd.com/comics/tar.png';
  const dialogue =
    'Rob! You use Unix! Come quick!\n' +
    '\n' +
    'To disarm the bomb, simply enter a valid `tar` command on your first try.\n' +
    'No googling. You have ten seconds.\n' +
    '\n' +
    '…Rob?\n' +
    '\n' +
    "I'm so sorry.\n" +
    '\n' +
    '— xkcd #1168 — https://xkcd.com/1168/\n';
  try {
    if (typeof fetch !== 'function') throw new Error('no fetch');
    const r = await fetch(url);
    if (!r || !r.ok) throw new Error('fetch ' + (r ? r.status : 'failed'));
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (ctx.vfs) {
      try { await ctx.vfs.mkdir('/tmp', { recursive: true }); } catch {}
      await ctx.vfs.writeFile('/tmp/tar.png', bytes);
      await _print(ctx, dialogue + '\n(saved to /tmp/tar.png — open it in the file tree to view)');
      return 0;
    }
  } catch { /* fall through to text-only */ }
  await _print(ctx, dialogue);
  return 0;
}

// ── gzip / gunzip ───────────────────────────────────────────────────────
//
// gzip [-d -k -c -N] FILE...
//   -d  decompress    -k  keep input    -c  write to stdout
//   -1..-9  compression level (forwarded to fflate; ignored on -d)
//
// gunzip = gzip -d (alias)

async function _gzipImpl(argv, ctx, defaultDecompress) {
  let decompress = defaultDecompress;
  let keep = false;
  let toStdout = false;
  // -1..-9 are ignored in v0 (fflate level handled by archive.gzip default);
  // we still consume them so they don't get classified as filenames.
  let positionals = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (a === '-' || !a.startsWith('-')) { positionals.push(a); continue; }
    for (const ch of a.slice(1)) {
      if (ch === 'd') decompress = true;
      else if (ch === 'k') keep = true;
      else if (ch === 'c') toStdout = true;
      else if (ch >= '0' && ch <= '9') { /* level ignored in v0 */ }
      else { await ctx.stderr(`gzip: unknown option -${ch}\n`); return 2; }
    }
  }

  if (!ctx.vfs) { await ctx.stderr('gzip: no VFS configured\n'); return 1; }
  if (positionals.length === 0) {
    await ctx.stderr('gzip: stdin/stdout mode not yet implemented; supply a FILE\n');
    return 2;
  }

  const archive = await _requireArchive(ctx, 'gzip'); if (!archive) return 127;

  let anyError = 0;
  for (const f of positionals) {
    const src = _arResolvePath(f, ctx);
    try {
      if (decompress) {
        if (toStdout) {
          // Pipe gunzipped bytes to stdout as text. Binary files printed to
          // a terminal aren't useful — that's a shell concern, not ours.
          const map = await archive.gunzip(
            { vfs: ctx.vfs, path: src }, 'memory');
          const [, bytes] = [...map.entries()][0];
          await ctx.stdout(new TextDecoder().decode(bytes));
        } else {
          // Strip .gz to derive the output name.
          const dst = src.replace(/\.gz$/i, '');
          if (dst === src) {
            await ctx.stderr(`gzip: ${f}: not a .gz file\n`);
            anyError = 1; continue;
          }
          await archive.gunzip(
            { vfs: ctx.vfs, path: src }, { vfs: ctx.vfs, path: dst });
          if (!keep) try { await ctx.vfs.unlink(src); } catch {}
        }
      } else {
        if (toStdout) {
          // gzip the input bytes; ctx.stdout sinks strings, so this only
          // really works downstream of a `> file` redirect. Worker stdouts
          // may be type-coercing — for v0 we accept the limitation.
          const map = await archive.gzip(
            { vfs: ctx.vfs, path: src }, 'memory');
          const [, bytes] = [...map.entries()][0];
          // Surface as latin-1 string to preserve binary bytes through
          // string-typed stdout sinks. Caller redirecting to a file should
          // get the right bytes back.
          let s = '';
          for (let k = 0; k < bytes.length; k++) s += String.fromCharCode(bytes[k]);
          await ctx.stdout(s);
        } else {
          const dst = src + '.gz';
          await archive.gzip(
            { vfs: ctx.vfs, path: src }, { vfs: ctx.vfs, path: dst });
          if (!keep) try { await ctx.vfs.unlink(src); } catch {}
        }
      }
    } catch (e) {
      await ctx.stderr(`gzip: ${f}: ${e.message || e}\n`);
      anyError = 1;
    }
  }
  return anyError;
}

async function _gzip(argv, ctx)   { return _gzipImpl(argv, ctx, false); }
async function _gunzip(argv, ctx) { return _gzipImpl(argv, ctx, true);  }

// ── zstd / unzstd ───────────────────────────────────────────────────────
// Same shape as gzip but compress isn't available (fzstd is decode-only).
// In v0 zstd without -d returns a clear error pointing at the gap.

async function _zstdImpl(argv, ctx, defaultDecompress) {
  let decompress = defaultDecompress;
  let keep = false;
  let toStdout = false;
  let positionals = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (a === '-' || !a.startsWith('-')) { positionals.push(a); continue; }
    for (const ch of a.slice(1)) {
      if (ch === 'd') decompress = true;
      else if (ch === 'k') keep = true;
      else if (ch === 'c') toStdout = true;
      else if (ch >= '0' && ch <= '9') { /* level ignored */ }
      else { await ctx.stderr(`zstd: unknown option -${ch}\n`); return 2; }
    }
  }

  if (!decompress) {
    await ctx.stderr('zstd: encode not available in this build (fzstd is decode-only). '
      + 'Use gzip / tar.gz for compression for now.\n');
    return 1;
  }
  if (!ctx.vfs) { await ctx.stderr('zstd: no VFS configured\n'); return 1; }
  if (positionals.length === 0) {
    await ctx.stderr('zstd: stdin/stdout mode not yet implemented; supply a FILE\n');
    return 2;
  }

  const archive = await _requireArchive(ctx, 'zstd'); if (!archive) return 127;

  let anyError = 0;
  for (const f of positionals) {
    const src = _arResolvePath(f, ctx);
    try {
      if (toStdout) {
        const map = await archive.unzstd(
          { vfs: ctx.vfs, path: src }, 'memory');
        const [, bytes] = [...map.entries()][0];
        await ctx.stdout(new TextDecoder().decode(bytes));
      } else {
        const dst = src.replace(/\.zst$/i, '');
        if (dst === src) {
          await ctx.stderr(`zstd: ${f}: not a .zst file\n`);
          anyError = 1; continue;
        }
        await archive.unzstd(
          { vfs: ctx.vfs, path: src }, { vfs: ctx.vfs, path: dst });
        if (!keep) try { await ctx.vfs.unlink(src); } catch {}
      }
    } catch (e) {
      await ctx.stderr(`zstd: ${f}: ${e.message || e}\n`);
      anyError = 1;
    }
  }
  return anyError;
}

async function _zstd(argv, ctx)   { return _zstdImpl(argv, ctx, false); }
async function _unzstd(argv, ctx) { return _zstdImpl(argv, ctx, true);  }

// ── zip / unzip ─────────────────────────────────────────────────────────
//
// zip [-r] [-N] FILE.zip paths...
//   -r recurse — we always recurse in v0; flag accepted for compatibility
//   -0..-9  level (forwarded to fflate)
//
// unzip [-l | -p] [-d DIR] [-o] FILE.zip [paths...]
//   -l  list, don't extract       -p  print one entry to stdout
//   -d  destination directory    -o  overwrite without prompt

async function _zip(argv, ctx) {
  let level = 6;
  let positionals = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (a === '-' || !a.startsWith('-')) { positionals.push(a); continue; }
    for (const ch of a.slice(1)) {
      if (ch === 'r') { /* always recursive */ }
      else if (ch >= '0' && ch <= '9') level = ch.charCodeAt(0) - 48;
      else { await ctx.stderr(`zip: unknown option -${ch}\n`); return 2; }
    }
  }
  if (!ctx.vfs)               { await ctx.stderr('zip: no VFS configured\n'); return 1; }
  if (positionals.length < 2) { await ctx.stderr('zip: need FILE.zip + at least one path\n'); return 2; }

  const archive = await _requireArchive(ctx, 'zip'); if (!archive) return 127;

  const dst = _arResolvePath(positionals[0], ctx);
  const sources = positionals.slice(1);
  try {
    const writer = archive.createWriter(
      { vfs: ctx.vfs, path: dst }, { format: 'zip', level });
    const walkVfsTree = await _loadWalk();
    if (!walkVfsTree) throw new Error('@gcu/archive walker not available');
    for (const src of sources) {
      const srcAbs = _arResolvePath(src, ctx);
      const entries = await walkVfsTree(ctx.vfs, srcAbs);
      const prefix = _arBasename(srcAbs);
      for (const e of entries) {
        const archivePath = prefix ? `${prefix}/${e.path}` : e.path;
        if (e.type === 'directory') await writer.addDirectory(archivePath);
        else                         await writer.addFile(archivePath, e.bytes);
      }
    }
    await writer.close();
    return 0;
  } catch (e) {
    await ctx.stderr(`zip: ${e.message || e}\n`);
    return 1;
  }
}

async function _unzip(argv, ctx) {
  let list = false, toStdout = false, overwrite = false;
  let dest = null;
  let positionals = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (a === '-' || !a.startsWith('-')) { positionals.push(a); continue; }
    const cluster = a.slice(1);
    let skip = false;
    for (let k = 0; k < cluster.length && !skip; k++) {
      const ch = cluster[k];
      if (ch === 'l') list = true;
      else if (ch === 'p') toStdout = true;
      else if (ch === 'o') overwrite = true;
      else if (ch === 'd') {
        // -dDIR (inline) or -d DIR (next arg).
        const rest = cluster.slice(k + 1);
        dest = rest || argv[++i] || null;
        skip = true;
      }
      else { await ctx.stderr(`unzip: unknown option -${ch}\n`); return 2; }
    }
  }

  if (!ctx.vfs)              { await ctx.stderr('unzip: no VFS configured\n'); return 1; }
  if (positionals.length === 0) { await ctx.stderr('unzip: need FILE.zip\n'); return 2; }

  const archive = await _requireArchive(ctx, 'unzip'); if (!archive) return 127;

  const src = _arResolvePath(positionals[0], ctx);
  const innerPaths = positionals.slice(1);

  try {
    if (list) {
      const entries = await archive.list({ vfs: ctx.vfs, path: src });
      await _print(ctx, _formatListing(entries, { verbose: true }));
      return 0;
    }
    if (toStdout) {
      // -p prints the named entries to stdout. With no entries listed,
      // print all of them. Text-only — binary entries print as garbled
      // strings, same as real unzip.
      const targets = innerPaths.length > 0
        ? innerPaths
        : (await archive.list({ vfs: ctx.vfs, path: src }))
            .filter(e => e.type === 'file').map(e => e.path);
      for (const p of targets) {
        const bytes = await archive.read({ vfs: ctx.vfs, path: src }, p);
        if (bytes) await ctx.stdout(new TextDecoder().decode(bytes));
      }
      return 0;
    }
    // Extract — into -d DIR, into a sibling-named dir if dest unset, or
    // into cwd. Match the convention of common unzip wrappers.
    let destPath;
    if (dest) destPath = _arResolvePath(dest, ctx);
    else      destPath = ctx.cwd || '/';
    await archive.extract(
      { vfs: ctx.vfs, path: src },
      { vfs: ctx.vfs, path: destPath },
      { overwrite: overwrite ? 'overwrite' : 'rename' }
    );
    return 0;
  } catch (e) {
    await ctx.stderr(`unzip: ${e.message || e}\n`);
    return 1;
  }
}

// ── Public ──────────────────────────────────────────────────────────────

export function archiveBuiltins() {
  return {
    tar:    _tar,
    gzip:   _gzip,
    gunzip: _gunzip,
    zstd:   _zstd,
    unzstd: _unzstd,
    zip:    _zip,
    unzip:  _unzip,
  };
}
