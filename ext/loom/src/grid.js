// @gcu/loom — grid: the host-agnostic createGrid factory (browser-only).
//
// createGrid(element, provider, options?) builds the canvas scaffold, wires
// scroll/mouse/keyboard, runs the edit→commit lifecycle, and returns an
// instance handle. No module globals — all state lives on the closure `g`, so
// any number of grids coexist in one page or surface (strata-spec §11,
// upgrade #4: host-agnostic mount, the seam that lets the same renderer drop
// into a standalone page OR a Works iframe unchanged).
//
// Scaffold + virtualized scroll + select + edit + refresh + a first-class
// selection object, plus the daily-driver ergonomics: full keyboard navigation
// (arrows/Home/End/PageUp-Down/Ctrl combos, shift-extend), range-aware
// delete/fill, TSV copy/cut/paste, undo/redo (Ctrl+Z / Ctrl+Y, via the optional
// provider.undo/redo + beginBatch/endBatch contract), and column resize (drag the
// header border; double-click it to autofit). Clipboard rides a focus-holding <textarea>
// so the native copy/cut/paste events carry e.clipboardData — no permission
// prompt, and it works under file:// (where navigator.clipboard is blocked).
// Still deferred (additive): zoom, frozen header rows, hover tooltips, variable
// row-height, persisting column widths into the document view-state.

import { normSel, selEquals, PENDING, CellState, toTSV, parseTSV } from './model.js';
import { cellAt, colAtX, totalWidth, totalHeight, visibleRowRange } from './geometry.js';
import { paint, DARK_COLORS, LIGHT_COLORS } from './render.js';

const SPACER_CAP = 16000000; // browser max element dimension, roughly

function styleEl(el, props) { for (const k in props) el.style[k] = props[k]; }

function readMono() {
  if (typeof getComputedStyle !== 'function') return 'monospace';
  const v = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim();
  return v || 'ui-monospace, monospace';
}

/**
 * @param {HTMLElement} element  host (sized by the caller; loom fills it)
 * @param {object} provider      dims/cellAt/header/rowHeader/commit/onReady
 * @param {object} [options]     { colors?, theme?, defaultColW?, rowH?, hdrH?,
 *                                 rowHdrW?, fontPx?, hdrFontPx?, mono? }
 * @returns {object} instance    { refresh, getSelection, setSelection, onSelect,
 *                                 focus, destroy, element, provider }
 */
