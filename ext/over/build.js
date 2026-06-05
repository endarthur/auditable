#!/usr/bin/env node
// Bundle ext/over/src/ into ext/over/index.js — a single ES module. Concat
// strategy (like the other ext libs): strip import/export, concatenate in manifest
// order, auto-collect the export footer. CRLF-safe.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, 'src');

// Manifest order — dependencies first (parse imports lex).
const files = ['lex.js', 'parse.js', 'schema.js', 'runtime.js', 'emit.js', 'driver.js', 'api.js'];

const exported = new Set();
const chunks = [];

for (const file of files) {
  let src = fs.readFileSync(path.join(srcDir, file), 'utf8').replace(/\r\n/g, '\n');

  const re = /^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(src)) !== null) exported.add(m[1]);

  src = src.replace(/^import\s+.*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^import\s*\{[^}]*\}\s*from\s*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^export\s*\{[^}]*\}\s*from\s*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  src = src.replace(/^export\s+async\s+function\s+/gm, 'async function ');
  src = src.replace(/^export\s+function\s+/gm, 'function ');
  src = src.replace(/^export\s+const\s+/gm, 'const ');
  src = src.replace(/^export\s+let\s+/gm, 'let ');
  src = src.replace(/^export\s+class\s+/gm, 'class ');

  src = src.replace(/^\n+/, '').replace(/\n+$/, '');
  chunks.push(`// -- ${file} --\n\n${src}`);
}

const header = `// @gcu/over — OVER (Ordered/Vectorized Expression Runner): the table-transform DSL
// Auto-generated from ext/over/src/ — do not edit directly
`;

const names = [...exported].sort();
const footer = `\nexport {\n${names.map((n) => '  ' + n).join(',\n')},\n};\n`;

const output = header + '\n' + chunks.join('\n\n') + '\n' + footer;
fs.writeFileSync(path.join(__dirname, 'index.js'), output);
console.log(`Built ext/over/index.js (${(output.length / 1024).toFixed(1)} KB, ${names.length} exports)`);
