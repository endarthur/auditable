// VFS-unified persistence.
//
// Cells, settings, modules, and user files all live on the VFS. The Persister
// serialises the contents of "persistent" mounts (/projects/self, /lib) into a
// single AUDITABLE-VFS comment block on save; the EncryptedPersister wraps
// that JSON in AUDITABLE-CRYPTO. Loading parses the block, hydrates the VFS,
// then a separate hydrateNotebook() pass reads /projects/self/notebook.txt to
// populate S.cells + settings + module declarations.
//
// Spec: spec_inbox/shipped/auditable-persistence-spec.md (roadmap step E).

import { $, S } from './state.js';
import { addCell } from './cell-ops.js';
import { applySettings } from './settings.js';
import { isCollapsed } from './dag.js';
import { parseNotebookTxt, serializeNotebookTxt, serializeVfs, hydrateVfs } from './serialize.js';
import { cryptoIsLocked, cryptoBuildBlock, cryptoDetect } from './crypto.js';
import { hydrateAllSavedOutputs, sweepOrphanOutputs } from './outputs.js';

export { serializeVfs, hydrateVfs };

// ── Comment-block helpers ────────────────────────────────────────────

const VFS_BLOCK_RE = /<!--AUDITABLE-VFS\n([\s\S]*?)\nAUDITABLE-VFS-->/;
const CRYPTO_BLOCK_RE = /<!--AUDITABLE-CRYPTO\n([\s\S]*?)\nAUDITABLE-CRYPTO-->/;

function _findBlock(html, re) {
  const m = html.match(re);
  return m ? m[1] : null;
}

// ── Persister classes ───────────────────────────────────────────────

export class Persister {
  async load(html) { throw new Error('not implemented'); }
  async serializeBlock(vfs) { throw new Error('not implemented'); }
  isEncrypted() { return false; }
  isLocked() { return false; }
}

export class CleartextPersister extends Persister {
  async load(html) {
    const raw = _findBlock(html, VFS_BLOCK_RE);
    if (!raw) return null;
    try { return JSON.parse(raw); }
    catch (e) { console.error('[persist] AUDITABLE-VFS parse error:', e); return null; }
  }
  async serializeBlock(vfs) {
    const dump = await serializeVfs(vfs);
    return '<!-- auditable notebook data: VFS dump (persistent mounts only) -->\n'
         + '<!--AUDITABLE-VFS\n' + JSON.stringify(dump) + '\nAUDITABLE-VFS-->';
  }
}

export class EncryptedPersister extends Persister {
  constructor() { super(); this._cachedDump = null; }
  async load(html) {
    // After unlock, the cached dump is the decrypted payload.
    return this._cachedDump;
  }
  setCachedDump(dump) { this._cachedDump = dump; }
  async serializeBlock(vfs) {
    const dump = await serializeVfs(vfs);
    const block = await cryptoBuildBlock(JSON.stringify(dump));
    return '<!-- encrypted notebook data: passphrase required to access cells, settings, modules, files -->\n'
         + '<!--AUDITABLE-CRYPTO\n' + JSON.stringify(block) + '\nAUDITABLE-CRYPTO-->';
  }
  isEncrypted() { return true; }
  isLocked() { return cryptoIsLocked(); }
}

// ── Factory ──────────────────────────────────────────────────────────

let _activePersister = null;

export function makePersister(html) {
  const detected = cryptoDetect(html || '');
  _activePersister = detected.found ? new EncryptedPersister() : new CleartextPersister();
  return _activePersister;
}

export function getPersister() {
  if (!_activePersister) _activePersister = new CleartextPersister();
  return _activePersister;
}

