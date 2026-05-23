#!/usr/bin/env node
// Bundle xterm.js + addon-fit into a single ESM module for the terminal
// surface. Pattern mirrors ext/cm6/build.js (rollup + terser); output is
// ESM so the surface can `import { Terminal, FitAddon } from '#xterm'`.
//
// xterm's CSS is copied alongside; build.js for --target=works picks it
// up and inlines it into the terminal-surface payload.

import { rollup } from 'rollup';
import resolve from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { statSync, copyFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');

async function build() {
  const bundle = await rollup({
    input: join(__dirname, 'entry.mjs'),
    plugins: [
      resolve(),
      terser({ compress: { passes: 2 }, mangle: true }),
    ],
  });

  const outFile = join(__dirname, 'index.js');
  await bundle.write({ file: outFile, format: 'esm' });
  await bundle.close();

  // Vendor the CSS too so the build doesn't reach into node_modules.
  copyFileSync(
    join(repoRoot, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'),
    join(__dirname, 'xterm.css'));

  const size = statSync(outFile).size;
  console.log(`Built ext/xterm/index.js (${(size / 1024).toFixed(1)} KB)`);
}

build().catch((err) => { console.error(err); process.exit(1); });
