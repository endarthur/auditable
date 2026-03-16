# @plan

Project management library for auditable notebooks. CPM scheduling, PERT estimation, Monte Carlo simulation, earned value management, and analysis functions.

## usage

```js
const plan = await load("@plan");
```

## modules

| File | Description |
|------|-------------|
| `calendar.js` | Working day calculations, holidays, blocked periods |
| `pert.js` | PERT three-point estimation |
| `graph.js` | Topological sort, cycle detection, predecessors/successors |
| `schedule.js` | CPM forward/backward pass, critical path, float |
| `resource.js` | Resource conflict detection, leveling |
| `scurve.js` | S-curve generation (planned/actual/forecast) |
| `evm.js` | Earned value management (BAC, EV, PV, AC, SPI, CPI) |
| `analysis.js` | 16 analysis functions (see below) |
| `workflow.js` | Workflow templates, stage gates, throughput |
| `montecarlo.js` | Monte Carlo simulation with sensitivity tracking |
| `render.js` | SVG renderers (Gantt, S-curve, histogram, tornado, etc.) |
| `xlsx.js` | Excel export |
| `holidays-br.js` | Brazilian holidays (federal, state, municipal) |

## analysis functions

- **Schedule**: whatIf, delayImpact, nearCritical, slackBudget, scopeDrift, bufferStatus
- **Resource**: busFactor, switchingOverhead, meetingCost, constraint
- **Math models**: brooksLaw, littlesLaw, multiProjectFragmentation
- **Progress**: burndown, health, compress

## renderers

gantt, scurvePlot, resourceHistogram, stageGateView, workflowDiagram, monteCarloPlot, deadlineRiskPlot, tornadoPlot, burndownPlot

## brazilian holidays

```js
// Federal + state + municipal
const cal = plan.brazilCalendar(2026, 2027, { municipality: "belo horizonte-MG" });
cal.blocked = [{ start: "2026-04-06", end: "2026-04-17", label: "Vacation" }];

// Options: carnival, corpusChristi, optional (pontos facultativos)
plan.brazilMunicipalities(); // list available municipalities
```

Covers all 27 state capitals + Parauapebas, Canaa dos Carajas, Maraba (PA).

## build

```
node ext/plan/build.js
```

Concatenates `src/*.js` into `index.js`, stripping ES module syntax.

## roadmap

### rework duration scaling

Current rework transitions in Monte Carlo re-run tasks at full PERT duration. In practice, rework is faster than the original pass (data exists, parameters are tuned, downstream artifacts just need updating). Enhancement:

```js
reworkTransitions: [{
  from: "validation", to: "estimation",
  probability: 0.3,
  durationScale: { estimation: 0.4, validation: 0.5 }
}]
```

`durationScale` would multiply the sampled PERT duration on rework iterations, per task. Tasks not listed default to 1.0 (or a configurable `defaultReworkScale`). This models the reality that re-estimation after a validation failure takes ~40% of original time, not 100%.

### not yet implemented (need historical data)

darkTime, gateMetrics, learningCurve, reworkAmplification, referenceClass, overheadRatio, outsourcingAnalysis, fragmentation, utilizationCurve — all require `completedInstances` / `stageHistory` data.
