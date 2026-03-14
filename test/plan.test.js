import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const cal = await import('../ext/plan/src/calendar.js');
const pert = await import('../ext/plan/src/pert.js');
const graph = await import('../ext/plan/src/graph.js');
const sched = await import('../ext/plan/src/schedule.js');
const res = await import('../ext/plan/src/resource.js');
const sc = await import('../ext/plan/src/scurve.js');
const ev = await import('../ext/plan/src/evm.js');
const wf = await import('../ext/plan/src/workflow.js');
const mc = await import('../ext/plan/src/montecarlo.js');
const render = await import('../ext/plan/src/render.js');

// ── Test calendar ──

const defaultCal = {
  weekends: [0, 6],
  holidays: [
    { date: '2026-01-01', label: 'New Year' },
    { date: '2026-12-25', label: 'Christmas' },
  ],
  blocked: [
    { start: '2026-12-21', end: '2027-01-04', label: 'Year-end shutdown' },
  ],
};

describe('plan: calendar', () => {
  it('weekdays are working days', () => {
    assert.ok(cal.isWorkingDay('2026-03-16', defaultCal)); // Monday
    assert.ok(cal.isWorkingDay('2026-03-20', defaultCal)); // Friday
  });

  it('weekends are not working days', () => {
    assert.ok(!cal.isWorkingDay('2026-03-14', defaultCal)); // Saturday
    assert.ok(!cal.isWorkingDay('2026-03-15', defaultCal)); // Sunday
  });

  it('holidays are not working days', () => {
    // 2026-01-01 is a Thursday
    assert.ok(!cal.isWorkingDay('2026-01-01', defaultCal));
  });

  it('blocked ranges are not working days', () => {
    assert.ok(!cal.isWorkingDay('2026-12-22', defaultCal)); // within blocked range (Tuesday)
  });

  it('resource overrides block days', () => {
    const resource = {
      calendarOverrides: [
        { start: '2026-06-15', end: '2026-06-27', type: 'vacation', label: 'Germany' },
      ],
    };
    assert.ok(!cal.isWorkingDay('2026-06-16', defaultCal, resource)); // Tuesday, on vacation
    assert.ok(cal.isWorkingDay('2026-06-16', defaultCal)); // Without resource: working day
  });

  it('addWorkingDays skips weekends', () => {
    // Friday + 1 working day = Monday
    const result = cal.addWorkingDays('2026-03-20', 1, defaultCal);
    assert.equal(result.getFullYear(), 2026);
    assert.equal(result.getMonth(), 2); // March
    assert.equal(result.getDate(), 23); // Monday
  });

  it('addWorkingDays skips holidays', () => {
    // 2025-12-31 (Wed) + 1 = 2026-01-02 (Fri, skipping Jan 1 holiday)
    const result = cal.addWorkingDays('2025-12-31', 1, defaultCal);
    assert.equal(result.getDate(), 2);
    assert.equal(result.getMonth(), 0);
    assert.equal(result.getFullYear(), 2026);
  });

  it('addWorkingDays negative for backward pass', () => {
    // Monday - 1 working day = Friday
    const result = cal.addWorkingDays('2026-03-23', -1, defaultCal);
    assert.equal(result.getDate(), 20); // Friday
  });

  it('workingDays counts correctly', () => {
    // Mon to Fri = 5 working days (Mon, Tue, Wed, Thu, Fri exclusive of end? No, exclusive of end means Mon-Fri counts Mon,Tue,Wed,Thu = 4)
    // Actually: Mon March 16 to Fri March 20. Count: 16,17,18,19 = 4 (exclusive of end)
    const count = cal.workingDays('2026-03-16', '2026-03-20', defaultCal);
    assert.equal(count, 4);
  });

  it('workingDays across weekend', () => {
    // Mon March 16 to Mon March 23 = 5 working days (16,17,18,19,20 — skip 21,22)
    const count = cal.workingDays('2026-03-16', '2026-03-23', defaultCal);
    assert.equal(count, 5);
  });

  it('nextWorkingDay on weekend returns Monday', () => {
    const result = cal.nextWorkingDay('2026-03-14', defaultCal); // Saturday
    assert.equal(result.getDate(), 16); // Monday
  });

  it('nextWorkingDay on working day returns same day', () => {
    const result = cal.nextWorkingDay('2026-03-16', defaultCal); // Monday
    assert.equal(result.getDate(), 16);
  });

  it('getBlockedDays includes weekends and holidays', () => {
    const blocked = cal.getBlockedDays('2026-03-14', '2026-03-16', defaultCal);
    assert.equal(blocked.length, 2); // Sat + Sun
    assert.equal(blocked[0].reason, 'weekend');
  });
});

