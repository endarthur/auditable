// Virtualized spreadsheet grid — canvas-based, scrollable to any position

const G = {
  BASE_COL_W: 100,
  BASE_ROW_H: 24,
  BASE_HDR_H: 24,
  BASE_ROW_W: 48,
  DEFAULT_COL_W: 100,
  ROW_H: 24,
  HDR_H: 24,
  ROW_W: 48,
  // Excel maximums
  MAX_ROWS: 1048576,
  MAX_COLS: 16384,
  // Per-column widths (sparse — only stores non-default)
  colWidths: {},
  // Cumulative x-offsets cache: colX[c] = x position of column c's left edge
  colX: null,
  totalW: 0,
  // runtime
  cells: null,
  maxRow: 0,
  maxCol: 0,
  totalRows: 1048576,
  totalCols: 16384,
  canvas: null,
  ctx: null,
  colHdrCanvas: null,
  colHdrCtx: null,
  rowHdrCanvas: null,
  rowHdrCtx: null,
  frozenCanvas: null,
  frozenCtx: null,
  frozenCorner: null,
  freezeRow: false,
  scrollEl: null,
  dpr: 1,
  // resize state
  resizeCol: -1,
  resizeStartX: 0,
  resizeStartW: 0,
  // selection state (cell range)
  sel: null,       // { r0, c0, r1, c1 } or null
  selDrag: false,  // currently dragging selection
  // cell source reverse map: key → { binding, index, tableCol, editable }
  cellSource: null,
  // cell editing state
  editing: null,   // { row, col, input, original, info, isNew }
  // cached font string
  _mono: null,
};

