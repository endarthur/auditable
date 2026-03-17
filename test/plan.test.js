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
const analysis = await import('../ext/plan/src/analysis.js');

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

  it('effectiveDuration prefers PERT (rounded)', () => {
    const task = { duration: 5, pert: { o: 3, m: 5, p: 10 } };
    assert.equal(pert.effectiveDuration(task), Math.round(pert.pertExpected(task.pert)));
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

  it('tornadoPlot produces valid SVG', () => {
    const data = [
      { id: 'a', name: 'Task A', correlation: 0.85 },
      { id: 'b', name: 'Task B', correlation: -0.42 },
      { id: 'c', name: 'Task C', correlation: 0.15 },
    ];
    const svg = render.tornadoPlot(data);
    assert.ok(svg.startsWith('<svg'));
    assert.ok(svg.includes('Task A'));
  });

  it('tornadoPlot handles empty data', () => {
    const svg = render.tornadoPlot([]);
    assert.ok(svg.includes('No sensitivity data'));
  });

  it('burndownPlot produces valid SVG', () => {
    const data = {
      labels: ['2026-03-16', '2026-03-23', '2026-03-30'],
      ideal: [10, 5, 0],
      actual: [10, 7],
      forecast: [null, null, 3],
      totalWork: 10,
    };
    const svg = render.burndownPlot(data);
    assert.ok(svg.startsWith('<svg'));
    assert.ok(svg.includes('ideal'));
    assert.ok(svg.includes('actual'));
  });
});

// ── Analysis: Mathematical Models ──

describe('plan: brooksLaw', () => {
  it('returns correct channels for team of 5', () => {
    const r = analysis.brooksLaw(5);
    assert.equal(r.teamSize, 5);
    assert.equal(r.channels, 10); // 5*4/2
    assert.ok(r.effectiveCapacity > 0);
    assert.ok(r.effectiveCapacity < 5);
  });

  it('team of 1 has 0 channels', () => {
    const r = analysis.brooksLaw(1);
    assert.equal(r.channels, 0);
    assert.equal(r.communicationOverhead, 0);
    assert.equal(r.effectiveCapacity, 1);
  });

  it('projection shows 5 increments', () => {
    const r = analysis.brooksLaw(3);
    assert.equal(r.projection.length, 5);
    assert.equal(r.projection[0].additionalPeople, 1);
    assert.equal(r.projection[0].newTeamSize, 4);
  });

  it('large team has high overhead', () => {
    const r = analysis.brooksLaw(20);
    assert.ok(r.communicationOverhead > 0.5);
    assert.ok(r.effectiveCapacity < r.teamSize);
  });
});

describe('plan: littlesLaw', () => {
  it('computes cycle time correctly', () => {
    const r = analysis.littlesLaw(10, 2);
    assert.equal(r.cycleTime, 5);
    assert.equal(r.wip, 10);
    assert.equal(r.throughput, 2);
  });

  it('projection function works', () => {
    const r = analysis.littlesLaw(10, 2);
    assert.equal(r.projection(20), 10);
    assert.equal(r.projection(4), 2);
  });

  it('handles zero throughput', () => {
    const r = analysis.littlesLaw(5, 0);
    assert.equal(r.cycleTime, Infinity);
  });
});

describe('plan: multiProjectFragmentation', () => {
  it('1 project = 100% effective', () => {
    const r = analysis.multiProjectFragmentation(1);
    assert.equal(r.effectivePerProject, 100);
    assert.equal(r.totalEffective, 100);
    assert.equal(r.switchingLoss, 0);
  });

  it('2 projects = 40% each (Weinberg)', () => {
    const r = analysis.multiProjectFragmentation(2);
    assert.equal(r.effectivePerProject, 40);
    assert.equal(r.totalEffective, 80);
    assert.equal(r.switchingLoss, 20);
  });

  it('3 projects = 20% each', () => {
    const r = analysis.multiProjectFragmentation(3);
    assert.equal(r.effectivePerProject, 20);
    assert.equal(r.totalEffective, 60);
  });

  it('curve array includes expected range', () => {
    const r = analysis.multiProjectFragmentation(2);
    assert.ok(r.curve.length >= 5);
    assert.equal(r.curve[0].projects, 1);
    assert.equal(r.curve[0].effectivePerProject, 100);
  });
});

