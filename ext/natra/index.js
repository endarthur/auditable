// natra — ndarray for the browser
// Bump-allocated f64 arrays over shared WebAssembly.Memory, with atra-compiled kernels.

// Resolve atra: check import cache, then installed modules (blob), then relative import.
// Blob URLs have no base path, so relative `import` fails inside embedded notebooks.
// See CLAUDE.md "inter-module imports in embedded/blob context" for the longer story.
let _atra;
const ATRA_KEYS = ['./ext/atra/index.js', '@atra', '../atra/index.js'];
async function getAtra() {
  if (_atra) return _atra;
  if (typeof window !== 'undefined') {
    // 1. already loaded via load()
    if (window._importCache) {
      for (const key of ATRA_KEYS) {
        if (window._importCache[key]?.atra) { _atra = window._importCache[key].atra; return _atra; }
      }
    }
    // 2. embedded but not yet loaded — import from blob URL (same as load() internals)
    if (window._installedModules) {
      for (const key of ATRA_KEYS) {
        const entry = window._installedModules[key];
        if (entry) {
          const src = typeof entry === 'string' ? entry : entry.source;
          const blob = new Blob([src], { type: 'application/javascript' });
          const url = URL.createObjectURL(blob);
          const mod = await import(url);
          if (mod.atra) { _atra = mod.atra; return _atra; }
        }
      }
    }
  }
  // 3. direct file import (Node.js tests, local dev server)
  const mod = await import('../atra/index.js');
  _atra = mod.atra;
  return _atra;
}

// Resolve alpack source distribution (same resolution pattern as atra)
let _alpackAll;
const ALPACK_KEYS = ['./ext/atra/lib/alpack.src.js', '../atra/lib/alpack.src.js'];
async function getAlpackAll() {
  if (_alpackAll) return _alpackAll;
  if (typeof window !== 'undefined') {
    if (window._importCache) {
      for (const key of ALPACK_KEYS) {
        if (window._importCache[key]?.all) { _alpackAll = window._importCache[key].all; return _alpackAll; }
      }
    }
    if (window._installedModules) {
      for (const key of ALPACK_KEYS) {
        const entry = window._installedModules[key];
        if (entry) {
          const src = typeof entry === 'string' ? entry : entry.source;
          const blob = new Blob([src], { type: 'application/javascript' });
          const url = URL.createObjectURL(blob);
          const mod = await import(url);
          if (mod.all) { _alpackAll = mod.all; return _alpackAll; }
        }
      }
    }
  }
  const mod = await import('../atra/lib/alpack.src.js');
  _alpackAll = mod.all;
  return _alpackAll;
}

// ── Kernel source (atra) ─────────────────────────────────────────────

const KERNEL_SRC = `
! ── elementwise (contiguous f64) ──────────────────────────────

subroutine ewise.add.f64(a: array f64; b: array f64; out: array f64; n: i32)
var i: i32
begin
  for i := 0, n
    out[i] := a[i] + b[i]
  end for
end

subroutine ewise.sub.f64(a: array f64; b: array f64; out: array f64; n: i32)
var i: i32
begin
  for i := 0, n
    out[i] := a[i] - b[i]
  end for
end

subroutine ewise.mul.f64(a: array f64; b: array f64; out: array f64; n: i32)
var i: i32
begin
  for i := 0, n
    out[i] := a[i] * b[i]
  end for
end

subroutine ewise.div.f64(a: array f64; b: array f64; out: array f64; n: i32)
var i: i32
begin
  for i := 0, n
    out[i] := a[i] / b[i]
  end for
end

subroutine ewise.neg.f64(a: array f64; out: array f64; n: i32)
var i: i32
begin
  for i := 0, n
    out[i] := -a[i]
  end for
end

subroutine ewise.adds.f64(a: array f64; out: array f64; n: i32; s: f64)
var i: i32
begin
  for i := 0, n
    out[i] := a[i] + s
  end for
end

subroutine ewise.muls.f64(a: array f64; out: array f64; n: i32; s: f64)
var i: i32
begin
  for i := 0, n
    out[i] := a[i] * s
  end for
end

! ── reductions ────────────────────────────────────────────────

function reduce.sum.f64(a: array f64; n: i32): f64
var i: i32; s: f64
begin
  s := 0.0
  for i := 0, n
    s := s + a[i]
  end for
  reduce.sum.f64 := s
end

function reduce.min.f64(a: array f64; n: i32): f64
var i: i32; m: f64
begin
  m := a[0]
  for i := 1, n
    if (a[i] < m) then
      m := a[i]
    end if
  end for
  reduce.min.f64 := m
end

function reduce.max.f64(a: array f64; n: i32): f64
var i: i32; m: f64
begin
  m := a[0]
  for i := 1, n
    if (a[i] > m) then
      m := a[i]
    end if
  end for
  reduce.max.f64 := m
end

function reduce.prod.f64(a: array f64; n: i32): f64
var i: i32; p: f64
begin
  p := 1.0
  for i := 0, n
    p := p * a[i]
  end for
  reduce.prod.f64 := p
end

! ── nan-safe reductions ───────────────────────────────────────

function reduce.nansum.f64(a: array f64; n: i32): f64
var i: i32; s: f64
begin
  s := 0.0
  for i := 0, n
    if (a[i] == a[i]) then
      s := s + a[i]
    end if
  end for
  reduce.nansum.f64 := s
end

function reduce.nanmin.f64(a: array f64; n: i32): f64
var i: i32; m: f64; found: i32
begin
  found := 0
  m := 0.0
  for i := 0, n
    if (a[i] == a[i]) then
      if (found == 0) then
        m := a[i]
        found := 1
      else if (a[i] < m) then
        m := a[i]
      end if
    end if
  end for
  reduce.nanmin.f64 := m
end

function reduce.nanmax.f64(a: array f64; n: i32): f64
var i: i32; m: f64; found: i32
begin
  found := 0
  m := 0.0
  for i := 0, n
    if (a[i] == a[i]) then
      if (found == 0) then
        m := a[i]
        found := 1
      else if (a[i] > m) then
        m := a[i]
      end if
    end if
  end for
  reduce.nanmax.f64 := m
end

function reduce.nanprod.f64(a: array f64; n: i32): f64
var i: i32; p: f64
begin
  p := 1.0
  for i := 0, n
    if (a[i] == a[i]) then
      p := p * a[i]
    end if
  end for
  reduce.nanprod.f64 := p
end

function reduce.nancount.f64(a: array f64; n: i32): i32
var i, c: i32
begin
  c := 0
  for i := 0, n
    if (a[i] == a[i]) then
      c := c + 1
    end if
  end for
  reduce.nancount.f64 := c
end

! ── fill ──────────────────────────────────────────────────────

subroutine fill.f64(a: array f64; n: i32; val: f64)
var i: i32
begin
  for i := 0, n
    a[i] := val
  end for
end

subroutine fill.zero(a: array i32; nbytes: i32)
var i, n: i32
begin
  n := nbytes / 4
  for i := 0, n
    a[i] := 0
  end for
end
`;

