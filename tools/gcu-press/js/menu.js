// File menu: new, open, save, export

function buildMenu() {
  const bar = $('#gp-menubar');
  if (!bar) return;

  bar.innerHTML = '';

  const fileMenu = createMenu('File', [
    { label: 'New', shortcut: 'Ctrl+N', action: newProject },
    { label: 'Open...', shortcut: 'Ctrl+O', action: openProject },
    { sep: true },
    { label: 'Save', shortcut: 'Ctrl+S', action: saveProject },
    { label: 'Save As...', action: saveProjectAs },
    { sep: true },
    { label: 'Import .md...', action: importMarkdown },
    { label: 'Export .md', action: exportMarkdown },
  ]);

  bar.appendChild(fileMenu);

  // Close menus on click outside
  document.addEventListener('click', (e) => {
    if (!bar.contains(e.target)) {
      $$('.gp-menu-item.open').forEach(el => el.classList.remove('open'));
    }
  });
}

function createMenu(label, items) {
  const wrapper = document.createElement('div');
  wrapper.className = 'gp-menu-item';

  const btn = document.createElement('button');
  btn.className = 'gp-menu-label';
  btn.textContent = label;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = wrapper.classList.contains('open');
    $$('.gp-menu-item.open').forEach(el => el.classList.remove('open'));
    if (!isOpen) wrapper.classList.add('open');
  });

  const dropdown = document.createElement('div');
  dropdown.className = 'gp-dropdown';

  for (const item of items) {
    if (item.sep) {
      const sep = document.createElement('div');
      sep.className = 'gp-menu-sep';
      dropdown.appendChild(sep);
      continue;
    }

    const entry = document.createElement('button');
    entry.className = 'gp-menu-entry';

    const labelSpan = document.createTextNode(item.label);
    entry.appendChild(labelSpan);

    if (item.shortcut) {
      const sc = document.createElement('span');
      sc.className = 'gp-menu-shortcut';
      sc.textContent = item.shortcut;
      entry.appendChild(sc);
    }

    entry.addEventListener('click', () => {
      wrapper.classList.remove('open');
      item.action();
    });

    dropdown.appendChild(entry);
  }

  wrapper.appendChild(btn);
  wrapper.appendChild(dropdown);
  return wrapper;
}
