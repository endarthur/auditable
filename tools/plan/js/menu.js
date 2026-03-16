// Classic dropdown menu bar

function initMenuBar() {
  const bar = $('#pp-menubar');

  const menus = [
    { label: 'File', items: [
      { label: 'New', action: newFile, shortcut: 'Ctrl+N' },
      { label: 'Open...', action: openFile, shortcut: 'Ctrl+O' },
      { type: 'sep' },
      { label: 'Save', action: saveFile, shortcut: 'Ctrl+S' },
      { label: 'Save As...', action: saveFileAs },
      { label: 'Rename...', action: renameProject },
    ], onOpen: buildRecentMenu },
    { label: 'Edit', items: [
      { label: 'Undo', action: undo, shortcut: 'Ctrl+Z' },
      { label: 'Redo', action: redo, shortcut: 'Ctrl+Y' },
      { type: 'sep' },
      { label: 'Add Task', action: () => { pushUndo(); PP.tasks.push(createTask()); PP.dirty = true; renderRows(); focusCell(PP.tasks.length - 1, 'id'); } },
      { label: 'Delete Task', action: () => { if (PP.ui.selectedRow >= 0) deleteRow(PP.ui.selectedRow); } },
      { type: 'sep' },
      { label: 'Save Baseline', action: saveBaseline },
      { label: 'Clear Baseline', action: clearBaseline },
    ]},
    { label: 'View', items: [
      { label: 'Toggle Tasks', action: toggleTaskWindow, shortcut: 'Ctrl+E' },
      { type: 'sep' },
      { label: 'Calendar', action: () => showSidebar('calendar') },
      { label: 'Earned Value', action: () => showSidebar('evm') },
      { label: 'Health', action: () => showSidebar('health') },
      { label: 'Compress', action: () => showSidebar('compress') },
    ]},
    { label: 'Analysis', items: [
      { label: 'Run Monte Carlo', action: () => runMC(), shortcut: 'Ctrl+M' },
      { label: 'Clear Simulation', action: () => { PP.mcResult = null; if (PP.projectId) mcDelete(PP.projectId); updateGantt(); setStatus('msg', 'simulation cleared'); } },
      { type: 'sep' },
      { label: 'Results...', action: () => showSidebar('mc') },
      { label: 'Sensitivity...', action: () => showSidebar('sensitivity') },
      { label: 'Burndown...', action: () => showSidebar('burndown') },
    ]},
    { label: 'Help', items: [
      { label: 'Keyboard Shortcuts', action: showShortcuts },
      { type: 'sep' },
      { label: 'About Plan', action: showAbout },
    ]},
  ];

  for (const menu of menus) {
    const item = document.createElement('div');
    item.className = 'pp-menu-item';

    const label = document.createElement('button');
    label.className = 'pp-menu-label';
    label.textContent = menu.label;
    item.appendChild(label);

    const dropdown = document.createElement('div');
    dropdown.className = 'pp-dropdown';

    for (const entry of menu.items) {
      if (entry.type === 'sep') {
        const sep = document.createElement('div');
        sep.className = 'pp-menu-sep';
        dropdown.appendChild(sep);
        continue;
      }
      const btn = document.createElement('button');
      btn.className = 'pp-menu-entry';
      const lbl = document.createElement('span');
      lbl.textContent = entry.label;
      btn.appendChild(lbl);
      if (entry.shortcut) {
        const sc = document.createElement('span');
        sc.className = 'pp-menu-shortcut';
        sc.textContent = entry.shortcut;
        btn.appendChild(sc);
      }
      btn.addEventListener('click', () => {
        closeMenus();
        entry.action();
      });
      dropdown.appendChild(btn);
    }

    item.appendChild(dropdown);
    bar.appendChild(item);

    label.addEventListener('click', e => {
      e.stopPropagation();
      if (item.classList.contains('open')) {
        closeMenus();
      } else {
        closeMenus();
        if (menu.onOpen) menu.onOpen(dropdown);
        item.classList.add('open');
        PP.menuOpen = item;
      }
    });

    label.addEventListener('mouseenter', () => {
      if (PP.menuOpen && PP.menuOpen !== item) {
        closeMenus();
        if (menu.onOpen) menu.onOpen(dropdown);
        item.classList.add('open');
        PP.menuOpen = item;
      }
    });
  }

  document.addEventListener('click', e => {
    if (PP.menuOpen && !e.target.closest('.pp-menu-item')) {
      closeMenus();
    }
  });
}

