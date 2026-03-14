// Analysis functions — schedule, resource, math models, progress tracking

import { schedule } from './schedule.js';
import { workingDays, _parseDate, _fmtDate } from './calendar.js';
import { effectiveDuration } from './pert.js';
import { successors, _buildAdj, _taskMap } from './graph.js';

// ── Group 1: Schedule Analysis ──

// What-if scenario analysis: clone tasks, apply overrides, re-schedule, compare
function whatIf(tasks, calendar, projectStart, scenarios) {
  const baseline = schedule(tasks, calendar, projectStart);
  const results = [];

  for (const scenario of scenarios) {
    const cloned = tasks.map(t => {
      const override = scenario.overrides && scenario.overrides[t.id];
      return override ? { ...t, ...override } : { ...t };
    });
    const result = schedule(cloned, calendar, projectStart);
    const endDelta = workingDays(baseline.projectEnd, result.projectEnd, calendar);
    const negDelta = workingDays(result.projectEnd, baseline.projectEnd, calendar);
    results.push({
      label: scenario.label,
      projectEnd: result.projectEnd,
      projectDuration: result.projectDuration,
      endDelta: result.projectEnd >= baseline.projectEnd ? endDelta : -negDelta,
      durationDelta: result.projectDuration - baseline.projectDuration,
      criticalPath: result.criticalPath,
    });
  }

  return {
    baseline: { projectEnd: baseline.projectEnd, projectDuration: baseline.projectDuration },
    scenarios: results,
  };
}

// Delay impact: float remaining + downstream tasks affected + cost at risk
function delayImpact(taskId, scheduledTasks) {
  const taskMap = new Map();
  for (const t of scheduledTasks) taskMap.set(t.id, t);
  const task = taskMap.get(taskId);
  if (!task) return null;

  // Build forward adjacency from scheduled tasks
  const fwd = new Map();
  for (const t of scheduledTasks) {
    if (!fwd.has(t.id)) fwd.set(t.id, []);
    if (t.depends) {
      for (const dep of t.depends) {
        if (!fwd.has(dep)) fwd.set(dep, []);
        fwd.get(dep).push(t.id);
      }
    }
  }

  // BFS for all downstream
  const visited = new Set();
  const queue = [...(fwd.get(taskId) || [])];
  while (queue.length > 0) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    for (const succ of (fwd.get(id) || [])) queue.push(succ);
  }

  const downstreamTasks = [...visited];
  let costAtRisk = 0;
  for (const id of downstreamTasks) {
    const t = taskMap.get(id);
    if (t) {
      const dur = effectiveDuration(t);
      costAtRisk += (t.cost && t.cost.rate) ? t.cost.rate * dur : dur;
    }
  }
  // Include the task itself
  const taskDur = effectiveDuration(task);
  costAtRisk += (task.cost && task.cost.rate) ? task.cost.rate * taskDur : taskDur;

  return {
    task: taskId,
    slipDays: task.totalFloat || 0,
    downstreamTasks,
    costAtRisk,
  };
}

// Near-critical paths: tasks with float <= threshold, grouped into contiguous paths
function nearCritical(scheduleResult, maxFloat = 5) {
  const tasks = scheduleResult.scheduled;
  const near = tasks.filter(t => t.totalFloat <= maxFloat);
  if (near.length === 0) return { paths: [], count: 0 };

  // Build adjacency among near-critical tasks
  const nearIds = new Set(near.map(t => t.id));
  const fwd = new Map();
  const rev = new Map();
  for (const t of near) {
    fwd.set(t.id, []);
    rev.set(t.id, []);
  }
  for (const t of near) {
    if (t.depends) {
      for (const dep of t.depends) {
        if (nearIds.has(dep)) {
          fwd.get(dep).push(t.id);
          rev.get(t.id).push(dep);
        }
      }
    }
  }

  // Find paths: start from roots (no near-critical predecessors)
  const visited = new Set();
  const paths = [];
  const floatMap = new Map();
  for (const t of near) floatMap.set(t.id, t.totalFloat);

  for (const t of near) {
    if (rev.get(t.id).length === 0 && !visited.has(t.id)) {
      // Trace forward from this root
      const path = [];
      const stack = [t.id];
      while (stack.length > 0) {
        const id = stack.pop();
        if (visited.has(id)) continue;
        visited.add(id);
        path.push(id);
        for (const succ of fwd.get(id)) {
          if (!visited.has(succ)) stack.push(succ);
        }
      }
      if (path.length > 0) {
        const totalFloat = Math.min(...path.map(id => floatMap.get(id)));
        paths.push({ tasks: path, totalFloat });
      }
    }
  }

  return { paths, count: near.length };
}

