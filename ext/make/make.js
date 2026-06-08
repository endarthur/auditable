// @gcu/make — the catcher in the rye of build orchestrators. No phonies.
//
// Make's premise is "write down your dependencies." GCU already HAS them — in the
// imports + inline lists — so @gcu/make derives the graph instead of declaring it:
// it discovers every package built by @gcu/build, reads the cross-package edges
// out of their source, topo-sorts, and rebuilds only what changed (and whatever
// sits downstream of a change). No Makefile, no rule DSL, no .PHONY — every target
// is a real artifact (index.js) whose source-hash is the truth.
//
// It orchestrates; it doesn't re-implement per-package config. Each package's
// build.js stays the single source of truth for its own options (inline, define,
// sidecars); @gcu/make just runs them in the right order, skipping the unchanged.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const isManagedBuild = (txt) => /@gcu\/build|build\/src\/main\.js/.test(txt);

// Discover packages whose build.js is driven by @gcu/build.
export function discover(extDir) {
  const out = [];
  for (const name of fs.readdirSync(extDir).sort()) {
    const dir = path.join(extDir, name);
    const buildJs = path.join(dir, 'build.js');
    const mainJs = path.join(dir, 'src', 'main.js');
    if (!fs.existsSync(buildJs) || !fs.existsSync(mainJs)) continue;
    if (!isManagedBuild(fs.readFileSync(buildJs, 'utf8'))) continue;
    out.push({ name, dir, buildJs, srcDir: path.join(dir, 'src') });
  }
  return out;
}

function srcFilesOf(srcDir) {
  const files = [];
  for (const ent of fs.readdirSync(srcDir, { recursive: true, withFileTypes: true })) {
    if (ent.isFile() && ent.name.endsWith('.js')) files.push(path.join(ent.parentPath || ent.path, ent.name));
  }
  return files.sort();
}

// Content hash of a package's src tree (path + bytes), order-stable.
function srcHash(srcDir) {
  const h = crypto.createHash('sha256');
  for (const f of srcFilesOf(srcDir)) {
    h.update(path.relative(srcDir, f).split(path.sep).join('/'));
    h.update('\0');
    h.update(fs.readFileSync(f));
    h.update('\0');
  }
  return h.digest('hex');
}

// ── repo targets ──────────────────────────────────────────────────────────
// The non-@gcu/build root builds (auditable.html, works, works-all) can't be
// derived like packages — they're the multi-target bundler, not uniform @gcu/build
// wrappers — so they're declared. Each lists its build command + the input set
// whose change should retrigger it. Crucially auditable's inputs include every
// ext/*/index.js, so a PACKAGE rebuild → auditable rebuilds → works rebuild: the
// "forgot to rebuild the dependent" cascade, made automatic.

function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const ent of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (ent.isFile()) out.push(path.join(ent.parentPath || ent.path, ent.name));
  }
  return out;
}
function extBundles(root) {
  const ext = path.join(root, 'ext');
  if (!fs.existsSync(ext)) return [];
  return fs.readdirSync(ext).map((n) => path.join(ext, n, 'index.js')).filter((f) => fs.existsSync(f));
}
function hashFiles(files) {
  const h = crypto.createHash('sha256');
  for (const f of [...files].sort()) {
    h.update(f.split(path.sep).join('/')); h.update('\0');
    try { h.update(fs.readFileSync(f)); } catch { h.update('\0missing'); }
    h.update('\0');
  }
  return h.digest('hex');
}

