// VFS-unified persistence.
//
// Cells, settings, modules, and user files all live on the VFS. The Persister
// serialises the contents of "persistent" mounts (/home/nb, /var) into a
// single AUDITABLE-VFS comment block on save; the EncryptedPersister wraps
// that JSON in AUDITABLE-CRYPTO. Loading parses the block, hydrates the VFS,
// then a separate hydrateNotebook() pass reads /var/notebook.txt to populate
// S.cells + settings + module declarations.
//
// Spec: spec_inbox/shipped/auditable-persistence-spec.md (roadmap step E).

import { $ } from './state.js';
import { addCell } from './cell-ops.js';
import { applySettings } from './settings.js';
import { isCollapsed } from './dag.js';
import { parseNotebookTxt, serializeNotebookTxt, serializeVfs, hydrateVfs } from './serialize.js';
import { cryptoIsLocked, cryptoBuildBlock, cryptoDetect } from './crypto.js';

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

// ── Module storage sync (window._installedModules ↔ /var/modules/) ──
//
// Pre-1.0 cell-builtins/modules.js still reads/writes window._installedModules
// directly (full migration is a follow-up). Here we sync the in-memory map
// onto /var/modules/<url-encoded>/ at save time and back at load time, so
// the on-disk format is VFS-uniform.

const MODULES_DIR = '/var/modules';
const _enc = encodeURIComponent;
const _dec = decodeURIComponent;

export async function syncModulesToVfs(vfs, installedModules) {
  if (!vfs) return;
  await vfs.mkdir(MODULES_DIR, { recursive: true }).catch(() => {});

  // Wipe the existing /var/modules/ entries — easier than diffing.
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
  for (const [url, entry] of Object.entries(installedModules)) {
    const dir = MODULES_DIR + '/' + _enc(url);
    await vfs.mkdir(dir, { recursive: true }).catch(() => {});
    if (typeof entry === 'string') {
      // legacy: bare source string
      await vfs.writeFile(dir + '/source', entry);
      await vfs.writeFile(dir + '/meta.json', JSON.stringify({ legacy: true }));
      continue;
    }
    if (entry && typeof entry === 'object') {
      // metadata sans `source`
      const { source, ...meta } = entry;
      await vfs.writeFile(dir + '/meta.json', JSON.stringify(meta));
      if (typeof source === 'string') await vfs.writeFile(dir + '/source', source);
    }
  }
}

/**
 * Write S.cells + current settings to /var/notebook.txt in /// form.
 * Called before serializeBlock() so the dump reflects current runtime state.
 */
export async function syncCellsToVfs(vfs, S, settings, title) {
  await vfs.mkdir('/var', { recursive: true }).catch(() => {});
  const cells = S.cells.map(c => ({
    type: c.type,
    code: c.code,
    collapsed: c.collapsed || undefined,
  }));
  const modules = Object.keys(window._installedModules || {}).map(url => ({ url }));
  const txt = serializeNotebookTxt({ title, settings, cells, modules });
  await vfs.writeFile(NOTEBOOK_TXT_PATH, txt);
}

/**
 * One-shot: sync runtime state (cells, settings, modules) into the VFS so
 * `serializeVfs(vfs)` produces an up-to-date dump. Called from save paths.
 */
export async function flushPendingDirty(vfs, S, settings, title) {
  await syncCellsToVfs(vfs, S, settings, title);
  await syncModulesToVfs(vfs, window._installedModules || {});
}

export async function hydrateModulesFromVfs(vfs) {
  if (!vfs) return {};
  let entries;
  try { entries = await vfs.readdir(MODULES_DIR, { stat: true }); }
  catch { return {}; }
  const result = {};
  for (const e of entries) {
    if (e.type !== 'directory') continue;
    const url = _dec(e.name);
    const dir = MODULES_DIR + '/' + e.name;
    let meta = {};
    let source = null;
    try { meta = JSON.parse(await vfs.readFile(dir + '/meta.json', 'text')); } catch {}
    try { source = await vfs.readFile(dir + '/source', 'text'); } catch {}
    if (meta.legacy && source !== null) {
      result[url] = source;
    } else if (source !== null) {
      result[url] = { ...meta, source };
    } else if (Object.keys(meta).length > 0) {
      result[url] = meta;
    }
  }
  return result;
}

// ── Notebook hydration (post-VFS-restore) ───────────────────────────

const NOTEBOOK_TXT_PATH = '/var/notebook.txt';

/**
 * After hydrateVfs has populated the VFS, read /var/notebook.txt and
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

  for (const c of parsed.cells || []) {
    const cell = addCell(c.type, c.code);
    if (c.collapsed || isCollapsed(c.code)) {
      cell.el.classList.add('collapsed');
      cell.collapsed = true;
    }
  }
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
  // Cells + settings → /var/notebook.txt (the /// form)
  const dataMatch = html.match(LEGACY_DATA_RE);
  const settingsMatch = html.match(LEGACY_SETTINGS_RE);
  const cells = dataMatch ? JSON.parse(dataMatch[1]) : [];
  const settings = settingsMatch ? JSON.parse(settingsMatch[1]) : {};
  const title = $('#docTitle')?.value || 'untitled';

  const txt = serializeNotebookTxt({ title, settings, cells, modules: [] });
  await vfs.mkdir('/var', { recursive: true }).catch(() => {});
  await vfs.writeFile(NOTEBOOK_TXT_PATH, txt);

  // Modules → window._installedModules (kept in legacy shape for now;
  // cell-builtins/modules.js still reads from there. Migration to
  // /var/modules/<url>/ is a follow-up.)
  const modulesMatch = html.match(LEGACY_MODULES_RE);
  if (modulesMatch && decodeModules) {
    try { window._installedModules = decodeModules(modulesMatch[1]); }
    catch (e) { console.error('[persist] failed to import legacy modules:', e); }
  }

  // FS → /home/nb (CommentBackend reads from window._notebookFS Map)
  const fsMatch = html.match(LEGACY_FS_RE);
  if (fsMatch && decodeModules) {
    try {
      const decoded = decodeModules(fsMatch[1]);
      window._notebookFS = new Map(Object.entries(decoded));
    } catch (e) { console.error('[persist] failed to import legacy FS:', e); }
  }
}
