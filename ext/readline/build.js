#!/usr/bin/env node
// Bundles ext/readline/src/ ES modules into a single index.js
// (mirrors ext/geas/build.js).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const srcDir = path.join(__dirname, 'src');
const mainPath = path.join(srcDir, 'main.js');
const mainSrc = fs.readFileSync(mainPath, 'utf8');

// Pull import / export paths from main.js (order = bundle order).
const importPaths = [];
for (const line of mainSrc.split('\n')) {
  const m = line.match(/^(?:import|export)\s+.*['"]\.\/(.+?)['"];?\s*(?:\/\/.*)?$/);
  if (m && !importPaths.includes(m[1])) importPaths.push(m[1]);
}

const chunks = [];
for (const relPath of importPaths) {
  const filePath = path.join(srcDir, relPath);
  let src = fs.readFileSync(filePath, 'utf8');
  const basename = path.basename(relPath);

  // Strip import lines (single-line and multi-line)
  src = src.replace(/^import\s+.*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^import\s*\{[\s\S]*?\}\s*from\s*['"].*['"];?\s*$/gm, '');
  // Strip `import * as foo from ...`
  src = src.replace(/^import\s+\*\s+as\s+\w+\s+from\s+['"].*['"];?\s*$/gm, '');

  // Replace top-level exports with their plain declarations
  src = src.replace(/^export function /gm, 'function ');
  src = src.replace(/^export const /gm, 'const ');
  src = src.replace(/^export let /gm, 'let ');
  src = src.replace(/^export class /gm, 'class ');
  src = src.replace(/^export async function /gm, 'async function ');

  // Strip explicit re-export blocks
  src = src.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  src = src.replace(/^export\s+default\s+.*$/gm, '');

  src = src.replace(/^\n+/, '').replace(/\n+$/, '');
  chunks.push(`// -- ${basename} --\n\n${src}`);
}

const header = '// ⚠ GENERATED FILE — DO NOT EDIT. Source: ext/readline/src/  Build: node ext/readline/build.js\n'
  + '// @gcu/readline — GNU-readline-minimum line editor with fish-style autosuggest\n'
  + '// and tab completion. Drop-in for @gcu/geas\'s makeLineEditor.\n';

// editor.js exports a lot — list them so the bundle ES export matches
// what api.js consumes internally (the bundle is one file, so internal
// editor.* refs are by name; we re-export only the public surface).
const output = header + '\n' + chunks.join('\n\n')
  + '\n\nexport { parseKeys, createReadline };\n';

const outPath = path.join(__dirname, 'index.js');
fs.writeFileSync(outPath, output);
const size = fs.statSync(outPath).size;
console.log(`Built ext/readline/index.js (${(size / 1024).toFixed(1)} KB)`);