// ── Analysis: Schedule Analysis ──

describe('plan: slackBudget', () => {
  it('categorizes float correctly', () => {
    const result = sched.schedule([
      { id: 'a', duration: 5 },
      { id: 'b', duration: 3, depends: ['a'] },
      { id: 'c', duration: 2 }, // parallel, should have float
    ], defaultCal, '2026-03-16');
    const sb = analysis.slackBudget(result);
    assert.equal(sb.total, 3);
    assert.ok(sb.distribution.critical >= 0);
    assert.ok(sb.meanFloat >= 0);
  });

  it('all-critical schedule', () => {
    const result = sched.schedule([
      { id: 'a', duration: 5 },
      { id: 'b', duration: 3, depends: ['a'] },
    ], defaultCal, '2026-03-16');
    const sb = analysis.slackBudget(result);
    assert.equal(sb.distribution.critical, 2);
    assert.equal(sb.criticalRatio, 1);
  });
});

describe('plan: nearCritical', () => {
  it('finds near-critical tasks', () => {
    const result = sched.schedule([
      { id: 'a', duration: 10 },
      { id: 'b', duration: 8, depends: ['a'] },
      { id: 'c', duration: 2 }, // parallel, has float
    ], defaultCal, '2026-03-16');
    const nc = analysis.nearCritical(result, 20); // wide threshold to capture all
    assert.ok(nc.count > 0);
  });

  it('returns empty for no near-critical tasks', () => {
    const result = sched.schedule([
      { id: 'a', duration: 5 },
      { id: 'b', duration: 3, depends: ['a'] },
    ], defaultCal, '2026-03-16');
    // All tasks are critical (float=0), maxFloat=-1 means nothing qualifies
    const nc = analysis.nearCritical(result, -1);
    assert.equal(nc.count, 0);
  });
});

describe('plan: whatIf', () => {
  it('computes scenario deltas', () => {
    const tasks = [
      { id: 'a', duration: 5 },
      { id: 'b', duration: 3, depends: ['a'] },
    ];
    const result = analysis.whatIf(tasks, defaultCal, '2026-03-16', [
      { label: 'slip A', overrides: { a: { duration: 10 } } },
    ]);
    assert.ok(result.baseline.projectEnd);
    assert.equal(result.scenarios.length, 1);
    assert.equal(result.scenarios[0].label, 'slip A');
    assert.ok(result.scenarios[0].endDelta > 0); // project should be later
  });

  it('no change scenario has zero delta', () => {
    const tasks = [
      { id: 'a', duration: 5 },
    ];
    const result = analysis.whatIf(tasks, defaultCal, '2026-03-16', [
      { label: 'no change', overrides: {} },
    ]);
    assert.equal(result.scenarios[0].endDelta, 0);
    assert.equal(result.scenarios[0].durationDelta, 0);
  });
});

describe('plan: delayImpact', () => {
  it('identifies downstream tasks and cost', () => {
    const result = sched.schedule([
      { id: 'a', duration: 5 },
      { id: 'b', duration: 3, depends: ['a'] },
      { id: 'c', duration: 2, depends: ['b'] },
    ], defaultCal, '2026-03-16');
    const impact = analysis.delayImpact('a', result.scheduled);
    assert.equal(impact.task, 'a');
    assert.ok(impact.downstreamTasks.includes('b'));
    assert.ok(impact.downstreamTasks.includes('c'));
    assert.ok(impact.costAtRisk > 0);
  });

  it('leaf task has no downstream', () => {
    const result = sched.schedule([
      { id: 'a', duration: 5 },
      { id: 'b', duration: 3, depends: ['a'] },
    ], defaultCal, '2026-03-16');
    const impact = analysis.delayImpact('b', result.scheduled);
    assert.equal(impact.downstreamTasks.length, 0);
  });

  it('returns null for unknown task', () => {
    const result = sched.schedule([{ id: 'a', duration: 5 }], defaultCal, '2026-03-16');
    assert.equal(analysis.delayImpact('z', result.scheduled), null);
  });
});