function buildRecentMenu(dropdown) {
  const old = dropdown.querySelector('.pp-menu-recent');
  if (old) old.remove();

  const projects = getProjects();
  if (!projects.length) return;

  const frag = document.createElement('div');
  frag.className = 'pp-menu-recent';

  const sep = document.createElement('div');
  sep.className = 'pp-menu-sep';
  frag.appendChild(sep);

  const header = document.createElement('div');
  header.className = 'pp-menu-entry';
  header.textContent = 'Recent';
  header.style.color = 'var(--fg-dim)';
  header.style.fontSize = '0.85em';
  header.style.cursor = 'default';
  frag.appendChild(header);

  for (const p of projects.slice(0, 8)) {
    const btn = document.createElement('button');
    btn.className = 'pp-menu-entry';
    const lbl = document.createElement('span');
    lbl.textContent = p.name;
    lbl.style.overflow = 'hidden';
    lbl.style.textOverflow = 'ellipsis';
    lbl.style.whiteSpace = 'nowrap';
    btn.appendChild(lbl);
    if (p.id === PP.projectId) {
      lbl.style.color = 'var(--accent)';
    }
    const time = document.createElement('span');
    time.className = 'pp-menu-shortcut';
    time.textContent = timeAgo(p.ts);
    btn.appendChild(time);
    btn.addEventListener('click', () => {
      closeMenus();
      if (p.id === PP.projectId) return;
      projectSave();
      const data = projectLoad(p.id);
      if (data) {
        loadProjectData(data);
        PP.fileHandle = null;
        PP.dirty = false;
        PP.fileName = p.name;
        startProject();
      }
    });
    frag.appendChild(btn);
  }

  dropdown.appendChild(frag);
}

function closeMenus() {
  $$('.pp-menu-item.open').forEach(m => m.classList.remove('open'));
  PP.menuOpen = null;
}

function showShortcuts() {
  showModal('Keyboard Shortcuts',
    'FILE\n'
    + '  Ctrl+S \u2014 Save\n'
    + '  Ctrl+O \u2014 Open\n'
    + '  Ctrl+N \u2014 New\n\n'
    + 'VIEW\n'
    + '  Ctrl+E \u2014 Toggle Tasks\n\n'
    + 'ANALYSIS\n'
    + '  Ctrl+M \u2014 Run Monte Carlo\n\n'
    + 'EDIT\n'
    + '  Ctrl+Z \u2014 Undo\n'
    + '  Ctrl+Y \u2014 Redo\n'
    + '  Ctrl+Delete \u2014 Delete Row\n\n'
    + 'GRID\n'
    + '  Enter \u2014 Next Row\n'
    + '  Tab / Shift+Tab \u2014 Next / Prev Cell\n'
    + '  Escape \u2014 Cancel Edit\n'
    + '  Right-click row # \u2014 Context Menu'
  );
}

function showAbout() {
  showModal('About Plan',
    'Plan \u2014 project scheduling tool\n\n'
    + 'PERT estimation, critical path, Monte Carlo simulation,\n'
    + 'Gantt charts, earned value management.\n\n'
    + 'Part of the Auditable project.\n'
    + 'https://github.com/endarthur/auditable'
  );
}

function showModal(title, text) {
  let overlay = $('#pp-modal-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'pp-modal-overlay';
    overlay.className = 'pp-modal-overlay';
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = '<div class="pp-modal">'
    + '<div class="pp-modal-title">' + title + '</div>'
    + '<pre class="pp-modal-body">' + text.replace(/</g, '&lt;') + '</pre>'
    + '<button class="pp-modal-close" onclick="this.closest(\'.pp-modal-overlay\').remove()">close</button>'
    + '</div>';
  overlay.style.display = 'flex';
}
