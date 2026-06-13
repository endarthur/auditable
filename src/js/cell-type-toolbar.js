// The toolbar cell-type changer (#cellTypeSelect) — a Jupyter-style dropdown
// that reflects the SELECTED cell's type and converts it on change. Useful in
// standalone and (especially) as part of the slim cell toolbar a notebook
// surface shows inside Auditable Works.
//
// Subscribes to the `cell:selected` hook to stay in sync; the inline
// onchange (template.html) calls convertSelectedCellType. Plugin / tagged cell
// types (not one of the four builtins) are shown as a transient, non-selectable
// option so the dropdown never lies about the current cell.

import { S, $ } from './state.js';
import { convertCell } from './cell-ops.js';
import { selectCell } from './keyboard.js';
import * as hooks from './hooks.js';

const BUILTIN_TYPES = new Set(['code', 'md', 'css', 'html']);

// Reflect the given cell's type in the dropdown (or disable it when nothing's
// selected). Removes any transient plugin-type option left from a prior sync.
function syncSelect(id) {
  const sel = $('#cellTypeSelect');
  if (!sel) return;
  const extra = sel.querySelector('option[data-extra]');
  if (extra) extra.remove();
  const cell = id != null ? S.cells.find((c) => c.id === id) : null;
  if (!cell) { sel.disabled = true; return; }
  sel.disabled = false;
  if (BUILTIN_TYPES.has(cell.type)) { sel.value = cell.type; return; }
  // A plugin / tagged cell type — add a transient option so the dropdown shows
  // the real type (converting TO a plugin type stays an Edit-menu / tag affair).
  const o = document.createElement('option');
  o.value = cell.type; o.textContent = cell.type; o.dataset.extra = '1';
  sel.appendChild(o);
  sel.value = cell.type;
}

// Convert the selected cell to `type` (from the dropdown). convertCell replaces
// the cell element, so re-select to restore the highlight — which re-emits
// cell:selected and re-syncs the dropdown to the new type.
export function convertSelectedCellType(type) {
  const id = S.selectedId;
  if (id == null) return;
  const cell = S.cells.find((c) => c.id === id);
  if (!cell || cell.type === type) return;
  convertCell(id, type);
  selectCell(id);
}

if (typeof window !== 'undefined') window.convertSelectedCellType = convertSelectedCellType;
hooks.on('cell:selected', syncSelect);