// Slack budget: float distribution across all tasks
function slackBudget(scheduleResult) {
  const tasks = scheduleResult.scheduled;
  let critical = 0, tight = 0, comfortable = 0, buffered = 0;
  let totalFloat = 0;
  const floats = [];

  for (const t of tasks) {
    const f = t.totalFloat || 0;
    floats.push(f);
    totalFloat += f;
    if (f === 0) critical++;
    else if (f <= 5) tight++;
    else if (f <= 15) comfortable++;
    else buffered++;
  }

  floats.sort((a, b) => a - b);
  const n = floats.length;
  const medianFloat = n === 0 ? 0 : n % 2 === 1 ? floats[Math.floor(n / 2)] : (floats[n / 2 - 1] + floats[n / 2]) / 2;

  return {
    distribution: { critical, tight, comfortable, buffered },
    total: n,
    criticalRatio: n > 0 ? critical / n : 0,
    meanFloat: n > 0 ? totalFloat / n : 0,
    medianFloat,
  };
}

// Scope drift: diff two task lists by id
function scopeDrift(baselineTasks, currentTasks) {
  const baseMap = new Map();
  for (const t of baselineTasks) baseMap.set(t.id, t);
  const currMap = new Map();
  for (const t of currentTasks) currMap.set(t.id, t);

  const added = [];
  const removed = [];
  const changed = [];

  for (const t of currentTasks) {
    if (!baseMap.has(t.id)) {
      added.push(t.id);
    } else {
      const base = baseMap.get(t.id);
      // Compare key fields
      if (t.duration !== base.duration ||
          t.name !== base.name ||
          JSON.stringify(t.depends) !== JSON.stringify(base.depends) ||
          JSON.stringify(t.pert) !== JSON.stringify(base.pert)) {
        changed.push(t.id);
      }
    }
  }

  for (const t of baselineTasks) {
    if (!currMap.has(t.id)) removed.push(t.id);
  }

  const total = Math.max(baselineTasks.length, currentTasks.length);
  return {
    added, removed, changed,
    addedCount: added.length,
    removedCount: removed.length,
    changedCount: changed.length,
    driftRatio: total > 0 ? (added.length + removed.length + changed.length) / total : 0,
  };
}

// Buffer status: Critical Chain buffer consumption vs project progress
function bufferStatus(scheduledTasks, bufferDays) {
  if (bufferDays <= 0) return { bufferDays, consumed: 0, remaining: bufferDays, consumedRatio: 0, zone: 'green', feverChart: { x: 0, y: 0 } };

  // Project progress: weighted by duration
  let totalDur = 0, completedDur = 0;
  for (const t of scheduledTasks) {
    const dur = effectiveDuration(t);
    totalDur += dur;
    completedDur += dur * (t.progress || 0);
  }
  const projectProgress = totalDur > 0 ? completedDur / totalDur : 0;

  // Buffer consumed: sum of critical task delays (slip beyond early finish)
  let consumed = 0;
  for (const t of scheduledTasks) {
    if (t.isCritical && t.actualFinish) {
      const slip = (t.actualFinish - t.earlyFinish) / (1000 * 60 * 60 * 24);
      if (slip > 0) consumed += slip;
    }
  }

  const remaining = Math.max(0, bufferDays - consumed);
  const consumedRatio = consumed / bufferDays;

  // Fever chart zone: compare progress vs consumption
  let zone;
  if (consumedRatio <= projectProgress * 0.5 + 0.1) zone = 'green';
  else if (consumedRatio <= projectProgress * 0.8 + 0.3) zone = 'yellow';
  else zone = 'red';

  return {
    bufferDays, consumed, remaining, consumedRatio,
    zone,
    feverChart: { x: projectProgress, y: consumedRatio },
  };
}

