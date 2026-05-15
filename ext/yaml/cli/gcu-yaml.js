#!/usr/bin/env node
// gcu-yaml — CLI for @gcu/yaml.
//
//   gcu-yaml check FILES...           — parse each file; exit 1 if any fail
//   gcu-yaml fmt FILES...             — rewrite each file in canonical form
//   gcu-yaml fmt --check FILES...     — exit non-zero if any file would change
//   gcu-yaml fmt --stdout FILES...    — write canonical form to stdout
//
// Exit codes:
//   0  — all files conform / all formatted
//   1  — at least one file failed parsing / would change (with --check)
//   2  — usage error (no files, unreadable file)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse, emit, check } from '../src/api.js';

const argv = process.argv.slice(2);

function usage(code = 2) {
  process.stderr.write([
    'usage:',
    '  gcu-yaml check FILES...',
    '  gcu-yaml fmt   [--check|--stdout] FILES...',
  ].join('\n') + '\n');
  process.exit(code);
}

if (argv.length === 0) usage();

const cmd = argv[0];
const rest = argv.slice(1);

const flags = { check: false, stdout: false };
const files = [];
for (const a of rest) {
  if (a === '--check') flags.check = true;
  else if (a === '--stdout') flags.stdout = true;
  else if (a.startsWith('-')) {
    process.stderr.write(`unknown flag: ${a}\n`);
    usage(2);
  } else files.push(a);
}

if (files.length === 0) usage(2);

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    process.stderr.write(`cannot read ${p}: ${e.message}\n`);
    process.exit(2);
  }
}

if (cmd === 'check') {
  let bad = 0;
  for (const f of files) {
    const src = readFile(f);
    const err = check(src);
    if (err) {
      process.stderr.write(`${f}: ${err.message}\n`);
      bad++;
    }
  }
  process.exit(bad === 0 ? 0 : 1);
} else if (cmd === 'fmt') {
  let changed = 0;
  let bad = 0;
  for (const f of files) {
    const src = readFile(f);
    let canonical;
    try {
      canonical = emit(parse(src));
    } catch (e) {
      process.stderr.write(`${f}: ${e.message}\n`);
      bad++;
      continue;
    }
    if (flags.stdout) {
      process.stdout.write(canonical);
      continue;
    }
    if (canonical !== src) changed++;
    if (flags.check) continue;
    if (canonical !== src) fs.writeFileSync(f, canonical);
  }
  if (bad > 0) process.exit(1);
  if (flags.check && changed > 0) process.exit(1);
  process.exit(0);
} else {
  usage(2);
}