describe('plan: scopeDrift', () => {
  it('detects added, removed, and changed tasks', () => {
    const baseline = [
      { id: 'a', name: 'A', duration: 5 },
      { id: 'b', name: 'B', duration: 3 },
    ];
    const current = [
      { id: 'a', name: 'A', duration: 8 }, // changed
      { id: 'c', name: 'C', duration: 2 }, // added
    ];
    const drift = analysis.scopeDrift(baseline, current);
    assert.deepEqual(drift.added, ['c']);
    assert.deepEqual(drift.removed, ['b']);
    assert.deepEqual(drift.changed, ['a']);
    assert.ok(drift.driftRatio > 0);
  });

  it('no drift when identical', () => {
    const tasks = [{ id: 'a', name: 'A', duration: 5 }];
    const drift = analysis.scopeDrift(tasks, tasks);
    assert.equal(drift.addedCount, 0);
    assert.equal(drift.removedCount, 0);
    assert.equal(drift.changedCount, 0);
    assert.equal(drift.driftRatio, 0);
  });
});

describe('plan: bufferStatus', () => {
  it('green zone with no consumption', () => {
    const tasks = [{ id: 'a', duration: 5, isCritical: true, earlyFinish: new Date('2026-03-20'), progress: 0 }];
    const bs = analysis.bufferStatus(tasks, 10);
    assert.equal(bs.zone, 'green');
    assert.equal(bs.consumed, 0);
    assert.equal(bs.remaining, 10);
  });

  it('handles zero buffer', () => {
    const bs = analysis.bufferStatus([], 0);
    assert.equal(bs.zone, 'green');
    assert.equal(bs.bufferDays, 0);
  });
});

// ── Analysis: Resource Analysis ──

describe('plan: busFactor', () => {
  it('identifies high-risk resources', () => {
    const tasks = [
      { id: 'a', resource: 'alice', isCritical: true },
      { id: 'b', resource: 'alice', isCritical: true },
      { id: 'c', resource: 'alice', isCritical: false },
      { id: 'd', resource: 'bob', isCritical: false },
    ];
    const resources = [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }];
    const bf = analysis.busFactor(tasks, resources);
    assert.equal(bf.resources.length, 2);
    const alice = bf.resources.find(r => r.id === 'alice');
    assert.equal(alice.taskCount, 3);
    assert.equal(alice.criticalTasks, 2);
  });
});

describe('plan: switchingOverhead', () => {
  it('reports max concurrent and effective capacity', () => {
    const tasks = [
      { id: 'a', resource: 'alice', earlyStart: new Date('2026-03-16'), earlyFinish: new Date('2026-03-25') },
      { id: 'b', resource: 'alice', earlyStart: new Date('2026-03-18'), earlyFinish: new Date('2026-03-23') },
      { id: 'c', resource: 'bob', earlyStart: new Date('2026-03-16'), earlyFinish: new Date('2026-03-20') },
    ];
    const so = analysis.switchingOverhead('alice', tasks);
    assert.equal(so.totalTasks, 2);
    assert.equal(so.maxConcurrent, 2);
    assert.ok(so.effectiveCapacity < 1);
  });

  it('no tasks returns zero', () => {
    const so = analysis.switchingOverhead('nobody', []);
    assert.equal(so.totalTasks, 0);
    assert.equal(so.maxConcurrent, 0);
  });
});

describe('plan: meetingCost', () => {
  it('computes total person-hours', () => {
    const resources = [
      { id: 'alice', cost: { rate: 80 } },
      { id: 'bob', cost: { rate: 64 } },
    ];
    const mc = analysis.meetingCost(['alice', 'bob'], 2, resources);
    assert.equal(mc.attendees, 2);
    assert.equal(mc.totalPersonHours, 4);
    assert.equal(mc.displacedWorkDays, 0.5);
    assert.ok(mc.totalCost > 0);
  });
});