// ── Group 2: Resource Analysis ──

// Bus factor: per-resource risk analysis
function busFactor(scheduledTasks, resources) {
  const resMap = new Map();
  for (const r of resources) resMap.set(r.id, { id: r.id, name: r.name || r.id, taskCount: 0, criticalTasks: 0, uniqueTasks: 0, risk: 'low' });

  // Count tasks per resource
  const taskResources = new Map(); // taskId → [resourceIds]
  for (const t of scheduledTasks) {
    if (!t.resource) continue;
    const r = resMap.get(t.resource);
    if (!r) continue;
    r.taskCount++;
    if (t.isCritical) r.criticalTasks++;
    if (!taskResources.has(t.id)) taskResources.set(t.id, []);
    taskResources.get(t.id).push(t.resource);
  }

  // Unique tasks: tasks only this resource can do
  for (const [taskId, resIds] of taskResources) {
    if (resIds.length === 1) {
      const r = resMap.get(resIds[0]);
      if (r) r.uniqueTasks++;
    }
  }

  // Risk assessment
  const result = [];
  for (const r of resMap.values()) {
    if (r.criticalTasks > 0 && r.uniqueTasks > 2) r.risk = 'high';
    else if (r.criticalTasks > 0 || r.uniqueTasks > 1) r.risk = 'medium';
    result.push(r);
  }

  return {
    resources: result,
    highRisk: result.filter(r => r.risk === 'high'),
  };
}

// Switching overhead: peak concurrent tasks for a resource
function switchingOverhead(resourceId, scheduledTasks) {
  const tasks = scheduledTasks.filter(t => t.resource === resourceId);
  if (tasks.length === 0) return { resourceId, totalTasks: 0, maxConcurrent: 0, effectiveCapacity: 1 };

  // Find max concurrent: sweep line
  const events = [];
  for (const t of tasks) {
    events.push({ time: t.earlyStart.getTime(), type: 1 });
    events.push({ time: t.earlyFinish.getTime(), type: -1 });
  }
  events.sort((a, b) => a.time - b.time || a.type - b.type);

  let current = 0, max = 0;
  for (const e of events) {
    current += e.type;
    if (current > max) max = current;
  }

  // Switching tax: ~20% per additional concurrent task (Weinberg-inspired)
  const effectiveCapacity = max <= 1 ? 1 : 1 / (1 + 0.2 * (max - 1));

  return { resourceId, totalTasks: tasks.length, maxConcurrent: max, effectiveCapacity };
}

// Meeting cost: person-hours and displaced work
function meetingCost(attendeeIds, durationHours, resources) {
  const resMap = new Map();
  for (const r of resources) resMap.set(r.id, r);

  let totalCost = 0;
  let attendees = 0;
  for (const id of attendeeIds) {
    const r = resMap.get(id);
    if (r) {
      attendees++;
      const hourlyRate = (r.cost && r.cost.rate) ? r.cost.rate / 8 : 0; // daily rate / 8
      totalCost += hourlyRate * durationHours;
    }
  }

  return {
    attendees,
    durationHours,
    totalPersonHours: attendees * durationHours,
    totalCost,
    displacedWorkDays: (attendees * durationHours) / 8,
  };
}

// Constraint: Theory of Constraints bottleneck by utilization
function constraint(scheduledTasks, resources) {
  const resMap = new Map();
  for (const r of resources) resMap.set(r.id, { id: r.id, name: r.name || r.id, taskCount: 0, totalDuration: 0, utilization: 0 });

  for (const t of scheduledTasks) {
    if (!t.resource) continue;
    const r = resMap.get(t.resource);
    if (!r) continue;
    r.taskCount++;
    r.totalDuration += effectiveDuration(t);
  }

  // Compute utilization as fraction of project span
  let minStart = Infinity, maxEnd = 0;
  for (const t of scheduledTasks) {
    const s = t.earlyStart.getTime();
    const e = t.earlyFinish.getTime();
    if (s < minStart) minStart = s;
    if (e > maxEnd) maxEnd = e;
  }
  const spanDays = (maxEnd - minStart) / (1000 * 60 * 60 * 24) || 1;

  const result = [];
  for (const r of resMap.values()) {
    r.utilization = r.totalDuration / spanDays;
    result.push(r);
  }
  result.sort((a, b) => b.utilization - a.utilization);

  return {
    bottleneck: result[0] || null,
    resources: result,
  };
}

