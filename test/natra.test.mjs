import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { natra } from '../ext/natra/index.js';

// ═════════════════════════════════════════════════════════════════════
// Context creation
// ═════════════════════════════════════════════════════════════════════

describe('context', () => {
  it('creates a context with default pages', async () => {
    const ctx = await natra();
    assert.ok(ctx.memory instanceof WebAssembly.Memory);
  });

  it('creates a context with custom pages', async () => {
    const ctx = await natra({ pages: 4 });
    assert.ok(ctx.memory.buffer.byteLength >= 4 * 65536);
  });

  it('accepts an existing memory', async () => {
    const mem = new WebAssembly.Memory({ initial: 2 });
    const ctx = await natra({ memory: mem });
    assert.equal(ctx.memory, mem);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Array creation
// ═════════════════════════════════════════════════════════════════════

describe('array creation', () => {
  it('creates from flat array', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([1, 2, 3]);
    assert.deepStrictEqual(a.shape, [3]);
    assert.equal(a.ndim, 1);
    assert.equal(a.length, 3);
    assert.equal(a.dtype, 'f64');
    assert.equal(a.itemsize, 8);
    assert.equal(a.nbytes, 24);
  });

  it('creates from nested array', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([[1, 2], [3, 4]]);
    assert.deepStrictEqual(a.shape, [2, 2]);
    assert.equal(a.ndim, 2);
    assert.equal(a.length, 4);
  });

  it('creates from 3D nested array', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([[[1, 2], [3, 4]], [[5, 6], [7, 8]]]);
    assert.deepStrictEqual(a.shape, [2, 2, 2]);
    assert.equal(a.ndim, 3);
    assert.equal(a.length, 8);
  });

  it('creates from flat array with explicit shape', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([1, 2, 3, 4, 5, 6], { shape: [2, 3] });
    assert.deepStrictEqual(a.shape, [2, 3]);
    assert.equal(a.length, 6);
  });

  it('has row-major contiguous strides', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([[1, 2, 3], [4, 5, 6]]);
    // shape [2,3]: strides should be [3*8, 8] = [24, 8]
    assert.deepStrictEqual(a.strides, [24, 8]);
  });

  it('ndarray is frozen', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([1, 2, 3]);
    assert.ok(Object.isFrozen(a));
    assert.ok(Object.isFrozen(a.shape));
    assert.ok(Object.isFrozen(a.strides));
  });

  it('zeros', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.zeros([3, 3]);
    assert.deepStrictEqual(a.shape, [3, 3]);
    const data = ctx.toArray(a);
    assert.deepStrictEqual(data, [[0, 0, 0], [0, 0, 0], [0, 0, 0]]);
  });

  it('ones', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.ones([2, 3]);
    const data = ctx.toArray(a);
    assert.deepStrictEqual(data, [[1, 1, 1], [1, 1, 1]]);
  });

  it('full', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.full([2, 2], 7.5);
    const data = ctx.toArray(a);
    assert.deepStrictEqual(data, [[7.5, 7.5], [7.5, 7.5]]);
  });

  it('eye', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.eye(3);
    const data = ctx.toArray(a);
    assert.deepStrictEqual(data, [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
  });

  it('linspace', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.linspace(0, 1, 5);
    const data = ctx.toArray(a);
    assert.deepStrictEqual(data, [0, 0.25, 0.5, 0.75, 1]);
  });

  it('linspace single point', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.linspace(5, 5, 1);
    assert.deepStrictEqual(ctx.toArray(a), [5]);
  });

  it('arange', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.arange(0, 5);
    assert.deepStrictEqual(ctx.toArray(a), [0, 1, 2, 3, 4]);
  });

  it('arange with step', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.arange(0, 1, 0.25);
    const data = ctx.toArray(a);
    assert.equal(data.length, 4);
    assert.ok(Math.abs(data[0] - 0) < 1e-15);
    assert.ok(Math.abs(data[1] - 0.25) < 1e-15);
    assert.ok(Math.abs(data[2] - 0.5) < 1e-15);
    assert.ok(Math.abs(data[3] - 0.75) < 1e-15);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Data access
// ═════════════════════════════════════════════════════════════════════

describe('data access', () => {
  it('toArray roundtrip 1D', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([10, 20, 30]);
    assert.deepStrictEqual(ctx.toArray(a), [10, 20, 30]);
  });

  it('toArray roundtrip 2D', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([[1, 2], [3, 4]]);
    assert.deepStrictEqual(ctx.toArray(a), [[1, 2], [3, 4]]);
  });

  it('toTypedArray returns a Float64Array view', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([1, 2, 3]);
    const view = ctx.toTypedArray(a);
    assert.ok(view instanceof Float64Array);
    assert.equal(view.length, 3);
    assert.equal(view[0], 1);
    assert.equal(view[1], 2);
    assert.equal(view[2], 3);
  });

  it('toTypedArray is a live view', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([1, 2, 3]);
    const view = ctx.toTypedArray(a);
    // Modify via view
    view[0] = 99;
    assert.equal(ctx.get(a, 0), 99);
  });

  it('get individual elements', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([[10, 20], [30, 40]]);
    assert.equal(ctx.get(a, 0, 0), 10);
    assert.equal(ctx.get(a, 0, 1), 20);
    assert.equal(ctx.get(a, 1, 0), 30);
    assert.equal(ctx.get(a, 1, 1), 40);
  });

  it('set individual elements', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([[0, 0], [0, 0]]);
    ctx.set(a, 99, 1, 0);
    assert.equal(ctx.get(a, 1, 0), 99);
  });

  it('copy creates independent array', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([1, 2, 3]);
    const b = ctx.copy(a);
    assert.deepStrictEqual(ctx.toArray(b), [1, 2, 3]);
    assert.notEqual(a.ptr, b.ptr);
    // Modify original, copy unchanged
    ctx.set(a, 99, 0);
    assert.equal(ctx.get(b, 0), 1);
  });

  it('get/set throws on wrong index count', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([[1, 2], [3, 4]]);
    assert.throws(() => ctx.get(a, 0), /Expected 2 indices/);
    assert.throws(() => ctx.set(a, 0, 1), /Expected 2 indices/);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Scope / arena
// ═════════════════════════════════════════════════════════════════════

describe('scope', () => {
  it('returned array survives scope', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([1, 2, 3]);
    const B = ctx.array([4, 5, 6]);
    const C = ctx.scope(s => s.add(A, B));
    assert.deepStrictEqual(ctx.toArray(C), [5, 7, 9]);
    assert.equal(C._arena, null); // promoted to permanent
  });

  it('scratch is reclaimed after scope', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([1, 2, 3]);
    const B = ctx.array([4, 5, 6]);

    // Record memory before scope
    const C = ctx.scope(s => {
      const temp1 = s.add(A, B);    // scratch
      const temp2 = s.mul(temp1, A); // scratch
      return temp2;                   // promoted
    });

    // C should be valid
    assert.deepStrictEqual(ctx.toArray(C), [5, 14, 27]);

    // Creating another array should reuse reclaimed scratch space
    const D = ctx.array([10, 20, 30]);
    assert.deepStrictEqual(ctx.toArray(D), [10, 20, 30]);
    // D should not overlap with C
    assert.ok(D.ptr >= C.ptr + C.nbytes || D.ptr + D.nbytes <= C.ptr);
  });

  it('scope returning scalar', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([1, 2, 3, 4]);
    const sum = ctx.scope(s => s.sum(A));
    assert.equal(sum, 10);
  });

  it('scope returning null/undefined', async () => {
    const ctx = await natra({ pages: 1 });
    const r = ctx.scope(s => {});
    assert.equal(r, undefined);
  });

  it('scope returning array of results', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([1, 2, 3]);
    const B = ctx.array([4, 5, 6]);
    const [sum, diff] = ctx.scope(s => [s.add(A, B), s.sub(A, B)]);
    assert.deepStrictEqual(ctx.toArray(sum), [5, 7, 9]);
    assert.deepStrictEqual(ctx.toArray(diff), [-3, -3, -3]);
  });

  it('scope with pre-existing permanent array in return', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([1, 2, 3]);
    const [kept, computed] = ctx.scope(s => [A, s.add(A, A)]);
    assert.equal(kept, A); // unchanged permanent array
    assert.deepStrictEqual(ctx.toArray(computed), [2, 4, 6]);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Elementwise operations
// ═════════════════════════════════════════════════════════════════════

describe('elementwise ops', () => {
  it('add', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([1, 2, 3]);
    const B = ctx.array([10, 20, 30]);
    const C = ctx.scope(s => s.add(A, B));
    assert.deepStrictEqual(ctx.toArray(C), [11, 22, 33]);
  });

  it('sub', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([10, 20, 30]);
    const B = ctx.array([1, 2, 3]);
    const C = ctx.scope(s => s.sub(A, B));
    assert.deepStrictEqual(ctx.toArray(C), [9, 18, 27]);
  });

  it('mul', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([2, 3, 4]);
    const B = ctx.array([5, 6, 7]);
    const C = ctx.scope(s => s.mul(A, B));
    assert.deepStrictEqual(ctx.toArray(C), [10, 18, 28]);
  });

  it('div', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([10, 20, 30]);
    const B = ctx.array([2, 5, 10]);
    const C = ctx.scope(s => s.div(A, B));
    assert.deepStrictEqual(ctx.toArray(C), [5, 4, 3]);
  });

  it('neg', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([1, -2, 3]);
    const C = ctx.scope(s => s.neg(A));
    assert.deepStrictEqual(ctx.toArray(C), [-1, 2, -3]);
  });

  it('scalar add (array + scalar)', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([1, 2, 3]);
    const C = ctx.scope(s => s.add(A, 10));
    assert.deepStrictEqual(ctx.toArray(C), [11, 12, 13]);
  });

  it('scalar add (scalar + array)', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([1, 2, 3]);
    const C = ctx.scope(s => s.add(10, A));
    assert.deepStrictEqual(ctx.toArray(C), [11, 12, 13]);
  });

  it('scalar mul (array * scalar)', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([2, 3, 4]);
    const C = ctx.scope(s => s.mul(A, 3));
    assert.deepStrictEqual(ctx.toArray(C), [6, 9, 12]);
  });

  it('scalar sub (scalar - array)', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([1, 2, 3]);
    const C = ctx.scope(s => s.sub(10, A));
    assert.deepStrictEqual(ctx.toArray(C), [9, 8, 7]);
  });

  it('scalar sub (array - scalar)', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([10, 20, 30]);
    const C = ctx.scope(s => s.sub(A, 3));
    assert.deepStrictEqual(ctx.toArray(C), [7, 17, 27]);
  });

  it('scalar div (scalar / array)', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([2, 4, 5]);
    const C = ctx.scope(s => s.div(10, A));
    assert.deepStrictEqual(ctx.toArray(C), [5, 2.5, 2]);
  });

  it('scalar div (array / scalar)', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([10, 20, 30]);
    const C = ctx.scope(s => s.div(A, 5));
    assert.deepStrictEqual(ctx.toArray(C), [2, 4, 6]);
  });

  it('shape mismatch throws', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([1, 2, 3]);
    const B = ctx.array([1, 2]);
    assert.throws(() => {
      ctx.scope(s => s.add(A, B));
    }, /Incompatible shapes/);
  });

  it('chained operations in scope', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([1, 2, 3]);
    const B = ctx.array([4, 5, 6]);
    // (A + B) * A - B
    const C = ctx.scope(s => {
      const sum = s.add(A, B);
      const product = s.mul(sum, A);
      return s.sub(product, B);
    });
    // [5*1-4, 7*2-5, 9*3-6] = [1, 9, 21]
    assert.deepStrictEqual(ctx.toArray(C), [1, 9, 21]);
  });

  it('2D elementwise', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[1, 2], [3, 4]]);
    const B = ctx.array([[10, 20], [30, 40]]);
    const C = ctx.scope(s => s.add(A, B));
    assert.deepStrictEqual(ctx.toArray(C), [[11, 22], [33, 44]]);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Reductions
