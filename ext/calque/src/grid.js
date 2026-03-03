// Grid renderer — calque result → DOM table display
//
// Takes a calque.run() result, renders each sheet as a <table>.
// Multiple sheets get tab buttons to switch between them.

export function grid(result) {
  const root = document.createElement('div');

  // Collect sheet tables
  const sections = [];
  for (const [name, data] of Object.entries(result.sheets)) {
    sections.push({ name, table: data.table });
  }

  // Bare bindings (not in any sheet block)
  const bareKeys = [];
  for (const [k, v] of Object.entries(result.bindings)) {
    if (v && v.__table) continue; // sheet table reference
    if (typeof v === 'function') continue;
    bareKeys.push(k);
  }
  if (bareKeys.length > 0) {
    sections.push({ name: 'Bindings', bare: bareKeys, bindings: result.bindings });
  }

  if (sections.length === 0) {
    root.textContent = '(no data)';
    return root;
  }

  // Render each section's DOM
  const panels = sections.map(s => s.bare ? renderBare(s) : renderTable(s.table));

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
