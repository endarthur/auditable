#!/usr/bin/env node
// Bundle ext/mimic-io/src/ → ext/mimic-io/index.js (single-file ESM).
//
// Same concat-and-strip pattern @gcu/iso9660 / @gcu/dee use: read each
// module, strip its `import` and bare `export { … }` statements (keep
// `export function`/`export const`/etc. with the `export` removed), join
// with a header per module, append a single final export block.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, 'src');

// Order matters: each file may reference names from earlier files
// (registry.js's defaultRegistry is referenced from dump-load.js, etc.).
const modules = [
  'typed-array.js',
  'canonical.js',
  'registry.js',
  'v1-normalize.js',
  'dump-load.js',
];

let output = '// @gcu/mimic-io — bundled from src/\n';
output += '// SPDX-License-Identifier: MIT\n\n';

for (const mod of modules) {
  let src = readFileSync(join(srcDir, mod), 'utf8');
  // Strip side-effect-free import lines.
  src = src.replace(/^import\s+\{[^}]*\}\s+from\s+['"][^'"]+['"];?\s*$/gm, '');
  // Strip bare `export { … }` blocks (we provide a single one at the end).
  src = src.replace(/^export\s+\{[^}]*\};?\s*$/gm, '');
  // Convert `export X` into `X` for top-level declarations.
  src = src.replace(/^export\s+(function|async\s+function|const|let|var|class)\s/gm, '$1 ');
  output += `// ── ${mod} ──\n\n${src.trim()}\n\n`;
}

output += `// ── exports ──
export {
  dump, load, MimicIOUnsupportedClass,
  register, createRegistry, defaultRegistry,
  canonicalize,
  encodeTypedArray, decodeTypedArray, isTypedArrayRef,
  normalizeV1, isV1,
};
`;

const outPath = join(__dirname, 'index.js');
writeFileSync(outPath, output);
console.log(`Built ${outPath} (${(output.length / 1024).toFixed(1)} KB)`);
