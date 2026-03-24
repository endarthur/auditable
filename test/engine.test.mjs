import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// engine.js has ZERO DOM dependencies — no document shim needed
import {
  INJECTED_NAMES, TaggedContent, taggedTemplate, cellErrorLine,
  compileCellCode, cellCacheKey, executeCellCode, executeDAG
} from '../src/js/engine.js';

describe('engine: INJECTED_NAMES', () => {
  it('is a non-empty array of strings', () => {
    assert.ok(Array.isArray(INJECTED_NAMES));
    assert.ok(INJECTED_NAMES.length > 0);
    assert.ok(INJECTED_NAMES.every(n => typeof n === 'string'));
  });

  it('includes core builtins', () => {
    for (const name of ['ui', 'std', 'load', 'display', 'print']) {
      assert.ok(INJECTED_NAMES.includes(name), `missing ${name}`);
    }
  });
});

describe('engine: TaggedContent', () => {
  it('stores type and content', () => {
    const tc = new TaggedContent('md', '# hello');
    assert.equal(tc.type, 'md');
    assert.equal(tc.content, '# hello');
  });

  it('toString returns content', () => {
    const tc = new TaggedContent('html', '<b>hi</b>');
    assert.equal(String(tc), '<b>hi</b>');
  });
});

describe('engine: taggedTemplate', () => {
  it('creates TaggedContent from template literal', () => {
    const md = taggedTemplate('md');
    const result = md`hello ${'world'}`;
    assert.ok(result instanceof TaggedContent);
    assert.equal(result.type, 'md');
    assert.equal(result.content, 'hello world');
  });
});

describe('engine: cellErrorLine', () => {
  it('extracts line from stack trace', () => {
    const err = new Error('test');
    // use a real AsyncFunction to get a real stack trace
    const AF = Object.getPrototypeOf(async function(){}).constructor;
    const id = 'test42';
    const fn = new AF(
      `"use strict";\nconst a = 1;\nbad_var;\n` +
      `//# sourceURL=auditable://cell-${id}.js`
    );
    return fn().catch(e => {
      const line = cellErrorLine(e, id);
      assert.ok(line > 0, `expected positive line, got ${line}`);
    });
  });

  it('returns 0 for unrelated stack', () => {
    const err = new Error('nope');
    err.stack = 'Error: nope\n    at Object.<anonymous>';
    assert.equal(cellErrorLine(err, 'xyz'), 0);
  });
});

describe('engine: compileCellCode', () => {
  it('compiles simple code into AsyncFunction', () => {
    const fn = compileCellCode('const x = 1', [], 'x', 0, null);
    assert.equal(typeof fn, 'function');
  });

  it('compiles with scope parameters', () => {
    const fn = compileCellCode('const z = a + b', ['a', 'b'], 'z', 1, null);
    assert.equal(typeof fn, 'function');
  });

  it('includes cell name in sourceURL', () => {
    const fn = compileCellCode('const x = 1', [], 'x', 5, 'my-cell');
    assert.equal(typeof fn, 'function');
  });
});

describe('engine: cellCacheKey', () => {
  it('produces deterministic key', () => {
    const k1 = cellCacheKey(['a', 'b'], 'x, y', 'const x = a');
    const k2 = cellCacheKey(['a', 'b'], 'x, y', 'const x = a');
    assert.equal(k1, k2);
  });

  it('changes with different code', () => {
    const k1 = cellCacheKey([], 'x', 'const x = 1');
    const k2 = cellCacheKey([], 'x', 'const x = 2');
    assert.notEqual(k1, k2);
  });
});

describe('engine: executeCellCode', () => {
  it('executes and returns defines', async () => {
    const fn = compileCellCode('const x = 1', [], 'x', 0, null);
    const injected = new Array(INJECTED_NAMES.length).fill(undefined);
    const { defines, error } = await executeCellCode(fn, [], injected);
    assert.equal(error, null);
    assert.equal(defines.x, 1);
  });

  it('returns multiple defines', async () => {
    const fn = compileCellCode('const a = 10; const b = 20', [], 'a, b', 0, null);
    const injected = new Array(INJECTED_NAMES.length).fill(undefined);
    const { defines, error } = await executeCellCode(fn, [], injected);
    assert.equal(error, null);
    assert.equal(defines.a, 10);
    assert.equal(defines.b, 20);
  });

  it('uses scope parameters', async () => {
    const fn = compileCellCode('const z = a + b', ['a', 'b'], 'z', 0, null);
    const injected = new Array(INJECTED_NAMES.length).fill(undefined);
    const { defines, error } = await executeCellCode(fn, [3, 7], injected);
    assert.equal(error, null);
    assert.equal(defines.z, 10);
  });

  it('captures errors', async () => {
    const fn = compileCellCode('throw new Error("boom")', [], '', 0, null);
    const injected = new Array(INJECTED_NAMES.length).fill(undefined);
    const { defines, error } = await executeCellCode(fn, [], injected);
    assert.ok(error);
    assert.equal(error.message, 'boom');
  });

  it('captures syntax errors', async () => {
    try {
      compileCellCode('const = ;', [], '', 0, null);
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e instanceof SyntaxError);
    }
  });

  it('passes injected values', async () => {
    // 'display' is at index 7 in INJECTED_NAMES
    const displayIdx = INJECTED_NAMES.indexOf('display');
    const captured = [];
    const injected = new Array(INJECTED_NAMES.length).fill(undefined);
    injected[displayIdx] = (...args) => captured.push(...args);
    const fn = compileCellCode('display("hello")', [], '', 0, null);
    await executeCellCode(fn, [], injected);
    assert.deepEqual(captured, ['hello']);
  });
});