// ═════════════════════════════════════════════════════════════════════

describe('reductions', () => {
  it('sum', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([1, 2, 3, 4, 5]);
    const s = ctx.scope(s => s.sum(A));
    assert.equal(s, 15);
  });

  it('mean', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([2, 4, 6, 8]);
    const m = ctx.scope(s => s.mean(A));
    assert.equal(m, 5);
  });

  it('min', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([5, 3, 8, 1, 7]);
    const m = ctx.scope(s => s.min(A));
    assert.equal(m, 1);
  });

  it('max', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([5, 3, 8, 1, 7]);
    const m = ctx.scope(s => s.max(A));
    assert.equal(m, 8);
  });

  it('prod', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([1, 2, 3, 4]);
    const p = ctx.scope(s => s.prod(A));
    assert.equal(p, 24);
  });

  it('reduction on 2D array (flattened)', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[1, 2], [3, 4]]);
    const s = ctx.scope(s => s.sum(A));
    assert.equal(s, 10);
  });
});

// ═════════════════════════════════════════════════════════════════════
// NaN-safe reductions
// ═════════════════════════════════════════════════════════════════════

describe('nan-safe reductions', () => {
  it('nansum skips NaN', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([1, NaN, 3, NaN, 5]);
    const s = ctx.scope(s => s.nansum(A));
    assert.equal(s, 9);
  });

  it('nansum with no NaN equals sum', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([1, 2, 3]);
    assert.equal(ctx.scope(s => s.nansum(A)), ctx.scope(s => s.sum(A)));
  });

  it('nanmean skips NaN', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([2, NaN, 4, NaN, 6]);
    const m = ctx.scope(s => s.nanmean(A));
    assert.equal(m, 4); // (2+4+6)/3
  });

  it('nanmean of all-NaN returns NaN', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([NaN, NaN, NaN]);
    const m = ctx.scope(s => s.nanmean(A));
    assert.ok(Number.isNaN(m));
  });

  it('nanmin skips NaN', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([NaN, 5, 3, NaN, 8]);
    const m = ctx.scope(s => s.nanmin(A));
    assert.equal(m, 3);
  });

  it('nanmin of all-NaN returns NaN', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([NaN, NaN]);
    assert.ok(Number.isNaN(ctx.scope(s => s.nanmin(A))));
  });

  it('nanmax skips NaN', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([NaN, 5, 3, NaN, 8]);
    const m = ctx.scope(s => s.nanmax(A));
    assert.equal(m, 8);
  });

  it('nanmax of all-NaN returns NaN', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([NaN, NaN]);
    assert.ok(Number.isNaN(ctx.scope(s => s.nanmax(A))));
  });

  it('nanprod skips NaN', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([2, NaN, 3, NaN, 4]);
    const p = ctx.scope(s => s.nanprod(A));
    assert.equal(p, 24);
  });

  it('regular sum propagates NaN', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([1, NaN, 3]);
    const s = ctx.scope(s => s.sum(A));
    assert.ok(Number.isNaN(s));
  });
});

// ═════════════════════════════════════════════════════════════════════
// Allocator
// ═════════════════════════════════════════════════════════════════════