function cqColLetter(n) {
  let s = '';
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

function cqFmtVal(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

function cqIsNum(v) { return typeof v === 'number'; }
function cqIsCol(v) { return Array.isArray(v) || ArrayBuffer.isView(v); }
function cqIsTable(v) { return v && typeof v === 'object' && v.__table === true; }

function buildCellMap(sheetName, result) {
  const layoutResult = result._ast ? calque._layout(result._ast, result) : null;
  const sheetLayout = layoutResult && layoutResult.sheets[sheetName];
  const sheetData = result.sheets[sheetName];
  if (!sheetData) return null;

  const cells = new Map();
  const src = new Map();
  let maxCol = 0, maxRow = 0;

  const set = (r, c, text, header, numeric) => {
    cells.set(r * 16384 + c, { text, header, numeric });
    if (c > maxCol) maxCol = c;
    if (r > maxRow) maxRow = r;
  };
  const setSrc = (r, c, binding, index, tableCol, editable) => {
    src.set(r * 16384 + c, { binding, index, tableCol, editable });
  };

  if (sheetLayout && cqHasDirectives(sheetLayout)) {
    for (const [name, info] of Object.entries(sheetLayout.bindings)) {
      const label = info.label;
      const val = sheetData.scope.get(name);

      if (cqIsTable(val)) {
        for (let ci = 0; ci < val.headers.length; ci++) {
          const colName = val.headers[ci];
          if (label !== false) {
            set(info.row - 1, info.col + ci, colName, true, false);
          }
          const ed = isEditableValue(result._ast, sheetName, name, colName);
          const colData = val.columns[colName];
          if (cqIsCol(colData)) {
            for (let ri = 0; ri < colData.length; ri++) {
              set(info.row + ri, info.col + ci, cqFmtVal(colData[ri]), false, cqIsNum(colData[ri]));
              setSrc(info.row + ri, info.col + ci, name, ri, colName, ed);
            }
          } else {
            set(info.row, info.col + ci, cqFmtVal(colData), false, cqIsNum(colData));
            setSrc(info.row, info.col + ci, name, -1, colName, ed);
          }
        }
      } else {
        if (label === 'left') {
          if (info.col > 0) set(info.row, info.col - 1, name, true, false);
        } else if (label !== false) {
          set(info.row - 1, info.col, name, true, false);
        }
        const ed = isEditableValue(result._ast, sheetName, name, null);
        if (cqIsCol(val)) {
          for (let i = 0; i < val.length; i++) {
            set(info.row + i, info.col, cqFmtVal(val[i]), false, cqIsNum(val[i]));
            setSrc(info.row + i, info.col, name, i, null, ed);
          }
        } else {
          set(info.row, info.col, cqFmtVal(val), false, cqIsNum(val));
          setSrc(info.row, info.col, name, -1, null, ed);
        }
      }
    }
  } else {
    const table = sheetData.table;
    let gc = 0;
    for (let c = 0; c < table.headers.length; c++) {
      const col = table.columns[table.headers[c]];
      if (cqIsTable(col)) {
        for (let ci = 0; ci < col.headers.length; ci++) {
          const colName = col.headers[ci];
          set(0, gc, colName, true, false);
          const ed = isEditableValue(result._ast, sheetName, table.headers[c], colName);
          const colData = col.columns[colName];
          const rows = cqIsCol(colData) ? colData.length : 1;
          for (let r = 0; r < rows; r++) {
            const v = cqIsCol(colData) ? colData[r] : colData;
            set(r + 1, gc, cqFmtVal(v), false, cqIsNum(v));
            setSrc(r + 1, gc, table.headers[c], r, colName, ed);
          }
          gc++;
        }
      } else {
        set(0, gc, table.headers[c], true, false);
        const ed = isEditableValue(result._ast, sheetName, table.headers[c], null);
        const rows = cqIsCol(col) ? col.length : (table.rows || 1);
        for (let r = 0; r < rows; r++) {
          const v = cqIsCol(col) ? col[r] : col;
          set(r + 1, gc, cqFmtVal(v), false, cqIsNum(v));
          setSrc(r + 1, gc, table.headers[c], r, null, ed);
        }
        gc++;
      }
    }
  }

  return { cells, maxRow, maxCol, cellSource: src };
}

function cqHasDirectives(sheetLayout) {
  if (!sheetLayout) return false;
  for (const info of Object.values(sheetLayout.bindings)) {
    if (info.row !== 1) return true;
  }
  return false;
}

// ── Column width helpers ──

function colW(c) {
  return G.colWidths[c] || G.DEFAULT_COL_W;
}

// Rebuild cumulative x-offset array for visible range
// We can't precompute all 16384 columns, so we compute on-the-fly
// colXAt(c) = sum of widths of columns 0..c-1
function colXAt(c) {
  // For columns with default widths, it's just c * DEFAULT_COL_W
  // minus the difference for any custom-width columns before c
  let x = c * G.DEFAULT_COL_W;
  for (const [col, w] of Object.entries(G.colWidths)) {
    const ci = Number(col);
    if (ci < c) x += w - G.DEFAULT_COL_W;
  }
  return x;
}

// Find which column a given x-offset falls in (binary search not needed for scroll)
function colAtX(x) {
  let accum = 0;
  // Check custom-width columns first
  const customs = Object.keys(G.colWidths).map(Number).sort((a, b) => a - b);
  let lastCustom = -1;
  for (const ci of customs) {
    // Fill gap with default-width columns
    const gapCols = ci - lastCustom - 1;
    const gapEnd = accum + gapCols * G.DEFAULT_COL_W;
    if (x < gapEnd) {
      return lastCustom + 1 + Math.floor((x - accum) / G.DEFAULT_COL_W);
    }
    accum = gapEnd;
    // This custom column
    if (x < accum + G.colWidths[ci]) return ci;
    accum += G.colWidths[ci];
    lastCustom = ci;
  }
  // Past all custom columns, rest are default width
  return lastCustom + 1 + Math.floor((x - accum) / G.DEFAULT_COL_W);
}

// Find first/last visible columns for a scroll range
function visibleColRange(sx, vw) {
  const c0 = colAtX(sx);
  const c1 = colAtX(sx + vw);
  return [Math.max(0, c0), Math.min(G.totalCols - 1, c1)];
}

// Auto-fit column width to content
function autoFitCol(c) {
  if (!G.cells || !G.ctx) return;
  const mono = getMono();
  const ctx = G.ctx;
  const dpr = G.dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  let maxW = 30; // minimum

  // Measure header text
  const fs = Math.round(13 * CQ.zoom);
  ctx.font = '600 ' + fs + 'px ' + mono;
  const hdrText = cqColLetter(c);
  maxW = Math.max(maxW, ctx.measureText(hdrText).width + 16);

  // Measure data cells in this column
  const r0 = 0;
  const r1 = Math.min(G.maxRow, 10000); // don't scan the whole million
  for (let r = r0; r <= r1; r++) {
    const cell = G.cells.get(r * 16384 + c);
    if (!cell) continue;
    ctx.font = cell.header ? '600 ' + fs + 'px ' + mono : fs + 'px ' + mono;
    const w = ctx.measureText(cell.text).width + 16;
    if (w > maxW) maxW = w;
  }

  G.colWidths[c] = Math.ceil(Math.min(maxW, 500));
  saveColWidths();
  sizeCanvases();
  paintGrid();
}

function getMono() {
  if (!G._mono) {
    G._mono = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim();
  }
  return G._mono;
}

function isLight() { return CQ.theme === 'light'; }

function setZoom(level) {
  CQ.zoom = Math.round(Math.max(0.5, Math.min(2, level)) * 10) / 10;
  localStorage.setItem('cq-zoom', CQ.zoom);
  applyZoom();
}

function applyZoom() {
  const z = CQ.zoom;
  G.DEFAULT_COL_W = Math.round(G.BASE_COL_W * z);
  G.ROW_H = Math.round(G.BASE_ROW_H * z);
  G.HDR_H = Math.round(G.BASE_HDR_H * z);
  G.ROW_W = Math.round(G.BASE_ROW_W * z);
  G._mono = null;
  // Update CSS-positioned elements that use ROW_W
  const corner = $('.cq-grid-corner');
  if (corner) { corner.style.width = G.ROW_W + 'px'; corner.style.height = G.HDR_H + 'px'; }
  const colHdr = $('.cq-grid-col-hdr');
  if (colHdr) { colHdr.style.left = G.ROW_W + 'px'; colHdr.style.height = G.HDR_H + 'px'; }
  const rowHdr = $('.cq-grid-row-hdr');
  if (rowHdr) rowHdr.style.width = G.ROW_W + 'px';
  const frozen = $('.cq-grid-frozen');
  if (frozen) frozen.style.left = G.ROW_W + 'px';
  const frozenCorner = $('.cq-grid-frozen-corner');
  if (frozenCorner) { frozenCorner.style.width = G.ROW_W + 'px'; }
  const body = $('.cq-grid-body');
  if (body) body.style.left = G.ROW_W + 'px';
  sizeCanvases();
  paintGrid();
  // Sync zoom UI
  const pct = Math.round(z * 100);
  const slider = $('#cq-zoom-slider');
  if (slider) slider.value = pct;
  const label = $('#cq-zoom-pct');
  if (label) label.textContent = pct + '%';
}

function toggleFreeze() {
  G.freezeRow = !G.freezeRow;
  sizeCanvases();
  paintGrid();
}

function toggleTheme() {
  CQ.theme = CQ.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.classList.toggle('cq-light', CQ.theme === 'light');
  localStorage.setItem('cq-theme', CQ.theme);
  G._mono = null; // reset cached font
  paintGrid();
}

// Canvas colors — theme-aware
function gridColors() {
  if (isLight()) return {
    gridLine: '#ddd', hdrBg: '#e8e8e8', hdrBorder: '#ccc',
    hdrText: '#888', cellText: '#444', cellNum: '#3a7a30',
    cellHdrBg: 'rgba(138, 108, 42, 0.06)', cellHdrText: '#333',
    selFill: 'rgba(138, 108, 42, 0.12)', selStroke: '#8a6c2a',
    typeHint: '#bbb',
  };
  return {
    gridLine: '#1e1e1e', hdrBg: '#1a1a1a', hdrBorder: '#2a2a2a',
    hdrText: '#555', cellText: '#aaa', cellNum: '#8cb878',
    cellHdrBg: 'rgba(200, 155, 60, 0.04)', cellHdrText: '#ccc',
    selFill: 'rgba(200, 155, 60, 0.12)', selStroke: '#c89b3c',
    typeHint: '#3a3a3a',
  };
}

// ── Column width persistence ──

function saveColWidths() {
  if (!CQ.activeSheet) return;
  let all = {};
  try { all = JSON.parse(localStorage.getItem('cq-col-widths') || '{}'); } catch (_) {}
  // Only store non-empty
  if (Object.keys(G.colWidths).length > 0) {
    all[CQ.activeSheet] = G.colWidths;
  } else {
    delete all[CQ.activeSheet];
  }
  localStorage.setItem('cq-col-widths', JSON.stringify(all));
}

function loadColWidths(sheetName) {
  let all = {};
  try { all = JSON.parse(localStorage.getItem('cq-col-widths') || '{}'); } catch (_) {}
  G.colWidths = all[sheetName] ? { ...all[sheetName] } : {};
}

// ── Selection helpers ──

function cellAtPoint(clientX, clientY) {
  const rect = G.scrollEl.getBoundingClientRect();
  const x = clientX - rect.left + G.scrollEl.scrollLeft;
  const y = clientY - rect.top + G.scrollEl.scrollTop;
  const col = colAtX(x);
  const row = Math.floor(y / G.ROW_H);
  return { row: Math.max(0, row), col: Math.max(0, col) };
}

function updateFormulaBar() {
  const refEl = $('#cq-formula-ref');
  const valEl = $('#cq-formula-val');
  if (!refEl || !valEl) return;
  const sel = normSel(G.sel);
  if (!sel) { refEl.textContent = ''; valEl.textContent = ''; return; }
  const cellRef = cqColLetter(sel.c0) + (sel.r0 + 1);
  refEl.textContent = cellRef;
  setStatus('cursor', cellRef);
  const key = sel.r0 * 16384 + sel.c0;
  const info = G.cellSource ? G.cellSource.get(key) : null;
  const cell = G.cells ? G.cells.get(key) : null;
  if (info) {
    const parts = [info.binding];
    if (info.tableCol) parts.push('.' + info.tableCol);
    if (info.index >= 0) parts.push('[' + info.index + ']');
    const val = cell ? cell.text : '';
    valEl.textContent = parts.join('') + ' = ' + val;
  } else if (cell) {
    valEl.textContent = cell.text;
  } else {
    valEl.textContent = '';
  }
}

function normSel(sel) {
  if (!sel) return null;
  return {
    r0: Math.min(sel.r0, sel.r1),
    c0: Math.min(sel.c0, sel.c1),
    r1: Math.max(sel.r0, sel.r1),
    c1: Math.max(sel.c0, sel.c1),
  };
}

function onGridMouseDown(e) {
  // Only left-click, not on scrollbar
  if (e.button !== 0) return;
  if (G.tooltip) G.tooltip.style.display = 'none';
  if (G.editing) cancelCellEdit();
  const cell = cellAtPoint(e.clientX, e.clientY);
  G.sel = { r0: cell.row, c0: cell.col, r1: cell.row, c1: cell.col };
  G.selDrag = true;
  paintGrid();

  const onMove = (ev) => {
    const c = cellAtPoint(ev.clientX, ev.clientY);
    G.sel.r1 = c.row;
    G.sel.c1 = c.col;
    paintGrid();
  };

  const onUp = () => {
    G.selDrag = false;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ── Paste helpers ──

function calqueValue(v) {
  v = v.trim();
  if (v === '') return '""';
  // Strip surrounding quotes (Excel/sheets clipboard format)
  if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') {
    v = v.slice(1, -1).replace(/""/g, '"');
  }
  const n = Number(v);
  if (!isNaN(n) && v !== '') return v;
  if (v.toLowerCase() === 'true') return 'true';
  if (v.toLowerCase() === 'false') return 'false';
  return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function colSuffix(i) {
  return cqColLetter(i).toLowerCase();
}

function onPaste(useHeaders) {
  navigator.clipboard.readText().then(text => {
    if (!text.trim()) return;

    const sel = G.sel;
    const anchorCol = sel ? Math.min(sel.c0, sel.c1) : 0;
    const anchorRow = sel ? Math.min(sel.r0, sel.r1) : 0;
    const bindingName = cqColLetter(anchorCol) + (anchorRow + 1);

    const rows = text.trim().split('\n').map(line => line.split('\t'));
    if (rows.length === 0) return;

    const numCols = Math.max(...rows.map(r => r.length));
    let headers = [];
    let dataRows = rows;

    if (useHeaders && rows.length > 1) {
      headers = rows[0].map((h, i) => {
        const name = h.trim().replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1');
        return name || 'col_' + colSuffix(i);
      });
      dataRows = rows.slice(1);
    } else {
      for (let c = 0; c < numCols; c++) {
        headers.push(numCols === 1 ? 'value' : colSuffix(c));
      }
    }

    const directive = '  @anchor(' + anchorCol + ', ' + anchorRow + ', label: false)';

    // Single scalar — simple binding
    if (numCols === 1 && dataRows.length === 1) {
      const val = calqueValue(dataRows[0][0] || '');
      const binding = directive + '\n  ' + bindingName + ' = ' + val;
      insertIntoSheet(binding);
      setStatus('msg', 'pasted 1 value');
      return;
    }

    // Build table literal: { col: [vals], ... }
    const labelDirective = useHeaders
      ? '  @anchor(' + anchorCol + ', ' + anchorRow + ')'
      : directive;

    const cols = [];
    for (let c = 0; c < numCols; c++) {
      const vals = dataRows.map(row => calqueValue(row[c] || ''));
      const expr = vals.length === 1 ? vals[0] : '[' + vals.join(', ') + ']';
      cols.push('    ' + headers[c] + ': ' + expr);
    }

    const binding = labelDirective + '\n  ' + bindingName + ' = {\n' + cols.join(',\n') + ',\n  }';

    insertIntoSheet(binding);
    setStatus('msg', 'pasted ' + dataRows.length + ' rows, ' + numCols + ' cols');
  }).catch(() => {
    setStatus('msg', 'paste failed');
  });
}

function findSheetBlockEnd(source, sheetName) {
  const esc = sheetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = source.match(new RegExp('\\b' + esc + '\\s*\\{'));
  if (!m) return -1;

  let depth = 1;
  let i = m.index + m[0].length;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '"') {
      i++;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') i++;
        i++;
      }
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
    }
    i++;
  }
  return depth === 0 ? i - 1 : -1;
}

function ensureBlankLine(source, pos) {
  // Look backwards from pos for the preceding content
  let i = pos - 1;
  // Skip the immediate newline (end of previous line)
  while (i >= 0 && source[i] === ' ') i--;
  if (i >= 0 && source[i] === '\n') {
    i--;
    // Check if this blank line is truly blank
    while (i >= 0 && source[i] === ' ') i--;
    if (i < 0 || source[i] === '\n') return ''; // already a blank line
  }
  return '\n';
}

function insertIntoSheet(newCode) {
  const source = CQ.source;

  const pos = findSheetBlockEnd(source, CQ.activeSheet);
  if (pos >= 0) {
    // Named sheet block — insert before closing }
    const gap = ensureBlankLine(source, pos);
    updateEditorSource(source.slice(0, pos) + gap + newCode + '\n' + source.slice(pos));
    return;
  }

  if (CQ.activeSheet === 'Sheet1') {
    // Bare top-level bindings (no Sheet1 {} wrapper)
    const trimmed = source.trimEnd();
    const gap = ensureBlankLine(trimmed + '\n', trimmed.length + 1);
    updateEditorSource(trimmed + '\n' + gap + newCode + '\n');
  }
}

function updateEditorSource(newSource) {
  if (!CQ.editorView) return;
  CQ.editorView.dispatch({
    changes: { from: 0, to: CQ.editorView.state.doc.length, insert: newSource }
  });
}

// ── Cell editing ──

function isLiteralNode(node) {
  return ['NumberLit', 'StringLit', 'BoolLit', 'NullLit'].includes(node.type);
}

function isEditableValue(ast, sheetName, bindingName, tableCol) {
  if (!ast) return false;
  let nodes;
  if (sheetName === 'Sheet1') {
    nodes = ast.body.filter(n => n.type === 'Binding');
  } else {
    const sheet = ast.body.find(n => n.type === 'SheetBlock' && n.name === sheetName);
    nodes = sheet ? sheet.body.filter(n => n.type === 'Binding') : [];
  }
  const binding = nodes.find(n => n.name === bindingName);
  if (!binding) return false;

  let expr = binding.expr;
  if (tableCol !== null && expr.type === 'TableLit') {
    const col = expr.columns.find(c => c.name === tableCol);
    if (!col) return false;
    expr = col.values;
  }

  if (isLiteralNode(expr)) return true;
  if (expr.type === 'ArrayLit') return expr.elements.every(isLiteralNode);
  return false;
}

function startCellEdit(row, col, initialChar) {
  if (G.editing) cancelCellEdit();

  const key = row * 16384 + col;
  const info = G.cellSource ? G.cellSource.get(key) : null;
  const cell = G.cells ? G.cells.get(key) : null;

  if (cell && cell.header) return;
  if (info && !info.editable) {
    setStatus('msg', 'computed — not editable');
    return;
  }

  const input = document.createElement('input');
  input.className = 'cq-cell-input';
  input.type = 'text';
  input.style.fontSize = Math.round(13 * CQ.zoom) + 'px';

  const sx = G.scrollEl.scrollLeft;
  const sy = G.scrollEl.scrollTop;
  input.style.left = (colXAt(col) - sx) + 'px';
  input.style.top = (row * G.ROW_H - sy) + 'px';
  input.style.width = colW(col) + 'px';
  input.style.height = G.ROW_H + 'px';

  if (initialChar !== undefined) {
    input.value = initialChar;
  } else {
    input.value = cell ? cell.text : '';
  }

  G.editing = {
    row, col, input,
    original: cell ? cell.text : '',
    info: info || null,
    isNew: !info,
  };

  G.canvas.parentElement.appendChild(input);
  input.focus();
  if (initialChar !== undefined) {
    input.setSelectionRange(input.value.length, input.value.length);
  } else {
    input.select();
  }

  input.addEventListener('keydown', onEditKeyDown);
}

function onEditKeyDown(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    commitCellEdit(1, 0);
  } else if (e.key === 'Tab') {
    e.preventDefault();
    e.stopPropagation();
    commitCellEdit(0, e.shiftKey ? -1 : 1);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    cancelCellEdit();
  }
}

