// Cell output sidecar persistence.
//
// After each code cell runs, we snapshot its output area and write to
// /projects/self/notebook.outputs/<cell-id>.json. The file is keyed by
// the cell's stable id (e.g. c-3.json) — assigned at cell creation,
// persisted in notebook.txt's /// directive, and stable across save /
// reload / reorder. Each cell has at most ONE sidecar file at any
// moment, no orphans from edits.
//
// On notebook open, each cell looks up its sidecar by id and restores
// the saved output. The entry carries the sourceHash that produced
// the output; if the cell's current source hashes differently, we
// still render the saved output (Jupyter-faithful — show last result)
// AND tint the cell with a "stale" class so the user knows the output
// is from earlier source.
//
// Markdown / HTML / CSS cells are deterministic from source so they're
// re-rendered on open; only code cells (and extension cell types
// declared executable) need the sidecar.

import { S } from './state.js';
import * as hooks from './hooks.js';
import { _ctIsExecutable } from './cell-types.js';

// Hardcoded rather than imported from persist.js — persist.js → cell-ops.js
// → outputs.js → persist.js forms a circular dependency that puts
// PROJECT_DIR in the temporal dead zone when this module first evaluates.
// The path is fixed by the notebook layout (auditable-persistence-spec
// §3.1); duplicating one literal is cheaper than restructuring the cycle.
const OUTPUTS_DIR = '/projects/self/notebook.outputs';

// Per-cell write debounce — autorun on a chatty cell would otherwise
// hammer the VFS. 400ms collapses a burst into one write.
const SAVE_DEBOUNCE_MS = 400;
const _saveTimers = new Map();   // cell.id → timer

// ── Source hashing ──────────────────────────────────────────────────
//
// The hash lives inside the entry (for stale detection on open), not
// in the filename. Filenames are cell IDs. We don't need cryptographic
// strength — we just need to detect when source changed. SubtleCrypto
// is the preferred path but it requires a secure context, and blob:
// URLs created from a file:// origin get unique opaque origins that
// Chromium treats as non-secure (same root cause as the IDB-delegation
// warning). Fall back to FNV-1a 64-bit when crypto.subtle is gone.

const _encoder = new TextEncoder();
const _hashCache = new WeakMap();   // cell → { tag, hash }

function _fnv1a64(s) {
  let hi = 0xcbf29ce4 | 0;
  let lo = 0x84222325 | 0;
  for (let i = 0; i < s.length; i++) {
    lo = lo ^ s.charCodeAt(i);
    // multiply by 0x100000001b3 — 64-bit FNV prime — in two 32-bit halves
    const lo2 = Math.imul(lo, 0x01b3);
    const hi2 = Math.imul(hi, 0x01b3) + Math.imul(lo, 0x00000100);
    lo = lo2 | 0;
    hi = hi2 | 0;
  }
  const toHex = (n) => (n >>> 0).toString(16).padStart(8, '0');
  return toHex(hi) + toHex(lo);
}

async function _hashTag(tag) {
  if (typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest) {
    try {
      const buf = await crypto.subtle.digest('SHA-256', _encoder.encode(tag));
      const u8 = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
      return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    } catch { /* fall through to FNV */ }
  }
  return 'fnv:' + _fnv1a64(tag);
}

export async function cellSourceHash(cell) {
  const tag = cell.type + '\n' + (cell.code || '');
  const cached = _hashCache.get(cell);
  if (cached && cached.tag === tag) return cached.hash;
  const hash = await _hashTag(tag);
  _hashCache.set(cell, { tag, hash });
  return hash;
}

// ── Save ────────────────────────────────────────────────────────────

function _shouldSave(cell) {
  if (cell.type === 'code') return true;
  if (cell.type === 'md' || cell.type === 'html' || cell.type === 'css') return false;
  return _ctIsExecutable(cell.type);
}