describe('plan: constraint', () => {
  it('identifies bottleneck resource', () => {
    const tasks = sched.schedule([
      { id: 'a', duration: 10, resource: 'alice' },
      { id: 'b', duration: 3, resource: 'bob' },
      { id: 'c', duration: 8, resource: 'alice', depends: ['a'] },
    ], defaultCal, '2026-03-16').scheduled;
    const resources = [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }];
    const c = analysis.constraint(tasks, resources);
    assert.equal(c.bottleneck.id, 'alice');
    assert.ok(c.bottleneck.utilization > 0);
  });
});

// ── Analysis: Progress Tracking ──

describe('plan: burndown', () => {
  it('produces labels and ideal curve', () => {
    const tasks = sched.schedule([
      { id: 'a', duration: 5 },
      { id: 'b', duration: 5, depends: ['a'] },
    ], defaultCal, '2026-03-16').scheduled;
    const bd = analysis.burndown(tasks, { today: '2026-03-16' });
    assert.ok(bd.labels.length > 0);
    assert.equal(bd.totalWork, 2); // 2 tasks
    assert.equal(bd.ideal[0], 2);
    assert.equal(bd.ideal[bd.ideal.length - 1], 0);
  });

  it('handles empty tasks', () => {
    const bd = analysis.burndown([]);
    assert.equal(bd.totalWork, 0);
    assert.equal(bd.labels.length, 0);
  });
});

describe('plan: health', () => {
  it('green when all indicators healthy', () => {
    // Long critical path + many short parallel tasks = low critical ratio (<30%)
    const tasks = sched.schedule([
      { id: 'a', duration: 20 },
      { id: 'b', duration: 20, depends: ['a'] },
      { id: 'c', duration: 1 },
      { id: 'd', duration: 1 },
      { id: 'e', duration: 1 },
      { id: 'f', duration: 1 },
      { id: 'g', duration: 1 },
      { id: 'h', duration: 1 },
      { id: 'i', duration: 1 },
    ], defaultCal, '2026-03-16');
    const h = analysis.health(tasks, { spi: 1.0, cpi: 1.0 });
    assert.equal(h.indicators.schedule, 'green');
    assert.equal(h.indicators.cost, 'green');
    assert.equal(h.overall, 'green');
  });

  it('red when SPI is low', () => {
    const tasks = sched.schedule([
      { id: 'a', duration: 5 },
    ], defaultCal, '2026-03-16');
    const h = analysis.health(tasks, { spi: 0.5, cpi: 1.0 });
    assert.equal(h.indicators.schedule, 'red');
    assert.equal(h.overall, 'red');
  });

  it('amber when CPI slightly below threshold', () => {
    const h = analysis.health(null, { spi: 1.0, cpi: 0.9 });
    assert.equal(h.indicators.cost, 'amber');
  });
});

// ── Monte Carlo: Sensitivity ──

describe('plan: monteCarlo sensitivity', () => {
  it('returns sensitivity data by default', () => {
    const tasks = [
      { id: 'a', pert: { o: 3, m: 5, p: 15 } },
      { id: 'b', pert: { o: 1, m: 2, p: 4 }, depends: ['a'] },
    ];
    const result = mc.monteCarlo(tasks, defaultCal, '2026-03-16', { iterations: 500, seed: 42 });
    assert.ok(result.sensitivity);
    assert.ok(result.sensitivity.length > 0);
    // Task A should have higher correlation (wider range + upstream)
    assert.equal(result.sensitivity[0].id, 'a');
    assert.ok(Math.abs(result.sensitivity[0].correlation) > 0);
  });

  it('sensitivity can be disabled', () => {
    const tasks = [{ id: 'a', pert: { o: 3, m: 5, p: 10 } }];
    const result = mc.monteCarlo(tasks, defaultCal, '2026-03-16', { iterations: 100, seed: 42, sensitivity: false });
    assert.equal(result.sensitivity, null);
  });

  it('sensitivity sorted by |correlation| descending', () => {
    const tasks = [
      { id: 'a', pert: { o: 1, m: 2, p: 3 } },
      { id: 'b', pert: { o: 5, m: 10, p: 30 }, depends: ['a'] },
    ];
    const result = mc.monteCarlo(tasks, defaultCal, '2026-03-16', { iterations: 500, seed: 42 });
    for (let i = 1; i < result.sensitivity.length; i++) {
      assert.ok(Math.abs(result.sensitivity[i - 1].correlation) >= Math.abs(result.sensitivity[i].correlation));
    }
  });
});

