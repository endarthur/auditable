// @gcu/build — @gcu/vfs adapter (SPEC §1.4)
//
// Build inside Works / geas, in-browser, over the workspace VFS. The pure core
// runs unchanged; this adapter just reads sources from a VFS and writes outputs
// back. With it, the GCU desktop builds its own packages with no node/toolchain
// — the self-hosting "owned all the way down" property at the bottom.
//
// VFS contract used: async readFile(p,'utf8'), readdir(p)→names, stat(p)→{type},
// writeFile(p, content). bundleHash uses crypto.subtle (async, browser-native).

import { bundleModules } from '../core.js';

const noSlash = (p) => p.replace(/\/+$/, '');
const join = (a, b) => noSlash(a) + '/' + b.replace(/^\/+/, '');

// POSIX relative path between two absolute dirs/files.
function relApath(from, to) {
  const f = from.split('/').filter(Boolean);
  const t = to.split('/').filter(Boolean);
  let i = 0;
  while (i < f.length && i < t.length && f[i] === t[i]) i++;
  return [...f.slice(i).map(() => '..'), ...t.slice(i)].join('/');
}

// Relative import/export-from specifiers (cheap regex; the core re-validates).
function relativeSpecsOf(src) {
  const out = [];
  const re = /(?:^|\n)\s*(?:import|export)\b[^\n]*?from\s*['"](\.[^'"]+)['"]/g;
  const re2 = /(?:^|\n)\s*import\s*['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  while ((m = re2.exec(src))) out.push(m[1]);
  return out;
}

async function readTree(vfs, absRoot, dir, sources) {
  let names;
  try { names = await vfs.readdir(absRoot); } catch { return; }
  for (const name of names) {
    const child = join(absRoot, name);
    const st = await vfs.stat(child);
    if (st.type === 'directory') await readTree(vfs, child, dir, sources);
    else if (name.endsWith('.js')) sources[relApath(dir, child)] = await vfs.readFile(child, 'utf8');
  }
}

async function resolveInlineVfs(vfs, dir, inlineList) {
  const sources = {};
  const aliases = {};
  const visited = new Set();
  const libRoot = dir.slice(0, noSlash(dir).lastIndexOf('/')); // sibling-of-package root
  async function readClosure(abs) {
    const key = relApath(dir, abs);
    if (visited.has(abs)) return key;
    visited.add(abs);
    const src = await vfs.readFile(abs, 'utf8');
    sources[key] = src;
    for (const spec of relativeSpecsOf(src)) {
      const childDir = abs.slice(0, abs.lastIndexOf('/'));
      // resolve spec against childDir
      const parts = childDir.split('/').filter(Boolean);
      for (const seg of spec.split('/')) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') parts.pop(); else parts.push(seg);
      }
      await readClosure('/' + parts.join('/'));
    }
    return key;
  }
  for (const entry of inlineList) {
    let abs;
    if (entry.startsWith('.')) {
      const parts = noSlash(dir).split('/').filter(Boolean);
      for (const seg of entry.split('/')) { if (seg === '' || seg === '.') continue; if (seg === '..') parts.pop(); else parts.push(seg); }
      abs = '/' + parts.join('/');
    } else if (entry.startsWith('@gcu/')) {
      abs = join(join(libRoot, entry.slice('@gcu/'.length)), 'src/main.js');
    } else {
      throw new Error(`gcu-build: cannot resolve inline entry '${entry}' (expected @gcu/<name> or a relative path)`);
    }
    const key = await readClosure(abs);
    if (!entry.startsWith('.')) aliases[entry] = key;
  }
  return { sources, aliases };
}

async function sha256Hex(s) {
  const bytes = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {object} vfs  a @gcu/vfs instance (async readFile/readdir/stat/writeFile)
 * @param {{ dir:string, entry?:string, outFile?:string, write?:boolean, meta?:boolean,
 *           parser?:object, header?:string, define?:object, inline?:string[],
 *           lintEscaping?:boolean, packageName?:string, packageDesc?:string, version?:string }} opts
 *   dir — absolute package directory in the VFS (e.g. '/projects/over').
 * @returns {Promise<{code,map,meta,warnings,outPath:string|null}>}
 */
export async function bundleVfs(vfs, opts = {}) {
  const dir = noSlash(opts.dir);
  const entry = opts.entry || 'src/main.js';
  const srcRoot = entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/')) : 'src';
  const write = opts.write !== false;

  let packageName = opts.packageName;
  let packageDesc = opts.packageDesc;
  let version = opts.version;
  if (packageName === undefined || packageDesc === undefined || version === undefined) {
    try {
      const pkg = JSON.parse(await vfs.readFile(join(dir, 'package.json'), 'utf8'));
      if (packageName === undefined) packageName = pkg.name || '';
      if (packageDesc === undefined) packageDesc = pkg.description || '';
      if (version === undefined) version = pkg.version || null;
    } catch { /* no package.json */ }
  }

  const sources = {};
  await readTree(vfs, join(dir, srcRoot), dir, sources);

  let inlineAliases;
  if (opts.inline && opts.inline.length) {
    const { sources: inlineSources, aliases } = await resolveInlineVfs(vfs, dir, opts.inline);
    Object.assign(sources, inlineSources);
    inlineAliases = aliases;
  }

  const result = bundleModules(sources, {
    entry, srcRoot, parser: opts.parser, header: opts.header,
    packageName, packageDesc, version, define: opts.define, inlineAliases, lintEscaping: opts.lintEscaping,
  });
  result.meta.bundleHash = 'sha256-' + await sha256Hex(result.code);

  let outPath = null;
  if (write) {
    outPath = join(dir, opts.outFile || 'index.js');
    await vfs.writeFile(outPath, result.code);
    if (opts.meta !== false) await vfs.writeFile(join(dir, 'index.meta.json'), JSON.stringify(result.meta, null, 2));
  }
  return { ...result, outPath };
}
