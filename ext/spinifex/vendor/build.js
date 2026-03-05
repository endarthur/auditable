#!/usr/bin/env node
// Builds OL + proj4 vendor bundle for spinifex
// Usage: cd ext/spinifex && npm install && node vendor/build.js

import { rollup } from 'rollup';
import resolve from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, statSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const spxDir = dirname(__dirname);

async function build() {
  const bundle = await rollup({
    input: join(__dirname, 'entry.mjs'),
    plugins: [
      resolve(),
      terser({
        compress: { passes: 2 },
        mangle: {
          reserved: ['ol', 'proj4'],
        },
      }),
    ],
  });

  const outFile = join(__dirname, 'ol.min.js');
  await bundle.write({
    file: outFile,
    format: 'es',
  });

  await bundle.close();

  // Read the bundled output and strip export statement
  // This leaves `const ol = {...}` and `proj4` as bare declarations in scope
  let code = readFileSync(outFile, 'utf8');
  code = code.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');

  // Read OL CSS from node_modules and embed as a constant
  const cssPath = join(spxDir, 'node_modules', 'ol', 'ol.css');
  const css = readFileSync(cssPath, 'utf8')
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');

  code += `\nconst _OL_CSS = \`${css}\`;\n`;
  code += `(function(){if(document.querySelector('style[data-ol]'))return;const s=document.createElement('style');s.dataset.ol='';s.textContent=_OL_CSS;document.head.appendChild(s)})();\n`;

  writeFileSync(outFile, code);

  const size = statSync(outFile).size;
  console.log(`Built vendor/ol.min.js (${(size / 1024).toFixed(1)} KB)`);
}

build().catch(err => {
  console.error(err);
  process.exit(1);
});
