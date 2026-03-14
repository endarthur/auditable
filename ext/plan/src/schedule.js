// CPM scheduler — forward/backward pass, float, critical path

import { addWorkingDays, workingDays, nextWorkingDay, _parseDate } from './calendar.js';
import { effectiveDuration } from './pert.js';
import { topoSort, _taskMap, _buildAdj } from './graph.js';

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

export { schedule };
