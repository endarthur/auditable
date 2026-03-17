// Template editor — floating window for reusable task templates

const TPL_COLUMNS = [
  { key: '#',       label: '#',       width: 28,  type: 'rownum' },
  { key: 'id',      label: 'ID',      width: 70,  type: 'text',   editable: true },
  { key: 'name',    label: 'Name',    width: 180, type: 'text',   editable: true },
  { key: 'o',       label: 'O',       width: 45,  type: 'number', editable: true },
  { key: 'm',       label: 'M',       width: 45,  type: 'number', editable: true },
  { key: 'p',       label: 'P',       width: 45,  type: 'number', editable: true },
  { key: 'depends', label: 'Depends', width: 100, type: 'text',   editable: true },
  { key: 'resource',label: 'Resource',width: 80,  type: 'text',   editable: true },
];

function createTemplate(overrides) {
  return {
    id: 'tpl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    name: 'New Template',
    tasks: [],
    ...overrides,
  };
}

function createTemplateTask(overrides) {
  return { id: '', name: '', o: '', m: '', p: '', depends: '', resource: '', ...overrides };
}

// ── Template window ──

function createTemplateWindow() {
  const existing = $('#pp-tpl-window');
  if (existing) return existing;

  const win = document.createElement('div');
  win.id = 'pp-tpl-window';
  win.className = 'pp-window hidden';

  const saved = localStorage.getItem('pp-tpl-win-pos');
  let pos = { left: 120, top: 100, width: 720, height: 420 };
  if (saved) {
    try { pos = JSON.parse(saved); } catch (_) {}
  }
  win.style.left = pos.left + 'px';
  win.style.top = pos.top + 'px';
  win.style.width = pos.width + 'px';
  win.style.height = pos.height + 'px';

  // Title bar
  const tb = document.createElement('div');
  tb.className = 'pp-win-tb';

  const title = document.createElement('span');
  title.className = 'pp-win-title';
  title.id = 'pp-tpl-title';
  title.textContent = 'TEMPLATES';
  tb.appendChild(title);

  const btns = document.createElement('div');
  btns.className = 'pp-win-btns';

  const minBtn = document.createElement('button');
  minBtn.className = 'pp-win-btn';
  minBtn.textContent = '\u2013';
  minBtn.title = 'Minimize';
  minBtn.addEventListener('click', () => win.classList.toggle('minimized'));
  btns.appendChild(minBtn);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'pp-win-btn';
  closeBtn.textContent = '\u00d7';
  closeBtn.title = 'Close';
  closeBtn.addEventListener('click', () => toggleTemplateWindow());
  btns.appendChild(closeBtn);

  tb.appendChild(btns);
  win.appendChild(tb);

  // Body
  const body = document.createElement('div');
  body.className = 'pp-win-body';
  body.id = 'pp-tpl-body';
  win.appendChild(body);

  // Resize handle
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'pp-win-resize';
  win.appendChild(resizeHandle);

  // Drag
  let dragging = false, dragX = 0, dragY = 0;
  tb.addEventListener('mousedown', e => {
    if (e.target.closest('.pp-win-btn')) return;
    e.preventDefault();
    dragging = true;
    dragX = e.clientX - win.offsetLeft;
    dragY = e.clientY - win.offsetTop;
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', e => {
    if (dragging) {
      win.style.left = Math.max(0, e.clientX - dragX) + 'px';
      win.style.top = Math.max(0, e.clientY - dragY) + 'px';
    }
  });

  document.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      saveTplWinPos(win);
    }
  });

  // Resize
  let resizing = false, resStartX = 0, resStartY = 0, resStartW = 0, resStartH = 0;
  resizeHandle.addEventListener('mousedown', e => {
    e.preventDefault();
    e.stopPropagation();
    resizing = true;
    resStartX = e.clientX;
    resStartY = e.clientY;
    resStartW = win.offsetWidth;
    resStartH = win.offsetHeight;
    document.body.style.cursor = 'nwse-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', e => {
    if (resizing) {
      win.style.width = Math.max(400, resStartW + e.clientX - resStartX) + 'px';
      win.style.height = Math.max(150, resStartH + e.clientY - resStartY) + 'px';
    }
  });

  document.addEventListener('mouseup', () => {
    if (resizing) {
      resizing = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      saveTplWinPos(win);
    }
  });

  $('#pp-main').appendChild(win);
  return win;
}

