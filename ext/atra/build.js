#!/usr/bin/env node
// Bundles ext/atra/src/ ES modules into a single index.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const srcDir = path.join(__dirname, 'src');
const mainPath = path.join(srcDir, 'main.js');
const mainSrc = fs.readFileSync(mainPath, 'utf8');

// Extract module paths from main.js (imports and re-exports)
const importPaths = [];
for (const line of mainSrc.split('\n')) {
  const m = line.match(/^(?:import|export)\s+.*['"]\.\/(.+?)['"];?\s*(?:\/\/.*)?$/);
  if (m) importPaths.push(m[1]);
}

const chunks = [];
for (const relPath of importPaths) {
  const filePath = path.join(srcDir, relPath);
  let src = fs.readFileSync(filePath, 'utf8');
  const basename = path.basename(relPath);

  // Strip import lines (single-line and multi-line)
  src = src.replace(/^import\s+.*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^import\s*\{[\s\S]*?\}\s*from\s*['"].*['"];?\s*$/gm, '');

  // Replace export function -> function, export const -> const, etc.
  src = src.replace(/^export function /gm, 'function ');
  src = src.replace(/^export const /gm, 'const ');
  src = src.replace(/^export let /gm, 'let ');
  src = src.replace(/^export class /gm, 'class ');

  // Strip export { ... } and export default lines
  src = src.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  src = src.replace(/^export\s+default\s+.*$/gm, '');

  // Trim leading/trailing blank lines
  src = src.replace(/^\n+/, '').replace(/\n+$/, '');

  chunks.push(`// -- ${basename} --\n\n${src}`);
}

const header = '// @auditable/atra — Arithmetic TRAnspiler\n'
  + '// Fortran/Pascal hybrid → WebAssembly bytecode. Single-file compiler.\n';

const output = header + '\n' + chunks.join('\n\n') + '\n\nexport { atra };\n';

const outPath = path.join(__dirname, 'index.js');
fs.writeFileSync(outPath, output);
const size = fs.statSync(outPath).size;
console.log(`Built ext/atra/index.js (${(size / 1024).toFixed(1)} KB)`);

// ── Build lib/alpack.src.js from lib/alpack.atra ──
// Exports each subroutine/function as a named string constant,
// plus `all` for the full source.

const libDir = path.join(__dirname, 'lib');
const atraPath = path.join(libDir, 'alpack.atra');
if (fs.existsSync(atraPath)) {
  const atraSrc = fs.readFileSync(atraPath, 'utf8');
  const lines = atraSrc.split('\n');
  const routines = {};
  let current = null, name = null;

  for (const line of lines) {
    const m = line.match(/^\s*(?:subroutine|function)\s+([\w.]+)\s*\(/);
    if (m) {
      name = m[1];
      current = [line];
    } else if (current) {
      current.push(line);
      if (/^\s*end\s*$/.test(line)) {
        routines[name] = current.join('\n');
        current = null;
        name = null;
      }
    }
  }

  // Build dependency map: for each routine, find calls to other routines
  const routineNames = Object.keys(routines);
  const deps = {};
  for (const [rname, src] of Object.entries(routines)) {
    deps[rname] = routineNames.filter(other =>
      other !== rname && new RegExp(`\\b${other.replace(/\./g, '\\.')}\\s*\\(`).test(src)
    );
  }

  let libOut = '// Generated from alpack.atra — do not edit\n\n';
  libOut += `export const all = ${JSON.stringify(atraSrc)};\n\n`;

  // Individual routine exports (flat names: alas.ddot → alas_ddot)
  for (const [rname, src] of Object.entries(routines)) {
    const jsName = rname.replace(/\./g, '_');
    libOut += `export const ${jsName} = ${JSON.stringify(src)};\n\n`;
  }

  // Library object for std.include(): { sources, deps }
  libOut += `export const sources = {\n`;
  for (const rname of routineNames) {
    libOut += `  ${JSON.stringify(rname)}: ${JSON.stringify(routines[rname])},\n`;
  }
  libOut += `};\n\n`;
  libOut += `export const deps = {\n`;
  for (const rname of routineNames) {
    libOut += `  ${JSON.stringify(rname)}: ${JSON.stringify(deps[rname])},\n`;
  }
  libOut += `};\n`;

  const libOutPath = path.join(libDir, 'alpack.src.js');
  fs.writeFileSync(libOutPath, libOut);
  const libSize = fs.statSync(libOutPath).size;
  console.log(`Built ext/atra/lib/alpack.src.js (${(libSize / 1024).toFixed(1)} KB)`);
}