function toCalqueSource(text) {
  text = text.trim();
  if (text === '') return '""';
  const n = Number(text);
  if (!isNaN(n) && text !== '') return text;
  if (text === 'true' || text === 'false') return text;
  if (text.startsWith('"') && text.endsWith('"')) return text;
  return '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function commitCellEdit(dRow, dCol) {
  if (!G.editing) return;

  const { row, col, input, info, isNew } = G.editing;
  const newText = input.value.trim();
  const newCalque = toCalqueSource(newText);

  removeCellInput();

  if (newText === '' && isNew) {
    // empty new cell — do nothing
  } else if (isNew) {
    const cellRef = cqColLetter(col) + (row + 1);
    const directive = '@anchor(' + col + ', ' + row + ', label: false)';
    const binding = '  ' + directive + '\n  ' + cellRef + ' = ' + newCalque;
    insertIntoSheet(binding);
  } else if (info) {
    const pos = findValueInSource(info);
    if (pos) {
      CQ.editorView.dispatch({
        changes: { from: pos.from, to: pos.to, insert: newCalque }
      });
    }
  }

  // Move selection before eval so paintGrid highlights the right cell
  const newRow = Math.max(0, row + dRow);
  const newCol = Math.max(0, col + dCol);
  G.sel = { r0: newRow, c0: newCol, r1: newRow, c1: newCol };

  // Evaluate immediately — skip the 300ms debounce
  clearTimeout(CQ.evalTimer);
  cqEvaluate(CQ.source);
}

