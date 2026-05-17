// Headless .ipynb runner.
//
// Takes a Jupyter notebook path, applies the @gcu/ipynb import-rewrite
// (numpy → natra, scipy → scitra, sklearn → learn, matplotlib.pyplot →
// plt), then runs each code cell through adder's pythonExecute and
// reports pass/fail per cell. Lets us iterate on ipynb-compat gaps
// from node without round-tripping through a browser.
//
// Usage:
//   node test/run-ipynb.mjs path/to/notebook.ipynb
//   node test/run-ipynb.mjs path/to/notebook.ipynb --verbose
//
// Output shape (per cell):
//   ✓ cell 3 (12 lines)               — ran cleanly
//   ✗ cell 5 (4 lines)                — failed with one line of error
//      RuntimeError: 'object' has no attribute 'foo'
//   ⊘ cell 6 (md)                     — skipped (not code)
//
// Cells run in order and share scope — same as the notebook would.
// On failure, subsequent cells still run (with possibly-broken upstream
// state) so we see all distinct failures, not just the first.

import { readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';

// ── Argv ──
const args = process.argv.slice(2);
const verbose = args.includes('--verbose') || args.includes('-v');
const failFast = args.includes('--fail-fast');
const lenientImports = args.includes('--lenient-imports');
const filtered = args.filter(a => !a.startsWith('-'));
const nbPath = filtered[0];
if (!nbPath) {
  console.error('Usage: node test/run-ipynb.mjs <notebook.ipynb> [--verbose] [--fail-fast] [--lenient-imports]');
  process.exit(2);
}

// --lenient-imports: wrap each single-line `import X` / `from X import Y`
// statement in `try: ... except (ImportError, ModuleNotFoundError): pass`
// so a single missing dep doesn't kill the whole cell. Helps survey
// real-world notebooks where one of N imports is unavailable. Later
// code that uses the missing module fails with NameError — still a
// clear error. Multi-line imports with parens are left alone.
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

// ── Browser-shaped global shims (matches our test harness pattern) ──
// Includes a no-op CanvasRenderingContext2D stub so @gcu/plot's render
// calls don't blow up under node. We don't validate visual output here
// — the runner is for API-surface gaps. Browser-side visual check still
// required for plot correctness.
function _stubCanvasCtx() {
  const noop = () => {};
  const ctx = {
    canvas: null,
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
    globalAlpha: 1, globalCompositeOperation: 'source-over',
    save: noop, restore: noop, beginPath: noop, closePath: noop,
    moveTo: noop, lineTo: noop, arc: noop, arcTo: noop, rect: noop, ellipse: noop,
    fill: noop, stroke: noop, fillRect: noop, strokeRect: noop, clearRect: noop,
    fillText: noop, strokeText: noop, drawImage: noop,
    measureText: () => ({ width: 0 }),
    setLineDash: noop, getLineDash: () => [],
    translate: noop, rotate: noop, scale: noop, transform: noop, setTransform: noop, resetTransform: noop,
    clip: noop, isPointInPath: () => false, isPointInStroke: () => false,
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => null,
    createImageData: () => ({ data: new Uint8ClampedArray(0), width: 0, height: 0 }),
    getImageData: () => ({ data: new Uint8ClampedArray(0), width: 0, height: 0 }),
    putImageData: noop,
    quadraticCurveTo: noop, bezierCurveTo: noop,
  };
  return ctx;
}
globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: (tag) => {
    const el = {
      tagName: tag.toUpperCase(), className: '', dataset: {}, style: {},
      innerHTML: '', textContent: '', children: [],
      src: '', width: 0, height: 0, alt: '',
      appendChild(c) { this.children.push(c); return c; },
      remove() {},
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    };
    if (tag.toLowerCase() === 'canvas') {
      const ctx = _stubCanvasCtx();
      ctx.canvas = el;
      el.getContext = () => ctx;
      el.toDataURL = () => 'data:image/png;base64,';
      el.toBlob = (cb) => cb(null);
    }
    return el;
  },
  createTreeWalker: () => ({ nextNode: () => null, currentNode: null }),
};
globalThis.window = globalThis;
globalThis.CSS = { escape: s => s };
window._importCache = {};