export const REPO_TARGETS = [
  { name: 'auditable', out: 'auditable.html', cmd: ['build.js'], deps: [],
    inputs: (root) => [...filesUnder(path.join(root, 'src')), ...extBundles(root), path.join(root, 'build.js')] },
  { name: 'works', out: 'works.html', cmd: ['build.js', '--target=works'], deps: ['auditable'],
    inputs: (root) => [...filesUnder(path.join(root, 'works')), ...extBundles(root), path.join(root, 'auditable.html'), path.join(root, 'build.js')] },
  { name: 'works-all', out: 'works-all.html', cmd: ['build.js', '--target=works-all'], deps: ['auditable'],
    inputs: (root) => [...filesUnder(path.join(root, 'works')), ...extBundles(root), path.join(root, 'auditable.html'), path.join(root, 'build.js')] },
  // Editions (editions/auditable-<name>.html): the base notebook with a curated ext
  // set embedded for offline use. Built from build/auditable.html (written by the
  // auditable target) + the embedded ext bundles, so a change to any of those re-bakes
  // the edition. Reproducible (git-date build), so it's safe under --check.
  { name: 'auditable-py', out: 'editions/auditable-py.html', cmd: ['build.js', '--target=auditable-py'], deps: ['auditable'],
    inputs: (root) => [
      path.join(root, 'build', 'auditable.html'),
      path.join(root, 'ext/adder/index.js'), path.join(root, 'ext/plot/index.js'), path.join(root, 'ext/sadpan/index.js'),
      path.join(root, 'build.js'), path.join(root, 'make_example.js'),
    ] },
  // The 79 examples each embed a compressed copy of the runtime, so they go stale on
  // every auditable.html change — gen_examples.js reads build/auditable.html (the
  // cleartext sibling build.js also writes). out:null = many files, not one; the dir
  // always exists so it's input/dep-gated only. checkPaths feeds the --check drift
  // diff but excludes the crypto demo (re-encrypts with a random DEK/IV every run).
  { name: 'examples', out: null, cmd: ['gen_examples.js'], deps: ['auditable'],
    inputs: (root) => [
      ...filesUnder(path.join(root, 'examples', 'defs')),
      path.join(root, 'build', 'auditable.html'),
      path.join(root, 'gen_examples.js'),
      path.join(root, 'make_example.js'),
    ],
    checkPaths: [
      'examples/',
      ':(exclude)examples/basics/example_encrypted_password-is-auditable.html',
      ':(exclude)examples/basics/example_encrypted_password-is-auditable.recovery.txt',
    ] },
];

