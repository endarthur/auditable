// Classic dropdown menu bar

function initMenuBar() {
  const bar = $('#cq-menubar');

  const menus = [
    { label: 'File', items: [
      { label: 'New', action: newFile, shortcut: 'Ctrl+N' },
      { label: 'Open .calque...', action: openFile, shortcut: 'Ctrl+O' },
      { type: 'sep' },
      { label: 'Import .xlsx...', action: importXlsx },
      { type: 'sep' },
      { label: 'Save', action: saveFile, shortcut: 'Ctrl+S' },
      { label: 'Save As...', action: saveFileAs },
      { label: 'Rename...', action: renameProject },
      { type: 'sep' },
      { label: 'Export .xlsx', action: exportXlsx },
    ], onOpen: buildRecentMenu },
    { label: 'Edit', items: [
      { label: 'Undo', action: () => editorCmd('undo'), shortcut: 'Ctrl+Z' },
      { label: 'Redo', action: () => editorCmd('redo'), shortcut: 'Ctrl+Shift+Z' },
      { type: 'sep' },
      { label: 'Select All', action: () => editorCmd('selectAll'), shortcut: 'Ctrl+A' },
    ]},
    { label: 'View', items: [
      { label: 'Toggle Editor', action: toggleEditor, shortcut: 'Ctrl+E' },
    ]},
    { label: 'Help', items: [
      { label: 'Keyboard Shortcuts', action: showShortcuts },
      { type: 'sep' },
      { label: 'About Calque', action: showAbout },
    ]},
  ];

  for (const menu of menus) {
    const item = document.createElement('div');
    item.className = 'cq-menu-item';

    const label = document.createElement('button');
    label.className = 'cq-menu-label';
    label.textContent = menu.label;
    item.appendChild(label);

    const dropdown = document.createElement('div');
    dropdown.className = 'cq-dropdown';

    for (const entry of menu.items) {
      if (entry.type === 'sep') {
        const sep = document.createElement('div');
        sep.className = 'cq-menu-sep';
        dropdown.appendChild(sep);
        continue;
      }
      const btn = document.createElement('button');
      btn.className = 'cq-menu-entry';
      const lbl = document.createElement('span');
      lbl.textContent = entry.label;
      btn.appendChild(lbl);
      if (entry.shortcut) {
        const sc = document.createElement('span');
        sc.className = 'cq-menu-shortcut';
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

    // Open on click
    label.addEventListener('click', e => {
      e.stopPropagation();
      if (item.classList.contains('open')) {
        closeMenus();
      } else {
        closeMenus();
        if (menu.onOpen) menu.onOpen(dropdown);
        item.classList.add('open');
        CQ.menuOpen = item;
      }
    });

    // Hover-switch between menus when one is open
    label.addEventListener('mouseenter', () => {
      if (CQ.menuOpen && CQ.menuOpen !== item) {
        closeMenus();
        if (menu.onOpen) menu.onOpen(dropdown);
        item.classList.add('open');
        CQ.menuOpen = item;
      }
    });
  }

  // Close on click outside
  document.addEventListener('click', e => {
    if (CQ.menuOpen && !e.target.closest('.cq-menu-item')) {
      closeMenus();
    }
  });
}

function buildRecentMenu(dropdown) {
  // Remove previous recent section
  const old = dropdown.querySelector('.cq-menu-recent');
  if (old) old.remove();

  const projects = getProjects();
  if (!projects.length) return;

  const frag = document.createElement('div');
  frag.className = 'cq-menu-recent';

  const sep = document.createElement('div');
  sep.className = 'cq-menu-sep';
  frag.appendChild(sep);

  const header = document.createElement('div');
  header.className = 'cq-menu-entry cq-menu-recent-header';
  header.textContent = 'Recent';
  header.style.color = 'var(--fg-dim)';
  header.style.fontSize = '0.85em';
  header.style.cursor = 'default';
  frag.appendChild(header);

  for (const p of projects.slice(0, 8)) {
    const btn = document.createElement('button');
    btn.className = 'cq-menu-entry';
    const lbl = document.createElement('span');
    lbl.textContent = p.name;
    lbl.style.overflow = 'hidden';
    lbl.style.textOverflow = 'ellipsis';
    lbl.style.whiteSpace = 'nowrap';
    btn.appendChild(lbl);
    if (p.id === CQ.projectId) {
      lbl.style.color = 'var(--accent)';
    }
    const time = document.createElement('span');
    time.className = 'cq-menu-shortcut';
    time.textContent = timeAgo(p.ts);
    btn.appendChild(time);
    btn.addEventListener('click', () => {
      closeMenus();
      if (p.id === CQ.projectId) return;
      // Save current, load selected
      projectSave();
      const src = projectLoad(p.id);
      if (src != null) {
        CQ.source = src;
        CQ.fileHandle = null;
        CQ.dirty = false;
        CQ.importData = null;
        CQ.fileName = p.name;
        setEditorSource(CQ.source);
        cqEvaluate(CQ.source);
        updateTitle();
      }
    });
    frag.appendChild(btn);
  }

  dropdown.appendChild(frag);
}

function closeMenus() {
  $$('.cq-menu-item.open').forEach(m => m.classList.remove('open'));
  CQ.menuOpen = null;
}

function editorCmd(cmd) {
  if (!CQ.editorView) return;
  const v = CQ.editorView;
  if (cmd === 'undo') window.CM6.undo(v);
  else if (cmd === 'redo') window.CM6.redo(v);
  else if (cmd === 'selectAll') {
    v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } });
  }
  v.focus();
}

