// File persistence: localStorage + .md import/export

const STORAGE_KEY = 'gcu-press-projects';

function getProjects() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch { return {}; }
}

function saveProjects(projects) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
}

function newProject() {
  if (GP.dirty && !confirm('Discard unsaved changes?')) return;
  GP.projectId = 'p_' + Date.now();
  GP.projectName = 'untitled';
  GP.source = '';
  GP.dirty = false;
  setEditorSource('');
  typeset();
  updateTitle();
  updateStatus();
}

function openProject() {
  const projects = getProjects();
  const ids = Object.keys(projects);
  if (ids.length === 0) {
    alert('No saved projects.');
    return;
  }

  const names = ids.map(id => projects[id].name);
  const choice = prompt('Open project:\n' + names.map((n, i) => `${i + 1}. ${n}`).join('\n') + '\n\nEnter number:');
  if (!choice) return;

  const idx = parseInt(choice) - 1;
  if (idx < 0 || idx >= ids.length) return;

  const id = ids[idx];
  const proj = projects[id];
  GP.projectId = id;
  GP.projectName = proj.name;
  GP.source = proj.source;
  GP.dirty = false;
  setEditorSource(proj.source);
  typeset();
  updateTitle();
  updateStatus();
}

function saveProject() {
  if (!GP.projectId) GP.projectId = 'p_' + Date.now();
  const projects = getProjects();
  projects[GP.projectId] = {
    name: GP.projectName,
    source: GP.source,
    modified: Date.now(),
  };
  saveProjects(projects);
  GP.dirty = false;
  updateTitle();
  setMsg('saved');
}

function saveProjectAs() {
  const name = prompt('Project name:', GP.projectName);
  if (!name) return;
  GP.projectName = name;
  GP.projectId = 'p_' + Date.now();
  saveProject();
}

function importMarkdown() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.md,.txt,.markdown';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    const text = await file.text();
    GP.source = text;
    GP.projectName = file.name.replace(/\.(md|txt|markdown)$/, '');
    GP.projectId = 'p_' + Date.now();
    GP.dirty = false;
    setEditorSource(text);
    typeset();
    updateTitle();
  };
  input.click();
}

function exportMarkdown() {
  const blob = new Blob([GP.source], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = GP.projectName + '.md';
  a.click();
  URL.revokeObjectURL(url);
}

function updateTitle() {
  document.title = (GP.dirty ? '\u2022 ' : '') + GP.projectName + ' \u2014 GCU Press';
}

function setMsg(text) {
  const el = $('#gp-status-msg');
  if (el) el.textContent = text;
  setTimeout(() => { if (el && el.textContent === text) el.textContent = 'ready'; }, 2000);
}

function updateStatus() {
  updateTitle();
}
