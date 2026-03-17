// Project management + splash screen

function futureDate(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

const EXAMPLES = {
  'Simple Project': {
    tasks: STARTER_TASKS,
    projectStart: futureDate(0),
    deadlines: [
      { label: 'Release', taskId: 'deploy', date: futureDate(45) },
    ],
  },
  'Mining Schedule': {
    tasks: [
      createTask({ id: 'survey',    name: 'Geological Survey',      group: 'Exploration', o: '5', m: '10', p: '20' }),
      createTask({ id: 'sampling',  name: 'Core Sampling',          group: 'Exploration', o: '10', m: '15', p: '25', depends: 'survey' }),
      createTask({ id: 'assay',     name: 'Assay Analysis',         group: 'Exploration', o: '5', m: '8', p: '12', depends: 'sampling' }),
      createTask({ id: 'model',     name: 'Resource Model',         group: 'Estimation',  o: '10', m: '20', p: '35', depends: 'assay' }),
      createTask({ id: 'classify',  name: 'Classification',         group: 'Estimation',  o: '3', m: '5', p: '10', depends: 'model' }),
      createTask({ id: 'mplan',     name: 'Mine Plan',              group: 'Planning',    o: '8', m: '15', p: '25', depends: 'classify' }),
      createTask({ id: 'permit',    name: 'Environmental Permits',  group: 'Planning',    o: '20', m: '40', p: '80', depends: 'model' }),
      createTask({ id: 'infra',     name: 'Infrastructure',         group: 'Build',       o: '15', m: '25', p: '40', depends: 'mplan, permit' }),
      createTask({ id: 'prod',      name: 'Production Start',       group: 'Build',       o: '1', m: '1', p: '1', depends: 'infra' }),
    ],
    projectStart: futureDate(0),
    deadlines: [
      { label: 'Board Review', taskId: 'classify', date: futureDate(120) },
      { label: 'Production Target', taskId: 'prod', date: futureDate(365) },
    ],
  },
  'Multi-Deposit Mine': {
    tasks: [
      // Deposit A — Exploration
      createTask({ id: 'a_map',     name: 'Geological Mapping',    group: 'Deposit A/Exploration', o: '5',  m: '8',  p: '14' }),
      createTask({ id: 'a_drill',   name: 'Diamond Drilling',      group: 'Deposit A/Exploration', o: '15', m: '25', p: '40', depends: 'a_map' }),
      createTask({ id: 'a_log',     name: 'Core Logging',          group: 'Deposit A/Exploration', o: '8',  m: '12', p: '20', depends: 'a_drill' }),
      createTask({ id: 'a_assay',   name: 'Assay & QA/QC',        group: 'Deposit A/Exploration', o: '10', m: '15', p: '25', depends: 'a_log' }),
      // Deposit A — Estimation
      createTask({ id: 'a_db',      name: 'Database Validation',   group: 'Deposit A/Estimation',  o: '3',  m: '5',  p: '10', depends: 'a_assay' }),
      createTask({ id: 'a_geo',     name: 'Geological Domains',    group: 'Deposit A/Estimation',  o: '5',  m: '10', p: '18', depends: 'a_db' }),
      createTask({ id: 'a_vario',   name: 'Variography',           group: 'Deposit A/Estimation',  o: '5',  m: '8',  p: '15', depends: 'a_geo' }),
      createTask({ id: 'a_krig',    name: 'Block Model & Kriging', group: 'Deposit A/Estimation',  o: '8',  m: '15', p: '25', depends: 'a_vario' }),
      createTask({ id: 'a_class',   name: 'Resource Classification', group: 'Deposit A/Estimation', o: '3', m: '5', p: '8', depends: 'a_krig' }),
      // Deposit B — Exploration
      createTask({ id: 'b_map',     name: 'Geological Mapping',    group: 'Deposit B/Exploration', o: '4',  m: '7',  p: '12' }),
      createTask({ id: 'b_rc',      name: 'RC Drilling',           group: 'Deposit B/Exploration', o: '10', m: '18', p: '30', depends: 'b_map' }),
      createTask({ id: 'b_log',     name: 'Chip Logging',          group: 'Deposit B/Exploration', o: '5',  m: '8',  p: '14', depends: 'b_rc' }),
      createTask({ id: 'b_assay',   name: 'Assay & QA/QC',        group: 'Deposit B/Exploration', o: '8',  m: '12', p: '20', depends: 'b_log' }),
      // Deposit B — Estimation
      createTask({ id: 'b_db',      name: 'Database Validation',   group: 'Deposit B/Estimation',  o: '2',  m: '4',  p: '8',  depends: 'b_assay' }),
      createTask({ id: 'b_geo',     name: 'Geological Domains',    group: 'Deposit B/Estimation',  o: '4',  m: '8',  p: '14', depends: 'b_db' }),
      createTask({ id: 'b_vario',   name: 'Variography',           group: 'Deposit B/Estimation',  o: '4',  m: '7',  p: '12', depends: 'b_geo' }),
      createTask({ id: 'b_krig',    name: 'Block Model & Kriging', group: 'Deposit B/Estimation',  o: '6',  m: '12', p: '20', depends: 'b_vario' }),
      createTask({ id: 'b_class',   name: 'Resource Classification', group: 'Deposit B/Estimation', o: '2', m: '4', p: '7', depends: 'b_krig' }),
      // Integration
      createTask({ id: 'int_model', name: 'Consolidated Model',    group: 'Integration/Reporting', o: '5',  m: '10', p: '18', depends: 'a_class, b_class' }),
      createTask({ id: 'int_opt',   name: 'Pit Optimization',      group: 'Integration/Planning',  o: '5',  m: '8',  p: '15', depends: 'int_model' }),
      createTask({ id: 'int_mine',  name: 'Mine Scheduling',       group: 'Integration/Planning',  o: '8',  m: '15', p: '25', depends: 'int_opt' }),
      createTask({ id: 'int_econ',  name: 'Economic Analysis',     group: 'Integration/Planning',  o: '5',  m: '8',  p: '12', depends: 'int_mine' }),
      createTask({ id: 'int_43',    name: 'NI 43-101 Report',      group: 'Integration/Reporting', o: '10', m: '20', p: '35', depends: 'int_econ, int_model' }),
      createTask({ id: 'int_rev',   name: 'External Review',       group: 'Integration/Reporting', o: '5',  m: '10', p: '20', depends: 'int_43' }),
    ],
    projectStart: futureDate(0),
    deadlines: [
      { label: 'Dep A Resource', taskId: 'a_class', date: futureDate(180) },
      { label: 'Dep B Resource', taskId: 'b_class', date: futureDate(160) },
      { label: 'Board Presentation', taskId: 'int_rev', date: futureDate(365) },
    ],
  },
  'Templated Multi-Deposit': (() => {
    // Templates
    const explorationTpl = {
      id: 'tpl_exploration',
      name: 'Exploration Workflow',
      tasks: [
        createTemplateTask({ id: 'map',   name: 'Geological Mapping', o: '5',  m: '8',  p: '14' }),
        createTemplateTask({ id: 'drill', name: 'Drilling Program',   o: '12', m: '20', p: '35', depends: 'map' }),
        createTemplateTask({ id: 'log',   name: 'Core/Chip Logging',  o: '6',  m: '10', p: '18', depends: 'drill' }),
        createTemplateTask({ id: 'assay', name: 'Assay & QA/QC',      o: '8',  m: '12', p: '20', depends: 'log' }),
      ],
    };

    const estimationTpl = {
      id: 'tpl_estimation',
      name: 'Resource Estimation',
      tasks: [
        createTemplateTask({ id: 'db',    name: 'Database Validation',   o: '3', m: '5',  p: '10' }),
        createTemplateTask({ id: 'geo',   name: 'Geological Domains',    o: '5', m: '8',  p: '15', depends: 'db' }),
        createTemplateTask({ id: 'vario', name: 'Variography',           o: '4', m: '7',  p: '12', depends: 'geo' }),
        createTemplateTask({ id: 'krig',  name: 'Block Model & Kriging', o: '8', m: '14', p: '22', depends: 'vario' }),
        createTemplateTask({ id: 'class', name: 'Resource Classification', o: '3', m: '5', p: '8', depends: 'krig' }),
      ],
    };

    // Helper to instance a template into tasks
    function inst(tpl, prefix, group, linked) {
      const tplIds = new Set(tpl.tasks.map(t => t.id));
      return tpl.tasks.filter(t => t.id).map(tt => {
        const depends = tt.depends ? tt.depends.split(',').map(d => {
          const dep = d.trim();
          return tplIds.has(dep) ? prefix + '_' + dep : dep;
        }).filter(Boolean).join(', ') : '';
        const task = { id: prefix + '_' + tt.id, name: tt.name, group, o: tt.o, m: tt.m, p: tt.p, depends, resource: tt.resource || '' };
        if (linked) { task._tpl = tpl.id; task._tplTask = tt.id; task._tplPrefix = prefix; }
        return createTask(task);
      });
    }

    // Deposit A: linked instances (read-only from templates)
    const aTasks = [
      ...inst(explorationTpl, 'a', 'Deposit A/Exploration', true),
      ...inst(estimationTpl, 'a', 'Deposit A/Estimation', true),
    ];
    // Wire estimation to depend on exploration output
    aTasks.find(t => t.id === 'a_db').depends = 'a_assay';

    // Deposit B: linked instances
    const bTasks = [
      ...inst(explorationTpl, 'b', 'Deposit B/Exploration', true),
      ...inst(estimationTpl, 'b', 'Deposit B/Estimation', true),
    ];
    bTasks.find(t => t.id === 'b_db').depends = 'b_assay';

    // Deposit C: detached (copied, freely editable — smaller deposit, shorter estimates)
    const cTasks = [
      ...inst(explorationTpl, 'c', 'Deposit C/Exploration', false),
      ...inst(estimationTpl, 'c', 'Deposit C/Estimation', false),
    ];
    cTasks.find(t => t.id === 'c_db').depends = 'c_assay';
    // Customise detached tasks — smaller deposit, shorter drilling
    const cDrill = cTasks.find(t => t.id === 'c_drill');
    if (cDrill) { cDrill.name = 'RC Drilling (shallow)'; cDrill.o = '5'; cDrill.m = '10'; cDrill.p = '18'; }

    // Integration tasks (manual, cross-instance dependencies)
    const intTasks = [
      createTask({ id: 'int_model', name: 'Consolidated Model',   group: 'Integration/Reporting', o: '5',  m: '10', p: '18', depends: 'a_class, b_class, c_class' }),
      createTask({ id: 'int_opt',   name: 'Pit Optimization',     group: 'Integration/Planning',  o: '5',  m: '8',  p: '15', depends: 'int_model' }),
      createTask({ id: 'int_mine',  name: 'Mine Scheduling',      group: 'Integration/Planning',  o: '8',  m: '15', p: '25', depends: 'int_opt' }),
      createTask({ id: 'int_econ',  name: 'Economic Analysis',    group: 'Integration/Planning',  o: '5',  m: '8',  p: '12', depends: 'int_mine' }),
      createTask({ id: 'int_43',    name: 'NI 43-101 Report',     group: 'Integration/Reporting', o: '10', m: '20', p: '35', depends: 'int_econ, int_model' }),
      createTask({ id: 'int_rev',   name: 'External Review',      group: 'Integration/Reporting', o: '5',  m: '10', p: '20', depends: 'int_43' }),
    ];

    return {
      tasks: [...aTasks, ...bTasks, ...cTasks, ...intTasks],
      templates: [explorationTpl, estimationTpl],
      projectStart: futureDate(0),
      deadlines: [
        { label: 'Dep A Resource', taskId: 'a_class', date: futureDate(180) },
        { label: 'Dep B Resource', taskId: 'b_class', date: futureDate(170) },
        { label: 'Dep C Resource', taskId: 'c_class', date: futureDate(150) },
        { label: 'Board Presentation', taskId: 'int_rev', date: futureDate(400) },
      ],
    };
  })(),
};

// ── Project CRUD ──

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function getProjects() {
  try { return JSON.parse(localStorage.getItem('pp-projects') || '[]'); }
  catch { return []; }
}

function setProjects(list) {
  localStorage.setItem('pp-projects', JSON.stringify(list));
}

function projectCreate(name) {
  const id = genId();
  const list = getProjects();
  list.unshift({ id, name: name || 'untitled', ts: Date.now() });
  if (list.length > 20) {
    const removed = list.splice(20);
    for (const r of removed) localStorage.removeItem('pp-project:' + r.id);
  }
  setProjects(list);
  localStorage.setItem('pp-project:' + id, serializeProject());
  localStorage.setItem('pp-active', id);
  PP.projectId = id;
  return id;
}

function projectSave() {
  if (!PP.projectId) return;
  localStorage.setItem('pp-project:' + PP.projectId, serializeProject());
  const list = getProjects();
  const entry = list.find(p => p.id === PP.projectId);
  if (entry) {
    entry.ts = Date.now();
    setProjects(list);
  }
}

function projectUpdateName(name) {
  if (!PP.projectId) return;
  const list = getProjects();
  const entry = list.find(p => p.id === PP.projectId);
  if (entry) {
    entry.name = name;
    setProjects(list);
  }
}

function projectLoad(id) {
  const raw = localStorage.getItem('pp-project:' + id);
  if (raw == null) return null;
  localStorage.setItem('pp-active', id);
  PP.projectId = id;
  try { return JSON.parse(raw); }
  catch { return null; }
}

function projectRemove(id) {
  let list = getProjects();
  list = list.filter(p => p.id !== id);
  setProjects(list);
  localStorage.removeItem('pp-project:' + id);
  if (localStorage.getItem('pp-active') === id) {
    localStorage.removeItem('pp-active');
  }
}

function isProjectUntitled() {
  if (!PP.projectId) return true;
  const projects = getProjects();
  const p = projects.find(e => e.id === PP.projectId);
  return !p || p.name === 'untitled';
}

// ── Time formatting ──

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' hr ago';
  const d = Math.floor(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 30) return d + ' days ago';
  return new Date(ts).toLocaleDateString();
}

