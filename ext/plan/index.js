// @gcu/plan — Project management primitives for Auditable notebooks
// Auto-generated from ext/plan/src/ — do not edit directly

// -- calendar.js --

// Calendar engine — all scheduling flows through these functions

// Parse "YYYY-MM-DD" to Date (local midnight)
function _parseDate(d) {
  if (d instanceof Date) return d;
  const [y, m, day] = d.split('-').map(Number);
  return new Date(y, m - 1, day);
}

// Format Date to "YYYY-MM-DD"
function _fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Check if a date string falls within a range { start, end }
function _inRange(dateStr, range) {
  return dateStr >= range.start && dateStr <= range.end;
}

// Check if a date is a non-working day
function _isOff(date, calendar, resource) {
  const dow = date.getDay();
  const weekends = calendar.weekends || [0, 6];
  if (weekends.includes(dow)) return true;

  const ds = _fmtDate(date);

  // Calendar holidays
  if (calendar.holidays) {
    for (const h of calendar.holidays) {
      if (h.date === ds) return true;
    }
  }

  // Calendar blocked ranges
  if (calendar.blocked) {
    for (const b of calendar.blocked) {
      if (_inRange(ds, b)) return true;
    }
  }

  // Resource overrides (vacation, leave, etc.)
  if (resource && resource.calendarOverrides) {
    for (const ov of resource.calendarOverrides) {
      if (_inRange(ds, ov)) return true;
    }
  }

  return false;
}

// Is a given date a working day?
function isWorkingDay(date, calendar, resource) {
  return !_isOff(_parseDate(date), calendar, resource);
}

// Add N working days to a date (negative N for backward pass)
function addWorkingDays(date, n, calendar, resource) {
  const d = new Date(_parseDate(date));
  if (n === 0) return d;

  const step = n > 0 ? 1 : -1;
  let remaining = Math.abs(n);

  while (remaining > 0) {
    d.setDate(d.getDate() + step);
    if (!_isOff(d, calendar, resource)) remaining--;
  }

  return d;
}

// Count working days between two dates (exclusive of end)
function workingDays(start, end, calendar, resource) {
  const s = _parseDate(start);
  const e = _parseDate(end);
  if (s >= e) return 0;

  let count = 0;
  const d = new Date(s);
  while (d < e) {
    if (!_isOff(d, calendar, resource)) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

// Get the next working day on or after date
function nextWorkingDay(date, calendar, resource) {
  const d = new Date(_parseDate(date));
  while (_isOff(d, calendar, resource)) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

// Get all blocked/off days in a range (for rendering)
function getBlockedDays(start, end, calendar, resource) {
  const s = _parseDate(start);
  const e = _parseDate(end);
  const result = [];
  const d = new Date(s);

  while (d <= e) {
    if (_isOff(d, calendar, resource)) {
      const ds = _fmtDate(d);
      let reason = 'weekend';
      const dow = d.getDay();
      const weekends = calendar.weekends || [0, 6];

      if (!weekends.includes(dow)) {
        // Check holidays
        if (calendar.holidays) {
          const h = calendar.holidays.find(h => h.date === ds);
          if (h) { reason = h.label || 'holiday'; }
        }
        // Check blocked
        if (reason === 'weekend' && calendar.blocked) {
          const b = calendar.blocked.find(b => _inRange(ds, b));
          if (b) { reason = b.label || 'blocked'; }
        }
        // Check resource
        if (reason === 'weekend' && resource && resource.calendarOverrides) {
          const ov = resource.calendarOverrides.find(o => _inRange(ds, o));
          if (ov) { reason = ov.label || ov.type || 'unavailable'; }
        }
      }

      result.push({ date: new Date(d), reason });
    }
    d.setDate(d.getDate() + 1);
  }

  return result;
}

// -- pert.js --

// PERT three-point estimation

// Expected duration: (o + 4m + p) / 6
function pertExpected({ o, m, p }) {
  return (o + 4 * m + p) / 6;
}

// Standard deviation: (p - o) / 6
function pertStdDev({ o, m, p }) {
  return (p - o) / 6;
}

// Variance: ((p - o) / 6)^2
function pertVariance({ o, m, p }) {
  const sd = (p - o) / 6;
  return sd * sd;
}

// Resolve a task's effective duration (PERT expected if available, else raw duration)
function effectiveDuration(task) {
  if (task.milestone) return 0;
  if (task.pert) return pertExpected(task.pert);
  if (task.optimistic != null) return pertExpected({ o: task.optimistic, m: task.mostLikely, p: task.pessimistic });
  return task.duration || 0;
}

// -- graph.js --

// Dependency graph utilities

// Build id→task map
function _taskMap(tasks) {
  const map = new Map();
  for (const t of tasks) map.set(t.id, t);
  return map;
}

// Build forward and reverse adjacency lists
function _buildAdj(tasks) {
  const fwd = new Map(); // id → [successor ids]
  const rev = new Map(); // id → [predecessor ids]
  for (const t of tasks) {
    if (!fwd.has(t.id)) fwd.set(t.id, []);
    if (!rev.has(t.id)) rev.set(t.id, []);
    if (t.depends) {
      for (const dep of t.depends) {
        if (!fwd.has(dep)) fwd.set(dep, []);
        if (!rev.has(dep)) rev.set(dep, []);
        fwd.get(dep).push(t.id);
        rev.get(t.id).push(dep);
      }
    }
  }
  return { fwd, rev };
}

// Topological sort — Kahn's algorithm. Throws on cycles.
function topoSort(tasks) {
  const { fwd, rev } = _buildAdj(tasks);
  const inDeg = new Map();
  for (const t of tasks) inDeg.set(t.id, (rev.get(t.id) || []).length);

  const queue = [];
  for (const [id, deg] of inDeg) {
    if (deg === 0) queue.push(id);
  }

  const order = [];
  while (queue.length > 0) {
    const id = queue.shift();
    order.push(id);
    for (const succ of (fwd.get(id) || [])) {
      inDeg.set(succ, inDeg.get(succ) - 1);
      if (inDeg.get(succ) === 0) queue.push(succ);
    }
  }

  if (order.length !== tasks.length) {
    // Find a cycle for the error message
    const cycle = detectCycles(tasks);
    throw new Error(`Dependency cycle detected: ${cycle ? cycle.join(' → ') : 'unknown'}`);
  }

  return order;
}

// Detect dependency cycles via DFS. Returns cycle path or null.
function detectCycles(tasks) {
  const { rev } = _buildAdj(tasks); // rev maps id → predecessors (depends)
  const color = new Map();
  const parent = new Map();
  for (const t of tasks) color.set(t.id, 0);

  // Build forward adjacency for DFS
  const adj = new Map();
  for (const t of tasks) {
    if (!adj.has(t.id)) adj.set(t.id, []);
    if (t.depends) {
      for (const dep of t.depends) {
        if (!adj.has(dep)) adj.set(dep, []);
        adj.get(dep).push(t.id);
      }
    }
  }

  for (const t of tasks) {
    if (color.get(t.id) === 0) {
      const cycle = _dfs(t.id, adj, color, parent);
      if (cycle) return cycle;
    }
  }
  return null;
}

function _dfs(u, adj, color, parent) {
  color.set(u, 1); // GRAY
  for (const v of (adj.get(u) || [])) {
    if (color.get(v) === 1) { // GRAY — cycle
      const cycle = [v, u];
      let cur = u;
      while (cur !== v && parent.has(cur)) {
        cur = parent.get(cur);
        cycle.push(cur);
      }
      return cycle.reverse();
    }
    if (color.get(v) === 0) { // WHITE
      parent.set(v, u);
      const cycle = _dfs(v, adj, color, parent);
      if (cycle) return cycle;
    }
  }
  color.set(u, 2); // BLACK
  return null;
}

// Get all transitive predecessors of a task
function predecessors(taskId, tasks) {
  const { rev } = _buildAdj(tasks);
  const visited = new Set();
  const queue = [...(rev.get(taskId) || [])];
  while (queue.length > 0) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    for (const pred of (rev.get(id) || [])) queue.push(pred);
  }
  return [...visited];
}

// Get all transitive successors of a task
function successors(taskId, tasks) {
  const { fwd } = _buildAdj(tasks);
  const visited = new Set();
  const queue = [...(fwd.get(taskId) || [])];
  while (queue.length > 0) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    for (const succ of (fwd.get(id) || [])) queue.push(succ);
  }
  return [...visited];
}

// -- schedule.js --

// CPM scheduler — forward/backward pass, float, critical path




function schedule(tasks, calendar, projectStart, resources) {
  const taskMap = _taskMap(tasks);
  const { fwd, rev } = _buildAdj(tasks);
  const order = topoSort(tasks);
  const resMap = new Map();
  if (resources) for (const r of resources) resMap.set(r.id, r);

  const start = _parseDate(projectStart);
  const scheduled = new Map();

  // Forward pass
  for (const id of order) {
    const task = taskMap.get(id);
    const dur = effectiveDuration(task);
    const resource = task.resource ? resMap.get(task.resource) : undefined;

    // earlyStart = max(earlyFinish of all predecessors), or task.start, or projectStart
    let es;
    const preds = rev.get(id) || [];
    if (preds.length > 0) {
      es = preds.reduce((latest, predId) => {
        const predEF = scheduled.get(predId).earlyFinish;
        return predEF > latest ? predEF : latest;
      }, new Date(0));
      // Move to next working day after predecessor finishes
      es = nextWorkingDay(es, calendar, resource);
    } else if (task.start) {
      es = nextWorkingDay(_parseDate(task.start), calendar, resource);
    } else {
      es = nextWorkingDay(start, calendar, resource);
    }

    const ef = dur > 0 ? addWorkingDays(es, dur, calendar, resource) : new Date(es);

    scheduled.set(id, {
      ...task,
      earlyStart: es,
      earlyFinish: ef,
      lateStart: null,
      lateFinish: null,
      totalFloat: 0,
      freeFloat: 0,
      isCritical: false,
      _dur: dur,
      _resource: resource,
    });
  }

  // Project end = max(earlyFinish)
  let projectEnd = new Date(0);
  for (const s of scheduled.values()) {
    if (s.earlyFinish > projectEnd) projectEnd = s.earlyFinish;
  }

  // Backward pass
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    const s = scheduled.get(id);
    const succs = fwd.get(id) || [];

    if (succs.length === 0) {
      s.lateFinish = new Date(projectEnd);
    } else {
      s.lateFinish = succs.reduce((earliest, succId) => {
        const succLS = scheduled.get(succId).lateStart;
        return succLS < earliest ? succLS : earliest;
      }, new Date(8640000000000000)); // max date
    }

    s.lateStart = s._dur > 0
      ? addWorkingDays(s.lateFinish, -s._dur, calendar, s._resource)
      : new Date(s.lateFinish);

    // Float
    s.totalFloat = workingDays(s.earlyStart, s.lateStart, calendar, s._resource);

    // Free float = min(earlyStart of successors) - earlyFinish
    if (succs.length > 0) {
      const minSuccES = succs.reduce((earliest, succId) => {
        const succES = scheduled.get(succId).earlyStart;
        return succES < earliest ? succES : earliest;
      }, new Date(8640000000000000));
      s.freeFloat = workingDays(s.earlyFinish, minSuccES, calendar, s._resource);
    }

    s.isCritical = s.totalFloat === 0;
  }

  // Build critical path — tasks with 0 float in topo order
  const criticalPath = order.filter(id => scheduled.get(id).isCritical);

  // Clean up internal fields and build result array
  const result = order.map(id => {
    const s = scheduled.get(id);
    delete s._dur;
    delete s._resource;
    return s;
  });

  const projectDuration = workingDays(start, projectEnd, calendar);

  return { scheduled: result, criticalPath, projectEnd, projectDuration };
}