function saveTplWinPos(win) {
  localStorage.setItem('pp-tpl-win-pos', JSON.stringify({
    left: win.offsetLeft,
    top: win.offsetTop,
    width: win.offsetWidth,
    height: win.offsetHeight,
  }));
}

function toggleTemplateWindow() {
  const win = createTemplateWindow();
  win.classList.toggle('hidden');
  if (!win.classList.contains('hidden')) renderTemplateList();
}

function showTemplateWindow() {
  const win = createTemplateWindow();
  win.classList.remove('hidden');
  renderTemplateList();
}

// ── Template list view ──

function renderTemplateList() {
  const body = $('#pp-tpl-body');
  if (!body) return;
  body.innerHTML = '';

  const titleEl = $('#pp-tpl-title');
  if (titleEl) titleEl.textContent = 'TEMPLATES';

  // Toolbar
  const toolbar = document.createElement('div');
  toolbar.className = 'pp-tpl-toolbar';

  const addBtn = document.createElement('button');
  addBtn.className = 'pp-tpl-action';
  addBtn.textContent = '+ new template';
  addBtn.addEventListener('click', () => {
    pushUndo();
    const tpl = createTemplate();
    tpl.tasks.push(createTemplateTask());
    PP.templates.push(tpl);
    PP.dirty = true;
    updateTitle();
    openTemplateEditor(tpl.id);
  });
  toolbar.appendChild(addBtn);
  body.appendChild(toolbar);

  if (!PP.templates.length) {
    const empty = document.createElement('div');
    empty.className = 'pp-tpl-empty';
    empty.textContent = 'No templates yet. Create one to define reusable task sequences.';
    body.appendChild(empty);
    return;
  }

  const list = document.createElement('div');
  list.className = 'pp-tpl-list';

  for (const tpl of PP.templates) {
    const entry = document.createElement('div');
    entry.className = 'pp-tpl-entry';

    const info = document.createElement('div');
    info.className = 'pp-tpl-info';
    info.addEventListener('click', () => openTemplateEditor(tpl.id));

    const name = document.createElement('span');
    name.className = 'pp-tpl-name';
    name.textContent = tpl.name;
    info.appendChild(name);

    const count = document.createElement('span');
    count.className = 'pp-tpl-count';
    const n = tpl.tasks.filter(t => t.id).length;
    count.textContent = n + ' task' + (n !== 1 ? 's' : '');
    info.appendChild(count);

    entry.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'pp-tpl-actions';

    const instBtn = document.createElement('button');
    instBtn.className = 'pp-tpl-action';
    instBtn.textContent = 'Instance';
    instBtn.title = 'Create tasks from this template';
    instBtn.addEventListener('click', e => { e.stopPropagation(); showInstanceDialog(tpl.id); });
    actions.appendChild(instBtn);

    const dupBtn = document.createElement('button');
    dupBtn.className = 'pp-tpl-action';
    dupBtn.textContent = 'Duplicate';
    dupBtn.title = 'Duplicate this template';
    dupBtn.addEventListener('click', e => {
      e.stopPropagation();
      pushUndo();
      const copy = createTemplate({
        name: tpl.name + ' (copy)',
        tasks: tpl.tasks.map(t => createTemplateTask(t)),
      });
      PP.templates.push(copy);
      PP.dirty = true;
      updateTitle();
      renderTemplateList();
    });
    actions.appendChild(dupBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'pp-tpl-action pp-tpl-danger';
    delBtn.textContent = '\u00d7';
    delBtn.title = 'Delete template';
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (!confirm('Delete template "' + tpl.name + '"?')) return;
      pushUndo();
      PP.templates = PP.templates.filter(t => t.id !== tpl.id);
      // Unlink any linked tasks
      for (const task of PP.tasks) {
        if (task._tpl === tpl.id) {
          unlinkTask(task, tpl);
        }
      }
      PP.dirty = true;
      updateTitle();
      renderTemplateList();
      renderRows();
      scheduleEval();
    });
    actions.appendChild(delBtn);

    entry.appendChild(actions);
    list.appendChild(entry);
  }

  body.appendChild(list);
}

