// _findScopedSpecifiers regex coverage.
//
// Regression for the multi-segment specifier bug: secondary entries
// like `@gcu/carotte/adder` (the adder.js bridge pattern used across
// the GCU adapter family) were getting truncated to `@gcu/carotte` by
// the rewriter. The literal `@gcu/carotte/adder` then survived into
// the blob URL → V8 "Failed to resolve module specifier" at import.
//
// modules.js as a whole can't be imported in plain Node (the works
// import-map alias `#licenses` doesn't resolve here), so this duplicates
// the regex inline. Keep it in sync with cell-builtins/modules.js's
// _findScopedSpecifiers.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

function findScopedSpecifiers(source) {
  const re = /(?:from|import)\s*\(?\s*["'](@[\w.-]+\/[\w.-]+(?:\/[\w.-]+)*)["']/g;
  const specs = new Set();
  let m;
  while ((m = re.exec(source)) !== null) specs.add(m[1]);
  return specs;
}

describe('_findScopedSpecifiers — module loader path resolver', () => {
  it('captures two-segment paths (the @scope/name common case)', () => {
    const src = `import { x } from "@gcu/foo";`;
    assert.deepEqual([...findScopedSpecifiers(src)], ['@gcu/foo']);
  });

  it('captures three-segment paths (secondary-entry bridge pattern)', () => {
    const src = `import { Workflow } from "@gcu/carotte/adder";`;
    assert.deepEqual([...findScopedSpecifiers(src)], ['@gcu/carotte/adder']);
  });

  it('captures dynamic imports of three-segment paths', () => {
    const src = `const m = await import("@gcu/carotte/adder");`;
    assert.deepEqual([...findScopedSpecifiers(src)], ['@gcu/carotte/adder']);
  });

  it('captures four+ segment paths too', () => {
    const src = `import { x } from "@gcu/foo/bar/baz";`;
    assert.deepEqual([...findScopedSpecifiers(src)], ['@gcu/foo/bar/baz']);
  });

  it('captures multiple specifiers in one source', () => {
    const src = `
      import { x } from "@gcu/foo";
      import { y } from "@gcu/bar/baz";
      const m = await import("@gcu/foo");
    `;
    assert.deepEqual([...findScopedSpecifiers(src)].sort(), ['@gcu/bar/baz', '@gcu/foo']);
  });

  it('ignores @-scope text not preceded by import / from', () => {
    const src = `
      // just talking about @gcu/foo in a comment
      const url = "@gcu/foo";  // literal string, not an import
    `;
    assert.equal(findScopedSpecifiers(src).size, 0);
  });

  it('ignores non-scoped specifiers', () => {
    const src = `import { x } from "react";`;
    assert.equal(findScopedSpecifiers(src).size, 0);
  });

  it('handles single-quote variants', () => {
    const src = `import { x } from '@gcu/carotte/adder';`;
    assert.deepEqual([...findScopedSpecifiers(src)], ['@gcu/carotte/adder']);
  });
});
