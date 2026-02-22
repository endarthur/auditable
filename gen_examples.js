#!/usr/bin/env node
// Generates all example notebooks from auditable.html + per-example definitions.
// Usage: node gen_examples.js
//
// Each example is defined in examples/defs/<name>.js.
// To add a new example, create a def file and add it to the list below.

const fs = require('fs');
const path = require('path');
const makeExample = require('./make_example');

const outDir = path.join(__dirname, 'examples');

const examples = [
  require('./examples/defs/workshop'),
  require('./examples/defs/life'),
  require('./examples/defs/lorenz'),
  require('./examples/defs/mandelbrot'),
  require('./examples/defs/stereonet'),
  require('./examples/defs/synth'),
  require('./examples/defs/particles'),
  require('./examples/defs/idw'),
  require('./examples/defs/dashboard'),
  require('./examples/defs/modules'),
  require('./examples/defs/python'),
  require('./examples/defs/sql'),
  require('./examples/defs/shader'),
];

// ── Generate ──
console.log('Generating examples from auditable.html:');
for (const ex of examples) {
  // build modules map if _buildModule is specified
  let modules = ex.modules || undefined;
  if (ex._buildModule) {
    const modPath = path.join(__dirname, ex._buildModule.path);
    const source = fs.readFileSync(modPath, 'utf8');
    modules = { [ex._buildModule.url]: { source, cellId: null } };
  }
  makeExample({
    title: ex.title,
    cells: ex.cells,
    settings: ex.settings || { theme: 'dark', fontSize: 13, width: '860' },
    modules,
    outPath: path.join(outDir, ex.file)
  });
}
console.log(`Done \u2014 ${examples.length} examples generated.`);