// ── Template editor (single template) ──

function openTemplateEditor(tplId) {
  const tpl = PP.templates.find(t => t.id === tplId);
  if (!tpl) return;

  const body = $('#pp-tpl-body');
  if (!body) return;
  body.innerHTML = '';

  const titleEl = $('#pp-tpl-title');
  if (titleEl) titleEl.textContent = 'TEMPLATE: ' + tpl.name;

  // Back + name row
  const header = document.createElement('div');
  header.className = 'pp-tpl-header';

  const backBtn = document.createElement('button');
  backBtn.className = 'pp-tpl-action';
  backBtn.textContent = '\u2190 Back';
  backBtn.addEventListener('click', () => renderTemplateList());
  header.appendChild(backBtn);

  const nameInput = document.createElement('input');
  nameInput.className = 'pp-tpl-name-input';
  nameInput.type = 'text';
  nameInput.value = tpl.name;
  nameInput.spellcheck = false;
  nameInput.addEventListener('blur', () => {
    const v = nameInput.value.trim() || 'Unnamed';
    if (v !== tpl.name) {
      tpl.name = v;
      PP.dirty = true;
      updateTitle();
      if (titleEl) titleEl.textContent = 'TEMPLATE: ' + v;
      // Update linked tasks' template ref name
    }
  });
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') nameInput.blur(); });
  header.appendChild(nameInput);

  body.appendChild(header);

  // Task table
  const table = document.createElement('table');
  table.className = 'pp-grid pp-tpl-grid';

  const thead = document.createElement('thead');
  const hrow = document.createElement('tr');
  for (const col of TPL_COLUMNS) {
    const th = document.createElement('th');
    th.className = 'pp-col-' + (col.key === '#' ? 'num' : col.key === 'o' || col.key === 'm' || col.key === 'p' ? 'omp' : col.key);
    th.textContent = col.label;
    th.style.width = col.width + 'px';
    hrow.appendChild(th);
  }
  thead.appendChild(hrow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  for (let i = 0; i < tpl.tasks.length; i++) {
    const task = tpl.tasks[i];
    const tr = document.createElement('tr');
    tr.dataset.index = i;

    for (const col of TPL_COLUMNS) {
      const td = document.createElement('td');

      if (col.type === 'rownum') {
        td.className = 'pp-row-num';
        td.textContent = i + 1;
        td.addEventListener('contextmenu', e => showTplRowMenu(e, tplId, i));
      } else {
        td.className = 'pp-editable';
        if (col.type === 'number') td.classList.add('pp-number');
        td.contentEditable = 'true';
        td.spellcheck = false;
        td.textContent = task[col.key] || '';
        td.dataset.col = col.key;
        td.dataset.row = i;

        td.addEventListener('blur', () => {
          const val = td.textContent.trim();
          if (val !== (task[col.key] || '')) {
            task[col.key] = val;
            PP.dirty = true;
            updateTitle();
            propagateTemplateChange(tplId);
          }
        });

        td.addEventListener('keydown', e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            td.blur();
            if (i + 1 < tpl.tasks.length) {
              tplFocusCell(tbody, i + 1, col.key);
            } else {
              tpl.tasks.push(createTemplateTask());
              PP.dirty = true;
              openTemplateEditor(tplId);
              requestAnimationFrame(() => {
                const newBody = body.querySelector('tbody');
                if (newBody) tplFocusCell(newBody, tpl.tasks.length - 1, col.key);
              });
            }
          }
          if (e.key === 'Escape') {
            td.textContent = task[col.key] || '';
            td.blur();
          }
          if (e.key === 'Tab') {
            e.preventDefault();
            td.blur();
            const editableCols = TPL_COLUMNS.filter(c => c.editable);
            const idx = editableCols.findIndex(c => c.key === col.key);
            if (e.shiftKey) {
              if (idx > 0) tplFocusCell(tbody, i, editableCols[idx - 1].key);
              else if (i > 0) tplFocusCell(tbody, i - 1, editableCols[editableCols.length - 1].key);
            } else {
              if (idx < editableCols.length - 1) tplFocusCell(tbody, i, editableCols[idx + 1].key);
              else if (i + 1 < tpl.tasks.length) tplFocusCell(tbody, i + 1, editableCols[0].key);
            }
          }
          if (e.key === 'Delete' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            if (tpl.tasks.length > 1) {
              tpl.tasks.splice(i, 1);
              PP.dirty = true;
              updateTitle();
              propagateTemplateChange(tplId);
              openTemplateEditor(tplId);
            }
          }
        });
      }

      tr.appendChild(td);
    }

    tbody.appendChild(tr);
  }

  // Add row
  const addTr = document.createElement('tr');
  const addTd = document.createElement('td');
  addTd.colSpan = TPL_COLUMNS.length;
  addTd.className = 'pp-add-row';
  addTd.textContent = '+ add task';
  addTd.addEventListener('click', () => {
    tpl.tasks.push(createTemplateTask());
    PP.dirty = true;
    updateTitle();
    openTemplateEditor(tplId);
    requestAnimationFrame(() => {
      const newBody = body.querySelector('tbody');
      if (newBody) tplFocusCell(newBody, tpl.tasks.length - 1, 'id');
    });
  });
  addTr.appendChild(addTd);
  tbody.appendChild(addTr);

  table.appendChild(tbody);
  body.appendChild(table);
}

