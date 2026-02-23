#!/usr/bin/env node
// Generates all example notebooks from auditable.html + plain-text definitions.
// Usage: node gen_examples.js
//
// Each example is a .txt file in examples/defs/ using the /// comment format.
// See examples/defs/FORMAT.md for the format specification.
// To add a new example, create a .txt def and add its filename below.

const fs = require('fs');
const path = require('path');
const makeExample = require('./make_example');

const defsDir = path.join(__dirname, 'examples', 'defs');
const outDir = path.join(__dirname, 'examples');

const defs = [
  'example_workshop.txt',
  'example_life.txt',
  'example_lorenz.txt',
  'example_mandelbrot.txt',
  'example_stereonet.txt',
  'example_synth.txt',
  'example_particles.txt',
  'example_idw.txt',
  'example_dashboard.txt',
  'example_modules.txt',
  'example_python.txt',
  'example_sql.txt',
  'example_shader.txt',
];

// ── Parser ──

function parseDef(text) {
  const lines = text.split('\n');
  let title = 'untitled';
  let settings = { theme: 'dark', fontSize: 13, width: '860' };
  const modules = {};
  const cells = [];
  let currentCell = null;

  for (const line of lines) {
    if (line.startsWith('/// ')) {
      // flush previous cell
      if (currentCell) {
        currentCell.code = trimCell(currentCell.code);
        cells.push(currentCell);
        currentCell = null;
      }

      const directive = line.slice(4);

      if (directive === 'auditable') {
        // magic first line, skip
        continue;
      } else if (directive.startsWith('title: ')) {
        title = directive.slice(7);
      } else if (directive.startsWith('settings: ')) {
        settings = JSON.parse(directive.slice(10));
      } else if (directive.startsWith('module: ')) {
        const parts = directive.slice(8).split(' ');
        const url = parts[0];
        const ref = parts.slice(1).join(' ');
        modules[url] = { ref };
      } else {
        // cell type line: "code", "code collapsed", "md", "css", "html"
        const parts = directive.split(' ');
        const type = parts[0];
        const collapsed = parts.includes('collapsed');
        // key order: type, collapsed (if true), code
        currentCell = { type };
        if (collapsed) currentCell.collapsed = true;
        currentCell.code = '';
      }
    } else if (currentCell) {
      currentCell.code += (currentCell.code ? '\n' : '') + line;
    }
    // lines before any cell directive are ignored (blank lines between headers)
  }

  // flush last cell
  if (currentCell) {
    currentCell.code = trimCell(currentCell.code);
    cells.push(currentCell);
  }

  return { title, settings, modules, cells };
}

function trimCell(code) {
  // remove single leading/trailing blank line (allows visual spacing in def file)
  return code.replace(/^\n/, '').replace(/\n$/, '');
}

// ── Generate ──

console.log('Generating examples from auditable.html:');
for (const defFile of defs) {
  const text = fs.readFileSync(path.join(defsDir, defFile), 'utf8');
  const notebook = parseDef(text);

  // resolve module file-path refs → inline source
  let modules;
  if (Object.keys(notebook.modules).length > 0) {
    modules = {};
    for (const [url, entry] of Object.entries(notebook.modules)) {
      const refPath = path.join(__dirname, entry.ref);
      const source = fs.readFileSync(refPath, 'utf8');
      modules[url] = { source, cellId: null };
    }
  }

  const htmlFile = defFile.replace(/\.txt$/, '.html');
  makeExample({
    title: notebook.title,
    cells: notebook.cells,
    settings: notebook.settings,
    modules,
    outPath: path.join(outDir, htmlFile),
  });
}
console.log(`Done \u2014 ${defs.length} examples generated.`);