// ── Group 3: Mathematical Models ──

// Brooks's Law: communication overhead from team size
function brooksLaw(teamSize) {
  const channels = teamSize * (teamSize - 1) / 2;
  const communicationOverhead = Math.min(0.9, channels * 0.02); // 2% per channel, cap at 90%
  const effectiveCapacity = teamSize * (1 - communicationOverhead);

  const projection = [];
  for (let add = 1; add <= 5; add++) {
    const newSize = teamSize + add;
    const newChannels = newSize * (newSize - 1) / 2;
    const newOverhead = Math.min(0.9, newChannels * 0.02);
    const newEffective = newSize * (1 - newOverhead);
    projection.push({
      additionalPeople: add,
      newTeamSize: newSize,
      newChannels,
      newEffective,
      marginalGain: newEffective - effectiveCapacity,
    });
  }

  return { teamSize, channels, communicationOverhead, effectiveCapacity, projection };
}

// Little's Law: L = λW → cycleTime = WIP / throughput
function littlesLaw(wip, throughput) {
  const cycleTime = throughput > 0 ? wip / throughput : Infinity;
  return {
    wip, throughput, cycleTime,
    projection: (newWip) => throughput > 0 ? newWip / throughput : Infinity,
  };
}

// Multi-project fragmentation: Weinberg's context-switching data
function multiProjectFragmentation(projectCount) {
  // Weinberg's data: effective % per project
  const table = [100, 40, 20, 10, 5];
  const effectivePerProject = projectCount <= table.length ? table[projectCount - 1] : Math.max(1, 100 / (projectCount * 2));
  const totalEffective = effectivePerProject * projectCount;
  const switchingLoss = 100 - totalEffective;

  const curve = [];
  for (let i = 1; i <= Math.max(projectCount + 2, 5); i++) {
    const eff = i <= table.length ? table[i - 1] : Math.max(1, 100 / (i * 2));
    curve.push({ projects: i, effectivePerProject: eff, totalEffective: eff * i, switchingLoss: 100 - eff * i });
  }

  return { projectCount, effectivePerProject, totalEffective, switchingLoss, curve };
}

// ── Group 4: Progress Tracking ──