// ── compress ──

describe('compress', () => {
  it('returns original when budget exceeds total', () => {
    const profile = { a: [2, 4, 6], b: [1, 3, 5] };
    const r = analysis.compress(profile, 100);
    assert.equal(r.alpha, 1);
    assert.equal(r.feasible, true);
    assert.deepStrictEqual(r.profile.a, [2, 4, 6]);
  });

  it('compresses to fit budget', () => {
    const profile = { a: [2, 4, 8], b: [1, 3, 7] };
    // original: a=4.33 + b=3.33 = 7.67
    const r = analysis.compress(profile, 5);
    assert.ok(r.compressed <= 5.1);
    assert.ok(r.alpha < 1);
    assert.ok(r.feasible);
    // o values preserved
    assert.equal(r.profile.a[0], 2);
    assert.equal(r.profile.b[0], 1);
    // m and p compressed toward o
    assert.ok(r.profile.a[1] <= 4);
    assert.ok(r.profile.a[2] <= 8);
  });

  it('reports infeasible when floor exceeds budget', () => {
    const profile = { a: [5, 8, 12], b: [4, 6, 10] };
    // floor = 5 + 4 = 9
    const r = analysis.compress(profile, 7);
    assert.equal(r.feasible, false);
    assert.equal(r.alpha, 0);
  });

  it('respects fixed tasks', () => {
    const profile = { a: [2, 4, 6], b: [1, 3, 5] };
    const r = analysis.compress(profile, 5, { fixed: ['a'] });
    // a should be unchanged
    assert.deepStrictEqual(r.profile.a, [2, 4, 6]);
    // b should be compressed
    assert.ok(r.profile.b[1] < 3);
  });

  it('works with task array input', () => {
    const tasks = [
      { id: 'x', pert: { o: 2, m: 5, p: 10 } },
      { id: 'y', pert: { o: 3, m: 6, p: 12 }, depends: ['x'] },
    ];
    const r = analysis.compress(tasks, 8);
    assert.ok(r.compressed <= 8.1);
    assert.ok(r.profile.x);
    assert.ok(r.profile.y);
  });
});

// ── holidays-br ──

const br = await import('../ext/plan/src/holidays-br.js');

describe('brazilHolidays', () => {
  it('returns 13 federal holidays', () => {
    const fed = br.federalHolidays(2026);
    assert.equal(fed.length, 13);
    assert.ok(fed.some(h => h.label === 'Natal'));
    assert.ok(fed.some(h => h.label.startsWith('Carnaval')));
  });

  it('computes Easter-dependent dates correctly for 2026', () => {
    const hols = br.brazilHolidays(2026);
    // Easter 2026 = April 5
    assert.ok(hols.some(h => h.date === '2026-02-16' && h.label.includes('Carnaval')));
    assert.ok(hols.some(h => h.date === '2026-04-03' && h.label.includes('Sexta')));
    assert.ok(hols.some(h => h.date === '2026-06-04' && h.label === 'Corpus Christi'));
  });

  it('includes state and municipal holidays', () => {
    const hols = br.brazilHolidays(2026, { municipality: 'parauapebas-pa' });
    assert.ok(hols.some(h => h.label === 'Adesão do Pará'));
    assert.ok(hols.some(h => h.label === 'Aniversário de Parauapebas'));
  });

  it('excludes carnival when disabled', () => {
    const hols = br.brazilHolidays(2026, { carnival: false });
    assert.ok(!hols.some(h => h.label.includes('Carnaval')));
  });

  it('includes optional periods when enabled', () => {
    const hols = br.brazilHolidays(2026, { optional: true });
    assert.ok(hols.some(h => h.label.includes('Cinzas')));
  });

  it('brazilCalendar returns multi-year calendar object', () => {
    const cal = br.brazilCalendar(2026, 2027);
    assert.ok(cal.holidays.length > 20);
    assert.ok(cal.holidays.some(h => h.date.startsWith('2027')));
  });

  it('brazilMunicipalities lists all entries', () => {
    const munis = br.brazilMunicipalities();
    assert.ok(munis.length >= 29);
    assert.ok(munis.includes('parauapebas-pa'));
    assert.ok(munis.includes('sao paulo-sp'));
  });
});

