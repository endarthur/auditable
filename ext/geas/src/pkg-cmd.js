// pkg — the geas-side of the pkg-spec CLI. Lives alongside the other
// builtins so users can `pkg install npm:leaflet` from a geas terminal
// in Auditable Works or a `!pkg install ...` cell in a notebook.
//
// Spec: spec_inbox/auditable-pkg-spec.md.
//
// Subcommands (v1):
//   pkg install <alias>      — fetch, verify, write to /lib + lockfile;
//                              also fetches package.json + LICENSE from the
//                              registry CDN so aggregateLicenses picks it up
//   pkg install              — restore every entry from /lib/.gcu-lock.json
//   pkg list                 — list installed modules with SPDX badges
//   pkg licenses             — aggregate license table across the workspace
//                              (delegates to @gcu/licenses aggregateLicenses)
//   pkg freeze               — print the workspace lockfile
//   pkg remove <alias>       — drop the entry + its /lib directory
//   pkg help                 — usage
//
// v1 always installs to workspace /lib. The --project flag (per-notebook
// installs to /projects/self/lib/) is deferred — needs the cell-side
// install() builtin to coordinate, which is its own design step.

const LIB_ROOT = '/lib';
const LOCKFILE = LIB_ROOT + '/.gcu-lock.json';

// pkg-spec §3.3 alias prefixes → URLs. Duplicated from
// src/js/cell-builtins/modules.js (different package; coreutils
// extraction will deduplicate later).
function _aliasToUrl(key) {
  if (key.startsWith('npm:'))   return { url: 'https://esm.sh/' + key.slice(4) };
  if (key.startsWith('jsr:'))   return { url: 'https://esm.sh/jsr/' + key.slice(4) };
  if (key.startsWith('gh:'))    return { url: 'https://esm.sh/gh/' + key.slice(3) };
  if (key.startsWith('@gcu/'))  return { url: 'https://esm.sh/' + key + '/bundled',
                                         fallback: 'https://esm.sh/' + key };
  if (/^@[\w.-]+\/[\w.-]+$/.test(key)) return { url: 'https://esm.sh/' + key };
  return null;
}