// Take a snapshot of the cell's output element. Returns the innerHTML
// as a string, or null if empty. Canvas elements get their pixel state
// captured as a data URL before serializing.
function _snapshotOutputHTML(cell) {
  const el = cell.el?.querySelector('.cell-output');
  if (!el) return null;
  const clone = el.cloneNode(true);
  const liveCanvases = el.querySelectorAll('canvas');
  const cloneCanvases = clone.querySelectorAll('canvas');
  for (let i = 0; i < liveCanvases.length && i < cloneCanvases.length; i++) {
    try {
      const dataUrl = liveCanvases[i].toDataURL('image/png');
      const img = document.createElement('img');
      img.src = dataUrl;
      img.width = liveCanvases[i].width;
      img.height = liveCanvases[i].height;
      img.className = 'cell-output-canvas-snapshot';
      cloneCanvases[i].replaceWith(img);
    } catch {
      // tainted (cross-origin) canvas — can't read pixels.
    }
  }
  const html = clone.innerHTML;
  return html.trim() === '' ? null : html;
}

function _captureError(cell) {
  if (!cell.error) return null;
  if (typeof cell.error === 'string') return { message: cell.error };
  return {
    name:    cell.error.name || 'Error',
    message: cell.error.message || String(cell.error),
    line:    cell.error.line ?? null,
  };
}

async function _buildEntry(cell) {
  return {
    v:          1,
    sourceHash: await cellSourceHash(cell),
    outputHTML: _snapshotOutputHTML(cell),
    error:      _captureError(cell),
    ranAt:      new Date().toISOString(),
  };
}

function _outputPath(cellId) {
  return OUTPUTS_DIR + '/' + cellId + '.json';
}

// Public: trigger a debounced save for one cell. Same file overwritten
// on every save (filename = cell.id is stable); no orphans from edits.
// Opt-in diagnostic logging — set `window._outputsDebug = true` in the
// iframe's devtools to trace the output-save → autosave → writeBack chain.
// Useful for verifying changes to the sidecar path without console spam in
// normal use.
const _dbg = (...a) => { if (window._outputsDebug) console.log(...a); };

export function scheduleOutputSave(cell) {
  if (!_shouldSave(cell)) {
    _dbg('[outputs] skip (not executable)', cell.id, cell.type);
    return;
  }
  const vfs = window._notebookVFS;
  if (!vfs) {
    _dbg('[outputs] skip (no VFS)', cell.id);
    return;
  }
  const existing = _saveTimers.get(cell.id);
  if (existing) clearTimeout(existing);
  _dbg('[outputs] scheduling save for', cell.id);
  _saveTimers.set(cell.id, setTimeout(async () => {
    _saveTimers.delete(cell.id);
    try {
      const entry = await _buildEntry(cell);
      await vfs.mkdir(OUTPUTS_DIR, { recursive: true }).catch(() => {});
      await vfs.writeFile(_outputPath(cell.id), JSON.stringify(entry));
      _dbg('[outputs] saved', cell.id, '→', _outputPath(cell.id),
           '(' + JSON.stringify(entry).length + ' bytes)');
    } catch (e) {
      console.warn(`[outputs] save failed for cell ${cell.id}:`, e.message);
    }
  }, SAVE_DEBOUNCE_MS));
}

// Cancel any pending save for one cell — used when the cell is being
// deleted or its output cleared manually.
export function cancelOutputSave(cellId) {
  const existing = _saveTimers.get(cellId);
  if (existing) {
    clearTimeout(existing);
    _saveTimers.delete(cellId);
  }
}

// Drop the sidecar file for a cell that's being deleted. Called from
// cell-ops.js's deleteCell BEFORE the cell record is spliced out.
export async function removeOutputForCell(cell) {
  cancelOutputSave(cell.id);
  const vfs = window._notebookVFS;
  if (!vfs) return;
  try {
    if (typeof vfs.rm === 'function') await vfs.rm(_outputPath(cell.id));
    else if (typeof vfs.unlink === 'function') await vfs.unlink(_outputPath(cell.id));
  } catch { /* already gone — fine */ }
}

