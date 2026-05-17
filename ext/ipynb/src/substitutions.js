// Import-rewrite table and Python source rewriter.
//
// Maps Python scientific-stack package names to their @gcu/* equivalents.
// The rewriter recognizes four Python import shapes and rewrites the
// PACKAGE part only; the `as alias` and the imported-names list are
// preserved verbatim so user code continues to use `np`, `pd`, `plt`
// without further changes.
//
// Shapes handled:
//   import X                       →  import Y
//   import X as alias              →  import Y as alias
//   import X.sub (as alias)?       →  import Y.sub (as alias)?   (when X is in table)
//                                  →  import V (as alias)?       (when X.sub is in table — e.g. matplotlib.pyplot)
//   from X import a, b             →  from Y import a, b
//   from X.sub import a            →  from Y.sub import a        (when X is in table)
//                                  →  from V import a            (when X.sub is in table)
//
// Comma-separated `import X, Y` is split and each segment rewritten
// independently. Unknown packages pass through unchanged — the runtime
// will raise ModuleNotFoundError, which is the honest signal for "this
// dependency isn't in the GCU stack yet."

export const SUBSTITUTIONS = {
  // Numerical core. natra is ndarray-by-design — has array(), elementwise
  // ops, broadcasting, axis reductions. line lacks the ergonomic ndarray
  // surface (see ROADMAP "line adder adapter that covers numpy basics").
  'numpy': 'natra',

  // DataFrames. sadpan is the auditable-side pandas equivalent.
  'pandas': 'sadpan',

  // Scientific routines. scitra is pandas-shaped (scipy.shaped, actually).
  'scipy': 'scitra',

  // sklearn → learn. The estimator API contract matches.
  'sklearn': 'learn',

  // Plotting. matplotlib.pyplot is the entry point users actually call
  // (`plt.plot(...)`, `plt.show()`); we map the full dotted form, not
  // bare 'matplotlib'. @gcu/plot registers under the name `plt` in
  // adder's extension table, so we map directly to `plt`. After the
  // `as plt` alias is preserved, `import matplotlib.pyplot as plt`
  // becomes `import plt as plt` (effectively `import plt`), giving the
  // user the same `plt.plot(...)` handle they'd write in Jupyter.
  'matplotlib.pyplot': 'plt',
};

// Rewrite all import lines in a Python source string. Returns the
// rewritten source plus a list of {original, rewritten, type} records
// for any substitution that fired (used by callers that want to surface
// the rewrites — e.g. a banner cell on import).
export function rewriteImports(source) {
  const lines = source.split('\n');
  const rewrites = [];
  const out = [];
  for (const line of lines) {
    const { rewritten, applied } = rewriteImportLine(line);
    out.push(rewritten);
    if (applied) rewrites.push(...applied);
  }
  return { source: out.join('\n'), rewrites };
}

// Single-line rewriter. Handles `from X import …` and `import X[, X2]`
// shapes; preserves indentation and trailing comments.
export function rewriteImportLine(line) {
  // Preserve leading whitespace (so `    import numpy` inside a function
  // stays at the same indent).
  const indentMatch = line.match(/^(\s*)/);
  const indent = indentMatch ? indentMatch[1] : '';
  const body = line.slice(indent.length);

  // Capture trailing comment for round-trip preservation.
  // We don't honor `#` inside a string literal — Python imports never
  // contain string literals, so this is safe in practice.
  let comment = '';
  const hashAt = body.indexOf('#');
  let code = body;
  if (hashAt >= 0) {
    code = body.slice(0, hashAt).trimEnd();
    comment = body.slice(hashAt);
    if (comment) comment = ' ' + comment;
  }

  // `from X import ...`
  let m = code.match(/^from\s+([\w.]+)\s+import\s+(.+?)\s*$/);
  if (m) {
    const pkg = m[1];
    const rest = m[2];
    const replacement = substitutePackage(pkg);
    if (replacement === null) return { rewritten: line, applied: null };
    return {
      rewritten: `${indent}from ${replacement} import ${rest}${comment}`,
      applied: [{ original: pkg, rewritten: replacement, type: 'from' }],
    };
  }

  // `import X [as A][, Y [as B], …]`
  m = code.match(/^import\s+(.+?)\s*$/);
  if (m) {
    const segments = splitImportSegments(m[1]);
    const newSegs = [];
    const applied = [];
    let anyChange = false;
    for (const seg of segments) {
      const segMatch = seg.match(/^([\w.]+)(\s+as\s+\w+)?$/);
      if (!segMatch) { newSegs.push(seg); continue; }
      const pkg = segMatch[1];
      let asPart = segMatch[2] || '';
      const replacement = substitutePackage(pkg);
      if (replacement === null) {
        newSegs.push(seg);
        continue;
      }
      // Preserve the user's original name binding when no `as` alias
      // was provided. `import scipy` rewritten to `import scitra` would
      // lose the `scipy` name in scope, breaking later code that
      // references `scipy.linalg.lu(...)`. Adding `as scipy` keeps the
      // user's reference name working — only applies to bare (non-
      // dotted) module names since `as foo.bar` isn't valid syntax.
      if (!asPart && !pkg.includes('.')) {
        asPart = ` as ${pkg}`;
      }
      newSegs.push(`${replacement}${asPart}`);
      applied.push({ original: pkg, rewritten: replacement, type: 'import' });
      anyChange = true;
    }
    if (!anyChange) return { rewritten: line, applied: null };
    return {
      rewritten: `${indent}import ${newSegs.join(', ')}${comment}`,
      applied,
    };
  }

  return { rewritten: line, applied: null };
}

// Given a dotted package path, return its substitution (longest matching
// prefix in the table) or null if no substitution applies. So:
//   substitutePackage('matplotlib.pyplot')  → 'plot'    (exact key)
//   substitutePackage('numpy.linalg')       → 'natra.linalg'  (numpy → natra, .linalg kept)
//   substitutePackage('matplotlib')         → null     (no entry, no prefix matches)
function substitutePackage(pkg) {
  if (pkg in SUBSTITUTIONS) return SUBSTITUTIONS[pkg];
  // Try progressively shorter prefixes.
  const parts = pkg.split('.');
  for (let n = parts.length - 1; n >= 1; n--) {
    const prefix = parts.slice(0, n).join('.');
    if (prefix in SUBSTITUTIONS) {
      const rest = parts.slice(n).join('.');
      return `${SUBSTITUTIONS[prefix]}.${rest}`;
    }
  }
  return null;
}

// Split a comma-separated import list, respecting nothing fancy (no
// parens — `import (a, b)` isn't valid Python anyway). Trims each
// segment so `import a , b` produces ['a', 'b'].
function splitImportSegments(s) {
  return s.split(',').map(x => x.trim()).filter(Boolean);
}
