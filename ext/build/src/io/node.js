// @gcu/build — node-fs adapter (SPEC §1.4, §13.1)
//
// bundle(opts): read the package's src/, call the pure core, write outputs.
// Manifest *walking* is core-side; the adapter just reads every source file
// under srcRoot into memory and hands the core a complete { path: source } map.
// Anything the core resolves outside srcRoot stays external (verbatim) and is
// never read here.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { bundleModules } from '../core.js';
import { makeNodeParser } from './parser-node.js';

// Relative import/export-from specifiers in a source (cheap regex pre-scan; the
// core re-validates with the AST). Used to follow an inlined dep's own deps.
function relativeSpecsOf(src) {
  const out = [];
  const re = /(?:^|\n)\s*(?:import|export)\b[^\n]*?from\s*['"](\.[^'"]+)['"]/g;
  const re2 = /(?:^|\n)\s*import\s*['"](\.[^'"]+)['"]/g; // side-effect import
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  while ((m = re2.exec(src))) out.push(m[1]);
  return out;
}

// Resolve the inline list (§4.2) into extra sources + a bare→key alias map.
// Each entry is a bare '@gcu/x' (→ ext/x/src/main.js) or a path relative to the
// package dir. The dep's own relative deps are followed transitively. Files are
// keyed by their path relative to `dir` (POSIX) so the host's escaping-relative
// imports and inter-dep imports resolve to them via normal path arithmetic.
function resolveInline(dir, inlineList) {
  const sources = {};
  const aliases = {};
  const visited = new Set();
  const keyFor = (abs) => path.relative(dir, abs).split(path.sep).join('/');
  function readClosure(abs) {
    const key = keyFor(abs);
    if (visited.has(abs)) return key;
    visited.add(abs);
    const src = fs.readFileSync(abs, 'utf8');
    sources[key] = src;
    for (const spec of relativeSpecsOf(src)) {
      readClosure(path.resolve(path.dirname(abs), spec));
    }
    return key;
  }
  for (const entry of inlineList) {
    let abs;
    if (entry.startsWith('.')) {
      abs = path.resolve(dir, entry);
    } else if (entry.startsWith('@gcu/')) {
      abs = path.join(path.dirname(dir), entry.slice('@gcu/'.length), 'src', 'main.js');
    } else {
      throw new Error(`gcu-build: cannot resolve inline entry '${entry}' (expected @gcu/<name> or a relative path)`);
    }
    const key = readClosure(abs);
    if (!entry.startsWith('.')) aliases[entry] = key;
  }
  return { sources, aliases };
}

function readSrcTree(dir, srcRoot) {
  const absRoot = path.join(dir, srcRoot);
  const sources = {};
  const entries = fs.readdirSync(absRoot, { recursive: true, withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!ent.name.endsWith('.js')) continue;
    const abs = path.join(ent.parentPath || ent.path, ent.name);
    const rel = path.relative(dir, abs).split(path.sep).join('/');
    sources[rel] = fs.readFileSync(abs, 'utf8');
  }
  return sources;
}

/**
 * @param {{ dir?:string, entry?:string, outFile?:string, write?:boolean,
 *           meta?:boolean, header?:string, packageName?:string, packageDesc?:string }} opts
 * @returns {{ code, map, meta, warnings, outPath:string|null }}
 */
export function bundle(opts = {}) {
  const dir = opts.dir || process.cwd();
  const entry = opts.entry || 'src/main.js';
  const srcRoot = entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/')) : 'src';
  const write = opts.write !== false;

  // package.json metadata for the header (best-effort).
  let packageName = opts.packageName;
  let packageDesc = opts.packageDesc;
  let version = opts.version;
  if (packageName === undefined || packageDesc === undefined || version === undefined) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (packageName === undefined) packageName = pkg.name || '';
      if (packageDesc === undefined) packageDesc = pkg.description || '';
      if (version === undefined) version = pkg.version || null;
    } catch { /* no package.json — header omits the name line */ }
  }

  const sources = readSrcTree(dir, srcRoot);
  let inlineAliases;
  if (opts.inline && opts.inline.length) {
    const { sources: inlineSources, aliases } = resolveInline(dir, opts.inline);
    Object.assign(sources, inlineSources);
    inlineAliases = aliases;
  }
  const parser = makeNodeParser();
  const result = bundleModules(sources, {
    entry, srcRoot, parser, header: opts.header, packageName, packageDesc, version,
    define: opts.define, inlineAliases, lintEscaping: opts.lintEscaping,
  });

  // fill the bundleHash the pure core left null (it has no hash primitive).
  result.meta.bundleHash = 'sha256-' + crypto.createHash('sha256').update(result.code).digest('hex');

  let outPath = null;
  if (write) {
    outPath = path.join(dir, opts.outFile || 'index.js');
    fs.writeFileSync(outPath, result.code);
    if (opts.meta !== false) {
      fs.writeFileSync(path.join(dir, 'index.meta.json'), JSON.stringify(result.meta, null, 2));
    }
  }
  return { ...result, outPath };
}