// -- resource.js --

// Resource conflict detection and simple leveling



// Detect resource conflicts (overlapping tasks for same resource)
function detectConflicts(scheduledTasks) {
  const byResource = new Map();
  for (const t of scheduledTasks) {
    if (!t.resource) continue;
    if (!byResource.has(t.resource)) byResource.set(t.resource, []);
    byResource.get(t.resource).push(t);
  }

  const conflicts = [];
  for (const [resource, tasks] of byResource) {
    // Sort by earlyStart
    const sorted = [...tasks].sort((a, b) => a.earlyStart - b.earlyStart);
    for (let i = 0; i < sorted.length - 1; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        if (sorted[j].earlyStart < sorted[i].earlyFinish) {
          conflicts.push({
            resource,
            tasks: [sorted[i].id, sorted[j].id],
            overlap: {
              start: sorted[j].earlyStart,
              end: new Date(Math.min(sorted[i].earlyFinish, sorted[j].earlyFinish)),
            },
          });
        }
      }
    }
  }
  return conflicts;
}

// Simple serial leveling: delay lower-priority conflicting tasks
// Priority: critical path first, then earliest earlyStart, then by id
function levelResources(scheduledTasks, calendar, resources) {
  // Re-create tasks with adjusted start constraints
  const tasks = scheduledTasks.map(t => ({
    ...t,
    // Strip computed fields — keep original task fields
    earlyStart: undefined, earlyFinish: undefined,
    lateStart: undefined, lateFinish: undefined,
    totalFloat: undefined, freeFloat: undefined, isCritical: undefined,
  }));

  const byResource = new Map();
  for (const t of scheduledTasks) {
    if (!t.resource) continue;
    if (!byResource.has(t.resource)) byResource.set(t.resource, []);
    byResource.get(t.resource).push(t);
  }

  const taskById = new Map();
  for (const t of tasks) taskById.set(t.id, t);

  // For each resource with conflicts, impose serial ordering
  for (const [resource, resTasks] of byResource) {
    // Sort by priority: critical first, then earlyStart, then id
    const sorted = [...resTasks].sort((a, b) => {
      if (a.isCritical !== b.isCritical) return a.isCritical ? -1 : 1;
      if (a.earlyStart.getTime() !== b.earlyStart.getTime()) return a.earlyStart - b.earlyStart;
      return a.id.localeCompare(b.id);
    });

    // Chain: each task must start after the previous one finishes
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = taskById.get(sorted[i].id);
      // Add dependency if not already present
      if (!curr.depends) curr.depends = [];
      if (!curr.depends.includes(prev.id)) {
        curr.depends.push(prev.id);
      }
    }
  }

  // Determine project start from earliest task
  let projectStart = new Date(8640000000000000);
  for (const t of scheduledTasks) {
    if (t.earlyStart < projectStart) projectStart = t.earlyStart;
  }

  return schedule(tasks, calendar, projectStart, resources);
}

// -- scurve.js --

// S-curve generator — cumulative progress over time