// ── Test PERT ──

describe('plan: pert', () => {
  it('pertExpected', () => {
    assert.equal(pert.pertExpected({ o: 3, m: 5, p: 10 }), (3 + 20 + 10) / 6);
  });

  it('pertStdDev', () => {
    assert.equal(pert.pertStdDev({ o: 3, m: 5, p: 9 }), 1);
  });

  it('pertVariance', () => {
    assert.equal(pert.pertVariance({ o: 3, m: 5, p: 9 }), 1);
  });

  it('effectiveDuration prefers PERT', () => {
    const task = { duration: 5, pert: { o: 3, m: 5, p: 10 } };
    assert.equal(pert.effectiveDuration(task), pert.pertExpected(task.pert));
  });

  it('effectiveDuration falls back to duration', () => {
    assert.equal(pert.effectiveDuration({ duration: 7 }), 7);
  });

  it('effectiveDuration milestone returns 0', () => {
    assert.equal(pert.effectiveDuration({ milestone: true, duration: 5 }), 0);
  });
});

// ── Test graph ──

describe('plan: graph', () => {
  it('topoSort linear chain', () => {
    const tasks = [
      { id: 'a', depends: [] },
      { id: 'b', depends: ['a'] },
      { id: 'c', depends: ['b'] },
    ];
    const order = graph.topoSort(tasks);
    assert.deepEqual(order, ['a', 'b', 'c']);
  });

  it('topoSort diamond DAG', () => {
    const tasks = [
      { id: 'a' },
      { id: 'b', depends: ['a'] },
      { id: 'c', depends: ['a'] },
      { id: 'd', depends: ['b', 'c'] },
    ];
    const order = graph.topoSort(tasks);
    assert.equal(order[0], 'a');
    assert.equal(order[3], 'd');
    assert.ok(order.indexOf('b') < order.indexOf('d'));
    assert.ok(order.indexOf('c') < order.indexOf('d'));
  });

  it('topoSort throws on cycle', () => {
    const tasks = [
      { id: 'a', depends: ['b'] },
      { id: 'b', depends: ['a'] },
    ];
    assert.throws(() => graph.topoSort(tasks), /cycle/i);
  });

  it('detectCycles returns cycle', () => {
    const tasks = [
      { id: 'a', depends: ['c'] },
      { id: 'b', depends: ['a'] },
      { id: 'c', depends: ['b'] },
    ];
    const cycle = graph.detectCycles(tasks);
    assert.ok(cycle);
    assert.ok(cycle.length >= 2);
  });

  it('detectCycles returns null for acyclic', () => {
    const tasks = [
      { id: 'a' },
      { id: 'b', depends: ['a'] },
    ];
    assert.equal(graph.detectCycles(tasks), null);
  });

  it('predecessors transitive', () => {
    const tasks = [
      { id: 'a' },
      { id: 'b', depends: ['a'] },
      { id: 'c', depends: ['b'] },
    ];
    const preds = graph.predecessors('c', tasks);
    assert.ok(preds.includes('a'));
    assert.ok(preds.includes('b'));
  });

  it('successors transitive', () => {
    const tasks = [
      { id: 'a' },
      { id: 'b', depends: ['a'] },
      { id: 'c', depends: ['b'] },
    ];
    const succs = graph.successors('a', tasks);
    assert.ok(succs.includes('b'));
    assert.ok(succs.includes('c'));
  });
});