// ── Constants ────────────────────────────────────────────────────────

const ALIGN = 16; // 16-byte alignment for SIMD compat
const ITEMSIZE_F64 = 8;
const PAGE_SIZE = 65536; // WebAssembly page = 64KB

// ── Allocator ────────────────────────────────────────────────────────

function alignUp(n, a) {
  return (n + a - 1) & ~(a - 1);
}

function ensureMemory(memory, needed) {
  const have = memory.buffer.byteLength;
  if (needed > have) {
    const pages = Math.ceil((needed - have) / PAGE_SIZE);
    memory.grow(pages);
  }
}

// ── Contiguity check ────────────────────────────────────────────────

function isContiguous(arr) {
  let stride = arr.itemsize;
  for (let i = arr.ndim - 1; i >= 0; i--) {
    if (arr.strides[i] !== stride) return false;
    stride *= arr.shape[i];
  }
  return true;
}

// ── Broadcasting ────────────────────────────────────────────────────

function broadcastShapes(shapeA, shapeB) {
  const ndim = Math.max(shapeA.length, shapeB.length);
  const out = new Array(ndim);
  for (let i = 0; i < ndim; i++) {
    const da = i < ndim - shapeA.length ? 1 : shapeA[i - (ndim - shapeA.length)];
    const db = i < ndim - shapeB.length ? 1 : shapeB[i - (ndim - shapeB.length)];
    if (da !== db && da !== 1 && db !== 1) {
      throw new Error(`Incompatible shapes for broadcasting: [${shapeA}] vs [${shapeB}]`);
    }
    out[i] = Math.max(da, db);
  }
  return out;
}

function broadcastStrides(shape, strides, targetShape) {
  const ndim = targetShape.length;
  const offset = ndim - shape.length;
  const out = new Array(ndim);
  for (let i = 0; i < ndim; i++) {
    if (i < offset) {
      out[i] = 0; // prepend 0-strides for missing leading dimensions
    } else {
      out[i] = shape[i - offset] === 1 ? 0 : strides[i - offset];
    }
  }
  return out;
}

// ── Strided element access ──────────────────────────────────────────

function stridedBinaryOp(memory, aPtr, aStrides, bPtr, bStrides, outPtr, outStrides, outShape, jsOp) {
  const ndim = outShape.length;
  const total = outShape.reduce((a, b) => a * b, 1);
  const f64 = new Float64Array(memory.buffer);
  const indices = new Array(ndim).fill(0);

  for (let flat = 0; flat < total; flat++) {
    let aOff = aPtr, bOff = bPtr, oOff = outPtr;
    for (let d = 0; d < ndim; d++) {
      aOff += indices[d] * aStrides[d];
      bOff += indices[d] * bStrides[d];
      oOff += indices[d] * outStrides[d];
    }
    f64[oOff >> 3] = jsOp(f64[aOff >> 3], f64[bOff >> 3]);

    // increment indices (last dimension fastest)
    for (let d = ndim - 1; d >= 0; d--) {
      if (++indices[d] < outShape[d]) break;
      indices[d] = 0;
    }
  }
}

function stridedUnaryOp(memory, aPtr, aStrides, outPtr, outStrides, outShape, jsOp) {
  const ndim = outShape.length;
  const total = outShape.reduce((a, b) => a * b, 1);
  const f64 = new Float64Array(memory.buffer);
  const indices = new Array(ndim).fill(0);

  for (let flat = 0; flat < total; flat++) {
    let aOff = aPtr, oOff = outPtr;
    for (let d = 0; d < ndim; d++) {
      aOff += indices[d] * aStrides[d];
      oOff += indices[d] * outStrides[d];
    }
    f64[oOff >> 3] = jsOp(f64[aOff >> 3]);

    for (let d = ndim - 1; d >= 0; d--) {
      if (++indices[d] < outShape[d]) break;
      indices[d] = 0;
    }
  }
}

function stridedReduce(memory, aPtr, aStrides, shape, init, jsOp) {
  const ndim = shape.length;
  const total = shape.reduce((a, b) => a * b, 1);
  const f64 = new Float64Array(memory.buffer);
  const indices = new Array(ndim).fill(0);
  let acc = init;

  for (let flat = 0; flat < total; flat++) {
    let aOff = aPtr;
    for (let d = 0; d < ndim; d++) {
      aOff += indices[d] * aStrides[d];
    }
    acc = jsOp(acc, f64[aOff >> 3]);

    for (let d = ndim - 1; d >= 0; d--) {
      if (++indices[d] < shape[d]) break;
      indices[d] = 0;
    }
  }
  return acc;
}

function stridedScalarOp(memory, aPtr, aStrides, outPtr, outStrides, outShape, scalar, jsOp) {
  const ndim = outShape.length;
  const total = outShape.reduce((a, b) => a * b, 1);
  const f64 = new Float64Array(memory.buffer);
  const indices = new Array(ndim).fill(0);

  for (let flat = 0; flat < total; flat++) {
    let aOff = aPtr, oOff = outPtr;
    for (let d = 0; d < ndim; d++) {
      aOff += indices[d] * aStrides[d];
      oOff += indices[d] * outStrides[d];
    }
    f64[oOff >> 3] = jsOp(f64[aOff >> 3], scalar);

    for (let d = ndim - 1; d >= 0; d--) {
      if (++indices[d] < outShape[d]) break;
      indices[d] = 0;
    }
  }
}

// ── ndarray descriptor ───────────────────────────────────────────────

