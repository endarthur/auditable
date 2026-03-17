// .plan file format — parse, serialize, template instancing, calendar preset resolution

import { brazilCalendar } from './holidays-br.js';

// ── Calendar preset resolution ──

function resolveCalendarPreset(preset, startYear, endYear) {
  if (!preset) return [];
  if (preset === 'brazil-federal') {
    const cal = brazilCalendar(startYear, endYear);
    return cal.holidays || [];
  }
  // Municipality preset: "city-uf" (e.g. "belo horizonte-mg", "parauapebas-pa")
  const parts = preset.split('-');
  const uf = parts[parts.length - 1];
  const cal = brazilCalendar(startYear, endYear, {
    uf,
    municipality: preset,
    carnival: true,
    corpusChristi: true,
  });
  return cal.holidays || [];
}

// ── Template helpers ──

function _defaultTemplate(overrides) {
  return {
    id: 'tpl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    name: 'New Template',
    tasks: [],
    ...overrides,
  };
}

function _defaultTemplateTask(overrides) {
  return { id: '', name: '', o: '', m: '', p: '', depends: '', resource: '', ...overrides };
}

// Instance a template into concrete tasks
// Returns array of task objects ready for the scheduler or for .plan task list
function instancePlanTemplate(template, prefix, group, mode) {
  const tasks = [];
  const tplIds = new Set(template.tasks.map(t => t.id).filter(Boolean));

  for (const tt of template.tasks) {
    if (!tt.id) continue;

    const newId = prefix + '_' + tt.id;

    // Remap dependencies: prefix internal deps, leave external ones as-is
    let depends = '';
    if (tt.depends) {
      depends = tt.depends.split(',').map(d => {
        const dep = d.trim();
        if (!dep) return '';
        return tplIds.has(dep) ? prefix + '_' + dep : dep;
      }).filter(Boolean).join(', ');
    }

    const task = {
      id: newId,
      name: tt.name || '',
      group: group || '',
      o: tt.o || '',
      m: tt.m || '',
      p: tt.p || '',
      depends,
      resource: tt.resource || '',
      progress: '',
    };

    if (mode === 'linked') {
      task._tpl = template.id;
      task._tplTask = tt.id;
      task._tplPrefix = prefix;
    }

    tasks.push(task);
  }

  return tasks;
}

// Propagate template changes to linked tasks in a task array
function propagateTemplate(template, tasks) {
  const tplIds = new Set(template.tasks.map(t => t.id).filter(Boolean));

  for (const task of tasks) {
    if (task._tpl !== template.id) continue;
    const tt = template.tasks.find(t => t.id === task._tplTask);
    if (!tt) {
      // Template task was deleted — unlink
      delete task._tpl;
      delete task._tplTask;
      delete task._tplPrefix;
      continue;
    }

    const prefix = task._tplPrefix;
    task.name = tt.name;
    task.o = tt.o;
    task.m = tt.m;
    task.p = tt.p;
    task.resource = tt.resource;

    if (tt.depends) {
      task.depends = tt.depends.split(',').map(d => {
        const dep = d.trim();
        if (!dep) return '';
        return tplIds.has(dep) ? prefix + '_' + dep : dep;
      }).filter(Boolean).join(', ');
    } else {
      task.depends = '';
    }
  }
}

// Check if a task is linked to a template
function isLinkedPlanTask(task) {
  return !!(task._tpl && task._tplTask);
}

// Unlink a task from its template (in place)
function unlinkPlanTask(task) {
  delete task._tpl;
  delete task._tplTask;
  delete task._tplPrefix;
}

// ── Parse .plan ──

// Parse a .plan file (JSON string or object) into a structured project object.
// Resolves calendar presets into actual holiday lists.
// Returns { tasks, templates, calendar, projectStart, deadlines, baseline, title, settings }
function parsePlan(input) {
  const data = typeof input === 'string' ? JSON.parse(input) : input;

  const projectStart = data.projectStart || new Date().toISOString().slice(0, 10);

  // Calendar
  const calData = data.calendar || {};
  const calendar = {
    weekends: calData.weekends || [0, 6],
    holidays: calData.holidays || [],
    blocked: calData.blocked || [],
  };
  const calendarPreset = calData.preset || null;

  // Resolve preset holidays if preset is specified and no holidays provided
  if (calendarPreset && calendar.holidays.length === 0) {
    const startYear = parseInt(projectStart.slice(0, 4)) || new Date().getFullYear();
    const endYear = startYear + 2;
    try {
      calendar.holidays = resolveCalendarPreset(calendarPreset, startYear, endYear);
    } catch (_) { /* ignore — preset resolution is best-effort */ }
  }

  // Templates
  const templates = (data.templates || []).map(t => ({
    ..._defaultTemplate(t),
    tasks: (t.tasks || []).map(tt => _defaultTemplateTask(tt)),
  }));

  // Tasks
  const tasks = (data.tasks || []).map(t => ({
    id: '', name: '', group: '', o: '', m: '', p: '',
    depends: '', resource: '', progress: '',
    ...t,
  }));

  // Deadlines
  const deadlines = data.deadlines || [];

  // Settings
  const settings = data.settings || {};

  return {
    title: data.title || 'untitled',
    version: data.version || 1,
    projectStart,
    calendar,
    calendarPreset,
    templates,
    tasks,
    deadlines,
    baseline: data.baseline || null,
    settings,
  };
}

// ── Serialize .plan ──

// Serialize a project object back to .plan JSON string
function serializePlan(project) {
  return JSON.stringify({
    version: project.version || 1,
    title: project.title || 'untitled',
    projectStart: project.projectStart,
    calendar: {
      preset: project.calendarPreset || null,
      weekends: project.calendar.weekends,
      holidays: project.calendar.holidays,
      blocked: project.calendar.blocked,
    },
    deadlines: project.deadlines || [],
    baseline: project.baseline || null,
    templates: (project.templates && project.templates.length) ? project.templates : undefined,
    tasks: project.tasks,
    settings: project.settings || {},
  }, null, 2);
}

// ── Build scheduler-ready tasks from .plan task list ──

// Convert .plan task format (string fields) to scheduler task format (numeric fields)
function buildSchedulerTasks(planTasks) {
  const tasks = [];
  for (const t of planTasks) {
    if (!t.id) continue;
    const task = { id: t.id };
    if (t.name) task.name = t.name;
    if (t.group) task.group = t.group;
    if (t.resource) task.resource = t.resource;

    const o = parseFloat(t.o);
    const m = parseFloat(t.m);
    const p = parseFloat(t.p);
    if (!isNaN(o) && !isNaN(m) && !isNaN(p)) {
      task.pert = { o, m, p };
    } else if (!isNaN(m)) {
      task.duration = m;
    } else {
      task.milestone = true;
    }

    if (t.depends) {
      task.depends = typeof t.depends === 'string'
        ? t.depends.split(',').map(s => s.trim()).filter(Boolean)
        : t.depends;
    }

    const prog = parseFloat(t.progress);
    if (!isNaN(prog)) {
      task.progress = prog / 100;
    }

    tasks.push(task);
  }
  return tasks;
}

export {
  parsePlan, serializePlan, buildSchedulerTasks,
  resolveCalendarPreset,
  instancePlanTemplate, propagateTemplate,
  isLinkedPlanTask, unlinkPlanTask,
};