function cancelCellEdit() {
  removeCellInput();
}

function removeCellInput() {
  if (!G.editing) return;
  G.editing.input.removeEventListener('keydown', onEditKeyDown);
  G.editing.input.remove();
  G.editing = null;
}

function moveSel(s, dr, dc, extend) {
  if (extend) {
    // Shift held — move the far end, keep anchor
    const r = Math.max(0, G.sel.r1 + dr);
    const c = Math.max(0, G.sel.c1 + dc);
    G.sel = { r0: G.sel.r0, c0: G.sel.c0, r1: r, c1: c };
    scrollToCell(r, c);
  } else {
    const r = Math.max(0, s.r0 + dr);
    const c = Math.max(0, s.c0 + dc);
    G.sel = { r0: r, c0: c, r1: r, c1: c };
    scrollToCell(r, c);
  }
  paintGrid();
}

function scrollToCell(r, c) {
  const x = colXAt(c);
  const y = r * G.ROW_H;
  const vw = G.canvas.width / G.dpr;
  const vh = G.canvas.height / G.dpr;
  const sx = G.scrollEl.scrollLeft;
  const sy = G.scrollEl.scrollTop;

  if (x < sx) G.scrollEl.scrollLeft = x;
  else if (x + colW(c) > sx + vw) G.scrollEl.scrollLeft = x + colW(c) - vw;
  if (y < sy) G.scrollEl.scrollTop = y;
  else if (y + G.ROW_H > sy + vh) G.scrollEl.scrollTop = y + G.ROW_H - vh;
}

function clearCell(row, col) {
  const key = row * 16384 + col;
  const info = G.cellSource ? G.cellSource.get(key) : null;
  if (!info || !info.editable) return;

  const pos = findValueInSource(info);
  if (!pos) return;
  CQ.editorView.dispatch({
    changes: { from: pos.from, to: pos.to, insert: '""' }
  });
  clearTimeout(CQ.evalTimer);
  cqEvaluate(CQ.source);
}

// ── Jump between editor and grid ──

function jumpEditorGrid() {
  if (!CQ.editorView || !CQ.result || !CQ.result._ast) return;

  const editorEl = $('#cq-win-body');
  const inEditor = editorEl && editorEl.contains(document.activeElement);

  if (inEditor) {
    // Editor → Grid: find which binding the cursor is on, select that cell
    const cursor = CQ.editorView.state.selection.main.head;
    const curLine = CQ.editorView.state.doc.lineAt(cursor).number;
    jumpFromEditorToGrid(curLine);
  } else {
    // Grid → Editor: find the source position for the selected cell
    jumpFromGridToEditor();
  }
}

function jumpFromEditorToGrid(curLine) {
  const ast = CQ.result._ast;
  const layoutResult = calque._layout(ast, CQ.result);

  // Find which binding the cursor line falls within
  // Check all sheets for the best match
  let best = null;
  for (const node of ast.body) {
    if (node.type === 'Binding') {
      if (node.line <= curLine) {
        if (!best || node.line > best.line) best = { node, sheet: 'Sheet1' };
      }
    } else if (node.type === 'SheetBlock') {
      for (const child of node.body) {
        if (child.type === 'Binding' && child.line <= curLine) {
          if (!best || child.line > best.line) best = { node: child, sheet: node.name };
        }
      }
    }
  }
  if (!best) return;

  const sheetLayout = layoutResult.sheets[best.sheet];
  if (!sheetLayout) return;
  const info = sheetLayout.bindings[best.node.name];
  if (!info) return;

  // Switch sheet if needed
  if (CQ.activeSheet !== best.sheet) {
    saveColWidths();
    CQ.activeSheet = best.sheet;
  }

  G.sel = { r0: info.row, c0: info.col, r1: info.row, c1: info.col };
  document.activeElement.blur();
  renderGrid();
  scrollToCell(info.row, info.col);
  paintGrid();
}

function jumpFromGridToEditor() {
  const sel = normSel(G.sel);
  if (!sel) return;

  const key = sel.r0 * 16384 + sel.c0;
  const info = G.cellSource ? G.cellSource.get(key) : null;
  if (!info) return;

  const pos = findValueInSource(info);
  if (!pos) return;

  if (!isEditorVisible()) showEditorWindow();
  CQ.editorView.focus();
  CQ.editorView.dispatch({ selection: { anchor: pos.from, head: pos.to } });
}

// ── Source value locator ──

function findValueInSource(info) {
  const source = CQ.source;
  const { binding, index, tableCol } = info;
  const sheetName = CQ.activeSheet;

  // Find sheet block range
  let blockStart, blockEnd;
  if (sheetName === 'Sheet1') {
    blockStart = 0;
    blockEnd = source.length;
  } else {
    const esc = sheetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = source.match(new RegExp('\\b' + esc + '\\s*\\{'));
    if (!m) return null;
    blockStart = m.index + m[0].length;
    blockEnd = findSheetBlockEnd(source, sheetName);
    if (blockEnd < 0) return null;
  }

  // Find binding = within block
  const besc = binding.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = source.slice(blockStart, blockEnd);
  const bm = block.match(new RegExp('(?:^|\\n)[ \\t]*' + besc + '\\s*=', 'm'));
  if (!bm) return null;

  const eqPos = block.indexOf('=', bm.index + binding.length);
  let valStart = blockStart + eqPos + 1;
  while (valStart < blockEnd && ' \t'.includes(source[valStart])) valStart++;

  if (tableCol !== null) {
    // Navigate into table literal to find column's array element
    const cesc = tableCol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rest = source.slice(valStart);
    const cm = rest.match(new RegExp(cesc + '\\s*:\\s*'));
    if (!cm) return null;
    let colValStart = valStart + cm.index + cm[0].length;
    if (index >= 0 && source[colValStart] === '[') {
      return findNthElement(source, colValStart, index);
    }
    return findScalarEnd(source, colValStart, blockEnd);
  } else if (index >= 0) {
    if (source[valStart] === '[') {
      return findNthElement(source, valStart, index);
    }
    return null;
  }
  return findScalarEnd(source, valStart, blockEnd);
}

function findScalarEnd(source, start, limit) {
  let end = start;
  if (source[end] === '"') {
    end++;
    while (end < limit && source[end] !== '"') {
      if (source[end] === '\\') end++;
      end++;
    }
    end++;
  } else {
    while (end < limit && !'\n\r'.includes(source[end])) {
      if (source[end] === '/' && source[end + 1] === '/') break;
      if (source[end] === '#') break;
      end++;
    }
    while (end > start && ' \t'.includes(source[end - 1])) end--;
  }
  return { from: start, to: end };
}

function findNthElement(source, bracketPos, n) {
  let i = bracketPos + 1;
  let count = 0;

  while (i < source.length) {
    while (i < source.length && ' \t\n\r'.includes(source[i])) i++;
    if (source[i] === ']') break;

    const elemStart = i;
    if (source[i] === '"') {
      i++;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') i++;
        i++;
      }
      i++;
    } else {
      while (i < source.length && !' \t\n\r,]'.includes(source[i])) i++;
    }

    if (count === n) return { from: elemStart, to: i };
    count++;

    while (i < source.length && ' \t\n\r'.includes(source[i])) i++;
    if (source[i] === ',') i++;
  }
  return null;
}