// ── VFS — adder needs window._notebookVFS / window._vfsPath wired in
// order to register `os`, `os.path`, `pathlib`, `shutil`, `glob`. The
// sandbox does this in globals.js; replicate here so `import os` works
// in headless notebooks.
const { VFS, MemoryBackend, path: vfsPath } = await import('../ext/vfs/index.js');
const _notebookVFS = new VFS();
_notebookVFS._mounts.set('/home/nb', new MemoryBackend());
_notebookVFS._mounts.set('/var', new MemoryBackend());
_notebookVFS._mounts.set('/tmp', new MemoryBackend());
_notebookVFS._mounts.set('/usr/lib/python', new MemoryBackend());
window._notebookVFS = _notebookVFS;
window._vfsPath = vfsPath;

// ── Load adapters in the same order the sandbox does ──
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

// ── Parse the notebook + rewrite imports ──
const raw = readFileSync(resolve(nbPath), 'utf8');
const { cells, warnings, rewrites } = importNotebook(raw);

const name = basename(nbPath);
console.log(`\n== ${name} ==`);
console.log(`${cells.length} cells (${cells.filter(c => c.type === 'adder').length} code, ${cells.filter(c => c.type === 'md').length} markdown)`);
if (rewrites.length) {
  console.log(`${rewrites.length} import rewrite${rewrites.length === 1 ? '' : 's'}`);
  if (verbose) for (const r of rewrites) console.log(`  ${r}`);
}
if (warnings.length) {
  console.log(`${warnings.length} import warning${warnings.length === 1 ? '' : 's'}`);
  if (verbose) for (const w of warnings) console.log(`  ${w}`);
}
console.log('');

// ── Run cells in order ──
// Adder execCellHooks expect a `cell._ctx` shape so display/print work.
// Provide a minimal one that captures output to console.
function makeCellCtx(cellIdx) {
  const output = [];
  return {
    output,
    display(...args) { for (const a of args) output.push(_repr(a)); },
    outputEl: { innerHTML: '' },
  };
}

function _repr(v) {
  if (v == null) return String(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && typeof v._repr_html_ === 'function') return '<rich-html>';
  if (typeof v === 'object' && typeof v.nodeType === 'number') return `<${v.tagName?.toLowerCase() || 'node'}>`;
  if (typeof v === 'object') {
    try { return JSON.stringify(v).slice(0, 200); }
    catch { return String(v); }
  }
  return String(v);
}

let scope = {};
let pass = 0, fail = 0, skip = 0;
const failures = [];

for (let i = 0; i < cells.length; i++) {
  const c = cells[i];
  const lines = (c.code || '').split('\n').length;

  if (c.type !== 'adder') {
    console.log(`⊘ cell ${i + 1} (${c.type})`);
    skip++;
    continue;
  }

  const cell = { id: `c${i + 1}`, _ctx: makeCellCtx(i + 1) };
  try {
    const src = lenientImports ? _lenientWrapImports(c.code) : c.code;
    const result = await pythonExecute(src, scope, cell);
    // Merge defines into scope so downstream cells see them.
    if (result?.defines) Object.assign(scope, result.defines);
    const outLine = cell._ctx.output.length
      ? `   (${cell._ctx.output.length} display call${cell._ctx.output.length === 1 ? '' : 's'})`
      : '';
    console.log(`✓ cell ${i + 1} (${lines} line${lines === 1 ? '' : 's'})${outLine}`);
    pass++;
  } catch (e) {
    const errLine = String(e.message || e).split('\n')[0];
    console.log(`✗ cell ${i + 1} (${lines} line${lines === 1 ? '' : 's'})`);
    console.log(`   ${errLine}`);
    failures.push({ cellIdx: i + 1, error: errLine, code: c.code });
    fail++;
    if (failFast) break;
  }
}

// ── Summary ──
console.log('');
console.log(`pass: ${pass}    fail: ${fail}    skipped: ${skip}`);

if (failures.length) {
  console.log('\n— Failures —');
  for (const f of failures) {
    console.log(`\ncell ${f.cellIdx}: ${f.error}`);
    if (verbose) {
      console.log('  source:');
      for (const line of f.code.split('\n').slice(0, 20)) {
        console.log('    ' + line);
      }
    }
  }
}

process.exit(fail > 0 ? 1 : 0);
