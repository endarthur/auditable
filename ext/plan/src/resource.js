// Resource conflict detection and simple leveling

import { addWorkingDays, nextWorkingDay, _parseDate } from './calendar.js';
import { schedule } from './schedule.js';

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

export { detectConflicts, levelResources };