// ── Create binding from selection ──

// Find the full source range of a binding (including preceding @directives)
// Returns { from, to } character offsets in source, or null
function findBindingRange(source, sheetName, bindingName) {
  let blockStart, blockEnd;
  if (sheetName === 'Sheet1') {
    blockStart = 0;
    blockEnd = source.length;
  } else {
    const esc = sheetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = source.match(new RegExp('\\b' + esc + '\\s*\\{'));
    if (!m) return null;
    blockStart = m.index + m[0].length;
    blockEnd = findSheetBlockEnd(source, sheetName);
    if (blockEnd < 0) return null;
  }

  const block = source.slice(blockStart, blockEnd);
  const besc = bindingName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bm = block.match(new RegExp('(?:^|\\n)([ \\t]*)(?:@[^\\n]*\\n[ \\t]*)*' + besc + '\\s*=', 'm'));
  if (!bm) return null;

  // from: start of directives or binding name (skip the leading \n if present)
  let from = blockStart + bm.index;
  if (source[from] === '\n') from++;

  // to: end of the binding expression — find the next binding or block end
  const eqPos = block.indexOf('=', bm.index + bm[0].length - 1);
  let valStart = blockStart + eqPos + 1;
  while (valStart < blockEnd && ' \t'.includes(source[valStart])) valStart++;

  let to;
  if (source[valStart] === '{') {
    // Table literal — find matching }
    let depth = 1, i = valStart + 1;
    while (i < blockEnd && depth > 0) {
      const ch = source[i];
      if (ch === '"') { i++; while (i < blockEnd && source[i] !== '"') { if (source[i] === '\\') i++; i++; } }
      else if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    to = i;
  } else if (source[valStart] === '[') {
    // Array literal — find matching ]
    let depth = 1, i = valStart + 1;
    while (i < blockEnd && depth > 0) {
      const ch = source[i];
      if (ch === '"') { i++; while (i < blockEnd && source[i] !== '"') { if (source[i] === '\\') i++; i++; } }
      else if (ch === '[') depth++;
      else if (ch === ']') depth--;
      i++;
    }
    to = i;
  } else {
    // Scalar — to end of line
    to = valStart;
    while (to < blockEnd && source[to] !== '\n') to++;
  }

  // Include trailing newline
  if (to < source.length && source[to] === '\n') to++;

  return { from, to };
}

// Remove all source bindings that back the selected cells
function removeSelectedBindings(sel) {
  if (!G.cellSource) return;
  const names = new Set();
  for (let r = sel.r0; r <= sel.r1; r++) {
    for (let c = sel.c0; c <= sel.c1; c++) {
      const info = G.cellSource.get(r * 16384 + c);
      if (info) names.add(info.binding);
    }
  }
  if (names.size === 0) return;

  let source = CQ.source;
  // Remove in reverse order of position to keep offsets valid
  const ranges = [];
  for (const name of names) {
    const range = findBindingRange(source, CQ.activeSheet, name);
    if (range) ranges.push(range);
  }
  ranges.sort((a, b) => b.from - a.from);

  for (const { from, to } of ranges) {
    source = source.slice(0, from) + source.slice(to);
  }

  // Clean up double blank lines left by removal
  source = source.replace(/\n{3,}/g, '\n\n');

  return source;
}

function deleteSelectedBindings(sel) {
  const cleaned = removeSelectedBindings(sel);
  if (cleaned === undefined) return;
  updateEditorSource(cleaned);
  clearTimeout(CQ.evalTimer);
  cqEvaluate(CQ.source);
  setStatus('msg', 'deleted bindings');
}

function createFromSelection(useHeaders) {
  const sel = normSel(G.sel);
  if (!sel || !G.cells) return;

  const anchorCol = sel.c0;
  const anchorRow = sel.r0;
  const bindingName = cqColLetter(anchorCol) + (anchorRow + 1);
  const numCols = sel.c1 - sel.c0 + 1;

  let startRow = sel.r0;
  let headers = [];

  if (useHeaders) {
    // Auto-detect: check if first row cells are headers
    let allHdr = true;
    for (let c = sel.c0; c <= sel.c1; c++) {
      const cell = G.cells.get(sel.r0 * 16384 + c);
      if (!cell || !cell.header) { allHdr = false; break; }
    }
    if (allHdr) {
      for (let c = sel.c0; c <= sel.c1; c++) {
        const cell = G.cells.get(sel.r0 * 16384 + c);
        const name = cell.text.trim().replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1');
        headers.push(name || 'col_' + colSuffix(c - sel.c0));
      }
      startRow = sel.r0 + 1;
    }
  }

  // Fall back to generic names
  if (headers.length === 0) {
    for (let c = 0; c < numCols; c++) headers.push(numCols === 1 ? 'value' : colSuffix(c));
  }

  const numRows = sel.r1 - startRow + 1;
  if (numRows <= 0) return;

  // Remove old source bindings that back these cells
  const cleaned = removeSelectedBindings(sel);
  if (cleaned !== undefined) {
    updateEditorSource(cleaned);
  }

  const directive = useHeaders && startRow > sel.r0
    ? '  @anchor(' + anchorCol + ', ' + anchorRow + ')'
    : '  @anchor(' + anchorCol + ', ' + anchorRow + ', label: false)';

  // Single scalar
  if (numCols === 1 && numRows === 1) {
    const cell = G.cells.get(startRow * 16384 + sel.c0);
    const val = cell ? calqueValue(cell.text) : '""';
    insertIntoSheet(directive + '\n  ' + bindingName + ' = ' + val);
    setStatus('msg', 'created binding');
    return;
  }

  // Single column
  if (numCols === 1) {
    const vals = [];
    for (let r = startRow; r <= sel.r1; r++) {
      const cell = G.cells.get(r * 16384 + sel.c0);
      vals.push(cell ? calqueValue(cell.text) : '""');
    }
    insertIntoSheet(directive + '\n  ' + bindingName + ' = [' + vals.join(', ') + ']');
    setStatus('msg', 'created column (' + numRows + ' rows)');
    return;
  }

  // Multi-column table
  const cols = [];
  for (let c = 0; c < numCols; c++) {
    const vals = [];
    for (let r = startRow; r <= sel.r1; r++) {
      const cell = G.cells.get(r * 16384 + (sel.c0 + c));
      vals.push(cell ? calqueValue(cell.text) : '""');
    }
    const expr = vals.length === 1 ? vals[0] : '[' + vals.join(', ') + ']';
    cols.push('    ' + headers[c] + ': ' + expr);
  }
  insertIntoSheet(directive + '\n  ' + bindingName + ' = {\n' + cols.join(',\n') + ',\n  }');
  setStatus('msg', 'created table (' + numRows + ' rows, ' + numCols + ' cols)');
}

// ── Copy ──

function copySelection() {
  const sel = normSel(G.sel);
  if (!sel || !G.cells) return;
  const lines = [];
  for (let r = sel.r0; r <= sel.r1; r++) {
    const cols = [];
    for (let c = sel.c0; c <= sel.c1; c++) {
      const cell = G.cells.get(r * 16384 + c);
      cols.push(cell ? cell.text : '');
    }
    lines.push(cols.join('\t'));
  }
  const tsv = lines.join('\n');
  navigator.clipboard.writeText(tsv).then(
    () => setStatus('msg', 'copied ' + (sel.r1 - sel.r0 + 1) + ' rows'),
    () => setStatus('msg', 'copy failed')
  );
}

// ── Grid setup ──

function initGridCanvas() {
  const gridEl = $('#cq-grid');
  G.dpr = window.devicePixelRatio || 1;

  gridEl.innerHTML = '';

  const corner = document.createElement('div');
  corner.className = 'cq-grid-corner';
  corner.style.width = G.ROW_W + 'px';
  corner.style.height = G.HDR_H + 'px';
  gridEl.appendChild(corner);

  const colHdr = document.createElement('canvas');
  colHdr.className = 'cq-grid-col-hdr';
  colHdr.style.left = G.ROW_W + 'px';
  colHdr.style.height = G.HDR_H + 'px';
  gridEl.appendChild(colHdr);
  G.colHdrCanvas = colHdr;
  G.colHdrCtx = colHdr.getContext('2d');

  const rowHdr = document.createElement('canvas');
  rowHdr.className = 'cq-grid-row-hdr';
  rowHdr.style.width = G.ROW_W + 'px';
  rowHdr.style.top = G.HDR_H + 'px';
  gridEl.appendChild(rowHdr);
  G.rowHdrCanvas = rowHdr;
  G.rowHdrCtx = rowHdr.getContext('2d');

  const frozenCorner = document.createElement('div');
  frozenCorner.className = 'cq-grid-frozen-corner';
  frozenCorner.style.width = G.ROW_W + 'px';
  gridEl.appendChild(frozenCorner);
  G.frozenCorner = frozenCorner;

  const frozen = document.createElement('canvas');
  frozen.className = 'cq-grid-frozen';
  frozen.style.left = G.ROW_W + 'px';
  gridEl.appendChild(frozen);
  G.frozenCanvas = frozen;
  G.frozenCtx = frozen.getContext('2d');

  const body = document.createElement('div');
  body.className = 'cq-grid-body';
  body.style.left = G.ROW_W + 'px';
  body.style.top = G.HDR_H + 'px';
  gridEl.appendChild(body);

  const scroll = document.createElement('div');
  scroll.className = 'cq-grid-scroll';
  body.appendChild(scroll);
  G.scrollEl = scroll;

  const spacer = document.createElement('div');
  spacer.className = 'cq-grid-spacer';
  scroll.appendChild(spacer);
  G.spacer = spacer;

  const canvas = document.createElement('canvas');
  canvas.className = 'cq-grid-canvas';
  body.appendChild(canvas);
  G.canvas = canvas;
  G.ctx = canvas.getContext('2d');

  scroll.addEventListener('scroll', () => {
    if (G.editing) cancelCellEdit();
    paintGrid();
  }, { passive: true });

  // Column resize: drag on header edges
  colHdr.addEventListener('mousedown', onColHdrMouseDown);
  colHdr.addEventListener('dblclick', onColHdrDblClick);
  colHdr.addEventListener('mousemove', onColHdrHover);

  // Cell hover tooltip
  const tooltip = document.createElement('div');
  tooltip.className = 'cq-cell-tooltip';
  tooltip.style.display = 'none';
  body.appendChild(tooltip);
  G.tooltip = tooltip;
  let hoverTimer = 0;

  scroll.addEventListener('mousemove', (e) => {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      if (!G.cells || !G.ctx) { tooltip.style.display = 'none'; return; }
      const cell = cellAtPoint(e.clientX, e.clientY);
      const data = G.cells.get(cell.row * 16384 + cell.col);
      if (!data || !data.text) { tooltip.style.display = 'none'; return; }
      const mono = getMono();
      G.ctx.setTransform(G.dpr, 0, 0, G.dpr, 0, 0);
      G.ctx.font = data.header ? '600 13px ' + mono : '13px ' + mono;
      const tw = G.ctx.measureText(data.text).width + 12;
      if (tw <= colW(cell.col)) { tooltip.style.display = 'none'; return; }
      const rect = body.getBoundingClientRect();
      tooltip.textContent = data.text;
      tooltip.style.left = (e.clientX - rect.left + 8) + 'px';
      tooltip.style.top = (e.clientY - rect.top - 24) + 'px';
      tooltip.style.display = 'block';
    }, 50);
  });

  scroll.addEventListener('mouseleave', () => {
    clearTimeout(hoverTimer);
    tooltip.style.display = 'none';
  });

  scroll.addEventListener('scroll', () => {
    tooltip.style.display = 'none';
  }, { passive: true });

  // Cell selection
  scroll.addEventListener('mousedown', onGridMouseDown);

  // Double-click to edit cell (preserves content)
  scroll.addEventListener('dblclick', (e) => {
    const cell = cellAtPoint(e.clientX, e.clientY);
    G.sel = { r0: cell.row, c0: cell.col, r1: cell.row, c1: cell.col };
    startCellEdit(cell.row, cell.col);
  });

  // Grid keyboard handling
  document.addEventListener('keydown', (e) => {
    // Skip if focus is inside the editor, cell input, or any input/textarea
    const active = document.activeElement;
    const editorEl = $('#cq-win-body');
    if (editorEl && editorEl.contains(active)) return;
    if (G.editing) return; // input handles its own keys
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;

    // Ctrl+Z undo / Ctrl+Shift+Z redo
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey && CQ.redo) CQ.redo();
      else if (CQ.undo) CQ.undo();
      clearTimeout(CQ.evalTimer);
      cqEvaluate(CQ.source);
      return;
    }
    // Alt+PageDown / Alt+PageUp — switch sheets
    if (e.altKey && (e.key === 'PageDown' || e.key === 'PageUp') && CQ.sheets && CQ.sheets.length > 1) {
      e.preventDefault();
      const idx = CQ.sheets.indexOf(CQ.activeSheet);
      const next = e.key === 'PageDown' ? (idx + 1) % CQ.sheets.length : (idx - 1 + CQ.sheets.length) % CQ.sheets.length;
      saveColWidths();
      CQ.activeSheet = CQ.sheets[next];
      renderGrid();
      return;
    }
    // Ctrl+C copy
    if ((e.ctrlKey || e.metaKey) && e.key === 'c' && G.sel && !e.shiftKey) {
      e.preventDefault();
      copySelection();
    }
    // Ctrl+V paste (generic)
    if ((e.ctrlKey || e.metaKey) && e.key === 'v' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      onPaste(false);
    }
    // Alt+V paste (with headers)
    if (e.altKey && e.key === 'v' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      onPaste(true);
    }
    // Shift+Alt+T — create binding from selection (auto-detect headers)
    if (e.altKey && e.shiftKey && e.key.toLowerCase() === 't' && !e.ctrlKey && !e.metaKey && G.sel) {
      e.preventDefault();
      createFromSelection(true);
    }
    // Alt+T — create binding from selection (generic names)
    if (e.altKey && !e.shiftKey && e.key === 't' && !e.ctrlKey && !e.metaKey && G.sel) {
      e.preventDefault();
      createFromSelection(false);
    }
    // Arrow keys — move or extend selection
    if (G.sel && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const s = normSel(G.sel);
      if (e.key === 'ArrowUp')    { e.preventDefault(); moveSel(s, -1, 0, e.shiftKey); }
      if (e.key === 'ArrowDown')  { e.preventDefault(); moveSel(s, 1, 0, e.shiftKey); }
      if (e.key === 'ArrowLeft')  { e.preventDefault(); moveSel(s, 0, -1, e.shiftKey); }
      if (e.key === 'ArrowRight') { e.preventDefault(); moveSel(s, 0, 1, e.shiftKey); }
      // Enter moves down
      if (e.key === 'Enter') { e.preventDefault(); moveSel(s, 1, 0); }
      // Tab moves right
      if (e.key === 'Tab') { e.preventDefault(); moveSel(s, 0, e.shiftKey ? -1 : 1); }
    }
    // F2 — edit current cell
    if (e.key === 'F2' && G.sel) {
      e.preventDefault();
      const s = normSel(G.sel);
      startCellEdit(s.r0, s.c0);
    }
    // Delete — clear cell (single) or remove bindings (multi-cell)
    if (e.key === 'Delete' && G.sel) {
      e.preventDefault();
      const s = normSel(G.sel);
      if (s.r0 === s.r1 && s.c0 === s.c1) {
        clearCell(s.r0, s.c0);
      } else {
        deleteSelectedBindings(s);
      }
    }
    // Type to edit — printable character starts editing
    if (G.sel && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const s = normSel(G.sel);
      startCellEdit(s.r0, s.c0, e.key);
      e.preventDefault();
    }
  });

  const ro = new ResizeObserver(() => {
    sizeCanvases();
    paintGrid();
  });
  ro.observe(gridEl);
}

