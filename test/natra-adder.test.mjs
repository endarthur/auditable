import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// ── shim DOM ──
globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: (tag) => ({
    tagName: tag.toUpperCase(), className: '', dataset: {}, style: {},
    innerHTML: '', textContent: '', children: [],
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  }),
  createTreeWalker: () => ({ nextNode: () => null, currentNode: null }),
};
globalThis.window = globalThis;
globalThis.CSS = { escape: s => s };

const { pythonExecute } = await import('../ext/adder/src/cell.js');
const { adderEval, AdderScope } = await import('../ext/adder/src/eval.js');
const { adderBuiltins } = await import('../ext/adder/src/builtins.js');
const { natraAdder } = await import('../ext/natra/adder.js');

// helper: run Python code and return defines + output
async function pyEval(code) {
  return pythonExecute(code, {}, { id: 'test' });
}

// helper: run Python code with upstream scope
async function pyEvalWith(code, scope) {
  return pythonExecute(code, scope, { id: 'test' });
}

// ═════════════════════════════════════════════════════════════════════
// Part 1: Adder prerequisites
// ═════════════════════════════════════════════════════════════════════

describe('reflected operators', () => {
  it('calls __radd__ when left operand is a scalar', async () => {
    const r = await pyEval(`
class Vec:
    def __init__(self, v):
        self.v = v
    def __radd__(self, other):
        return Vec(other + self.v)
x = Vec(10)
y = 5 + x
result = y.v
`);
    assert.equal(r.defines.result, 15);
  });

  it('calls __rmul__ when left operand is a scalar', async () => {
    const r = await pyEval(`
class W:
    def __init__(self, v):
        self.v = v
    def __rmul__(self, other):
        return W(other * self.v)
x = W(3)
y = 4 * x
result = y.v
`);
    assert.equal(r.defines.result, 12);
  });

  it('left dunder has priority over right rdunder', async () => {
    const r = await pyEval(`
class A:
    def __add__(self, other):
        return "left"
class B:
    def __radd__(self, other):
        return "right"
a = A()
b = B()
result = a + b
`);
    assert.equal(r.defines.result, 'left');
  });

  it('falls back to rdunder when left has no dunder', async () => {
    const r = await pyEval(`
class C:
    def __rsub__(self, other):
        return other * 10
c = C()
result = 7 - c
`);
    assert.equal(r.defines.result, 70);
  });
});

describe('matmul operator (@)', () => {
  it('dispatches to __matmul__', async () => {
    const r = await pyEval(`
class M:
    def __init__(self, v):
        self.v = v
    def __matmul__(self, other):
        return M(self.v * other.v)
a = M(3)
b = M(5)
c = a @ b
result = c.v
`);
    assert.equal(r.defines.result, 15);
  });

  it('dispatches to __rmatmul__ on right operand', async () => {
    const r = await pyEval(`
class N:
    def __rmatmul__(self, other):
        return other * 100
n = N()
result = 7 @ n
`);
    assert.equal(r.defines.result, 700);
  });

  it('raises TypeError when no dunder', async () => {
    await assert.rejects(() => pyEval('x = 3 @ 4'), /TypeError/);
  });
});

