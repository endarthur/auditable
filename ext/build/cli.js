#!/usr/bin/env node
// @gcu/build — CLI (SPEC §13.2). A thin wrapper over the library; the library is
// the load-bearing contract. `bin` can be removed and every build.js keeps working.

import fs from 'node:fs';
import path from 'node:path';
import { bundle } from './src/io/node.js';

const VERSION = '0.1.0';

const HELP = `gcu-build — owned AST bundler

usage: gcu-build [options] <entry>

  <entry>                main.js manifest (default: src/main.js), relative to --out-dir

options:
  --out-dir <dir>        package dir (default: cwd)
  --out-file <name>      output file name (default: index.js)
  --no-meta              suppress index.meta.json
  --define <KEY=VALUE>   repeatable; VALUE is a JS literal expression
  --inline <spec>        repeatable; an external to inline (@gcu/x or a path)
  --no-lint-escaping     allow escaping-relative imports as external (disables E002)
  --check                drift check: rebuild, assert committed output matches; exit 1 on drift
  --stdout               emit code to stdout, no disk writes (implies --no-meta)
  --quiet                suppress non-error output
  --help                 show this
  --version              print version
`;

function parseArgs(argv) {
  const o = { define: {}, inline: [], outDir: process.cwd(), outFile: 'index.js', meta: true, check: false, stdout: false, quiet: false, lintEscaping: true };
  let entry = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--help': case '-h': o.help = true; break;
      case '--version': case '-v': o.version = true; break;
      case '--out-dir': o.outDir = path.resolve(argv[++i]); break;
      case '--out-file': o.outFile = argv[++i]; break;
      case '--no-meta': o.meta = false; break;
      case '--no-lint-escaping': o.lintEscaping = false; break;
      case '--check': o.check = true; break;
      case '--stdout': o.stdout = true; o.meta = false; break;
      case '--quiet': o.quiet = true; break;
      case '--inline': o.inline.push(argv[++i]); break;
      case '--define': {
        const kv = argv[++i];
        const eq = kv.indexOf('=');
        if (eq < 0) { console.error(`gcu-build: error: --define expects KEY=VALUE, got '${kv}'`); process.exit(2); }
        o.define[kv.slice(0, eq)] = kv.slice(eq + 1);
        break;
      }
      default:
        if (a.startsWith('-')) { console.error(`gcu-build: error: unknown option '${a}'`); process.exit(2); }
        entry = a;
    }
  }
  o.entry = entry || 'src/main.js';
  return o;
}

const o = parseArgs(process.argv.slice(2));
if (o.help) { process.stdout.write(HELP); process.exit(0); }
if (o.version) { process.stdout.write(VERSION + '\n'); process.exit(0); }

const common = {
  dir: o.outDir, entry: o.entry, outFile: o.outFile,
  define: Object.keys(o.define).length ? o.define : undefined,
  inline: o.inline.length ? o.inline : undefined,
  lintEscaping: o.lintEscaping,
};

try {
  if (o.check) {
    const r = bundle({ ...common, write: false, meta: false });
    const target = path.join(o.outDir, o.outFile);
    const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (existing === null) { console.error(`gcu-build: error: --check: no committed ${o.outFile} to compare`); process.exit(1); }
    if (existing !== r.code) {
      console.error(`gcu-build: error: ${o.outFile} is out of date — rebuild with gcu-build (drift detected)`);
      process.exit(1);
    }
    if (!o.quiet) console.log(`gcu-build: ${o.outFile} is up to date`);
    process.exit(0);
  }

  if (o.stdout) {
    const r = bundle({ ...common, write: false, meta: false });
    process.stdout.write(r.code);
    process.exit(0);
  }

  const r = bundle({ ...common, write: true, meta: o.meta });
  if (!o.quiet) console.log(`gcu-build: wrote ${path.relative(process.cwd(), r.outPath)} (${(r.code.length / 1024).toFixed(1)} KB)`);
} catch (e) {
  console.error(e.code ? e.toString() : `gcu-build: error: ${e.message}`);
  process.exit(1);
}