function toggleEditor() {
  if (!isEditorVisible()) {
    showEditorWindow();
    if (CQ.editorView) CQ.editorView.focus();
  } else {
    const editorEl = $('#cq-win-body');
    if (editorEl && editorEl.contains(document.activeElement)) {
      // Focus is in editor — move to grid
      document.activeElement.blur();
    } else {
      // Focus is on grid — move to editor
      if (CQ.editorView) CQ.editorView.focus();
    }
  }
}

function showShortcuts() {
  showModal('Keyboard Shortcuts',
    'FILE\n' +
    '  Ctrl+S \u2014 Save\n' +
    '  Ctrl+O \u2014 Open\n' +
    '  Ctrl+N \u2014 New\n\n' +
    'EDITOR\n' +
    '  Ctrl+E \u2014 Toggle Editor / Focus\n' +
    '  Ctrl+Shift+E \u2014 Jump Editor \u2194 Cell\n' +
    '  Ctrl+Z \u2014 Undo\n' +
    '  Ctrl+Shift+Z \u2014 Redo\n' +
    '  Ctrl+/ \u2014 Toggle Comment\n\n' +
    'GRID\n' +
    '  Arrows \u2014 Navigate\n' +
    '  Shift+Arrows \u2014 Extend Selection\n' +
    '  Enter / Tab \u2014 Move Down / Right\n' +
    '  F2 / type \u2014 Edit Cell\n' +
    '  Delete \u2014 Clear / Remove\n' +
    '  Ctrl+C \u2014 Copy\n' +
    '  Ctrl+V \u2014 Paste\n' +
    '  Alt+V \u2014 Paste with Headers\n' +
    '  Alt+T \u2014 Create Binding\n' +
    '  Shift+Alt+T \u2014 Create Binding (Headers)\n' +
    '  Alt+PageUp/Dn \u2014 Switch Sheet\n\n' +
    'F1 \u2014 Toggle This Window'
  );
}

function showAbout() {
  showModal('About Calque',
    'Calque \u2014 a spreadsheet language\n\n' +
    'Write code, see spreadsheet, download xlsx.\n' +
    'Part of the Auditable project.\n\n' +
    'https://github.com/endarthur/auditable'
  );
}

function showModal(title, text) {
  let overlay = $('#cq-modal-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'cq-modal-overlay';
    overlay.className = 'cq-modal-overlay';
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `<div class="cq-modal">
<div class="cq-modal-title">${title}</div>
<pre class="cq-modal-body">${text.replace(/</g, '&lt;')}</pre>
<button class="cq-modal-close" onclick="this.closest('.cq-modal-overlay').remove()">close</button>
</div>`;
  overlay.style.display = 'flex';
}
