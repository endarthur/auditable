#!/usr/bin/env node
// Bundle ext/over/src/ into ext/over/index.js — a single ES module. Concat
// strategy (like the other ext libs): strip import/export, concatenate in manifest
// order, auto-collect the export footer. CRLF-safe.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, 'src');

// External deps inlined into the bundle (concat model — shared source, inlined per
// consumer). @gcu/dimensions is the dimension algebra under units.js; its exports go
// into bundle scope but NOT into over's public export footer.
const externalDeps = [path.join(__dirname, '..', 'dimensions', 'src', 'dimensions.js')];

// Manifest order — dependencies first (parse imports lex; units imports dimensions;
// schema imports units; join imports lookup/emit/windows/runtime; driver imports
// windows/lookup/join/check; api imports the collects).
const files = ['util.js', 'lex.js', 'parse.js', 'units.js', 'schema.js', 'runtime.js', 'emit.js', 'windows.js', 'lookup.js', 'join.js', 'check.js', 'driver.js', 'api.js', 'tag.js'];

const exported = new Set();
const chunks = [];

const stripModule = (src) => src
  .replace(/^import\s+.*['"].*['"];?\s*$/gm, '')
  .replace(/^import\s*\{[^}]*\}\s*from\s*['"].*['"];?\s*$/gm, '')
  .replace(/^export\s*\{[^}]*\}\s*from\s*['"].*['"];?\s*$/gm, '')
  .replace(/^export\s*\{[^}]*\};?\s*$/gm, '')
  .replace(/^export\s+async\s+function\s+/gm, 'async function ')
  .replace(/^export\s+function\s+/gm, 'function ')
  .replace(/^export\s+const\s+/gm, 'const ')
  .replace(/^export\s+let\s+/gm, 'let ')
  .replace(/^export\s+class\s+/gm, 'class ')
  .replace(/^\n+/, '').replace(/\n+$/, '');

// External deps first (so their consts are defined before use) — exports NOT collected.
for (const dep of externalDeps) {
  const src = stripModule(fs.readFileSync(dep, 'utf8').replace(/\r\n/g, '\n'));
  chunks.push(`// -- ${path.basename(path.dirname(path.dirname(dep)))}/${path.basename(dep)} (inlined) --\n\n${src}`);
}

for (const file of files) {
  let src = fs.readFileSync(path.join(srcDir, file), 'utf8').replace(/\r\n/g, '\n');

  const re = /^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(src)) !== null) exported.add(m[1]);

  src = stripModule(src);
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
