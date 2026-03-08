// Bootstrap

(function init() {
  // Load starter text
  GP.source = STARTER;

  // Build menu
  buildMenu();

  // Initialize editor
  const editorPane = $('#gp-editor-pane');
  if (editorPane) initEditor(editorPane);

  // Initialize zoom controls
  initZoom();

  // Initialize divider drag
  initDivider();

  // Initial typeset
  typeset();

  // Update title
  updateTitle();

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'n') { e.preventDefault(); newProject(); }
      if (e.key === 'o') { e.preventDefault(); openProject(); }
    }
  });
})();

function initDivider() {
  const divider = $('#gp-divider');
  const main = $('#gp-main');
  const editorPane = $('#gp-editor-pane');
  if (!divider || !main || !editorPane) return;

  let dragging = false;

  divider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = main.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = Math.max(15, Math.min(85, (x / rect.width) * 100));
    editorPane.style.width = pct + '%';
  });

  document.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });
}
