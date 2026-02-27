#!/usr/bin/env node
// Builds CM6 bundle for auditable
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

  const outFile = join(__dirname, 'cm6.min.js');
  await bundle.write({
    file: outFile,
    format: 'iife',
    name: 'CM6',
  });

  await bundle.close();

  const size = statSync(outFile).size;
  console.log(`Built cm6.min.js (${(size / 1024).toFixed(1)} KB)`);
}

build().catch(err => {
  console.error(err);
  process.exit(1);
});