// ── Splash screen ──

function showSplash(onSelect) {
  const projects = getProjects();
  const activeId = localStorage.getItem('pp-active');

  const overlay = document.createElement('div');
  overlay.id = 'pp-splash';
  overlay.className = 'pp-splash';

  let recentHtml = '';
  if (projects.length) {
    recentHtml = '<div class="pp-splash-section">Recent</div>'
      + '<div class="pp-splash-list">'
      + projects.map(p => '<div class="pp-splash-entry" data-id="' + p.id + '">'
        + '<span class="pp-splash-name">' + esc(p.name) + '</span>'
        + '<span class="pp-splash-time">' + timeAgo(p.ts) + '</span>'
        + '<button class="pp-splash-rm" data-rm="' + p.id + '" title="Remove">\u00d7</button>'
        + '</div>').join('')
      + '</div>';
  }

  const hasActive = activeId && projects.some(p => p.id === activeId);

  const exOpts = Object.keys(EXAMPLES).map(n => '<option value="' + esc(n) + '">' + esc(n) + '</option>').join('');

  overlay.innerHTML = '<div class="pp-splash-box">'
    + '<div class="pp-splash-title">p l a n</div>'
    + '<div class="pp-splash-actions">'
    + '<button class="pp-splash-btn" data-action="new">New</button>'
    + '<button class="pp-splash-btn" data-action="open">Open\u2026</button>'
    + '<select class="pp-splash-select" data-action="example">'
    + '<option value="" disabled selected>Examples</option>'
    + exOpts
    + '</select>'
    + '</div>'
    + recentHtml
    + (hasActive ? '<div class="pp-splash-resume"><button class="pp-splash-btn" data-action="resume">Resume Last</button></div>' : '')
    + '</div>';

  function dismiss() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (hasActive) {
        dismiss();
        onSelect('resume');
      }
    }
  }

  overlay.addEventListener('click', e => {
    const rm = e.target.closest('[data-rm]');
    if (rm) {
      e.stopPropagation();
      const rid = rm.dataset.rm;
      projectRemove(rid);
      rm.closest('.pp-splash-entry').remove();
      if (!overlay.querySelector('.pp-splash-entry')) {
        const sec = overlay.querySelector('.pp-splash-section');
        const list = overlay.querySelector('.pp-splash-list');
        if (sec) sec.remove();
        if (list) list.remove();
      }
      return;
    }

    const btn = e.target.closest('[data-action]');
    if (btn) {
      const action = btn.dataset.action;
      if (action === 'new' || action === 'resume' || action === 'open') {
        dismiss();
        onSelect(action);
      }
      return;
    }

    const entry = e.target.closest('.pp-splash-entry');
    if (entry) {
      dismiss();
      onSelect('load', entry.dataset.id);
    }
  });

  const sel = overlay.querySelector('.pp-splash-select');
  if (sel) {
    sel.addEventListener('change', () => {
      const name = sel.value;
      if (name && EXAMPLES[name]) {
        dismiss();
        onSelect('example', name);
      }
    });
  }

  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Inline rename prompt ──

