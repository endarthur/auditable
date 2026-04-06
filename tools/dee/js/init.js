// dee tool — bootstrap

;(async function init() {
  const loader = $('#d3-loader');

  // load Three.js from CDN
  try {
    if (loader) loader.textContent = 'loading Three.js\u2026';
    await loadThreeJS();
    if (loader) loader.classList.add('hidden');
  } catch (e) {
    if (loader) loader.textContent = 'failed to load Three.js: ' + e.message;
    return;
  }

  // keyboard shortcuts
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'S') { e.preventDefault(); exportScreenshot(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'o') { e.preventDefault(); openBlockCSV(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'n') { e.preventDefault(); newProject(); return; }
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === '1') { D3.scene?.controls.fitAll(); D3.scene?.markDirty(); }
    if (e.key === '2') { D3.scene?.controls.planView(); D3.scene?.markDirty(); }
    if (e.key === '3') { D3.scene?.controls.sectionNorth(); D3.scene?.markDirty(); }
    if (e.key === '4') { D3.scene?.controls.sectionEast(); D3.scene?.markDirty(); }
    if (e.key === 'Tab') { e.preventDefault(); toggleSidebar(); }
    if (e.key === 's' || e.key === 'S') { if (!e.ctrlKey && !e.metaKey) enterSectionMode(); }
    if (e.key === 'w' || e.key === 'W') { if (!e.ctrlKey && !e.metaKey) toggleWireframe(); }
    if (e.key === 'Escape') { if (D3.sectionMode) exitSectionMode(); }
  });

  // dirty check
  window.addEventListener('beforeunload', e => {
    if (D3.dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  // drag-drop
  document.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  document.addEventListener('drop', async e => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (file.name.endsWith('.csv') || file.name.endsWith('.txt')) {
      closeSplash();
      const text = await file.text();
      try {
        const result = parseBlockCSV(text);
        D3.columns = result.columns;
        D3.columnNames = result.columnNames;
        D3.fileName = file.name;
        if (!D3.scene) initScene();
        loadBlockModel(result.gridDef, result.columns[result.columnNames[0]], result.columnNames[0]);
        startFPSCounter();
        buildSidebar();
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }
  });

  // service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  // section drag interaction
  initSectionDrag();

  // menu bar
  initMenuBar();

  // splash
  showSplash();
})();