describe('allocator', () => {
  it('arrays are 16-byte aligned', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([1]);
    const b = ctx.array([2]);
    assert.equal(a.ptr % 16, 0);
    assert.equal(b.ptr % 16, 0);
  });

  it('reset reclaims all memory', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([1, 2, 3]);
    const firstPtr = a.ptr;
    ctx.reset();
    const b = ctx.array([4, 5, 6]);
    assert.equal(b.ptr, firstPtr); // reused
  });

  it('multiple arrays do not overlap', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([1, 2, 3]);
    const b = ctx.array([4, 5, 6]);
    // b should start at or after a's end
    assert.ok(b.ptr >= a.ptr + a.nbytes);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Reset
// ═════════════════════════════════════════════════════════════════════

describe('reset', () => {
  it('allows reuse after reset', async () => {
    const ctx = await natra({ pages: 1 });
    ctx.array([1, 2, 3]);
    ctx.array([4, 5, 6]);
    ctx.reset();
    const c = ctx.array([7, 8, 9]);
    assert.deepStrictEqual(ctx.toArray(c), [7, 8, 9]);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Views — transpose
// ═════════════════════════════════════════════════════════════════════

describe('views — transpose', () => {
  it('.T reverses shape and strides', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([[1, 2, 3], [4, 5, 6]]);
    assert.deepStrictEqual(a.shape, [2, 3]);
    const t = a.T;
    assert.deepStrictEqual(t.shape, [3, 2]);
    assert.deepStrictEqual(t.strides, [...a.strides].reverse());
  });

  it('.T data accessible via get()', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([[1, 2, 3], [4, 5, 6]]);
    const t = a.T;
    assert.equal(ctx.get(t, 0, 0), 1);
    assert.equal(ctx.get(t, 0, 1), 4);
    assert.equal(ctx.get(t, 1, 0), 2);
    assert.equal(ctx.get(t, 1, 1), 5);
    assert.equal(ctx.get(t, 2, 0), 3);
    assert.equal(ctx.get(t, 2, 1), 6);
  });

  it('.T toArray() returns correct nested array', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([[1, 2], [3, 4]]);
    const t = a.T;
    assert.deepStrictEqual(ctx.toArray(t), [[1, 3], [2, 4]]);
  });

  it('1D transpose is no-op', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([1, 2, 3]);
    assert.equal(a.T, a);
  });

  it('T of T restores original layout', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([[1, 2, 3], [4, 5, 6]]);
    const tt = a.T.T;
    assert.deepStrictEqual(tt.shape, a.shape);
    assert.deepStrictEqual(tt.strides, a.strides);
    assert.deepStrictEqual(ctx.toArray(tt), ctx.toArray(a));
  });

  it('.T has _arena null (view)', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([[1, 2], [3, 4]]);
    assert.equal(a.T._arena, null);
  });

  it('toTypedArray throws on transposed array', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([[1, 2], [3, 4]]);
    assert.throws(() => ctx.toTypedArray(a.T), /non-contiguous/);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Views — reshape
// ═════════════════════════════════════════════════════════════════════

describe('views — reshape', () => {
  it('valid reshape 1D to 2D', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([1, 2, 3, 4, 5, 6]);
    const b = a.reshape([2, 3]);
    assert.deepStrictEqual(b.shape, [2, 3]);
    assert.deepStrictEqual(ctx.toArray(b), [[1, 2, 3], [4, 5, 6]]);
  });

  it('valid reshape 2D to 1D', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([[1, 2, 3], [4, 5, 6]]);
    const b = a.reshape([6]);
    assert.deepStrictEqual(b.shape, [6]);
    assert.deepStrictEqual(ctx.toArray(b), [1, 2, 3, 4, 5, 6]);
  });

  it('1D→2D→1D roundtrip', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([1, 2, 3, 4]);
    const b = a.reshape([2, 2]);
    const c = b.reshape([4]);
    assert.deepStrictEqual(ctx.toArray(c), [1, 2, 3, 4]);
  });

  it('length mismatch throws', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([1, 2, 3]);
    assert.throws(() => a.reshape([2, 2]), /Cannot reshape/);
  });

  it('non-contiguous throws', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([[1, 2, 3], [4, 5, 6]]);
    assert.throws(() => a.T.reshape([6]), /non-contiguous/);
  });

  it('same ptr (zero-copy)', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([1, 2, 3, 4]);
    const b = a.reshape([2, 2]);
    assert.equal(a.ptr, b.ptr);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Views — slice
// ═════════════════════════════════════════════════════════════════════

describe('views — slice', () => {
  it('full slice (null) returns all elements', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([[1, 2, 3], [4, 5, 6]]);
    const b = a.slice(null, null);
    assert.deepStrictEqual(ctx.toArray(b), [[1, 2, 3], [4, 5, 6]]);
  });

  it('range slice [start, stop]', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([10, 20, 30, 40, 50]);
    const b = a.slice([1, 4]);
    assert.deepStrictEqual(ctx.toArray(b), [20, 30, 40]);
  });

  it('step slice [start, stop, step]', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([10, 20, 30, 40, 50, 60]);
    const b = a.slice([0, 6, 2]);
    assert.deepStrictEqual(ctx.toArray(b), [10, 30, 50]);
  });

  it('integer index reduces dimension', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([[1, 2, 3], [4, 5, 6]]);
    const row0 = a.slice(0);
    assert.deepStrictEqual(row0.shape, [3]);
    assert.deepStrictEqual(ctx.toArray(row0), [1, 2, 3]);
    const row1 = a.slice(1);
    assert.deepStrictEqual(ctx.toArray(row1), [4, 5, 6]);
  });

  it('negative index', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([[1, 2, 3], [4, 5, 6]]);
    const lastRow = a.slice(-1);
    assert.deepStrictEqual(ctx.toArray(lastRow), [4, 5, 6]);
  });

  it('negative range indices', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([10, 20, 30, 40, 50]);
    const b = a.slice([-3, -1]);
    assert.deepStrictEqual(ctx.toArray(b), [30, 40]);
  });

  it('2D column slice', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
    // All rows, columns 0..2
    const b = a.slice(null, [0, 2]);
    assert.deepStrictEqual(ctx.toArray(b), [[1, 2], [4, 5], [7, 8]]);
  });

  it('slice is zero-copy (same ptr base)', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([10, 20, 30, 40, 50]);
    const b = a.slice([1, 4]);
    // b.ptr should be offset from a.ptr
    assert.equal(b.ptr, a.ptr + 1 * 8);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Views — diag
// ═════════════════════════════════════════════════════════════════════

describe('views — diag', () => {
  it('extracts diagonal of square matrix', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
    const d = a.diag();
    assert.deepStrictEqual(d.shape, [3]);
    assert.deepStrictEqual(ctx.toArray(d), [1, 5, 9]);
  });

  it('eye diagonal is all ones', async () => {
    const ctx = await natra({ pages: 1 });
    const I = ctx.eye(4);
    const d = I.diag();
    assert.deepStrictEqual(ctx.toArray(d), [1, 1, 1, 1]);
  });

  it('non-square throws', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([[1, 2, 3], [4, 5, 6]]);
    assert.throws(() => a.diag(), /square/);
  });

  it('1D throws (not 2D)', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([1, 2, 3]);
    assert.throws(() => a.diag(), /2D/);
  });

  it('diag stride is correct', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([[1, 2], [3, 4]]);
    const d = a.diag();
    // stride should be (2+1)*8 = 24 for 2x2
    assert.deepStrictEqual(d.strides, [a.strides[0] + a.strides[1]]);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Broadcasting
// ═════════════════════════════════════════════════════════════════════

describe('broadcasting', () => {
  it('[n,m] + [m] row broadcast', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[1, 2, 3], [4, 5, 6]]);
    const B = ctx.array([10, 20, 30]);
    const C = ctx.scope(s => s.add(A, B));
    assert.deepStrictEqual(ctx.toArray(C), [[11, 22, 33], [14, 25, 36]]);
  });

  it('[m] + [n,m] row broadcast (reversed)', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([10, 20, 30]);
    const B = ctx.array([[1, 2, 3], [4, 5, 6]]);
    const C = ctx.scope(s => s.add(A, B));
    assert.deepStrictEqual(ctx.toArray(C), [[11, 22, 33], [14, 25, 36]]);
  });

  it('[n,1] + [1,m] outer broadcast', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[1], [2], [3]]);
    const B = ctx.array([[10, 20, 30]]);
    const C = ctx.scope(s => s.add(A, B));
    assert.deepStrictEqual(C.shape, [3, 3]);
    assert.deepStrictEqual(ctx.toArray(C), [[11, 21, 31], [12, 22, 32], [13, 23, 33]]);
  });

  it('[n,1] * [1,m] outer broadcast', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[1], [2], [3]]);
    const B = ctx.array([[10, 20]]);
    const C = ctx.scope(s => s.mul(A, B));
    assert.deepStrictEqual(C.shape, [3, 2]);
    assert.deepStrictEqual(ctx.toArray(C), [[10, 20], [20, 40], [30, 60]]);
  });

  it('incompatible shapes throw', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[1, 2, 3], [4, 5, 6]]);  // [2,3]
    const B = ctx.array([10, 20]);                   // [2]
    assert.throws(() => {
      ctx.scope(s => s.add(A, B));
    }, /Incompatible shapes/);
  });

  it('broadcast sub', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[10, 20], [30, 40]]);
    const B = ctx.array([1, 2]);
    const C = ctx.scope(s => s.sub(A, B));
    assert.deepStrictEqual(ctx.toArray(C), [[9, 18], [29, 38]]);
  });

  it('broadcast div', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[10, 20], [30, 40]]);
    const B = ctx.array([2, 5]);
    const C = ctx.scope(s => s.div(A, B));
    assert.deepStrictEqual(ctx.toArray(C), [[5, 4], [15, 8]]);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Non-contiguous operations
// ═════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════
// Axis reductions
// ═════════════════════════════════════════════════════════════════════

