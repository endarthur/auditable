// Bulk-run a directory of .ipynb files through the headless runner and
// report pass-rate stats. Useful for sizing the ipynb-compat surface
// against real notebook corpora (Pyrcz's PythonNumericalDemos, etc.).
//
// Usage:
//   node test/sweep-ipynb.mjs <dir>
//   node test/sweep-ipynb.mjs <dir> --filter=DataBasics    # substring match
//   node test/sweep-ipynb.mjs <dir> --top-errors=20        # group + count
//
// Reuses run-ipynb.mjs's adapter setup. Each notebook gets a fresh
// scope (no cross-notebook bleed). Per-notebook timeout caps long runs.

import { readdirSync, readFileSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';

const args = process.argv.slice(2);
const dirArg = args.find(a => !a.startsWith('-'));
const filter = (args.find(a => a.startsWith('--filter=')) || '').slice(9);
const skipInteractive = !args.includes('--include-interactive');
const lenientImports = args.includes('--lenient-imports');
// Pyrcz uses his own `geostatspy` package heavily — we don't ship it,
// so these notebooks are blocked at line 1 regardless. Skipped by
// default to keep the signal honest; pass --include-geostatspy to count
// them anyway.
const skipGeostatspy = !args.includes('--include-geostatspy');
const topErrorsArg = (args.find(a => a.startsWith('--top-errors=')) || '--top-errors=15').slice(13);
const TOP_ERRORS = Number(topErrorsArg) || 15;
const PER_NOTEBOOK_TIMEOUT_MS = 30_000;

if (!dirArg) {
  console.error('Usage: node test/sweep-ipynb.mjs <dir> [--filter=substr] [--top-errors=N] [--include-interactive] [--lenient-imports] [--include-geostatspy]');
  process.exit(2);
}

function _lenientWrapImports(code) {
  const lines = code.split('\n');
  const out = [];
  for (const line of lines) {
    const stripped = line.replace(/^\s+/, '');
    const indent = line.slice(0, line.length - stripped.length);
    if (/^(import\s|from\s+\S+\s+import\s)/.test(stripped)
        && !stripped.includes('(')) {
      out.push(`${indent}try:`);
      out.push(`${indent}    ${stripped}`);
      out.push(`${indent}except (ImportError, ModuleNotFoundError):`);
      out.push(`${indent}    pass`);
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}

// ── DOM shim + VFS + adapters (shared across all notebook runs) ──
import { installDomShim } from './helpers/dom-shim.mjs';
installDomShim();

const { VFS, MemoryBackend, path: vfsPath } = await import('../ext/vfs/index.js');
const _vfs = new VFS();
_vfs._mounts.set('/projects/self', new MemoryBackend());
_vfs._mounts.set('/lib', new MemoryBackend());
_vfs._mounts.set('/tmp', new MemoryBackend());
_vfs._mounts.set('/usr/lib/python', new MemoryBackend());
window._notebookVFS = _vfs;
window._vfsPath = vfsPath;
window._importCache = window._importCache || {};

const _natra = await import('../ext/natra/index.js');
window._importCache['../ext/natra/index.js'] = _natra;
await import('../ext/natra/adder.js');
const _scitra = await import('../ext/scitra/index.js');
window._importCache['@gcu/scitra'] = _scitra;
await import('../ext/scitra/adder.js');
await import('../ext/plot/index.js');
await import('../ext/sadpan/index.js');
const _learn = await import('../ext/learn/index.js');
window._importCache['@gcu/learn'] = _learn;
await import('../ext/learn/adder.js');
await import('../ext/ipython-adapter/adder.js');

const { importNotebook } = await import('../ext/ipynb/index.js');
const { pythonExecute } = await import('../ext/adder/src/cell.js');

// ── Per-notebook runner ──

function makeCellCtx() {
  return {
    output: [],
    display() {},
    outputEl: { innerHTML: '' },
  };
}

async function runNotebook(path) {
  const raw = readFileSync(path, 'utf8');
  let parsed;
  try {
    parsed = importNotebook(raw);
  } catch (e) {
    return { error: 'parse: ' + e.message, codeCells: 0, pass: 0, fail: 0, failures: [] };
  }
  const cells = parsed.cells;
  const codeCells = cells.filter(c => c.type === 'adder').length;

  if (skipGeostatspy) {
    const usesGeostatspy = cells.some(c =>
      c.type === 'adder' && /\bgeostatspy\b/.test(c.code || ''));
    if (usesGeostatspy) {
      return { codeCells, pass: 0, fail: 0, failures: [], skipped: 'geostatspy' };
    }
  }

  let scope = {};
  let pass = 0, fail = 0;
  const failures = [];

  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (c.type !== 'adder') continue;
    const cell = { id: `c${i + 1}`, _ctx: makeCellCtx() };
    try {
      const src = lenientImports ? _lenientWrapImports(c.code) : c.code;
      const result = await Promise.race([
        pythonExecute(src, scope, cell),
        new Promise((_, rej) => setTimeout(
          () => rej(new Error('timeout')),
          PER_NOTEBOOK_TIMEOUT_MS,
        )),
      ]);
      if (result?.defines) Object.assign(scope, result.defines);
      pass++;
    } catch (e) {
      const msg = String(e.message || e).split('\n')[0];
      failures.push({ cellIdx: i + 1, error: msg });
      fail++;
    }
  }
  return { codeCells, pass, fail, failures };
}

// ── Sweep ──

const root = resolve(dirArg);
let files = readdirSync(root).filter(f => f.endsWith('.ipynb'));
if (skipInteractive) files = files.filter(f => !f.startsWith('Interactive_'));
if (filter) files = files.filter(f => f.includes(filter));
files.sort();

console.log(`Sweeping ${files.length} notebooks in ${root}\n`);

const errorBuckets = new Map();   // first-line error → { count, examples: [notebook, cell] }
const perNotebook = [];

const startTime = Date.now();
for (let i = 0; i < files.length; i++) {
  const fn = files[i];
  const start = Date.now();
  let result;
  try {
    result = await runNotebook(join(root, fn));
  } catch (e) {
    result = { error: e.message };
  }
  const dt = Date.now() - start;

  if (result.error) {
    console.log(`[${i + 1}/${files.length}] ✗ ${fn} — ${result.error} (${dt}ms)`);
    perNotebook.push({ fn, pass: 0, fail: 1, codeCells: 0, dt, error: result.error });
    continue;
  }
  if (result.skipped) {
    console.log(`[${i + 1}/${files.length}] ⊘ ${fn} — skipped (${result.skipped})`);
    perNotebook.push({ fn, ...result, dt });
    continue;
  }

  const pct = result.codeCells > 0
    ? Math.round(100 * result.pass / result.codeCells)
    : 100;
  const icon = pct === 100 ? '✓' : pct >= 80 ? '~' : pct >= 50 ? '!' : '✗';
  console.log(`[${i + 1}/${files.length}] ${icon} ${fn}: ${result.pass}/${result.codeCells} cells (${pct}%) (${dt}ms)`);
  perNotebook.push({ fn, ...result, dt });

  for (const f of result.failures) {
    if (!errorBuckets.has(f.error)) {
      errorBuckets.set(f.error, { count: 0, examples: [] });
    }
    const b = errorBuckets.get(f.error);
    b.count++;
    if (b.examples.length < 3) b.examples.push(`${fn}:cell${f.cellIdx}`);
  }
}

const totalDt = Date.now() - startTime;

// ── Summary ──
console.log('\n========== summary ==========');
console.log(`notebooks: ${perNotebook.length}, total time: ${(totalDt / 1000).toFixed(1)}s`);

const considered = perNotebook.filter(n => !n.skipped);
const fullPass = considered.filter(n => n.codeCells > 0 && n.pass === n.codeCells).length;
const partial = considered.filter(n => n.pass > 0 && n.pass < n.codeCells).length;
const zero = considered.filter(n => n.codeCells > 0 && n.pass === 0).length;
const empty = considered.filter(n => n.codeCells === 0).length;
const skipped = perNotebook.filter(n => n.skipped).length;

console.log(`considered: ${considered.length} (skipped: ${skipped})`);
console.log(`fully passing (${fullPass}/${considered.length}): all code cells run`);
console.log(`partially passing (${partial}): some cells fail`);
console.log(`zero passing (${zero}): every code cell fails`);
if (empty) console.log(`empty (${empty}): no code cells`);

const totalCells = considered.reduce((s, n) => s + (n.codeCells || 0), 0);
const totalPass = considered.reduce((s, n) => s + (n.pass || 0), 0);
console.log(`\nper-cell pass rate: ${totalPass}/${totalCells} = ${(100 * totalPass / Math.max(1, totalCells)).toFixed(1)}%`);

// Top errors
if (errorBuckets.size > 0) {
  console.log(`\n— top ${TOP_ERRORS} errors —`);
  const sorted = [...errorBuckets.entries()].sort(([, a], [, b]) => b.count - a.count);
  for (const [msg, info] of sorted.slice(0, TOP_ERRORS)) {
    console.log(`\n  [${info.count}×] ${msg}`);
    for (const ex of info.examples) console.log(`     ${ex}`);
  }
}