// ── Test schedule ──

describe('plan: schedule', () => {
  it('linear chain scheduling', () => {
    const tasks = [
      { id: 'a', duration: 3 },
      { id: 'b', duration: 2, depends: ['a'] },
      { id: 'c', duration: 1, depends: ['b'] },
    ];
    const result = sched.schedule(tasks, defaultCal, '2026-03-16');
    assert.equal(result.scheduled.length, 3);

    const a = result.scheduled.find(t => t.id === 'a');
    const b = result.scheduled.find(t => t.id === 'b');
    const c = result.scheduled.find(t => t.id === 'c');

    // a: starts Mon 16, 3 working days → ends Thu 19
    assert.equal(a.earlyStart.getDate(), 16);
    assert.equal(a.earlyFinish.getDate(), 19);

    // b: starts Thu 19, 2 working days → ends Mon 23 (skips weekend)
    assert.equal(b.earlyStart.getDate(), 19);

    // All on critical path
    assert.ok(a.isCritical);
    assert.ok(b.isCritical);
    assert.ok(c.isCritical);
  });

  it('diamond with float', () => {
    const tasks = [
      { id: 'start', duration: 1 },
      { id: 'long', duration: 5, depends: ['start'] },
      { id: 'short', duration: 2, depends: ['start'] },
      { id: 'end', duration: 1, depends: ['long', 'short'] },
    ];
    const result = sched.schedule(tasks, defaultCal, '2026-03-16');

    const short = result.scheduled.find(t => t.id === 'short');
    const long = result.scheduled.find(t => t.id === 'long');

    // Short path has float, long path is critical
    assert.ok(long.isCritical);
    assert.ok(short.totalFloat > 0);
  });

  it('independent tasks with explicit start dates', () => {
    const tasks = [
      { id: 'a', duration: 5, start: '2026-01-06' },
      { id: 'b', duration: 10, start: '2026-02-03' },
    ];
    const result = sched.schedule(tasks, defaultCal, '2026-01-06');
    const a = result.scheduled.find(t => t.id === 'a');
    const b = result.scheduled.find(t => t.id === 'b');

    assert.equal(a.earlyStart.getMonth(), 0); // January
    assert.equal(b.earlyStart.getMonth(), 1); // February
  });

  it('calendar-aware: weekend extends duration', () => {
    // Start Friday, 2 working days = finish Tuesday (skips Sat, Sun)
    const tasks = [{ id: 'a', duration: 2 }];
    const result = sched.schedule(tasks, defaultCal, '2026-03-20'); // Friday
    const a = result.scheduled[0];
    assert.equal(a.earlyStart.getDate(), 20); // Friday
    assert.equal(a.earlyFinish.getDate(), 24); // Tuesday (skips weekend)
  });

  it('milestone tasks', () => {
    const tasks = [
      { id: 'work', duration: 5 },
      { id: 'review', milestone: true, depends: ['work'] },
    ];
    const result = sched.schedule(tasks, defaultCal, '2026-03-16');
    const review = result.scheduled.find(t => t.id === 'review');
    assert.equal(review.earlyStart.getTime(), review.earlyFinish.getTime());
  });

  it('critical path identification', () => {
    const tasks = [
      { id: 'a', duration: 3 },
      { id: 'b', duration: 2, depends: ['a'] },
    ];
    const result = sched.schedule(tasks, defaultCal, '2026-03-16');
    assert.deepEqual(result.criticalPath, ['a', 'b']);
  });
});

// ── Test resource ──