describe('axis reductions', () => {
  it('sum axis=0 on [2,3] → [3] (column sums)', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[1, 2, 3], [4, 5, 6]]);
    const C = ctx.scope(s => s.sum(A, 0));
    assert.deepStrictEqual(C.shape, [3]);
    assert.deepStrictEqual(ctx.toArray(C), [5, 7, 9]);
  });

  it('sum axis=1 on [2,3] → [2] (row sums)', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[1, 2, 3], [4, 5, 6]]);
    const C = ctx.scope(s => s.sum(A, 1));
    assert.deepStrictEqual(C.shape, [2]);
    assert.deepStrictEqual(ctx.toArray(C), [6, 15]);
  });

  it('sum axis=-1 equals sum axis=last', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[1, 2, 3], [4, 5, 6]]);
    const C1 = ctx.scope(s => s.sum(A, -1));
    const C2 = ctx.scope(s => s.sum(A, 1));
    assert.deepStrictEqual(ctx.toArray(C1), ctx.toArray(C2));
  });

  it('mean axis=0 on [2,3]', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[2, 4, 6], [8, 10, 12]]);
    const C = ctx.scope(s => s.mean(A, 0));
    assert.deepStrictEqual(C.shape, [3]);
    assert.deepStrictEqual(ctx.toArray(C), [5, 7, 9]);
  });

  it('min axis=1 on [3,3]', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[5, 1, 9], [3, 8, 2], [7, 4, 6]]);
    const C = ctx.scope(s => s.min(A, 1));
    assert.deepStrictEqual(C.shape, [3]);
    assert.deepStrictEqual(ctx.toArray(C), [1, 2, 4]);
  });

  it('max axis=0 on [3,3]', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[5, 1, 9], [3, 8, 2], [7, 4, 6]]);
    const C = ctx.scope(s => s.max(A, 0));
    assert.deepStrictEqual(C.shape, [3]);
    assert.deepStrictEqual(ctx.toArray(C), [7, 8, 9]);
  });

  it('prod axis=0', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[1, 2], [3, 4], [5, 6]]);
    const C = ctx.scope(s => s.prod(A, 0));
    assert.deepStrictEqual(C.shape, [2]);
    assert.deepStrictEqual(ctx.toArray(C), [15, 48]);
  });

  it('nansum axis=0 with NaN values', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[1, NaN, 3], [NaN, 5, 6]]);
    const C = ctx.scope(s => s.nansum(A, 0));
    assert.deepStrictEqual(C.shape, [3]);
    assert.deepStrictEqual(ctx.toArray(C), [1, 5, 9]);
  });

  it('nanmean axis=1 with NaN values', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[2, NaN, 4], [NaN, NaN, 6]]);
    const C = ctx.scope(s => s.nanmean(A, 1));
    assert.deepStrictEqual(C.shape, [2]);
    assert.deepStrictEqual(ctx.toArray(C), [3, 6]); // (2+4)/2=3, 6/1=6
  });

  it('nanmean axis with all-NaN row returns NaN', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[NaN, NaN], [1, 3]]);
    const C = ctx.scope(s => s.nanmean(A, 1));
    assert.deepStrictEqual(C.shape, [2]);
    const data = ctx.toArray(C);
    assert.ok(Number.isNaN(data[0]));
    assert.equal(data[1], 2);
  });

  it('nanmin axis=0', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[NaN, 5], [3, NaN]]);
    const C = ctx.scope(s => s.nanmin(A, 0));
    assert.deepStrictEqual(ctx.toArray(C), [3, 5]);
  });

  it('nanmax axis=0', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[NaN, 5], [3, NaN]]);
    const C = ctx.scope(s => s.nanmax(A, 0));
    assert.deepStrictEqual(ctx.toArray(C), [3, 5]);
  });

  it('nanmin/nanmax all-NaN column returns NaN', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[NaN, 1], [NaN, 2]]);
    const minC = ctx.scope(s => s.nanmin(A, 0));
    const maxC = ctx.scope(s => s.nanmax(A, 0));
    assert.ok(Number.isNaN(ctx.toArray(minC)[0]));
    assert.ok(Number.isNaN(ctx.toArray(maxC)[0]));
    assert.equal(ctx.toArray(minC)[1], 1);
    assert.equal(ctx.toArray(maxC)[1], 2);
  });

  it('nanprod axis=1', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[2, NaN, 3], [NaN, 4, 5]]);
    const C = ctx.scope(s => s.nanprod(A, 1));
    assert.deepStrictEqual(ctx.toArray(C), [6, 20]);
  });

  it('axis reduction on transposed array', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[1, 2, 3], [4, 5, 6]]);
    // A.T is [3,2]: [[1,4],[2,5],[3,6]]
    const C = ctx.scope(s => s.sum(A.T, 0));
    assert.deepStrictEqual(C.shape, [2]);
    assert.deepStrictEqual(ctx.toArray(C), [6, 15]); // col sums of transposed
  });

  it('axis reduction on 3D array', async () => {
    const ctx = await natra({ pages: 1 });
    // [2,2,3]
    const A = ctx.array([[[1, 2, 3], [4, 5, 6]], [[7, 8, 9], [10, 11, 12]]]);
    // sum axis=0 → [2,3]
    const C0 = ctx.scope(s => s.sum(A, 0));
    assert.deepStrictEqual(C0.shape, [2, 3]);
    assert.deepStrictEqual(ctx.toArray(C0), [[8, 10, 12], [14, 16, 18]]);

    // sum axis=1 → [2,3]
    const C1 = ctx.scope(s => s.sum(A, 1));
    assert.deepStrictEqual(C1.shape, [2, 3]);
    assert.deepStrictEqual(ctx.toArray(C1), [[5, 7, 9], [17, 19, 21]]);

    // sum axis=2 → [2,2]
    const C2 = ctx.scope(s => s.sum(A, 2));
    assert.deepStrictEqual(C2.shape, [2, 2]);
    assert.deepStrictEqual(ctx.toArray(C2), [[6, 15], [24, 33]]);
  });

  it('invalid axis throws', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[1, 2], [3, 4]]);
    assert.throws(() => ctx.scope(s => s.sum(A, 2)), /axis.*out of range/);
    assert.throws(() => ctx.scope(s => s.sum(A, -3)), /axis.*out of range/);
  });

  it('axis reduction on 1D reduces to [1]', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([1, 2, 3, 4]);
    const C = ctx.scope(s => s.sum(A, 0));
    assert.deepStrictEqual(C.shape, [1]);
    assert.deepStrictEqual(ctx.toArray(C), [10]);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Linear algebra
// ═════════════════════════════════════════════════════════════════════

const TOL = 1e-10;
function assertClose(actual, expected, msg) {
  assert.ok(Math.abs(actual - expected) < TOL, `${msg || ''}: ${actual} not close to ${expected}`);
}

describe('linalg — matmul', () => {
  it('[2,3] @ [3,2] = [2,2]', async () => {
    const ctx = await natra({ pages: 4 });
    const A = ctx.array([[1, 2, 3], [4, 5, 6]]);
    const B = ctx.array([[7, 8], [9, 10], [11, 12]]);
    const C = ctx.scope(s => s.matmul(A, B));
    assert.deepStrictEqual(C.shape, [2, 2]);
    const data = ctx.toArray(C);
    // [1*7+2*9+3*11, 1*8+2*10+3*12] = [58, 64]
    // [4*7+5*9+6*11, 4*8+5*10+6*12] = [139, 154]
    assert.deepStrictEqual(data, [[58, 64], [139, 154]]);
  });

  it('identity matmul', async () => {
    const ctx = await natra({ pages: 4 });
    const A = ctx.array([[1, 2], [3, 4]]);
    const I = ctx.eye(2);
    const C = ctx.scope(s => s.matmul(A, I));
    assert.deepStrictEqual(ctx.toArray(C), [[1, 2], [3, 4]]);
  });

  it('matvec [2,3] @ [3] = [2]', async () => {
    const ctx = await natra({ pages: 4 });
    const A = ctx.array([[1, 2, 3], [4, 5, 6]]);
    const x = ctx.array([1, 1, 1]);
    const y = ctx.scope(s => s.matmul(A, x));
    assert.deepStrictEqual(y.shape, [2]);
    assert.deepStrictEqual(ctx.toArray(y), [6, 15]);
  });

  it('transposed input', async () => {
    const ctx = await natra({ pages: 4 });
    const A = ctx.array([[1, 2], [3, 4]]);
    // A.T = [[1,3],[2,4]]
    const B = ctx.array([[1, 0], [0, 1]]);
    const C = ctx.scope(s => s.matmul(A.T, B));
    assert.deepStrictEqual(ctx.toArray(C), [[1, 3], [2, 4]]);
  });

  it('inner dimension mismatch throws', async () => {
    const ctx = await natra({ pages: 4 });
    const A = ctx.array([[1, 2, 3], [4, 5, 6]]);
    const B = ctx.array([[1, 2], [3, 4]]);
    assert.throws(() => ctx.scope(s => s.matmul(A, B)), /inner dimensions mismatch/);
  });
});

describe('linalg — dot', () => {
  it('simple dot product', async () => {
    const ctx = await natra({ pages: 4 });
    const a = ctx.array([1, 2, 3]);
    const b = ctx.array([4, 5, 6]);
    const d = ctx.scope(s => s.dot(a, b));
    assertClose(d, 32); // 1*4 + 2*5 + 3*6
  });

  it('orthogonal vectors dot = 0', async () => {
    const ctx = await natra({ pages: 4 });
    const a = ctx.array([1, 0, 0]);
    const b = ctx.array([0, 1, 0]);
    assertClose(ctx.scope(s => s.dot(a, b)), 0);
  });
});

describe('linalg — solve', () => {
  it('3x3 system', async () => {
    const ctx = await natra({ pages: 4 });
    // A * x = b where A = [[2,1,0],[1,3,1],[0,1,2]], b = [1,2,3]
    const A = ctx.array([[2, 1, 0], [1, 3, 1], [0, 1, 2]]);
    const b = ctx.array([1, 2, 3]);
    const x = ctx.scope(s => s.solve(A, b));
    assert.deepStrictEqual(x.shape, [3]);
    // Verify A*x ≈ b
    const xArr = ctx.toArray(x);
    const Ax = [
      2*xArr[0] + 1*xArr[1] + 0*xArr[2],
      1*xArr[0] + 3*xArr[1] + 1*xArr[2],
      0*xArr[0] + 1*xArr[1] + 2*xArr[2],
    ];
    assertClose(Ax[0], 1, 'Ax[0]');
    assertClose(Ax[1], 2, 'Ax[1]');
    assertClose(Ax[2], 3, 'Ax[2]');
  });

  it('singular throws', async () => {
    const ctx = await natra({ pages: 4 });
    const A = ctx.array([[1, 2], [2, 4]]); // row 2 = 2 * row 1
    const b = ctx.array([1, 2]);
    assert.throws(() => ctx.scope(s => s.solve(A, b)), /singular/);
  });

  it('multiple RHS', async () => {
    const ctx = await natra({ pages: 4 });
    const A = ctx.array([[2, 1], [1, 3]]);
    const B = ctx.array([[1, 0], [0, 1]]);
    const X = ctx.scope(s => s.solve(A, B));
    assert.deepStrictEqual(X.shape, [2, 2]);
    // X should be A^{-1}, verify A*X ≈ I
    const x = ctx.toArray(X);
    assertClose(2*x[0][0] + 1*x[1][0], 1, 'AX[0,0]');
    assertClose(2*x[0][1] + 1*x[1][1], 0, 'AX[0,1]');
    assertClose(1*x[0][0] + 3*x[1][0], 0, 'AX[1,0]');
    assertClose(1*x[0][1] + 3*x[1][1], 1, 'AX[1,1]');
  });
});

describe('linalg — cholesky', () => {
  it('SPD matrix: L*L^T ≈ A', async () => {
    const ctx = await natra({ pages: 4 });
    // SPD: A = [[4,2],[2,3]]
    const A = ctx.array([[4, 2], [2, 3]]);
    const L = ctx.scope(s => s.cholesky(A));
    assert.deepStrictEqual(L.shape, [2, 2]);
    const l = ctx.toArray(L);
    // Verify L * L^T = A
    assertClose(l[0][0]*l[0][0] + l[0][1]*l[0][1], 4, 'LLT[0,0]');
    assertClose(l[1][0]*l[0][0] + l[1][1]*l[0][1], 2, 'LLT[1,0]');
    assertClose(l[1][0]*l[1][0] + l[1][1]*l[1][1], 3, 'LLT[1,1]');
    // Upper triangle should be zero
    assertClose(l[0][1], 0, 'upper zero');
  });

  it('non-SPD throws', async () => {
    const ctx = await natra({ pages: 4 });
    const A = ctx.array([[1, 2], [2, 1]]); // eigenvalues 3 and -1
    assert.throws(() => ctx.scope(s => s.cholesky(A)), /not positive definite/);
  });
});

describe('linalg — inv', () => {
  it('A @ A^-1 ≈ I', async () => {
    const ctx = await natra({ pages: 4 });
    const A = ctx.array([[1, 2], [3, 4]]);
    const Ainv = ctx.scope(s => s.inv(A));
    assert.deepStrictEqual(Ainv.shape, [2, 2]);
    // Verify A * Ainv ≈ I
    const a = ctx.toArray(A);
    const ai = ctx.toArray(Ainv);
    assertClose(a[0][0]*ai[0][0] + a[0][1]*ai[1][0], 1, 'I[0,0]');
    assertClose(a[0][0]*ai[0][1] + a[0][1]*ai[1][1], 0, 'I[0,1]');
    assertClose(a[1][0]*ai[0][0] + a[1][1]*ai[1][0], 0, 'I[1,0]');
    assertClose(a[1][0]*ai[0][1] + a[1][1]*ai[1][1], 1, 'I[1,1]');
  });
});

describe('linalg — det', () => {
  it('2x2 ad-bc', async () => {
    const ctx = await natra({ pages: 4 });
    const A = ctx.array([[3, 8], [4, 6]]);
    const d = ctx.scope(s => s.det(A));
    assertClose(d, 3*6 - 8*4); // = -14
  });

  it('known 3x3 det', async () => {
    const ctx = await natra({ pages: 4 });
    const A = ctx.array([[6, 1, 1], [4, -2, 5], [2, 8, 7]]);
    const d = ctx.scope(s => s.det(A));
    // det = 6*(-14-40) - 1*(28-10) + 1*(32+4) = -306-18+36 = -306
    // Actually: 6(-2*7-5*8) - 1(4*7-5*2) + 1(4*8-(-2)*2)
    // = 6(-14-40) - (28-10) + (32+4) = 6(-54) -18+36 = -324-18+36 = -306
    assertClose(d, -306);
  });

  it('singular → 0', async () => {
    const ctx = await natra({ pages: 4 });
    const A = ctx.array([[1, 2], [2, 4]]);
    assertClose(ctx.scope(s => s.det(A)), 0);
  });
});

describe('linalg — eigh', () => {
  it('symmetric eigenvalues', async () => {
    const ctx = await natra({ pages: 4 });
    // Symmetric: [[2, 1], [1, 2]] → eigenvalues 1, 3
    const A = ctx.array([[2, 1], [1, 2]]);
    const [vals, vecs] = ctx.scope(s => s.eigh(A));
    assert.deepStrictEqual(vals.shape, [2]);
    const v = ctx.toArray(vals).sort((a, b) => a - b);
    assertClose(v[0], 1, 'eigenvalue 1');
    assertClose(v[1], 3, 'eigenvalue 2');
  });

  it('A*v ≈ lambda*v for each eigenpair', async () => {
    const ctx = await natra({ pages: 4 });
    const A = ctx.array([[4, 1, 0], [1, 3, 1], [0, 1, 2]]);
    const [vals, vecs] = ctx.scope(s => s.eigh(A));
    assert.deepStrictEqual(vals.shape, [3]);
    assert.deepStrictEqual(vecs.shape, [3, 3]);
    const w = ctx.toArray(vals);
    const V = ctx.toArray(vecs);
    const Amat = [[4,1,0],[1,3,1],[0,1,2]];
    for (let k = 0; k < 3; k++) {
      const lambda = w[k];
      const v = [V[0][k], V[1][k], V[2][k]]; // column k
      // A*v
      const Av = [
        Amat[0][0]*v[0] + Amat[0][1]*v[1] + Amat[0][2]*v[2],
        Amat[1][0]*v[0] + Amat[1][1]*v[1] + Amat[1][2]*v[2],
        Amat[2][0]*v[0] + Amat[2][1]*v[1] + Amat[2][2]*v[2],
      ];
      // lambda*v
      for (let i = 0; i < 3; i++) {
        assertClose(Av[i], lambda * v[i], `Av[${i}] = lambda*v[${i}] for eigenpair ${k}`);
      }
    }
  });
});

describe('linalg — norm', () => {
  it('L2 norm of vector', async () => {
    const ctx = await natra({ pages: 4 });
    const a = ctx.array([3, 4]);
    assertClose(ctx.scope(s => s.norm(a)), 5);
  });

  it('Frobenius norm of matrix', async () => {
    const ctx = await natra({ pages: 4 });
    const A = ctx.array([[1, 2], [3, 4]]);
    // sqrt(1+4+9+16) = sqrt(30)
    assertClose(ctx.scope(s => s.norm(A)), Math.sqrt(30));
  });

  it('norm of unit vector', async () => {
    const ctx = await natra({ pages: 4 });
    const a = ctx.array([0, 0, 1]);
    assertClose(ctx.scope(s => s.norm(a)), 1);
  });
});

describe('non-contiguous ops', () => {
  it('transpose then sum', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([[1, 2], [3, 4]]);
    const t = a.T;
    const s = ctx.scope(s => s.sum(t));
    assert.equal(s, 10);
  });

  it('transpose then add', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[1, 2], [3, 4]]);
    const B = ctx.array([[10, 20], [30, 40]]);
    const C = ctx.scope(s => s.add(A.T, B.T));
    assert.deepStrictEqual(ctx.toArray(C), [[11, 33], [22, 44]]);
  });

  it('slice then mul', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([1, 2, 3, 4, 5, 6]);
    const B = ctx.array([10, 20, 30]);
    const sliced = A.slice([0, 6, 2]); // [1, 3, 5]
    const C = ctx.scope(s => s.mul(sliced, B));
    assert.deepStrictEqual(ctx.toArray(C), [10, 60, 150]);
  });

  it('neg on transposed array', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[1, 2], [3, 4]]);
    const C = ctx.scope(s => s.neg(A.T));
    assert.deepStrictEqual(ctx.toArray(C), [[-1, -3], [-2, -4]]);
  });

  it('min/max on transposed array', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[5, 1], [3, 8]]);
    assert.equal(ctx.scope(s => s.min(A.T)), 1);
    assert.equal(ctx.scope(s => s.max(A.T)), 8);
  });

  it('prod on strided slice', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([2, 0, 3, 0, 4]);
    const s = A.slice([0, 5, 2]); // [2, 3, 4]
    assert.equal(ctx.scope(sc => sc.prod(s)), 24);
  });

  it('copy of non-contiguous array produces contiguous', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[1, 2, 3], [4, 5, 6]]);
    const t = A.T;
    const c = ctx.copy(t);
    assert.deepStrictEqual(c.shape, [3, 2]);
    assert.deepStrictEqual(ctx.toArray(c), [[1, 4], [2, 5], [3, 6]]);
    // copy should be contiguous
    assert.doesNotThrow(() => ctx.toTypedArray(c));
  });

  it('scalar + non-contiguous array', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[1, 2], [3, 4]]);
    const C = ctx.scope(s => s.add(A.T, 10));
    assert.deepStrictEqual(ctx.toArray(C), [[11, 13], [12, 14]]);
  });

  it('non-contiguous array + scalar', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[1, 2], [3, 4]]);
    const C = ctx.scope(s => s.mul(A.T, 2));
    assert.deepStrictEqual(ctx.toArray(C), [[2, 6], [4, 8]]);
  });

  it('diag then sum', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
    const d = A.diag();
    assert.equal(ctx.scope(s => s.sum(d)), 15); // 1+5+9
  });
});