function scurve(scheduledTasks, options = {}) {
  const {
    bucket = 'week',
    metric = 'tasks',
    baseline,
    today,
  } = options;

  if (scheduledTasks.length === 0) {
    return { labels: [], planned: [], actual: [], total: 0, percentComplete: 0 };
  }

  // Determine date range
  let rangeStart = options.start ? _parseDate(options.start) : null;
  let rangeEnd = options.end ? _parseDate(options.end) : null;

  if (!rangeStart) {
    rangeStart = scheduledTasks.reduce((m, t) =>
      t.earlyStart < m ? t.earlyStart : m, scheduledTasks[0].earlyStart);
  }
  if (!rangeEnd) {
    rangeEnd = scheduledTasks.reduce((m, t) =>
      t.earlyFinish > m ? t.earlyFinish : m, scheduledTasks[0].earlyFinish);
  }

  // Generate bucket edges
  const buckets = _generateBuckets(rangeStart, rangeEnd, bucket);

  // Weight function
  const weight = (t) => {
    if (metric === 'duration') return effectiveDuration(t);
    if (metric === 'cost') return (t.cost && t.cost.rate) ? t.cost.rate * effectiveDuration(t) : effectiveDuration(t);
    return 1; // tasks
  };

  const total = scheduledTasks.reduce((s, t) => s + weight(t), 0);

  // Planned: cumulative weight by earlyFinish bucket
  const planned = new Array(buckets.length).fill(0);
  for (const t of scheduledTasks) {
    const bi = _bucketIndex(t.earlyFinish, buckets);
    if (bi >= 0 && bi < buckets.length) planned[bi] += weight(t);
  }
  _cumSum(planned);

  // Actual: based on task.progress
  const actual = new Array(buckets.length).fill(0);
  const todayDate = today ? _parseDate(today) : new Date();
  const todayBi = _bucketIndex(todayDate, buckets);

  for (const t of scheduledTasks) {
    const progress = t.progress || 0;
    if (progress <= 0) continue;
    // Distribute actual progress up to the current bucket
    const finishBi = Math.min(_bucketIndex(t.earlyFinish, buckets), todayBi);
    if (finishBi >= 0 && finishBi < buckets.length) {
      actual[finishBi] += weight(t) * progress;
    }
  }
  _cumSum(actual);

  // Baseline (if provided)
  let baselineCurve;
  if (baseline) {
    baselineCurve = new Array(buckets.length).fill(0);
    for (const t of baseline) {
      const bi = _bucketIndex(t.earlyFinish, buckets);
      if (bi >= 0 && bi < buckets.length) baselineCurve[bi] += weight(t);
    }
    _cumSum(baselineCurve);
  }

  // Forecast: linear extrapolation from current rate
  let forecast;
  if (todayBi >= 0 && todayBi < buckets.length && actual[todayBi] > 0 && actual[todayBi] < total) {
    forecast = new Array(buckets.length).fill(null);
    const rate = actual[todayBi] / (todayBi + 1);
    for (let i = 0; i <= todayBi; i++) forecast[i] = actual[i];
    for (let i = todayBi + 1; i < buckets.length; i++) {
      forecast[i] = Math.min(total, actual[todayBi] + rate * (i - todayBi));
    }
  }

  // SPI trend
  const spiTrend = planned.map((p, i) => p > 0 ? actual[i] / p : null);

  const percentComplete = total > 0 ? actual[Math.min(todayBi, buckets.length - 1)] / total : 0;

  const labels = buckets.map(b => _bucketLabel(b, bucket));

  const result = { labels, planned, actual, total, percentComplete };
  if (forecast) result.forecast = forecast;
  if (baselineCurve) result.baseline = baselineCurve;
  result.spiTrend = spiTrend;
  return result;
}

function _generateBuckets(start, end, bucket) {
  const buckets = [];
  const d = new Date(start);

  if (bucket === 'day') {
    while (d <= end) {
      buckets.push(new Date(d));
      d.setDate(d.getDate() + 1);
    }
  } else if (bucket === 'week') {
    // Align to Monday
    const dow = d.getDay();
    if (dow !== 1) d.setDate(d.getDate() + (dow === 0 ? 1 : 8 - dow));
    if (d > end) d.setTime(start.getTime());
    while (d <= end) {
      buckets.push(new Date(d));
      d.setDate(d.getDate() + 7);
    }
    // Ensure we cover the end
    if (buckets.length === 0 || buckets[buckets.length - 1] < end) {
      buckets.push(new Date(end));
    }
  } else if (bucket === 'month') {
    d.setDate(1);
    while (d <= end) {
      buckets.push(new Date(d));
      d.setMonth(d.getMonth() + 1);
    }
    if (buckets[buckets.length - 1] < end) {
      buckets.push(new Date(end));
    }
  }

  return buckets;
}

function _bucketIndex(date, buckets) {
  for (let i = buckets.length - 1; i >= 0; i--) {
    if (date >= buckets[i]) return i;
  }
  return 0;
}

function _cumSum(arr) {
  for (let i = 1; i < arr.length; i++) arr[i] += arr[i - 1];
}

