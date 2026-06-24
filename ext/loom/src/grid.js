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
// delete/fill, and TSV copy/cut/paste. Clipboard rides a hidden focus-holding
// <textarea> so the native copy/cut/paste events carry e.clipboardData — no
// permission prompt, and it works under file:// (where navigator.clipboard is
// blocked). Still deferred (additive): column resize, zoom, frozen header rows,
// hover tooltips, variable row-height.

import { normSel, selEquals, PENDING, CellState, toTSV, parseTSV } from './model.js';
import { cellAt, colAtX, totalWidth, totalHeight } from './geometry.js';
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
      hdrH: options.hdrH || 24,
      rowHdrW: options.rowHdrW || 48,
      colWidths: options.colWidths || {},
      totalRows: dims.rows,
      totalCols: dims.cols,
    },
    sel: null,
    selDrag: false,
    editing: null,
    selectListeners: [],
    headerListeners: [],
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
  async function applyWrites(writes) {
    for (const [r, c, v] of writes) {
      try { await provider.commit(r, c, v); }
      catch (e) { console.error('[loom] commit failed', e); }
    }
    refresh();
  }
  function clearRange() {
    const s = normSel(g.sel); if (!s) return;
    const w = [];
    for (let r = s.r0; r <= s.r1; r++) for (let c = s.c0; c <= s.c1; c++) w.push([r, c, '']);
    applyWrites(w);
  }
  function fillDown() {
    const s = normSel(g.sel); if (!s || s.r1 === s.r0) return;
    const w = [];
    for (let c = s.c0; c <= s.c1; c++) {
      const src = cellPlainText(s.r0, c);
      for (let r = s.r0 + 1; r <= s.r1; r++) w.push([r, c, src]);
    }
    applyWrites(w);
  }
  function fillRight() {
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
    if (g.editing) return;
    const m = selMatrix(); if (!m) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', toTSV(m));
    clearRange();
  }
  function onPaste(e) {
    if (g.editing) return; // the cell input pastes into itself
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

  // Column-header click → emit the column index (for click-to-sort, etc.).
  function onHeaderClickEvt(e) {
    const rect = colHdr.getBoundingClientRect();
    const c = colAtX(M, e.clientX - rect.left + scroll.scrollLeft);
    if (c < 0 || c >= M.totalCols) return;
    for (const cb of g.headerListeners) { try { cb(c); } catch (err) { console.error('[loom] onHeaderClick listener threw', err); } }
  }
  colHdr.addEventListener('click', onHeaderClickEvt);
  g._cleanup.push(() => colHdr.removeEventListener('click', onHeaderClickEvt));

  scroll.addEventListener('scroll', () => { if (g.editing) cancelEdit(); repaint(); }, { passive: true });
  scroll.addEventListener('mousedown', onMouseDown);
  scroll.addEventListener('dblclick', onDblClick);
  g._cleanup.push(() => scroll.removeEventListener('mousedown', onMouseDown));
  g._cleanup.push(() => scroll.removeEventListener('dblclick', onDblClick));

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