// Cross-package dependency edges, derived from source: a package depends on
// another managed package if its src imports it as `@gcu/<name>` (bare) or
// `../<name>/` (escaping-relative — the inline-primitive shape).
export function deriveEdges(pkgs) {
  const names = new Set(pkgs.map((p) => p.name));
  const edges = new Map(pkgs.map((p) => [p.name, new Set()]));
  // `@gcu/<name>` (bare) or `../…/<name>/` (escaping — one or more `../` segments,
  // then the package dir). The name class excludes '.' so `../../dimensions/` yields
  // 'dimensions', not the intervening '..'.
  const re = /from\s*['"](?:@gcu\/([a-z0-9-]+)|(?:\.\.\/)+([a-z0-9-]+)\/)/g;
  for (const p of pkgs) {
    for (const f of srcFilesOf(p.srcDir)) {
      const txt = fs.readFileSync(f, 'utf8');
      let m;
      while ((m = re.exec(txt))) {
        const dep = m[1] || m[2];
        if (dep && dep !== p.name && names.has(dep)) edges.get(p.name).add(dep);
      }
    }
  }
  return edges;
}

// Topological order (deps before dependents). Throws on a cycle.
export function topoOrder(pkgs, edges) {
  const indeg = new Map(pkgs.map((p) => [p.name, 0]));
  const dependents = new Map(pkgs.map((p) => [p.name, []]));
  for (const p of pkgs) for (const dep of edges.get(p.name)) { indeg.set(p.name, indeg.get(p.name) + 1); dependents.get(dep).push(p.name); }
  const queue = pkgs.map((p) => p.name).filter((n) => indeg.get(n) === 0).sort();
  const order = [];
  while (queue.length) {
    const n = queue.shift();
    order.push(n);
    for (const d of dependents.get(n)) { indeg.set(d, indeg.get(d) - 1); if (indeg.get(d) === 0) { queue.push(d); queue.sort(); } }
  }
  if (order.length !== pkgs.length) {
    const stuck = pkgs.map((p) => p.name).filter((n) => !order.includes(n));
    throw new Error(`gcu-make: dependency cycle among ${stuck.join(', ')}`);
  }
  return order;
}

const cachePath = (extDir) => path.join(extDir, '.gcu-make.cache.json');
function loadCache(extDir) { try { return JSON.parse(fs.readFileSync(cachePath(extDir), 'utf8')); } catch { return {}; } }
function saveCache(extDir, cache) { fs.writeFileSync(cachePath(extDir), JSON.stringify(cache, null, 2)); }

/**
 * Rebuild managed packages (then the repo targets) in dependency order, skipping
 * unchanged ones.
 * @param {{ extDir:string, only?:string[], force?:boolean, noTargets?:boolean,
 *           targets?:object[], log?:(s:string)=>void, run?:(pkg)=>void,
 *           runTarget?:(t)=>void }} opts
 *   run/runTarget — injectable runners (default: `node …`); tests stub them.
 *   A target is `{ name, out, cmd, deps, inputs(root), checkPaths? }`; out:null =
 *   many outputs (input/dep-gated only); checkPaths = git pathspecs for --check drift.
 * @returns {{ order, built, skipped, edges, targets:{order,built,skipped} }}
 */
export function make(opts) {
  const { extDir, only, force, log = () => {} } = opts;
  const root = path.resolve(extDir, '..');
  const run = opts.run || ((pkg) => execFileSync('node', [pkg.buildJs], { stdio: 'inherit' }));
  const runTarget = opts.runTarget || ((t) => execFileSync('node', t.cmd, { cwd: root, stdio: 'inherit' }));

  const pkgs = discover(extDir);
  const byName = new Map(pkgs.map((p) => [p.name, p]));
  const edges = deriveEdges(pkgs);
  const order = topoOrder(pkgs, edges);

  const wanted = only && only.length ? new Set(only) : null;
  const cache = force ? {} : loadCache(extDir);
  const dirty = new Map();
  const built = [], skipped = [];

  for (const name of order) {
    const pkg = byName.get(name);
    const hash = srcHash(pkg.srcDir);
    const depDirty = [...edges.get(name)].some((d) => dirty.get(d));
    const missing = !fs.existsSync(path.join(pkg.dir, 'index.js'));
    const isDirty = force || missing || cache[name] !== hash || depDirty;
    dirty.set(name, isDirty);

    if (wanted && !wanted.has(name) && !depDirty) { continue; } // out of scope this run
    if (isDirty) {
      log(`build ${name}`);
      run(pkg);
      cache[name] = hash;
      built.push(name);
    } else {
      log(`skip  ${name} (up to date)`);
      skipped.push(name);
    }
  }

  // ── repo targets (auditable.html → works → works-all). Run after packages so
  //    a package rebuild is reflected in auditable's input hash; targets in dep
  //    order so works sees a freshly-built auditable.html. ──
  const targets = opts.noTargets ? [] : (opts.targets || REPO_TARGETS);
  const tBuilt = [], tSkipped = [];
  for (const t of targets) {
    const hash = hashFiles(t.inputs(root));
    const depDirty = (t.deps || []).some((d) => dirty.get(d));
    const outMissing = t.out ? !fs.existsSync(path.join(root, t.out)) : false;
    const key = '#' + t.name;
    const isDirty = force || outMissing || cache[key] !== hash || depDirty;
    dirty.set(t.name, isDirty);
    if (isDirty) { log(`build ${t.name} (target)`); runTarget(t); cache[key] = hash; tBuilt.push(t.name); }
    else { log(`skip  ${t.name} (target, up to date)`); tSkipped.push(t.name); }
  }

  saveCache(extDir, cache);
  const edgesObj = Object.fromEntries([...edges].map(([k, v]) => [k, [...v]]));
  return { order, built, skipped, edges: edgesObj, targets: { order: targets.map((t) => t.name), built: tBuilt, skipped: tSkipped } };
}