// ── Load ────────────────────────────────────────────────────────────

// Inject a saved output entry into a cell's output element. Called at
// hydration time after the cell's DOM is in place. Compares the saved
// sourceHash against the cell's current hash; if they differ, marks
// the cell stale (renders the old output AND tints visually).
function _applySavedOutput(cell, entry, isStale) {
  if (!entry || !cell.el) return;
  const outputEl = cell.el.querySelector('.cell-output');
  if (!outputEl) return;
  if (entry.error) {
    outputEl.className = 'cell-output error';
    outputEl.textContent = entry.error.message || 'errored';
    cell.el.classList.add('error');
  } else if (entry.outputHTML) {
    outputEl.className = 'cell-output';
    outputEl.innerHTML = entry.outputHTML;
  }
  cell._savedOutput = true;
  cell.el.classList.add('output-restored');
  if (isStale) cell.el.classList.add('output-stale');
}

// Hydrate every cell in S.cells with its saved output. Called once
// during hydrateNotebook AFTER cells have been added to the DOM.
export async function hydrateAllSavedOutputs() {
  const vfs = window._notebookVFS;
  if (!vfs) return;
  for (const cell of S.cells) {
    if (!_shouldSave(cell)) continue;
    let entry = null;
    try { entry = JSON.parse(await vfs.readFile(_outputPath(cell.id), 'utf8')); }
    catch { continue; }   // no sidecar — first time, fine
    const currentHash = await cellSourceHash(cell);
    const stale = entry.sourceHash && entry.sourceHash !== currentHash;
    _applySavedOutput(cell, entry, stale);
  }
}

// ── Cleanup ─────────────────────────────────────────────────────────

// Periodic sweep — list the sidecar dir, delete files for cell IDs
// that no longer exist in S.cells. Catches cells deleted without the
// runtime watching (closing the browser mid-edit, importing a
// different notebook into the same VFS, etc.). Called from
// flushPendingDirty at notebook save time.
export async function sweepOrphanOutputs() {
  const vfs = window._notebookVFS;
  if (!vfs) return;
  let entries;
  try { entries = await vfs.readdir(OUTPUTS_DIR); }
  catch { return; }
  const live = new Set();
  for (const cell of S.cells) {
    if (_shouldSave(cell)) live.add(cell.id);
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -('.json'.length));
    if (live.has(id)) continue;
    try {
      if (typeof vfs.rm === 'function') await vfs.rm(OUTPUTS_DIR + '/' + name);
      else if (typeof vfs.unlink === 'function') await vfs.unlink(OUTPUTS_DIR + '/' + name);
    } catch { /* concurrent delete is fine */ }
  }
}

// Drop the entire outputs sidecar dir. Used by the Run → Clear all
// outputs command.
export async function clearAllOutputs() {
  const vfs = window._notebookVFS;
  if (!vfs) return;
  for (const [id, timer] of _saveTimers) {
    clearTimeout(timer);
    _saveTimers.delete(id);
  }
  try {
    if (typeof vfs.rm === 'function') {
      await vfs.rm(OUTPUTS_DIR, { recursive: true });
    }
  } catch { /* dir didn't exist — fine */ }
}

// ── Wire to dag hooks ───────────────────────────────────────────────

export function installOutputCapture() {
  hooks.on('dag:cell:after-exec', (cell) => {
    if (!cell || !cell.id) return;
    scheduleOutputSave(cell);
  });
  // When a cell starts executing, drop the "restored from sidecar"
  // affordance so the saved-output visual hint clears once the user
  // is looking at a fresh result.
  hooks.on('dag:cell:before-exec', (cell) => {
    if (!cell || !cell.el) return;
    if (cell._savedOutput) {
      cell.el.classList.remove('output-restored', 'output-stale');
      delete cell._savedOutput;
    }
  });
}