// ── Module storage sync (window._installedModules ↔ /lib/) ──
//
// pkg-spec §3.1 layout: /lib/ is sub-namespaced by source.
//   /lib/@gcu/spinifex/         gentropic.org-hosted
//   /lib/npm/leaflet/           npm via esm.sh
//   /lib/jsr/@hono/hono/        jsr.io via esm.sh
//   /lib/gh/user/repo/          GitHub via esm.sh
//   /lib/local/<hash>/          local: dev installs (hash of VFS path)
//   /lib/url/<hash>/            raw URL, no matching prefix
// Each leaf has source + meta.json; meta.json records the user-facing alias
// and the resolved URL. window._installedModules keys remain user-facing
// (alias or URL) — keyToLibPath turns them into paths, libPathToKey reverses.
//
// Legacy layout was /lib/<encodeURIComponent(url)>/ (flat). Hydrate still
// reads it; sync only writes the new layout — saved notebooks self-upgrade.

const MODULES_DIR = '/lib';
// In Works, the shell exposes bundled libs at /usr/lib (Unix-style
// "system-provided"); hydrate reads both, /lib shadows /usr/lib so a user
// install wins over a builtin. Standalone notebooks see /lib only.
const BUILTIN_MODULES_DIR = '/usr/lib';
const _enc = encodeURIComponent;
const _dec = decodeURIComponent;