// pkg-spec §3.1 key → /lib path. Duplicated from src/js/persist.js.
//
// Path slug is FNV-1a 32-bit hex — pure JS, deterministic, low-collision
// for the volumes we care about. Crypto-grade SHA-256 isn't required
// here (paths aren't security-sensitive), and pkg runs inside a geas
// worker which may not have crypto.subtle when the worker's blob URL
// inherits a non-secure context (file:// parents are the usual cause).
function _shortSlug(s) {
  let hash = 2166136261;   // FNV offset basis (32-bit)
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function _keyToLibPath(key) {
  if (key.startsWith('npm:'))    return LIB_ROOT + '/npm/'    + key.slice('npm:'.length);
  if (key.startsWith('jsr:'))    return LIB_ROOT + '/jsr/'    + key.slice('jsr:'.length);
  if (key.startsWith('gh:'))     return LIB_ROOT + '/gh/'     + key.slice('gh:'.length);
  if (key.startsWith('local:'))  return LIB_ROOT + '/local/'  + _shortSlug(key);
  if (key.startsWith('http://') || key.startsWith('https://'))
                                 return LIB_ROOT + '/url/'    + _shortSlug(key);
  if (/^@[\w.-]+\/[\w.-]+$/.test(key)) return LIB_ROOT + '/' + key;
  return LIB_ROOT + '/url/' + _shortSlug(key);
}

// SRI hash over the un-compressed bytes. pkg-spec §4.1. Optional — when
// the worker's context lacks crypto.subtle (blob:file:// origins),
// returns null and pkg records the install without an integrity field.
function _toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function _sha256SRI(bytes) {
  if (!globalThis.crypto || !globalThis.crypto.subtle) return null;
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return 'sha256-' + _toBase64(new Uint8Array(buf));
}

// esm.sh wrapper unwrap (bounded). Matches modules.js install path.
async function _fetchAndUnwrap(startUrl) {
  const wrapperRe = /^\s*(?:\/\*[\s\S]*?\*\/\s*)?export\s+\*\s+from\s*["']([^"']+)["'];?\s*$/;
  let currentUrl = startUrl;
  for (let hop = 0; hop < 3; hop++) {
    const resp = await fetch(currentUrl);
    if (!resp.ok) {
      if (hop === 0) return { ok: false, status: resp.status };
      throw new Error(`Failed to fetch ${currentUrl}: ${resp.status}`);
    }
    const text = await resp.text();
    const m = text.trim().match(wrapperRe);
    if (m) { currentUrl = new URL(m[1], resp.url).href; continue; }
    return { ok: true, source: text, finalUrl: resp.url };
  }
  throw new Error('Too many esm.sh wrapper redirects');
}

async function _readLockfile(vfs) {
  try {
    const raw = await vfs.readFile(LOCKFILE, 'utf8');
    const obj = JSON.parse(raw);
    if (!obj.modules || typeof obj.modules !== 'object') obj.modules = {};
    if (!obj.version) obj.version = 1;
    return obj;
  } catch { return { version: 1, modules: {} }; }
}

async function _writeLockfile(vfs, lockfile) {
  await vfs.writeFile(LOCKFILE, JSON.stringify(lockfile, null, 2));
}

// pkg install <file.gcupkg>  — sideload an extension package per
// EXTENSION_SPEC §6.1. Reads bytes from the VFS (path) or a URL (http(s):
// prefix), runs parseGcupkg + installGcupkg, prints a summary.
//
// The archive bundle is concat'd into the geas bundle (see ext/geas/build.js);
// gcupkg.js's parser takes it as a parameter. Both `archive` and
// `parseGcupkg` / `installGcupkg` are in scope by the time this runs.
async function _installGcupkgFile(ctx, source) {
  const vfs = ctx.vfs;
  if (typeof parseGcupkg !== 'function' || typeof installGcupkg !== 'function') {
    await ctx.stderr('pkg: gcupkg loader not bundled in this build\n');
    return 1;
  }
  if (typeof archive === 'undefined' || !archive) {
    await ctx.stderr('pkg: @gcu/archive not bundled (required for .gcupkg)\n');
    return 1;
  }

  // Source can be a VFS path or an http(s) URL. (Worker-relative imports
  // not supported — too risky on file:// origins.)
  let bytes;
  if (source.startsWith('http://') || source.startsWith('https://')) {
    try {
      const resp = await fetch(source);
      if (!resp.ok) { await ctx.stderr(`pkg: fetch ${source} failed (${resp.status})\n`); return 1; }
      bytes = new Uint8Array(await resp.arrayBuffer());
    } catch (e) {
      await ctx.stderr(`pkg: fetch ${source}: ${e.message}\n`);
      return 1;
    }
  } else {
    // VFS read. Pass 'bytes' encoding so the backend doesn't UTF-8 decode
    // (silent corruption of binary, same trap as the archive read path).
    try {
      bytes = await vfs.readFile(source, 'bytes');
    } catch (e) {
      await ctx.stderr(`pkg: cannot read ${source}: ${e.message}\n`);
      return 1;
    }
    if (typeof bytes === 'string') {
      // Backend ignored the 'bytes' hint — convert defensively.
      bytes = new TextEncoder().encode(bytes);
    }
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  }

  let parsed;
  try {
    parsed = await parseGcupkg(bytes, { archive });
  } catch (e) {
    await ctx.stderr(`pkg: ${e.message}\n`);
    return 1;
  }

  let result;
  try {
    result = await installGcupkg(parsed, {
      vfs,
      installedModules: (typeof window !== 'undefined' && window._installedModules) || null,
    });
  } catch (e) {
    await ctx.stderr(`pkg: installGcupkg failed: ${e.message}\n`);
    return 1;
  }

  // Summary. Includes the suggested load() calls so the user knows how
  // to reach the extension from a cell after install.
  const name = parsed.meta.name;
  const version = parsed.meta.version;
  await ctx.stdout(`installed ${name}@${version} → ${result.libPath}\n`);
  if (parsed.meta.spdx) {
    const verdict = parsed.integrity.ok === false ? ' (integrity mismatch — see meta)' : '';
    await ctx.stdout(`  license: ${parsed.meta.spdx}${verdict}\n`);
  }
  if (result.exampleCount > 0) {
    await ctx.stdout(`  examples: ${result.exampleCount} → ${result.exampleRoot}\n`);
  }
  if (result.docsCount > 0) {
    await ctx.stdout(`  docs: ${result.docsCount} → ${result.docsRoot}\n`);
  }
  await ctx.stdout(`  load: load("${name}")${result.hasAdder ? `; load("${name}/adder")` : ''}\n`);
  return 0;
}

// pkg install <alias>  — one entry, end-to-end.
async function _installOne(ctx, alias) {
  const vfs = ctx.vfs;
  if (!vfs) { await ctx.stderr('pkg: no VFS in this context\n'); return 1; }

  // .gcupkg path — sideload an extension package. Bypasses the URL/alias
  // resolution since the bytes are already on the VFS or fetchable.
  if (alias.endsWith('.gcupkg') || alias.includes('.gcupkg?')) {
    return _installGcupkgFile(ctx, alias);
  }

  // Registry name (Works only) — a bare name (no alias-prefix, no path) may be
  // a content-registry entry. Delegate the full install to the shell via the
  // host bridge so a code extension's surfaces register live and the install
  // lands in the one ledger the Library reads. Falls through if not found.
  if (typeof ctx.host === 'function' && !alias.includes(':') && !alias.includes('/')) {
    let found;
    try { found = await _findRegistryEntry(ctx, alias); }
    catch { found = null; }
    if (found) {
      if (found.entry.kind === 'gcudat') {
        await ctx.stdout(`pkg: "${alias}" is a ${found.entry.datKind || 'data'} pack — install it from Tools → Library\n`);
        return 0;
      }
      await ctx.stdout(`installing ${alias}@${found.entry.version || '?'} from ${found.sourceName}…\n`);
      let dest;
      try { dest = await ctx.host('RegistryInstall', [found.source, alias]); }
      catch (e) { await ctx.stderr(`pkg: ${e.message}\n`); return 1; }
      if (!dest) { await ctx.stderr('pkg: install cancelled\n'); return 1; }
      await ctx.stdout(`installed ${alias} → ${dest}\n  (reload Works if its surfaces don't appear)\n`);
      return 0;
    }
  }

  let url, fallback;
  if (alias.startsWith('local:')) {
    // local: — read the surface VFS, no fetch.
    const fsPath = alias.slice('local:'.length);
    let source;
    try { source = await vfs.readFile(fsPath, 'utf8'); }
    catch (e) { await ctx.stderr(`pkg: cannot read ${fsPath}: ${e.message}\n`); return 1; }
    const dir = _keyToLibPath(alias);
    await vfs.mkdir(dir, { recursive: true }).catch(() => {});
    await vfs.writeFile(dir + '/source', source);
    const meta = { alias, url: alias, kind: 'local',
      installedAt: new Date().toISOString(), size: source.length };
    await vfs.writeFile(dir + '/meta.json', JSON.stringify(meta));
    const lockfile = await _readLockfile(vfs);
    lockfile.modules[alias] = meta;
    await _writeLockfile(vfs, lockfile);
    await ctx.stdout(`installed ${alias} (${source.length} bytes, local)\n`);
    return 0;
  }

  if (alias.startsWith('http://') || alias.startsWith('https://')) {
    url = alias;
  } else {
    const r = _aliasToUrl(alias);
    if (!r) { await ctx.stderr(`pkg: don't know how to resolve "${alias}"\n`); return 1; }
    url = r.url; fallback = r.fallback;
  }

  let result;
  try { result = await _fetchAndUnwrap(url); }
  catch (e) { await ctx.stderr(`pkg: ${e.message}\n`); return 1; }
  if (!result.ok && fallback) {
    try { result = await _fetchAndUnwrap(fallback); }
    catch (e) { await ctx.stderr(`pkg: ${e.message}\n`); return 1; }
  }
  if (!result.ok) {
    await ctx.stderr(`pkg: fetch ${url} failed (${result.status})\n`);
    return 1;
  }

  const source = result.source;
  const finalUrl = result.finalUrl;
  const sourceBytes = new TextEncoder().encode(source);
  const integrity = await _sha256SRI(sourceBytes);

  const dir = _keyToLibPath(alias);
  await vfs.mkdir(dir, { recursive: true }).catch(() => {});
  await vfs.writeFile(dir + '/source', source);
  const meta = { alias, url: finalUrl, kind: 'js',
    installedAt: new Date().toISOString(), size: sourceBytes.length };
  if (integrity) meta.integrity = integrity;

  // Best-effort license capture — fetches package.json + LICENSE from the
  // registry's CDN (esm.sh → jsdelivr for npm, jsr.io for jsr, etc.) via
  // the @gcu/licenses URL-aware handlers. Writes both files alongside the
  // source so aggregateLicenses(vfs)'s walkLib picks the entry up without
  // any pkg-specific knowledge. Records a small license hint on meta so
  // `pkg list` can show it without re-traversing the FS.
  //
  // Failures here are NEVER fatal to the install — the package is already
  // on disk; the licence info is enrichment.
  const licInfo = await _captureLicense(ctx, dir, finalUrl);
  if (licInfo) meta.license = licInfo;

  await vfs.writeFile(dir + '/meta.json', JSON.stringify(meta));

  const lockfile = await _readLockfile(vfs);
  lockfile.modules[alias] = meta;
  await _writeLockfile(vfs, lockfile);

  await ctx.stdout(`installed ${alias} (${sourceBytes.length} bytes) → ${finalUrl}\n`);
  if (licInfo && licInfo.spdx) {
    await ctx.stdout(`  license: ${licInfo.spdx}${licInfo.spdxSource ? ` (${licInfo.spdxSource})` : ''}\n`);
  }
  return 0;
}

// Resolve @gcu/licenses symbols. In the geas worker bundle they're
// IIFE-isolated and re-exposed under `_lic`-prefixed names (to avoid
// collisions with same-named geas symbols — tokenize, formatTable);
// outside that context (tests, dev tooling) callers can inject via
// globalThis. Returns null when no source has the symbol.
function _resolveLicensesSym(name) {
  // The bare references must be wrapped in typeof to be safe when undeclared
  // (typeof of an unresolvable reference returns 'undefined', never throws).
  if (name === 'fetchLicense') {
    if (typeof _licFetchLicense === 'function') return _licFetchLicense;
    if (typeof fetchLicense === 'function') return fetchLicense;
  } else if (name === 'aggregateLicenses') {
    if (typeof _licAggregateLicenses === 'function') return _licAggregateLicenses;
    if (typeof aggregateLicenses === 'function') return aggregateLicenses;
  } else if (name === 'formatTable') {
    if (typeof _licFormatTable === 'function') return _licFormatTable;
    if (typeof formatTable === 'function') return formatTable;
  }
  if (typeof globalThis !== 'undefined' && typeof globalThis[name] === 'function') {
    return globalThis[name];
  }
  return null;
}

// _captureLicense — best-effort. Returns the meta hint to store, or null
// on any failure (network, missing registry support, etc.). Always swallows
// errors; the install continues regardless.
//
// Writes two artifacts to <dir> when available:
//   <dir>/package.json  — minimal { name, version, license } so walkLib's
//                          spdxFromPackageJson picks it up
//   <dir>/LICENSE       — raw license text
//
// Returns the small hint:
//   { spdx, spdxSource, fetchedFrom, copyright? }
async function _captureLicense(ctx, dir, finalUrl) {
  const fetchLic = _resolveLicensesSym('fetchLicense');
  if (!fetchLic) return null;  // licenses bundle not loaded
  let result;
  try {
    result = await fetchLic(finalUrl);
  } catch (e) {
    // network / parsing failure — silent.
    return null;
  }
  if (!result) return null;

  // Persist what we have. package.json shape mirrors the minimal subset
  // walkLib's spdxFromPackageJson reads — name + version + license.
  if (result.spdx) {
    const pkgJson = {
      name: result.pkg || null,
      version: result.version || null,
      license: result.spdx,
    };
    try { await ctx.vfs.writeFile(dir + '/package.json', JSON.stringify(pkgJson, null, 2)); }
    catch { /* non-fatal */ }
  }
  if (result.text) {
    try { await ctx.vfs.writeFile(dir + '/LICENSE', result.text); }
    catch { /* non-fatal */ }
  }

  return {
    spdx: result.spdx || null,
    spdxSource: result.spdxSource || null,
    fetchedFrom: result.fetchedFrom || null,
    copyright: result.copyright || null,
  };
}

// pkg install (no args) — restore every entry from the lockfile.
async function _installFromLockfile(ctx) {
  const vfs = ctx.vfs;
  const lockfile = await _readLockfile(vfs);
  const aliases = Object.keys(lockfile.modules);
  if (aliases.length === 0) {
    await ctx.stdout('pkg: lockfile is empty\n');
    return 0;
  }
  let failed = 0;
  for (const alias of aliases) {
    const rc = await _installOne(ctx, alias);
    if (rc !== 0) failed++;
  }
  if (failed > 0) {
    await ctx.stderr(`pkg: ${failed}/${aliases.length} installs failed\n`);
    return 1;
  }
  return 0;
}

async function _list(ctx) {
  const lockfile = await _readLockfile(ctx.vfs);
  const aliases = Object.keys(lockfile.modules).sort();
  if (aliases.length === 0) {
    await ctx.stdout('(no modules installed)\n');
    return 0;
  }
  for (const alias of aliases) {
    const m = lockfile.modules[alias];
    const size = m.size ? `${m.size}b` : '?';
    const kind = m.kind || '?';
    const spdx = (m.license && m.license.spdx) ? m.license.spdx : '-';
    await ctx.stdout(`${alias.padEnd(30)}  ${kind.padEnd(6)}  ${spdx.padEnd(14)}  ${size}\n`);
  }
  return 0;
}

// pkg licenses — aggregate license table over the workspace VFS, formatted
// for the terminal. Picks up everything walkLib + walkVarModules + walkSys
// reach (pkg-managed /lib, install()'d /var/modules, build-time /sys/licenses).
async function _licenses(ctx) {
  const agg = _resolveLicensesSym('aggregateLicenses');
  const fmt = _resolveLicensesSym('formatTable');
  if (!agg || !fmt) {
    await ctx.stderr('pkg: @gcu/licenses not loaded in this build\n');
    return 1;
  }
  let table;
  try { table = await agg(ctx.vfs); }
  catch (e) {
    await ctx.stderr(`pkg: aggregateLicenses failed: ${e.message || e}\n`);
    return 1;
  }
  if (!table || table.length === 0) {
    await ctx.stdout('(no licensed components found)\n');
    return 0;
  }
  await ctx.stdout(fmt(table, { format: 'text' }) + '\n');
  return 0;
}

async function _freeze(ctx) {
  const lockfile = await _readLockfile(ctx.vfs);
  await ctx.stdout(JSON.stringify(lockfile, null, 2) + '\n');
  return 0;
}

async function _remove(ctx, alias) {
  const vfs = ctx.vfs;
  const lockfile = await _readLockfile(vfs);
  if (!(alias in lockfile.modules)) {
    await ctx.stderr(`pkg: ${alias} not installed\n`);
    return 1;
  }
  const dir = _keyToLibPath(alias);
  try { await vfs.rm(dir, { recursive: true }); }
  catch (e) { /* directory may not exist if lockfile drifted */ }
  delete lockfile.modules[alias];
  await _writeLockfile(vfs, lockfile);
  await ctx.stdout(`removed ${alias}\n`);
  return 0;
}

// ── content registry (Works only — via the host-RPC bridge) ──────────
// The geas worker can't see the registry's source list (shell meta) or run a
// full shell-side install (surface registration), so these delegate to the
// `works` Shell through ctx.host. Absent host bridge → "Works only".
async function _eachRegistryEntry(ctx, fn) {
  const sources = await ctx.host('RegistrySources');
  for (const s of (sources || [])) {
    let reg;
    try { reg = (await ctx.host('RegistryFetch', [s.url])).registry; }
    catch { continue; }
    for (const e of (reg.entries || [])) await fn(e, s);
  }
}

async function _search(ctx, query) {
  if (typeof ctx.host !== 'function') { await ctx.stderr('pkg search: the content registry is only available in Auditable Works\n'); return 1; }
  const q = (query || '').toLowerCase().trim();
  let any = false;
  try {
    await _eachRegistryEntry(ctx, async (e, s) => {
      const hay = ((e.title || '') + ' ' + (e.name || '') + ' ' + (e.description || '') + ' ' + (e.tags || []).join(' ') + ' ' + (e.datKind || '')).toLowerCase();
      if (q && !hay.includes(q)) return;
      any = true;
      const kind = e.kind === 'gcupkg' ? 'ext' : (e.datKind || 'data');
      await ctx.stdout(`${String(e.name || '').padEnd(18)} ${String(e.version || '').padEnd(8)} ${kind.padEnd(5)} ${e.title || ''}  (${s.name || s.url})\n`);
    });
  } catch (e) { await ctx.stderr(`pkg search: ${e.message}\n`); return 1; }
  if (!any) await ctx.stdout(q ? 'no matches.\n' : '(no registry entries)\n');
  return 0;
}

async function _sources(ctx) {
  if (typeof ctx.host !== 'function') { await ctx.stderr('pkg sources: the content registry is only available in Auditable Works\n'); return 1; }
  let sources;
  try { sources = await ctx.host('RegistrySources'); }
  catch (e) { await ctx.stderr(`pkg sources: ${e.message}\n`); return 1; }
  if (!sources || !sources.length) { await ctx.stdout('(no sources configured)\n'); return 0; }
  for (const s of sources) await ctx.stdout(`${String(s.name || s.url).padEnd(22)} ${s.url}\n`);
  return 0;
}

// Find a registry entry by exact name across configured sources.
async function _findRegistryEntry(ctx, name) {
  let hit = null;
  await _eachRegistryEntry(ctx, async (e, s) => { if (!hit && e.name === name) hit = { entry: e, source: s.url, sourceName: s.name || s.url }; });
  return hit;
}

async function _help(ctx) {
  await ctx.stdout([
    'usage: pkg <subcommand> [args...]',
    '',
    'subcommands:',
    '  install <name>             install a registry entry by name (Works)',
    '  install <alias>            fetch + verify, write to /lib + lockfile',
    '  install <path.gcupkg>      sideload a packed extension (EXTENSION_SPEC §6.1)',
    '  install                    re-install every entry from /lib/.gcu-lock.json',
    '  search [query]             search the content registry (Works)',
    '  sources                    list configured registry sources (Works)',
    '  list                       list installed modules with SPDX badges',
    '  licenses                   aggregate license table across the workspace',
    '  freeze                     print the workspace lockfile',
    '  remove <alias>             delete the entry + its /lib directory',
    '  help                       show this message',
    '',
    'alias prefixes (pkg-spec §3.3):',
    '  @gcu/<name>         GCU package via esm.sh',
    '  npm:<name>          npm package via esm.sh',
    '  jsr:<name>          jsr.io package via esm.sh',
    '  gh:<user>/<repo>    GitHub repo via esm.sh',
    '  local:/<vfs-path>   surface VFS, no integrity, no caching',
    '  /path.gcupkg        VFS-path .gcupkg file — sideload',
    '  https://…/x.gcupkg  fetched .gcupkg — sideload',
    '',
  ].join('\n'));
  return 0;
}

export async function _pkg(argv, ctx) {
  const sub = argv[1];
  switch (sub) {
    case undefined:
    case 'help':
    case '-h':
    case '--help':  return _help(ctx);
    case 'install':  return argv[2] ? _installOne(ctx, argv[2]) : _installFromLockfile(ctx);
    case 'search':   return _search(ctx, argv.slice(2).join(' '));
    case 'sources':  return _sources(ctx);
    case 'list':     return _list(ctx);
    case 'licenses': return _licenses(ctx);
    case 'freeze':   return _freeze(ctx);
    case 'remove':
    case 'rm':       if (!argv[2]) { await ctx.stderr('pkg: remove needs <alias>\n'); return 1; }
                     return _remove(ctx, argv[2]);
    default:         await ctx.stderr(`pkg: unknown subcommand "${sub}" (try 'pkg help')\n`);
                     return 1;
  }
}
