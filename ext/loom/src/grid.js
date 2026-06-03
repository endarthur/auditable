// @gcu/loom — grid: the host-agnostic createGrid factory (browser-only).
//
// createGrid(element, provider, options?) builds the canvas scaffold, wires
// scroll/mouse/keyboard, runs the edit→commit lifecycle, and returns an
// instance handle. No module globals — all state lives on the closure `g`, so
// any number of grids coexist in one page or surface (strata-spec §11,
// upgrade #4: host-agnostic mount, the seam that lets the same renderer drop
// into a standalone page OR a Works iframe unchanged).
//
// This is the de-risk slice: scaffold + virtualized scroll + select + edit +
// refresh + a first-class selection object. Deferred (second pass, additive):
// column resize, zoom, frozen header rows, hover tooltips, copy/paste.

import { normSel, selEquals } from './model.js';
import { cellAt, totalWidth, totalHeight } from './geometry.js';
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
  styleEl(scroll, { position: 'absolute', inset: 0, overflow: 'auto', outline: 'none' });
  scroll.tabIndex = 0; // focusable → keyboard scoped to this instance
  body.appendChild(scroll);
  g.scrollEl = scroll;

  const spacer = document.createElement('div');
  styleEl(spacer, { pointerEvents: 'none' });
  scroll.appendChild(spacer);
  g.spacer = spacer;

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
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelEdit(); scroll.focus(); }
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
    scroll.focus();
    refresh();
  }

  // ── events ──
  function onMouseDown(e) {
    if (e.button !== 0) return;
    if (g.editing) cancelEdit();
    scroll.focus();
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

  function moveSel(dr, dc, extend) {
    const s = normSel(g.sel) || { r0: 0, c0: 0, r1: 0, c1: 0 };
    if (extend) {
      const r = Math.max(0, g.sel.r1 + dr), c = Math.max(0, g.sel.c1 + dc);
      g.sel = { r0: g.sel.r0, c0: g.sel.c0, r1: r, c1: c };
      scrollToCell(r, c);
    } else {
      const r = Math.max(0, s.r0 + dr), c = Math.max(0, s.c0 + dc);
      g.sel = { r0: r, c0: c, r1: r, c1: c };
      scrollToCell(r, c);
    }
    repaint();
    emitSelect();
  }

  function onKeyDown(e) {
    if (g.editing) return; // input handles its own keys
    if (!g.sel) return;
    const s = normSel(g.sel);
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.key === 'ArrowUp')    { e.preventDefault(); moveSel(-1, 0, e.shiftKey); return; }
      if (e.key === 'ArrowDown')  { e.preventDefault(); moveSel(1, 0, e.shiftKey); return; }
      if (e.key === 'ArrowLeft')  { e.preventDefault(); moveSel(0, -1, e.shiftKey); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); moveSel(0, 1, e.shiftKey); return; }
      if (e.key === 'Enter')      { e.preventDefault(); moveSel(1, 0, false); return; }
      if (e.key === 'Tab')        { e.preventDefault(); moveSel(0, e.shiftKey ? -1 : 1, false); return; }
      if (e.key === 'F2')         { e.preventDefault(); startEdit(s.r0, s.c0); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        Promise.resolve(provider.commit(s.r0, s.c0, '')).then(refresh).catch((err) => console.error('[loom] clear failed', err));
        return;
      }
      if (e.key.length === 1) { e.preventDefault(); startEdit(s.r0, s.c0, e.key); return; }
    }
  }

  scroll.addEventListener('scroll', () => { if (g.editing) cancelEdit(); repaint(); }, { passive: true });
  scroll.addEventListener('mousedown', onMouseDown);
  scroll.addEventListener('dblclick', onDblClick);
  scroll.addEventListener('keydown', onKeyDown);
  g._cleanup.push(() => scroll.removeEventListener('mousedown', onMouseDown));
  g._cleanup.push(() => scroll.removeEventListener('dblclick', onDblClick));
  g._cleanup.push(() => scroll.removeEventListener('keydown', onKeyDown));

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
    focus() { g.scrollEl.focus(); },
    setColors(colors) { g.colors = colors; repaint(); },
    destroy() { for (const fn of g._cleanup) { try { fn(); } catch (_) {} } element.innerHTML = ''; },
  };
}
