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

export { instantiate, instantiateBatch, compose, stageGateMatrix, throughput };