describe('plan: resource', () => {
  it('detectConflicts finds overlapping tasks', () => {
    const tasks = [
      { id: 'a', resource: 'r1', earlyStart: new Date(2026, 2, 16), earlyFinish: new Date(2026, 2, 20) },
      { id: 'b', resource: 'r1', earlyStart: new Date(2026, 2, 18), earlyFinish: new Date(2026, 2, 23) },
    ];
    const conflicts = res.detectConflicts(tasks);
    assert.equal(conflicts.length, 1);
    assert.deepEqual(conflicts[0].tasks, ['a', 'b']);
  });

  it('detectConflicts no overlap', () => {
    const tasks = [
      { id: 'a', resource: 'r1', earlyStart: new Date(2026, 2, 16), earlyFinish: new Date(2026, 2, 18) },
      { id: 'b', resource: 'r1', earlyStart: new Date(2026, 2, 18), earlyFinish: new Date(2026, 2, 20) },
    ];
    const conflicts = res.detectConflicts(tasks);
    assert.equal(conflicts.length, 0);
  });

  it('detectConflicts different resources no conflict', () => {
    const tasks = [
      { id: 'a', resource: 'r1', earlyStart: new Date(2026, 2, 16), earlyFinish: new Date(2026, 2, 20) },
      { id: 'b', resource: 'r2', earlyStart: new Date(2026, 2, 16), earlyFinish: new Date(2026, 2, 20) },
    ];
    const conflicts = res.detectConflicts(tasks);
    assert.equal(conflicts.length, 0);
  });
});

// ── Test S-curve ──

describe('plan: scurve', () => {
  it('generates cumulative planned values', () => {
    const tasks = [
      { id: 'a', duration: 5, earlyStart: new Date(2026, 2, 16), earlyFinish: new Date(2026, 2, 21), progress: 1.0 },
      { id: 'b', duration: 5, earlyStart: new Date(2026, 2, 23), earlyFinish: new Date(2026, 2, 28), progress: 0.5 },
      { id: 'c', duration: 5, earlyStart: new Date(2026, 2, 30), earlyFinish: new Date(2026, 3, 4), progress: 0 },
    ];
    const result = sc.scurve(tasks, { bucket: 'week' });
    assert.ok(result.labels.length > 0);
    assert.equal(result.total, 3); // 3 tasks
    // Planned should be monotonically increasing
    for (let i = 1; i < result.planned.length; i++) {
      assert.ok(result.planned[i] >= result.planned[i - 1]);
    }
  });

  it('tracks actual progress', () => {
    const tasks = [
      { id: 'a', duration: 5, earlyStart: new Date(2026, 2, 16), earlyFinish: new Date(2026, 2, 21), progress: 1.0 },
      { id: 'b', duration: 5, earlyStart: new Date(2026, 2, 23), earlyFinish: new Date(2026, 2, 28), progress: 0.5 },
    ];
    const result = sc.scurve(tasks, { bucket: 'week', today: '2026-03-28' });
    const lastActual = result.actual[result.actual.length - 1];
    assert.ok(lastActual > 0);
    assert.ok(result.percentComplete > 0);
  });
});

// ── Test EVM ──

describe('plan: evm', () => {
  it('computes EVM metrics', () => {
    const tasks = [
      { id: 'a', duration: 10, earlyStart: new Date(2026, 0, 6), earlyFinish: new Date(2026, 0, 20), progress: 1.0 },
      { id: 'b', duration: 10, earlyStart: new Date(2026, 0, 20), earlyFinish: new Date(2026, 1, 3), progress: 0.5 },
    ];
    const result = ev.evm(tasks, '2026-01-30');
    assert.equal(result.bac, 20); // total planned duration
    assert.equal(result.ev, 15); // 10 * 1.0 + 10 * 0.5
    assert.ok(result.spi > 0);
  });

  it('SPI = 1 when on schedule', () => {
    const tasks = [
      { id: 'a', duration: 10, earlyStart: new Date(2026, 0, 6), earlyFinish: new Date(2026, 0, 20), progress: 1.0 },
    ];
    // Status date after task finishes
    const result = ev.evm(tasks, '2026-01-25');
    assert.equal(result.spi, 1);
    assert.equal(result.ev, result.pv);
  });
});

// ── Test workflow ──

