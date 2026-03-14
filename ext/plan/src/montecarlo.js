// Monte Carlo schedule simulation with seedable PRNG

import { addWorkingDays, nextWorkingDay, _parseDate } from './calendar.js';
import { topoSort, _taskMap, _buildAdj } from './graph.js';

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

export { monteCarlo, createRng, samplePert };