function _bucketLabel(date, bucket) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  if (bucket === 'day') return `${y}-${m}-${d}`;
  if (bucket === 'week') return `${y}-${m}-${d}`;
  if (bucket === 'month') {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[date.getMonth()]} ${y}`;
  }
  return _fmtDate(date);
}

// -- evm.js --

// Earned Value Management



function evm(scheduledTasks, statusDate, calendar) {
  const sd = statusDate ? _parseDate(statusDate) : new Date();

  let pv = 0, ev = 0, ac = 0, bac = 0;

  for (const t of scheduledTasks) {
    const dur = effectiveDuration(t);
    const taskCost = (t.cost && t.cost.rate) ? t.cost.rate * dur : dur;
    bac += taskCost;

    // Planned Value: how much work should be done by status date
    if (t.earlyFinish <= sd) {
      pv += taskCost; // task should be 100% complete
    } else if (t.earlyStart <= sd) {
      // Task is in progress — proportion based on schedule
      const totalDur = dur || 1;
      const elapsed = calendar
        ? workingDays(t.earlyStart, sd, calendar)
        : _calendarDayFraction(t.earlyStart, sd, t.earlyFinish);
      pv += taskCost * Math.min(1, elapsed / totalDur);
    }

    // Earned Value: actual progress × planned value
    const progress = t.progress || 0;
    ev += taskCost * progress;

    // Actual Cost: if provided, use it; otherwise mirror EV
    if (t.actualCost != null) {
      ac += t.actualCost;
    } else {
      ac += taskCost * progress;
    }
  }

  const sv = ev - pv;
  const cv = ev - ac;
  const spi = pv > 0 ? ev / pv : 1;
  const cpi = ac > 0 ? ev / ac : 1;
  const eac = cpi > 0 ? bac / cpi : bac;
  const etc = eac - ac;
  const vac = bac - eac;

  return {
    statusDate: sd,
    pv, ev, ac, bac,
    sv, cv, spi, cpi,
    eac, etc, vac,
  };
}

function _calendarDayFraction(start, current, end) {
  const total = end - start || 1;
  const elapsed = current - start;
  return Math.max(0, elapsed / total);
}

// -- workflow.js --

// Workflow engine — process templates, instantiation, stage-gate tracking

// Instantiate a workflow into concrete tasks for the scheduler
function instantiate(workflow, instance) {
  const tasks = [];
  const reworkTransitions = [];
  const prefix = instance.id;

  for (const stage of workflow.stages) {
    const overrides = (instance.stageOverrides && instance.stageOverrides[stage.id]) || {};
    const task = {
      id: `${prefix}/${stage.id}`,
      name: overrides.name || stage.name,
      duration: overrides.duration || stage.duration,
      resource: overrides.resource || instance.resource || stage.resource,
      group: instance.name || instance.id,
      depends: [],
    };
    if (overrides.pert || stage.pert) {
      task.pert = overrides.pert || stage.pert;
    }
    if (instance.start && tasks.length === 0) {
      task.start = instance.start;
    }
    tasks.push(task);
  }

  // Resolve transitions into dependencies
  for (const tr of workflow.transitions) {
    if (tr.probability != null) {
      // Rework transition — store for Monte Carlo, don't add as dependency
      reworkTransitions.push({
        from: `${prefix}/${tr.from}`,
        to: `${prefix}/${tr.to}`,
        probability: tr.probability,
        label: tr.label || `${tr.from} → ${tr.to}`,
      });
      continue;
    }

    const target = tasks.find(t => t.id === `${prefix}/${tr.to}`);
    if (target) {
      target.depends.push(`${prefix}/${tr.from}`);
    }
  }

  // Copy progress from instance.stageProgress
  if (instance.stageProgress) {
    for (const task of tasks) {
      const stageId = task.id.split('/').slice(1).join('/');
      if (instance.stageProgress[stageId] != null) {
        task.progress = instance.stageProgress[stageId];
      }
    }
  }

  return { tasks, reworkTransitions };
}

// Instantiate multiple instances of the same workflow
function instantiateBatch(workflow, instances) {
  const allTasks = [];
  const allRework = [];
  for (const inst of instances) {
    const { tasks, reworkTransitions } = instantiate(workflow, inst);
    allTasks.push(...tasks);
    allRework.push(...reworkTransitions);
  }
  return { tasks: allTasks, reworkTransitions: allRework };
}

// Compose tasks from multiple groups with optional cross-dependencies
function compose(taskGroups, crossDependencies) {
  const allTasks = taskGroups.flat();
  if (crossDependencies) {
    const taskById = new Map();
    for (const t of allTasks) taskById.set(t.id, t);

    for (const dep of crossDependencies) {
      const target = taskById.get(dep.to);
      if (target) {
        if (!target.depends) target.depends = [];
        target.depends.push(dep.from);
      }
    }
  }
  return allTasks;
}

// Stage-gate matrix: instances × stages → status
function stageGateMatrix(workflow, instances) {
  const stages = workflow.stages.map(s => s.id);

  const rows = instances.map(inst => {
    const stageStatus = {};
    const stageOrder = stages.indexOf(inst.currentStage);

    for (let i = 0; i < stages.length; i++) {
      const sid = stages[i];
      const progress = (inst.stageProgress && inst.stageProgress[sid]) || 0;

      let status;
      if (progress >= 1.0) {
        status = 'complete';
      } else if (sid === inst.currentStage) {
        status = 'active';
      } else if (i < stageOrder || progress > 0) {
        status = progress > 0 ? 'active' : 'complete';
      } else {
        status = 'pending';
      }

      stageStatus[sid] = { status, progress };
    }

    return {
      id: inst.id,
      name: inst.name || inst.id,
      stages: stageStatus,
    };
  });

  // Find bottleneck: stage with most active instances
  const activeCounts = {};
  for (const row of rows) {
    for (const [sid, s] of Object.entries(row.stages)) {
      if (s.status === 'active') {
        activeCounts[sid] = (activeCounts[sid] || 0) + 1;
      }
    }
  }

  let bottleneck = null;
  let maxActive = 0;
  for (const [sid, count] of Object.entries(activeCounts)) {
    if (count > maxActive) {
      maxActive = count;
      bottleneck = { stage: sid, count };
    }
  }

  return { stages, instances: rows, bottleneck };
}

// Pipeline throughput analysis
function throughput(workflow, instances, resources, calendar) {
  // Compute throughput rate from completed instances
  const completed = instances.filter(i => {
    if (!i.stageHistory) return false;
    const lastStage = workflow.stages[workflow.stages.length - 1].id;
    return i.stageHistory.some(h => h.stage === lastStage && h.exited);
  });

  if (completed.length < 2) {
    return {
      bottleneckStage: null,
      actualRate: 0,
      theoreticalRate: 0,
      completedCount: completed.length,
    };
  }

  // Compute average stage durations
  const stageDurations = {};
  for (const inst of completed) {
    for (const h of inst.stageHistory) {
      if (h.entered && h.exited) {
        const days = (new Date(h.exited) - new Date(h.entered)) / (1000 * 60 * 60 * 24);
        if (!stageDurations[h.stage]) stageDurations[h.stage] = [];
        stageDurations[h.stage].push(days);
      }
    }
  }

  const avgDurations = {};
  let maxAvg = 0, bottleneckStage = null;
  for (const [stage, durations] of Object.entries(stageDurations)) {
    const avg = durations.reduce((s, d) => s + d, 0) / durations.length;
    avgDurations[stage] = avg;
    if (avg > maxAvg) {
      maxAvg = avg;
      bottleneckStage = stage;
    }
  }

  // Actual rate from historical data
  const firstStart = completed.reduce((m, i) => {
    const s = new Date(i.stageHistory[0].entered);
    return s < m ? s : m;
  }, new Date());
  const lastEnd = completed.reduce((m, i) => {
    const e = new Date(i.stageHistory[i.stageHistory.length - 1].exited);
    return e > m ? e : m;
  }, new Date(0));
  const spanMonths = (lastEnd - firstStart) / (1000 * 60 * 60 * 24 * 30.44);
  const actualRate = spanMonths > 0 ? completed.length / spanMonths : 0;

  // Theoretical rate: 1 / bottleneck duration * 30.44 days/month
  const theoreticalRate = maxAvg > 0 ? 30.44 / maxAvg : 0;

  return {
    bottleneckStage,
    actualRate: Math.round(actualRate * 10) / 10,
    theoreticalRate: Math.round(theoreticalRate * 10) / 10,
    completedCount: completed.length,
    avgDurations,
  };
}

// -- montecarlo.js --

// Monte Carlo schedule simulation with seedable PRNG



// xoshiro128** — fast 32-bit seedable PRNG
function createRng(seed) {
  // SplitMix32 seeder
  function sm32(a) {
    a |= 0; a = a + 0x9e3779b9 | 0;
    let t = a ^ a >>> 16; t = Math.imul(t, 0x21f0aaad);
    t = t ^ t >>> 15; t = Math.imul(t, 0x735a2d97);
    return (t ^ t >>> 15) >>> 0;
  }

  let s0 = sm32(seed), s1 = sm32(s0), s2 = sm32(s1), s3 = sm32(s2);

  function next() {
    const result = Math.imul(s1 * 5, 9) >>> 0;
    const t = s1 << 9;
    s2 ^= s0; s3 ^= s1; s1 ^= s2; s0 ^= s3;
    s2 ^= t; s3 = (s3 << 11) | (s3 >>> 21);
    return (result >>> 0) / 4294967296;
  }

  // Sample from Beta(a, b) using Joehnk's method (for small a, b)
  // Falls back to rejection for larger params
  function nextBeta(a, b) {
    if (a <= 0 || b <= 0) return 0.5;
    // Joehnk's method
    while (true) {
      const u1 = next();
      const u2 = next();
      const x = Math.pow(u1, 1 / a);
      const y = Math.pow(u2, 1 / b);
      const s = x + y;
      if (s <= 1 && s > 0) return x / s;
    }
  }

  return { next, nextBeta };
}

// Sample a duration from PERT distribution (scaled Beta)
function samplePert(pert, rng) {
  const { o, m, p } = pert;
  if (p <= o) return m;
  const range = p - o;
  // PERT distribution: alpha and beta from mode
  const mu = (o + 4 * m + p) / 6;
  const alpha = 1 + 4 * (m - o) / range;
  const beta = 1 + 4 * (p - m) / range;
  const sample = rng.nextBeta(alpha, beta);
  return o + sample * range;
}

function monteCarlo(tasks, calendar, projectStart, options = {}) {
  const {
    iterations = 10000,
    reworkTransitions = [],
    seed = 42,
  } = options;

  const rng = createRng(seed);
  const start = _parseDate(projectStart);
  const taskMap = _taskMap(tasks);
  const order = topoSort(tasks);
  const { fwd, rev } = _buildAdj(tasks);

  const projectEnds = [];
  const taskEnds = {};
  const cpFreq = {};
  const reworkCounts = {};

  for (const id of order) {
    taskEnds[id] = [];
    cpFreq[id] = 0;
  }
  for (const rt of reworkTransitions) {
    reworkCounts[rt.label] = { total: 0, max: 0 };
  }

  for (let iter = 0; iter < iterations; iter++) {
    // Sample durations
    const durations = new Map();
    for (const id of order) {
      const task = taskMap.get(id);
      if (task.milestone) {
        durations.set(id, 0);
      } else if (task.pert) {
        durations.set(id, Math.round(samplePert(task.pert, rng)));
      } else if (task.optimistic != null) {
        durations.set(id, Math.round(samplePert({ o: task.optimistic, m: task.mostLikely, p: task.pessimistic }, rng)));
      } else {
        durations.set(id, task.duration || 0);
      }
    }

    // Sample rework: add extra duration to the "from" task
    let iterRework = {};
    for (const rt of reworkTransitions) {
      let count = 0;
      // Each rework can trigger multiple times (geometric distribution)
      while (rng.next() < rt.probability) {
        count++;
        // Add the "to" task's duration as rework time to the "from" task
        const toTask = taskMap.get(rt.to);
        if (toTask) {
          const extraDur = toTask.pert
            ? Math.round(samplePert(toTask.pert, rng))
            : toTask.optimistic != null
              ? Math.round(samplePert({ o: toTask.optimistic, m: toTask.mostLikely, p: toTask.pessimistic }, rng))
              : (toTask.duration || 0);
          const fromId = rt.from;
          durations.set(fromId, (durations.get(fromId) || 0) + extraDur);
        }
      }
      if (count > 0) {
        reworkCounts[rt.label].total += count;
        reworkCounts[rt.label].max = Math.max(reworkCounts[rt.label].max, count);
      }
    }

    // Forward pass only (skip backward pass for performance)
    const earlyFinish = new Map();
    let projectEnd = new Date(0);

    for (const id of order) {
      const task = taskMap.get(id);
      const dur = durations.get(id);
      const preds = rev.get(id) || [];

      let es;
      if (preds.length > 0) {
        es = preds.reduce((latest, predId) => {
          const pef = earlyFinish.get(predId);
          return pef > latest ? pef : latest;
        }, new Date(0));
        es = nextWorkingDay(es, calendar);
      } else if (task.start) {
        es = nextWorkingDay(_parseDate(task.start), calendar);
      } else {
        es = nextWorkingDay(start, calendar);
      }

      const ef = dur > 0 ? addWorkingDays(es, dur, calendar) : new Date(es);
      earlyFinish.set(id, ef);

      if (ef > projectEnd) projectEnd = ef;
      taskEnds[id].push(ef);
    }

    projectEnds.push(projectEnd);

    // Determine critical path for this iteration (tasks on longest path)
    // Simple: tasks whose earlyFinish equals projectEnd, traced back
    for (const id of order) {
      if (earlyFinish.get(id).getTime() === projectEnd.getTime()) {
        cpFreq[id]++;
      }
    }
  }

  // Aggregate results
  projectEnds.sort((a, b) => a - b);

  const pct = (p) => projectEnds[Math.floor(p / 100 * (iterations - 1))];

  // Histogram: ~20 bins
  const binCount = Math.min(20, iterations);
  const minEnd = projectEnds[0];
  const maxEnd = projectEnds[iterations - 1];
  const binWidth = (maxEnd - minEnd) / binCount || 1;
  const bins = [];
  const counts = new Array(binCount).fill(0);
  for (let i = 0; i <= binCount; i++) {
    bins.push(new Date(minEnd.getTime() + i * binWidth));
  }
  for (const pe of projectEnds) {
    const bi = Math.min(Math.floor((pe - minEnd) / binWidth), binCount - 1);
    counts[bi]++;
  }

  // Per-task percentiles
  const taskEndPcts = {};
  for (const id of order) {
    taskEnds[id].sort((a, b) => a - b);
    const te = taskEnds[id];
    taskEndPcts[id] = {
      p10: te[Math.floor(0.1 * (iterations - 1))],
      p50: te[Math.floor(0.5 * (iterations - 1))],
      p90: te[Math.floor(0.9 * (iterations - 1))],
    };
  }

  // Critical path frequency
  const criticalPathFrequency = {};
  for (const id of order) {
    criticalPathFrequency[id] = cpFreq[id] / iterations;
  }

  // Rework stats
  const reworkOccurrences = {};
  for (const [label, data] of Object.entries(reworkCounts)) {
    reworkOccurrences[label] = {
      mean: data.total / iterations,
      max: data.max,
    };
  }

  return {
    iterations,
    projectEnd: {
      p10: pct(10), p50: pct(50), p75: pct(75), p90: pct(90),
      mean: new Date(projectEnds.reduce((s, d) => s + d.getTime(), 0) / iterations),
      stdDev: _stdDevDays(projectEnds),
    },
    histogram: { bins, counts },
    taskEnd: taskEndPcts,
    criticalPathFrequency,
    reworkOccurrences,
  };
}

function _stdDevDays(dates) {
  const ms = dates.map(d => d.getTime());
  const mean = ms.reduce((s, v) => s + v, 0) / ms.length;
  const variance = ms.reduce((s, v) => s + (v - mean) ** 2, 0) / ms.length;
  return Math.sqrt(variance) / (1000 * 60 * 60 * 24); // convert ms to days
}

// -- render.js --

// SVG renderers — all produce SVG strings



// ── SVG helpers ──

function _esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function _svg(w, h, content) { return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="font-family:monospace;font-size:11px">${content}</svg>`; }
function _rect(x, y, w, h, fill, extra = '') { return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" ${extra}/>`; }
function _line(x1, y1, x2, y2, stroke, extra = '') { return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" ${extra}/>`; }
function _text(x, y, str, fill = '#bbb', extra = '') { return `<text x="${x}" y="${y}" fill="${fill}" ${extra}>${_esc(str)}</text>`; }
function _path(d, stroke, fill = 'none', extra = '') { return `<path d="${d}" stroke="${stroke}" fill="${fill}" ${extra}/>`; }

// ── Default theme ──

const GCU = {
  bg: '#111',
  grid: '#222',
  text: '#bbb',
  textDim: '#666',
  normal: '#4A90D9',
  critical: '#B87333',
  milestone: '#2D8B6F',
  complete: '#6BBF6B',
  planned: '#4A90D9',
  actual: '#B87333',
  forecast: '#B87333',
  baseline: '#888',
  pending: '#333',
  active: '#B87333',
  blocked: '#D94040',
};

// ── Gantt Chart ──

function gantt(scheduleResult, options = {}) {
  const {
    width = 1200,
    rowHeight = 28,
    showCritical = true,
    showFloat = false,
    showDependencies = true,
    showProgress = true,
    showToday = true,
    showResources = true,
    showGroups = true,
    labelWidth = 200,
  } = options;
  const colors = { ...GCU, ...(options.barColors || {}) };

  const tasks = scheduleResult.scheduled;
  if (tasks.length === 0) return _svg(width, 40, _text(10, 25, 'No tasks', colors.textDim));

  // Group tasks
  let rows = [];
  if (showGroups) {
    const groups = new Map();
    for (const t of tasks) {
      const g = t.group || '';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(t);
    }
    for (const [group, groupTasks] of groups) {
      if (group) rows.push({ type: 'group', label: group });
      for (const t of groupTasks) rows.push({ type: 'task', task: t });
    }
  } else {
    rows = tasks.map(t => ({ type: 'task', task: t }));
  }

  // Date range
  let minDate = tasks[0].earlyStart, maxDate = tasks[0].earlyFinish;
  for (const t of tasks) {
    if (t.earlyStart < minDate) minDate = t.earlyStart;
    if (t.earlyFinish > maxDate) maxDate = t.earlyFinish;
    if (showFloat && t.lateFinish > maxDate) maxDate = t.lateFinish;
  }

  const headerHeight = 30;
  const height = headerHeight + rows.length * rowHeight + 10;
  const chartWidth = width - labelWidth - 20;
  const chartLeft = labelWidth + 10;

  const timeSpan = maxDate - minDate || 1;
  const dateToX = (d) => chartLeft + ((d - minDate) / timeSpan) * chartWidth;

  let svg = '';

  // Background
  svg += _rect(0, 0, width, height, colors.bg);

  // Timeline header — month labels
  const d = new Date(minDate);
  d.setDate(1);
  while (d <= maxDate) {
    const x = dateToX(d);
    const label = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()] + ' ' + d.getFullYear();
    if (x >= chartLeft) {
      svg += _line(x, headerHeight, x, height, colors.grid, 'stroke-dasharray="2,4"');
      svg += _text(x + 4, 20, label, colors.textDim, 'font-size="10"');
    }
    d.setMonth(d.getMonth() + 1);
  }

  // Today line
  if (showToday) {
    const todayX = dateToX(new Date());
    if (todayX >= chartLeft && todayX <= chartLeft + chartWidth) {
      svg += _line(todayX, headerHeight, todayX, height, '#c89b3c', 'stroke-width="1" stroke-dasharray="4,2"');
    }
  }

  // Rows
  for (let i = 0; i < rows.length; i++) {
    const y = headerHeight + i * rowHeight;
    const row = rows[i];

    if (row.type === 'group') {
      svg += _rect(0, y, width, rowHeight, '#181818');
      svg += _text(8, y + rowHeight * 0.7, row.label, colors.textDim, 'font-weight="bold" font-size="11"');
      continue;
    }

    const t = row.task;
    const isMilestone = t.milestone || effectiveDuration(t) === 0;

    // Alternating row bg
    if (i % 2 === 0) svg += _rect(0, y, width, rowHeight, '#151515');

    // Label
    const label = t.name || t.id;
    svg += _text(8, y + rowHeight * 0.7, label.length > 28 ? label.substring(0, 26) + '\u2026' : label, colors.text, 'font-size="11"');

    // Resource
    if (showResources && t.resource) {
      svg += _text(labelWidth - 4, y + rowHeight * 0.7, t.resource, colors.textDim, 'font-size="10" text-anchor="end"');
    }

    if (isMilestone) {
      // Diamond
      const mx = dateToX(t.earlyStart);
      const my = y + rowHeight / 2;
      const s = 6;
      svg += _path(`M${mx} ${my-s} L${mx+s} ${my} L${mx} ${my+s} L${mx-s} ${my} Z`, 'none', colors.milestone);
    } else {
      // Bar
      const x1 = dateToX(t.earlyStart);
      const x2 = dateToX(t.earlyFinish);
      const barH = rowHeight * 0.55;
      const barY = y + (rowHeight - barH) / 2;
      const barW = Math.max(2, x2 - x1);
      const barColor = (showCritical && t.isCritical) ? colors.critical : colors.normal;

      svg += _rect(x1, barY, barW, barH, barColor, 'rx="2"');

      // Progress fill
      if (showProgress && t.progress > 0) {
        const pw = barW * Math.min(1, t.progress);
        svg += _rect(x1, barY, pw, barH, colors.complete, 'rx="2" opacity="0.6"');
      }

      // Float line
      if (showFloat && t.lateFinish && t.lateFinish > t.earlyFinish) {
        const fx = dateToX(t.lateFinish);
        const floatY = y + rowHeight / 2;
        svg += _line(x2, floatY, fx, floatY, colors.textDim, 'stroke-width="1" stroke-dasharray="2,2"');
      }
    }
  }

  // Dependency arrows
  if (showDependencies) {
    const rowIdx = new Map();
    let ri = 0;
    for (const row of rows) {
      if (row.type === 'task') rowIdx.set(row.task.id, ri);
      ri++;
    }

    for (const row of rows) {
      if (row.type !== 'task' || !row.task.depends) continue;
      const t = row.task;
      for (const dep of t.depends) {
        const fromRow = rowIdx.get(dep);
        const toRow = rowIdx.get(t.id);
        if (fromRow == null || toRow == null) continue;

        const fromTask = tasks.find(tt => tt.id === dep);
        if (!fromTask) continue;

        const x1 = dateToX(fromTask.earlyFinish);
        const y1 = headerHeight + fromRow * rowHeight + rowHeight / 2;
        const x2 = dateToX(t.earlyStart);
        const y2 = headerHeight + toRow * rowHeight + rowHeight / 2;

        const stub = 6;
        let d;
        if (x2 - x1 > stub * 2) {
          // Gap available — L-elbow with vertical in the gap
          const mx = x1 + stub;
          d = `M${x1} ${y1} L${mx} ${y1} L${mx} ${y2} L${x2} ${y2}`;
        } else {
          // Tight — vertical drop from finish, short horizontal to start
          d = `M${x1} ${y1} L${x1} ${y2} L${x2} ${y2}`;
        }
        svg += _path(d, colors.textDim, 'none', 'stroke-width="1" opacity="0.5"');
        // Arrowhead at bar start
        svg += _path(
          `M${x2 - 5} ${y2 - 3} L${x2} ${y2} L${x2 - 5} ${y2 + 3}`,
          colors.textDim, 'none', 'stroke-width="1" opacity="0.5"'
        );
      }
    }
  }

  return _svg(width, height, svg);
}

// ── S-Curve Plot ──

function scurvePlot(scurveData, options = {}) {
  const {
    width = 800,
    height = 400,
    showBaseline = true,
    showForecast = true,
    showToday = true,
    showGrid = true,
  } = options;
  const colors = { ...GCU, ...(options.lineColors || {}) };

  const { labels, planned, actual, total, forecast, baseline } = scurveData;
  if (!labels || labels.length === 0) return _svg(width, height, _text(10, 25, 'No data', colors.textDim));

  const pad = { top: 30, right: 40, bottom: 60, left: 60 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const maxY = total || Math.max(...planned, ...(actual || []), ...(baseline || []), ...(forecast || []));

  const xScale = (i) => pad.left + (i / (labels.length - 1 || 1)) * plotW;
  const yScale = (v) => pad.top + plotH - (v / (maxY || 1)) * plotH;

  let svg = '';
  svg += _rect(0, 0, width, height, colors.bg);

  // Grid
  if (showGrid) {
    for (let i = 0; i <= 4; i++) {
      const y = yScale(maxY * i / 4);
      svg += _line(pad.left, y, pad.left + plotW, y, colors.grid);
      svg += _text(pad.left - 8, y + 4, String(Math.round(maxY * i / 4)), colors.textDim, 'text-anchor="end" font-size="10"');
    }
  }

  // X-axis labels
  const step = Math.max(1, Math.floor(labels.length / 8));
  for (let i = 0; i < labels.length; i += step) {
    const x = xScale(i);
    svg += _text(x, height - pad.bottom + 20, labels[i], colors.textDim, 'text-anchor="middle" font-size="10"');
  }

  // Lines
  function polyline(data, color, dash = '') {
    if (!data || data.length === 0) return '';
    const points = data.map((v, i) => `${xScale(i)},${yScale(v || 0)}`).join(' ');
    return `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" ${dash}/>`;
  }

  if (showBaseline && baseline) svg += polyline(baseline, colors.baseline, 'stroke-dasharray="4,4"');
  svg += polyline(planned, colors.planned);
  svg += polyline(actual, colors.actual);
  if (showForecast && forecast) svg += polyline(forecast, colors.forecast, 'stroke-dasharray="6,3"');

  // Legend
  const legendY = 15;
  svg += _rect(pad.left + 10, legendY - 8, 12, 3, colors.planned);
  svg += _text(pad.left + 26, legendY, 'planned', colors.textDim, 'font-size="10"');
  svg += _rect(pad.left + 90, legendY - 8, 12, 3, colors.actual);
  svg += _text(pad.left + 106, legendY, 'actual', colors.textDim, 'font-size="10"');
  if (showBaseline && baseline) {
    svg += _rect(pad.left + 160, legendY - 8, 12, 3, colors.baseline);
    svg += _text(pad.left + 176, legendY, 'baseline', colors.textDim, 'font-size="10"');
  }

  // Axes
  svg += _line(pad.left, pad.top, pad.left, pad.top + plotH, colors.text);
  svg += _line(pad.left, pad.top + plotH, pad.left + plotW, pad.top + plotH, colors.text);

  return _svg(width, height, svg);
}

// ── Resource Histogram ──

function resourceHistogram(scheduledTasks, options = {}) {
  const {
    width = 800,
    height = 300,
    bucket = 'week',
  } = options;
  const colors = { ...GCU };

  // Group tasks by resource and bucket
  const tasks = scheduledTasks.filter(t => t.resource);
  if (tasks.length === 0) return _svg(width, height, _text(10, 25, 'No resource data', colors.textDim));

  let minDate = tasks[0].earlyStart, maxDate = tasks[0].earlyFinish;
  for (const t of tasks) {
    if (t.earlyStart < minDate) minDate = t.earlyStart;
    if (t.earlyFinish > maxDate) maxDate = t.earlyFinish;
  }

  // Generate weekly buckets
  const buckets = [];
  const d = new Date(minDate);
  const bucketDays = bucket === 'month' ? 30 : bucket === 'day' ? 1 : 7;
  while (d <= maxDate) {
    buckets.push(new Date(d));
    d.setDate(d.getDate() + bucketDays);
  }
  if (buckets.length === 0) return _svg(width, height, _text(10, 25, 'No data', colors.textDim));

  // Count tasks per resource per bucket
  const resources = [...new Set(tasks.map(t => t.resource))].sort();
  const resColors = {};
  const palette = ['#4A90D9', '#B87333', '#2D8B6F', '#D9534F', '#8E6BBF', '#6BBF6B', '#D9A534'];
  resources.forEach((r, i) => resColors[r] = palette[i % palette.length]);

  const data = buckets.map(() => ({}));
  for (const t of tasks) {
    for (let bi = 0; bi < buckets.length; bi++) {
      const bStart = buckets[bi];
      const bEnd = new Date(bStart.getTime() + bucketDays * 86400000);
      if (t.earlyStart < bEnd && t.earlyFinish > bStart) {
        if (!data[bi][t.resource]) data[bi][t.resource] = 0;
        data[bi][t.resource]++;
      }
    }
  }

  const maxCount = Math.max(1, ...data.map(d => Object.values(d).reduce((s, v) => s + v, 0)));

  const pad = { top: 30, right: 20, bottom: 50, left: 40 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const barW = Math.max(2, plotW / buckets.length - 2);

  let svg = '';
  svg += _rect(0, 0, width, height, colors.bg);

  // Bars
  for (let bi = 0; bi < buckets.length; bi++) {
    const x = pad.left + (bi / buckets.length) * plotW;
    let yOff = 0;
    for (const res of resources) {
      const count = data[bi][res] || 0;
      if (count > 0) {
        const barH = (count / maxCount) * plotH;
        svg += _rect(x, pad.top + plotH - yOff - barH, barW, barH, resColors[res], 'opacity="0.8"');
        yOff += barH;
      }
    }
  }

  // X-axis labels
  const step = Math.max(1, Math.floor(buckets.length / 8));
  for (let i = 0; i < buckets.length; i += step) {
    const x = pad.left + (i / buckets.length) * plotW;
    svg += _text(x, height - pad.bottom + 15, _fmtDate(buckets[i]), colors.textDim, 'font-size="9" text-anchor="middle"');
  }

  // Y-axis
  svg += _line(pad.left, pad.top, pad.left, pad.top + plotH, colors.text);
  svg += _line(pad.left, pad.top + plotH, pad.left + plotW, pad.top + plotH, colors.text);

  // Legend
  let lx = pad.left + 10;
  for (const res of resources) {
    svg += _rect(lx, 12, 10, 10, resColors[res]);
    svg += _text(lx + 14, 21, res, colors.textDim, 'font-size="10"');
    lx += res.length * 7 + 24;
  }

  return _svg(width, height, svg);
}

// ── Stage-Gate Matrix ──

function stageGateView(stageGateData, options = {}) {
  const {
    width = 1000,
    cellSize = 32,
    showProgress = true,
  } = options;
  const statusColors = {
    complete: '#6BBF6B',
    active: '#B87333',
    pending: '#333',
    blocked: '#D94040',
    ...((options.colors) || {}),
  };

  const { stages, instances, bottleneck } = stageGateData;
  const labelW = 160;
  const headerH = 40;
  const h = headerH + instances.length * (cellSize + 4) + 10;

  let svg = '';
  svg += _rect(0, 0, width, h, GCU.bg);

  // Column headers
  for (let si = 0; si < stages.length; si++) {
    const x = labelW + si * (cellSize + 4);
    const isBottleneck = bottleneck && bottleneck.stage === stages[si];
    svg += _text(x + cellSize / 2, 15, stages[si], isBottleneck ? '#c89b3c' : GCU.textDim,
      'text-anchor="middle" font-size="9" transform="rotate(-30,' + (x + cellSize/2) + ',15)"');
  }

  // Rows
  for (let ri = 0; ri < instances.length; ri++) {
    const inst = instances[ri];
    const y = headerH + ri * (cellSize + 4);

    // Label
    svg += _text(4, y + cellSize * 0.65, inst.name.length > 20 ? inst.name.substring(0, 18) + '\u2026' : inst.name,
      GCU.text, 'font-size="11"');

    // Stage cells
    for (let si = 0; si < stages.length; si++) {
      const x = labelW + si * (cellSize + 4);
      const s = inst.stages[stages[si]];
      if (!s) continue;

      svg += _rect(x, y, cellSize, cellSize, statusColors[s.status] || statusColors.pending, 'rx="3" opacity="0.7"');

      // Progress fill overlay
      if (showProgress && s.progress > 0 && s.progress < 1) {
        svg += _rect(x, y + cellSize * (1 - s.progress), cellSize, cellSize * s.progress,
          statusColors[s.status], 'rx="3" opacity="0.4"');
      }
    }
  }

  return _svg(width, h, svg);
}

// ── Workflow Flowchart ──

function workflowDiagram(workflow, options = {}) {
  const {
    direction = 'LR',
    showProbabilities = true,
    showDurations = true,
  } = options;

  const stages = workflow.stages;
  const nodeW = 120, nodeH = 40, gap = 60;
  const isLR = direction === 'LR';
  const totalW = isLR ? stages.length * (nodeW + gap) - gap + 40 : nodeW + 80;
  const totalH = isLR ? nodeH + 120 : stages.length * (nodeH + gap) - gap + 40;

  let svg = '';
  svg += _rect(0, 0, totalW, totalH, GCU.bg);

  const positions = {};

  // Nodes
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i];
    const x = isLR ? 20 + i * (nodeW + gap) : 40;
    const y = isLR ? 40 : 20 + i * (nodeH + gap);
    positions[s.id] = { x: x + nodeW / 2, y: y + nodeH / 2 };

    svg += _rect(x, y, nodeW, nodeH, '#222', 'rx="6" stroke="#444" stroke-width="1"');
    svg += _text(x + nodeW / 2, y + nodeH / 2 + 4, s.name || s.id, GCU.text, 'text-anchor="middle" font-size="10"');

    if (showDurations && s.duration) {
      svg += _text(x + nodeW / 2, y + nodeH + 14, `${s.duration}d`, GCU.textDim, 'text-anchor="middle" font-size="9"');
    }
  }

  // Transitions
  for (const tr of workflow.transitions) {
    const from = positions[tr.from];
    const to = positions[tr.to];
    if (!from || !to) continue;

    const isRework = tr.probability != null;
    const stroke = isRework ? '#D94040' : GCU.textDim;
    const dash = isRework ? 'stroke-dasharray="4,3"' : '';

    if (isLR) {
      if (isRework && to.x < from.x) {
        // Backward arc (rework)
        const arcY = Math.max(from.y, to.y) + 40;
        svg += _path(`M${from.x} ${from.y + nodeH/2} L${from.x} ${arcY} L${to.x} ${arcY} L${to.x} ${to.y + nodeH/2}`,
          stroke, 'none', `stroke-width="1" ${dash}`);
      } else {
        svg += _line(from.x + nodeW/2, from.y, to.x - nodeW/2, to.y, stroke, `stroke-width="1" ${dash}`);
      }
    } else {
      svg += _line(from.x, from.y + nodeH/2, to.x, to.y - nodeH/2, stroke, `stroke-width="1" ${dash}`);
    }

    if (showProbabilities && tr.probability != null) {
      const mx = (from.x + to.x) / 2;
      const my = isRework && isLR ? Math.max(from.y, to.y) + 50 : (from.y + to.y) / 2 - 8;
      svg += _text(mx, my, `${(tr.probability * 100).toFixed(0)}%`, '#D94040', 'text-anchor="middle" font-size="9"');
      if (tr.label) {
        svg += _text(mx, my + 12, tr.label, '#D94040', 'text-anchor="middle" font-size="8"');
      }
    }
  }

  return _svg(totalW, totalH, svg);
}

// ── Monte Carlo Histogram ──

function monteCarloPlot(monteCarloResult, options = {}) {
  const {
    width = 800,
    height = 400,
    showPercentiles = [10, 50, 75, 90],
    showTarget,
    targetLabel = 'Deadline',
  } = options;

  const { histogram, projectEnd } = monteCarloResult;
  const { bins, counts } = histogram;

  const pad = { top: 30, right: 40, bottom: 50, left: 60 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const maxCount = Math.max(1, ...counts);
  const barW = Math.max(2, plotW / counts.length - 1);

  let svg = '';
  svg += _rect(0, 0, width, height, GCU.bg);

  // Bars
  for (let i = 0; i < counts.length; i++) {
    const x = pad.left + (i / counts.length) * plotW;
    const barH = (counts[i] / maxCount) * plotH;
    svg += _rect(x, pad.top + plotH - barH, barW, barH, GCU.normal, 'opacity="0.7"');
  }

  // Percentile lines
  const pColors = { 10: '#6BBF6B', 50: '#B87333', 75: '#D9A534', 90: '#D94040' };
  for (const p of showPercentiles) {
    const key = `p${p}`;
    const date = projectEnd[key];
    if (!date) continue;
    const x = pad.left + ((date - bins[0]) / (bins[bins.length - 1] - bins[0] || 1)) * plotW;
    const color = pColors[p] || '#888';
    svg += _line(x, pad.top, x, pad.top + plotH, color, 'stroke-width="2" stroke-dasharray="4,3"');
    svg += _text(x, pad.top - 5, `P${p}: ${_fmtDate(date)}`, color, 'text-anchor="middle" font-size="10"');
  }

  // Target deadline
  if (showTarget) {
    const td = _parseDate(showTarget);
    const x = pad.left + ((td - bins[0]) / (bins[bins.length - 1] - bins[0] || 1)) * plotW;
    svg += _line(x, pad.top, x, pad.top + plotH, '#c89b3c', 'stroke-width="2"');
    svg += _text(x, pad.top + plotH + 15, targetLabel, '#c89b3c', 'text-anchor="middle" font-size="10"');
  }

  // X-axis labels
  const step = Math.max(1, Math.floor(bins.length / 6));
  for (let i = 0; i < bins.length; i += step) {
    const x = pad.left + (i / (bins.length - 1)) * plotW;
    svg += _text(x, height - pad.bottom + 15, _fmtDate(bins[i]), GCU.textDim, 'text-anchor="middle" font-size="9"');
  }

  // Axes
  svg += _line(pad.left, pad.top, pad.left, pad.top + plotH, GCU.text);
  svg += _line(pad.left, pad.top + plotH, pad.left + plotW, pad.top + plotH, GCU.text);

  return _svg(width, height, svg);
}

// -- xlsx.js --

// XLSX export adapter — uses @sheet if available



function planToXLSX(scheduleResult, scurveData, options = {}) {
  // Try to get @sheet from the import cache
  const sheet = (typeof window !== 'undefined' && window._importCache && window._importCache['@sheet'])
    || options.sheet;

  if (!sheet || !sheet.writeXLSX) {
    throw new Error('planToXLSX requires @sheet to be loaded. Call load("@sheet") first.');
  }

  const wb = {};

  // Schedule sheet
  wb['Schedule'] = [
    ['ID', 'Name', 'Group', 'Resource', 'Duration', 'Start', 'Finish', 'Float', 'Critical', 'Progress'],
    ...scheduleResult.scheduled.map(t => [
      t.id,
      t.name || t.id,
      t.group || '',
      t.resource || '',
      effectiveDuration(t),
      _fmtDate(t.earlyStart),
      _fmtDate(t.earlyFinish),
      t.totalFloat,
      t.isCritical ? 'Yes' : 'No',
      t.progress != null ? Math.round(t.progress * 100) + '%' : '',
    ]),
  ];

  // S-Curve sheet
  if (scurveData && scurveData.labels) {
    const scRows = [['Period', 'Planned', 'Actual']];
    for (let i = 0; i < scurveData.labels.length; i++) {
      scRows.push([
        scurveData.labels[i],
        Math.round(scurveData.planned[i] * 100) / 100,
        Math.round((scurveData.actual[i] || 0) * 100) / 100,
      ]);
    }
    wb['S-Curve'] = scRows;
  }

  return sheet.writeXLSX(wb);
}
export {
  // calendar
  isWorkingDay, addWorkingDays, workingDays, nextWorkingDay, getBlockedDays,
  // pert
  pertExpected, pertStdDev, pertVariance, effectiveDuration,
  // graph
  topoSort, detectCycles, predecessors, successors,
  // schedule
  schedule,
  // resource
  detectConflicts, levelResources,
  // scurve
  scurve,
  // evm
  evm,
  // workflow
  instantiate, instantiateBatch, compose, stageGateMatrix, throughput,
  // montecarlo
  monteCarlo, createRng, samplePert,
  // render
  gantt, scurvePlot, resourceHistogram, stageGateView, workflowDiagram, monteCarloPlot,
  // xlsx
  planToXLSX,
};
