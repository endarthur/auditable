#!/usr/bin/env node
// Generates all example notebooks from auditable.html + plain-text definitions.
// Usage: node gen_examples.js
//
// Each example is a .txt file in examples/defs/<category>/ using the /// comment format.
// See examples/defs/FORMAT.md for the format specification.
// To add a new example, create a .txt def and add it to the appropriate category below.

const fs = require('fs');
const path = require('path');
const makeExample = require('./make_example');

const defsDir = path.join(__dirname, 'examples', 'defs');
const outDir = path.join(__dirname, 'examples');

// ── Example categories ──
// Each key is a subfolder under examples/defs/.
// Add new examples to the appropriate category.
// Output HTML always goes to examples/ (flat).

const categories = {
  // basics — core auditable features: reactive DAG, widgets, modules, cells
  basics: [
    'example_workshop.txt',
    'example_life.txt',
    'example_lorenz.txt',
    'example_mandelbrot.txt',
    'example_particles.txt',
    'example_idw.txt',
    'example_dashboard.txt',
    'example_modules.txt',
    'example_python.txt',
    'example_widgets.txt',
    'example_dialog.txt',
    'example_app_export.txt',
    'example_md_interpolation.txt',
    'example_workers.txt',
    'example_notebook_fs.txt',
    'example_webmcp.txt',
    'example_plot.txt',
    'example_sadpan.txt',
    'example_unified_fs.txt',
    'example_units.txt',
    'example_sideact.txt',
  ],

  // atra — Wasm compiler: language features, kernels, natra
  atra: [
    'example_atra.txt',
    'example_atra_tour.txt',
    'example_atra_v_julia.txt',
    'example_atra_layouts.txt',
    'example_atra_multi_memory.txt',
    'example_atra_strings.txt',
    'example_natra.txt',
    'example_v8_vs_wasm.txt',
  ],

  // calque — spreadsheet language and sheet widget
  calque: [
    'example_calque.txt',
    'example_calque_advanced.txt',
    'example_sheet.txt',
  ],

  // gslib — geostatistics: kriging, simulation, linear algebra, grid
  gslib: [
    'example_grid.txt',
    'example_alpack.txt',
    'example_alpack_atra.txt',
    'example_gslib_kb2d.txt',
    'example_gslib_sgsim.txt',
    'example_gslib_dhsa.txt',
    'example_pairing.txt',
    'example_dee.txt',
    'example_dee_domains.txt',
  ],

  // gis — spatial analysis: maps, raster, hydrology
  gis: [
    'example_spinifex.txt',
    'example_raster.txt',
    'example_hydrology.txt',
  ],

  // geology — structural geology, petrology, stratigraphy
  geology: [
    'example_stereonet.txt',
    'example_winding.txt',
    'example_winding_3d.txt',
    'example_peel_3d.txt',
  ],

  // extensions — language tags and browser APIs
  extensions: [
    'example_sql.txt',
    'example_shader.txt',
    'example_vfs.txt',
    'example_soft.txt',
    'example_soft_ptbr.txt',
    'example_air_ir.txt',
  ],

  // adder — Python interpreter: adder cells, adder/mpy tag, cross-language DAG
  adder: [
    'example_adder.txt',
    'example_adder_gslib.txt',
    'example_adder_estimation.txt',
    'example_adder_dhsa.txt',
    'example_adder_sadpan.txt',
    'example_adder_fs.txt',
    'example_adder_natra.txt',
    'example_adder_dee.txt',
  ],

  // etc — standalone demos that don't fit elsewhere
  etc: [
    'example_iso9660.txt',
    'example_plan.txt',
    'example_plan_analysis.txt',
    'example_plan_files.txt',
    'example_resource_estimation.txt',
    'example_synth.txt',
    'example_threejs.txt',
    'example_line.txt',
  ],
};

// ── Parser ──

// Extract named subroutines/functions from atra source.
// Each routine starts with `subroutine name(` or `function name(` and ends
// with a standalone `end` line (not `end if`, `end for`, etc.).
function extractRoutines(source, names) {
  const lines = source.split('\n');
  const results = [];
  for (const name of names) {
    const pattern = new RegExp(`^\\s*(?:subroutine|function)\\s+${name.replace('.', '\\.')}\\b`);
    let inside = false;
    let routine = [];
    for (const line of lines) {
      if (!inside && pattern.test(line)) {
        inside = true;
        routine = [line];
      } else if (inside) {
        routine.push(line);
        if (/^\s*end\s*$/.test(line)) {
          results.push(routine.join('\n'));
          inside = false;
          break;
        }
      }
    }
  }
  return results.join('\n\n');
}

