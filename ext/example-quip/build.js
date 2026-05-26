#!/usr/bin/env node
// Concats ext/example-quip/src/ ES modules into two bundles:
//
//   index.js   — notebook-context entry (cellType, taggedLanguage,
//                exports, globals — see src/register.js)
//   works.js   — shell-context entry (surfaces + contextMenu — see
//                src/works-register.js)
//
// EXTENSION_SPEC §2.5 + §3.8.7. Each runs in its own JS context;
// they share no state.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, 'src');

function stripModuleSyntax(src) {
  src = src.replace(/^import\s+.*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^import\s*\{[\s\S]*?\}\s*from\s*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^export function /gm, 'function ');
  src = src.replace(/^export const /gm, 'const ');
  src = src.replace(/^export let /gm, 'let ');
  src = src.replace(/^export class /gm, 'class ');
  src = src.replace(/^export async function /gm, 'async function ');
  src = src.replace(/^export\s*\{[^}]*\}\s*from\s*['"][^'"]+['"];?\s*$/gm, '');
  src = src.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  src = src.replace(/^export\s+default\s+.*$/gm, '');
  return src.replace(/^\n+/, '').replace(/\n+$/, '');
}

function concat(entryPaths, header, trailer) {
  const chunks = [];
  for (const rel of entryPaths) {
    const filePath = path.join(srcDir, rel);
    const src = stripModuleSyntax(fs.readFileSync(filePath, 'utf8'));
    chunks.push(`// -- ${rel} --\n\n${src}`);
  }
  return header + '\n' + chunks.join('\n\n') + (trailer ? '\n\n' + trailer : '') + '\n';
}

// ── index.js (notebook context) ────────────────────────────────────
//
// Build order: parse (zero deps) → tokenize → tag/adapter/cell →
// register. register.js consumes everything via stripped imports.
const NOTEBOOK_HEADER = '// ⚠ GENERATED FILE — DO NOT EDIT. Source: ext/example-quip/src/  Build: node ext/example-quip/build.js\n'
  + '// @example/quip — notebook-context entry (EXTENSION_SPEC §2.5).\n';
const NOTEBOOK_TRAILER = 'export { parseQuip, renderQuip, compileQuip, makePhrases, tokenizeQuip, quipTag, quipNamespace };';

const indexJs = concat(
  ['parse.js', 'tokenize.js', 'tag.js', 'adapter.js', 'cell.js', 'register.js'],
  NOTEBOOK_HEADER, NOTEBOOK_TRAILER
);
fs.writeFileSync(path.join(__dirname, 'index.js'), indexJs);

// ── works.js (shell context) ───────────────────────────────────────
//
// works-register.js is self-contained — no imports from src/. The
// inlined parser in the contextMenu action keeps it that way, so the
// concat is just the one file.
const SHELL_HEADER = '// ⚠ GENERATED FILE — DO NOT EDIT. Source: ext/example-quip/src/  Build: node ext/example-quip/build.js\n'
  + '// @example/quip — shell-context entry (EXTENSION_SPEC §2.5 + §3.8).\n';

const worksJs = concat(['works-register.js'], SHELL_HEADER, '');
fs.writeFileSync(path.join(__dirname, 'works.js'), worksJs);

const idxSize = fs.statSync(path.join(__dirname, 'index.js')).size;
const worksSize = fs.statSync(path.join(__dirname, 'works.js')).size;
console.log(`Built ext/example-quip/index.js (${(idxSize / 1024).toFixed(1)} KB) + works.js (${(worksSize / 1024).toFixed(1)} KB)`);
