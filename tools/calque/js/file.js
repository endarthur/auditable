// File operations — open/save .calque, import/export .xlsx

async function newFile() {
  if (CQ.dirty && !confirm('Discard unsaved changes?')) return;
  CQ.source = 'Sheet1 {\n  \n}';
  CQ.fileHandle = null;
  CQ.fileName = null;
  CQ.dirty = false;
  CQ.importData = null;
  projectCreate(CQ.source);
  setEditorSource(CQ.source);
  cqEvaluate(CQ.source);
  updateTitle();
}

async function openFile() {
  try {
    if (window.showOpenFilePicker) {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'Calque files', accept: { 'text/plain': ['.calque', '.cq'] } }],
      });
      const file = await handle.getFile();
      CQ.source = await file.text();
      CQ.fileHandle = handle;
      CQ.fileName = file.name;
    } else {
      // Fallback
      const source = await pickFileText('.calque,.cq,.txt');
      if (!source) return;
      CQ.source = source.text;
      CQ.fileName = source.name;
      CQ.fileHandle = null;
    }
    CQ.dirty = false;
    CQ.importData = null;
    const pname = (CQ.fileName || 'untitled').replace(/\.\w+$/, '');
    projectCreate(CQ.source, pname);
    setEditorSource(CQ.source);
    cqEvaluate(CQ.source);
    updateTitle();
  } catch (e) {
    if (e.name !== 'AbortError') setStatus('msg', 'open failed: ' + e.message);
  }
}

async function saveFile() {
  if (CQ.fileHandle) {
    try {
      const writable = await CQ.fileHandle.createWritable();
      await writable.write(CQ.source);
      await writable.close();
      CQ.dirty = false;
      projectSave();
      updateTitle();
      setStatus('msg', 'saved');
      return;
    } catch (e) {
      // Fall through
    }
  }
  // No file handle — persisted to localStorage
  if (isProjectUntitled()) {
    // First save of untitled project — ask for a name
    showRenamePrompt('untitled', name => {
      projectUpdateName(name);
      CQ.fileName = name;
      CQ.dirty = false;
      projectSave();
      updateTitle();
      setStatus('msg', 'saved as ' + name);
    });
    return;
  }
  CQ.dirty = false;
  projectSave();
  updateTitle();
  setStatus('msg', 'saved');
}

async function saveFileAs() {
  try {
    if (window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({
        suggestedName: CQ.fileName || 'untitled.calque',
        types: [{ description: 'Calque files', accept: { 'text/plain': ['.calque'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(CQ.source);
      await writable.close();
      CQ.fileHandle = handle;
      CQ.fileName = handle.name;
      CQ.dirty = false;
      projectUpdateName(handle.name.replace(/\.\w+$/, ''));
      projectSave();
      updateTitle();
      setStatus('msg', 'saved');
    } else {
      downloadBlob(CQ.source, CQ.fileName || 'untitled.calque', 'text/plain');
      CQ.dirty = false;
      updateTitle();
      setStatus('msg', 'downloaded');
    }
  } catch (e) {
    if (e.name !== 'AbortError') setStatus('msg', 'save failed: ' + e.message);
  }
}

async function importXlsx() {
  try {
    let file;
    if (window.showOpenFilePicker) {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'Excel files', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } }],
      });
      file = await handle.getFile();
    } else {
      file = await pickFile('.xlsx');
      if (!file) return;
    }
    const buf = await file.arrayBuffer();
    const data = await sheet.read(new Uint8Array(buf));
    CQ.importData = {};
    for (const s of data.sheets) {
      CQ.importData[s.name] = s;
    }
    setStatus('msg', 'imported ' + file.name + ' (' + data.sheets.length + ' sheets)');
    forceEval();
  } catch (e) {
    if (e.name !== 'AbortError') setStatus('msg', 'import failed: ' + e.message);
  }
}

async function exportXlsx() {
  if (!CQ.result) {
    setStatus('msg', 'nothing to export');
    return;
  }
  try {
    const { workbook, warnings } = CQ.result.compile();
    const bytes = await sheet.write(workbook);
    const name = (CQ.fileName || 'untitled').replace(/\.\w+$/, '') + '.xlsx';
    downloadBlob(bytes, name, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    if (warnings.length) setStatus('msg', 'exported with ' + warnings.length + ' warning(s)');
    else setStatus('msg', 'exported ' + name);
  } catch (e) {
    setStatus('msg', 'export failed: ' + e.message);
  }
}

// Helpers

function downloadBlob(data, filename, type) {
  const blob = data instanceof Blob ? data :
    data instanceof Uint8Array ? new Blob([data], { type }) :
    new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function pickFileText(accept) {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return resolve(null);
      resolve({ text: await file.text(), name: file.name });
    };
    input.click();
  });
}

function pickFile(accept) {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });
}

function updateTitle() {
  const name = CQ.fileName || 'untitled';
  document.title = (CQ.dirty ? '\u2022 ' : '') + name + ' \u2014 Calque';
}

// Drag-drop xlsx on grid
function initDragDrop() {
  const grid = $('#cq-grid');
  grid.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  grid.addEventListener('drop', async e => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (file.name.endsWith('.xlsx')) {
      try {
        const buf = await file.arrayBuffer();
        const data = await sheet.read(new Uint8Array(buf));
        CQ.importData = {};
        for (const s of data.sheets) CQ.importData[s.name] = s;
        setStatus('msg', 'imported ' + file.name);
        forceEval();
      } catch (err) {
        setStatus('msg', 'import failed: ' + err.message);
      }
    } else if (file.name.endsWith('.calque') || file.name.endsWith('.cq')) {
      const text = await file.text();
      CQ.source = text;
      CQ.fileName = file.name;
      CQ.fileHandle = null;
      CQ.dirty = false;
      const pname = file.name.replace(/\.\w+$/, '');
      projectCreate(CQ.source, pname);
      setEditorSource(CQ.source);
      cqEvaluate(CQ.source);
      updateTitle();
    }
  });
}