function tplFocusCell(tbody, row, colKey) {
  requestAnimationFrame(() => {
    const cell = tbody.querySelector('tr[data-index="' + row + '"] td[data-col="' + colKey + '"]');
    if (cell) cell.focus();
  });
}

function showTplRowMenu(e, tplId, row) {
  e.preventDefault();
  closeContextMenu();

  const tpl = PP.templates.find(t => t.id === tplId);
  if (!tpl) return;

  const menu = document.createElement('div');
  menu.className = 'pp-context-menu';
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';

  const items = [
    { label: 'Insert Row Above', action: () => { tpl.tasks.splice(row, 0, createTemplateTask()); PP.dirty = true; propagateTemplateChange(tplId); openTemplateEditor(tplId); } },
    { label: 'Insert Row Below', action: () => { tpl.tasks.splice(row + 1, 0, createTemplateTask()); PP.dirty = true; propagateTemplateChange(tplId); openTemplateEditor(tplId); } },
    { label: 'Delete Row', action: () => { if (tpl.tasks.length > 1) { tpl.tasks.splice(row, 1); PP.dirty = true; propagateTemplateChange(tplId); openTemplateEditor(tplId); } } },
  ];

  for (const item of items) {
    const btn = document.createElement('button');
    btn.className = 'pp-context-entry';
    btn.textContent = item.label;
    btn.addEventListener('click', () => { closeContextMenu(); item.action(); });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 4) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 4) + 'px';

  const dismiss = ev => {
    if (!menu.contains(ev.target)) {
      closeContextMenu();
      document.removeEventListener('click', dismiss);
    }
  };
  setTimeout(() => document.addEventListener('click', dismiss), 0);
}

// ── Instance dialog ──

