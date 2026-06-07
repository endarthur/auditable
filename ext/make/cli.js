#!/usr/bin/env node
// @gcu/make CLI. Rebuilds @gcu/build-managed packages in dependency order,
// skipping the unchanged. No targets to name, no rules to write.
//
//   gcu-make                 build everything that changed (+ its dependents)
//   gcu-make over strata     build (at least) these, plus anything downstream
//   gcu-make --force         rebuild all, ignore the cache
//   gcu-make --check         rebuild all, then assert nothing drifted in git (CI)
//   gcu-make --graph         print the derived dependency graph and exit

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { make, discover, deriveEdges, topoOrder } from './make.js';

const extDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const only = args.filter((a) => !a.startsWith('--'));
const quiet = flags.has('--quiet');
const log = quiet ? () => {} : (s) => console.log('gcu-make: ' + s);

if (flags.has('--help')) {
  process.stdout.write(`gcu-make — derived-graph build orchestrator\n\n  gcu-make [--force|--check|--graph|--quiet] [pkg...]\n`);
  process.exit(0);
}

if (flags.has('--graph')) {
  const pkgs = discover(extDir);
  const edges = deriveEdges(pkgs);
  const order = topoOrder(pkgs, edges);
  for (const n of order) {
    const deps = [...edges.get(n)];
    console.log(`  ${n}${deps.length ? '  ←  ' + deps.join(', ') : ''}`);
  }
  console.log(`\n${pkgs.length} managed package(s), build order above (deps first).`);
  process.exit(0);
}

try {
  if (flags.has('--check')) {
    // rebuild everything, then assert the committed index.js files match (no drift).
    const r = make({ extDir, force: true, log });
    const indexPaths = r.order.map((n) => path.join(extDir, n, 'index.js'));
    const out = execFileSync('git', ['diff', '--name-only', '--', ...indexPaths], { encoding: 'utf8' }).trim();
    if (out) {
      console.error('gcu-make: error: drift — these bundles are out of date (rebuild + commit):\n  ' + out.split('\n').join('\n  '));
      process.exit(1);
    }
    log('all bundles reproducible from source ✓');
  } else {
    const r = make({ extDir, only, force: flags.has('--force'), log });
    log(`${r.built.length} built, ${r.skipped.length} up to date`);
  }
} catch (e) {
  console.error(e.message || String(e));
  process.exit(1);
}
