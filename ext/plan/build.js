#!/usr/bin/env node
// Bundle ext/plan/src/ into ext/plan/index.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, 'src');

const files = [
  'calendar.js', 'pert.js', 'graph.js', 'schedule.js',
  'resource.js', 'scurve.js', 'evm.js', 'analysis.js',
  'workflow.js', 'montecarlo.js', 'render.js', 'xlsx.js',
];

const chunks = [];
for (const file of files) {
  let src = fs.readFileSync(path.join(srcDir, file), 'utf8');
  src = src.replace(/^import\s+.*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^import\s*\{[^}]*\}\s*from\s*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  src = src.replace(/^export function /gm, 'function ');
  src = src.replace(/^export async function /gm, 'async function ');
  src = src.replace(/^export const /gm, 'const ');
  src = src.replace(/^export let /gm, 'let ');
  src = src.replace(/^export class /gm, 'class ');
  src = src.replace(/^\n+/, '').replace(/\n+$/, '');
  chunks.push(`// -- ${file} --\n\n${src}`);
}

const header = `// @gcu/plan — Project management primitives for Auditable notebooks
// Auto-generated from ext/plan/src/ — do not edit directly
`;

const footer = `
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
  // analysis
  whatIf, delayImpact, nearCritical, slackBudget, scopeDrift, bufferStatus,
  busFactor, switchingOverhead, meetingCost, constraint,
  brooksLaw, littlesLaw, multiProjectFragmentation,
  burndown, health,
  // render
  gantt, scurvePlot, resourceHistogram, stageGateView, workflowDiagram, monteCarloPlot,
  tornadoPlot, burndownPlot,
  // xlsx
  planToXLSX,
};
`;

const output = header + '\n' + chunks.join('\n\n') + footer;
const outPath = path.join(__dirname, 'index.js');
fs.writeFileSync(outPath, output);
console.log(`Built ${outPath} (${(output.length / 1024).toFixed(1)} KB)`);