// Path slug: pure-JS FNV-1a 32-bit hex. Crypto-grade SHA-256 isn't
// required for paths (they aren't security-sensitive), and the geas
// worker that mirrors keyToLibPath in pkg-cmd.js may not have
// crypto.subtle when its blob-URL context isn't secure (file:// parents
// are the usual cause). Same hash everywhere for portability.
function _shortSlug(s) {
  let hash = 2166136261;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// Map a user-facing key (alias or URL) to its on-disk /lib subpath.
export function keyToLibPath(key, root = MODULES_DIR) {
  if (key.startsWith('npm:'))    return root + '/npm/'    + key.slice('npm:'.length);
  if (key.startsWith('jsr:'))    return root + '/jsr/'    + key.slice('jsr:'.length);
  if (key.startsWith('gh:'))     return root + '/gh/'     + key.slice('gh:'.length);
  if (key.startsWith('local:'))  return root + '/local/'  + _shortSlug(key);
  if (key.startsWith('http://') || key.startsWith('https://'))
                                 return root + '/url/'    + _shortSlug(key);
  // Scoped packages — @gcu/foo, @atra/foo, @anyscope/foo. The scope dir
  // (which already starts with @) acts as the source namespace; no extra
  // prefix needed.
  if (/^@[\w.-]+\/[\w.-]+$/.test(key)) return root + '/' + key;
  // Anything else (bare name without prefix) — treat as a URL hash. Rare.
  return root + '/url/' + _shortSlug(key);
}

// Reverse: a path under /lib (as segments after the /lib prefix) + the
// hydrated meta.json → the user-facing key. Returns null when we can't
// determine the key (e.g. /url/<hash> without an `alias` field in meta).
export function libPathToKey(segments, meta) {
  if (!segments || segments.length === 0) return null;
  const [first, ...rest] = segments;

  // Legacy single-segment <url-encoded>/ — flat layout from before pkg-spec.
  if (segments.length === 1 && first.includes('%')) {
    try { return _dec(first); } catch { return null; }
  }

  if (first === 'npm' || first === 'jsr' || first === 'gh') {
    return rest.length ? first + ':' + rest.join('/') : null;
  }
  if (first === 'url' || first === 'local') {
    return meta?.alias || meta?.url || null;
  }
  // Scoped: first starts with @, the rest is the package name (one or more
  // segments — jsr could nest @scope/name).
  if (first.startsWith('@') && rest.length) {
    return first + '/' + rest.join('/');
  }
  return null;
}

// Module-state signature: cheap fingerprint of the keys + each entry's
// content hash. We use it to skip the nuke-and-rewrite when the modules
// map hasn't changed since the last sync — autosave fires on every cell
// run, and rewriting /lib (~250 vfs ops for a 54-module workspace) on
// each one buried the iframe under VFS.Changed events. Modules only
// move on install/uninstall, so the check is cheap and skips 99% of
// the autosave traffic.
let _lastModulesSig = null;

function _modulesSignature(installedModules) {
  if (!installedModules) return '';
  // Sort keys for stable ordering across sessions. Per-entry signature
  // uses installedAt (set by install paths) as a cheap version marker,
  // plus the source length and binary flag — enough to detect the
  // entries' shape without hashing the source bytes on every call.
  const keys = Object.keys(installedModules).sort();
  const parts = [];
  for (const k of keys) {
    const v = installedModules[k];
    if (typeof v === 'string') {
      parts.push(k + ':s' + v.length);
    } else if (v && typeof v === 'object') {
      parts.push(k + ':' +
        (v.installedAt || '') + ':' +
        (v.size ?? (typeof v.source === 'string' ? v.source.length : 0)) + ':' +
        (v.binary ? 'b' : 't'));
    } else {
      parts.push(k + ':?');
    }
  }
  return parts.join('|');
}

export async function syncModulesToVfs(vfs, installedModules) {
  if (!vfs) return;

  // Idempotency: skip the nuke-and-rewrite if the modules map is
  // unchanged since the last sync. This is the difference between
  // autosave being cheap and autosave being a VFS-thrashing storm.
  const sig = _modulesSignature(installedModules);
  if (sig === _lastModulesSig) return;
  _lastModulesSig = sig;

  await vfs.mkdir(MODULES_DIR, { recursive: true }).catch(() => {});

  // Wipe the existing /lib/ tree — easier than diffing. rm -r on each
  // top-level entry handles both new (sub-namespaced) and legacy (flat) layouts.
  let existing = [];
  try { existing = await vfs.readdir(MODULES_DIR, { stat: true }); } catch {}
  for (const e of existing) {
    if (e.type === 'directory') {
      await vfs.rm(MODULES_DIR + '/' + e.name, { recursive: true }).catch(() => {});
    } else {
      await vfs.unlink(MODULES_DIR + '/' + e.name).catch(() => {});
    }
  }

  if (!installedModules) return;

  // pkg-spec §4: aggregate every (non-builtin) entry's meta into the
  // workspace lockfile at /lib/.gcu-lock.json. Built as we walk the
  // entries so we don't iterate twice.
  const lockfile = { version: 1, modules: {} };

  for (const [key, entry] of Object.entries(installedModules)) {
    // Skip builtins — they live at /usr/lib (volatile, repopulated by the
    // shell at boot). Writing them to /lib would persist them in workspace
    // exports and shadow future shell-provided versions.
    if (entry && typeof entry === 'object' && entry.builtin) continue;
    const dir = await keyToLibPath(key);
    await vfs.mkdir(dir, { recursive: true }).catch(() => {});
    if (typeof entry === 'string') {
      // legacy: bare source string
      await vfs.writeFile(dir + '/source', entry);
      await vfs.writeFile(dir + '/meta.json', JSON.stringify({ alias: key, legacy: true }));
      lockfile.modules[key] = { alias: key, legacy: true };
      continue;
    }
    if (entry && typeof entry === 'object') {
      // metadata sans `source`; always stamp the alias so url/local hashes
      // can be reversed.
      const { source, ...meta } = entry;
      if (!meta.alias) meta.alias = key;
      await vfs.writeFile(dir + '/meta.json', JSON.stringify(meta));
      if (typeof source === 'string') await vfs.writeFile(dir + '/source', source);
      // Lockfile entry mirrors meta.json minus source-data fields (cellId
      // is in-memory provenance; source is in the leaf dir already).
      const { cellId, ...lockEntry } = meta;
      lockfile.modules[key] = lockEntry;
    }
  }

  // pkg-spec §4 workspace lockfile. Pretty-printed for diff-friendliness.
  await vfs.writeFile(MODULES_DIR + '/.gcu-lock.json',
    JSON.stringify(lockfile, null, 2));
}

/**
 * Write S.cells + current settings to /projects/self/notebook.txt in /// form,
 * and ensure /projects/self/project.json exists. Called before serializeBlock()
 * so the dump reflects current runtime state.
 */
export async function syncCellsToVfs(vfs, S, settings, title) {
  await vfs.mkdir(PROJECT_DIR, { recursive: true }).catch(() => {});
  await ensureProjectJson(vfs, title);
  const cells = S.cells.map(c => ({
    id: c.id,
    type: c.type,
    code: c.code,
    collapsed: c.collapsed || undefined,
  }));
  // Skip builtins (hydrated from /usr/lib by works-all et al.) — they're
  // system-provided, not part of this notebook's own dependencies. Same
  // filter the lockfile write applies above.
  const allMods = window._installedModules || {};
  const modules = Object.keys(allMods)
    .filter(url => !(allMods[url] && typeof allMods[url] === 'object' && allMods[url].builtin))
    .map(url => ({ url }));
  const txt = serializeNotebookTxt({ title, settings, cells, modules, nextId: S.cellId });
  await vfs.writeFile(NOTEBOOK_TXT_PATH, txt);
}

/**
 * One-shot: sync runtime state (cells, settings, modules) into the VFS so
 * `serializeVfs(vfs)` produces an up-to-date dump. Called from save paths.
 */
export async function flushPendingDirty(vfs, S, settings, title) {
  await syncCellsToVfs(vfs, S, settings, title);
  await syncModulesToVfs(vfs, window._installedModules || {});
  // Sweep orphan output sidecars — catches anything the incremental
  // cleanup missed (e.g. cells removed without the runtime around to
  // see it). Best-effort.
  try { await sweepOrphanOutputs(); }
  catch (e) { console.warn('[persist] sweep orphan outputs failed:', e.message); }
}

async function _walkLibLeaves(vfs, base, segments, result) {
  let entries;
  try { entries = await vfs.readdir(base, { stat: true }); } catch { return; }

  // Leaf: a directory holding `source` and/or `meta.json` files.
  const isLeaf = entries.some(e => e.type !== 'directory'
    && (e.name === 'source' || e.name === 'meta.json'));
  if (isLeaf && segments.length > 0) {
    let meta = {};
    let source = null;
    try { meta = JSON.parse(await vfs.readFile(base + '/meta.json', 'text')); } catch {}
    try { source = await vfs.readFile(base + '/source', 'text'); } catch {}
    const key = libPathToKey(segments, meta);
    if (key !== null) {
      if (meta.legacy && source !== null) result[key] = source;
      else if (source !== null) result[key] = { ...meta, source };
      else if (Object.keys(meta).length > 0) result[key] = meta;
    }
    // Don't early-return — a leaf directory can ALSO contain nested
    // leaves (e.g. /lib/@gcu/carotte/ holds the engine at /source AND
    // a secondary entry at /adder/source). The gcupkg installer writes
    // exactly this shape per EXTENSION_SPEC §6.1. Fall through so we
    // recurse into subdirectories and discover those nested entries.
  }

  // Recurse into subdirectories — discovers nested @scope/name namespaces
  // and adapter-bridge secondaries.
  for (const e of entries) {
    if (e.type !== 'directory') continue;
    await _walkLibLeaves(vfs, base + '/' + e.name, [...segments, e.name], result);
  }
}

export async function hydrateModulesFromVfs(vfs) {
  if (!vfs) return {};
  const result = {};
  // /usr/lib first — its entries are the floor; /lib overlays them so a
  // user install of the same key shadows a shell-provided one.
  for (const dir of [BUILTIN_MODULES_DIR, MODULES_DIR]) {
    await _walkLibLeaves(vfs, dir, [], result);
  }
  return result;
}

// ── Project directory ───────────────────────────────────────────────
//
// Standalone is a workspace-of-one: the notebook's own project lives at the
// fixed path /projects/self/. In Works the surface VFS resolves `self` to the
// real project path via the A-Bus-proxy backend, so notebook code refers to
// itself by this one literal in both modes.

export const PROJECT_DIR = '/projects/self';
const NOTEBOOK_TXT_PATH = PROJECT_DIR + '/notebook.txt';
const PROJECT_JSON_PATH = PROJECT_DIR + '/project.json';

/**
 * Ensure /projects/self/project.json exists with a stable random id. The id is
 * minted once and preserved across saves; the title tracks the current document
 * title. Returns the project metadata.
 */
export async function ensureProjectJson(vfs, title) {
  let meta = null;
  try { meta = JSON.parse(await vfs.readFile(PROJECT_JSON_PATH, 'text')); }
  catch { /* not yet created */ }
  const id = (meta && meta.id) || ('nb-' + crypto.randomUUID().slice(0, 8));
  const next = { kind: 'notebook', id, title: title || 'untitled' };
  if (!meta || meta.kind !== next.kind || meta.id !== next.id || meta.title !== next.title) {
    await vfs.mkdir(PROJECT_DIR, { recursive: true }).catch(() => {});
    await vfs.writeFile(PROJECT_JSON_PATH, JSON.stringify(next, null, 2));
  }
  return next;
}

// ── Notebook hydration (post-VFS-restore) ───────────────────────────

/**
 * After hydrateVfs has populated the VFS, read /projects/self/notebook.txt and
 * populate S.cells, settings, module declarations.
 */
export async function hydrateNotebook(vfs) {
  let txt = null;
  try { txt = await vfs.readFile(NOTEBOOK_TXT_PATH, 'text'); }
  catch { /* fresh notebook */ }

  if (!txt) {
    // Fresh notebook — start with default md + code cells
    addCell('md', '');
    addCell('code', '');
    return;
  }

  const parsed = parseNotebookTxt(txt);

  if (parsed.title) {
    const titleInput = document.getElementById('docTitle');
    if (titleInput) titleInput.value = parsed.title;
    document.title = 'Auditable — ' + parsed.title;
  }
  if (parsed.settings) applySettings(parsed.settings);

  // Clean any stale DOM (native browser save leaves stale cell elements)
  const nb = document.getElementById('notebook');
  if (nb) nb.innerHTML = '';
  document.querySelectorAll('style[data-cell-id]').forEach(el => el.remove());

  // Restore the notebook's id allocator. addCell respects presetId when
  // each cell has an id= directive; for cells without one (legacy / hand-
  // edited notebook.txt), addCell falls through to the counter and
  // assigns a fresh id. Either way, S.cellId is bumped past every id
  // we've seen so subsequent adds don't collide.
  if (typeof parsed.nextId === 'number' && parsed.nextId > S.cellId) {
    S.cellId = parsed.nextId;
  }

  for (const c of parsed.cells || []) {
    const cell = addCell(c.type, c.code, null, null, c.id || null);
    if (c.collapsed || isCollapsed(c.code)) {
      cell.el.classList.add('collapsed');
      cell.collapsed = true;
    }
  }

  // Restore saved cell outputs from /projects/self/notebook.outputs/.
  // Each cell looks up its own id; if a sidecar exists, the saved output
  // gets injected into its .cell-output element. The notebook appears
  // already-run on open without any cells actually executing.
  // Best-effort — if outputs load fails we proceed without them.
  try { await hydrateAllSavedOutputs(); }
  catch (e) { console.warn('[persist] saved-output hydration failed:', e.message); }
}

// ── Legacy VFS-dump migration (pre-4a /var + /home/nb layout) ───────

/**
 * Remap an AUDITABLE-VFS dump saved under the pre-4a layout (/var/* and
 * /home/nb/*) onto the current /projects/self/ + /lib/ layout. A no-op for
 * dumps already in the new layout. Notebooks self-upgrade on next save.
 */
export function migrateLegacyDump(dump) {
  if (!dump || typeof dump !== 'object') return dump;
  const keys = Object.keys(dump);
  const isOld = keys.some(k =>
    k === '/var' || k.startsWith('/var/') ||
    k === '/home/nb' || k.startsWith('/home/nb/'));
  if (!isOld) return dump;
  const out = {};
  for (const [k, v] of Object.entries(dump)) {
    let nk = k;
    if (k === '/var/modules' || k === '/var/modules/') nk = '/lib';
    else if (k.startsWith('/var/modules/')) nk = '/lib/' + k.slice('/var/modules/'.length);
    else if (k === '/var' || k === '/var/') nk = '/projects/self';
    else if (k.startsWith('/var/')) nk = '/projects/self/' + k.slice('/var/'.length);
    else if (k === '/home/nb' || k === '/home/nb/') nk = '/projects/self';
    else if (k.startsWith('/home/nb/')) nk = '/projects/self/' + k.slice('/home/nb/'.length);
    out[nk] = v;
  }
  return out;
}

// ── Legacy 4-block import (back-compat for older saved notebooks) ───

const LEGACY_DATA_RE     = /<!--AUDITABLE-DATA\n([\s\S]*?)\nAUDITABLE-DATA-->/;
const LEGACY_SETTINGS_RE = /<!--AUDITABLE-SETTINGS\n([\s\S]*?)\nAUDITABLE-SETTINGS-->/;
const LEGACY_MODULES_RE  = /<!--AUDITABLE-MODULES\n([\s\S]*?)\nAUDITABLE-MODULES-->/;
const LEGACY_FS_RE       = /<!--AUDITABLE-FS\n([\s\S]*?)\nAUDITABLE-FS-->/;

/**
 * Detect a legacy 4-block notebook. Returns true if any of DATA/SETTINGS/
 * MODULES/FS is present and there's no AUDITABLE-VFS block.
 */
export function isLegacyFormat(html) {
  if (VFS_BLOCK_RE.test(html)) return false;
  return LEGACY_DATA_RE.test(html) || LEGACY_SETTINGS_RE.test(html);
}

/**
 * One-time migration on load: parse the four legacy comment blocks and
 * hydrate the VFS as if we'd loaded an AUDITABLE-VFS block. The Persister
 * writes the new format on next save, so legacy notebooks self-upgrade.
 */
export async function importLegacyFormat(vfs, html, decodeModules) {
  // Cells + settings → /projects/self/notebook.txt (the /// form)
  const dataMatch = html.match(LEGACY_DATA_RE);
  const settingsMatch = html.match(LEGACY_SETTINGS_RE);
  const cells = dataMatch ? JSON.parse(dataMatch[1]) : [];
  const settings = settingsMatch ? JSON.parse(settingsMatch[1]) : {};
  const title = $('#docTitle')?.value || 'untitled';

  const txt = serializeNotebookTxt({ title, settings, cells, modules: [] });
  await vfs.mkdir(PROJECT_DIR, { recursive: true }).catch(() => {});
  await vfs.writeFile(NOTEBOOK_TXT_PATH, txt);

  // Modules → window._installedModules (kept in legacy shape for now;
  // cell-builtins/modules.js still reads from there. Migration to
  // /lib/<url>/ is a follow-up.)
  const modulesMatch = html.match(LEGACY_MODULES_RE);
  if (modulesMatch && decodeModules) {
    try { window._installedModules = decodeModules(modulesMatch[1]); }
    catch (e) { console.error('[persist] failed to import legacy modules:', e); }
  }

  // FS → /projects/self/ (CommentBackend reads from window._notebookFS Map).
  // Legacy 4-block FS keys were /home/nb-relative (bare, no prefix); under the
  // /projects mount they must be re-keyed beneath self/.
  const fsMatch = html.match(LEGACY_FS_RE);
  if (fsMatch && decodeModules) {
    try {
      const decoded = decodeModules(fsMatch[1]);
      window._notebookFS = new Map(
        Object.entries(decoded).map(([k, v]) => ['self/' + k, v]));
    } catch (e) { console.error('[persist] failed to import legacy FS:', e); }
  }
}