function parseDef(text) {
  const lines = text.split('\n');
  let title = 'untitled';
  let settings = { theme: 'dark', fontSize: 13, width: '860' };
  const modules = {};
  const cells = [];
  let currentCell = null;

  for (const line of lines) {
    if (line.startsWith('/// ')) {
      const directive = line.slice(4);

      // include directive: insert file contents into current cell (no flush)
      if (directive.startsWith('include: ') && currentCell) {
        const parts = directive.slice(9).trim().split(/\s+/);
        const filePath = parts[0];
        const names = parts.slice(1);
        const content = fs.readFileSync(path.join(__dirname, filePath), 'utf8');
        const included = names.length > 0 ? extractRoutines(content, names) : content;
        currentCell.code += (currentCell.code ? '\n' : '') + included;
        continue;
      }

      // flush previous cell
      if (currentCell) {
        currentCell.code = trimCell(currentCell.code);
        cells.push(currentCell);
        currentCell = null;
      }

      if (directive === 'auditable') {
        // magic first line, skip
        continue;
      } else if (directive.startsWith('title: ')) {
        title = directive.slice(7);
      } else if (directive.startsWith('settings: ')) {
        settings = JSON.parse(directive.slice(10));
      } else if (directive.startsWith('module-binary: ')) {
        const parts = directive.slice(15).split(' ');
        const url = parts[0];
        const ref = parts.slice(1).join(' ');
        modules[url] = { ref, binary: true };
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

let total = 0;
console.log('Generating examples from auditable.html:\n');

for (const [category, defs] of Object.entries(categories)) {
  console.log(`  ${category}/`);
  for (const defFile of defs) {
    const text = fs.readFileSync(path.join(defsDir, category, defFile), 'utf8');
    const notebook = parseDef(text);

    // resolve module file-path refs → inline source (text or binary)
    let modules;
    if (Object.keys(notebook.modules).length > 0) {
      modules = {};
      for (const [url, entry] of Object.entries(notebook.modules)) {
        const refPath = path.join(__dirname, entry.ref);
        if (entry.binary) {
          // binary module: gzip-compress, base64-encode
          const raw = fs.readFileSync(refPath);
          const { execSync } = require('child_process');
          // use Node's zlib for sync gzip
          const zlib = require('zlib');
          const compressed = zlib.gzipSync(raw);
          const source = compressed.toString('base64');
          const ext = path.extname(refPath).slice(1);
          const mimeMap = { wasm: 'application/wasm', png: 'image/png', jpg: 'image/jpeg' };
          modules[url] = { source, cellId: null, binary: true, compressed: true, type: mimeMap[ext] || 'application/octet-stream' };
        } else {
          // text module: gzip-compress for smaller saved notebooks
          const zlib = require('zlib');
          const raw = fs.readFileSync(refPath, 'utf8');
          const compressed = zlib.gzipSync(Buffer.from(raw, 'utf8'));
          const source = compressed.toString('base64');
          modules[url] = { source, compressed: true, cellId: null };
        }
      }
    }

    const htmlFile = defFile.replace(/\.txt$/, '.html');
    const catOutDir = path.join(outDir, category);
    if (!fs.existsSync(catOutDir)) fs.mkdirSync(catOutDir, { recursive: true });
    makeExample({
      title: notebook.title,
      cells: notebook.cells,
      settings: notebook.settings,
      modules,
      outPath: path.join(catOutDir, htmlFile),
    });
    total++;
  }
}

// Copy companion files (.plan, etc.) from defs/ to output
for (const [category] of Object.entries(categories)) {
  const catDefsDir = path.join(defsDir, category);
  if (!fs.existsSync(catDefsDir)) continue;
  for (const f of fs.readdirSync(catDefsDir)) {
    if (f.endsWith('.plan')) {
      const src = path.join(catDefsDir, f);
      const dst = path.join(outDir, category, f);
      fs.copyFileSync(src, dst);
      console.log(`  ${category}/${f} (companion)`);
    }
  }
}

// ── Encrypted example (requires async crypto, runs as separate ESM script) ──

const { execSync } = require('child_process');
console.log('\n  basics/ (encrypted)');
try {
  const out = execSync('node make_encrypted_example.mjs', { cwd: __dirname, encoding: 'utf8', stdio: 'pipe' });
  process.stdout.write(out);
  total++;
} catch (e) {
  console.error('  FAILED: ' + (e.stderr || e.message));
}

console.log(`\nDone \u2014 ${total} examples generated.`);
