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
import { parse as parseYaml } from '../yaml/index.js';

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

function hashFiles(files) {
  const h = crypto.createHash('sha256');
  for (const f of [...files].sort()) {
    h.update(f.split(path.sep).join('/')); h.update('\0');
    try { h.update(fs.readFileSync(f)); } catch { h.update('\0missing'); }
    h.update('\0');
  }
  return h.digest('hex');
}

// ── targets (make.yaml) ─────────────────────────────────────────────────────
// The non-@gcu/build root builds (auditable.html → works/works-all + editions +
// examples) can't be derived like packages — they're the multi-target bundler,
// not uniform @gcu/build wrappers — so they're DECLARED, in a per-root make.yaml.
// Managed @gcu/build packages stay auto-discovered + edge-derived; you only write
// down the irreducible non-derivable part. Crucially auditable's inputs include
// every ext/*/index.js, so a PACKAGE rebuild → auditable rebuilds → works rebuild:
// the "forgot to rebuild the dependent" cascade, made automatic.
//
// Moving these out of make.js is what makes @gcu/make a GENERIC bin: any repo (a
// wasm4 game, catra, ep) drops a make.yaml and gets the incremental + drift engine.

// Accepted makefile names, in resolution order. `make.yaml` is canonical (it pairs
// with the `make` command the way package.json pairs with npm); the others are
// recognized aliases.
export const MAKEFILE_NAMES = ['make.yaml', 'gcu-make.yaml', 'makefile.yaml'];

// Find the root's makefile. First-found wins; warns if more than one is present.
export function findMakefile(root, log = () => {}) {
  const present = MAKEFILE_NAMES.filter((n) => fs.existsSync(path.join(root, n)));
  if (present.length > 1) log(`multiple makefiles present (${present.join(', ')}); using ${present[0]}`);
  return present.length ? path.join(root, present[0]) : null;
}

// Minimal glob → matched files, relative to root. Supports `**` (any depth,
// crosses `/`), `*`/`?` (within a segment), and literal paths (existence check,
// no walk). Each pattern walks only its literal-prefix subtree, so resolving
// `src/**` touches src/ — not the whole repo (no .git/node_modules traversal).
function globToRegExp(pat) {
  let re = '';
  const s = pat.replace(/\\/g, '/');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '*') {
      if (s[i + 1] === '*') { re += '.*'; i++; if (s[i + 1] === '/') i++; } // ** (optionally **/)
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('.+^${}()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}
function* walkFiles(dir) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walkFiles(fp);
    else if (ent.isFile()) yield fp;
  }
}
export function globFiles(root, patterns) {
  const out = new Set();
  for (const pat of patterns || []) {
    if (!/[*?]/.test(pat)) { // literal path — no walk
      const fp = path.join(root, pat);
      if (fs.existsSync(fp) && fs.statSync(fp).isFile()) out.add(fp);
      continue;
    }
    const re = globToRegExp(pat);
    const pre = [];
    for (const seg of pat.split('/')) { if (/[*?]/.test(seg)) break; pre.push(seg); }
    const base = path.join(root, ...pre);
    if (!fs.existsSync(base)) continue;
    const start = fs.statSync(base).isDirectory() ? base : path.dirname(base);
    for (const f of walkFiles(start)) {
      const rel = path.relative(root, f).split(path.sep).join('/');
      if (re.test(rel)) out.add(f);
    }
  }
  return [...out];
}

// Load declared targets from the root's make.yaml. Returns the same target shape
// the engine consumes ({ name, out, cmd, deps, inputs(root), checkPaths }), with
// glob `inputs:` resolved through globFiles and `check:` mapped to checkPaths.
// Returns null when no makefile exists (→ a generic repo runs packages only).
// @gcu/yaml's parse() returns an AST (node tree); collapse it to a plain JS value.
function yamlToJS(node) {
  if (!node) return null;
  if (node.kind === 'scalar') return node.value;
  if (node.kind === 'seq') return node.items.map(yamlToJS);
  if (node.kind === 'map') return Object.fromEntries(node.entries.map((e) => [yamlToJS(e.key), yamlToJS(e.value)]));
  return null;
}
export function loadTargets(root, log = () => {}) {
  const mk = findMakefile(root, log);
  if (!mk) return null;
  const doc = yamlToJS(parseYaml(fs.readFileSync(mk, 'utf8')));
  const targets = (doc && doc.targets) || {};
  return Object.entries(targets).map(([name, t]) => ({
    name,
    out: t.out ?? null,
    cmd: t.cmd,
    deps: t.deps || [],
    inputs: (r) => globFiles(r, t.inputs),
    checkPaths: t.check,
  }));
}

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
  // A target's cmd is a full argv whose first element is the executable
  // (e.g. ['node', 'build.js', '--target=works']) — so make.yaml can drive any
  // toolchain, not just node.
  const runTarget = opts.runTarget || ((t) => execFileSync(t.cmd[0], t.cmd.slice(1), { cwd: root, stdio: 'inherit' }));

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
  const targets = opts.noTargets ? [] : (opts.targets || loadTargets(root, log) || []);
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