export function createGrid(element, provider, options = {}) {
  const dims = provider.dims();
  const g = {
    el: element,
    provider,
    dpr: window.devicePixelRatio || 1,
    colors: options.colors || (options.theme === 'light' ? LIGHT_COLORS : DARK_COLORS),
    mono: options.mono || readMono(),
    fontPx: options.fontPx || 13,
    hdrFontPx: options.hdrFontPx || 11,
    metrics: {
      defaultColW: options.defaultColW || 100,
      rowH: options.rowH || 24,
      // The header splits into a label strip (hdrLabelH) + an optional gutter strip
      // (hdrGutterH, for per-column distribution glyphs via provider.headerGutter).
      // hdrH is the total — every layout offset below uses it.
      hdrLabelH: options.hdrH || 24,
      hdrGutterH: options.headerGutterH || 0,
      hdrH: (options.hdrH || 24) + (options.headerGutterH || 0),
      rowHdrW: options.rowHdrW || 48,
      colWidths: options.colWidths || {},
      totalRows: dims.rows,
      totalCols: dims.cols,
    },
    sel: null,
    selDrag: false,
    editing: null,
    readOnly: !!options.readOnly,   // refuse edits/paste/fill/clear (a viewer, e.g. lamina)
    selectListeners: [],
    headerListeners: [],
    headerContextListeners: [],
    gutterListeners: [],
    gutterBrushListeners: [],
    gutterBrush: null,
    contextListeners: [],
    _cleanup: [],
  };

  // ── scaffold ──
  element.innerHTML = '';
  if (getComputedStyle(element).position === 'static') element.style.position = 'relative';
  element.style.overflow = 'hidden';
  const M = g.metrics;

  const corner = document.createElement('div');
  styleEl(corner, { position: 'absolute', left: 0, top: 0, width: M.rowHdrW + 'px', height: M.hdrH + 'px', background: g.colors.hdrBg, borderRight: '1px solid ' + g.colors.hdrBorder, borderBottom: '1px solid ' + g.colors.hdrBorder, zIndex: 3 });
  element.appendChild(corner);

  const colHdr = document.createElement('canvas');
  styleEl(colHdr, { position: 'absolute', left: M.rowHdrW + 'px', top: 0, height: M.hdrH + 'px', zIndex: 2 });
  element.appendChild(colHdr);
  g.colHdrCanvas = colHdr; g.colHdrCtx = colHdr.getContext('2d');

  const rowHdr = document.createElement('canvas');
  styleEl(rowHdr, { position: 'absolute', left: 0, top: M.hdrH + 'px', width: M.rowHdrW + 'px', zIndex: 2 });
  element.appendChild(rowHdr);
  g.rowHdrCanvas = rowHdr; g.rowHdrCtx = rowHdr.getContext('2d');

  const body = document.createElement('div');
  styleEl(body, { position: 'absolute', left: M.rowHdrW + 'px', top: M.hdrH + 'px', right: 0, bottom: 0, overflow: 'hidden' });
  element.appendChild(body);
  g.body = body;

  const canvas = document.createElement('canvas');
  styleEl(canvas, { position: 'absolute', left: 0, top: 0, pointerEvents: 'none' });
  body.appendChild(canvas);
  g.canvas = canvas; g.ctx = canvas.getContext('2d');

  const scroll = document.createElement('div');
  styleEl(scroll, {
    position: 'absolute', inset: 0, overflow: 'auto', outline: 'none',
    // Standard scrollbar styling (Chrome 121+/Firefox) — themed, set inline so
    // loom stays self-contained (no CSS file); every consumer inherits it.
    scrollbarWidth: 'thin', scrollbarColor: g.colors.scrollThumb + ' ' + g.colors.scrollTrack,
  });
  // No tabindex: the scroll div wheel/drag-scrolls but must NOT be click-
  // focusable, or it would steal focus from `clip` (where keyboard + clipboard
  // live) on every mousedown. Adding a tabindex attribute makes a div click-
  // focusable, so we deliberately leave it off.
  body.appendChild(scroll);
  g.scrollEl = scroll;

  const spacer = document.createElement('div');
  styleEl(spacer, { pointerEvents: 'none' });
  scroll.appendChild(spacer);
  g.spacer = spacer;

  // Hidden focus holder: a 1px transparent textarea that holds focus when no
  // cell is being edited. Keyboard navigation and clipboard both target it —
  // the native copy/cut/paste events on a real <textarea> carry clipboardData
  // directly, so copy/paste needs no permission and works under file:// (unlike
  // navigator.clipboard, which is blocked there). Tucked under the corner.
  const clip = document.createElement('textarea');
  styleEl(clip, {
    position: 'absolute', left: 0, top: 0, width: '1px', height: '1px',
    opacity: 0, border: 0, padding: 0, margin: 0, resize: 'none', outline: 'none',
    whiteSpace: 'pre', zIndex: 0,
  });
  clip.tabIndex = 0;
  clip.setAttribute('autocomplete', 'off');
  clip.setAttribute('autocorrect', 'off');
  clip.setAttribute('autocapitalize', 'off');
  clip.spellcheck = false;
  clip.setAttribute('aria-hidden', 'true');
  element.appendChild(clip);
  g.clip = clip;

  // Hover tooltip — shows provider.cellTitle(r,c) (provenance: was→now, derived
  // formula, …) after a short dwell. position:fixed so it floats over the canvas.
  const tip = document.createElement('div');
  tip.className = 'loom-tooltip';
  styleEl(tip, {
    position: 'fixed', display: 'none', zIndex: 10, pointerEvents: 'none',
    background: g.colors.hdrBg, color: g.colors.cellText, border: '1px solid ' + g.colors.hdrBorder,
    borderRadius: '3px', padding: '2px 6px', font: g.hdrFontPx + 'px ' + g.mono,
    whiteSpace: 'nowrap', boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
  });
  element.appendChild(tip);
  g.tip = tip;

  // ── sizing ──
  function sizeCanvases() {
    const dpr = g.dpr;
    const viewW = body.clientWidth, viewH = body.clientHeight;
    for (const [cv, w, h] of [[canvas, viewW, viewH], [colHdr, viewW, M.hdrH], [rowHdr, M.rowHdrW, viewH]]) {
      cv.width = Math.max(1, Math.round(w * dpr));
      cv.height = Math.max(1, Math.round(h * dpr));
      cv.style.width = w + 'px';
      cv.style.height = h + 'px';
    }
    spacer.style.width = Math.min(totalWidth(M), SPACER_CAP) + 'px';
    spacer.style.height = Math.min(totalHeight(M), SPACER_CAP) + 'px';
  }

  function repaint() { paint(g); }

  // ── selection ──
  function emitSelect() {
    const ns = normSel(g.sel);
    for (const cb of g.selectListeners) { try { cb(ns); } catch (e) { console.error('[loom] onSelect listener threw', e); } }
  }
  function setSel(sel, notify) {
    const changed = !selEquals(g.sel, sel);
    g.sel = sel;
    repaint();
    if (notify && changed) emitSelect();
  }

  function pointToCell(clientX, clientY) {
    const rect = scroll.getBoundingClientRect();
    const x = clientX - rect.left + scroll.scrollLeft;
    const y = clientY - rect.top + scroll.scrollTop;
    return cellAt(M, x, y);
  }

  function scrollToCell(r, c) {
    const left = colXOf(c), top = r * M.rowH;
    const vw = body.clientWidth, vh = body.clientHeight;
    if (left < scroll.scrollLeft) scroll.scrollLeft = left;
    else if (left + colWOf(c) > scroll.scrollLeft + vw) scroll.scrollLeft = left + colWOf(c) - vw;
    if (top < scroll.scrollTop) scroll.scrollTop = top;
    else if (top + M.rowH > scroll.scrollTop + vh) scroll.scrollTop = top + M.rowH - vh;
  }
  // tiny local geometry shims (avoid importing colXAt/colW just for these two)
  function colWOf(c) { return M.colWidths[c] || M.defaultColW; }
  function colXOf(c) { let x = c * M.defaultColW; for (const k in M.colWidths) if (Number(k) < c) x += M.colWidths[k] - M.defaultColW; return x; }

  // ── edit lifecycle ──
  function startEdit(row, col, initialChar) {
    if (g.readOnly) return;
    if (g.editing) cancelEdit();
    const cur = provider.cellAt(row, col);
    // Computed (derived) or not-yet-loaded (pending) cells aren't editable —
    // the cell state drives editability, no extra flag needed.
    if (cur === PENDING || (cur && cur.state === CellState.DERIVED)) return;
    const input = document.createElement('input');
    input.type = 'text';
    styleEl(input, {
      position: 'absolute', font: g.fontPx + 'px ' + g.mono, boxSizing: 'border-box',
      padding: '0 5px', margin: 0, border: '2px solid ' + g.colors.selStroke,
      background: g.colors.bg, color: g.colors.cellText, zIndex: 5,
      left: (colXOf(col) - scroll.scrollLeft) + 'px',
      top: (row * M.rowH - scroll.scrollTop) + 'px',
      width: colWOf(col) + 'px', height: M.rowH + 'px',
    });
    const original = cur && cur.style && typeof cur.style.text === 'string'
      ? cur.style.text
      : (cur && cur.value != null ? String(cur.value) : '');
    input.value = initialChar !== undefined ? initialChar : original;
    body.appendChild(input);
    input.focus();
    if (initialChar !== undefined) input.setSelectionRange(input.value.length, input.value.length);
    else input.select();

    g.editing = { row, col, input };
    input.addEventListener('keydown', onEditKey);
  }
  function onEditKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commitEdit(1, 0); }
    else if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); commitEdit(0, e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelEdit(); clip.focus(); }
  }
  function removeInput() {
    if (!g.editing) return;
    g.editing.input.removeEventListener('keydown', onEditKey);
    g.editing.input.remove();
    g.editing = null;
  }
  function cancelEdit() { removeInput(); }
  async function commitEdit(dRow, dCol) {
    if (!g.editing) return;
    const { row, col, input } = g.editing;
    const raw = input.value;
    removeInput();
    // Provider owns coercion (column types). loom passes the raw edited string.
    try { await provider.commit(row, col, raw); }
    catch (e) { console.error('[loom] commit failed', e); }
    const nr = Math.max(0, row + dRow), nc = Math.max(0, col + dCol);
    setSel({ r0: nr, c0: nc, r1: nr, c1: nc }, true);
    clip.focus();
    refresh();
  }

  // ── events ──
  function onMouseDown(e) {
    if (e.button !== 0) return;
    // Suppress the default mousedown action: on a non-focusable target it would
    // move focus to <body>, blurring our hidden `clip` right after we focus it
    // (then keyboard + clipboard would be dead). We manage focus + selection
    // ourselves, so the default buys us nothing.
    e.preventDefault();
    if (g.editing) cancelEdit();
    clip.focus();
    if (g.tip) g.tip.style.display = 'none';
    const { row, col } = pointToCell(e.clientX, e.clientY);
    setSel({ r0: row, c0: col, r1: row, c1: col }, false);
    g.selDrag = true;
    const onMove = (ev) => {
      const c = pointToCell(ev.clientX, ev.clientY);
      g.sel.r1 = c.row; g.sel.c1 = c.col;
      repaint();
    };
    const onUp = () => {
      g.selDrag = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      emitSelect();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function onDblClick(e) {
    const { row, col } = pointToCell(e.clientX, e.clientY);
    setSel({ r0: row, c0: col, r1: row, c1: col }, true);
    startEdit(row, col);
  }

  const clampR = (r) => Math.max(0, Math.min(M.totalRows - 1, r));
  const clampC = (c) => Math.max(0, Math.min(M.totalCols - 1, c));

  // Move the active corner to (r,c). extend=true keeps the anchor (r0,c0) and
  // grows the rect; otherwise collapses to a single cell. Clamped to the grid.
  function gotoCell(r, c, extend) {
    r = clampR(r); c = clampC(c);
    if (extend && g.sel) g.sel = { r0: g.sel.r0, c0: g.sel.c0, r1: r, c1: c };
    else g.sel = { r0: r, c0: c, r1: r, c1: c };
    scrollToCell(r, c);
    repaint();
    emitSelect();
  }

  // ── range writes (delete / fill / paste) ──
  // Plain display text of a cell — the copy source and the fill seed.
  function cellPlainText(row, col) {
    const cell = provider.cellAt(row, col);
    if (cell == null || cell === PENDING) return '';
    if (cell.style && typeof cell.style.text === 'string') return cell.style.text;
    return cell.value == null ? '' : String(cell.value);
  }
  // Apply a batch of [row, col, raw] writes through the provider, then refresh
  // once. The provider owns coercion + dirty tracking (the app wraps commit).
  // beginBatch/endBatch (optional contract) group the writes into ONE undo step.
  async function applyWrites(writes) {
    if (!writes.length) return;
    if (provider.beginBatch) provider.beginBatch();
    try {
      for (const [r, c, v] of writes) {
        try { await provider.commit(r, c, v); }
        catch (e) { console.error('[loom] commit failed', e); }
      }
    } finally { if (provider.endBatch) provider.endBatch(); }
    refresh();
  }
  function clearRange() {
    if (g.readOnly) return;
    const s = normSel(g.sel); if (!s) return;
    const w = [];
    for (let r = s.r0; r <= s.r1; r++) for (let c = s.c0; c <= s.c1; c++) w.push([r, c, '']);
    applyWrites(w);
  }
  function fillDown() {
    if (g.readOnly) return;
    const s = normSel(g.sel); if (!s || s.r1 === s.r0) return;
    const w = [];
    for (let c = s.c0; c <= s.c1; c++) {
      const src = cellPlainText(s.r0, c);
      for (let r = s.r0 + 1; r <= s.r1; r++) w.push([r, c, src]);
    }
    applyWrites(w);
  }
  function fillRight() {
    if (g.readOnly) return;
    const s = normSel(g.sel); if (!s || s.c1 === s.c0) return;
    const w = [];
    for (let r = s.r0; r <= s.r1; r++) {
      const src = cellPlainText(r, s.c0);
      for (let c = s.c0 + 1; c <= s.c1; c++) w.push([r, c, src]);
    }
    applyWrites(w);
  }

  // ── clipboard (native copy/cut/paste on the focus holder) ──
  function selMatrix() {
    const s = normSel(g.sel); if (!s) return null;
    const m = [];
    for (let r = s.r0; r <= s.r1; r++) {
      const row = [];
      for (let c = s.c0; c <= s.c1; c++) row.push(cellPlainText(r, c));
      m.push(row);
    }
    return m;
  }
  function onCopy(e) {
    if (g.editing) return; // the cell input copies its own text
    const m = selMatrix(); if (!m) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', toTSV(m));
  }
  function onCut(e) {
    if (g.editing || g.readOnly) return;
    const m = selMatrix(); if (!m) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', toTSV(m));
    clearRange();
  }
  function onPaste(e) {
    if (g.editing || g.readOnly) return; // the cell input pastes into itself
    if (!e.clipboardData) return;
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    const m = parseTSV(text);
    if (!m.length) return;
    const s = normSel(g.sel) || { r0: 0, c0: 0, r1: 0, c1: 0 };
    const oneByOne = m.length === 1 && m[0].length === 1;
    const w = [];
    if (oneByOne && (s.r1 > s.r0 || s.c1 > s.c0)) {
      // A single value pasted over a range fills the whole range (Excel-like).
      const v = m[0][0];
      for (let r = s.r0; r <= s.r1 && r < M.totalRows; r++)
        for (let c = s.c0; c <= s.c1 && c < M.totalCols; c++) w.push([r, c, v]);
    } else {
      // Block paste anchored at the top-left, clipped to the grid (v1 base is
      // fixed-height, so a paste that runs past the last row simply stops).
      let maxCols = 0;
      for (let i = 0; i < m.length; i++) {
        const r = s.r0 + i; if (r >= M.totalRows) break;
        maxCols = Math.max(maxCols, m[i].length);
        for (let j = 0; j < m[i].length; j++) {
          const c = s.c0 + j; if (c >= M.totalCols) break;
          w.push([r, c, m[i][j]]);
        }
      }
      const r1 = clampR(s.r0 + m.length - 1), c1 = clampC(s.c0 + maxCols - 1);
      g.sel = { r0: s.r0, c0: s.c0, r1, c1 }; // select the pasted block
    }
    applyWrites(w).then(emitSelect);
  }

  function onKeyDown(e) {
    if (g.editing) return; // input handles its own keys
    if (!g.sel) return;
    const mod = e.ctrlKey || e.metaKey;
    const ext = e.shiftKey;
    const a = { r: g.sel.r1, c: g.sel.c1 };  // active (moving) corner
    const lastR = M.totalRows - 1, lastC = M.totalCols - 1;
    const page = Math.max(1, Math.floor(body.clientHeight / M.rowH) - 1);

    if (mod && !e.altKey) {
      switch (e.key) {
        case 'a': case 'A': e.preventDefault(); g.sel = { r0: 0, c0: 0, r1: lastR, c1: lastC }; repaint(); emitSelect(); return;
        // Copy/cut/paste are left to the native clipboard events on `clip`.
        case 'c': case 'C': case 'x': case 'X': case 'v': case 'V': return;
        // Undo/redo (optional provider contract). Ctrl+Z / Ctrl+Shift+Z + Ctrl+Y.
        case 'z': case 'Z': e.preventDefault(); if (e.shiftKey) { if (provider.redo) { provider.redo(); refresh(); } } else if (provider.undo) { provider.undo(); refresh(); } return;
        case 'y': case 'Y': e.preventDefault(); if (provider.redo) { provider.redo(); refresh(); } return;
        case 'd': case 'D': e.preventDefault(); fillDown(); return;
        case 'r': case 'R': e.preventDefault(); fillRight(); return;
        case 'ArrowUp':    e.preventDefault(); gotoCell(0, a.c, ext); return;
        case 'ArrowDown':  e.preventDefault(); gotoCell(lastR, a.c, ext); return;
        case 'ArrowLeft':  e.preventDefault(); gotoCell(a.r, 0, ext); return;
        case 'ArrowRight': e.preventDefault(); gotoCell(a.r, lastC, ext); return;
        case 'Home':       e.preventDefault(); gotoCell(0, 0, ext); return;
        case 'End':        e.preventDefault(); gotoCell(lastR, lastC, ext); return;
      }
      return;
    }
    if (e.altKey) return;

    switch (e.key) {
      case 'ArrowUp':    e.preventDefault(); gotoCell(a.r - 1, a.c, ext); return;
      case 'ArrowDown':  e.preventDefault(); gotoCell(a.r + 1, a.c, ext); return;
      case 'ArrowLeft':  e.preventDefault(); gotoCell(a.r, a.c - 1, ext); return;
      case 'ArrowRight': e.preventDefault(); gotoCell(a.r, a.c + 1, ext); return;
      case 'Home':       e.preventDefault(); gotoCell(a.r, 0, ext); return;
      case 'End':        e.preventDefault(); gotoCell(a.r, lastC, ext); return;
      case 'PageUp':     e.preventDefault(); gotoCell(a.r - page, a.c, ext); return;
      case 'PageDown':   e.preventDefault(); gotoCell(a.r + page, a.c, ext); return;
      case 'Enter': { const s = normSel(g.sel); e.preventDefault(); gotoCell(s.r0 + 1, s.c0, false); return; }
      case 'Tab':   { const s = normSel(g.sel); e.preventDefault(); gotoCell(s.r0, s.c0 + (e.shiftKey ? -1 : 1), false); return; }
      case 'F2':    { const s = normSel(g.sel); e.preventDefault(); startEdit(s.r0, s.c0); return; }
      case 'Delete': case 'Backspace': e.preventDefault(); clearRange(); return;
      default:
        if (e.key.length === 1) { const s = normSel(g.sel); e.preventDefault(); startEdit(s.r0, s.c0, e.key); return; }
    }
  }

  // ── column resize ──
  const RESIZE_HANDLE = 5;  // px proximity to a border that grabs the resize
  const MIN_COL_W = 30;     // px floor so a column can't vanish
  // The column whose right border is within RESIZE_HANDLE of clientX, or -1.
  // A column is resized by dragging its OWN right edge (so the left edge of
  // column c grabs column c-1, the standard spreadsheet feel).
  function colBorderAt(clientX) {
    const rect = colHdr.getBoundingClientRect();
    const x = clientX - rect.left + scroll.scrollLeft;
    if (x < 0) return -1;
    const c = Math.max(0, colAtX(M, x));
    let hit = -1;
    if (Math.abs(x - colXOf(c + 1)) <= RESIZE_HANDLE) hit = c;               // c's right edge
    else if (c > 0 && Math.abs(x - colXOf(c)) <= RESIZE_HANDLE) hit = c - 1; // c's left edge → prev col
    return (hit >= 0 && hit < M.totalCols) ? hit : -1;
  }
  // Autofit a column to the widest of its header label + the currently visible
  // cells (a bounded sample — virtualized grids can't measure every row).
  function autofitCol(c) {
    const ctx = g.colHdrCtx;
    let w = 0;
    ctx.font = '600 ' + g.hdrFontPx + 'px ' + g.mono;
    const h = provider.header ? provider.header(c) : null;
    const label = h == null ? '' : (typeof h === 'string' ? h : (h.label ?? ''));
    // The header paints decorations the label measure misses: a muted type glyph
    // (+12 advance) before the label, and right-edge indicators (sort ↑/↓, filter
    // ▽, invalid ⚠ — ~11px each) after it. Reserve them so autofit doesn't clip the
    // glyph against the label or run the label under the sort arrow.
    const obj = h && typeof h === 'object';
    const glyphExtra = obj && (h.type || h.calc) ? 12 : 0;
    let rightExtra = 0;
    if (obj && h.sort) rightExtra += 11;
    if (obj && h.filtered) rightExtra += 11;
    if (obj && h.invalid) rightExtra += 11;
    if (rightExtra) rightExtra += 4;                 // gap between the label and the indicators
    w = Math.max(w, ctx.measureText(String(label)).width + glyphExtra + rightExtra);
    ctx.font = g.fontPx + 'px ' + g.mono;
    const [r0, r1] = visibleRowRange(M, scroll.scrollTop, body.clientHeight);
    for (let r = r0; r <= r1; r++) w = Math.max(w, ctx.measureText(cellPlainText(r, c)).width);
    M.colWidths[c] = Math.max(MIN_COL_W, Math.ceil(w) + 16); // + padding both sides
    sizeCanvases();
    repaint();
  }
  function onHeaderMouseDown(e) {
    if (e.button !== 0) return;
    const c = colBorderAt(e.clientX);
    if (c < 0) {                       // not on a resize border — maybe a gutter brush
      const rect = colHdr.getBoundingClientRect();
      if (M.hdrGutterH > 0 && (e.clientY - rect.top) > M.hdrLabelH) { startGutterBrush(e, rect); }
      return;                          // (label area is inert: sort lives in the menu)
    }
    e.preventDefault();
    g.suppressHeaderClick = true;      // the ensuing click must not also sort
    const startX = e.clientX, startW = colWOf(c);
    document.body.style.cursor = 'col-resize';
    const onMove = (ev) => {
      M.colWidths[c] = Math.max(MIN_COL_W, startW + (ev.clientX - startX));
      sizeCanvases();                  // total width changed → resize the spacer
      repaint();
    };
    const onUp = () => {
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }
  function onHeaderMove(e) {
    if (document.body.style.cursor === 'col-resize') return; // mid-drag
    colHdr.style.cursor = colBorderAt(e.clientX) >= 0 ? 'col-resize' : '';
  }
  function onHeaderDblClick(e) {
    const c = colBorderAt(e.clientX);
    if (c < 0) return;
    e.preventDefault();
    g.suppressHeaderClick = true;
    autofitCol(c);
  }

  // Gutter brush: drag a range across a column's distribution glyph. NO filtering
  // happens during the drag — only a preview band; on release we emit onGutterBrush
  // (col, loFrac, hiFrac) ONCE. A drag under the threshold is a tap → onGutterClick
  // (stats), not a brush. Esc cancels mid-drag. (The host decides apply-vs-stage.)
  function startGutterBrush(e, rect) {
    const col = colAtX(M, e.clientX - rect.left + scroll.scrollLeft);
    if (col < 0 || col >= M.totalCols) return;
    e.preventDefault();
    g.suppressHeaderClick = true;
    const cw = colWOf(col), colLeft = colXOf(col) - scroll.scrollLeft;
    const at = (clientX) => Math.max(0, Math.min(cw, clientX - rect.left - colLeft));
    const x0 = at(e.clientX);
    g.gutterBrush = { col, x0, x1: x0, moved: false };
    repaint();
    const onMove = (ev) => { g.gutterBrush.x1 = at(ev.clientX); if (Math.abs(g.gutterBrush.x1 - x0) > 4) g.gutterBrush.moved = true; repaint(); };
    const done = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); window.removeEventListener('keydown', onKey, true); };
    const onUp = () => {
      const b = g.gutterBrush; done(); g.gutterBrush = null; repaint();
      if (!b) return;                                  // cancelled by Esc
      if (!b.moved) { for (const cb of g.gutterListeners) { try { cb(col); } catch (err) { console.error('[loom] onGutterClick threw', err); } } return; }
      const lo = Math.min(b.x0, b.x1) / cw, hi = Math.max(b.x0, b.x1) / cw;
      for (const cb of g.gutterBrushListeners) { try { cb(col, lo, hi); } catch (err) { console.error('[loom] onGutterBrush threw', err); } }
    };
    const onKey = (ev) => { if (ev.key === 'Escape') { done(); g.gutterBrush = null; repaint(); } };
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp); window.addEventListener('keydown', onKey, true);
  }

  // Column-header click → emit the column index (for click-to-sort, etc.).
  // Suppressed right after a border drag / autofit so a resize doesn't sort.
  function onHeaderClickEvt(e) {
    if (g.suppressHeaderClick) { g.suppressHeaderClick = false; return; }
    const rect = colHdr.getBoundingClientRect();
    const c = colAtX(M, e.clientX - rect.left + scroll.scrollLeft);
    if (c < 0 || c >= M.totalCols) return;
    // (gutter taps/brushes are handled in startGutterBrush via mousedown/up; a label
    // click is inert — sort lives in the header menu.)
    for (const cb of g.headerListeners) { try { cb(c); } catch (err) { console.error('[loom] onHeaderClick listener threw', err); } }
  }
  // Right-click a column header → emit (col, clientX, clientY); the host builds
  // the header menu (sort/autofit/revert-column/…). No listener → native menu.
  function onHeaderContextMenuEvt(e) {
    if (!g.headerContextListeners.length) return;
    e.preventDefault();
    const rect = colHdr.getBoundingClientRect();
    const c = colAtX(M, e.clientX - rect.left + scroll.scrollLeft);
    if (c < 0 || c >= M.totalCols) return;
    for (const cb of g.headerContextListeners) { try { cb({ col: c, clientX: e.clientX, clientY: e.clientY }); } catch (err) { console.error('[loom] onHeaderContextMenu listener threw', err); } }
  }
  colHdr.addEventListener('mousedown', onHeaderMouseDown);
  colHdr.addEventListener('mousemove', onHeaderMove);
  colHdr.addEventListener('dblclick', onHeaderDblClick);
  colHdr.addEventListener('click', onHeaderClickEvt);
  colHdr.addEventListener('contextmenu', onHeaderContextMenuEvt);
  g._cleanup.push(() => colHdr.removeEventListener('mousedown', onHeaderMouseDown));
  g._cleanup.push(() => colHdr.removeEventListener('mousemove', onHeaderMove));
  g._cleanup.push(() => colHdr.removeEventListener('dblclick', onHeaderDblClick));
  g._cleanup.push(() => colHdr.removeEventListener('click', onHeaderClickEvt));
  g._cleanup.push(() => colHdr.removeEventListener('contextmenu', onHeaderContextMenuEvt));

  // ── hover tooltip ──
  let hoverKey = null, hoverTimer = null;
  function hideTip() { tip.style.display = 'none'; }
  function onHoverMove(e) {
    if (g.editing || g.selDrag || !provider.cellTitle) { hideTip(); return; }
    const { row, col } = pointToCell(e.clientX, e.clientY);
    const k = row + ':' + col;
    if (k === hoverKey) return;            // same cell — leave the pending/shown tip
    hoverKey = k;
    hideTip();
    clearTimeout(hoverTimer);
    const cx = e.clientX, cy = e.clientY;
    hoverTimer = setTimeout(() => {
      const txt = provider.cellTitle(row, col);
      if (!txt) return;
      tip.textContent = txt;
      tip.style.left = (cx + 12) + 'px';
      tip.style.top = (cy + 16) + 'px';
      tip.style.display = 'block';
    }, 350);
  }
  function onHoverLeave() { hoverKey = null; clearTimeout(hoverTimer); hideTip(); }

  // ── context menu (right-click) ──
  // loom only DETECTS the gesture and emits (row,col,sel,clientX,clientY); the
  // host builds the menu (so its items run through the host's own mutation/undo
  // wiring). With no listener, the native menu shows (a bare grid stays default).
  function onContextMenuEvt(e) {
    if (!g.contextListeners.length) return;
    e.preventDefault();
    onHoverLeave();
    clip.focus();
    const { row, col } = pointToCell(e.clientX, e.clientY);
    const ns = normSel(g.sel);
    const inSel = ns && row >= ns.r0 && row <= ns.r1 && col >= ns.c0 && col <= ns.c1;
    if (!inSel) { g.sel = { r0: row, c0: col, r1: row, c1: col }; repaint(); emitSelect(); }
    const detail = { row, col, sel: normSel(g.sel), clientX: e.clientX, clientY: e.clientY };
    for (const cb of g.contextListeners) { try { cb(detail); } catch (err) { console.error('[loom] onContextMenu listener threw', err); } }
  }

  scroll.addEventListener('scroll', () => { if (g.editing) cancelEdit(); hideTip(); hoverKey = null; repaint(); }, { passive: true });
  scroll.addEventListener('mousedown', onMouseDown);
  scroll.addEventListener('dblclick', onDblClick);
  scroll.addEventListener('mousemove', onHoverMove);
  scroll.addEventListener('mouseleave', onHoverLeave);
  scroll.addEventListener('contextmenu', onContextMenuEvt);
  g._cleanup.push(() => scroll.removeEventListener('mousedown', onMouseDown));
  g._cleanup.push(() => scroll.removeEventListener('dblclick', onDblClick));
  g._cleanup.push(() => scroll.removeEventListener('mousemove', onHoverMove));
  g._cleanup.push(() => scroll.removeEventListener('mouseleave', onHoverLeave));
  g._cleanup.push(() => scroll.removeEventListener('contextmenu', onContextMenuEvt));
  g._cleanup.push(() => clearTimeout(hoverTimer));

  // Keyboard + clipboard live on the hidden focus holder (see scaffold above).
  clip.addEventListener('keydown', onKeyDown);
  clip.addEventListener('copy', onCopy);
  clip.addEventListener('cut', onCut);
  clip.addEventListener('paste', onPaste);
  g._cleanup.push(() => clip.removeEventListener('keydown', onKeyDown));
  g._cleanup.push(() => clip.removeEventListener('copy', onCopy));
  g._cleanup.push(() => clip.removeEventListener('cut', onCut));
  g._cleanup.push(() => clip.removeEventListener('paste', onPaste));

  const ro = new ResizeObserver(() => { sizeCanvases(); repaint(); });
  ro.observe(element);
  g._cleanup.push(() => ro.disconnect());

  // Async windowing: provider signals a window landed → repaint (upgrade #1).
  if (typeof provider.onReady === 'function') {
    const off = provider.onReady(() => repaint());
    if (typeof off === 'function') g._cleanup.push(off);
  }

  // ── public instance ──
  function refresh() {
    const d = provider.dims();
    M.totalRows = d.rows; M.totalCols = d.cols;
    sizeCanvases();
    repaint();
  }

  sizeCanvases();
  repaint();

  return {
    element,
    provider,
    refresh,
    getSelection() { return normSel(g.sel); },
    setSelection(sel) { setSel(sel, true); },
    onSelect(cb) { g.selectListeners.push(cb); return () => { const i = g.selectListeners.indexOf(cb); if (i >= 0) g.selectListeners.splice(i, 1); }; },
    onHeaderClick(cb) { g.headerListeners.push(cb); return () => { const i = g.headerListeners.indexOf(cb); if (i >= 0) g.headerListeners.splice(i, 1); }; },
    onContextMenu(cb) { g.contextListeners.push(cb); return () => { const i = g.contextListeners.indexOf(cb); if (i >= 0) g.contextListeners.splice(i, 1); }; },
    onHeaderContextMenu(cb) { g.headerContextListeners.push(cb); return () => { const i = g.headerContextListeners.indexOf(cb); if (i >= 0) g.headerContextListeners.splice(i, 1); }; },
    onGutterClick(cb) { g.gutterListeners.push(cb); return () => { const i = g.gutterListeners.indexOf(cb); if (i >= 0) g.gutterListeners.splice(i, 1); }; },
    onGutterBrush(cb) { g.gutterBrushListeners.push(cb); return () => { const i = g.gutterBrushListeners.indexOf(cb); if (i >= 0) g.gutterBrushListeners.splice(i, 1); }; },
    // Column widths (the sparse non-default map). get returns a copy; set
    // restores a saved map — the seam for persisting widths into a document's
    // view-state. autofitColumn measures the header + visible cells.
    getColWidths() { return { ...M.colWidths }; },
    setColWidths(widths) { M.colWidths = { ...(widths || {}) }; sizeCanvases(); repaint(); },
    autofitColumn(c) { autofitCol(c); },
    focus() { g.clip.focus(); },
    setColors(colors) {
      g.colors = colors;
      scroll.style.scrollbarColor = colors.scrollThumb + ' ' + colors.scrollTrack;
      corner.style.background = colors.hdrBg;
      repaint();
    },
    destroy() { for (const fn of g._cleanup) { try { fn(); } catch (_) {} } element.innerHTML = ''; },
  };
}
