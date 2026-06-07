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

// Cross-package dependency edges, derived from source: a package depends on
// another managed package if its src imports it as `@gcu/<name>` (bare) or
// `../<name>/` (escaping-relative — the inline-primitive shape).
export function deriveEdges(pkgs) {
  const names = new Set(pkgs.map((p) => p.name));
  const edges = new Map(pkgs.map((p) => [p.name, new Set()]));
  const re = /from\s*['"](?:@gcu\/([a-z0-9.-]+)|\.\.\/([a-z0-9.-]+)\/)/g;
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
 * Rebuild managed packages in dependency order, skipping unchanged ones.
 * @param {{ extDir:string, only?:string[], force?:boolean, log?:(s:string)=>void,
 *           run?:(pkg)=>void }} opts
 *   run — injectable runner (default: `node <build.js>`); tests stub it.
 * @returns {{ order:string[], built:string[], skipped:string[], edges:object }}
 */
export function make(opts) {
  const { extDir, only, force, log = () => {} } = opts;
  const run = opts.run || ((pkg) => execFileSync('node', [pkg.buildJs], { stdio: 'inherit' }));

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

  saveCache(extDir, cache);
  const edgesObj = Object.fromEntries([...edges].map(([k, v]) => [k, [...v]]));
  return { order, built, skipped, edges: edgesObj };
}
