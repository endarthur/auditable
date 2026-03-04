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

;(function init() {
  // Restore source from localStorage
  const saved = localStorage.getItem('cq-source');
  CQ.source = saved || STARTER;

  // Build menu bar
  initMenuBar();

  // Init canvas grid
  initGridCanvas();

  // Create floating editor window
  const win = createWindow();
  const body = win.querySelector('#cq-win-body');
  initEditor(body);

  // Initial eval + render
  cqEvaluate(CQ.source);

  // Drag-drop
  initDragDrop();

  // Global keyboard shortcuts
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

  setStatus('msg', 'ready');
  setStatus('cursor', '1:1');
  updateTitle();
})();
