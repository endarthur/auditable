// Cell output sidecar persistence.
//
// After each code cell runs, we snapshot its output area and write to
// /projects/self/notebook.outputs/<source-hash>.json. The file is
// keyed by the SHA-256 of the cell type + source, not by cell.id —
// cell.id is integer-reassigned at every hydration and would break
// the moment cells get reordered. Hashing keys the output to the
// source that actually produced it, so reorders survive cleanly and
// editing a cell invalidates only its own saved entry (different
// source → different hash → different file). On notebook open, each
// cell looks up its current-source-hashed file and restores the
// saved output verbatim.
//
// Markdown / HTML / CSS cells are deterministic from source so they're
// re-rendered on open; only code cells (and extension cell types
// declared executable) need the sidecar.

import { S } from './state.js';
import { PROJECT_DIR } from './persist.js';
import * as hooks from './hooks.js';
import { _ctIsExecutable } from './cell-types.js';

const OUTPUTS_DIR = PROJECT_DIR + '/notebook.outputs';

// Per-cell write debounce — autorun on a chatty cell would otherwise
// hammer the VFS. 400ms collapses a burst into one write.
const SAVE_DEBOUNCE_MS = 400;
const _saveTimers = new Map();   // cell.id → timer

// ── Source hashing — async SubtleCrypto SHA-256, base64url ──────────
//
// Filename-safe variant (base64url, no '/' or '+' or '=') so the hash
// can be used directly as a sidecar filename.

const _encoder = new TextEncoder();
const _hashCache = new WeakMap();   // cell → { tag, hash }   tag = type + '\n' + code

