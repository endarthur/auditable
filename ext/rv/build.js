#!/usr/bin/env node
// Builds ext/rv/index.js — compiles cpu.atra via atrac.bundle() + concatenates JS host

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { bundle } from '../atra/atrac.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. Compile atra CPU core
const cpuSource = fs.readFileSync(path.join(__dirname, 'src', 'cpu.atra'), 'utf8');
let cpuJs = bundle(cpuSource, { name: 'rv32ima-cpu' });

// 2. Read JS host modules
const jsDir = path.join(__dirname, 'js');
const jsFiles = ['elf.js', 'dtb.js', 'uart.js', 'host.js', 'console.js'];
const jsChunks = jsFiles.map(f => {
  const src = fs.readFileSync(path.join(jsDir, f), 'utf8');
  return `// -- ${f} --\n\n${src}`;
});

// 3. Assemble full index.js (for non-worker use and ref scripts)
const header = '// \u26a0 GENERATED FILE \u2014 DO NOT EDIT. Source: ext/rv/src/ + ext/rv/js/  Build: node ext/rv/build.js\n'
  + '// RV32IMA system emulator \u2014 atra CPU core + JS host\n';
const output = header + '\n' + cpuJs + '\n\n' + jsChunks.join('\n\n') + '\n';

const outPath = path.join(__dirname, 'index.js');
fs.writeFileSync(outPath, output);
const size = fs.statSync(outPath).size;
console.log(`Built ext/rv/index.js (${(size / 1024).toFixed(1)} KB)`);

// 4. Build worker source (engine + worker.js, no console.js or host.js)
const workerModules = ['elf.js', 'dtb.js', 'uart.js'];
const workerChunks = workerModules.map(f => {
  const src = fs.readFileSync(path.join(jsDir, f), 'utf8');
  return `// -- ${f} --\n\n${src}`;
});
const workerMain = fs.readFileSync(path.join(jsDir, 'worker.js'), 'utf8');
const workerSrc = cpuJs + '\n\n' + workerChunks.join('\n\n') + '\n\n// -- worker.js --\n\n' + workerMain;

const workerOutPath = path.join(__dirname, 'worker.js');
fs.writeFileSync(workerOutPath, workerSrc);
const wSize = fs.statSync(workerOutPath).size;
console.log(`Built ext/rv/worker.js (${(wSize / 1024).toFixed(1)} KB)`);