describe('abs() dunder', () => {
  it('calls __abs__ on objects', async () => {
    const r = await pyEval(`
class V:
    def __init__(self, v):
        self.v = v
    def __abs__(self):
        return V(self.v if self.v > 0 else -self.v)
x = V(-5)
y = abs(x)
result = y.v
`);
    assert.equal(r.defines.result, 5);
  });

  it('falls back to Math.abs for numbers', async () => {
    const r = await pyEval(`result = abs(-42)`);
    assert.equal(r.defines.result, 42);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Part 2: Cell hooks
// ═════════════════════════════════════════════════════════════════════

describe('cell hooks', () => {
  it('calls before/after hooks around cell execution', async () => {
    const log = [];
    window._adderCellHooks = window._adderCellHooks || [];
    const hook = {
      before(scope, cell) { log.push('before'); return 'state'; },
      after(state, defines, scope) { log.push(`after:${state}:${Object.keys(defines).join(',')}`); },
    };
    window._adderCellHooks.push(hook);
    try {
      await pyEval('x = 42');
      assert.deepStrictEqual(log, ['before', 'after:state:x']);
    } finally {
      window._adderCellHooks.splice(window._adderCellHooks.indexOf(hook), 1);
    }
  });

  it('calls after hooks even on error', async () => {
    const log = [];
    window._adderCellHooks = window._adderCellHooks || [];
    const hook = {
      before() { log.push('before'); return 'st'; },
      after(state) { log.push(`after:${state}`); },
    };
    window._adderCellHooks.push(hook);
    try {
      await assert.rejects(() => pyEval('raise ValueError("boom")'));
      assert.ok(log.includes('before'));
      assert.ok(log.includes('after:st'));
    } finally {
      window._adderCellHooks.splice(window._adderCellHooks.indexOf(hook), 1);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════
// Part 3+4: natra/adder integration
// ═════════════════════════════════════════════════════════════════════

describe('natra/adder module', () => {
  it('registers on window._auditableExtensions', () => {
    assert.ok(window._auditableExtensions['natra']);
  });

  it('import natra as np works', async () => {
    const r = await pyEval(`
import natra as np
a = await np.array([1, 2, 3])
result = a.tolist()
`);
    assert.deepStrictEqual(r.defines.result, [1, 2, 3]);
  });

  it('import natra as np works (alias)', async () => {
    const r = await pyEval(`
import natra as np
a = await np.zeros([3])
result = a.tolist()
`);
    assert.deepStrictEqual(r.defines.result, [0, 0, 0]);
  });
});

describe('array creation', () => {
  it('np.array from nested list', async () => {
    const r = await pyEval(`
import natra as np
a = await np.array([[1, 2], [3, 4]])
result = a.shape
`);
    assert.deepStrictEqual(r.defines.result, [2, 2]);
  });

  it('np.ones', async () => {
    const r = await pyEval(`
import natra as np
a = await np.ones([2, 3])
result = a.tolist()
`);
    assert.deepStrictEqual(r.defines.result, [[1, 1, 1], [1, 1, 1]]);
  });

  it('np.full', async () => {
    const r = await pyEval(`
import natra as np
a = await np.full([3], 7.0)
result = a.tolist()
`);
    assert.deepStrictEqual(r.defines.result, [7, 7, 7]);
  });

  it('np.eye', async () => {
    const r = await pyEval(`
import natra as np
a = await np.eye(3)
result = a.tolist()
`);
    assert.deepStrictEqual(r.defines.result, [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
  });

  it('np.linspace', async () => {
    const r = await pyEval(`
import natra as np
a = await np.linspace(0, 1, 5)
result = a.tolist()
`);
    assert.deepStrictEqual(r.defines.result, [0, 0.25, 0.5, 0.75, 1]);
  });

  it('np.arange', async () => {
    const r = await pyEval(`
import natra as np
a = await np.arange(0, 5)
result = a.tolist()
`);
    assert.deepStrictEqual(r.defines.result, [0, 1, 2, 3, 4]);
  });

  it('np.arange single arg', async () => {
    const r = await pyEval(`
import natra as np
a = await np.arange(4)
result = a.tolist()
`);
    assert.deepStrictEqual(r.defines.result, [0, 1, 2, 3]);
  });
});

describe('arithmetic operators', () => {
  it('a + b (array + array)', async () => {
    const r = await pyEval(`
import natra as np
a = await np.array([1, 2, 3])
b = await np.array([10, 20, 30])
c = a + b
result = c.tolist()
`);
    assert.deepStrictEqual(r.defines.result, [11, 22, 33]);
  });

  it('a + scalar (reflected)', async () => {
    const r = await pyEval(`
import natra as np
a = await np.array([1, 2, 3])
c = 10 + a
result = c.tolist()
`);
    assert.deepStrictEqual(r.defines.result, [11, 12, 13]);
  });

  it('a * scalar', async () => {
    const r = await pyEval(`
import natra as np
a = await np.array([1, 2, 3])
c = a * 2
result = c.tolist()
`);
    assert.deepStrictEqual(r.defines.result, [2, 4, 6]);
  });

  it('scalar * a (reflected)', async () => {
    const r = await pyEval(`
import natra as np
a = await np.array([1, 2, 3])
c = 3 * a
result = c.tolist()
`);
    assert.deepStrictEqual(r.defines.result, [3, 6, 9]);
  });

  it('a - b', async () => {
    const r = await pyEval(`
import natra as np
a = await np.array([10, 20, 30])
b = await np.array([1, 2, 3])
c = a - b
result = c.tolist()
`);
    assert.deepStrictEqual(r.defines.result, [9, 18, 27]);
  });

  it('scalar - a (reflected)', async () => {
    const r = await pyEval(`
import natra as np
a = await np.array([1, 2, 3])
c = 10 - a
result = c.tolist()
`);
    assert.deepStrictEqual(r.defines.result, [9, 8, 7]);
  });

  it('a / scalar', async () => {
    const r = await pyEval(`
import natra as np
a = await np.array([10, 20, 30])
c = a / 10
result = c.tolist()
`);
    assert.deepStrictEqual(r.defines.result, [1, 2, 3]);
  });

  it('-a (negation)', async () => {
    const r = await pyEval(`
import natra as np
a = await np.array([1, -2, 3])
c = -a
result = c.tolist()
`);
    assert.deepStrictEqual(r.defines.result, [-1, 2, -3]);
  });

  it('abs(a)', async () => {
    const r = await pyEval(`
import natra as np
a = await np.array([-1, 2, -3])
c = abs(a)
result = c.tolist()
`);
    assert.deepStrictEqual(r.defines.result, [1, 2, 3]);
  });
});

describe('matmul operator', () => {
  it('a @ b (matrix multiply)', async () => {
    const r = await pyEval(`
import natra as np
a = await np.array([[1, 2], [3, 4]])
b = await np.array([[5, 6], [7, 8]])
c = a @ b
result = c.tolist()
`);
    assert.deepStrictEqual(r.defines.result, [[19, 22], [43, 50]]);
  });
});

describe('comparison operators', () => {
  it('a > scalar returns mask', async () => {
    const r = await pyEval(`
import natra as np
a = await np.array([1, 5, 3, 7, 2])
mask = a > 3
result = mask.tolist()
`);
    assert.deepStrictEqual(r.defines.result, [0, 1, 0, 1, 0]);
  });

  it('a == b', async () => {
    const r = await pyEval(`
import natra as np
a = await np.array([1, 2, 3])
b = await np.array([1, 0, 3])
mask = a == b
result = mask.tolist()
`);
    assert.deepStrictEqual(r.defines.result, [1, 0, 1]);
  });
});

describe('math functions', () => {
  it('np.sqrt', async () => {
    const r = await pyEval(`
import natra as np
a = await np.array([1, 4, 9])
c = np.sqrt(a)
result = c.tolist()
`);
    assert.deepStrictEqual(r.defines.result, [1, 2, 3]);
  });

  it('np.sin', async () => {
    const r = await pyEval(`
import natra as np
import math
a = await np.array([0.0])
c = np.sin(a)
result = c.tolist()
`);
    assert.deepStrictEqual(r.defines.result, [0]);
  });

  it('np.exp', async () => {
    const r = await pyEval(`
import natra as np
a = await np.array([0.0])
c = np.exp(a)
result = c.tolist()
`);
    assert.deepStrictEqual(r.defines.result, [1]);
  });

  it('np.abs scalar passthrough', async () => {
    const r = await pyEval(`
import natra as np
result = np.abs(-5)
`);
    assert.equal(r.defines.result, 5);
  });
});

describe('reductions', () => {
  it('a.sum()', async () => {
    const r = await pyEval(`
import natra as np
a = await np.array([1, 2, 3, 4])
result = a.sum()
`);
    assert.equal(r.defines.result, 10);
  });

  it('a.mean()', async () => {
    const r = await pyEval(`
import natra as np
a = await np.array([2, 4, 6, 8])
result = a.mean()
`);
    assert.equal(r.defines.result, 5);
  });

  it('np.sum(a)', async () => {
    const r = await pyEval(`
import natra as np
a = await np.array([1, 2, 3])
result = np.sum(a)
`);
    assert.equal(r.defines.result, 6);
  });
});

describe('indexing and slicing', () => {
  it('a[0] returns scalar for 1D', async () => {
    const r = await pyEval(`
import natra as np
a = await np.array([10, 20, 30])
result = a[0]
`);
    assert.equal(r.defines.result, 10);
  });

  it('a[-1] negative indexing', async () => {
    const r = await pyEval(`
import natra as np
a = await np.array([10, 20, 30])
result = a[-1]
`);
    assert.equal(r.defines.result, 30);
  });

  it('a[0] returns row for 2D', async () => {
    const r = await pyEval(`
import natra as np
a = await np.array([[1, 2], [3, 4]])
row = a[0]
result = row.tolist()
`);
    assert.deepStrictEqual(r.defines.result, [1, 2]);
  });

  it('a[i][j] chained indexing', async () => {
    const r = await pyEval(`
import natra as np
a = await np.array([[1, 2], [3, 4]])
result = a[1][0]
`);
    assert.equal(r.defines.result, 3);
  });

  it('a[i] = val setitem', async () => {
    const r = await pyEval(`
import natra as np
a = await np.array([1, 2, 3])
a[1] = 99
result = a.tolist()
`);
    assert.deepStrictEqual(r.defines.result, [1, 99, 3]);
  });
});

describe('reshape and properties', () => {
  it('a.reshape()', async () => {
    const r = await pyEval(`
import natra as np
a = await np.array([1, 2, 3, 4, 5, 6])
b = a.reshape([2, 3])
result = b.shape
`);
    assert.deepStrictEqual(r.defines.result, [2, 3]);
  });

  it('a.flatten()', async () => {
    const r = await pyEval(`
import natra as np
a = await np.array([[1, 2], [3, 4]])
b = a.flatten()
result = b.tolist()
`);
    assert.deepStrictEqual(r.defines.result, [1, 2, 3, 4]);
  });

  it('a.T', async () => {
    const r = await pyEval(`
import natra as np
a = await np.array([[1, 2], [3, 4]])
b = a.T
result = b.shape
`);
    assert.deepStrictEqual(r.defines.result, [2, 2]);
  });

  it('a.ndim, a.size, a.dtype', async () => {
    const r = await pyEval(`
import natra as np
a = await np.array([[1, 2], [3, 4]])
ndim = a.ndim
size = a.size
dtype = a.dtype
`);
    assert.equal(r.defines.ndim, 2);
    assert.equal(r.defines.size, 4);
    assert.equal(r.defines.dtype, 'f64');
  });

  it('len(a) returns first dimension', async () => {
    const r = await pyEval(`
import natra as np
a = await np.array([[1, 2], [3, 4], [5, 6]])
result = len(a)
`);
    assert.equal(r.defines.result, 3);
  });
});

describe('linalg', () => {
  it('np.linalg.det', async () => {
    const r = await pyEval(`
import natra as np
a = await np.array([[1, 2], [3, 4]])
result = np.linalg.det(a)
`);
    assert.ok(Math.abs(r.defines.result - (-2)) < 1e-10);
  });

  it('np.linalg.inv', async () => {
    const r = await pyEval(`
import natra as np
a = await np.eye(3)
b = np.linalg.inv(a)
result = b.tolist()
`);
    assert.deepStrictEqual(r.defines.result, [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
  });

  it('np.linalg.norm for 1D', async () => {
    const r = await pyEval(`
import natra as np
a = await np.array([3, 4])
result = np.linalg.norm(a)
`);
    assert.ok(Math.abs(r.defines.result - 5) < 1e-10);
  });
});

describe('constants', () => {
  it('np.pi', async () => {
    const r = await pyEval(`
import natra as np
result = np.pi
`);
    assert.equal(r.defines.result, Math.PI);
  });

  it('np.e', async () => {
    const r = await pyEval(`
import natra as np
result = np.e
`);
    assert.equal(r.defines.result, Math.E);
  });
});

describe('display', () => {
  it('__repr__ returns string', async () => {
    const r = await pyEval(`
import natra as np
a = await np.array([1, 2, 3])
result = repr(a)
`);
    assert.ok(r.defines.result.includes('1'));
    assert.ok(r.defines.result.includes('3'));
  });
});

describe('iteration', () => {
  it('for x in array (1D)', async () => {
    const r = await pyEval(`
import natra as np
a = await np.array([10, 20, 30])
total = 0
for x in a:
    total += x
result = total
`);
    assert.equal(r.defines.result, 60);
  });
});

describe('copy', () => {
  it('a.copy() creates independent array', async () => {
    const r = await pyEval(`
import natra as np
a = await np.array([1, 2, 3])
b = a.copy()
b[0] = 99
result_a = a[0]
result_b = b[0]
`);
    assert.equal(r.defines.result_a, 1);
    assert.equal(r.defines.result_b, 99);
  });
});

describe('where', () => {
  it('np.where(cond, a, b)', async () => {
    const r = await pyEval(`
import natra as np
a = await np.array([1, 2, 3, 4, 5])
c = np.where(a > 3, a, await np.zeros([5]))
result = c.tolist()
`);
    assert.deepStrictEqual(r.defines.result, [0, 0, 0, 4, 5]);
  });
});
