#!/usr/bin/env node
// Builds acorn + acorn-typescript bundle for auditable
// Usage: node build.js

import { rollup } from 'rollup';
import resolve from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { statSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function build() {
  const bundle = await rollup({
    input: join(__dirname, 'entry.mjs'),
    plugins: [
      resolve(),
      terser({
        compress: { passes: 2 },
        mangle: true,
      }),
    ],
  });

  // IIFE for browser (loaded by auditable.html boot)
  const iifeFile = join(__dirname, 'acorn.min.js');
  await bundle.write({
    file: iifeFile,
    format: 'iife',
    name: 'Acorn',
    exports: 'named',
  });

  // ESM for import by ext/air/ modules and tests
  const esmFile = join(__dirname, 'acorn.esm.min.js');
  await bundle.write({
    file: esmFile,
    format: 'es',
  });

  const iifeSize = statSync(iifeFile).size;
  const esmSize = statSync(esmFile).size;
  console.log(`acorn.min.js (IIFE): ${(iifeSize / 1024).toFixed(1)} KB`);
  console.log(`acorn.esm.min.js (ESM): ${(esmSize / 1024).toFixed(1)} KB`);
}

build().catch(err => { console.error(err); process.exit(1); });
