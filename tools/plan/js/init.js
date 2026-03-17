// Bootstrap — init IIFE, event wiring, sidebar management

function setStatus(key, text) {
  if (key === 'msg') {
    const el = $('#pp-status-msg');
    if (el) el.textContent = text;
  }
}

// ── Sidebar ──

const SIDEBAR_PANELS = {
  calendar:    { label: 'Calendar',    show: showCalendarPanel },
  mc:          { label: 'Monte Carlo', show: showMCPanel },
  sensitivity: { label: 'Sensitivity', show: showSensitivityPanel },
  burndown:    { label: 'Burndown',    show: showBurndownPanel },
  evm:         { label: 'Earned Value', show: showEVMPanel },
  health:      { label: 'Health',      show: showHealthPanel },
  compress:    { label: 'Compress',    show: showCompressPanel },
};

function showSidebar(key) {
  const sidebar = $('#pp-sidebar');
  const titleEl = $('#pp-sidebar-title');
  if (!sidebar) return;

  const panel = SIDEBAR_PANELS[key];
  if (!panel) return;

  PP.ui.sidebarPanel = key;
  titleEl.textContent = panel.label;
  sidebar.classList.remove('hidden');
  panel.show();
}

function hideSidebar() {
  const sidebar = $('#pp-sidebar');
  if (sidebar) sidebar.classList.add('hidden');
  PP.ui.sidebarPanel = null;
}

function toggleSidebar(key) {
  const sidebar = $('#pp-sidebar');
  if (!sidebar) return;
  if (!sidebar.classList.contains('hidden') && PP.ui.sidebarPanel === key) {
    hideSidebar();
  } else {
    showSidebar(key);
  }
}

;(function init() {
  // Global keyboard shortcuts
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveFile();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
      e.preventDefault();
      openFile();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
      e.preventDefault();
      newFile();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'e') {
      e.preventDefault();
      toggleTaskWindow();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 't') {
      e.preventDefault();
      toggleTemplateWindow();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'm') {
      e.preventDefault();
      runMC();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      // Only intercept if not focused on a contenteditable cell
      if (!document.activeElement || !document.activeElement.contentEditable || document.activeElement.contentEditable !== 'true') {
        e.preventDefault();
        undo();
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
      if (!document.activeElement || !document.activeElement.contentEditable || document.activeElement.contentEditable !== 'true') {
        e.preventDefault();
        redo();
      }
    }
    if (e.key === 'F1') {
      e.preventDefault();
      const overlay = $('#pp-modal-overlay');
      if (overlay) overlay.remove();
      else showShortcuts();
    }
  });

  // Dirty check on unload
  window.addEventListener('beforeunload', e => {
    if (PP.dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  // Build menu bar
  initMenuBar();

  // Wire sidebar close button
  const sidebarClose = $('#pp-sidebar-close');
  if (sidebarClose) {
    sidebarClose.addEventListener('click', hideSidebar);
  }

  setStatus('msg', 'ready');

  // Drag-drop .plan files
  document.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  document.addEventListener('drop', async e => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (file.name.endsWith('.plan') || file.name.endsWith('.json')) {
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        loadProjectData(data);
        PP.fileHandle = null;
        PP.fileName = file.name;
        PP.dirty = false;
        const pname = file.name.replace(/\.\w+$/, '');
        projectCreate(pname);
        startProject();
        setStatus('msg', 'opened ' + file.name);
      } catch (err) {
        setStatus('msg', 'open failed: ' + err.message);
      }
    }
  });

  // Show splash
  showSplash(handleSplashChoice);
})();

function handleSplashChoice(action, arg) {
  switch (action) {
    case 'new':
      PP.tasks = [createTask()];
      PP.fileHandle = null;
      PP.fileName = null;
      PP.dirty = false;
      projectCreate();
      startProject();
      break;

    case 'open':
      openFile();
      break;

    case 'resume': {
      const activeId = localStorage.getItem('pp-active');
      if (activeId) {
        const data = projectLoad(activeId);
        if (data) {
          loadProjectData(data);
          PP.fileHandle = null;
          PP.dirty = false;
          const projects = getProjects();
          const p = projects.find(e => e.id === activeId);
          PP.fileName = p ? p.name : null;
          startProject();
          break;
        }
      }
      // Fallback
      PP.tasks = STARTER_TASKS.map(t => createTask(t));
      projectCreate();
      startProject();
      break;
    }

    case 'load': {
      const data = projectLoad(arg);
      if (data) {
        loadProjectData(data);
        PP.fileHandle = null;
        PP.dirty = false;
        const projects = getProjects();
        const p = projects.find(e => e.id === arg);
        PP.fileName = p ? p.name : null;
        startProject();
      }
      break;
    }

    case 'example': {
      const ex = EXAMPLES[arg];
      if (ex) {
        PP.tasks = ex.tasks.map(t => createTask(t));
        PP.templates = (ex.templates || []).map(t => ({
          ...createTemplate(t),
          tasks: (t.tasks || []).map(tt => createTemplateTask(tt)),
        }));
        PP.projectStart = ex.projectStart || new Date().toISOString().slice(0, 10);
        PP.deadlines = ex.deadlines || [];
        PP.fileHandle = null;
        PP.fileName = null;
        PP.dirty = false;
        projectCreate(arg);
        startProject();
      }
      break;
    }
  }
}