// ── Column resize mouse handlers ──

function colEdgeAt(ex) {
  // ex is relative to the column header canvas
  const sx = G.scrollEl.scrollLeft;
  const x = ex + sx;
  // Check if x is near (within 4px) a column right edge
  // Walk columns from the first visible one
  const [c0] = visibleColRange(sx, G.colHdrCanvas.width / G.dpr);
  let cx = colXAt(c0);
  for (let c = c0; c < G.totalCols; c++) {
    cx += colW(c);
    if (cx - sx > ex + 200) break; // past viewport
    if (Math.abs((cx - sx) - ex) <= 4) return c;
  }
  return -1;
}

function onColHdrHover(e) {
  const rect = G.colHdrCanvas.getBoundingClientRect();
  const ex = e.clientX - rect.left;
  const col = colEdgeAt(ex);
  G.colHdrCanvas.style.cursor = col >= 0 ? 'col-resize' : 'default';
}

function onColHdrMouseDown(e) {
  const rect = G.colHdrCanvas.getBoundingClientRect();
  const ex = e.clientX - rect.left;
  const col = colEdgeAt(ex);
  if (col < 0) return;

  e.preventDefault();
  G.resizeCol = col;
  G.resizeStartX = e.clientX;
  G.resizeStartW = colW(col);

  const onMove = (ev) => {
    const delta = ev.clientX - G.resizeStartX;
    const newW = Math.max(30, G.resizeStartW + delta);
    G.colWidths[col] = newW;
    sizeCanvases();
    paintGrid();
  };

  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    G.resizeCol = -1;
    saveColWidths();
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function onColHdrDblClick(e) {
  const rect = G.colHdrCanvas.getBoundingClientRect();
  const ex = e.clientX - rect.left;
  const col = colEdgeAt(ex);
  if (col >= 0) autoFitCol(col);
}

// ── Canvas sizing ──

function sizeCanvases() {
  const gridEl = $('#cq-grid');
  const w = gridEl.clientWidth;
  const h = gridEl.clientHeight;
  const dpr = G.dpr;

  const frozenH = G.freezeRow ? G.ROW_H : 0;
  const viewW = w - G.ROW_W;
  const viewH = h - G.HDR_H - frozenH;

  G.canvas.width = viewW * dpr;
  G.canvas.height = viewH * dpr;
  G.canvas.style.width = viewW + 'px';
  G.canvas.style.height = viewH + 'px';

  G.colHdrCanvas.width = viewW * dpr;
  G.colHdrCanvas.height = G.HDR_H * dpr;
  G.colHdrCanvas.style.width = viewW + 'px';
  G.colHdrCanvas.style.height = G.HDR_H + 'px';

  // Frozen row canvas
  G.frozenCanvas.width = viewW * dpr;
  G.frozenCanvas.height = frozenH * dpr;
  G.frozenCanvas.style.width = viewW + 'px';
  G.frozenCanvas.style.height = frozenH + 'px';
  G.frozenCanvas.style.top = G.HDR_H + 'px';
  G.frozenCorner.style.top = G.HDR_H + 'px';
  G.frozenCorner.style.height = frozenH + 'px';

  // Adjust body and row header positions
  const bodyTop = G.HDR_H + frozenH;
  const bodyEl = G.canvas.parentElement;
  if (bodyEl) bodyEl.style.top = bodyTop + 'px';
  G.rowHdrCanvas.parentElement && (G.rowHdrCanvas.style.top = '0px');
  // Row header needs to start below frozen row
  const rowHdrParent = G.rowHdrCanvas;
  rowHdrParent.style.top = (G.HDR_H + frozenH) + 'px' ;

  G.rowHdrCanvas.width = G.ROW_W * dpr;
  G.rowHdrCanvas.height = viewH * dpr;
  G.rowHdrCanvas.style.width = G.ROW_W + 'px';
  G.rowHdrCanvas.style.height = viewH + 'px';

  // Compute total virtual width
  G.totalW = colXAt(G.totalCols);
  const maxPx = 16000000;
  G.spacer.style.width = Math.min(G.totalW, maxPx) + 'px';
  G.spacer.style.height = Math.min(G.totalRows * G.ROW_H, maxPx) + 'px';
}

// ── Paint ──

function paintFrozenRow(c0, c1, sx, vw) {
  const ctx = G.frozenCtx;
  if (!ctx) return;
  const dpr = G.dpr;
  const h = G.ROW_H;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, vw, h);

  const colors = gridColors();
  ctx.fillStyle = colors.hdrBg;
  ctx.fillRect(0, 0, vw, h);

  // Grid lines
  ctx.strokeStyle = colors.hdrBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let c = c0; c <= c1 + 1; c++) {
    const x = Math.round(colXAt(c) - sx) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  ctx.moveTo(0, h - 0.5);
  ctx.lineTo(vw, h - 0.5);
  ctx.stroke();

  // Paint row 0 cells
  if (!G.cells) return;
  const mono = getMono();
  const fs = Math.round(13 * CQ.zoom);
  const font = fs + 'px ' + mono;
  const hdrFont = '600 ' + fs + 'px ' + mono;
  const pad = 6;

  for (let c = c0; c <= c1; c++) {
    const cell = G.cells.get(0 * 16384 + c);
    if (!cell) continue;
    const x = colXAt(c) - sx;
    const w = colW(c);
    if (cell.header) {
      ctx.fillStyle = colors.cellHdrBg;
      ctx.fillRect(x + 1, 1, w - 1, h - 1);
      ctx.font = hdrFont;
      ctx.fillStyle = colors.cellHdrText;
    } else {
      ctx.font = font;
      ctx.fillStyle = cell.numeric ? colors.cellNum : colors.cellText;
    }
    ctx.textBaseline = 'middle';
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 1, 0, w - 2, h);
    ctx.clip();
    if (cell.numeric && !cell.header) {
      ctx.textAlign = 'right';
      ctx.fillText(cell.text, x + w - pad, h / 2);
    } else {
      ctx.textAlign = 'left';
      ctx.fillText(cell.text, x + pad, h / 2);
    }
    ctx.restore();
  }
}

