// File operations — new/open/save .plan JSON

async function newFile() {
  if (PP.dirty && !confirm('Discard unsaved changes?')) return;
  PP.tasks = [createTask()];
  PP.templates = [];
  PP.calendar = { weekends: [0, 6], holidays: [], blocked: [] };
  PP.calendarPreset = null;
  PP.projectStart = new Date().toISOString().slice(0, 10);
  PP.deadlines = [];
  PP.scheduleResult = null;
  PP.mcResult = null;
  PP.evmResult = null;
  PP.fileHandle = null;
  PP.fileName = null;
  PP.dirty = false;
  PP.undoStack = [];
  PP.redoStack = [];
  projectCreate();
  startProject();
}

async function openFile() {
  try {
    let file, handle;
    if (window.showOpenFilePicker) {
      [handle] = await window.showOpenFilePicker({
        types: [
          { description: 'Plan files', accept: { 'application/json': ['.plan', '.json'] } },
        ],
      });
      file = await handle.getFile();
    } else {
      file = await pickFile('.plan,.json');
      if (!file) return;
      handle = null;
    }

    const text = await file.text();
    const data = JSON.parse(text);
    loadProjectData(data);
    PP.fileHandle = handle;
    PP.fileName = file.name;
    PP.dirty = false;
    const pname = (PP.fileName || 'untitled').replace(/\.\w+$/, '');
    projectCreate(pname);
    startProject();
    setStatus('msg', 'opened ' + file.name);
  } catch (e) {
    if (e.name !== 'AbortError') setStatus('msg', 'open failed: ' + e.message);
  }
}

async function saveFile() {
  if (PP.fileHandle) {
    try {
      const writable = await PP.fileHandle.createWritable();
      await writable.write(serializeProject());
      await writable.close();
      PP.dirty = false;
      projectSave();
      updateTitle();
      setStatus('msg', 'saved');
      return;
    } catch (e) {
      // Fall through
    }
  }
  // No file handle — localStorage
  if (isProjectUntitled()) {
    showRenamePrompt('untitled', name => {
      projectUpdateName(name);
      PP.fileName = name;
      PP.dirty = false;
      projectSave();
      updateTitle();
      setStatus('msg', 'saved as ' + name);
    });
    return;
  }
  PP.dirty = false;
  projectSave();
  updateTitle();
  setStatus('msg', 'saved');
}

async function saveFileAs() {
  try {
    if (window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({
        suggestedName: PP.fileName || 'untitled.plan',
        types: [{ description: 'Plan files', accept: { 'application/json': ['.plan'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(serializeProject());
      await writable.close();
      PP.fileHandle = handle;
      PP.fileName = handle.name;
      PP.dirty = false;
      projectUpdateName(handle.name.replace(/\.\w+$/, ''));
      projectSave();
      updateTitle();
      setStatus('msg', 'saved');
    } else {
      downloadBlob(serializeProject(), PP.fileName || 'untitled.plan', 'application/json');
      PP.dirty = false;
      updateTitle();
      setStatus('msg', 'downloaded');
    }
  } catch (e) {
    if (e.name !== 'AbortError') setStatus('msg', 'save failed: ' + e.message);
  }
}

function serializeProject() {
  const projects = getProjects();
  const p = projects.find(e => e.id === PP.projectId);
  return serializePlan({
    title: (p && p.name) || PP.fileName || 'untitled',
    projectStart: PP.projectStart,
    calendar: PP.calendar,
    calendarPreset: PP.calendarPreset,
    deadlines: PP.deadlines,
    baseline: PP.baseline,
    templates: PP.templates,
    tasks: PP.tasks,
    settings: {
      showFloat: PP.ui.showFloat,
      showProgress: PP.ui.showProgress,
      pxPerDay: GANTT.pxPerDay,
      mcIterations: PP.mcIterations || 5000,
    },
  });
}

function loadProjectData(data) {
  const project = parsePlan(data);

  PP.tasks = project.tasks.map(t => createTask(t));
  PP.templates = project.templates.map(t => ({
    ...createTemplate(t),
    tasks: (t.tasks || []).map(tt => createTemplateTask(tt)),
  }));
  PP.projectStart = project.projectStart;
  PP.deadlines = project.deadlines;
  PP.undoStack = [];
  PP.redoStack = [];
  PP.mcResult = null;
  PP.evmResult = null;
  PP.baseline = project.baseline;
  PP.calendarPreset = project.calendarPreset;
  PP.calendar = project.calendar;

  const s = project.settings;
  if (s.showFloat != null) PP.ui.showFloat = s.showFloat;
  if (s.showProgress != null) PP.ui.showProgress = s.showProgress;
  if (s.pxPerDay != null) GANTT.pxPerDay = Math.max(GANTT.minPx, Math.min(GANTT.maxPx, s.pxPerDay));
  if (s.mcIterations != null) PP.mcIterations = s.mcIterations;
}

// Helpers

function downloadBlob(data, filename, type) {
  const blob = typeof data === 'string' ? new Blob([data], { type }) :
    data instanceof Blob ? data :
    new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
  const name = PP.fileName || 'untitled';
  document.title = (PP.dirty ? '\u2022 ' : '') + name + ' \u2014 Plan';
}

function startProject() {
  createTaskWindow();
  showTaskWindow();
  buildGrid();
  evaluate();
  updateTitle();
  // Restore cached MC results
  if (PP.projectId) {
    mcLoad(PP.projectId).then(data => {
      if (data) {
        PP.mcResult = data;
        updateGantt();
      }
    });
  }
}

// ── Baseline ──

function saveBaseline() {
  if (!PP.scheduleResult || !PP.scheduleResult.scheduled.length) {
    setStatus('msg', 'no schedule to baseline');
    return;
  }
  const bl = {};
  for (const s of PP.scheduleResult.scheduled) {
    bl[s.id] = {
      start: s.earlyStart instanceof Date ? s.earlyStart.toISOString() : s.earlyStart,
      end: s.earlyFinish instanceof Date ? s.earlyFinish.toISOString() : s.earlyFinish,
    };
  }
  PP.baseline = bl;
  PP.dirty = true;
  updateTitle();
  updateGantt();
  setStatus('msg', 'baseline saved');
}

function clearBaseline() {
  PP.baseline = null;
  PP.dirty = true;
  updateTitle();
  updateGantt();
  setStatus('msg', 'baseline cleared');
}

// ── IndexedDB for MC results ──

function _mcDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('pp-mc', 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('mc'); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function mcSave(projectId, data) {
  return _mcDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('mc', 'readwrite');
    tx.objectStore('mc').put(data, projectId);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  })).catch(() => {});
}

function mcLoad(projectId) {
  return _mcDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('mc', 'readonly');
    const req = tx.objectStore('mc').get(projectId);
    req.onsuccess = () => { db.close(); resolve(req.result || null); };
    req.onerror = () => { db.close(); reject(req.error); };
  })).catch(() => null);
}

function mcDelete(projectId) {
  return _mcDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('mc', 'readwrite');
    tx.objectStore('mc').delete(projectId);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  })).catch(() => {});
}