function showRenamePrompt(current, onDone) {
  const overlay = document.createElement('div');
  overlay.className = 'pp-modal-overlay';
  overlay.innerHTML = '<div class="pp-modal">'
    + '<div class="pp-modal-title">Project Name</div>'
    + '<input class="pp-rename-input" type="text" value="' + esc(current) + '" spellcheck="false">'
    + '<div class="pp-rename-actions">'
    + '<button class="pp-modal-close" data-action="cancel">Cancel</button>'
    + '<button class="pp-modal-close" data-action="ok">OK</button>'
    + '</div></div>';

  const input = overlay.querySelector('input');
  const finish = (accept) => {
    overlay.remove();
    if (accept) {
      const name = input.value.trim() || 'untitled';
      onDone(name);
    }
  };

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });

  overlay.addEventListener('click', e => {
    const action = e.target.dataset.action;
    if (action === 'ok') finish(true);
    else if (action === 'cancel') finish(false);
    else if (e.target === overlay) finish(false);
  });

  document.body.appendChild(overlay);
  requestAnimationFrame(() => { input.select(); input.focus(); });
}

function renameProject() {
  const projects = getProjects();
  const p = projects.find(e => e.id === PP.projectId);
  const current = (p && p.name) || PP.fileName || 'untitled';
  showRenamePrompt(current, name => {
    projectUpdateName(name);
    PP.fileName = name;
    updateTitle();
    setStatus('msg', 'renamed to ' + name);
  });
}