// Burndown chart data
function burndown(scheduledTasks, options = {}) {
  const { today, metric = 'tasks', bucket = 'week' } = options;
  const now = today ? _parseDate(today) : new Date();

  if (scheduledTasks.length === 0) {
    return { labels: [], ideal: [], actual: [], forecast: [], totalWork: 0, completedWork: 0, velocity: 0 };
  }

  // Compute total work
  let totalWork = 0;
  for (const t of scheduledTasks) {
    if (metric === 'tasks') totalWork++;
    else if (metric === 'duration') totalWork += effectiveDuration(t);
    else if (metric === 'cost') totalWork += (t.cost && t.cost.rate) ? t.cost.rate * effectiveDuration(t) : effectiveDuration(t);
  }

  // Find project span
  let minStart = scheduledTasks[0].earlyStart;
  let maxEnd = scheduledTasks[0].earlyFinish;
  for (const t of scheduledTasks) {
    if (t.earlyStart < minStart) minStart = t.earlyStart;
    if (t.earlyFinish > maxEnd) maxEnd = t.earlyFinish;
  }

  // Generate buckets
  const bucketDays = bucket === 'month' ? 30 : bucket === 'day' ? 1 : 7;
  const labels = [];
  const dates = [];
  const d = new Date(minStart);
  while (d <= maxEnd) {
    labels.push(_fmtDate(d));
    dates.push(new Date(d));
    d.setDate(d.getDate() + bucketDays);
  }
  // Ensure we include the end
  if (dates.length === 0 || dates[dates.length - 1] < maxEnd) {
    labels.push(_fmtDate(maxEnd));
    dates.push(new Date(maxEnd));
  }

  // Ideal: linear burndown
  const ideal = dates.map((_, i) => totalWork * (1 - i / (dates.length - 1 || 1)));

  // Actual: remaining work at each bucket, date-aware
  // For tasks finished by bucket date: use actual progress
  // For tasks not yet started by bucket date: 0 progress
  // For tasks in progress at bucket date: interpolate using scheduled fraction and actual progress
  const actual = [];
  let completedWork = 0;
  for (let i = 0; i < dates.length; i++) {
    if (dates[i] > now) break;
    let done = 0;
    for (const t of scheduledTasks) {
      const work = metric === 'tasks' ? 1
        : metric === 'duration' ? effectiveDuration(t)
        : (t.cost && t.cost.rate) ? t.cost.rate * effectiveDuration(t) : effectiveDuration(t);

      if (t.earlyFinish <= dates[i]) {
        // Task scheduled to be done by this date — use actual progress
        done += work * (t.progress || 0);
      } else if (t.earlyStart <= dates[i]) {
        // Task in progress at this date — use min of scheduled fraction and actual progress
        const span = t.earlyFinish - t.earlyStart || 1;
        const elapsed = dates[i] - t.earlyStart;
        const scheduledFrac = Math.min(1, elapsed / span);
        const actualProg = t.progress || 0;
        done += work * Math.min(scheduledFrac, actualProg);
      }
      // else: not started yet, 0 progress
    }
    actual.push(totalWork - done);
    completedWork = done;
  }

  // Velocity: work done per bucket
  const velocity = actual.length > 1 ? (actual[0] - actual[actual.length - 1]) / (actual.length - 1) : 0;

  // Forecast: linear extrapolation from last actual
  const forecast = new Array(dates.length).fill(null);
  if (actual.length > 0 && velocity > 0) {
    const lastActual = actual[actual.length - 1];
    for (let i = actual.length - 1; i < dates.length; i++) {
      forecast[i] = Math.max(0, lastActual - velocity * (i - actual.length + 1));
    }
  }

  return { labels, ideal, actual, forecast, totalWork, completedWork, velocity };
}

// Project health: aggregate RAG from multiple indicators
function health(scheduleResult, evmResult, options = {}) {
  const { nearCriticalThreshold = 5 } = options;

  const indicators = {
    schedule: 'green',
    cost: 'green',
    scope: 'green',
    risk: 'green',
  };

  // Schedule health from SPI
  if (evmResult) {
    if (evmResult.spi < 0.8) indicators.schedule = 'red';
    else if (evmResult.spi < 0.95) indicators.schedule = 'amber';

    // Cost health from CPI
    if (evmResult.cpi < 0.8) indicators.cost = 'red';
    else if (evmResult.cpi < 0.95) indicators.cost = 'amber';
  }

  // Risk: critical ratio
  if (scheduleResult) {
    const tasks = scheduleResult.scheduled;
    const critCount = tasks.filter(t => t.isCritical).length;
    const critRatio = tasks.length > 0 ? critCount / tasks.length : 0;
    if (critRatio > 0.5) indicators.risk = 'red';
    else if (critRatio > 0.3) indicators.risk = 'amber';

    // Scope: near-critical count
    const nearCrit = tasks.filter(t => t.totalFloat <= nearCriticalThreshold && t.totalFloat > 0).length;
    if (nearCrit > tasks.length * 0.4) indicators.scope = 'red';
    else if (nearCrit > tasks.length * 0.2) indicators.scope = 'amber';
  }

  // Overall: worst indicator
  const values = Object.values(indicators);
  let overall = 'green';
  if (values.includes('red')) overall = 'red';
  else if (values.includes('amber')) overall = 'amber';

  const summary = overall === 'green' ? 'Project is healthy'
    : overall === 'amber' ? 'Project needs attention'
    : 'Project at risk';

  return { overall, indicators, summary };
}

export {
  whatIf, delayImpact, nearCritical, slackBudget, scopeDrift, bufferStatus,
  busFactor, switchingOverhead, meetingCost, constraint,
  brooksLaw, littlesLaw, multiProjectFragmentation,
  burndown, health,
};
