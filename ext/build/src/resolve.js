// @gcu/build — module resolution (SPEC §4)
//
// Two rules:
//   1. Relative imports ('./x.js', '../lib/y.js') resolving INSIDE the package's
//      src/ are inlined. Extensions must be explicit; no directory-index inference.
//   2. Bare specifiers ('@gcu/air', 'acorn') and relative imports that ESCAPE src/
//      are external — preserved in the output (with their path rewritten relative
//      to the OUTPUT file location; see rewriteSpec).
//
// Resolution is path-string arithmetic only (no fs). The adapter supplies the
// set of known source paths; the core never touches disk. Paths are POSIX-style
// (forward slashes), normalized by the adapter before reaching here.

import { buildError } from './errors.js';

export function dirOf(p) { return p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''; }

// POSIX join + normalize that PRESERVES leading '..' segments (paths above the
// base root), so an import escaping the package is representable as a relative
// specifier. e.g. joinPath('src', '../../air/src/types.js') → '../air/src/types.js'.
export function joinPath(baseDir, spec) {
  const parts = baseDir ? baseDir.split('/').filter((s) => s && s !== '.') : [];
  for (const seg of spec.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length && parts[parts.length - 1] !== '..') parts.pop();
      else parts.push('..');
    } else parts.push(seg);
  }
  return parts.join('/');
}

export function isRelative(spec) {
  return spec.startsWith('./') || spec.startsWith('../');
}

// The output bundle lives at the parent of srcRoot (package root). An escaping
// external whose path is computed relative to the source file's dir would have
// the wrong number of '../' once concatenated into the root-level index.js.
// Recompute it relative to the package root (= output dir).
export function rewriteSpec(spec, fromPath, srcRoot) {
  if (!isRelative(spec)) return spec; // bare specifier — verbatim
  let resolved = joinPath(dirOf(fromPath), spec); // relative to package root
  if (!resolved.startsWith('.')) resolved = './' + resolved;
  return resolved;
}

// Classify an import specifier as seen from `fromPath`, given the package's
// `srcRoot` (e.g. 'src') and the set of available source paths.
//
//   { kind: 'internal', path }   — resolved path that exists in `sources`
//   { kind: 'external', spec, out } — bare or escaping-relative; `out` is the
//                                     specifier rewritten for the output location
//
// Throws E003/E004 for extension-less / directory-index / missing forms.
export function classify(spec, fromPath, srcRoot, sources, loc) {
  if (!isRelative(spec)) {
    return { kind: 'external', spec, out: spec };
  }
  const resolved = joinPath(dirOf(fromPath), spec);

  // Escaping src/ → external (verbatim, path rewritten). The lint rule that
  // makes this an ERROR (E002) is phase 2; phase 1 honors §4's pass-through.
  const root = srcRoot || '';
  const insideRoot = root ? (resolved === root || resolved.startsWith(root + '/')) : !resolved.startsWith('..');
  if (!insideRoot) {
    return { kind: 'external', spec, out: rewriteSpec(spec, fromPath, srcRoot) };
  }

  if (sources[resolved] !== undefined) {
    return { kind: 'internal', path: resolved };
  }

  // Inside root but absent — diagnose the likely cause.
  const last = spec.slice(spec.lastIndexOf('/') + 1);
  if (!last.includes('.')) {
    throw buildError('E003', `extension-less import '${spec}' — explicit extensions required`, loc);
  }
  throw buildError('E004', `cannot resolve '${spec}' from ${fromPath}`, loc);
}
