// Bootstrap — init IIFE, event wiring, status bar

function setStatus(key, text) {
  if (key === 'msg') {
    const el = $('#cq-status-msg');
    if (el) el.textContent = text;
  } else if (key === 'cursor') {
    const el = $('#cq-status-cursor');
    if (el) el.textContent = text;
  }
}

function startProject(source) {
  CQ.source = source;
  setEditorSource(CQ.source);
  cqEvaluate(CQ.source);
  updateTitle();
}

;(function init() {
  // Global keyboard shortcuts — register first to prevent browser defaults
  document.addEventListener('keydown', e => {
    // Ctrl+S
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveFile();
    }
    // Ctrl+O
    if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
      e.preventDefault();
      openFile();
    }
    // Ctrl+N
    if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
      e.preventDefault();
      newFile();
    }
    // F1 — toggle shortcuts
    if (e.key === 'F1') {
      e.preventDefault();
      const overlay = $('#cq-modal-overlay');
      if (overlay) overlay.remove();
      else showShortcuts();
      return;
    }
    // Ctrl+Shift+E — jump between editor cursor and grid cell
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      jumpEditorGrid();
      return;
    }
    // Ctrl+E
    if ((e.ctrlKey || e.metaKey) && e.key === 'e') {
      e.preventDefault();
      toggleEditor();
    }
  });

  // Dirty check on unload
  window.addEventListener('beforeunload', e => {
    if (CQ.dirty) {
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

  // Init canvas grid
  initGridCanvas();

  // Create floating editor window
  const win = createWindow();
  const body = win.querySelector('#cq-win-body');
  initEditor(body);

  // Drag-drop
  initDragDrop();

  setStatus('msg', 'ready');
  setStatus('cursor', '1:1');

  // Migrate from legacy cq-source key
  const legacySource = localStorage.getItem('cq-source');
  if (legacySource && !getProjects().length) {
    projectCreate(legacySource);
    localStorage.removeItem('cq-source');
  }

  // Show splash — don't render anything behind it
  showSplash(handleSplashChoice);
})();

function handleSplashChoice(action, arg) {
  switch (action) {
    case 'new':
      CQ.source = 'Sheet1 {\n  \n}';
      CQ.fileHandle = null;
      CQ.fileName = null;
      CQ.dirty = false;
      CQ.importData = null;
      projectCreate(CQ.source);
      startProject(CQ.source);
      break;

    case 'open':
      openFile();
      break;

    case 'resume': {
      const activeId = localStorage.getItem('cq-active');
      if (activeId) {
        const src = projectLoad(activeId);
        if (src != null) {
          CQ.source = src;
          CQ.fileHandle = null;
          CQ.dirty = false;
          CQ.importData = null;
          const projects = getProjects();
          const p = projects.find(e => e.id === activeId);
          CQ.fileName = p ? p.name : null;
          startProject(CQ.source);
          break;
        }
      }
      // Fallback if active project gone
      CQ.source = STARTER;
      projectCreate(CQ.source);
      startProject(CQ.source);
      break;
    }

    case 'load': {
      const src = projectLoad(arg);
      if (src != null) {
        CQ.source = src;
        CQ.fileHandle = null;
        CQ.dirty = false;
        CQ.importData = null;
        // Restore project name as fileName
        const projects = getProjects();
        const p = projects.find(e => e.id === arg);
        CQ.fileName = p ? p.name : null;
        startProject(CQ.source);
      }
      break;
    }

    case 'example': {
      const src = EXAMPLES[arg];
      if (src) {
        CQ.source = src;
        CQ.fileHandle = null;
        CQ.fileName = null;
        CQ.dirty = false;
        CQ.importData = null;
        projectCreate(CQ.source, arg);
        startProject(CQ.source);
      }
      break;
    }
  }
}
