// @gcu/build — annotation extraction (SPEC §5)
//
// Block comments immediately preceding a top-level declaration:
//   /* @bundle-share */     — binding is intentionally shared; never renamed on
//                             collision (collision with any other decl → E007).
//   /* @bundle-verbatim */  — declaration body emitted unchanged (identifiers
//                             within it are not rewritten); the top binding still
//                             participates in collision detection.
//
// air's parseModule doesn't attach comments, so we text-scan the gap before each
// declaration — cheap and exact for the "immediately preceding block comment" rule.

import { declaredNames } from './rewrite.js';

// The block comment immediately preceding `start` (only whitespace between the
// comment's `*/` and `start`), or null.
function leadingBlockComment(source, start) {
  let i = start - 1;
  while (i >= 0 && /\s/.test(source[i])) i--;
  if (i < 1 || source[i] !== '/' || source[i - 1] !== '*') return null; // not a `*/`
  const open = source.lastIndexOf('/*', i - 2);
  if (open < 0) return null;
  return source.slice(open + 2, i - 1);
}

/**
 * @returns {{ shared: Set<string>, verbatimRanges: Array<[number,number]> }}
 */
export function collectAnnotations(ast, source) {
  const shared = new Set();
  const verbatimRanges = [];
  for (const node of ast.body) {
    const decl = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
    if (!decl) continue;
    if (decl.type !== 'VariableDeclaration' && decl.type !== 'FunctionDeclaration' && decl.type !== 'ClassDeclaration') continue;
    const comment = leadingBlockComment(source, node.start);
    if (!comment) continue;
    if (/@bundle-share\b/.test(comment)) for (const n of declaredNames(decl)) shared.add(n);
    if (/@bundle-verbatim\b/.test(comment)) verbatimRanges.push([decl.start, decl.end]);
  }
  return { shared, verbatimRanges };
}