function paintGrid() {
  if (!G.ctx) return;
  const dpr = G.dpr;
  const sx = G.scrollEl.scrollLeft;
  const sy = G.scrollEl.scrollTop;
  const vw = G.canvas.width / dpr;
  const vh = G.canvas.height / dpr;

  const [firstCol, lastCol] = visibleColRange(sx, vw);
  const firstRow = Math.floor(sy / G.ROW_H);
  const lastRow = Math.min(G.totalRows - 1, Math.ceil((sy + vh) / G.ROW_H));

  if (G.freezeRow) {
    // Offset scroll by one frozen row so row 0 data doesn't appear in body
    paintCells(firstCol, Math.max(1, firstRow), lastCol, lastRow, sx, sy, vw, vh);
    paintFrozenRow(firstCol, lastCol, sx, vw);
  } else {
    paintCells(firstCol, firstRow, lastCol, lastRow, sx, sy, vw, vh);
  }
  paintColHeaders(firstCol, lastCol, sx, vw);
  paintRowHeaders(G.freezeRow ? Math.max(1, firstRow) : firstRow, lastRow, sy, vh);
  updateFormulaBar();
}

function paintCells(c0, r0, c1, r1, sx, sy, vw, vh) {
  const ctx = G.ctx;
  const dpr = G.dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, vw, vh);

  const mono = getMono();
  const fs = Math.round(13 * CQ.zoom);
  const font = fs + 'px ' + mono;
  const hdrFont = '600 ' + fs + 'px ' + mono;

  const colors = gridColors();
  // Grid lines
  ctx.strokeStyle = colors.gridLine;
  ctx.lineWidth = 1;
  ctx.beginPath();

  // Vertical lines
  for (let c = c0; c <= c1 + 1; c++) {
    const x = Math.round(colXAt(c) - sx) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, vh);
  }
  // Horizontal lines
  for (let r = r0; r <= r1 + 1; r++) {
    const y = Math.round(r * G.ROW_H - sy) + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(vw, y);
  }
  ctx.stroke();

  // Cells
  const cells = G.cells;
  if (!cells) return;

  for (let r = r0; r <= r1; r++) {
    const y = r * G.ROW_H - sy;
    for (let c = c0; c <= c1; c++) {
      const cell = cells.get(r * 16384 + c);
      if (!cell) continue;

      const x = colXAt(c) - sx;
      const w = colW(c);
      const pad = 6;

      if (cell.header) {
        ctx.fillStyle = colors.cellHdrBg;
        ctx.fillRect(x + 1, y + 1, w - 1, G.ROW_H - 1);
        ctx.font = hdrFont;
        ctx.fillStyle = colors.cellHdrText;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.save();
        ctx.beginPath();
        ctx.rect(x + 1, y, w - 2, G.ROW_H);
        ctx.clip();
        ctx.fillText(cell.text, x + pad, y + G.ROW_H / 2);
        ctx.restore();
      } else {
        ctx.font = font;
        ctx.textBaseline = 'middle';
        ctx.save();
        ctx.beginPath();
        ctx.rect(x + 1, y, w - 2, G.ROW_H);
        ctx.clip();
        if (cell.numeric) {
          ctx.fillStyle = colors.cellNum;
          ctx.textAlign = 'right';
          ctx.fillText(cell.text, x + w - pad, y + G.ROW_H / 2);
        } else {
          ctx.fillStyle = colors.cellText;
          ctx.textAlign = 'left';
          ctx.fillText(cell.text, x + pad, y + G.ROW_H / 2);
        }
        ctx.restore();
      }
    }
  }

  // Selection highlight
  const sel = normSel(G.sel);
  if (sel) {
    ctx.fillStyle = colors.selFill;
    ctx.strokeStyle = colors.selStroke;
    ctx.lineWidth = 2;

    const x0 = colXAt(sel.c0) - sx;
    const y0 = sel.r0 * G.ROW_H - sy;
    const x1 = colXAt(sel.c1 + 1) - sx;
    const y1 = (sel.r1 + 1) * G.ROW_H - sy;

    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);
  }
}

