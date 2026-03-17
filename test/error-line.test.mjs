import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Detect line offset the same way exec.js does
let _lineOffset = 0;
try {
  const fn = new Function('"use strict";\nthrow new Error();\n//# sourceURL=auditable://_probe.js');
  fn();
} catch (e) {
  const m = e.stack?.match(/auditable:\/\/_probe\.js:(\d+)/);
  if (m) _lineOffset = parseInt(m[1], 10) - 1;
}
if (!_lineOffset) _lineOffset = 3;

// Copy of cellErrorLine from exec.js
function cellErrorLine(err, cellId) {
  const tag = 'auditable://cell-' + cellId;
  if (err.stack) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = err.stack.match(new RegExp(escaped + '[^:]*:(\\d+)'));
    if (m) { const n = parseInt(m[1], 10) - _lineOffset; if (n > 0) return n; }
  }
  if (err.message) {
    const m = err.message.match(/\((\d+):(\d+)\)\s*$/) || err.message.match(/line (\d+)/i);
    if (m) { const n = parseInt(m[1], 10) - _lineOffset; if (n > 0) return n; }
  }
  return 0;
}

describe('cellErrorLine', () => {
  const cellId = 'abc123';

  it('extracts line from Chrome/Edge runtime stack trace', () => {
    const err = new Error('x is not defined');
    // simulate: cell line 4, offset by _lineOffset
    const rawLine = 4 + _lineOffset;
    err.stack = `ReferenceError: x is not defined
    at eval (auditable://cell-abc123.js:${rawLine}:1)`;
    assert.equal(cellErrorLine(err, cellId), 4);
  });

  it('extracts line from Firefox-style stack trace', () => {
    const err = new Error('x is not defined');
    const rawLine = 6 + _lineOffset;
    err.stack = `@auditable://cell-abc123.js:${rawLine}:15
@debugger eval code:1:1`;
    assert.equal(cellErrorLine(err, cellId), 6);
  });

  it('extracts line from named cell sourceURL', () => {
    const err = new Error('oops');
    const rawLine = 2 + _lineOffset;
    err.stack = `Error: oops
    at eval (auditable://cell-abc123-my-cell.js:${rawLine}:10)`;
    assert.equal(cellErrorLine(err, cellId), 2);
  });

  it('returns 0 when no line info available', () => {
    const err = new Error('something went wrong');
    err.stack = 'Error: something went wrong\n    at Object.<anonymous>';
    assert.equal(cellErrorLine(err, cellId), 0);
  });

  it('returns 0 when line maps to preamble', () => {
    const err = new Error('bad');
    err.stack = `Error: bad
    at eval (auditable://cell-abc123.js:1:1)`;
    assert.equal(cellErrorLine(err, cellId), 0);
  });

  it('ignores stack traces from other cells', () => {
    const err = new Error('x is not defined');
    err.stack = `ReferenceError: x is not defined
    at eval (auditable://cell-other999.js:${5 + _lineOffset}:1)`;
    assert.equal(cellErrorLine(err, cellId), 0);
  });

  it('handles real AsyncFunction runtime errors', async () => {
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
    const id = 'test42';
    const fn = new AsyncFunction(
      `"use strict";\nconst a = 1;\nconst b = 2;\nundefined_var;\n` +
      `//# sourceURL=auditable://cell-${id}.js`
    );
    try {
      await fn();
      assert.fail('should have thrown');
    } catch (e) {
      const line = cellErrorLine(e, id);
      // undefined_var is on line 4 of cell code (after "use strict")
      // "use strict" is line 1 of body, undefined_var is line 4
      // cell line = 4 - 1 = 3 (subtract 1 for "use strict", not _lineOffset,
      // because _lineOffset covers the function header too)
      // Actually: raw line in stack = 4 + _lineOffset - 1 (because "use strict" is part of body)
      // Wait, let's just check: the body is '"use strict";\nconst a = 1;\nconst b = 2;\nundefined_var;\n'
      // body line 1: "use strict"  → cell line 0 (preamble)
      // body line 2: const a = 1   → cell line 1
      // body line 3: const b = 2   → cell line 2
      // body line 4: undefined_var → cell line 3
      // Raw stack line = body line + (header lines) = 4 + (_lineOffset - 1) ← because "use strict" is body line 1
      // cellErrorLine subtracts _lineOffset, so: (4 + _lineOffset - 1) - _lineOffset = 3
      assert.equal(line, 3);
    }
  });

  it('handles multi-line cell code with error on last line', async () => {
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
    const id = 'multi';
    const fn = new AsyncFunction(
      `"use strict";\nconst a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nfoo_bar;\n` +
      `//# sourceURL=auditable://cell-${id}.js`
    );
    try {
      await fn();
      assert.fail('should have thrown');
    } catch (e) {
      assert.equal(cellErrorLine(e, id), 5);
    }
  });

  it('handles error on first line of cell code', async () => {
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
    const id = 'first';
    const fn = new AsyncFunction(
      `"use strict";\nbad_var;\n` +
      `//# sourceURL=auditable://cell-${id}.js`
    );
    try {
      await fn();
      assert.fail('should have thrown');
    } catch (e) {
      assert.equal(cellErrorLine(e, id), 1);
    }
  });
});