function makeArray(ptr, dtype, shape, strides, memory, arena) {
  const ndim = shape.length;
  const length = shape.reduce((a, b) => a * b, 1);
  const itemsize = ITEMSIZE_F64; // f64 only for now
  const nbytes = length * itemsize;
  const frozenShape = Object.freeze([...shape]);
  const frozenStrides = Object.freeze([...strides]);

  const arr = {
    ptr, dtype, ndim, length, itemsize, nbytes,
    shape: frozenShape,
    strides: frozenStrides,
    memory, _arena: arena,

    get T() {
      if (ndim <= 1) return arr;
      return makeArray(ptr, dtype, [...frozenShape].reverse(), [...frozenStrides].reverse(), memory, null);
    },

    reshape(newShape) {
      if (!isContiguous(arr)) throw new Error('Cannot reshape non-contiguous array');
      const newLen = newShape.reduce((a, b) => a * b, 1);
      if (newLen !== length) throw new Error(`Cannot reshape [${frozenShape}] (${length} elements) to [${newShape}] (${newLen} elements)`);
      return makeArray(ptr, dtype, newShape, contiguousStrides(newShape), memory, null);
    },

    slice(...ranges) {
      let newPtr = ptr;
      const newShape = [];
      const newStrides = [];

      for (let d = 0; d < ndim; d++) {
        const r = d < ranges.length ? ranges[d] : null;
        const dimSize = frozenShape[d];
        const dimStride = frozenStrides[d];

        if (r === null) {
          // full slice
          newShape.push(dimSize);
          newStrides.push(dimStride);
        } else if (typeof r === 'number') {
          // integer index — dimension reduction
          const idx = r < 0 ? r + dimSize : r;
          newPtr += idx * dimStride;
          // dimension removed from output
        } else if (Array.isArray(r)) {
          let [start, stop, step] = r;
          if (step === undefined) step = 1;
          if (start < 0) start += dimSize;
          if (stop < 0) stop += dimSize;
          newPtr += start * dimStride;
          const n = Math.max(0, Math.ceil((stop - start) / step));
          newShape.push(n);
          newStrides.push(dimStride * step);
        }
      }

      if (newShape.length === 0) {
        // all dims indexed — return scalar-shaped array [1]
        newShape.push(1);
        newStrides.push(ITEMSIZE_F64);
      }

      return makeArray(newPtr, dtype, newShape, newStrides, memory, null);
    },

    diag() {
      if (ndim !== 2) throw new Error('diag() requires a 2D array');
      if (frozenShape[0] !== frozenShape[1]) throw new Error('diag() requires a square matrix');
      const n = frozenShape[0];
      const diagStride = frozenStrides[0] + frozenStrides[1];
      return makeArray(ptr, dtype, [n], [diagStride], memory, null);
    },
  };

  Object.freeze(arr);
  return arr;
}

function contiguousStrides(shape) {
  const ndim = shape.length;
  const strides = new Array(ndim);
  let stride = ITEMSIZE_F64;
  for (let i = ndim - 1; i >= 0; i--) {
    strides[i] = stride;
    stride *= shape[i];
  }
  return strides;
}

function inferShape(data) {
  if (!Array.isArray(data)) return [];
  const shape = [data.length];
  let inner = data[0];
  while (Array.isArray(inner)) {
    shape.push(inner.length);
    inner = inner[0];
  }
  return shape;
}

function flattenData(data, out, offset) {
  if (!Array.isArray(data)) {
    out[offset[0]++] = data;
    return;
  }
  for (let i = 0; i < data.length; i++) {
    flattenData(data[i], out, offset);
  }
}

// ── Data access ──────────────────────────────────────────────────────

function toTypedArray(arr) {
  if (!isContiguous(arr)) throw new Error('Cannot create typed array view of non-contiguous array');
  return new Float64Array(arr.memory.buffer, arr.ptr, arr.length);
}

function toArray(arr) {
  if (isContiguous(arr)) {
    // Fast path: contiguous layout
    const f64 = new Float64Array(arr.memory.buffer, arr.ptr, arr.length);
    if (arr.ndim <= 1) return Array.from(f64);
    return _unflattenRec(f64, arr.shape, 0, 0);
  }
  // Strided path: non-contiguous layout
  return _stridedToArray(arr, 0, arr.ptr);
}

function _stridedToArray(arr, dim, byteOffset) {
  const f64 = new Float64Array(arr.memory.buffer);
  const n = arr.shape[dim];
  if (dim === arr.ndim - 1) {
    const row = new Array(n);
    for (let i = 0; i < n; i++) {
      row[i] = f64[(byteOffset + i * arr.strides[dim]) >> 3];
    }
    return dim === 0 && arr.ndim === 1 ? row : row;
  }
  const result = new Array(n);
  for (let i = 0; i < n; i++) {
    result[i] = _stridedToArray(arr, dim + 1, byteOffset + i * arr.strides[dim]);
  }
  return result;
}

function _unflattenRec(flat, shape, dim, offset) {
  const n = shape[dim];
  if (dim === shape.length - 1) {
    const row = new Array(n);
    for (let i = 0; i < n; i++) row[i] = flat[offset + i];
    return row;
  }
  const stride = shape.slice(dim + 1).reduce((a, b) => a * b, 1);
  const result = new Array(n);
  for (let i = 0; i < n; i++) {
    result[i] = _unflattenRec(flat, shape, dim + 1, offset + i * stride);
  }
  return result;
}

function getElement(arr, ...indices) {
  if (indices.length !== arr.ndim) throw new Error(`Expected ${arr.ndim} indices, got ${indices.length}`);
  let byteOffset = arr.ptr;
  for (let i = 0; i < indices.length; i++) {
    byteOffset += indices[i] * arr.strides[i];
  }
  return new Float64Array(arr.memory.buffer, byteOffset, 1)[0];
}

function setElement(arr, value, ...indices) {
  if (indices.length !== arr.ndim) throw new Error(`Expected ${arr.ndim} indices, got ${indices.length}`);
  let byteOffset = arr.ptr;
  for (let i = 0; i < indices.length; i++) {
    byteOffset += indices[i] * arr.strides[i];
  }
  new Float64Array(arr.memory.buffer, byteOffset, 1)[0] = value;
}

function copyArray(arr, memory, permPtr) {
  const length = arr.shape.reduce((a, b) => a * b, 1);
  const nbytes = length * arr.itemsize;
  const ptr = allocPerm(memory, permPtr, nbytes);
  if (isContiguous(arr) && arr.memory === memory) {
    const src = new Uint8Array(arr.memory.buffer, arr.ptr, nbytes);
    new Uint8Array(memory.buffer, ptr, nbytes).set(src);
  } else {
    // Strided copy — element by element into contiguous output
    const srcF64 = new Float64Array(arr.memory.buffer);
    const dstF64 = new Float64Array(memory.buffer);
    const ndim = arr.ndim;
    const indices = new Array(ndim).fill(0);
    for (let flat = 0; flat < length; flat++) {
      let srcOff = arr.ptr;
      for (let d = 0; d < ndim; d++) srcOff += indices[d] * arr.strides[d];
      dstF64[(ptr + flat * arr.itemsize) >> 3] = srcF64[srcOff >> 3];
      for (let d = ndim - 1; d >= 0; d--) {
        if (++indices[d] < arr.shape[d]) break;
        indices[d] = 0;
      }
    }
  }
  const strides = contiguousStrides(arr.shape);
  return makeArray(ptr, arr.dtype, arr.shape, strides, memory, null);
}

