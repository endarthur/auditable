#!/usr/bin/env node
// Bundle ext/sluice/src/ into ext/sluice/index.js — a single ES module.
// Concat strategy (like ext/abus, ext/plot, …): strip import/export statements,
// concatenate in manifest order, append an auto-collected export footer.
// CRLF-safe: normalize \r\n -> \n before line-anchored regex work.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, 'src');

// Manifest order (accumulator first; runner last).
const files = ['accumulator.js', 'tdigest.js', 'categorical.js', 'histogram.js', 'combinators.js', 'spec.js', 'runner.js'];

const exported = new Set();
const chunks = [];

for (const file of files) {
  let src = fs.readFileSync(path.join(srcDir, file), 'utf8').replace(/\r\n/g, '\n');

  // Collect exported identifier names for the footer.
  const re = /^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(src)) !== null) exported.add(m[1]);

  // Strip imports.
  src = src.replace(/^import\s+.*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^import\s*\{[^}]*\}\s*from\s*['"].*['"];?\s*$/gm, '');
  // Strip re-export forms (none expected in leaf modules, but be safe).
  src = src.replace(/^export\s*\{[^}]*\}\s*from\s*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  // Demote export declarations to plain declarations.
  src = src.replace(/^export\s+async\s+function\s+/gm, 'async function ');
  src = src.replace(/^export\s+function\s+/gm, 'function ');
  src = src.replace(/^export\s+const\s+/gm, 'const ');
  src = src.replace(/^export\s+let\s+/gm, 'let ');
  src = src.replace(/^export\s+class\s+/gm, 'class ');

  src = src.replace(/^\n+/, '').replace(/\n+$/, '');
  chunks.push(`// -- ${file} --\n\n${src}`);
}

const header = `// @gcu/sluice — online / streaming statistics nucleus
// Auto-generated from ext/sluice/src/ — do not edit directly
`;

const names = [...exported].sort();
const footer = `\nexport {\n${names.map((n) => '  ' + n).join(',\n')},\n};\n`;

const output = header + '\n' + chunks.join('\n\n') + '\n' + footer;
fs.writeFileSync(path.join(__dirname, 'index.js'), output);
console.log(`Built ext/sluice/index.js (${(output.length / 1024).toFixed(1)} KB, ${names.length} exports)`);
