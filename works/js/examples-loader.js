// Decompress the examples payload that build.js --target=works-all
// embedded into works-all.html, populating /usr/share/examples/ in the
// workspace VFS so the Help → Open example… menu can pick from them.
//
// /usr is a volatile MemoryBackend (workspace.js): the shell repopulates
// it on every boot, examples never leak into workspace exports, fresh on
// every reload.
//
// This is a no-op for the regular --target=works build (no payload tag
// in the DOM); only works-all.html carries the bundle.

import { WKS } from './state.js';

let _manifest = null;
export function getExamplesManifest() { return _manifest; }
export function hasExamples() { return _manifest != null; }

async function _decompressExamples() {
  const el = document.getElementById('examples-payload');
  if (!el) return null;
  const bytes = Uint8Array.from(
    atob(el.textContent.replace(/\s/g, '')), (c) => c.charCodeAt(0));
  const text = await new Response(
    new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  return JSON.parse(text);
}

export async function installExamplesToVfs(vfs) {
  if (!vfs) return;
  const payload = await _decompressExamples();
  if (payload) {
    _manifest = payload.manifest || { categories: {} };
    await vfs.mkdir('/usr/share/examples', { recursive: true }).catch(() => {});
    for (const [relPath, content] of Object.entries(payload.defs || {})) {
      const fullPath = '/usr/share/examples/' + relPath;
      const dir = fullPath.slice(0, fullPath.lastIndexOf('/'));
      await vfs.mkdir(dir, { recursive: true }).catch(() => {});
      await vfs.writeFile(fullPath, content);
    }
    await vfs.writeFile('/usr/share/examples/manifest.json',
      JSON.stringify(_manifest));
  }
  // After the works-all baked payload (if any), rehydrate the volatile
  // /usr/share/examples/<slug>/ trees from each gcupkg-installed extension's
  // persistent /lib/<name>/examples/ — this is what makes previously-
  // installed extensions' examples survive page reload.
  try {
    await scanLibExamples(vfs);
  } catch (e) {
    console.warn('[examples-loader] /lib scan failed:', e);
  }
}

// Walk /lib for gcupkg-installed extensions with persisted examples,
// copy each into /usr/share/examples/<slug>/, and merge their per-
// extension manifests into the picker. The /lib copies are the source
// of truth (persistent, IDB-backed); /usr/share/ is just the picker's
// scratch view. Called from installExamplesToVfs at boot and idempotent
// — re-scanning replaces prior entries via mergeExamplesFromExtension.
async function scanLibExamples(vfs) {
  let lockfile;
  try {
    const raw = await vfs.readFile('/lib/.gcu-lock.json', 'utf8');
    lockfile = JSON.parse(raw);
  } catch {
    return;  // no /lib lockfile — nothing installed via pkg/gcupkg
  }
  if (!lockfile || !lockfile.modules) return;
  for (const [name, meta] of Object.entries(lockfile.modules)) {
    // Only gcupkg-installed entries have persistent examples; pkg-installed
    // (url-fetched) entries don't ship examples.
    if (!meta || meta.kind !== 'gcupkg') continue;
    const libPath = _libPathForName(name);
    const libExamples = libPath + '/examples';
    const slug = name.replace(/\//g, '_');
    const usrRoot = '/usr/share/examples/' + slug;
    let files;
    try { files = await vfs.readdir(libExamples); }
    catch { continue; }
    if (!files || files.length === 0) continue;
    await vfs.mkdir(usrRoot, { recursive: true }).catch(() => {});
    for (const file of files) {
      try {
        const bytes = await vfs.readFile(libExamples + '/' + file, 'bytes');
        await vfs.writeFile(usrRoot + '/' + file, bytes);
      } catch (e) {
        console.warn('[examples-loader] could not rehydrate', libExamples + '/' + file, e);
      }
    }
    try { await mergeExamplesFromExtension(vfs, slug); }
    catch (e) { console.warn('[examples-loader] merge failed for', slug, e); }
  }
}

// Mirror the gcupkg installer's lib-path convention (src/js/gcupkg.js).
// Kept local so this module doesn't reach into gcupkg internals just for
// the path mapping.
function _libPathForName(name) {
  if (/^@[\w.-]+\/[\w.-]+$/.test(name)) return '/lib/' + name;
  return '/lib/local/' + name;
}

// Merge an installed-extension's examples into the picker manifest.
//
// Called after a .gcupkg install lands files in /usr/share/examples/<slug>/.
// The per-extension manifest.json shape (per EXTENSION_SPEC §6.3) is:
//   { examples: [ { file, title?, category?, description? }, ... ] }
//
// We translate each entry to the works-all shape the picker expects:
//   manifest.categories[<cat>][i] = { file: '<slug>/<file>', title, description }
//
// `<slug>` defaults to the @scope_name-style directory name. Defaults
// category to the slug when the entry doesn't specify one.
//
// Idempotent: re-running for the same slug replaces its prior entries
// rather than duplicating them.
export async function mergeExamplesFromExtension(vfs, slug) {
  if (!vfs || !slug) return 0;
  const extRoot = '/usr/share/examples/' + slug;

  // Read the per-extension manifest; bail silently if it's not there
  // (extension shipped examples without a manifest — acceptable, but
  // we don't auto-discover .txt files in that case, to avoid surprising
  // the user with raw filenames as titles).
  let extManifest;
  try {
    const raw = await vfs.readFile(extRoot + '/manifest.json', 'utf8');
    extManifest = JSON.parse(raw);
  } catch {
    return 0;
  }
  const entries = Array.isArray(extManifest.examples) ? extManifest.examples : [];
  if (entries.length === 0) return 0;

  // Ensure the picker manifest exists. In plain `works` builds (not
  // works-all), _manifest is null until the first extension installs
  // examples; this initialization makes the Help → Open example menu
  // item start showing up after such an install.
  if (!_manifest) _manifest = { categories: {} };
  if (!_manifest.categories) _manifest.categories = {};

  // First pass: remove any prior entries belonging to this slug (idempotent
  // reinstall — avoids "I installed twice, why are there duplicates").
  for (const cat of Object.keys(_manifest.categories)) {
    _manifest.categories[cat] = _manifest.categories[cat].filter(
      (e) => !e.file || !e.file.startsWith(slug + '/'));
    if (_manifest.categories[cat].length === 0) delete _manifest.categories[cat];
  }

  // Second pass: insert new entries.
  let added = 0;
  for (const entry of entries) {
    if (!entry || typeof entry.file !== 'string') continue;
    const category = entry.category || slug;
    const row = {
      file:        slug + '/' + entry.file,
      title:       entry.title || entry.file,
      description: entry.description || '',
    };
    if (!_manifest.categories[category]) _manifest.categories[category] = [];
    _manifest.categories[category].push(row);
    added++;
  }

  // Persist the updated manifest so reloads pick it up. (The bulk
  // works-all defs aren't re-extracted; only the manifest changes.)
  try {
    await vfs.writeFile('/usr/share/examples/manifest.json',
      JSON.stringify(_manifest));
  } catch { /* non-fatal */ }

  return added;
}

// Remove an extension's examples from the picker (called by future
// uninstall flows; currently unused but cheap to maintain alongside the
// merge function).
export function removeExtensionExamples(slug) {
  if (!_manifest || !_manifest.categories || !slug) return 0;
  let removed = 0;
  for (const cat of Object.keys(_manifest.categories)) {
    const before = _manifest.categories[cat].length;
    _manifest.categories[cat] = _manifest.categories[cat].filter(
      (e) => !e.file || !e.file.startsWith(slug + '/'));
    removed += before - _manifest.categories[cat].length;
    if (_manifest.categories[cat].length === 0) delete _manifest.categories[cat];
  }
  return removed;
}
