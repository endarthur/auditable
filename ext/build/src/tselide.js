// @gcu/build — TypeScript annotation elision (SPEC §18 phase 2, §14)
//
// acorn-typescript is already vendored (air parses `: i32` hints with it), so
// elision is cheap: "don't emit the annotation nodes." NOT a type-aware
// transform — purely deletes type syntax, leaving runnable JS. A no-op on the
// vanilla-JS ext/* sources; present for completeness + TS-authored extensions.
//
// Returns { patches, ranges }: delete patches for type syntax, and the deleted
// ranges so the caller can drop rename/define patches that land inside a type
// (e.g. a type reference sharing a name with a renamed value binding).

const KEEP_EXPR_SUFFIX = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression']);

export function collectTsElision(ast) {
  const patches = [];
  const ranges = [];
  const del = (start, end) => { if (end > start) { patches.push({ start, end, text: '' }); ranges.push([start, end]); } };

  function walk(node) {
    if (!node || typeof node.type !== 'string') return;
    const t = node.type;

    if (KEEP_EXPR_SUFFIX.has(t)) {
      // `expr as T` / `expr satisfies T` / `expr!` — keep expr, drop the suffix.
      del(node.expression.end, node.end);
      walk(node.expression);
      return;
    }
    if (t === 'TSTypeAssertion') {
      // `<T>expr` — drop the prefix.
      del(node.start, node.expression.start);
      walk(node.expression);
      return;
    }
    if (t.startsWith('TS')) {
      // pure type syntax (annotations, aliases, interfaces, type params, …)
      del(node.start, node.end);
      return; // all children are types — don't recurse
    }

    for (const k in node) {
      if (k === 'type' || k === 'loc' || k === 'start' || k === 'end' || k === 'range') continue;
      const v = node[k];
      if (Array.isArray(v)) { for (const c of v) walk(c); }
      else if (v && typeof v.type === 'string') walk(v);
    }
  }

  for (const n of ast.body) walk(n);
  return { patches, ranges };
}