function allocPerm(memory, permPtr, nbytes) {
  const ptr = alignUp(permPtr.value, ALIGN);
  permPtr.value = ptr + nbytes;
  ensureMemory(memory, permPtr.value);
  return ptr;
}

function allocScratch(memory, heapPtr, nbytes) {
  const ptr = alignUp(heapPtr.value, ALIGN);
  heapPtr.value = ptr + nbytes;
  ensureMemory(memory, heapPtr.value);
  return ptr;
}

// ── Scope / Arena ────────────────────────────────────────────────────

class Arena {
  constructor(memory, heapPtr, parentArena) {
    this.memory = memory;
    this.heapPtr = heapPtr;
    this.watermark = heapPtr.value;
    this.parent = parentArena;
    this.arrays = []; // track allocations for promotion
  }

  alloc(nbytes) {
    const ptr = allocScratch(this.memory, this.heapPtr, nbytes);
    return ptr;
  }

  track(arr) {
    this.arrays.push(arr);
  }
}

// ── Context factory ──────────────────────────────────────────────────

async function natra(opts = {}) {
  const pages = opts.pages || 256;
  const memory = opts.memory || new WebAssembly.Memory({ initial: pages });

  // Compile kernels (natra elementwise/reduce + alpack linalg in one Wasm instance)
  const atra = await getAtra();
  const alpackSrc = await getAlpackAll();
  const K = atra.run(KERNEL_SRC + '\n' + alpackSrc, { memory });

  // Allocator state
  const permPtr = { value: 0 };
  const heapPtr = { value: 0 };

  // ── Internal helpers ─────────────────────────────────────────────

  function _alloc(nbytes, arena) {
    if (arena) {
      const ptr = arena.alloc(nbytes);
      return ptr;
    }
    return allocPerm(memory, permPtr, nbytes);
  }

  function _makeNd(ptr, shape, arena) {
    const strides = contiguousStrides(shape);
    const arr = makeArray(ptr, 'f64', shape, strides, memory, arena);
    if (arena) arena.track(arr);
    return arr;
  }

  function _allocArray(shape, arena) {
    const length = shape.reduce((a, b) => a * b, 1);
    const nbytes = length * ITEMSIZE_F64;
    const ptr = _alloc(nbytes, arena);
    return _makeNd(ptr, shape, arena);
  }

  // ── Array creation ───────────────────────────────────────────────

  function array(data, opts) {
    const shape = (opts && opts.shape) ? opts.shape : inferShape(data);
    const length = shape.reduce((a, b) => a * b, 1);
    const nbytes = length * ITEMSIZE_F64;
    const ptr = allocPerm(memory, permPtr, nbytes);
    const f64 = new Float64Array(memory.buffer, ptr, length);
    if (Array.isArray(data)) {
      if (Array.isArray(data[0]) || (opts && opts.shape)) {
        // Nested or flat with explicit shape
        const flat = new Array(length);
        const offset = [0];
        if (Array.isArray(data[0])) {
          flattenData(data, flat, offset);
        } else {
          for (let i = 0; i < length; i++) flat[i] = data[i];
        }
        f64.set(flat);
      } else {
        f64.set(data);
      }
    } else if (ArrayBuffer.isView(data)) {
      f64.set(data);
    }
    // Sync heapPtr to stay ahead of permPtr
    if (heapPtr.value < permPtr.value) heapPtr.value = permPtr.value;
    const strides = contiguousStrides(shape);
    return makeArray(ptr, 'f64', shape, strides, memory, null);
  }

  function zeros(shape) {
    const arr = _allocArray(shape, null);
    K.fill.zero(arr.ptr, arr.nbytes);
    if (heapPtr.value < permPtr.value) heapPtr.value = permPtr.value;
    return arr;
  }

  function ones(shape) {
    const arr = _allocArray(shape, null);
    K.fill.f64(arr.ptr, arr.length, 1.0);
    if (heapPtr.value < permPtr.value) heapPtr.value = permPtr.value;
    return arr;
  }

  function full(shape, val) {
    const arr = _allocArray(shape, null);
    K.fill.f64(arr.ptr, arr.length, val);
    if (heapPtr.value < permPtr.value) heapPtr.value = permPtr.value;
    return arr;
  }

  function eye(n) {
    const arr = zeros([n, n]);
    const f64 = new Float64Array(memory.buffer, arr.ptr, arr.length);
    for (let i = 0; i < n; i++) f64[i * n + i] = 1.0;
    return arr;
  }

  function linspace(start, stop, num) {
    const shape = [num];
    const arr = _allocArray(shape, null);
    const f64 = new Float64Array(memory.buffer, arr.ptr, num);
    if (num === 1) {
      f64[0] = start;
    } else {
      const step = (stop - start) / (num - 1);
      for (let i = 0; i < num; i++) f64[i] = start + i * step;
    }
    if (heapPtr.value < permPtr.value) heapPtr.value = permPtr.value;
    return arr;
  }

  function arange(start, stop, step) {
    if (step === undefined) step = 1;
    const n = Math.max(0, Math.ceil((stop - start) / step));
    const shape = [n];
    const arr = _allocArray(shape, null);
    const f64 = new Float64Array(memory.buffer, arr.ptr, n);
    for (let i = 0; i < n; i++) f64[i] = start + i * step;
    if (heapPtr.value < permPtr.value) heapPtr.value = permPtr.value;
    return arr;
  }

  // ── Scope ────────────────────────────────────────────────────────

  function scope(fn) {
    // Save watermark
    const arena = new Arena(memory, heapPtr, null);

    // Build scope object with ops
    const s = makeScopeOps(arena);

    // Run user function
    const result = fn(s);

    // Promote returned arrays
    return promote(result, arena);
  }

  function promote(result, arena) {
    const watermark = arena.watermark;

    if (result === undefined || result === null || typeof result === 'number') {
      // Scalar or nothing — just reclaim scratch
      heapPtr.value = watermark;
      if (permPtr.value < heapPtr.value) permPtr.value = heapPtr.value;
      return result;
    }

    // Collect arrays to promote (those allocated in this arena)
    const toPromote = [];
    if (result && result.ptr !== undefined && result._arena === arena) {
      toPromote.push(result);
    } else if (Array.isArray(result)) {
      for (const r of result) {
        if (r && r.ptr !== undefined && r._arena === arena) toPromote.push(r);
      }
    }

    if (toPromote.length === 0) {
      // Nothing to promote, reclaim all scratch
      heapPtr.value = watermark;
      if (permPtr.value < heapPtr.value) permPtr.value = heapPtr.value;
      return result;
    }

    // Sort by ptr for compact copy
    toPromote.sort((a, b) => a.ptr - b.ptr);

    // Compact: copy each to watermark position
    let dest = watermark;
    const promoted = [];
    for (const arr of toPromote) {
      const alignedDest = alignUp(dest, ALIGN);
      if (alignedDest !== arr.ptr) {
        // Move data
        const src = new Uint8Array(memory.buffer, arr.ptr, arr.nbytes);
        new Uint8Array(memory.buffer, alignedDest, arr.nbytes).set(src);
      }
      const newArr = makeArray(alignedDest, arr.dtype, arr.shape, arr.strides, memory, null);
      promoted.push(newArr);
      dest = alignedDest + arr.nbytes;
    }

    // Update pointers
    heapPtr.value = dest;
    permPtr.value = dest;

    // Return in same shape as input
    if (Array.isArray(result)) {
      // Map promoted arrays back into result positions by original ptr
      const ptrMap = new Map();
      for (let i = 0; i < toPromote.length; i++) ptrMap.set(toPromote[i].ptr, promoted[i]);
      return result.map(r => {
        if (r && r.ptr !== undefined && r._arena === arena) return ptrMap.get(r.ptr);
        return r;
      });
    }
    return promoted[0];
  }

  // ── Scope operations ─────────────────────────────────────────────

  function makeScopeOps(arena) {
    function allocScoped(shape) {
      const length = shape.reduce((a, b) => a * b, 1);
      const nbytes = length * ITEMSIZE_F64;
      const ptr = arena.alloc(nbytes);
      const arr = makeArray(ptr, 'f64', shape, contiguousStrides(shape), memory, arena);
      arena.track(arr);
      return arr;
    }

    // JS ops for strided fallbacks
    const JS_ADD = (a, b) => a + b;
    const JS_SUB = (a, b) => a - b;
    const JS_MUL = (a, b) => a * b;
    const JS_DIV = (a, b) => a / b;
    const JS_NEG = a => -a;

    // ── Axis reduction helper ───────────────────────────────────────
    function axisReduce(a, axis, init, jsOp, finalize) {
      if (axis < 0) axis += a.ndim;
      if (axis < 0 || axis >= a.ndim) throw new Error(`axis ${axis} out of range for ndim ${a.ndim}`);

      const outShape = [...a.shape];
      outShape.splice(axis, 1);
      if (outShape.length === 0) outShape.push(1);

      const out = allocScoped(outShape);
      const f64 = new Float64Array(memory.buffer);
      const outLen = outShape.reduce((x, y) => x * y, 1);

      // Initialize output
      for (let i = 0; i < outLen; i++) f64[(out.ptr >> 3) + i] = init;

      const ndim = a.ndim;
      const axisLen = a.shape[axis];
      const outIndices = new Array(outShape.length).fill(0);

      for (let flat = 0; flat < outLen; flat++) {
        let oOff = out.ptr;
        for (let d = 0; d < outShape.length; d++) oOff += outIndices[d] * out.strides[d];

        let acc = init;
        for (let k = 0; k < axisLen; k++) {
          let aOff = a.ptr;
          let od = 0;
          for (let d = 0; d < ndim; d++) {
            if (d === axis) aOff += k * a.strides[d];
            else aOff += outIndices[od++] * a.strides[d];
          }
          acc = jsOp(acc, f64[aOff >> 3]);
        }

        f64[oOff >> 3] = finalize ? finalize(acc, axisLen) : acc;

        for (let d = outShape.length - 1; d >= 0; d--) {
          if (++outIndices[d] < outShape[d]) break;
          outIndices[d] = 0;
        }
      }

      return out;
    }

    function shapesEqual(a, b) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    }

    // Binary elementwise with scalar support and broadcasting
    function binaryOp(a, b, kernelAA, kernelAS, scalarMode, jsOp) {
      const aIsScalar = typeof a === 'number';
      const bIsScalar = typeof b === 'number';

      if (aIsScalar && bIsScalar) return jsOp(a, b);

      if (bIsScalar) {
        const s = scalarMode === 'negate' ? -b : scalarMode === 'reciprocal' ? 1 / b : b;
        if (isContiguous(a)) {
          const out = allocScoped(a.shape);
          kernelAS(a.ptr, out.ptr, a.length, s);
          return out;
        }
        // Non-contiguous array + scalar
        const out = allocScoped(a.shape);
        stridedScalarOp(memory, a.ptr, a.strides, out.ptr, out.strides, a.shape, s,
          scalarMode === 'negate' ? JS_ADD : scalarMode === 'reciprocal' ? JS_MUL : jsOp === JS_ADD ? JS_ADD : JS_MUL);
        return out;
      }

      if (aIsScalar) {
        if (isContiguous(b)) {
          if (kernelAA === K.ewise.add.f64 || kernelAA === K.ewise.mul.f64) {
            const out = allocScoped(b.shape);
            kernelAS(b.ptr, out.ptr, b.length, a);
            return out;
          }
          if (kernelAA === K.ewise.sub.f64) {
            const out = allocScoped(b.shape);
            K.ewise.neg.f64(b.ptr, out.ptr, b.length);
            K.ewise.adds.f64(out.ptr, out.ptr, b.length, a);
            return out;
          }
          if (kernelAA === K.ewise.div.f64) {
            const onesArr = allocScoped(b.shape);
            K.fill.f64(onesArr.ptr, b.length, a);
            const out = allocScoped(b.shape);
            K.ewise.div.f64(onesArr.ptr, b.ptr, out.ptr, b.length);
            return out;
          }
        }
        // Non-contiguous: scalar op via strided loop
        const out = allocScoped(b.shape);
        stridedScalarOp(memory, b.ptr, b.strides, out.ptr, out.strides, b.shape, a,
          (elem, s) => jsOp(s, elem));
        return out;
      }

      // Both arrays — check for broadcasting
      const sameShape = shapesEqual(a.shape, b.shape);
      if (sameShape && isContiguous(a) && isContiguous(b)) {
        // Fast path: same shape, both contiguous → Wasm kernel
        const out = allocScoped(a.shape);
        kernelAA(a.ptr, b.ptr, out.ptr, a.length);
        return out;
      }

      // Broadcast or non-contiguous path
      let outShape, aStrides, bStrides;
      if (sameShape) {
        outShape = [...a.shape];
        aStrides = [...a.strides];
        bStrides = [...b.strides];
      } else {
        outShape = broadcastShapes(a.shape, b.shape);
        aStrides = broadcastStrides(a.shape, a.strides, outShape);
        bStrides = broadcastStrides(b.shape, b.strides, outShape);
      }

      const out = allocScoped(outShape);
      stridedBinaryOp(memory, a.ptr, aStrides, b.ptr, bStrides, out.ptr, out.strides, outShape, jsOp);
      return out;
    }

    // Reduction helper: contiguous → Wasm, strided → JS
    function reduceOp(a, wasmKernel, init, jsOp) {
      if (isContiguous(a)) return wasmKernel(a.ptr, a.length);
      return stridedReduce(memory, a.ptr, a.strides, a.shape, init, jsOp);
    }

    // ── Linalg helpers ──────────────────────────────────────────────────

    // Allocate i32 scratch (for ipiv, info arrays). Always scratch, never promoted.
    function allocI32(n) {
      const nbytes = n * 4;
      const ptr = arena.alloc(nbytes);
      return ptr;
    }

    // Copy ndarray to contiguous scratch. If already contiguous, copies data.
    // Returns a new contiguous scoped ndarray.
    function copyToScoped(a) {
      const out = allocScoped(a.shape);
      if (isContiguous(a)) {
        new Uint8Array(memory.buffer, out.ptr, a.nbytes).set(
          new Uint8Array(memory.buffer, a.ptr, a.nbytes));
      } else {
        // Strided copy element by element
        const f64src = new Float64Array(memory.buffer);
        const f64dst = new Float64Array(memory.buffer);
        const ndim = a.ndim;
        const indices = new Array(ndim).fill(0);
        for (let flat = 0; flat < a.length; flat++) {
          let srcOff = a.ptr;
          for (let d = 0; d < ndim; d++) srcOff += indices[d] * a.strides[d];
          f64dst[(out.ptr + flat * ITEMSIZE_F64) >> 3] = f64src[srcOff >> 3];
          for (let d = ndim - 1; d >= 0; d--) {
            if (++indices[d] < a.shape[d]) break;
            indices[d] = 0;
          }
        }
      }
      return out;
    }

    const s = {
      add(a, b) { return binaryOp(a, b, K.ewise.add.f64, K.ewise.adds.f64, false, JS_ADD); },
      sub(a, b) { return binaryOp(a, b, K.ewise.sub.f64, K.ewise.adds.f64, 'negate', JS_SUB); },
      mul(a, b) { return binaryOp(a, b, K.ewise.mul.f64, K.ewise.muls.f64, false, JS_MUL); },
      div(a, b) { return binaryOp(a, b, K.ewise.div.f64, K.ewise.muls.f64, 'reciprocal', JS_DIV); },

      neg(a) {
        if (isContiguous(a)) {
          const out = allocScoped(a.shape);
          K.ewise.neg.f64(a.ptr, out.ptr, a.length);
          return out;
        }
        const out = allocScoped(a.shape);
        stridedUnaryOp(memory, a.ptr, a.strides, out.ptr, out.strides, a.shape, JS_NEG);
        return out;
      },

      // Reductions — return scalar (no axis) or array (with axis)
      sum(a, axis) {
        if (axis === undefined) return reduceOp(a, K.reduce.sum.f64, 0, JS_ADD);
        return axisReduce(a, axis, 0, JS_ADD);
      },
      mean(a, axis) {
        if (axis === undefined) return reduceOp(a, K.reduce.sum.f64, 0, JS_ADD) / a.length;
        return axisReduce(a, axis, 0, JS_ADD, (acc, n) => acc / n);
      },
      min(a, axis) {
        if (axis === undefined) {
          if (isContiguous(a)) return K.reduce.min.f64(a.ptr, a.length);
          return stridedReduce(memory, a.ptr, a.strides, a.shape, Infinity, (acc, v) => v < acc ? v : acc);
        }
        return axisReduce(a, axis, Infinity, (acc, v) => v < acc ? v : acc);
      },
      max(a, axis) {
        if (axis === undefined) {
          if (isContiguous(a)) return K.reduce.max.f64(a.ptr, a.length);
          return stridedReduce(memory, a.ptr, a.strides, a.shape, -Infinity, (acc, v) => v > acc ? v : acc);
        }
        return axisReduce(a, axis, -Infinity, (acc, v) => v > acc ? v : acc);
      },
      prod(a, axis) {
        if (axis === undefined) return reduceOp(a, K.reduce.prod.f64, 1, JS_MUL);
        return axisReduce(a, axis, 1, JS_MUL);
      },

      // NaN-safe reductions — skip NaN values
      nansum(a, axis) {
        if (axis === undefined) {
          if (isContiguous(a)) return K.reduce.nansum.f64(a.ptr, a.length);
          return stridedReduce(memory, a.ptr, a.strides, a.shape, 0, (acc, v) => v === v ? acc + v : acc);
        }
        return axisReduce(a, axis, 0, (acc, v) => v === v ? acc + v : acc);
      },
      nanmean(a, axis) {
        if (axis === undefined) {
          if (isContiguous(a)) {
            const c = K.reduce.nancount.f64(a.ptr, a.length);
            return c > 0 ? K.reduce.nansum.f64(a.ptr, a.length) / c : NaN;
          }
          let sum = 0, count = 0;
          stridedReduce(memory, a.ptr, a.strides, a.shape, 0, (_, v) => { if (v === v) { sum += v; count++; } return 0; });
          return count > 0 ? sum / count : NaN;
        }
        // Two-pass: nansum then nancount, divide element-wise
        const sums = axisReduce(a, axis, 0, (acc, v) => v === v ? acc + v : acc);
        const counts = axisReduce(a, axis, 0, (acc, v) => v === v ? acc + 1 : acc);
        const f64 = new Float64Array(memory.buffer);
        const result = allocScoped(sums.shape);
        for (let i = 0; i < sums.length; i++) {
          const sv = f64[(sums.ptr >> 3) + i];
          const cv = f64[(counts.ptr >> 3) + i];
          f64[(result.ptr >> 3) + i] = cv > 0 ? sv / cv : NaN;
        }
        return result;
      },
      nanmin(a, axis) {
        if (axis === undefined) {
          if (isContiguous(a)) return K.reduce.nancount.f64(a.ptr, a.length) > 0 ? K.reduce.nanmin.f64(a.ptr, a.length) : NaN;
          let m = NaN;
          stridedReduce(memory, a.ptr, a.strides, a.shape, 0, (_, v) => { if (v === v && (m !== m || v < m)) m = v; return 0; });
          return m;
        }
        // NaN as init — first non-NaN replaces it, then min logic
        const out = axisReduce(a, axis, NaN, (acc, v) => {
          if (v !== v) return acc; // v is NaN, skip
          if (acc !== acc) return v; // acc is NaN, take v
          return v < acc ? v : acc;
        });
        return out;
      },
      nanmax(a, axis) {
        if (axis === undefined) {
          if (isContiguous(a)) return K.reduce.nancount.f64(a.ptr, a.length) > 0 ? K.reduce.nanmax.f64(a.ptr, a.length) : NaN;
          let m = NaN;
          stridedReduce(memory, a.ptr, a.strides, a.shape, 0, (_, v) => { if (v === v && (m !== m || v > m)) m = v; return 0; });
          return m;
        }
        const out = axisReduce(a, axis, NaN, (acc, v) => {
          if (v !== v) return acc;
          if (acc !== acc) return v;
          return v > acc ? v : acc;
        });
        return out;
      },
      nanprod(a, axis) {
        if (axis === undefined) {
          if (isContiguous(a)) return K.reduce.nanprod.f64(a.ptr, a.length);
          return stridedReduce(memory, a.ptr, a.strides, a.shape, 1, (acc, v) => v === v ? acc * v : acc);
        }
        return axisReduce(a, axis, 1, (acc, v) => v === v ? acc * v : acc);
      },

      // ── Linear algebra ──────────────────────────────────────────────

      matmul(a, b) {
        if (a.ndim !== 2) throw new Error('matmul: a must be 2D');
        const matvec = b.ndim === 1;
        if (!matvec && b.ndim !== 2) throw new Error('matmul: b must be 1D or 2D');

        const m = a.shape[0], ka = a.shape[1];
        const kb = matvec ? b.shape[0] : b.shape[0];
        const n = matvec ? 1 : b.shape[1];
        if (ka !== kb) throw new Error(`matmul: inner dimensions mismatch: ${ka} vs ${kb}`);

        // Ensure contiguous inputs
        const ac = isContiguous(a) ? a : copyToScoped(a);
        const bc = isContiguous(b) ? b : copyToScoped(b);

        const out = allocScoped([m, n]);
        // zero output (dgemm uses beta*C + alpha*A*B, with beta=0 we need C initialized)
        K.fill.zero(out.ptr, out.nbytes);
        K.alas.dgemm(ac.ptr, bc.ptr, out.ptr, m, n, ka, 1.0, 0.0);

        if (matvec) {
          // Return [m] not [m,1] — reinterpret same allocation
          const vec = makeArray(out.ptr, 'f64', [m], [ITEMSIZE_F64], memory, arena);
          arena.track(vec);
          return vec;
        }
        return out;
      },

      dot(a, b) {
        if (a.ndim !== 1 || b.ndim !== 1) throw new Error('dot: both must be 1D');
        if (a.shape[0] !== b.shape[0]) throw new Error(`dot: length mismatch: ${a.shape[0]} vs ${b.shape[0]}`);
        const ac = isContiguous(a) ? a : copyToScoped(a);
        const bc = isContiguous(b) ? b : copyToScoped(b);
        return K.alas.ddot(ac.ptr, bc.ptr, a.shape[0]);
      },

      solve(a, b) {
        if (a.ndim !== 2 || a.shape[0] !== a.shape[1]) throw new Error('solve: a must be 2D square');
        const n = a.shape[0];
        const bIsVec = b.ndim === 1;
        if (bIsVec) {
          if (b.shape[0] !== n) throw new Error(`solve: b length ${b.shape[0]} != n ${n}`);
        } else {
          if (b.ndim !== 2 || b.shape[0] !== n) throw new Error(`solve: b first dimension ${b.shape[0]} != n ${n}`);
        }
        const nrhs = bIsVec ? 1 : b.shape[1];

        // Copy A and B to scratch (both destroyed by dgesv)
        const ac = copyToScoped(a);
        // Copy B to scratch. For 1D b, reshape to [n,1] column for dgesv.
        let bc;
        if (bIsVec) {
          bc = allocScoped([n, 1]);
          const f64 = new Float64Array(memory.buffer);
          if (isContiguous(b)) {
            new Uint8Array(memory.buffer, bc.ptr, b.nbytes).set(
              new Uint8Array(memory.buffer, b.ptr, b.nbytes));
          } else {
            for (let i = 0; i < n; i++) {
              let off = b.ptr;
              off += i * b.strides[0];
              f64[(bc.ptr >> 3) + i] = f64[off >> 3];
            }
          }
        } else {
          bc = copyToScoped(b);
        }

        const ipivPtr = allocI32(n);
        const infoPtr = allocI32(1);

        K.alpack.dgesv(ac.ptr, bc.ptr, n, nrhs, ipivPtr, infoPtr);
        const info = new Int32Array(memory.buffer, infoPtr, 1)[0];
        if (info !== 0) throw new Error(`solve: singular matrix (info=${info})`);

        if (bIsVec) {
          // Return [n] not [n,1] — reinterpret same allocation
          const vec = makeArray(bc.ptr, 'f64', [n], [ITEMSIZE_F64], memory, arena);
          arena.track(vec);
          return vec;
        }
        return bc;
      },

      cholesky(a) {
        if (a.ndim !== 2 || a.shape[0] !== a.shape[1]) throw new Error('cholesky: a must be 2D square');
        const n = a.shape[0];
        const ac = copyToScoped(a);
        const infoPtr = allocI32(1);

        K.alpack.dpotrf(ac.ptr, n, infoPtr);
        const info = new Int32Array(memory.buffer, infoPtr, 1)[0];
        if (info !== 0) throw new Error(`cholesky: not positive definite (info=${info})`);

        // Zero upper triangle (dpotrf leaves junk there)
        const f64 = new Float64Array(memory.buffer);
        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
            f64[(ac.ptr >> 3) + i * n + j] = 0;
          }
        }
        return ac;
      },

      inv(a) {
        if (a.ndim !== 2 || a.shape[0] !== a.shape[1]) throw new Error('inv: a must be 2D square');
        const n = a.shape[0];

        // Solve A * X = I
        const ac = copyToScoped(a);
        // Build identity as RHS
        const bc = allocScoped([n, n]);
        K.fill.zero(bc.ptr, bc.nbytes);
        const f64 = new Float64Array(memory.buffer);
        for (let i = 0; i < n; i++) f64[(bc.ptr >> 3) + i * n + i] = 1;

        const ipivPtr = allocI32(n);
        const infoPtr = allocI32(1);

        K.alpack.dgesv(ac.ptr, bc.ptr, n, n, ipivPtr, infoPtr);
        const info = new Int32Array(memory.buffer, infoPtr, 1)[0];
        if (info !== 0) throw new Error(`inv: singular matrix (info=${info})`);

        return bc;
      },

      det(a) {
        if (a.ndim !== 2 || a.shape[0] !== a.shape[1]) throw new Error('det: a must be 2D square');
        const n = a.shape[0];
        const ac = copyToScoped(a);
        const ipivPtr = allocI32(n);
        const infoPtr = allocI32(1);

        K.alpack.dgetrf(ac.ptr, n, ipivPtr, infoPtr);
        const info = new Int32Array(memory.buffer, infoPtr, 1)[0];
        if (info !== 0) return 0; // singular

        // det = product of diagonal * (-1)^(number of row swaps)
        const f64 = new Float64Array(memory.buffer);
        const ipiv = new Int32Array(memory.buffer, ipivPtr, n);
        let det = 1;
        let swaps = 0;
        for (let i = 0; i < n; i++) {
          det *= f64[(ac.ptr >> 3) + i * n + i];
          if (ipiv[i] !== i) swaps++;
        }
        return (swaps % 2 === 0) ? det : -det;
      },

      eigh(a) {
        if (a.ndim !== 2 || a.shape[0] !== a.shape[1]) throw new Error('eigh: a must be 2D square');
        const n = a.shape[0];

        // Copy a to scratch — dsyev destroys it (converges to diagonal)
        const ac = copyToScoped(a);

        // Allocate eigenvector matrix V = I, accumulate Jacobi rotations
        const vc = allocScoped([n, n]);
        K.fill.zero(vc.ptr, vc.nbytes);
        const f64 = new Float64Array(memory.buffer);
        for (let i = 0; i < n; i++) f64[(vc.ptr >> 3) + i * n + i] = 1;

        // JS Jacobi with eigenvector accumulation
        const maxIter = 100;
        const w = new Float64Array(n);
        for (let i = 0; i < n; i++) w[i] = f64[(ac.ptr >> 3) + i * n + i];

        for (let iter = 0; iter < maxIter; iter++) {
          let off = 0;
          for (let p = 0; p < n; p++)
            for (let q = p + 1; q < n; q++)
              off += f64[(ac.ptr >> 3) + p * n + q] ** 2;
          if (off < 1e-28) break;

          const thresh = iter < 4 ? 0.2 * off / (n * n) : 0;

          for (let p = 0; p < n; p++) {
            for (let q = p + 1; q < n; q++) {
              const apq = f64[(ac.ptr >> 3) + p * n + q];
              if (Math.abs(apq) <= thresh) continue;

              const app = w[p], aqq = w[q];
              const tau = (aqq - app) / (2 * apq);
              const t = tau >= 0
                ? 1 / (tau + Math.sqrt(1 + tau * tau))
                : -1 / (-tau + Math.sqrt(1 + tau * tau));
              const c = 1 / Math.sqrt(1 + t * t);
              const sn = t * c;

              w[p] = app - t * apq;
              w[q] = aqq + t * apq;
              f64[(ac.ptr >> 3) + p * n + q] = 0;

              // Rotate rows/columns of A
              for (let i = 0; i < p; i++) {
                const aip = f64[(ac.ptr >> 3) + i * n + p];
                const aiq = f64[(ac.ptr >> 3) + i * n + q];
                f64[(ac.ptr >> 3) + i * n + p] = c * aip - sn * aiq;
                f64[(ac.ptr >> 3) + i * n + q] = sn * aip + c * aiq;
              }
              for (let i = p + 1; i < q; i++) {
                const api = f64[(ac.ptr >> 3) + p * n + i];
                const aiq = f64[(ac.ptr >> 3) + i * n + q];
                f64[(ac.ptr >> 3) + p * n + i] = c * api - sn * aiq;
                f64[(ac.ptr >> 3) + i * n + q] = sn * api + c * aiq;
              }
              for (let i = q + 1; i < n; i++) {
                const api = f64[(ac.ptr >> 3) + p * n + i];
                const aqi = f64[(ac.ptr >> 3) + q * n + i];
                f64[(ac.ptr >> 3) + p * n + i] = c * api - sn * aqi;
                f64[(ac.ptr >> 3) + q * n + i] = sn * api + c * aqi;
              }

              // Accumulate eigenvectors: V := V * G(p,q)
              for (let i = 0; i < n; i++) {
                const vip = f64[(vc.ptr >> 3) + i * n + p];
                const viq = f64[(vc.ptr >> 3) + i * n + q];
                f64[(vc.ptr >> 3) + i * n + p] = c * vip - sn * viq;
                f64[(vc.ptr >> 3) + i * n + q] = sn * vip + c * viq;
              }
            }
          }
        }

        // Write eigenvalues to scoped array
        const wArr = allocScoped([n]);
        const wf64 = new Float64Array(memory.buffer, wArr.ptr, n);
        wf64.set(w);

        return [wArr, vc];
      },

      norm(a) {
        if (a.ndim === 1) {
          // L2 norm
          const ac = isContiguous(a) ? a : copyToScoped(a);
          return K.alas.dnrm2(ac.ptr, a.shape[0]);
        }
        if (a.ndim === 2) {
          // Frobenius norm: sqrt(sum of squares of all elements)
          if (isContiguous(a)) {
            return K.alas.dnrm2(a.ptr, a.length);
          }
          const sum = stridedReduce(memory, a.ptr, a.strides, a.shape, 0, (acc, v) => acc + v * v);
          return Math.sqrt(sum);
        }
        throw new Error('norm: array must be 1D or 2D');
      },
    };

    return s;
  }

  // ── Reset ────────────────────────────────────────────────────────

  function reset() {
    permPtr.value = 0;
    heapPtr.value = 0;
  }

  // ── Public API ───────────────────────────────────────────────────

  return {
    memory,
    array, zeros, ones, full, eye, linspace, arange,
    scope, reset,

    // data access as methods (also available as module functions)
    toArray(arr) { return toArray(arr); },
    toTypedArray(arr) { return toTypedArray(arr); },
    get(arr, ...indices) { return getElement(arr, ...indices); },
    set(arr, value, ...indices) { return setElement(arr, value, ...indices); },
    copy(arr) {
      const result = copyArray(arr, memory, permPtr);
      if (heapPtr.value < permPtr.value) heapPtr.value = permPtr.value;
      return result;
    },
  };
}

export { natra };
