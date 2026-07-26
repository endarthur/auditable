#!/usr/bin/env node
// Bundle the anywidget ESM into the Python package's static/ dir. The engine
// rides along INLINE (the built ../core.js — the engine-only bundle, no I/O
// layer), so the widget ships as one self-contained module: nothing is fetched
// at runtime, which is what makes it usable on an air-gapped analysis box.
import { appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { bundle } from '../../build/src/main.js';

const OUT = 'gcu_condenser/static/widget.js';
const HERE = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(HERE, 'gcu_condenser/static'), { recursive: true });
const r = await bundle({
  at: import.meta.url,
  entry: 'src/widget.js',
  outFile: OUT,
  inline: ['../core.js', '../../drillhole/src/samples.js', '../../drillhole/src/desurvey.js', '../../drillhole/src/validate.js'],
  sourcemap: false,
  meta: false,
});

// anywidget loads the module and reads its DEFAULT export; @gcu/build emits
// named exports only (§ rename-on-collision needs names). One appended line
// bridges the two contracts — no source-level exception in the bundler.
const path = join(HERE, OUT);
appendFileSync(path, '\nexport default { render };\n');
console.log(`Built ext/condenser/anywidget/${OUT} (${((r.code.length + 30) / 1024).toFixed(1)} KB)`);
