// dee tool — menu bar

function initMenuBar() {
  const bar = $('#d3-menubar');
  if (!bar) return;
  bar.innerHTML = '';

  const menus = [
    { label: 'File', items: [
      { label: 'New', action: newProject, shortcut: 'Ctrl+N' },
      { label: 'Open Block Model CSV\u2026', action: openBlockCSV, shortcut: 'Ctrl+O' },
      { label: 'Open Drillholes\u2026', action: openDrillholeCSV },
      { type: 'sep' },
      { label: 'Export Screenshot', action: exportScreenshot, shortcut: 'Ctrl+Shift+S' },
    ]},
    { label: 'View', items: [
      { label: 'Perspective', action: () => D3.scene?.controls.fitAll(), shortcut: '1' },
      { label: 'Plan View', action: () => D3.scene?.controls.planView(), shortcut: '2' },
      { label: 'Section North', action: () => D3.scene?.controls.sectionNorth(), shortcut: '3' },
      { label: 'Section East', action: () => D3.scene?.controls.sectionEast(), shortcut: '4' },
      { type: 'sep' },
      { label: 'Toggle Sidebar', action: toggleSidebar, shortcut: 'Tab' },
      { label: 'Toggle Wireframe', action: toggleWireframe, shortcut: 'W' },
    ]},
    { label: 'Tools', items: [
      { label: 'Generate: Small (4K)', action: () => generateAndLoad('small') },
      { label: 'Generate: Medium (50K)', action: () => generateAndLoad('medium') },
      { label: 'Generate: Large (300K)', action: () => generateAndLoad('large') },
      { label: 'Generate: Stress (2M)', action: () => generateAndLoad('stress') },
      { type: 'sep' },
      { label: 'Draw Section Plane', action: enterSectionMode, shortcut: 'S' },
      { label: 'Clear Section', action: clearSection },
    ]},
    { label: 'Help', items: [
      { label: 'Keyboard Shortcuts', action: showShortcuts },
      { label: 'About', action: showAbout },
    ]},
  ];

  for (const menu of menus) {
    const item = document.createElement('div');
    item.className = 'd3-menu-item';
    item.textContent = menu.label;
    const dropdown = document.createElement('div');
    dropdown.className = 'd3-dropdown';
    for (const entry of menu.items) {
      if (entry.type === 'sep') { const s = document.createElement('div'); s.className = 'd3-sep'; dropdown.appendChild(s); continue; }
      const row = document.createElement('div');
      row.className = 'd3-dropdown-item';
      row.innerHTML = `<span>${entry.label}</span>${entry.shortcut ? `<span class="d3-shortcut">${entry.shortcut}</span>` : ''}`;
      row.onclick = () => { closeMenus(); entry.action(); };
      dropdown.appendChild(row);
    }
    item.appendChild(dropdown);
    item.onclick = (e) => {
      if (e.target === item) {
        const open = item.classList.contains('open');
        closeMenus();
        if (!open) item.classList.add('open');
      }
    };
    bar.appendChild(item);
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.d3-menu-item')) closeMenus();
  });
}

function closeMenus() {
  $$('.d3-menu-item.open').forEach(m => m.classList.remove('open'));
}

function toggleSidebar() {
  const sb = $('#d3-sidebar');
  if (!sb) return;
  D3.sidebarOpen = !D3.sidebarOpen;
  sb.classList.toggle('hidden', !D3.sidebarOpen);
  D3.scene?.resize();
}

function buildSidebar() {
  const content = $('#d3-sidebar-content');
  if (!content) return;
  content.innerHTML = '';

  // column selector
  if (D3.columnNames.length > 1) {
    const label = document.createElement('label');
    label.textContent = 'Column:';
    label.className = 'd3-label';
    const sel = document.createElement('select');
    sel.className = 'd3-select';
    for (const name of D3.columnNames) {
      const opt = document.createElement('option');
      opt.value = name; opt.textContent = name;
      if (name === D3.activeColumn) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.onchange = () => switchColumn(sel.value);
    content.appendChild(label);
    content.appendChild(sel);
  }

  // cutoff slider
  if (D3.columns[D3.activeColumn]) {
    const cv = D3.columns[D3.activeColumn];
    const s = _grid.stats(cv.values);
    const label = document.createElement('label');
    label.className = 'd3-label';
    label.textContent = 'Cutoff:';
    const row = document.createElement('div');
    row.className = 'd3-slider-row';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = s.min; slider.max = s.max; slider.step = (s.max - s.min) / 100;
    slider.value = D3.cutoff ?? s.min;
    slider.className = 'd3-slider';
    const val = document.createElement('span');
    val.className = 'd3-slider-val';
    val.textContent = D3.cutoff != null ? D3.cutoff.toFixed(1) : 'off';
    const btn = document.createElement('button');
    btn.textContent = 'Show All';
    btn.className = 'd3-btn-small';
    btn.onclick = () => { D3.cutoff = null; val.textContent = 'off'; updateCutoff(null); };
    slider.oninput = () => {
      const v = parseFloat(slider.value);
      val.textContent = v.toFixed(1);
      updateCutoff(v);
    };
    content.appendChild(label);
    row.appendChild(slider); row.appendChild(val);
    content.appendChild(row);
    content.appendChild(btn);
  }

  // palette
  const pLabel = document.createElement('label');
  pLabel.className = 'd3-label';
  pLabel.textContent = 'Palette:';
  content.appendChild(pLabel);
  for (const p of PALETTES) {
    const btn = document.createElement('button');
    btn.textContent = p;
    btn.className = 'd3-btn-small' + (p === D3.palette ? ' active' : '');
    btn.onclick = () => { updatePalette(p); buildSidebar(); };
    content.appendChild(btn);
  }
}

function generateAndLoad(size) {
  const loader = $('#d3-loader');
  if (loader) { loader.classList.remove('hidden'); loader.textContent = `generating ${size} model\u2026`; }

  setTimeout(() => {
    const result = generateSynthetic({ size, seed: Math.floor(Math.random() * 9999) });
    D3.columns = result.columns;
    D3.columnNames = result.columnNames;
    D3.fileName = `synthetic-${size}`;
    D3.dirty = false;

    if (!D3.scene) initScene();
    loadBlockModel(result.gridDef, result.compactVar, result.columnNames[0]);
    loadDrillholes(result.drillholes);
    startFPSCounter();
    buildSidebar();

    if (loader) loader.classList.add('hidden');
  }, 50);
}

function showShortcuts() {
  alert('1: Perspective  2: Plan  3: Section N  4: Section E\nTab: Toggle sidebar\nCtrl+O: Open CSV\nCtrl+Shift+S: Screenshot');
}

function showAbout() {
  alert('dee \u2014 3D block model viewer\nPart of the Auditable project\nhttps://github.com/endarthur/auditable');
}