function showInstanceDialog(tplId) {
  const tpl = PP.templates.find(t => t.id === tplId);
  if (!tpl) return;

  const overlay = document.createElement('div');
  overlay.className = 'pp-modal-overlay';
  overlay.innerHTML = '<div class="pp-modal">'
    + '<div class="pp-modal-title">Instance: ' + esc(tpl.name) + '</div>'
    + '<div class="pp-instance-form">'
    + '<label class="pp-inst-label">Prefix<input class="pp-inst-input" id="pp-inst-prefix" type="text" placeholder="e.g. a" spellcheck="false"></label>'
    + '<label class="pp-inst-label">Group Path<input class="pp-inst-input" id="pp-inst-group" type="text" placeholder="e.g. Deposit A/Exploration" spellcheck="false"></label>'
    + '<label class="pp-inst-label">Mode'
    + '<select class="pp-inst-input" id="pp-inst-mode">'
    + '<option value="linked">Linked (read-only params from template)</option>'
    + '<option value="detached">Detached (editable copy)</option>'
    + '</select></label>'
    + '</div>'
    + '<div class="pp-rename-actions">'
    + '<button class="pp-modal-close" data-action="cancel">Cancel</button>'
    + '<button class="pp-modal-close" data-action="ok">Create</button>'
    + '</div></div>';

  const finish = (accept) => {
    if (accept) {
      const prefix = overlay.querySelector('#pp-inst-prefix').value.trim();
      const group = overlay.querySelector('#pp-inst-group').value.trim();
      const mode = overlay.querySelector('#pp-inst-mode').value;

      if (!prefix) {
        setStatus('msg', 'prefix is required');
        return;
      }

      // Check for ID collisions
      const existing = new Set(PP.tasks.map(t => t.id));
      for (const tt of tpl.tasks) {
        if (tt.id && existing.has(prefix + '_' + tt.id)) {
          setStatus('msg', 'ID collision: ' + prefix + '_' + tt.id + ' already exists');
          return;
        }
      }

      pushUndo();
      instanceTemplate(tplId, prefix, group, mode);
      PP.dirty = true;
      updateTitle();
      renderRows();
      scheduleEval();
      setStatus('msg', 'instanced ' + tpl.name + ' (' + mode + ')');
    }
    overlay.remove();
  };

  overlay.addEventListener('click', e => {
    const action = e.target.dataset.action;
    if (action === 'ok') finish(true);
    else if (action === 'cancel') finish(false);
    else if (e.target === overlay) finish(false);
  });

  overlay.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });

  document.body.appendChild(overlay);
  requestAnimationFrame(() => {
    const inp = overlay.querySelector('#pp-inst-prefix');
    if (inp) inp.focus();
  });
}

function instanceTemplate(tplId, prefix, group, mode) {
  const tpl = PP.templates.find(t => t.id === tplId);
  if (!tpl) return;
  const newTasks = instancePlanTemplate(tpl, prefix, group, mode);
  for (const t of newTasks) PP.tasks.push(createTask(t));
}

// ── Linked task management (delegates to library) ──

function isLinkedTask(task) {
  return isLinkedPlanTask(task);
}

function isLinkedField(colKey) {
  return colKey === 'name' || colKey === 'o' || colKey === 'm' || colKey === 'p' || colKey === 'depends' || colKey === 'resource';
}

function unlinkTask(task) {
  unlinkPlanTask(task);
}

function propagateTemplateChange(tplId) {
  const tpl = PP.templates.find(t => t.id === tplId);
  if (!tpl) return;
  propagateTemplate(tpl, PP.tasks);
  renderRows();
  scheduleEval();
}

// ── Unlink a specific task from its template ──

function unlinkTaskById(row) {
  const task = PP.tasks[row];
  if (!task || !isLinkedTask(task)) return;
  pushUndo();
  delete task._tpl;
  delete task._tplTask;
  delete task._tplPrefix;
  PP.dirty = true;
  updateTitle();
  renderRows();
  setStatus('msg', 'unlinked ' + task.id);
}
