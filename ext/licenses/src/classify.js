// classify(id|expression) → 'permissive' | 'weak-copyleft' | 'strong-copyleft' | 'unknown'
//
// Composition rules:
//   AND — must comply with all → take the MOST RESTRICTIVE classification
//   OR  — caller picks one     → take the MOST PERMISSIVE classification
//   WITH — preserves the base classification (the exception is a carve-out
//          to the same license; it doesn't change the broad kind)
//   "+"  — preserves the base classification (or-later semantics)
//
// "Unknown" is treated as maximally restrictive: in AND it dominates (we can't
// reason about it), in OR it loses to any known permissive option (a rational
// caller picks the known-safe license).

import { SPDX_CORPUS, SPDX_KINDS, canonicalize, validateSpdx } from './spdx.js';

// Severity ordering — higher = more restrictive / less attractive.
const SEVERITY = {
  permissive: 0,
  'weak-copyleft': 1,
  'strong-copyleft': 2,
  unknown: 3,
};

const FROM_SEVERITY = ['permissive', 'weak-copyleft', 'strong-copyleft', 'unknown'];

function kindOfId(id) {
  const canonical = canonicalize(id);
  if (!canonical) return SPDX_KINDS.UNKNOWN;
  return SPDX_CORPUS[canonical].kind;
}

// Walk an AST node (as produced by parseSpdx) and return the kind.
export function classifyExpression(ast) {
  if (!ast || typeof ast !== 'object') return SPDX_KINDS.UNKNOWN;
  switch (ast.kind) {
    case 'id':
      return kindOfId(ast.id);
    case 'plus':
      return classifyExpression(ast.term);
    case 'with':
      // The exception carves out specific permissions; the base license kind
      // is what governs reciprocity expectations. Classpath exception on
      // GPL-3.0 is still strong-copyleft for our warning purposes.
      return classifyExpression(ast.term);
    case 'and': {
      // Most restrictive (max severity).
      let worst = -1;
      for (const t of ast.terms) {
        const sev = SEVERITY[classifyExpression(t)];
        if (sev > worst) worst = sev;
      }
      return worst < 0 ? SPDX_KINDS.UNKNOWN : FROM_SEVERITY[worst];
    }
    case 'or': {
      // Most permissive (min severity).
      let best = Infinity;
      for (const t of ast.terms) {
        const sev = SEVERITY[classifyExpression(t)];
        if (sev < best) best = sev;
      }
      return !isFinite(best) ? SPDX_KINDS.UNKNOWN : FROM_SEVERITY[best];
    }
    default:
      return SPDX_KINDS.UNKNOWN;
  }
}

// classify accepts either a bare SPDX id, an SPDX expression string, or null.
// Returns the same four-way verdict regardless of input shape.
export function classify(input) {
  if (input == null) return SPDX_KINDS.UNKNOWN;
  if (typeof input !== 'string') return SPDX_KINDS.UNKNOWN;
  const trimmed = input.trim();
  if (!trimmed) return SPDX_KINDS.UNKNOWN;

  // Fast path — bare id with no operators.
  if (/^[A-Za-z0-9][A-Za-z0-9.\-]*$/.test(trimmed)) {
    return kindOfId(trimmed);
  }

  // Expression path — parse + walk.
  const parsed = validateSpdx(trimmed);
  if (!parsed.valid) return SPDX_KINDS.UNKNOWN;
  return classifyExpression(parsed.ast);
}