describe('engine: executeDAG', () => {
  function makeCell(id, type, code, defines = [], uses = []) {
    return {
      id, type, code,
      collapsed: false,
      defines: new Set(defines),
      uses: new Set(uses),
      error: null,
      _lastResult: null,
      _prevInputs: null,
      _blocked: false,
      _inputs: {},
      _fallback: false,
    };
  }

  it('executes code cells and builds scope', async () => {
    const cells = [
      makeCell(0, 'code', 'const x = 10', ['x']),
      makeCell(1, 'code', 'const y = x * 2', ['y'], ['x']),
    ];
    const scope = {};
    const execLog = [];

    await executeDAG(cells, [0, 1], new Set([0, 1]), scope, {
      onExecCode: async (cell) => {
        execLog.push(cell.id);
        if (cell.id === 0) {
          cell._lastResult = { x: 10 };
          cell.error = null;
          return { defines: { x: 10 }, error: null };
        } else {
          const y = scope.x * 2;
          cell._lastResult = { y };
          cell.error = null;
          return { defines: { y }, error: null };
        }
      },
      onExecHtml: () => {},
      onExecMd: () => {},
      checkGeneration: () => true,
    });

    assert.deepEqual(execLog, [0, 1]);
    assert.equal(scope.x, 10);
    assert.equal(scope.y, 20);
  });

  it('skips CSS cells', async () => {
    const cells = [
      makeCell(0, 'css', 'body { color: red }'),
    ];
    const scope = {};
    const execLog = [];

    await executeDAG(cells, [0], new Set([0]), scope, {
      onExecCode: async () => { execLog.push('code'); return { defines: {}, error: null }; },
      onExecHtml: () => execLog.push('html'),
      onExecMd: () => execLog.push('md'),
      checkGeneration: () => true,
    });

    assert.deepEqual(execLog, []);
  });

  it('skips manual cells unless in dirtyIds', async () => {
    const cells = [
      makeCell(0, 'code', '// %manual\nconst x = 1', ['x']),
    ];
    const scope = {};
    const execLog = [];
    const statusLog = [];

    await executeDAG(cells, [], new Set([0]), scope, {
      onExecCode: async () => { execLog.push(0); return { defines: { x: 1 }, error: null }; },
      onExecHtml: () => {},
      onExecMd: () => {},
      onCellStatus: (cell, status) => statusLog.push({ id: cell.id, status }),
      checkGeneration: () => true,
    });

    assert.deepEqual(execLog, []);
    assert.deepEqual(statusLog, [{ id: 0, status: 'stale' }]);
  });

  it('executes manual cells when in dirtyIds', async () => {
    const cells = [
      makeCell(0, 'code', '// %manual\nconst x = 1', ['x']),
    ];
    const scope = {};
    const execLog = [];

    await executeDAG(cells, [0], new Set([0]), scope, {
      onExecCode: async (cell) => {
        execLog.push(cell.id);
        cell._lastResult = { x: 1 };
        cell.error = null;
        return { defines: { x: 1 }, error: null };
      },
      onExecHtml: () => {},
      onExecMd: () => {},
      checkGeneration: () => true,
    });

    assert.deepEqual(execLog, [0]);
    assert.equal(scope.x, 1);
  });

  it('poisons downstream on error', async () => {
    const cells = [
      makeCell(0, 'code', 'const x = 1', ['x']),
      makeCell(1, 'code', 'const y = x + 1', ['y'], ['x']),
    ];
    const scope = {};
    const statusLog = [];

    const result = await executeDAG(cells, [0, 1], new Set([0, 1]), scope, {
      onExecCode: async (cell) => {
        if (cell.id === 0) {
          cell.error = 'boom';
          return { defines: {}, error: new Error('boom') };
        }
        return { defines: { y: 2 }, error: null };
      },
      onExecHtml: () => {},
      onExecMd: () => {},
      onCellStatus: (cell, status) => statusLog.push({ id: cell.id, status }),
      checkGeneration: () => true,
    });

    assert.ok(result.poisoned.has('x'));
    assert.deepEqual(statusLog, [{ id: 1, status: 'blocked' }]);
    assert.equal(scope.y, undefined);
  });

  it('restores cached results for cells not in runSet', async () => {
    const cells = [
      makeCell(0, 'code', 'const x = 10', ['x']),
      makeCell(1, 'code', 'const y = x + 1', ['y'], ['x']),
    ];
    cells[0]._lastResult = { x: 10 };
    cells[1]._lastResult = { y: 11 };

    const scope = {};
    const execLog = [];

    // only cell 0 is in runSet, cell 1 should restore from cache
    await executeDAG(cells, [0], new Set([0]), scope, {
      onExecCode: async (cell) => {
        execLog.push(cell.id);
        cell._lastResult = { x: 10 };
        cell.error = null;
        return { defines: { x: 10 }, error: null };
      },
      onExecHtml: () => {},
      onExecMd: () => {},
      checkGeneration: () => true,
    });

    assert.deepEqual(execLog, [0]);
    assert.equal(scope.x, 10);
    assert.equal(scope.y, 11); // restored from cache
  });

  it('aborts when checkGeneration returns false', async () => {
    const cells = [
      makeCell(0, 'code', 'const x = 1', ['x']),
      makeCell(1, 'code', 'const y = 2', ['y']),
    ];
    const scope = {};
    const execLog = [];

    const result = await executeDAG(cells, [0, 1], new Set([0, 1]), scope, {
      onExecCode: async (cell) => {
        execLog.push(cell.id);
        cell._lastResult = { [cell.id === 0 ? 'x' : 'y']: cell.id + 1 };
        cell.error = null;
        return { defines: cell._lastResult, error: null };
      },
      onExecHtml: () => {},
      onExecMd: () => {},
      checkGeneration: () => execLog.length < 1, // abort after first cell
    });

    assert.ok(result.aborted);
    assert.deepEqual(execLog, [0]);
  });

  it('skips norun cells unless in dirtyIds', async () => {
    const cells = [
      makeCell(0, 'code', '// %norun\nconst x = 1', ['x']),
    ];
    const scope = {};
    const execLog = [];

    await executeDAG(cells, [], new Set([0]), scope, {
      onExecCode: async () => { execLog.push(0); return { defines: {}, error: null }; },
      onExecHtml: () => {},
      onExecMd: () => {},
      checkGeneration: () => true,
    });

    assert.deepEqual(execLog, []);
  });

  it('calls onExecHtml for html cells', async () => {
    const cells = [
      makeCell(0, 'html', '<div>${x}</div>', [], ['x']),
    ];
    const scope = {};
    const htmlLog = [];

    await executeDAG(cells, [0], new Set([0]), scope, {
      onExecCode: async () => ({ defines: {}, error: null }),
      onExecHtml: (cell) => htmlLog.push(cell.id),
      onExecMd: () => {},
      checkGeneration: () => true,
    });

    assert.deepEqual(htmlLog, [0]);
  });

  it('calls onExecMd for markdown cells', async () => {
    const cells = [
      makeCell(0, 'md', '# Hello'),
    ];
    const scope = {};
    const mdLog = [];

    await executeDAG(cells, [0], new Set([0]), scope, {
      onExecCode: async () => ({ defines: {}, error: null }),
      onExecHtml: () => {},
      onExecMd: (cell) => mdLog.push(cell.id),
      checkGeneration: () => true,
    });

    assert.deepEqual(mdLog, [0]);
  });

  it('value-equality gating skips unchanged inputs', async () => {
    const cells = [
      makeCell(0, 'code', 'const x = 10', ['x']),
      makeCell(1, 'code', 'const y = x + 1', ['y'], ['x']),
    ];
    // simulate previous run
    cells[0]._lastResult = { x: 10 };
    cells[1]._lastResult = { y: 11 };
    cells[1]._prevInputs = { x: 10 };
    cells[1].error = null;
    cells[1]._blocked = false;

    const scope = {};
    const execLog = [];

    // cell 0 is dirty, cell 1 is downstream but inputs unchanged
    await executeDAG(cells, [0], new Set([0, 1]), scope, {
      onExecCode: async (cell) => {
        execLog.push(cell.id);
        cell._lastResult = { x: 10 };
        cell.error = null;
        return { defines: { x: 10 }, error: null };
      },
      onExecHtml: () => {},
      onExecMd: () => {},
      checkGeneration: () => true,
    });

    // cell 1 should be skipped because x didn't change
    assert.deepEqual(execLog, [0]);
    assert.equal(scope.y, 11); // restored from cache
  });

  it('injects HTML widget values into scope', async () => {
    const cells = [
      makeCell(0, 'html', '<audit-slider name="power">', ['power']),
      makeCell(1, 'code', 'const doubled = power * 2', ['doubled'], ['power']),
    ];
    cells[0]._inputs = { power: 50 };

    const scope = {};
    const execLog = [];

    await executeDAG(cells, [0, 1], new Set([0, 1]), scope, {
      onExecCode: async (cell) => {
        execLog.push(cell.id);
        const doubled = scope.power * 2;
        cell._lastResult = { doubled };
        cell.error = null;
        return { defines: { doubled }, error: null };
      },
      onExecHtml: () => {},
      onExecMd: () => {},
      checkGeneration: () => true,
    });

    assert.equal(scope.power, 50);
    assert.equal(scope.doubled, 100);
  });
});
