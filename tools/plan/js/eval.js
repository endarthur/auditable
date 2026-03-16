// Evaluation bridge — debounced schedule computation + render update

let _evalTimer = null;

function scheduleEval() {
  clearTimeout(_evalTimer);
  _evalTimer = setTimeout(evaluate, 300);
}

function evaluate() {
  const tasks = buildPlanTasks();
  if (!tasks.length) {
    PP.scheduleResult = null;
    renderRows();
    updateGantt();
    updateStatus();
    return;
  }

  try {
    PP.scheduleResult = schedule(tasks, PP.calendar, PP.projectStart);
    setStatus('msg', 'ready');
  } catch (e) {
    PP.scheduleResult = null;
    setStatus('msg', 'schedule error: ' + e.message);
  }

  renderRows();
  updateGantt();
  updateStatus();

  // Auto-refresh active sidebar panel
  if (PP.ui.sidebarPanel === 'health' && PP.scheduleResult && !$('#pp-sidebar').classList.contains('hidden')) {
    showHealthPanel();
  }
}

function buildPlanTasks() {
  const tasks = [];
  for (const t of PP.tasks) {
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
      task.depends = t.depends.split(',').map(s => s.trim()).filter(Boolean);
    }

    const prog = parseFloat(t.progress);
    if (!isNaN(prog)) {
      task.progress = prog / 100;
    }

    tasks.push(task);
  }
  return tasks;
}

function updateStatus() {
  const count = PP.tasks.filter(t => t.id).length;
  const el = $('#pp-status-tasks');
  if (el) el.textContent = count + ' task' + (count !== 1 ? 's' : '');

  const durEl = $('#pp-status-duration');
  if (durEl) {
    if (PP.scheduleResult) {
      const cp = PP.scheduleResult.criticalPath;
      const dur = PP.scheduleResult.projectDuration;
      durEl.textContent = 'CP: ' + (cp ? cp.length : 0) + ' tasks, ' + Math.round(dur) + ' days';
    } else {
      durEl.textContent = '';
    }
  }
}
