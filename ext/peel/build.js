#!/usr/bin/env node
// Bundle ext/peel/src/ into ext/peel/index.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, 'src');

const files = ['bvh.js', 'cpu.js', 'gpu.js', 'worker.js', 'main.js'];

const chunks = [];
for (const file of files) {
  let src = fs.readFileSync(path.join(srcDir, file), 'utf8');
  src = src.replace(/^import\s+.*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  src = src.replace(/^export function /gm, 'function ');
  src = src.replace(/^export async function /gm, 'async function ');
  src = src.replace(/^export const /gm, 'const ');
  src = src.replace(/^export let /gm, 'let ');
  src = src.replace(/^export class /gm, 'class ');
  src = src.replace(/^\n+/, '').replace(/\n+$/, '');
  chunks.push(`// -- ${file} --\n\n${src}`);
}

const header = `// PEEL — Depth Peeling Surface Intersection Engine
// Auto-generated from ext/peel/src/ — do not edit directly
`;

const footer = '\nexport { Peel, buildBVH, evaluateCPU, rayTriangle, rayAABB, peelColumnBrute, peelColumnBVH, AXIS_MAP };\n';
const output = header + '\n' + chunks.join('\n\n') + footer;
const outPath = path.join(__dirname, 'index.js');
fs.writeFileSync(outPath, output);
console.log(`Built ${outPath} (${(output.length / 1024).toFixed(1)} KB)`);