function _toBase64Url(u8) {
  let bin = '';
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function _hashTag(tag) {
  const buf = await crypto.subtle.digest('SHA-256', _encoder.encode(tag));
  return _toBase64Url(new Uint8Array(buf));
}

// Public: hash for a cell. Includes type so two cells with identical
// source but different types (`/// code` vs `/// adder`) get separate
// sidecars.
export async function cellSourceHash(cell) {
  const tag = cell.type + '\n' + (cell.code || '');
  const cached = _hashCache.get(cell);
  if (cached && cached.tag === tag) return cached.hash;
  const hash = await _hashTag(tag);
  _hashCache.set(cell, { tag, hash });
  return hash;
}

// ── Save ────────────────────────────────────────────────────────────

// Cell types that get their output saved. Built-in md/html/css render
// deterministically from source — saving them is wasted space. Code
// cells (and any extension-provided executable cell type) save.
function _shouldSave(cell) {
  if (cell.type === 'code') return true;
  if (cell.type === 'md' || cell.type === 'html' || cell.type === 'css') return false;
  // Extension types: save when executable. parseNames-only types
  // (rare) skip.
  return _ctIsExecutable(cell.type);
}

// Take a snapshot of the cell's output element. Returns the outerHTML
// as a string, or null if the output area is empty / missing. Canvas
// elements get their pixel state captured as a data URL before
// serializing — otherwise the saved markup is just an empty <canvas>.
function _snapshotOutputHTML(cell) {
  const el = cell.el?.querySelector('.cell-output');
  if (!el) return null;
  // Capture canvas pixel state. We mutate the cloned element rather
  // than the live one so the on-screen canvas isn't disturbed.
  const clone = el.cloneNode(true);
  const liveCanvases = el.querySelectorAll('canvas');
  const cloneCanvases = clone.querySelectorAll('canvas');
  for (let i = 0; i < liveCanvases.length && i < cloneCanvases.length; i++) {
    try {
      const dataUrl = liveCanvases[i].toDataURL('image/png');
      const img = document.createElement('img');
      img.src = dataUrl;
      // Inherit size hints so re-rendered canvases keep their layout box
      img.width = liveCanvases[i].width;
      img.height = liveCanvases[i].height;
      img.className = 'cell-output-canvas-snapshot';
      cloneCanvases[i].replaceWith(img);
    } catch {
      // tainted (cross-origin) canvas — can't read pixels. Leave the
      // empty <canvas> in place; nothing else we can do without the
      // CORS dance.
    }
  }
  const html = clone.innerHTML;
  return html.trim() === '' ? null : html;
}

// Marshal cell error into a small JSON-safe object. The `error` field
// on the cell can be either an Error object or a plain string depending
// on how the failure surfaced.
function _captureError(cell) {
  if (!cell.error) return null;
  if (typeof cell.error === 'string') return { message: cell.error };
  return {
    name:    cell.error.name || 'Error',
    message: cell.error.message || String(cell.error),
    line:    cell.error.line ?? null,
  };
}

// Per-cell entry — JSON object we write to
// /projects/self/notebook.outputs/<source-hash>.json.
// Schema versioned via `v` so future changes can migrate cleanly.
function _buildEntry(cell) {
  return {
    v:          1,
    outputHTML: _snapshotOutputHTML(cell),
    error:      _captureError(cell),
    ranAt:      new Date().toISOString(),
  };
}

function _outputPath(hash) {
  return OUTPUTS_DIR + '/' + hash + '.json';
}

// Public: trigger a debounced save for one cell. Safe to call on
// every run — overlapping calls collapse to one write per
// SAVE_DEBOUNCE_MS.
//
// Orphan cleanup is incremental: each cell tracks _prevSavedHash (the
// hash we last successfully wrote). When a new save happens with a
// different hash, the previous file is deleted. So a user editing a
// cell rapidly + running each time writes ONE file at a time, never
// accumulates. Cell deletion is handled separately by
// removeOutputForCell — wired into cell-ops.js's deleteCell so the
// runtime sees the death before the cell record disappears.
export function scheduleOutputSave(cell) {
  if (!_shouldSave(cell)) return;
  const vfs = window._notebookVFS;
  if (!vfs) return;
  const existing = _saveTimers.get(cell.id);
  if (existing) clearTimeout(existing);
  _saveTimers.set(cell.id, setTimeout(async () => {
    _saveTimers.delete(cell.id);
    try {
      const hash = await cellSourceHash(cell);
      const entry = _buildEntry(cell);
      await vfs.mkdir(OUTPUTS_DIR, { recursive: true }).catch(() => {});
      await vfs.writeFile(_outputPath(hash), JSON.stringify(entry));
      // Delete the previously-saved hash's file if the cell's source
      // has moved on. Skip when prev === current (idempotent re-runs
      // of identical source just rewrite the same file).
      const prev = cell._prevSavedHash;
      if (prev && prev !== hash) {
        try {
          if (typeof vfs.rm === 'function') await vfs.rm(_outputPath(prev));
          else if (typeof vfs.unlink === 'function') await vfs.unlink(_outputPath(prev));
        } catch { /* prev file already gone — fine */ }
      }
      cell._prevSavedHash = hash;
    } catch (e) {
      console.warn(`[outputs] save failed for cell ${cell.id}:`, e.message);
    }
  }, SAVE_DEBOUNCE_MS));
}

// Drop the sidecar file for a cell that's being deleted. Called from
// cell-ops.js's deleteCell BEFORE the cell record is spliced out of
// S.cells (so we still have access to cell._prevSavedHash). Also flushes
// any pending save for that cell.
export async function removeOutputForCell(cell) {
  cancelOutputSave(cell.id);
  if (!cell._prevSavedHash) return;
  const vfs = window._notebookVFS;
  if (!vfs) return;
  try {
    if (typeof vfs.rm === 'function') await vfs.rm(_outputPath(cell._prevSavedHash));
    else if (typeof vfs.unlink === 'function') await vfs.unlink(_outputPath(cell._prevSavedHash));
  } catch { /* already gone — fine */ }
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

// ── Load ────────────────────────────────────────────────────────────

// Read the saved output for one cell, by its current source hash.
// Returns null if no sidecar exists — the cell needs to run to produce
// fresh output.
export async function loadSavedOutput(cell) {
  if (!_shouldSave(cell)) return null;
  const vfs = window._notebookVFS;
  if (!vfs) return null;
  try {
    const hash = await cellSourceHash(cell);
    const raw = await vfs.readFile(_outputPath(hash), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Inject a saved output entry into a cell's output element. Called at
// hydration time after the cell's DOM is in place.
export function applySavedOutput(cell, entry) {
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
  // Mark the cell so callers know its output came from disk, not from
  // a live run. Cleared when the cell actually executes.
  cell._savedOutput = true;
  cell.el.classList.add('output-restored');
}

// Hydrate every cell in S.cells with its saved output. Called once
// during hydrateNotebook AFTER cells have been added to the DOM.
// Seeds cell._prevSavedHash with each cell's current hash so the
// first post-hydration save cleans up the previous-hash file correctly.
export async function hydrateAllSavedOutputs() {
  for (const cell of S.cells) {
    if (!_shouldSave(cell)) continue;
    const hash = await cellSourceHash(cell);
    const vfs = window._notebookVFS;
    if (!vfs) continue;
    let entry = null;
    try { entry = JSON.parse(await vfs.readFile(_outputPath(hash), 'utf8')); }
    catch { /* no sidecar — first time, fine */ }
    if (entry) {
      applySavedOutput(cell, entry);
      cell._prevSavedHash = hash;   // we own this hash; next edit will rewrite
    }
  }
}

// ── Cleanup ─────────────────────────────────────────────────────────

// Periodic sweep — list the sidecar dir, compare against the set of
// hashes any current cell has (or has had as _prevSavedHash), delete
// anything else. Catches orphans the incremental cleanup missed (e.g.
// a cell that was deleted while the runtime wasn't watching, or a
// pre-incremental-cleanup save). Called from flushPendingDirty at
// notebook save time.
export async function sweepOrphanOutputs() {
  const vfs = window._notebookVFS;
  if (!vfs) return;
  let entries;
  try { entries = await vfs.readdir(OUTPUTS_DIR); }
  catch { return; }   // no dir yet, nothing to sweep
  // Compute the set of live hashes across S.cells.
  const live = new Set();
  for (const cell of S.cells) {
    if (!_shouldSave(cell)) continue;
    try { live.add(await cellSourceHash(cell)); } catch { /* keep going */ }
    if (cell._prevSavedHash) live.add(cell._prevSavedHash);
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const hash = name.slice(0, -('.json'.length));
    if (live.has(hash)) continue;
    try {
      if (typeof vfs.rm === 'function') await vfs.rm(OUTPUTS_DIR + '/' + name);
      else if (typeof vfs.unlink === 'function') await vfs.unlink(OUTPUTS_DIR + '/' + name);
    } catch { /* concurrent delete is fine */ }
  }
}

// Drop the entire outputs sidecar dir. Used by the Tools → Clear all
// outputs command (Slice 4).
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

// ── Wire to dag:cell:after-exec ─────────────────────────────────────

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
      cell.el.classList.remove('output-restored');
      delete cell._savedOutput;
    }
  });
}
