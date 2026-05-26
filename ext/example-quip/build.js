#!/usr/bin/env node
// Concats ext/example-quip/src/ ES modules into a single index.js.
// Pattern lifted from ext/soft/build.js — same shape every ext/<name>
// uses. Order is taken from src/main.js's import order.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, 'src');
const mainSrc = fs.readFileSync(path.join(srcDir, 'main.js'), 'utf8');

const importPaths = [];
for (const rawLine of mainSrc.split('\n')) {
  // Strip CRLF — `$` doesn't span '\r' on Windows checkouts.
  const line = rawLine.replace(/\r$/, '');
  const m = line.match(/^(?:import|export)\s+.*['"]\.\/(.+?)['"];?\s*(?:\/\/.*)?$/);
  if (m) importPaths.push(m[1]);
}

function stripModuleSyntax(src) {
  src = src.replace(/^import\s+.*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^import\s*\{[\s\S]*?\}\s*from\s*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^export function /gm, 'function ');
  src = src.replace(/^export const /gm, 'const ');
  src = src.replace(/^export let /gm, 'let ');
  src = src.replace(/^export class /gm, 'class ');
  src = src.replace(/^export async function /gm, 'async function ');
  // Re-exports (`export { … } from './x';`) — strip the full statement
  // because the bundled form already has every name in scope from the
  // concat pass. Must run before the plain `export { … };` rule below
  // (the `from` part would otherwise survive into the output).
  src = src.replace(/^export\s*\{[^}]*\}\s*from\s*['"][^'"]+['"];?\s*$/gm, '');
  src = src.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  src = src.replace(/^export\s+default\s+.*$/gm, '');
  return src.replace(/^\n+/, '').replace(/\n+$/, '');
}

const chunks = [];
for (const rel of importPaths) {
  const filePath = path.join(srcDir, rel);
  const src = stripModuleSyntax(fs.readFileSync(filePath, 'utf8'));
  chunks.push(`// -- ${rel} --\n\n${src}`);
}

// register.js has a dynamic `import('./parse.js')` inside the
// contextMenu action — rewrite to a self-reference since the bundled
// file no longer has separate modules. parseQuip is in scope by name
// once concat'd, so the action body just uses it directly.
const header = '// ⚠ GENERATED FILE — DO NOT EDIT. Source: ext/example-quip/src/  Build: node ext/example-quip/build.js\n'
  + '// @example/quip — the EXTENSION_SPEC.md reference example.\n';

let body = chunks.join('\n\n');
// Replace the dynamic import in the bundled form. parseQuip is already
// hoisted by the concat pass.
body = body.replace(
  /const\s*\{\s*parseQuip\s*\}\s*=\s*await\s+import\(['"]\.\/parse\.js['"]\);?\s*/,
  '/* bundled — parseQuip is in scope */ '
);

const output = `${header}\n${body}\n\nexport { parseQuip, renderQuip, compileQuip, makePhrases, tokenizeQuip, quipTag, quipNamespace };\n`;
const outPath = path.join(__dirname, 'index.js');
fs.writeFileSync(outPath, output);
console.log(`Built ext/example-quip/index.js (${(fs.statSync(outPath).size / 1024).toFixed(1)} KB)`);