// ── Format (.plan file) ──

const fmt = await import('../ext/plan/src/format.js');

describe('plan: format', () => {
  const samplePlan = {
    version: 1,
    title: 'Test Project',
    projectStart: '2026-03-16',
    calendar: {
      preset: null,
      weekends: [0, 6],
      holidays: [],
      blocked: [{ start: '2026-04-06', end: '2026-04-17', label: 'Vacation' }],
    },
    deadlines: [{ label: 'Phase 1', taskId: 'b', date: '2026-05-01' }],
    templates: [
      {
        id: 'tpl_test',
        name: 'Test Template',
        tasks: [
          { id: 'audit', name: 'DB Audit', o: '1', m: '2', p: '4', depends: '', resource: '' },
          { id: 'prep', name: 'Data Prep', o: '1', m: '1', p: '2', depends: 'audit', resource: '' },
        ],
      },
    ],
    tasks: [
      { id: 'a', name: 'Task A', group: 'G1', o: '2', m: '3', p: '5', depends: '', resource: '', progress: '' },
      { id: 'b', name: 'Task B', group: 'G1', o: '1', m: '2', p: '3', depends: 'a', resource: '', progress: '' },
    ],
    settings: { showFloat: true, pxPerDay: 12 },
  };

  it('parsePlan roundtrip', () => {
    const json = JSON.stringify(samplePlan);
    const project = fmt.parsePlan(json);
    assert.equal(project.title, 'Test Project');
    assert.equal(project.projectStart, '2026-03-16');
    assert.equal(project.tasks.length, 2);
    assert.equal(project.templates.length, 1);
    assert.equal(project.templates[0].tasks.length, 2);
    assert.equal(project.deadlines.length, 1);
    assert.equal(project.calendar.blocked.length, 1);
    assert.equal(project.settings.pxPerDay, 12);
  });

  it('parsePlan accepts object input', () => {
    const project = fmt.parsePlan(samplePlan);
    assert.equal(project.title, 'Test Project');
    assert.equal(project.tasks.length, 2);
  });

  it('parsePlan resolves calendar preset', () => {
    const project = fmt.parsePlan({
      projectStart: '2026-01-05',
      calendar: { preset: 'brazil-federal' },
      tasks: [{ id: 'a', name: 'Task', o: '1', m: '2', p: '3' }],
    });
    assert.ok(project.calendar.holidays.length > 10, 'should have federal holidays');
    assert.equal(project.calendarPreset, 'brazil-federal');
  });

  it('parsePlan resolves municipality preset', () => {
    const project = fmt.parsePlan({
      projectStart: '2026-01-05',
      calendar: { preset: 'belo horizonte-mg' },
      tasks: [],
    });
    assert.ok(project.calendar.holidays.length > 10, 'should have BH holidays');
  });

  it('serializePlan produces valid JSON', () => {
    const project = fmt.parsePlan(samplePlan);
    const json = fmt.serializePlan(project);
    const reparsed = JSON.parse(json);
    assert.equal(reparsed.title, 'Test Project');
    assert.equal(reparsed.tasks.length, 2);
    assert.equal(reparsed.templates.length, 1);
  });

  it('buildSchedulerTasks converts string fields to numeric', () => {
    const planTasks = [
      { id: 'a', name: 'T1', o: '2', m: '3', p: '5', depends: 'b, c', progress: '50' },
      { id: 'b', name: 'T2', m: '4', o: '', p: '' },
      { id: 'c', name: 'Milestone', o: '', m: '', p: '' },
      { id: '', name: 'Empty' },
    ];
    const tasks = fmt.buildSchedulerTasks(planTasks);
    assert.equal(tasks.length, 3, 'should skip empty id');
    assert.deepEqual(tasks[0].pert, { o: 2, m: 3, p: 5 });
    assert.deepEqual(tasks[0].depends, ['b', 'c']);
    assert.equal(tasks[0].progress, 0.5);
    assert.equal(tasks[1].duration, 4);
    assert.equal(tasks[2].milestone, true);
  });
});

