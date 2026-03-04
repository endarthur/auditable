// Evaluation bridge — debounced calque.run() + grid update

function onSourceChange(source) {
  CQ.source = source;
  CQ.dirty = true;
  updateTitle();

  clearTimeout(CQ.evalTimer);
  CQ.evalTimer = setTimeout(() => cqEvaluate(source), 300);
}

function cqEvaluate(source) {
  try {
    const opts = CQ.importData ? { imports: CQ.importData } : undefined;
    CQ.result = calque.run(source, opts);
    CQ.error = null;
    renderGrid();
    setStatus('msg', 'ready');
  } catch (e) {
    CQ.error = e;
    setStatus('msg', 'error: ' + e.message);
  }

  // Persist source to active project
  projectSave();
}

function forceEval() {
  cqEvaluate(CQ.source);
}
