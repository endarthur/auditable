#!/usr/bin/env node
// Concats ext/workbench/src/ ES modules into the two package entry points:
//
//   service.js — the shell-side `pipeline` A-Bus service (pipeline-workers +
//                pipeline-service). A real ES module exporting setupService(ctx);
//                the broker's service activator blob-imports it from /lib and
//                calls that export. Dependency-injected — no imports survive
//                except the ones the activator satisfies via ctx.
//
//   works.js   — the shell-context surface registration (works-register.js).
//                Self-contained; evaluated at install + every boot.
//
// works-contribution-registry-spec — a package that contributes BOTH a surface
// (code, works.js) and a service (declarative data, package.json gcu.services).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, 'src');

// Strip ESM import statements (the service is dependency-injected; the only
// relative import — pipeline-workers — is satisfied by concatenation). EXPORTS
// are preserved: service.js is a real module the activator import()s.
function stripImports(src) {
  src = src.replace(/^import\s+.*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^import\s*\{[\s\S]*?\}\s*from\s*['"].*['"];?\s*$/gm, '');
  return src.replace(/^\n+/, '').replace(/\n+$/, '');
}

// Strip imports AND exports — for the self-contained works.js (runs as a side
// effect; nothing imports it, so exports would only dangle).
function stripModuleSyntax(src) {
  src = stripImports(src);
  src = src.replace(/^export function /gm, 'function ');
  src = src.replace(/^export const /gm, 'const ');
  src = src.replace(/^export async function /gm, 'async function ');
  src = src.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  return src.replace(/^\n+/, '').replace(/\n+$/, '');
}

function concat(files, transform, header) {
  const chunks = [];
  for (const rel of files) {
    const src = transform(fs.readFileSync(path.join(srcDir, rel), 'utf8'));
    chunks.push(`// -- ${rel} --\n\n${src}`);
  }
  return header + '\n' + chunks.join('\n\n') + '\n';
}

const GEN = '// ⚠ GENERATED FILE — DO NOT EDIT. Source: ext/workbench/src/  Build: node ext/workbench/build.js\n';

// service.js — workers first (defines scanParallel), then the service (which
// keeps its `export function setupService` for the activator to call).
const serviceJs = concat(
  ['pipeline-workers.js', 'pipeline-service.js'],
  stripImports,
  GEN + '// @gcu/workbench — shell-side `pipeline` service entry (exports setupService).\n'
);
fs.writeFileSync(path.join(__dirname, 'service.js'), serviceJs);

// works.js — the surface registration, self-contained.
const worksJs = concat(
  ['works-register.js'],
  stripModuleSyntax,
  GEN + '// @gcu/workbench — shell-context entry (surface registration).\n'
);
fs.writeFileSync(path.join(__dirname, 'works.js'), worksJs);

const svcSize = fs.statSync(path.join(__dirname, 'service.js')).size;
const worksSize = fs.statSync(path.join(__dirname, 'works.js')).size;
console.log(`Built ext/workbench/service.js (${(svcSize / 1024).toFixed(1)} KB) + works.js (${(worksSize / 1024).toFixed(1)} KB)`);