// ═════════════════════════════════════════════════════════════════════
// Comparison
// ═════════════════════════════════════════════════════════════════════

describe('comparison', () => {
  it('eq: array vs array', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([1, 2, 3, 4]);
    const b = ctx.array([1, 0, 3, 5]);
    const r = ctx.scope(s => s.eq(a, b));
    assert.deepStrictEqual(ctx.toArray(r), [1, 0, 1, 0]);
  });

  it('eq: array vs scalar', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([1, 2, 3, 2]);
    const r = ctx.scope(s => s.eq(a, 2));
    assert.deepStrictEqual(ctx.toArray(r), [0, 1, 0, 1]);
  });

  it('eq: scalar vs array', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([1, 2, 3]);
    const r = ctx.scope(s => s.eq(3, a));
    assert.deepStrictEqual(ctx.toArray(r), [0, 0, 1]);
  });

  it('eq: scalar vs scalar', async () => {
    const ctx = await natra({ pages: 1 });
    assert.equal(ctx.scope(s => s.eq(5, 5)), 1);
    assert.equal(ctx.scope(s => s.eq(5, 3)), 0);
  });

  it('eq: broadcasting [2,3] vs [3]', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([[1, 2, 3], [4, 2, 6]]);
    const b = ctx.array([1, 2, 3]);
    const r = ctx.scope(s => s.eq(a, b));
    assert.deepStrictEqual(ctx.toArray(r), [[1, 1, 1], [0, 1, 0]]);
  });

  it('ne: simple case', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([1, 2, 3]);
    const b = ctx.array([1, 0, 3]);
    const r = ctx.scope(s => s.ne(a, b));
    assert.deepStrictEqual(ctx.toArray(r), [0, 1, 0]);
  });

  it('ne: NaN !== NaN is true in JS', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([NaN, 1, NaN]);
    const b = ctx.array([NaN, 1, 0]);
    const r = ctx.scope(s => s.ne(a, b));
    // NaN !== NaN → 1.0 in JS path; Wasm path: NaN == NaN is false → ne returns 1.0
    assert.deepStrictEqual(ctx.toArray(r), [1, 0, 1]);
  });

  it('lt and le: boundary cases', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([1, 2, 3]);
    const b = ctx.array([2, 2, 2]);
    const lt = ctx.scope(s => s.lt(a, b));
    assert.deepStrictEqual(ctx.toArray(lt), [1, 0, 0]);
    const le = ctx.scope(s => s.le(a, b));
    assert.deepStrictEqual(ctx.toArray(le), [1, 1, 0]);
  });

  it('gt and ge: boundary cases', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([1, 2, 3]);
    const b = ctx.array([2, 2, 2]);
    const gt = ctx.scope(s => s.gt(a, b));
    assert.deepStrictEqual(ctx.toArray(gt), [0, 0, 1]);
    const ge = ctx.scope(s => s.ge(a, b));
    assert.deepStrictEqual(ctx.toArray(ge), [0, 1, 1]);
  });

  it('comparison on transposed (non-contiguous) input', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([[1, 2], [3, 4]]);
    const b = ctx.array([[1, 3], [2, 4]]);
    // a.T = [[1,3],[2,4]], b.T = [[1,2],[3,4]]
    const r = ctx.scope(s => s.eq(a.T, b.T));
    assert.deepStrictEqual(ctx.toArray(r), [[1, 0], [0, 1]]);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Where
// ═════════════════════════════════════════════════════════════════════

describe('where', () => {
  it('basic array select', async () => {
    const ctx = await natra({ pages: 1 });
    const cond = ctx.array([1, 0, 1, 0]);
    const a = ctx.array([10, 20, 30, 40]);
    const b = ctx.array([50, 60, 70, 80]);
    const r = ctx.scope(s => s.where(cond, a, b));
    assert.deepStrictEqual(ctx.toArray(r), [10, 60, 30, 80]);
  });

  it('where with scalar a', async () => {
    const ctx = await natra({ pages: 1 });
    const cond = ctx.array([1, 0, 1]);
    const b = ctx.array([5, 6, 7]);
    const r = ctx.scope(s => s.where(cond, 99, b));
    assert.deepStrictEqual(ctx.toArray(r), [99, 6, 99]);
  });

  it('where with scalar b', async () => {
    const ctx = await natra({ pages: 1 });
    const cond = ctx.array([0, 1, 0]);
    const a = ctx.array([10, 20, 30]);
    const r = ctx.scope(s => s.where(cond, a, -1));
    assert.deepStrictEqual(ctx.toArray(r), [-1, 20, -1]);
  });

  it('where with broadcasting', async () => {
    const ctx = await natra({ pages: 1 });
    const cond = ctx.array([[1, 0], [0, 1]]);
    const a = ctx.array([10, 20]); // [2] broadcasts to [2,2]
    const b = ctx.array([[-1, -2], [-3, -4]]);
    const r = ctx.scope(s => s.where(cond, a, b));
    assert.deepStrictEqual(ctx.toArray(r), [[10, -2], [-3, 20]]);
  });

  it('where on non-contiguous input', async () => {
    const ctx = await natra({ pages: 1 });
    const cond = ctx.array([[1, 0], [0, 1]]);
    const a = ctx.array([[10, 20], [30, 40]]);
    const b = ctx.array([[50, 60], [70, 80]]);
    const r = ctx.scope(s => s.where(cond.T, a.T, b.T));
    // cond.T = [[1,0],[0,1]], a.T = [[10,30],[20,40]], b.T = [[50,70],[60,80]]
    assert.deepStrictEqual(ctx.toArray(r), [[10, 70], [60, 40]]);
  });

  it('where all scalars', async () => {
    const ctx = await natra({ pages: 1 });
    assert.equal(ctx.scope(s => s.where(1, 10, 20)), 10);
    assert.equal(ctx.scope(s => s.where(0, 10, 20)), 20);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Take
// ═════════════════════════════════════════════════════════════════════

describe('take', () => {
  it('basic 1D gather', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([10, 20, 30, 40, 50]);
    const idx = ctx.array([0, 2, 4]);
    const r = ctx.scope(s => s.take(a, idx));
    assert.deepStrictEqual(ctx.toArray(r), [10, 30, 50]);
  });

  it('duplicate indices', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([10, 20, 30]);
    const idx = ctx.array([1, 1, 1, 0]);
    const r = ctx.scope(s => s.take(a, idx));
    assert.deepStrictEqual(ctx.toArray(r), [20, 20, 20, 10]);
  });

  it('out-of-order indices', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([10, 20, 30, 40]);
    const idx = ctx.array([3, 1, 0, 2]);
    const r = ctx.scope(s => s.take(a, idx));
    assert.deepStrictEqual(ctx.toArray(r), [40, 20, 10, 30]);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Compress
// ═════════════════════════════════════════════════════════════════════

describe('compress', () => {
  it('basic boolean select', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([10, 20, 30, 40, 50]);
    const mask = ctx.array([1, 0, 1, 0, 1]);
    const r = ctx.scope(s => s.compress(a, mask));
    assert.deepStrictEqual(ctx.toArray(r), [10, 30, 50]);
  });

  it('empty result (all zeros mask)', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([1, 2, 3]);
    const mask = ctx.array([0, 0, 0]);
    const r = ctx.scope(s => s.compress(a, mask));
    assert.deepStrictEqual(ctx.toArray(r), []);
    assert.deepStrictEqual(r.shape, [0]);
  });

  it('full result (all ones mask)', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([1, 2, 3]);
    const mask = ctx.array([1, 1, 1]);
    const r = ctx.scope(s => s.compress(a, mask));
    assert.deepStrictEqual(ctx.toArray(r), [1, 2, 3]);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Argsort
// ═════════════════════════════════════════════════════════════════════

describe('argsort', () => {
  it('ascending sort of unsorted array', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([30, 10, 20]);
    const r = ctx.scope(s => s.argsort(a));
    assert.deepStrictEqual(ctx.toArray(r), [1, 2, 0]);
  });

  it('already sorted → identity indices', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([1, 2, 3, 4]);
    const r = ctx.scope(s => s.argsort(a));
    assert.deepStrictEqual(ctx.toArray(r), [0, 1, 2, 3]);
  });

  it('ties produce valid sort', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([3, 1, 3, 1]);
    const r = ctx.scope(s => s.argsort(a));
    const idx = ctx.toArray(r);
    // Verify the sort is valid: values at indices should be non-decreasing
    const vals = ctx.toArray(a);
    for (let i = 1; i < idx.length; i++) {
      assert.ok(vals[idx[i]] >= vals[idx[i - 1]], `value at index ${i} should be >= previous`);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════
// Searchsorted
// ═════════════════════════════════════════════════════════════════════

describe('searchsorted', () => {
  it('scalar query → scalar result', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([10, 20, 30, 40, 50]);
    assert.equal(ctx.scope(s => s.searchsorted(a, 25)), 2); // between 20 and 30
  });

  it('array query → array of indices', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([10, 20, 30, 40, 50]);
    const v = ctx.array([5, 25, 50, 55]);
    const r = ctx.scope(s => s.searchsorted(a, v));
    assert.deepStrictEqual(ctx.toArray(r), [0, 2, 5, 5]);
  });

  it('value below all → 0', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([10, 20, 30]);
    assert.equal(ctx.scope(s => s.searchsorted(a, 0)), 0);
  });

  it('value above all → n', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([10, 20, 30]);
    assert.equal(ctx.scope(s => s.searchsorted(a, 100)), 3);
  });

  it('exact match → right insertion point', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([10, 20, 30]);
    // bisect right: 20 → index 2 (after the 20)
    assert.equal(ctx.scope(s => s.searchsorted(a, 20)), 2);
  });
});

// ═════════════════════════════════════════════════════════════════════
// RNG — xoshiro256**
// ═════════════════════════════════════════════════════════════════════

describe('random', () => {
  it('random 1D: correct shape, values in [0, 1)', async () => {
    const ctx = await natra({ pages: 1 });
    ctx.seed(123);
    const r = ctx.random([100]);
    assert.deepStrictEqual(r.shape, [100]);
    const vals = ctx.toArray(r);
    for (const v of vals) {
      assert.ok(v >= 0, `value ${v} should be >= 0`);
      assert.ok(v < 1, `value ${v} should be < 1`);
    }
  });

  it('random 2D: correct shape', async () => {
    const ctx = await natra({ pages: 1 });
    ctx.seed(42);
    const r = ctx.random([5, 3]);
    assert.deepStrictEqual(r.shape, [5, 3]);
    assert.equal(r.length, 15);
    const vals = ctx.toArray(r).flat();
    for (const v of vals) {
      assert.ok(v >= 0 && v < 1);
    }
  });

  it('same seed produces same sequence', async () => {
    const ctx = await natra({ pages: 1 });
    ctx.seed(99);
    const a = ctx.toArray(ctx.random([10]));
    ctx.seed(99);
    const b = ctx.toArray(ctx.random([10]));
    assert.deepStrictEqual(a, b);
  });

  it('different seeds produce different sequences', async () => {
    const ctx = await natra({ pages: 1 });
    ctx.seed(1);
    const a = ctx.toArray(ctx.random([10]));
    ctx.seed(2);
    const b = ctx.toArray(ctx.random([10]));
    // At least one value should differ
    let allSame = true;
    for (let i = 0; i < 10; i++) {
      if (a[i] !== b[i]) { allSame = false; break; }
    }
    assert.ok(!allSame, 'different seeds should produce different values');
  });
});

describe('randn', () => {
  it('randn 1D: correct shape', async () => {
    const ctx = await natra({ pages: 1 });
    ctx.seed(42);
    const r = ctx.randn([50]);
    assert.deepStrictEqual(r.shape, [50]);
    assert.equal(r.length, 50);
  });

  it('randn 2D: correct shape', async () => {
    const ctx = await natra({ pages: 1 });
    ctx.seed(42);
    const r = ctx.randn([4, 5]);
    assert.deepStrictEqual(r.shape, [4, 5]);
    assert.equal(r.length, 20);
  });

  it('randn odd length works', async () => {
    const ctx = await natra({ pages: 1 });
    ctx.seed(42);
    const r = ctx.randn([7]);
    assert.equal(r.length, 7);
    const vals = ctx.toArray(r);
    // All values should be finite (not NaN, not Infinity)
    for (const v of vals) {
      assert.ok(Number.isFinite(v), `value ${v} should be finite`);
    }
  });

  it('randn mean and std approximately correct for large n', async () => {
    const ctx = await natra({ pages: 2 });
    ctx.seed(42);
    const r = ctx.randn([10000]);
    const vals = ctx.toArray(r);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
    const std = Math.sqrt(variance);
    // mean should be close to 0, std close to 1
    assert.ok(Math.abs(mean) < 0.05, `mean ${mean} should be close to 0`);
    assert.ok(Math.abs(std - 1) < 0.05, `std ${std} should be close to 1`);
  });

  it('randn same seed reproducible', async () => {
    const ctx = await natra({ pages: 1 });
    ctx.seed(77);
    const a = ctx.toArray(ctx.randn([20]));
    ctx.seed(77);
    const b = ctx.toArray(ctx.randn([20]));
    assert.deepStrictEqual(a, b);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Display / toString / trace
// ═════════════════════════════════════════════════════════════════════

describe('toString', () => {
  it('1D array', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([1, 2, 3]);
    assert.equal(a.toString(), 'array([1, 2, 3])');
  });

  it('2D array multi-line', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([[1, 2, 3], [4, 5, 6]]);
    const s = a.toString();
    assert.ok(s.startsWith('array('));
    assert.ok(s.includes('1'));
    assert.ok(s.includes('6'));
    // should have newlines for 2D
    assert.ok(s.includes('\n'));
  });

  it('2D column alignment', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([[1, 200], [3000, 4]]);
    const s = a.toString();
    // columns should be right-aligned: "   1" padded to match "3000"
    assert.ok(s.includes('   1'), 'first col should be right-padded');
    assert.ok(s.includes('3000'));
    assert.ok(s.includes('200'));
    assert.ok(s.includes('  4'), 'second col should be right-padded');
  });

  it('large 1D truncated', async () => {
    const ctx = await natra({ pages: 64 });
    const data = new Array(2000).fill(0).map((_, i) => i);
    const a = ctx.array(data);
    const s = a.toString();
    assert.ok(s.includes('...'), 'should truncate with ...');
    assert.ok(s.includes('0'));
    assert.ok(s.includes('1999'));
  });

  it('NaN and Inf formatting', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([NaN, Infinity, -Infinity, 0]);
    const s = a.toString();
    assert.ok(s.includes('nan'));
    assert.ok(s.includes('inf'));
    assert.ok(s.includes('-inf'));
  });

  it('non-contiguous (transposed)', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([[1, 2], [3, 4]]);
    const t = a.T;
    const s = t.toString();
    // transposed: [[1,3],[2,4]]
    assert.ok(s.includes('1'));
    assert.ok(s.includes('4'));
  });

  it('template literal works', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([10, 20, 30]);
    const s = `result: ${a}`;
    assert.ok(s.startsWith('result: array('));
  });

  it('empty-like 1D', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([42]);
    assert.equal(a.toString(), 'array([42])');
  });

  it('3D compact format', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([[[1, 2], [3, 4]], [[5, 6], [7, 8]]]);
    const s = a.toString();
    assert.ok(s.includes('shape=[2,2,2]'));
    assert.ok(s.includes('dtype=f64'));
  });

  it('large 2D truncated rows and cols', async () => {
    const ctx = await natra({ pages: 64 });
    const data = [];
    for (let i = 0; i < 10; i++) {
      const row = [];
      for (let j = 0; j < 10; j++) row.push(i * 10 + j);
      data.push(row);
    }
    const a = ctx.array(data);
    const s = a.toString();
    assert.ok(s.includes('...'), 'should have ellipsis');
    // first element and last element present
    assert.ok(s.includes('0'));
    assert.ok(s.includes('99'));
  });

  it('fractional values strip trailing zeros', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([1.5, 2.25, 3.1]);
    const s = a.toString();
    // should not have trailing zeros like "1.5000"
    assert.ok(s.includes('1.5'));
    assert.ok(!s.includes('1.5000'));
  });
});

