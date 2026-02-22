#!/usr/bin/env node
// Generates all example notebooks from auditable.html + lightweight JSON definitions.
// Usage: node gen_examples.js
//
// Each example is a lightweight notebook JSON file in examples/defs/.
// Module refs can be file paths (resolved relative to project root at build time).
// To add a new example, create a .json def and add its filename below.

const fs = require('fs');
const path = require('path');
const makeExample = require('./make_example');

const defsDir = path.join(__dirname, 'examples', 'defs');
const outDir = path.join(__dirname, 'examples');

const defs = [
  'example_workshop.json',
  'example_life.json',
  'example_lorenz.json',
  'example_mandelbrot.json',
  'example_stereonet.json',
  'example_synth.json',
  'example_particles.json',
  'example_idw.json',
  'example_dashboard.json',
  'example_modules.json',
  'example_python.json',
  'example_sql.json',
  'example_shader.json',
];

// ── Generate ──
console.log('Generating examples from auditable.html:');
for (const defFile of defs) {
  const notebook = JSON.parse(fs.readFileSync(path.join(defsDir, defFile), 'utf8'));

  // resolve module file-path refs → inline source
  let modules;
  if (notebook.modules) {
    modules = {};
    for (const [url, entry] of Object.entries(notebook.modules)) {
      const refPath = path.join(__dirname, entry.ref);
      const source = fs.readFileSync(refPath, 'utf8');
      modules[url] = { source, cellId: entry.cellId ?? null };
    }
  }

  const htmlFile = defFile.replace(/\.json$/, '.html');
  makeExample({
    title: notebook.title,
    cells: notebook.cells,
    settings: notebook.settings || { theme: 'dark', fontSize: 13, width: '860' },
    modules,
    outPath: path.join(outDir, htmlFile),
  });
}
console.log(`Done \u2014 ${defs.length} examples generated.`);
