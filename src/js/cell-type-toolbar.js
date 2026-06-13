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

const BUILTIN_OPTS = [['code', 'code'], ['md', 'md'], ['css', 'css'], ['html', 'html']];

// (Re)build the dropdown options = the four builtins + every registered
// non-builtin (plugin / tagged) cell type — the SAME set Edit → Convert offers,
// so the dropdown is a full convert target list (it owns conversion once the
// menubar is hidden in works). `currentType` not in the registry is appended so
// the dropdown never lies about an unknown cell's type. Rebuilt per sync — cheap
// (a handful of options) and naturally picks up late-registered plugin types.
function buildOptions(sel, currentType) {
  const opts = BUILTIN_OPTS.slice();
  const reg = (typeof window !== 'undefined' && window._cellTypes) || {};
  for (const [name, h] of Object.entries(reg)) {
    if (h && h.capabilities && h.capabilities.builtin) continue;   // builtins already listed
    opts.push([name, (h && h.label) || name]);
  }
  if (currentType && !opts.some(([v]) => v === currentType)) opts.push([currentType, currentType]);
  sel.innerHTML = '';
  for (const [v, label] of opts) {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    sel.appendChild(o);
  }
}

// Reflect the selected cell's type in the dropdown (or disable it when nothing's
// selected).
function syncSelect(id) {
  const sel = $('#cellTypeSelect');
  if (!sel) return;
  const cell = id != null ? S.cells.find((c) => c.id === id) : null;
  if (!cell) { buildOptions(sel, null); sel.disabled = true; return; }
  sel.disabled = false;
  buildOptions(sel, cell.type);
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