describe('trace', () => {
  it('contains metadata and data', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([[1, 2, 3], [4, 5, 6]]);
    const t = ctx.trace(a);
    assert.ok(t.includes('shape:      [2,3]'));
    assert.ok(t.includes('dtype:      f64'));
    assert.ok(t.includes('strides:'));
    assert.ok(t.includes('contiguous: true'));
    assert.ok(t.includes('array('));
  });

  it('non-contiguous shows false', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([[1, 2], [3, 4]]);
    const t = ctx.trace(a.T);
    assert.ok(t.includes('contiguous: false'));
  });
});

// ═════════════════════════════════════════════════════════════════════
// Bounds checking
// ═════════════════════════════════════════════════════════════════════

describe('bounds checking', () => {
  it('get out of bounds throws RangeError', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([10, 20, 30]);
    assert.throws(() => ctx.get(a, 999), /out of bounds/);
    assert.throws(() => ctx.get(a, 3), /out of bounds/);
  });

  it('get negative index wraps', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([10, 20, 30]);
    assert.equal(ctx.get(a, -1), 30);
    assert.equal(ctx.get(a, -2), 20);
    assert.equal(ctx.get(a, -3), 10);
  });

  it('get negative index too low throws', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([10, 20, 30]);
    assert.throws(() => ctx.get(a, -4), /out of bounds/);
  });

  it('set out of bounds throws RangeError', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([10, 20, 30]);
    assert.throws(() => ctx.set(a, 99, 3), /out of bounds/);
  });

  it('set negative index wraps', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([10, 20, 30]);
    ctx.set(a, 99, -1);
    assert.equal(ctx.get(a, 2), 99);
  });

  it('2D out of bounds on second axis', async () => {
    const ctx = await natra({ pages: 1 });
    const a = ctx.array([[1, 2, 3], [4, 5, 6]]);
    assert.throws(() => ctx.get(a, 0, 5), /out of bounds.*axis 1/);
    assert.throws(() => ctx.get(a, 2, 0), /out of bounds.*axis 0/);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Dead-array detection
// ═════════════════════════════════════════════════════════════════════

describe('dead-array detection', () => {
  it('unreturned array throws on access', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([1, 2, 3]);
    const B = ctx.array([4, 5, 6]);
    let dead;
    ctx.scope(s => {
      dead = s.add(A, B); // scratch, not returned
      return s.sum(A); // return scalar
    });
    assert.throws(() => ctx.get(dead, 0), /scope exit/);
    assert.throws(() => ctx.toArray(dead), /scope exit/);
  });

  it('returned array is still accessible', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([1, 2, 3]);
    const result = ctx.scope(s => s.add(A, A));
    assert.deepStrictEqual(ctx.toArray(result), [2, 4, 6]);
  });

  it('one of two arrays not returned throws', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([1, 2, 3]);
    let dead;
    const kept = ctx.scope(s => {
      dead = s.mul(A, A);
      return s.add(A, A);
    });
    assert.deepStrictEqual(ctx.toArray(kept), [2, 4, 6]);
    assert.throws(() => ctx.toArray(dead), /scope exit/);
  });

  it('permanent array passed into scope stays accessible', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([1, 2, 3]);
    ctx.scope(s => s.sum(A));
    // A is permanent, not arena-allocated — should still be alive
    assert.deepStrictEqual(ctx.toArray(A), [1, 2, 3]);
  });

  it('copy of dead array throws', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([1, 2, 3]);
    const B = ctx.array([4, 5, 6]);
    let dead;
    ctx.scope(s => {
      dead = s.add(A, B);
      return s.sum(A); // return scalar, dead is not promoted
    });
    assert.throws(() => ctx.copy(dead), /scope exit/);
  });

  it('toTypedArray of dead array throws', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([1, 2, 3]);
    const B = ctx.array([4, 5, 6]);
    let dead;
    ctx.scope(s => {
      dead = s.add(A, B);
      return s.sum(A); // return scalar
    });
    assert.throws(() => ctx.toTypedArray(dead), /scope exit/);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Memory limit
// ═════════════════════════════════════════════════════════════════════

describe('memory limit', () => {
  it('exceeding maxPages throws', async () => {
    const ctx = await natra({ pages: 1, maxPages: 2 });
    // 1 page = 64KB. 2 pages = 128KB. Try to allocate 3 pages worth = 192KB
    // 192KB / 8 = 24000 f64 elements
    assert.throws(() => {
      ctx.array(new Array(24000).fill(0));
    }, /Memory limit exceeded/);
  });

  it('default maxPages allows large allocation', async () => {
    const ctx = await natra({ pages: 1 });
    // Allocate moderately (should succeed with default 16384 pages)
    const a = ctx.array(new Array(1000).fill(1));
    assert.equal(a.length, 1000);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Strided Wasm kernels
// ═════════════════════════════════════════════════════════════════════

describe('strided Wasm kernels', () => {
  it('transpose + add hits strided kernel', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[1, 2], [3, 4]]);
    const B = ctx.array([[10, 20], [30, 40]]);
    // A.T + B.T — both non-contiguous, same shape
    const C = ctx.scope(s => s.add(A.T, B.T));
    assert.deepStrictEqual(ctx.toArray(C), [[11, 33], [22, 44]]);
  });

  it('broadcast [n,1] + [1,m] via strided kernel', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[1], [2], [3]]);
    const B = ctx.array([[10, 20, 30]]);
    const C = ctx.scope(s => s.add(A, B));
    assert.deepStrictEqual(ctx.toArray(C), [[11, 21, 31], [12, 22, 32], [13, 23, 33]]);
  });

  it('3D broadcast via strided kernel', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[[1, 2], [3, 4]], [[5, 6], [7, 8]]]);
    const B = ctx.array([10, 20]);
    const C = ctx.scope(s => s.add(A, B));
    assert.deepStrictEqual(ctx.toArray(C), [[[11, 22], [13, 24]], [[15, 26], [17, 28]]]);
  });

  it('slice then mul via strided kernel', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([1, 2, 3, 4, 5, 6]);
    const B = ctx.array([10, 20, 30]);
    const sliced = A.slice([0, 6, 2]); // [1, 3, 5]
    const C = ctx.scope(s => s.mul(sliced, B));
    assert.deepStrictEqual(ctx.toArray(C), [10, 60, 150]);
  });

  it('strided neg on 2D', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[1, 2], [3, 4]]);
    const C = ctx.scope(s => s.neg(A.T));
    assert.deepStrictEqual(ctx.toArray(C), [[-1, -3], [-2, -4]]);
  });

  it('strided scalar add', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[1, 2], [3, 4]]);
    const C = ctx.scope(s => s.add(A.T, 10));
    assert.deepStrictEqual(ctx.toArray(C), [[11, 13], [12, 14]]);
  });

  it('strided sum reduction', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[1, 2], [3, 4]]);
    assert.equal(ctx.scope(s => s.sum(A.T)), 10);
  });

  it('strided min reduction', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[5, 1], [3, 8]]);
    assert.equal(ctx.scope(s => s.min(A.T)), 1);
  });

  it('strided max reduction', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[5, 1], [3, 8]]);
    assert.equal(ctx.scope(s => s.max(A.T)), 8);
  });

  it('strided prod reduction', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([2, 0, 3, 0, 4]);
    const s = A.slice([0, 5, 2]); // [2, 3, 4]
    assert.equal(ctx.scope(sc => sc.prod(s)), 24);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Multi-axis reductions
// ═════════════════════════════════════════════════════════════════════

describe('multi-axis reductions', () => {
  it('sum([0, 1]) on [2,3,4] → [4]', async () => {
    const ctx = await natra({ pages: 1 });
    // shape [2,3,4]: total 24 elements
    const data = [];
    for (let i = 0; i < 2; i++) {
      const plane = [];
      for (let j = 0; j < 3; j++) {
        const row = [];
        for (let k = 0; k < 4; k++) row.push(i * 12 + j * 4 + k + 1);
        plane.push(row);
      }
      data.push(plane);
    }
    const A = ctx.array(data);
    const C = ctx.scope(s => s.sum(A, [0, 1]));
    assert.deepStrictEqual(C.shape, [4]);
    // sum over axes 0 and 1: for each k, sum over i,j
    const expected = [0, 0, 0, 0];
    for (let i = 0; i < 2; i++)
      for (let j = 0; j < 3; j++)
        for (let k = 0; k < 4; k++)
          expected[k] += data[i][j][k];
    assert.deepStrictEqual(ctx.toArray(C), expected);
  });

  it('mean([0, 1]) on [2,3] → scalar-like [1]', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[1, 2, 3], [4, 5, 6]]);
    const C = ctx.scope(s => s.mean(A, [0, 1]));
    assert.deepStrictEqual(C.shape, [1]);
    // mean of all 6 elements = 21/6 = 3.5
    assertClose(ctx.toArray(C)[0], 3.5, 'mean([0,1])');
  });

  it('sum([0]) equals sum(0) — backward compatible', async () => {
    const ctx = await natra({ pages: 1 });
    const A = ctx.array([[1, 2, 3], [4, 5, 6]]);
    const C1 = ctx.scope(s => s.sum(A, [0]));
    const C2 = ctx.scope(s => s.sum(A, 0));
    assert.deepStrictEqual(ctx.toArray(C1), ctx.toArray(C2));
  });

  it('sum([1, 2]) on [2,3,4] → [2]', async () => {
    const ctx = await natra({ pages: 1 });
    const data = [];
    for (let i = 0; i < 2; i++) {
      const plane = [];
      for (let j = 0; j < 3; j++) {
        const row = [];
        for (let k = 0; k < 4; k++) row.push(i * 12 + j * 4 + k + 1);
        plane.push(row);
      }
      data.push(plane);
    }
    const A = ctx.array(data);
    const C = ctx.scope(s => s.sum(A, [1, 2]));
    assert.deepStrictEqual(C.shape, [2]);
    // For i=0: sum of 1..12 = 78, for i=1: sum of 13..24 = 222
    assert.deepStrictEqual(ctx.toArray(C), [78, 222]);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Wasm eigh
// ═════════════════════════════════════════════════════════════════════

describe('Wasm eigh', () => {
  it('3x3 analytical: eigenvalues match dsyev3', async () => {
    const ctx = await natra({ pages: 4 });
    const A = ctx.array([[4, 1, 0], [1, 3, 1], [0, 1, 2]]);
    const [vals, vecs] = ctx.scope(s => s.eigh(A));
    assert.deepStrictEqual(vals.shape, [3]);
    assert.deepStrictEqual(vecs.shape, [3, 3]);
    const w = ctx.toArray(vals);
    // Verify A*v ≈ λ*v for each eigenpair
    const V = ctx.toArray(vecs);
    const Amat = [[4,1,0],[1,3,1],[0,1,2]];
    for (let k = 0; k < 3; k++) {
      const lambda = w[k];
      const v = [V[0][k], V[1][k], V[2][k]];
      for (let i = 0; i < 3; i++) {
        const Av_i = Amat[i][0]*v[0] + Amat[i][1]*v[1] + Amat[i][2]*v[2];
        assertClose(Av_i, lambda * v[i], `3x3 Av[${i}] = lambda*v[${i}] for k=${k}`);
      }
    }
  });

  it('3x3 eigenvectors orthonormal: V^T * V ≈ I', async () => {
    const ctx = await natra({ pages: 4 });
    const A = ctx.array([[4, 1, 0], [1, 3, 1], [0, 1, 2]]);
    const [, vecs] = ctx.scope(s => s.eigh(A));
    const V = ctx.toArray(vecs);
    // Check V^T * V ≈ I
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        let dot = 0;
        for (let k = 0; k < 3; k++) dot += V[k][i] * V[k][j];
        const expected = i === j ? 1 : 0;
        assertClose(dot, expected, `V^T*V[${i},${j}]`);
      }
    }
  });

  it('large matrix (10x10) converges via general Jacobi', async () => {
    const ctx = await natra({ pages: 4 });
    // Build a symmetric 10x10 matrix
    const n = 10;
    const data = [];
    for (let i = 0; i < n; i++) {
      const row = [];
      for (let j = 0; j < n; j++) {
        row.push(i === j ? (i + 1) * 2 : 1.0 / (1 + Math.abs(i - j)));
      }
      data.push(row);
    }
    // Make symmetric
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++)
        data[j][i] = data[i][j];

    const A = ctx.array(data);
    const [vals, vecs] = ctx.scope(s => s.eigh(A));
    assert.deepStrictEqual(vals.shape, [n]);
    assert.deepStrictEqual(vecs.shape, [n, n]);

    const w = ctx.toArray(vals);
    const V = ctx.toArray(vecs);
    // Verify A*v ≈ λ*v for each eigenpair
    for (let k = 0; k < n; k++) {
      const lambda = w[k];
      const v = [];
      for (let i = 0; i < n; i++) v.push(V[i][k]);
      for (let i = 0; i < n; i++) {
        let Av_i = 0;
        for (let j = 0; j < n; j++) Av_i += data[i][j] * v[j];
        assertClose(Av_i, lambda * v[i], `10x10 Av[${i}] for k=${k}`);
      }
    }
  });

  it('diagonal matrix (trivial case)', async () => {
    const ctx = await natra({ pages: 4 });
    const A = ctx.array([[5, 0, 0], [0, 3, 0], [0, 0, 1]]);
    const [vals, vecs] = ctx.scope(s => s.eigh(A));
    const w = ctx.toArray(vals).sort((a, b) => a - b);
    assertClose(w[0], 1, 'eigenvalue 1');
    assertClose(w[1], 3, 'eigenvalue 2');
    assertClose(w[2], 5, 'eigenvalue 3');
  });

  it('2x2 works via general Jacobi path', async () => {
    const ctx = await natra({ pages: 4 });
    const A = ctx.array([[2, 1], [1, 2]]);
    const [vals, vecs] = ctx.scope(s => s.eigh(A));
    const w = ctx.toArray(vals).sort((a, b) => a - b);
    assertClose(w[0], 1, 'eigenvalue 1');
    assertClose(w[1], 3, 'eigenvalue 2');
  });
});
