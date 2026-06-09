// Pre-install distribution-shipped packages into /lib at boot.
//
// works/works-all bake a "builtin packages" payload (build.js); works-core
// omits it (that's the leanness). The payload is a gzipped JSON
// { version, packages: [ { name, version, files: { rel → content } } ] }.
// At boot we unpack each package into /lib/<pkg>/ and record it in the
// /lib lockfile with kind:'builtin', so the shell's surface scan
// (evaluateAllWorksScripts) and service scan (extension-services.js) pick
// it up exactly like a user-installed .gcupkg — /lib is the unified package
// root (works-contribution-registry-spec).
//
// Residency model: builtins self-heal/upgrade by version (write-if-absent-or-
// stale) and NEVER clobber a user install of the same name (kind !== 'builtin'
// wins). A works-core user who later installs @gcu/workbench from the registry
// gets the identical /lib shape — same code path, no special-casing.

import { WKS } from './state.js';

const LOCK_PATH = '/lib/.gcu-lock.json';

// /lib/<scope>/<name> for scoped names; /lib/local/<name> for bare ones.
// Mirrors _libPathForName in src/js/gcupkg.js + extension-loader.js.
function _libPathFor(name) {
  if (/^@[\w.-]+\/[\w.-]+$/.test(name)) return '/lib/' + name;
  return '/lib/local/' + name;
}

// Numeric semver compare — true when `a` is strictly newer than `b`. Pre-1.0
// so a dotted-numeric compare (ignoring pre-release tags) is enough.
function _isNewer(a, b) {
  if (!b) return true;
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

async function _decompressEl(el) {
  const bytes = Uint8Array.from(
    atob(el.textContent.replace(/\s/g, '')), (c) => c.charCodeAt(0));
  return new Response(
    new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

async function _readLock(vfs) {
  try { return JSON.parse(await vfs.readFile(LOCK_PATH, 'utf8')); }
  catch { return { version: 1, modules: {} }; }
}

// Decompress the baked builtin-packages payload (if any) and seed /lib. No-op
// when the payload tag is absent (works-core) or the VFS isn't ready.
export async function installBuiltinPackages(vfs) {
  if (!vfs) return;
  const el = document.getElementById('pkg-builtins-payload');
  if (!el) return;

  let payload;
  try { payload = JSON.parse(await _decompressEl(el)); }
  catch (e) { console.warn('[works] builtin-packages: payload decode failed:', e); return; }

  const packages = (payload && payload.packages) || [];
  if (packages.length === 0) return;

  const lock = await _readLock(vfs);
  if (!lock.modules || typeof lock.modules !== 'object') lock.modules = {};
  let wrote = 0, skipped = 0;

  for (const pkg of packages) {
    if (!pkg || !pkg.name || !pkg.files) continue;
    const existing = lock.modules[pkg.name];
    // A user-installed package of the same name owns the slot — never clobber it.
    if (existing && existing.kind !== 'builtin') { skipped++; continue; }
    // Already at this version (or newer) — nothing to do.
    if (existing && existing.kind === 'builtin' && !_isNewer(pkg.version, existing.version)) { skipped++; continue; }

    const libPath = _libPathFor(pkg.name);
    try {
      for (const [rel, content] of Object.entries(pkg.files)) {
        const full = libPath + '/' + rel;
        const slash = full.lastIndexOf('/');
        if (slash > 0) await vfs.mkdir(full.slice(0, slash), { recursive: true }).catch(() => {});
        await vfs.writeFile(full, content);
      }
      lock.modules[pkg.name] = {
        alias:       pkg.name,
        kind:        'builtin',
        version:     pkg.version || '0.0.0',
        installedAt: new Date().toISOString(),
        builtin:     true,
      };
      wrote++;
    } catch (e) {
      console.warn(`[works] builtin-packages: install of ${pkg.name} failed:`, e);
    }
  }

  if (wrote > 0) {
    try { await vfs.writeFile(LOCK_PATH, JSON.stringify(lock, null, 2)); }
    catch (e) { console.warn('[works] builtin-packages: lockfile write failed:', e); }
  }
  console.info(`[works] builtin packages: ${wrote} installed/updated, ${skipped} up-to-date or user-owned`);
}