describe('plan: template instancing', () => {
  const tpl = {
    id: 'tpl_1',
    name: 'Exploration',
    tasks: [
      { id: 'audit', name: 'DB Audit', o: '1', m: '2', p: '4', depends: '', resource: '' },
      { id: 'prep', name: 'Data Prep', o: '1', m: '1', p: '2', depends: 'audit', resource: 'geo' },
      { id: 'model', name: 'Modeling', o: '2', m: '3', p: '5', depends: 'prep', resource: '' },
    ],
  };

  it('instancePlanTemplate linked mode', () => {
    const tasks = fmt.instancePlanTemplate(tpl, 'a', 'Deposit A/Exploration', 'linked');
    assert.equal(tasks.length, 3);
    assert.equal(tasks[0].id, 'a_audit');
    assert.equal(tasks[0].group, 'Deposit A/Exploration');
    assert.equal(tasks[0]._tpl, 'tpl_1');
    assert.equal(tasks[0]._tplTask, 'audit');
    assert.equal(tasks[0]._tplPrefix, 'a');
    // Internal deps remapped
    assert.equal(tasks[1].depends, 'a_audit');
    assert.equal(tasks[2].depends, 'a_prep');
  });

  it('instancePlanTemplate detached mode', () => {
    const tasks = fmt.instancePlanTemplate(tpl, 'b', 'Deposit B', 'detached');
    assert.equal(tasks.length, 3);
    assert.equal(tasks[0]._tpl, undefined);
    assert.equal(tasks[1].depends, 'b_audit');
  });

  it('propagateTemplate syncs linked tasks', () => {
    const tasks = fmt.instancePlanTemplate(tpl, 'x', 'G', 'linked');
    // Modify template
    const modified = { ...tpl, tasks: tpl.tasks.map(t => ({ ...t })) };
    modified.tasks[0].name = 'Updated Audit';
    modified.tasks[0].o = '2';
    fmt.propagateTemplate(modified, tasks);
    assert.equal(tasks[0].name, 'Updated Audit');
    assert.equal(tasks[0].o, '2');
  });

  it('propagateTemplate unlinks deleted template tasks', () => {
    const tasks = fmt.instancePlanTemplate(tpl, 'y', 'G', 'linked');
    // Template with one task removed
    const modified = { id: 'tpl_1', name: 'Exploration', tasks: [tpl.tasks[0]] };
    fmt.propagateTemplate(modified, tasks);
    // First task still linked
    assert.ok(fmt.isLinkedPlanTask(tasks[0]));
    // Others unlinked (template task gone)
    assert.ok(!fmt.isLinkedPlanTask(tasks[1]));
    assert.ok(!fmt.isLinkedPlanTask(tasks[2]));
  });

  it('unlinkPlanTask removes template metadata', () => {
    const tasks = fmt.instancePlanTemplate(tpl, 'z', 'G', 'linked');
    assert.ok(fmt.isLinkedPlanTask(tasks[0]));
    fmt.unlinkPlanTask(tasks[0]);
    assert.ok(!fmt.isLinkedPlanTask(tasks[0]));
    // Values preserved
    assert.equal(tasks[0].name, 'DB Audit');
    assert.equal(tasks[0].o, '1');
  });
});

describe('plan: resolveCalendarPreset', () => {
  it('resolves brazil-federal', () => {
    const holidays = fmt.resolveCalendarPreset('brazil-federal', 2026, 2027);
    assert.ok(holidays.length > 10);
    assert.ok(holidays.some(h => h.label.includes('Natal')));
  });

  it('resolves municipality preset', () => {
    const holidays = fmt.resolveCalendarPreset('parauapebas-pa', 2026, 2027);
    assert.ok(holidays.length > 10);
  });

  it('returns empty for null preset', () => {
    const holidays = fmt.resolveCalendarPreset(null, 2026, 2027);
    assert.deepEqual(holidays, []);
  });
});