describe('plan: workflow', () => {
  const workflow = {
    id: 'test-wf',
    stages: [
      { id: 'design', name: 'Design', duration: 3 },
      { id: 'build', name: 'Build', duration: 5 },
      { id: 'test', name: 'Test', duration: 2 },
    ],
    transitions: [
      { from: 'design', to: 'build' },
      { from: 'build', to: 'test' },
      { from: 'test', to: 'build', probability: 0.1, label: 'rework' },
    ],
  };

  it('instantiate creates prefixed task IDs', () => {
    const { tasks } = wf.instantiate(workflow, { id: 'proj-1', start: '2026-03-16' });
    assert.equal(tasks.length, 3);
    assert.equal(tasks[0].id, 'proj-1/design');
    assert.equal(tasks[1].id, 'proj-1/build');
    assert.equal(tasks[2].id, 'proj-1/test');
  });

  it('instantiate resolves dependencies, excludes rework', () => {
    const { tasks, reworkTransitions } = wf.instantiate(workflow, { id: 'p1' });
    const build = tasks.find(t => t.id === 'p1/build');
    assert.ok(build.depends.includes('p1/design'));

    const test = tasks.find(t => t.id === 'p1/test');
    assert.ok(test.depends.includes('p1/build'));
    // Rework transition should NOT be in depends
    assert.ok(!build.depends.includes('p1/test'));

    assert.equal(reworkTransitions.length, 1);
    assert.equal(reworkTransitions[0].probability, 0.1);
  });

  it('instantiate applies stageOverrides', () => {
    const { tasks } = wf.instantiate(workflow, {
      id: 'p2',
      stageOverrides: { build: { duration: 10, resource: 'bob' } },
    });
    const build = tasks.find(t => t.id === 'p2/build');
    assert.equal(build.duration, 10);
    assert.equal(build.resource, 'bob');
  });

  it('instantiateBatch concatenates', () => {
    const { tasks } = wf.instantiateBatch(workflow, [
      { id: 'a' }, { id: 'b' },
    ]);
    assert.equal(tasks.length, 6); // 3 stages × 2 instances
  });

  it('compose merges with cross-dependencies', () => {
    const { tasks: g1 } = wf.instantiate(workflow, { id: 'a' });
    const { tasks: g2 } = wf.instantiate(workflow, { id: 'b' });
    const merged = wf.compose([g1, g2], [
      { from: 'a/test', to: 'b/design' },
    ]);
    assert.equal(merged.length, 6);
    const bDesign = merged.find(t => t.id === 'b/design');
    assert.ok(bDesign.depends.includes('a/test'));
  });

  it('stageGateMatrix correct status', () => {
    const instances = [
      {
        id: 'inst-1', name: 'Model A',
        currentStage: 'build',
        stageProgress: { design: 1.0, build: 0.4, test: 0 },
      },
    ];
    const result = wf.stageGateMatrix(workflow, instances);
    assert.equal(result.stages.length, 3);
    const inst = result.instances[0];
    assert.equal(inst.stages.design.status, 'complete');
    assert.equal(inst.stages.build.status, 'active');
    assert.equal(inst.stages.test.status, 'pending');
  });
});

// ── Test Monte Carlo ──

