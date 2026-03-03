// Grid renderer — calque result → DOM table display
//
// Takes a calque.run() result, renders each sheet as a <table>.
// Multiple sheets get tab buttons to switch between them.
// When layout directives (@below, @right, @anchor) are used,
// renders a spreadsheet-style positioned grid.

import { layout } from './layout.js';
import { isColumn } from './stdlib.js';

export function grid(result) {
  const root = document.createElement('div');

  // Compute layout if AST is available
  const layoutResult = result._ast ? layout(result._ast, result) : null;

  // Collect sheet tables
  const sections = [];
  for (const [name, data] of Object.entries(result.sheets)) {
    const hasDirectives = layoutResult && hasPositionedBindings(layoutResult.sheets[name]);
    sections.push({ name, table: data.table, sheetLayout: hasDirectives ? layoutResult.sheets[name] : null, sheetData: data });
  }

  // Bare bindings (not in any sheet block)
  const bareKeys = [];
  for (const [k, v] of Object.entries(result.bindings)) {
    if (v && v.__table) continue; // sheet table reference
    if (typeof v === 'function') continue;
    bareKeys.push(k);
  }
  if (bareKeys.length > 0) {
    const hasDirectives = layoutResult && layoutResult.sheets['Sheet1'] && hasPositionedBindings(layoutResult.sheets['Sheet1']);
    sections.push({
      name: 'Bindings', bare: bareKeys, bindings: result.bindings,
      sheetLayout: hasDirectives ? layoutResult.sheets['Sheet1'] : null,
    });
  }

  if (sections.length === 0) {
    root.textContent = '(no data)';
    return root;
  }

  // Render each section's DOM
  const panels = sections.map(s => {
    if (s.sheetLayout) return renderPositioned(s);
    if (s.bare) return renderBare(s);
    return renderTable(s.table);
  });

  if (sections.length === 1) {
    root.appendChild(panels[0]);
    return root;
  }

  // Tab bar for multiple sections
  const tabBar = document.createElement('div');
  tabBar.style.cssText = 'display:flex;gap:0;margin-bottom:4px;';
  const btns = [];

  for (let i = 0; i < sections.length; i++) {
    const btn = document.createElement('button');
    btn.textContent = sections[i].name;
    btn.style.cssText = 'padding:3px 10px;border:1px solid #555;background:#1a1a1a;color:#aaa;cursor:pointer;font:inherit;font-size:0.85em;';
    if (i === 0) btn.style.borderRadius = '3px 0 0 3px';
    else if (i === sections.length - 1) btn.style.borderRadius = '0 3px 3px 0';
    else btn.style.borderRadius = '0';
    btn.onclick = () => show(i);
    tabBar.appendChild(btn);
    btns.push(btn);
  }

  const content = document.createElement('div');
  root.appendChild(tabBar);
  root.appendChild(content);

  function show(idx) {
    content.replaceChildren(panels[idx]);
    for (let i = 0; i < btns.length; i++) {
      btns[i].style.background = i === idx ? '#2a2a2a' : '#1a1a1a';
      btns[i].style.color = i === idx ? '#c89b3c' : '#aaa';
      btns[i].style.borderBottomColor = i === idx ? '#2a2a2a' : '#555';
    }
  }
  show(0);

  return root;
}

function hasPositionedBindings(sheetLayout) {
  if (!sheetLayout) return false;
  for (const info of Object.values(sheetLayout.bindings)) {
    if (info.row !== 1) return true;
  }
  return false;
}

function fmtCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

function isNum(v) {
  return typeof v === 'number';
}