function paintColHeaders(c0, c1, sx, vw) {
  const ctx = G.colHdrCtx;
  const dpr = G.dpr;
  const colors = gridColors();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, vw, G.HDR_H);

  ctx.fillStyle = colors.hdrBg;
  ctx.fillRect(0, 0, vw, G.HDR_H);

  const mono = getMono();
  const hfs = Math.round(11 * CQ.zoom);
  ctx.font = hfs + 'px ' + mono;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  ctx.strokeStyle = colors.hdrBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();

  for (let c = c0; c <= c1 + 1; c++) {
    const x = Math.round(colXAt(c) - sx) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, G.HDR_H);
  }
  ctx.moveTo(0, G.HDR_H - 0.5);
  ctx.lineTo(vw, G.HDR_H - 0.5);
  ctx.stroke();

  ctx.fillStyle = colors.hdrText;
  for (let c = c0; c <= c1; c++) {
    const x = colXAt(c) - sx + colW(c) / 2;
    ctx.fillText(cqColLetter(c), x, G.HDR_H / 2);
  }

  // Type hints
  if (G.cells) {
    ctx.font = Math.round(9 * CQ.zoom) + 'px ' + mono;
    ctx.fillStyle = colors.typeHint;
    ctx.textAlign = 'right';
    for (let c = c0; c <= c1; c++) {
      let hasNum = false, hasStr = false;
      for (let r = 0; r <= Math.min(G.maxRow, 500); r++) {
        const cell = G.cells.get(r * 16384 + c);
        if (!cell || cell.header || !cell.text) continue;
        if (cell.numeric) hasNum = true; else hasStr = true;
        if (hasNum && hasStr) break;
      }
      const hint = hasNum && hasStr ? '?' : hasNum ? '#' : hasStr ? 'T' : '';
      if (hint) {
        const x = colXAt(c) - sx + colW(c) - 4;
        ctx.fillText(hint, x, G.HDR_H / 2 + 1);
      }
    }
  }
}

function paintRowHeaders(r0, r1, sy, vh) {
  const ctx = G.rowHdrCtx;
  const dpr = G.dpr;
  const colors = gridColors();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, G.ROW_W, vh);

  ctx.fillStyle = colors.hdrBg;
  ctx.fillRect(0, 0, G.ROW_W, vh);

  const mono = getMono();
  const hfs = Math.round(11 * CQ.zoom);
  ctx.font = hfs + 'px ' + mono;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';

  ctx.strokeStyle = colors.hdrBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();

  for (let r = r0; r <= r1 + 1; r++) {
    const y = Math.round(r * G.ROW_H - sy) + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(G.ROW_W, y);
  }
  ctx.moveTo(G.ROW_W - 0.5, 0);
  ctx.lineTo(G.ROW_W - 0.5, vh);
  ctx.stroke();

  ctx.fillStyle = colors.hdrText;
  for (let r = r0; r <= r1; r++) {
    const y = r * G.ROW_H - sy + G.ROW_H / 2;
    ctx.fillText(String(r + 1), G.ROW_W - 6, y);
  }
}

// ── Render entry point ──

function renderGrid() {
  const tabbar = $('#cq-sheet-tabs');

  if (!CQ.result) {
    G.cells = null;
    tabbar.innerHTML = '';
    if (G.ctx) paintGrid();
    return;
  }

  CQ.sheets = Object.keys(CQ.result.sheets);
  if (CQ.sheets.length === 0) {
    G.cells = null;
    tabbar.innerHTML = '';
    if (G.ctx) paintGrid();
    return;
  }

  const prevSheet = CQ.activeSheet;
  if (!CQ.activeSheet || !CQ.sheets.includes(CQ.activeSheet)) {
    CQ.activeSheet = CQ.sheets[0];
  }
  const sheetChanged = prevSheet !== CQ.activeSheet;

  // Load per-sheet column widths
  if (sheetChanged) {
    loadColWidths(CQ.activeSheet);
    G.sel = { r0: 0, c0: 0, r1: 0, c1: 0 };
  }
  if (!G.sel) G.sel = { r0: 0, c0: 0, r1: 0, c1: 0 };

  // Sheet tabs
  tabbar.innerHTML = '';
  for (const name of CQ.sheets) {
    const tab = document.createElement('button');
    tab.className = 'cq-sheet-tab' + (name === CQ.activeSheet ? ' active' : '');
    tab.textContent = name;
    tab.onclick = () => { saveColWidths(); CQ.activeSheet = name; renderGrid(); };
    tabbar.appendChild(tab);
  }

  const map = buildCellMap(CQ.activeSheet, CQ.result);
  if (!map) {
    G.cells = null;
    if (G.ctx) paintGrid();
    return;
  }

  G.cells = map.cells;
  G.cellSource = map.cellSource;
  G.maxRow = map.maxRow;
  G.maxCol = map.maxCol;
  G.totalRows = G.MAX_ROWS;
  G.totalCols = G.MAX_COLS;


  sizeCanvases();

  if (sheetChanged && G.scrollEl) {
    G.scrollEl.scrollTop = 0;
    G.scrollEl.scrollLeft = 0;
  }

  paintGrid();
}