describe('plan: montecarlo', () => {
  it('seeded RNG is deterministic', () => {
    const rng1 = mc.createRng(42);
    const rng2 = mc.createRng(42);
    for (let i = 0; i < 10; i++) {
      assert.equal(rng1.next(), rng2.next());
    }
  });

  it('samplePert respects bounds', () => {
    const rng = mc.createRng(42);
    for (let i = 0; i < 100; i++) {
      const s = mc.samplePert({ o: 3, m: 5, p: 10 }, rng);
      assert.ok(s >= 3, `sample ${s} < 3`);
      assert.ok(s <= 10, `sample ${s} > 10`);
    }
  });

  it('monteCarlo produces reproducible results', () => {
    const tasks = [
      { id: 'a', pert: { o: 3, m: 5, p: 10 } },
      { id: 'b', pert: { o: 2, m: 3, p: 5 }, depends: ['a'] },
    ];
    const r1 = mc.monteCarlo(tasks, defaultCal, '2026-03-16', { iterations: 100, seed: 42 });
    const r2 = mc.monteCarlo(tasks, defaultCal, '2026-03-16', { iterations: 100, seed: 42 });
    assert.equal(r1.projectEnd.p50.getTime(), r2.projectEnd.p50.getTime());
  });

  it('percentile ordering', () => {
    const tasks = [
      { id: 'a', pert: { o: 5, m: 10, p: 30 } },
      { id: 'b', pert: { o: 3, m: 5, p: 15 }, depends: ['a'] },
    ];
    const result = mc.monteCarlo(tasks, defaultCal, '2026-03-16', { iterations: 500, seed: 7 });
    assert.ok(result.projectEnd.p10 <= result.projectEnd.p50);
    assert.ok(result.projectEnd.p50 <= result.projectEnd.p75);
    assert.ok(result.projectEnd.p75 <= result.projectEnd.p90);
  });

  it('critical path frequency sums reasonably', () => {
    const tasks = [
      { id: 'a', pert: { o: 3, m: 5, p: 10 } },
      { id: 'b', pert: { o: 3, m: 5, p: 10 }, depends: ['a'] },
    ];
    const result = mc.monteCarlo(tasks, defaultCal, '2026-03-16', { iterations: 100, seed: 42 });
    // b should always be on critical path (it's the last task)
    assert.ok(result.criticalPathFrequency['b'] > 0.5);
  });
});

// ── Test renderers ──

describe('plan: render', () => {
  it('gantt produces valid SVG', () => {
    const tasks = [
      { id: 'a', duration: 5 },
      { id: 'b', duration: 3, depends: ['a'] },
    ];
    const result = sched.schedule(tasks, defaultCal, '2026-03-16');
    const svg = render.gantt(result);
    assert.ok(svg.startsWith('<svg'));
    assert.ok(svg.includes('</svg>'));
  });

  it('scurvePlot produces valid SVG', () => {
    const tasks = [
      { id: 'a', duration: 5, earlyStart: new Date(2026, 2, 16), earlyFinish: new Date(2026, 2, 21), progress: 1.0 },
    ];
    const data = sc.scurve(tasks, { bucket: 'week' });
    const svg = render.scurvePlot(data);
    assert.ok(svg.startsWith('<svg'));
  });

  it('stageGateView produces valid SVG', () => {
    const sgData = {
      stages: ['design', 'build', 'test'],
      instances: [
        { id: 'a', name: 'Model A', stages: { design: { status: 'complete', progress: 1 }, build: { status: 'active', progress: 0.5 }, test: { status: 'pending', progress: 0 } } },
      ],
      bottleneck: { stage: 'build', count: 1 },
    };
    const svg = render.stageGateView(sgData);
    assert.ok(svg.startsWith('<svg'));
  });

  it('workflowDiagram produces valid SVG', () => {
    const workflow = {
      stages: [
        { id: 'a', name: 'Alpha', duration: 3 },
        { id: 'b', name: 'Beta', duration: 5 },
      ],
      transitions: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a', probability: 0.1, label: 'rework' },
      ],
    };
    const svg = render.workflowDiagram(workflow);
    assert.ok(svg.startsWith('<svg'));
    assert.ok(svg.includes('10%'));
    assert.ok(svg.includes('rework'));
  });

  it('gantt handles empty input', () => {
    const result = { scheduled: [], criticalPath: [], projectEnd: new Date(), projectDuration: 0 };
    const svg = render.gantt(result);
    assert.ok(svg.startsWith('<svg'));
    assert.ok(svg.includes('No tasks'));
  });

  it('monteCarloPlot produces valid SVG', () => {
    const tasks = [
      { id: 'a', pert: { o: 3, m: 5, p: 10 } },
    ];
    const mcResult = mc.monteCarlo(tasks, defaultCal, '2026-03-16', { iterations: 100, seed: 42 });
    const svg = render.monteCarloPlot(mcResult);
    assert.ok(svg.startsWith('<svg'));
  });
});