function renderTable(table) {
  const t = document.createElement('table');
  t.style.cssText = 'border-collapse:collapse;font-size:0.9em;';

  // Header
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const h of table.headers) {
    const th = document.createElement('th');
    th.textContent = h;
    th.style.cssText = 'padding:3px 8px;border-bottom:1px solid #555;font-weight:600;text-align:left;';
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  t.appendChild(thead);

  // Body — render at least 1 row for scalar-only sheets
  const tbody = document.createElement('tbody');
  const rowCount = table.rows || (table.headers.length > 0 ? 1 : 0);
  for (let r = 0; r < rowCount; r++) {
    const tr = document.createElement('tr');
    for (const h of table.headers) {
      const td = document.createElement('td');
      const col = table.columns[h];
      const v = (Array.isArray(col) || ArrayBuffer.isView(col)) ? col[r] : col;
      td.textContent = fmtCell(v);
      td.style.cssText = 'padding:2px 8px;border-bottom:1px solid #333;';
      if (isNum(v)) td.style.textAlign = 'right';
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  t.appendChild(tbody);

  return t;
}

// ── Positioned grid renderer ──

function renderPositioned(section) {
  const sheetLayout = section.sheetLayout;
  const bindings = sheetLayout.bindings;

  // Get values from sheet data or bare bindings
  const getVal = (name) => {
    if (section.sheetData) return section.sheetData.scope.get(name);
    if (section.bindings) return section.bindings[name];
    return undefined;
  };

  // Build sparse cell map: { row → { col → { text, isHeader, isNum } } }
  const cellMap = new Map();
  let maxCol = 0;
  let maxRow = 0;

  const setCell = (r, c, text, isHeader, numeric) => {
    if (!cellMap.has(r)) cellMap.set(r, new Map());
    cellMap.get(r).set(c, { text, isHeader, isNum: numeric });
    if (c > maxCol) maxCol = c;
    if (r > maxRow) maxRow = r;
  };

  for (const [name, info] of Object.entries(bindings)) {
    const label = info.label;
    if (label === 'left') {
      // Header in cell to the left of data (same row), if col > 0
      if (info.col > 0) setCell(info.row, info.col - 1, name, true, false);
    } else if (label !== false) {
      // "above" or undefined: header in row above data (default)
      const headerRow = info.row - 1; // 0-indexed header row
      setCell(headerRow, info.col, name, true, false);
    }
    // label === false: no header cell

    const val = getVal(name);
    if (isColumn(val)) {
      for (let i = 0; i < val.length; i++) {
        setCell(info.row + i, info.col, fmtCell(val[i]), false, isNum(val[i]));
      }
    } else {
      setCell(info.row, info.col, fmtCell(val), false, isNum(val));
    }
  }

  // Render table
  const t = document.createElement('table');
  t.style.cssText = 'border-collapse:collapse;font-size:0.9em;';
  const tbody = document.createElement('tbody');

  for (let r = 0; r <= maxRow; r++) {
    const tr = document.createElement('tr');
    const rowData = cellMap.get(r);

    for (let c = 0; c <= maxCol; c++) {
      const cell = rowData && rowData.get(c);
      if (cell && cell.isHeader) {
        const th = document.createElement('th');
        th.textContent = cell.text;
        th.style.cssText = 'padding:3px 8px;border-bottom:1px solid #555;font-weight:600;text-align:left;';
        tr.appendChild(th);
      } else {
        const td = document.createElement('td');
        td.textContent = cell ? cell.text : '';
        td.style.cssText = 'padding:2px 8px;border-bottom:1px solid #333;';
        if (cell && cell.isNum) td.style.textAlign = 'right';
        tr.appendChild(td);
      }
    }

    tbody.appendChild(tr);
  }

  t.appendChild(tbody);
  return t;
}

function renderBare(section) {
  const t = document.createElement('table');
  t.style.cssText = 'border-collapse:collapse;font-size:0.9em;';

  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const h of ['name', 'value']) {
    const th = document.createElement('th');
    th.textContent = h;
    th.style.cssText = 'padding:3px 8px;border-bottom:1px solid #555;font-weight:600;text-align:left;';
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  t.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const k of section.bare) {
    const v = section.bindings[k];
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tdName.textContent = k;
    tdName.style.cssText = 'padding:2px 8px;border-bottom:1px solid #333;';
    tr.appendChild(tdName);

    const tdVal = document.createElement('td');
    if (Array.isArray(v) || ArrayBuffer.isView(v)) {
      tdVal.textContent = Array.from(v).map(fmtCell).join(', ');
    } else {
      tdVal.textContent = fmtCell(v);
    }
    tdVal.style.cssText = 'padding:2px 8px;border-bottom:1px solid #333;';
    if (isNum(v)) tdVal.style.textAlign = 'right';
    tr.appendChild(tdVal);

    tbody.appendChild(tr);
  }
  t.appendChild(tbody);

  return t;
}
