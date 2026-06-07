#!/usr/bin/env node
// @gcu/make CLI. Rebuilds @gcu/build-managed packages in dependency order, then
// the repo targets (auditable.html → works/works-all + examples), skipping unchanged.
// No rules to write — packages are derived; the few non-package targets declared.
//
//   gcu-make                 build everything that changed (+ its dependents + targets)
//   gcu-make over strata     build (at least) these, plus anything downstream
//   gcu-make --force         rebuild all, ignore the cache
//   gcu-make --no-targets    packages only (skip auditable/works rebuilds — fast iter)
//   gcu-make --check         rebuild all, then assert nothing drifted in git (CI)
//   gcu-make --graph         print the derived dependency graph and exit

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { make, discover, deriveEdges, topoOrder, REPO_TARGETS } from './make.js';

const extDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(extDir, '..');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const only = args.filter((a) => !a.startsWith('--'));
const quiet = flags.has('--quiet');
const noTargets = flags.has('--no-targets');
const log = quiet ? () => {} : (s) => console.log('gcu-make: ' + s);

if (flags.has('--help')) {
  process.stdout.write(`gcu-make — derived-graph build orchestrator\n\n  gcu-make [--force|--check|--graph|--no-targets|--quiet] [pkg...]\n`);
  process.exit(0);
}

if (flags.has('--graph')) {
  const pkgs = discover(extDir);
  const edges = deriveEdges(pkgs);
  for (const n of topoOrder(pkgs, edges)) {
    const deps = [...edges.get(n)];
    console.log(`  ${n}${deps.length ? '  ←  ' + deps.join(', ') : ''}`);
  }
  console.log(`\n  ── targets (non-package root builds) ──`);
  for (const t of REPO_TARGETS) {
    console.log(`  ${t.name}${t.deps && t.deps.length ? '  ←  ' + t.deps.join(', ') : ''}  →  ${t.out || t.cmd.join(' ')}`);
  }
  console.log(`\n${pkgs.length} managed package(s) + ${REPO_TARGETS.length} target(s); auditable's inputs include ext/*/index.js, so a package change cascades to works.`);
  process.exit(0);
}

try {
  if (flags.has('--check')) {
    // rebuild everything, then assert the committed outputs match (no drift).
    const r = make({ extDir, force: true, noTargets, log });
    const outs = r.order.map((n) => path.relative(root, path.join(extDir, n, 'index.js')));
    const targetPaths = (r.targets.order || []).flatMap((n) => {
      const t = REPO_TARGETS.find((x) => x.name === n);
      return t.checkPaths || (t.out ? [t.out] : []);
    });
    const drift = execFileSync('git', ['diff', '--name-only', '--', ...outs, ...targetPaths], { cwd: root, encoding: 'utf8' }).trim();
    if (drift) {
      console.error('gcu-make: error: drift — these outputs are out of date (rebuild + commit):\n  ' + drift.split('\n').join('\n  '));
      process.exit(1);
    }
    log('all bundles + targets reproducible from source ✓');
  } else {
    const r = make({ extDir, only, force: flags.has('--force'), noTargets, log });
    const t = r.targets;
    log(`${r.built.length} package(s) built, ${r.skipped.length} up to date` +
      (noTargets ? '' : `; ${t.built.length} target(s) built, ${t.skipped.length} up to date`));
  }
} catch (e) {
  console.error(e.message || String(e));
  process.exit(1);
}
