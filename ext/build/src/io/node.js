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
  const parser = makeNodeParser();
  const result = bundleModules(sources, { entry, srcRoot, parser, header: opts.header, packageName, packageDesc, version, define: opts.define });

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
