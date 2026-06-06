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
// `srcRoot` (e.g. 'src'), the available source paths, and options.
//
//   { kind: 'internal', path }   — resolved path that exists in `sources`
//                                  (a src/ file OR an inlined dep — §4.2)
//   { kind: 'external', spec, out } — bare specifier (verbatim)
//
// opts: { inlineAliases: {spec→key}, lintEscaping: bool }
//   inlineAliases maps a bare specifier the host opted to inline (e.g.
//     '@gcu/dimensions') to its source key. Relative inlined deps don't need an
//     alias — the adapter keyed them so normal path arithmetic resolves them.
//   lintEscaping (default true, the phase-2 model): escaping-relative imports
//     that are NEITHER in src/ NOR inlined are an E002 error. Shared deps must
//     use `inline` (collision-safe), not escaping-relative coupling.
//
// Throws E002 (escaping, not inlined) / E003 / E004.
export function classify(spec, fromPath, srcRoot, sources, loc, opts = {}) {
  const inlineAliases = opts.inlineAliases || {};
  if (Object.prototype.hasOwnProperty.call(inlineAliases, spec)) {
    return { kind: 'internal', path: inlineAliases[spec] };
  }
  if (!isRelative(spec)) {
    return { kind: 'external', spec, out: spec };
  }
  const resolved = joinPath(dirOf(fromPath), spec);

  // In sources (a src/ file or an inlined dep the adapter read in) → internal.
  if (sources[resolved] !== undefined) {
    return { kind: 'internal', path: resolved };
  }

  const root = srcRoot || '';
  const insideRoot = root ? (resolved === root || resolved.startsWith(root + '/')) : !resolved.startsWith('..');
  if (!insideRoot) {
    // Escaping-relative and not inlined. The phase-2 model rejects this (E002);
    // `lintEscaping: false` restores §4's pass-through (rewritten external).
    if (opts.lintEscaping === false) {
      return { kind: 'external', spec, out: rewriteSpec(spec, fromPath, srcRoot) };
    }
    throw buildError('E002', `relative import '${spec}' escapes src/ and is not inlined — use the inline option for shared deps (SPEC §4.2)`, loc);
  }

  // Inside root but absent — diagnose the likely cause.
  const last = spec.slice(spec.lastIndexOf('/') + 1);
  if (!last.includes('.')) {
    throw buildError('E003', `extension-less import '${spec}' — explicit extensions required`, loc);
  }
  throw buildError('E004', `cannot resolve '${spec}' from ${fromPath}`, loc);
}
