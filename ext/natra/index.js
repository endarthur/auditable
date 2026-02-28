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

// ── Strided kernel generation helpers ────────────────────────────────

function genStridedEwise(name, op, ranks) {
  let src = '';
  for (const r of ranks) {
    const params = [];
    const vars = [];
    const loopVars = 'ijklmn'.slice(0, r).split('');
    params.push('a: array f64');
    for (let d = 0; d < r; d++) params.push(`sa${d}: i32`);
    params.push('b: array f64');
    for (let d = 0; d < r; d++) params.push(`sb${d}: i32`);
    params.push('out: array f64');
    for (let d = 0; d < r; d++) params.push(`so${d}: i32`);
    for (let d = 0; d < r; d++) params.push(`n${d}: i32`);
    vars.push(...loopVars.map(v => `${v}: i32`));
    const aIdx = loopVars.map((v, d) => `${v} * sa${d}`).join(' + ');
    const bIdx = loopVars.map((v, d) => `${v} * sb${d}`).join(' + ');
    const oIdx = loopVars.map((v, d) => `${v} * so${d}`).join(' + ');
    let body = `out[${oIdx}] := a[${aIdx}] ${op} b[${bIdx}]`;
    let loops = body;
    for (let d = r - 1; d >= 0; d--) {
      loops = `for ${loopVars[d]} := 0, n${d}\n    ${'  '.repeat(r - 1 - d)}${loops}\n  ${'  '.repeat(r - 1 - d)}end for`;
    }
    src += `\nsubroutine ewise.${name}.s${r}.f64(${params.join('; ')})\nvar ${vars.join(', ')}\nbegin\n  ${loops}\nend\n`;
  }
  return src;
}

function genStridedNeg(ranks) {
  let src = '';
  for (const r of ranks) {
    const params = [];
    const vars = [];
    const loopVars = 'ijklmn'.slice(0, r).split('');
    params.push('a: array f64');
    for (let d = 0; d < r; d++) params.push(`sa${d}: i32`);
    params.push('out: array f64');
    for (let d = 0; d < r; d++) params.push(`so${d}: i32`);
    for (let d = 0; d < r; d++) params.push(`n${d}: i32`);
    vars.push(...loopVars.map(v => `${v}: i32`));
    const aIdx = loopVars.map((v, d) => `${v} * sa${d}`).join(' + ');
    const oIdx = loopVars.map((v, d) => `${v} * so${d}`).join(' + ');
    let body = `out[${oIdx}] := -a[${aIdx}]`;
    let loops = body;
    for (let d = r - 1; d >= 0; d--) {
      loops = `for ${loopVars[d]} := 0, n${d}\n    ${'  '.repeat(r - 1 - d)}${loops}\n  ${'  '.repeat(r - 1 - d)}end for`;
    }
    src += `\nsubroutine ewise.neg.s${r}.f64(${params.join('; ')})\nvar ${vars.join(', ')}\nbegin\n  ${loops}\nend\n`;
  }
  return src;
}

function genStridedScalar(name, op, ranks) {
  let src = '';
  for (const r of ranks) {
    const params = [];
    const vars = [];
    const loopVars = 'ijklmn'.slice(0, r).split('');
    params.push('a: array f64');
    for (let d = 0; d < r; d++) params.push(`sa${d}: i32`);
    params.push('out: array f64');
    for (let d = 0; d < r; d++) params.push(`so${d}: i32`);
    for (let d = 0; d < r; d++) params.push(`n${d}: i32`);
    params.push('s: f64');
    vars.push(...loopVars.map(v => `${v}: i32`));
    const aIdx = loopVars.map((v, d) => `${v} * sa${d}`).join(' + ');
    const oIdx = loopVars.map((v, d) => `${v} * so${d}`).join(' + ');
    let body = `out[${oIdx}] := a[${aIdx}] ${op} s`;
    let loops = body;
    for (let d = r - 1; d >= 0; d--) {
      loops = `for ${loopVars[d]} := 0, n${d}\n    ${'  '.repeat(r - 1 - d)}${loops}\n  ${'  '.repeat(r - 1 - d)}end for`;
    }
    src += `\nsubroutine ewise.${name}.s${r}.f64(${params.join('; ')})\nvar ${vars.join(', ')}\nbegin\n  ${loops}\nend\n`;
  }
  return src;
}

function genStridedReduce(name, accumExpr, initExpr, ranks) {
  let src = '';
  for (const r of ranks) {
    const params = [];
    const vars = [];
    const loopVars = 'ijklmn'.slice(0, r).split('');
    params.push('a: array f64');
    for (let d = 0; d < r; d++) params.push(`sa${d}: i32`);
    for (let d = 0; d < r; d++) params.push(`n${d}: i32`);
    vars.push(...loopVars.map(v => `${v}: i32`));
    vars.push('acc: f64', 'v: f64');
    const aIdx = loopVars.map((v, d) => `${v} * sa${d}`).join(' + ');
    let body = `v := a[${aIdx}]\n      ${'  '.repeat(r - 1)}${accumExpr}`;
    let loops = body;
    for (let d = r - 1; d >= 0; d--) {
      loops = `for ${loopVars[d]} := 0, n${d}\n    ${'  '.repeat(r - 1 - d)}${loops}\n  ${'  '.repeat(r - 1 - d)}end for`;
    }
    src += `\nfunction reduce.${name}.s${r}.f64(${params.join('; ')}): f64\nvar ${vars.join('; ')}\nbegin\n  acc := ${initExpr}\n  ${loops}\n  reduce.${name}.s${r}.f64 := acc\nend\n`;
  }
  return src;
}

const STRIDED_KERNELS = [
  genStridedEwise('add', '+', [1,2,3]),
  genStridedEwise('sub', '-', [1,2,3]),
  genStridedEwise('mul', '*', [1,2,3]),
  genStridedEwise('div', '/', [1,2,3]),
  genStridedNeg([1,2,3]),
  genStridedScalar('adds', '+', [1,2,3]),
  genStridedScalar('muls', '*', [1,2,3]),
  genStridedReduce('sum', 'acc := acc + v', '0.0', [1,2,3]),
  genStridedReduce('min', 'if (v < acc) then\n        acc := v\n      end if', 'a[0]', [1,2,3]),
  genStridedReduce('max', 'if (v > acc) then\n        acc := v\n      end if', 'a[0]', [1,2,3]),
  genStridedReduce('prod', 'acc := acc * v', '1.0', [1,2,3]),
].join('\n');

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

! ── comparison (f64: 1.0 = true, 0.0 = false) ────────────────

subroutine cmp.eq.f64(a: array f64; b: array f64; out: array f64; n: i32)
var i: i32
begin
  for i := 0, n
    if (a[i] == b[i]) then
      out[i] := 1.0
    else
      out[i] := 0.0
    end if
  end for
end

subroutine cmp.ne.f64(a: array f64; b: array f64; out: array f64; n: i32)
var i: i32
begin
  for i := 0, n
    if (a[i] == b[i]) then
      out[i] := 0.0
    else
      out[i] := 1.0
    end if
  end for
end

subroutine cmp.lt.f64(a: array f64; b: array f64; out: array f64; n: i32)
var i: i32
begin
  for i := 0, n
    if (a[i] < b[i]) then
      out[i] := 1.0
    else
      out[i] := 0.0
    end if
  end for
end

subroutine cmp.le.f64(a: array f64; b: array f64; out: array f64; n: i32)
var i: i32
begin
  for i := 0, n
    if (a[i] <= b[i]) then
      out[i] := 1.0
    else
      out[i] := 0.0
    end if
  end for
end

subroutine cmp.gt.f64(a: array f64; b: array f64; out: array f64; n: i32)
var i: i32
begin
  for i := 0, n
    if (a[i] > b[i]) then
      out[i] := 1.0
    else
      out[i] := 0.0
    end if
  end for
end

subroutine cmp.ge.f64(a: array f64; b: array f64; out: array f64; n: i32)
var i: i32
begin
  for i := 0, n
    if (a[i] >= b[i]) then
      out[i] := 1.0
    else
      out[i] := 0.0
    end if
  end for
end

! ── conditional select ───────────────────────────────────────

subroutine where.f64(cond: array f64; a: array f64; b: array f64; out: array f64; n: i32)
var i: i32
begin
  for i := 0, n
    if (cond[i] /= 0.0) then
      out[i] := a[i]
    else
      out[i] := b[i]
    end if
  end for
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

${STRIDED_KERNELS}
`;

// ── Constants ────────────────────────────────────────────────────────

const ALIGN = 16; // 16-byte alignment for SIMD compat
const ITEMSIZE_F64 = 8;
const PAGE_SIZE = 65536; // WebAssembly page = 64KB

// ── Dead-array detection ──────────────────────────────────────────────

const _deadArrays = new WeakSet();

function checkLive(arr) {
  if (_deadArrays.has(arr))
    throw new Error('Array access after scope exit: this array was not returned from its scope and its memory has been reclaimed');
}

// ── Allocator ────────────────────────────────────────────────────────

function alignUp(n, a) {
  return (n + a - 1) & ~(a - 1);
}

function ensureMemory(memory, needed, maxPages) {
  const have = memory.buffer.byteLength;
  if (needed > have) {
    const pages = Math.ceil((needed - have) / PAGE_SIZE);
    if (maxPages !== undefined) {
      const totalPages = have / PAGE_SIZE + pages;
      if (totalPages > maxPages)
        throw new Error(`Memory limit exceeded: need ${totalPages} pages, max is ${maxPages} (${(maxPages * 64 / 1024).toFixed(0)} MB)`);
    }
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

// ── Display / formatting ─────────────────────────────────────────────

function _fmtVal(v) {
  if (Number.isNaN(v)) return 'nan';
  if (v === Infinity) return 'inf';
  if (v === -Infinity) return '-inf';
  if (Number.isInteger(v) && Math.abs(v) < 1e16) return String(v);
  const a = Math.abs(v);
  if (a >= 1e8 || (a !== 0 && a < 1e-4)) return v.toExponential(4);
  return v.toFixed(4).replace(/\.?0+$/, '');
}

function _formatNdarray(arr) {
  const f64 = new Float64Array(arr.memory.buffer);
  const ndim = arr.ndim;
  const total = arr.length;

  // 3D+ → compact single-line summary
  if (ndim > 2) {
    const LIMIT = 6;
    const vals = [];
    const indices = new Array(ndim).fill(0);
    const show = total <= LIMIT;
    for (let i = 0; i < total; i++) {
      if (!show && i === 3 && total > LIMIT) {
        vals.push('...');
        // skip to last 3
        i = total - 4;
        // advance indices to match
        let rem = total - 3;
        for (let d = 0; d < ndim; d++) {
          const below = arr.shape.slice(d + 1).reduce((a, b) => a * b, 1);
          indices[d] = Math.floor(rem / below);
          rem %= below;
        }
        continue;
      }
      let off = arr.ptr;
      for (let d = 0; d < ndim; d++) off += indices[d] * arr.strides[d];
      vals.push(_fmtVal(f64[off >> 3]));

      for (let d = ndim - 1; d >= 0; d--) {
        if (++indices[d] < arr.shape[d]) break;
        indices[d] = 0;
      }
    }
    return `array([${vals.join(', ')}], shape=[${arr.shape}], dtype=${arr.dtype})`;
  }

  // helper: read one element by multi-index
  function readEl(...idx) {
    let off = arr.ptr;
    for (let d = 0; d < ndim; d++) off += idx[d] * arr.strides[d];
    return f64[off >> 3];
  }

  // 1D
  if (ndim <= 1) {
    const n = arr.shape[0] || 0;
    const vals = [];
    if (n <= 6) {
      for (let i = 0; i < n; i++) vals.push(_fmtVal(readEl(i)));
    } else {
      for (let i = 0; i < 3; i++) vals.push(_fmtVal(readEl(i)));
      vals.push('...');
      for (let i = n - 3; i < n; i++) vals.push(_fmtVal(readEl(i)));
    }
    return `array([${vals.join(', ')}])`;
  }

  // 2D — multi-line, right-aligned columns
  const [rows, cols] = arr.shape;
  const truncRows = rows > 6;
  const truncCols = cols > 6;

  // determine which row/col indices to display
  const rowIdx = truncRows
    ? [0, 1, 2, -1, rows - 3, rows - 2, rows - 1]
    : Array.from({ length: rows }, (_, i) => i);
  const colIdx = truncCols
    ? [0, 1, 2, -1, cols - 3, cols - 2, cols - 1]
    : Array.from({ length: cols }, (_, i) => i);

  // format all visible cells and find column widths
  const grid = [];
  const colWidths = new Array(colIdx.length).fill(0);
  for (const ri of rowIdx) {
    if (ri === -1) { grid.push(null); continue; }
    const row = [];
    for (let ci = 0; ci < colIdx.length; ci++) {
      if (colIdx[ci] === -1) { row.push('...'); }
      else { row.push(_fmtVal(readEl(ri, colIdx[ci]))); }
      if (row[ci].length > colWidths[ci]) colWidths[ci] = row[ci].length;
    }
    grid.push(row);
  }

  // prefix: "array([" for first row, spaces for rest
  const prefix = 'array(';
  const indent = ' '.repeat(prefix.length);

  const lines = [];
  for (let gi = 0; gi < grid.length; gi++) {
    const row = grid[gi];
    const isFirst = gi === 0;
    const isLast = gi === grid.length - 1;
    const pre = isFirst ? prefix : indent;

    if (row === null) {
      // ellipsis row
      lines.push(indent + '       ...');
      continue;
    }

    const padded = row.map((v, ci) => v.padStart(colWidths[ci]));
    const inner = padded.join(', ');
    const open = '[';
    const close = isLast ? ']])' : '],';
    lines.push(pre + open + inner + close);
  }

  return lines.join('\n');
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

function stridedTernaryOp(memory, cPtr, cStrides, aPtr, aStrides, bPtr, bStrides, outPtr, outStrides, outShape, jsOp) {
  const ndim = outShape.length;
  const total = outShape.reduce((a, b) => a * b, 1);
  const f64 = new Float64Array(memory.buffer);
  const indices = new Array(ndim).fill(0);

  for (let flat = 0; flat < total; flat++) {
    let cOff = cPtr, aOff = aPtr, bOff = bPtr, oOff = outPtr;
    for (let d = 0; d < ndim; d++) {
      cOff += indices[d] * cStrides[d];
      aOff += indices[d] * aStrides[d];
      bOff += indices[d] * bStrides[d];
      oOff += indices[d] * outStrides[d];
    }
    f64[oOff >> 3] = jsOp(f64[cOff >> 3], f64[aOff >> 3], f64[bOff >> 3]);

    for (let d = ndim - 1; d >= 0; d--) {
      if (++indices[d] < outShape[d]) break;
      indices[d] = 0;
    }
  }
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

    toString() { return _formatNdarray(arr); },
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
  checkLive(arr);
  if (!isContiguous(arr)) throw new Error('Cannot create typed array view of non-contiguous array');
  return new Float64Array(arr.memory.buffer, arr.ptr, arr.length);
}

function toArray(arr) {
  checkLive(arr);
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
  checkLive(arr);
  let byteOffset = arr.ptr;
  for (let i = 0; i < indices.length; i++) {
    let idx = indices[i];
    if (idx < 0) idx += arr.shape[i];
    if (idx < 0 || idx >= arr.shape[i])
      throw new RangeError(`Index ${indices[i]} out of bounds for axis ${i} with size ${arr.shape[i]}`);
    byteOffset += idx * arr.strides[i];
  }
  return new Float64Array(arr.memory.buffer, byteOffset, 1)[0];
}

function setElement(arr, value, ...indices) {
  if (indices.length !== arr.ndim) throw new Error(`Expected ${arr.ndim} indices, got ${indices.length}`);
  checkLive(arr);
  let byteOffset = arr.ptr;
  for (let i = 0; i < indices.length; i++) {
    let idx = indices[i];
    if (idx < 0) idx += arr.shape[i];
    if (idx < 0 || idx >= arr.shape[i])
      throw new RangeError(`Index ${indices[i]} out of bounds for axis ${i} with size ${arr.shape[i]}`);
    byteOffset += idx * arr.strides[i];
  }
  new Float64Array(arr.memory.buffer, byteOffset, 1)[0] = value;
}

function copyArray(arr, memory, permPtr, maxPages) {
  checkLive(arr);
  const length = arr.shape.reduce((a, b) => a * b, 1);
  const nbytes = length * arr.itemsize;
  const ptr = allocPerm(memory, permPtr, nbytes, maxPages);
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

function allocPerm(memory, permPtr, nbytes, maxPages) {
  const ptr = alignUp(permPtr.value, ALIGN);
  permPtr.value = ptr + nbytes;
  ensureMemory(memory, permPtr.value, maxPages);
  return ptr;
}

function allocScratch(memory, heapPtr, nbytes, maxPages) {
  const ptr = alignUp(heapPtr.value, ALIGN);
  heapPtr.value = ptr + nbytes;
  ensureMemory(memory, heapPtr.value, maxPages);
  return ptr;
}

// ── Scope / Arena ────────────────────────────────────────────────────

class Arena {
  constructor(memory, heapPtr, parentArena, maxPages) {
    this.memory = memory;
    this.heapPtr = heapPtr;
    this.watermark = heapPtr.value;
    this.parent = parentArena;
    this.arrays = []; // track allocations for promotion
    this.maxPages = maxPages;
  }

  alloc(nbytes) {
    const ptr = allocScratch(this.memory, this.heapPtr, nbytes, this.maxPages);
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
  const maxPages = opts.maxPages !== undefined ? opts.maxPages : 16384; // default 1GB

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
    return allocPerm(memory, permPtr, nbytes, maxPages);
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
    const ptr = allocPerm(memory, permPtr, nbytes, maxPages);
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

  // ── RNG (xoshiro256**) ──────────────────────────────────────────

  const MASK64 = (1n << 64n) - 1n;

  function rotl64(x, k) {
    const kb = BigInt(k);
    return ((x << kb) | (x >> (64n - kb))) & MASK64;
  }

  // SplitMix64 for seed initialization
  function splitmix64Step(state) {
    state = (state + 0x9e3779b97f4a7c15n) & MASK64;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    return [(z ^ (z >> 31n)) & MASK64, state];
  }

  let rng0 = 0n, rng1 = 0n, rng2 = 0n, rng3 = 0n;

  function seed(n) {
    let st = BigInt(n) & MASK64;
    [rng0, st] = splitmix64Step(st);
    [rng1, st] = splitmix64Step(st);
    [rng2, st] = splitmix64Step(st);
    [rng3, st] = splitmix64Step(st);
  }

  seed(42); // default seed

  function nextU64() {
    const result = (rotl64((rng1 * 5n) & MASK64, 7) * 9n) & MASK64;
    const t = (rng1 << 17n) & MASK64;
    rng2 = (rng2 ^ rng0) & MASK64;
    rng3 = (rng3 ^ rng1) & MASK64;
    rng1 = (rng1 ^ rng2) & MASK64;
    rng0 = (rng0 ^ rng3) & MASK64;
    rng2 = (rng2 ^ t) & MASK64;
    rng3 = rotl64(rng3, 45);
    return result;
  }

  function nextF64() {
    return Number(nextU64() >> 11n) / 9007199254740992; // 2^53
  }

  function random(shape) {
    const arr = _allocArray(shape, null);
    const f64 = new Float64Array(memory.buffer, arr.ptr, arr.length);
    for (let i = 0; i < arr.length; i++) f64[i] = nextF64();
    if (heapPtr.value < permPtr.value) heapPtr.value = permPtr.value;
    return arr;
  }

  function randn(shape) {
    const arr = _allocArray(shape, null);
    const f64 = new Float64Array(memory.buffer, arr.ptr, arr.length);
    const len = arr.length;
    let i = 0;
    while (i + 1 < len) {
      let u1;
      do { u1 = nextF64(); } while (u1 === 0);
      const u2 = nextF64();
      const r = Math.sqrt(-2 * Math.log(u1));
      const theta = 2 * Math.PI * u2;
      f64[i++] = r * Math.cos(theta);
      f64[i++] = r * Math.sin(theta);
    }
    if (i < len) {
      let u1;
      do { u1 = nextF64(); } while (u1 === 0);
      const u2 = nextF64();
      f64[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    }
    if (heapPtr.value < permPtr.value) heapPtr.value = permPtr.value;
    return arr;
  }

  // ── Scope ────────────────────────────────────────────────────────

  function scope(fn) {
    // Save watermark
    const arena = new Arena(memory, heapPtr, null, maxPages);

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
      // Scalar or nothing — just reclaim scratch, mark all arena arrays as dead
      for (const arr of arena.arrays) _deadArrays.add(arr);
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
      // Nothing to promote, reclaim all scratch — mark all arena arrays as dead
      for (const arr of arena.arrays) _deadArrays.add(arr);
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

    // Mark unreturned arena arrays as dead
    const promotedSet = new Set(toPromote);
    for (const arr of arena.arrays) {
      if (!promotedSet.has(arr)) _deadArrays.add(arr);
    }

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
    const JS_EQ = (a, b) => a === b ? 1.0 : 0.0;
    const JS_NE = (a, b) => a !== b ? 1.0 : 0.0;
    const JS_LT = (a, b) => a < b   ? 1.0 : 0.0;
    const JS_LE = (a, b) => a <= b  ? 1.0 : 0.0;
    const JS_GT = (a, b) => a > b   ? 1.0 : 0.0;
    const JS_GE = (a, b) => a >= b  ? 1.0 : 0.0;
    const JS_WHERE = (c, a, b) => c !== 0.0 ? a : b;

    // ── Axis reduction helper ───────────────────────────────────────
    function axisReduce(a, axis, init, jsOp, finalize) {
      // Multi-axis: reduce sequentially (highest axis first to preserve indices)
      if (Array.isArray(axis)) {
        const axes = [...axis].sort((a, b) => b - a); // descending
        let result = a;
        for (const ax of axes) result = axisReduce(result, ax, init, jsOp, null);
        if (finalize) {
          // Apply finalize with total count across all reduced axes
          const totalLen = axis.reduce((acc, ax) => acc * a.shape[ax < 0 ? ax + a.ndim : ax], 1);
          const f64 = new Float64Array(memory.buffer);
          const fin = allocScoped(result.shape);
          for (let i = 0; i < result.length; i++) {
            f64[(fin.ptr >> 3) + i] = finalize(f64[(result.ptr >> 3) + i], totalLen);
          }
          return fin;
        }
        return result;
      }

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

    // Helper: convert byte strides to element strides (i32) for Wasm kernels
    const toElem = s => (s / ITEMSIZE_F64) | 0;

    // Call strided Wasm binary kernel if available for this rank
    function callStridedAA(kern, a, aStrides, b, bStrides, out, outStrides, outShape) {
      const ndim = outShape.length;
      if (ndim === 1) {
        kern[1](a.ptr, toElem(aStrides[0]), b.ptr, toElem(bStrides[0]),
          out.ptr, toElem(outStrides[0]), outShape[0]);
      } else if (ndim === 2) {
        kern[2](a.ptr, toElem(aStrides[0]), toElem(aStrides[1]),
          b.ptr, toElem(bStrides[0]), toElem(bStrides[1]),
          out.ptr, toElem(outStrides[0]), toElem(outStrides[1]),
          outShape[0], outShape[1]);
      } else {
        kern[3](a.ptr, toElem(aStrides[0]), toElem(aStrides[1]), toElem(aStrides[2]),
          b.ptr, toElem(bStrides[0]), toElem(bStrides[1]), toElem(bStrides[2]),
          out.ptr, toElem(outStrides[0]), toElem(outStrides[1]), toElem(outStrides[2]),
          outShape[0], outShape[1], outShape[2]);
      }
    }

    function callStridedScalar(kern, a, aStrides, out, outStrides, outShape, scalar) {
      const ndim = outShape.length;
      if (ndim === 1) {
        kern[1](a.ptr, toElem(aStrides[0]), out.ptr, toElem(outStrides[0]), outShape[0], scalar);
      } else if (ndim === 2) {
        kern[2](a.ptr, toElem(aStrides[0]), toElem(aStrides[1]),
          out.ptr, toElem(outStrides[0]), toElem(outStrides[1]),
          outShape[0], outShape[1], scalar);
      } else {
        kern[3](a.ptr, toElem(aStrides[0]), toElem(aStrides[1]), toElem(aStrides[2]),
          out.ptr, toElem(outStrides[0]), toElem(outStrides[1]), toElem(outStrides[2]),
          outShape[0], outShape[1], outShape[2], scalar);
      }
    }

    function callStridedNeg(kern, a, aStrides, out, outStrides, outShape) {
      const ndim = outShape.length;
      if (ndim === 1) {
        kern[1](a.ptr, toElem(aStrides[0]), out.ptr, toElem(outStrides[0]), outShape[0]);
      } else if (ndim === 2) {
        kern[2](a.ptr, toElem(aStrides[0]), toElem(aStrides[1]),
          out.ptr, toElem(outStrides[0]), toElem(outStrides[1]),
          outShape[0], outShape[1]);
      } else {
        kern[3](a.ptr, toElem(aStrides[0]), toElem(aStrides[1]), toElem(aStrides[2]),
          out.ptr, toElem(outStrides[0]), toElem(outStrides[1]), toElem(outStrides[2]),
          outShape[0], outShape[1], outShape[2]);
      }
    }

    function callStridedReduce(kern, a, aStrides, shape) {
      const ndim = shape.length;
      if (ndim === 1) {
        return kern[1](a.ptr, toElem(aStrides[0]), shape[0]);
      } else if (ndim === 2) {
        return kern[2](a.ptr, toElem(aStrides[0]), toElem(aStrides[1]), shape[0], shape[1]);
      } else {
        return kern[3](a.ptr, toElem(aStrides[0]), toElem(aStrides[1]), toElem(aStrides[2]),
          shape[0], shape[1], shape[2]);
      }
    }

    // Strided kernel maps (rank → Wasm kernel)
    const stridedAA = {
      add: { 1: K.ewise.add.s1.f64, 2: K.ewise.add.s2.f64, 3: K.ewise.add.s3.f64 },
      sub: { 1: K.ewise.sub.s1.f64, 2: K.ewise.sub.s2.f64, 3: K.ewise.sub.s3.f64 },
      mul: { 1: K.ewise.mul.s1.f64, 2: K.ewise.mul.s2.f64, 3: K.ewise.mul.s3.f64 },
      div: { 1: K.ewise.div.s1.f64, 2: K.ewise.div.s2.f64, 3: K.ewise.div.s3.f64 },
    };
    const stridedNegK = { 1: K.ewise.neg.s1.f64, 2: K.ewise.neg.s2.f64, 3: K.ewise.neg.s3.f64 };
    const stridedScalarK = {
      adds: { 1: K.ewise.adds.s1.f64, 2: K.ewise.adds.s2.f64, 3: K.ewise.adds.s3.f64 },
      muls: { 1: K.ewise.muls.s1.f64, 2: K.ewise.muls.s2.f64, 3: K.ewise.muls.s3.f64 },
    };
    const stridedReduceK = {
      sum: { 1: K.reduce.sum.s1.f64, 2: K.reduce.sum.s2.f64, 3: K.reduce.sum.s3.f64 },
      min: { 1: K.reduce.min.s1.f64, 2: K.reduce.min.s2.f64, 3: K.reduce.min.s3.f64 },
      max: { 1: K.reduce.max.s1.f64, 2: K.reduce.max.s2.f64, 3: K.reduce.max.s3.f64 },
      prod: { 1: K.reduce.prod.s1.f64, 2: K.reduce.prod.s2.f64, 3: K.reduce.prod.s3.f64 },
    };

    // Binary elementwise with scalar support and broadcasting
    function binaryOp(a, b, kernelAA, kernelAS, scalarMode, jsOp, stridedKern, stridedScalar) {
      const aIsScalar = typeof a === 'number';
      const bIsScalar = typeof b === 'number';

      if (aIsScalar && bIsScalar) return jsOp(a, b);

      if (bIsScalar) {
        const sv = scalarMode === 'negate' ? -b : scalarMode === 'reciprocal' ? 1 / b : b;
        if (isContiguous(a)) {
          const out = allocScoped(a.shape);
          kernelAS(a.ptr, out.ptr, a.length, sv);
          return out;
        }
        // Non-contiguous array + scalar — try strided Wasm kernel
        const ndim = a.ndim;
        if (ndim <= 3 && stridedScalar) {
          const out = allocScoped(a.shape);
          callStridedScalar(stridedScalar, a, a.strides, out, out.strides, a.shape, sv);
          return out;
        }
        const out = allocScoped(a.shape);
        stridedScalarOp(memory, a.ptr, a.strides, out.ptr, out.strides, a.shape, sv,
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

      // Strided Wasm path for 1D/2D/3D
      const ndim = outShape.length;
      if (ndim <= 3 && stridedKern) {
        const out = allocScoped(outShape);
        callStridedAA(stridedKern, a, aStrides, b, bStrides, out, out.strides, outShape);
        return out;
      }

      const out = allocScoped(outShape);
      stridedBinaryOp(memory, a.ptr, aStrides, b.ptr, bStrides, out.ptr, out.strides, outShape, jsOp);
      return out;
    }

    // Reduction helper: contiguous → Wasm, strided → Wasm (1D/2D/3D) or JS fallback
    function reduceOp(a, wasmKernel, init, jsOp, stridedK) {
      if (isContiguous(a)) return wasmKernel(a.ptr, a.length);
      if (stridedK && a.ndim <= 3) return callStridedReduce(stridedK, a, a.strides, a.shape);
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

    // Comparison op: same structure as binaryOp but simpler — no scalar kernel variants
    function cmpOp(a, b, wasmKernel, jsOp) {
      const aIsScalar = typeof a === 'number';
      const bIsScalar = typeof b === 'number';

      if (aIsScalar && bIsScalar) return jsOp(a, b);

      if (bIsScalar) {
        const out = allocScoped(a.shape);
        stridedScalarOp(memory, a.ptr, a.strides, out.ptr, out.strides, a.shape, b, jsOp);
        return out;
      }

      if (aIsScalar) {
        const out = allocScoped(b.shape);
        stridedScalarOp(memory, b.ptr, b.strides, out.ptr, out.strides, b.shape, a, (elem, s) => jsOp(s, elem));
        return out;
      }

      // Both arrays
      const sameShape = shapesEqual(a.shape, b.shape);
      if (sameShape && isContiguous(a) && isContiguous(b)) {
        const out = allocScoped(a.shape);
        wasmKernel(a.ptr, b.ptr, out.ptr, a.length);
        return out;
      }

      // Broadcast or non-contiguous
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

    const s = {
      add(a, b) { return binaryOp(a, b, K.ewise.add.f64, K.ewise.adds.f64, false, JS_ADD, stridedAA.add, stridedScalarK.adds); },
      sub(a, b) { return binaryOp(a, b, K.ewise.sub.f64, K.ewise.adds.f64, 'negate', JS_SUB, stridedAA.sub, stridedScalarK.adds); },
      mul(a, b) { return binaryOp(a, b, K.ewise.mul.f64, K.ewise.muls.f64, false, JS_MUL, stridedAA.mul, stridedScalarK.muls); },
      div(a, b) { return binaryOp(a, b, K.ewise.div.f64, K.ewise.muls.f64, 'reciprocal', JS_DIV, stridedAA.div, stridedScalarK.muls); },

      neg(a) {
        if (isContiguous(a)) {
          const out = allocScoped(a.shape);
          K.ewise.neg.f64(a.ptr, out.ptr, a.length);
          return out;
        }
        // Strided Wasm path for 1D/2D/3D
        const ndim = a.ndim;
        if (ndim <= 3) {
          const out = allocScoped(a.shape);
          callStridedNeg(stridedNegK, a, a.strides, out, out.strides, a.shape);
          return out;
        }
        const out = allocScoped(a.shape);
        stridedUnaryOp(memory, a.ptr, a.strides, out.ptr, out.strides, a.shape, JS_NEG);
        return out;
      },

      // Reductions — return scalar (no axis) or array (with axis)
      sum(a, axis) {
        if (axis === undefined) return reduceOp(a, K.reduce.sum.f64, 0, JS_ADD, stridedReduceK.sum);
        return axisReduce(a, axis, 0, JS_ADD);
      },
      mean(a, axis) {
        if (axis === undefined) return reduceOp(a, K.reduce.sum.f64, 0, JS_ADD, stridedReduceK.sum) / a.length;
        return axisReduce(a, axis, 0, JS_ADD, (acc, n) => acc / n);
      },
      min(a, axis) {
        if (axis === undefined) return reduceOp(a, K.reduce.min.f64, Infinity, (acc, v) => v < acc ? v : acc, stridedReduceK.min);
        return axisReduce(a, axis, Infinity, (acc, v) => v < acc ? v : acc);
      },
      max(a, axis) {
        if (axis === undefined) return reduceOp(a, K.reduce.max.f64, -Infinity, (acc, v) => v > acc ? v : acc, stridedReduceK.max);
        return axisReduce(a, axis, -Infinity, (acc, v) => v > acc ? v : acc);
      },
      prod(a, axis) {
        if (axis === undefined) return reduceOp(a, K.reduce.prod.f64, 1, JS_MUL, stridedReduceK.prod);
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
        const ac = copyToScoped(a);
        const wArr = allocScoped([n]);
        const vc = allocScoped([n, n]);

        if (n === 3) {
          // Analytical 3×3 — no iteration, no info check needed
          K.alpack.dsyev3v(ac.ptr, wArr.ptr, vc.ptr);
        } else {
          // General Jacobi with eigenvector accumulation
          const infoPtr = allocI32(1);
          K.alpack.dsyevv(ac.ptr, wArr.ptr, vc.ptr, n, infoPtr);
          const info = new Int32Array(memory.buffer, infoPtr, 1)[0];
          if (info !== 0) throw new Error('eigh: failed to converge');
        }
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

      // ── Comparison (f64 masks: 1.0 = true, 0.0 = false) ──────────

      eq(a, b) { return cmpOp(a, b, K.cmp.eq.f64, JS_EQ); },
      ne(a, b) { return cmpOp(a, b, K.cmp.ne.f64, JS_NE); },
      lt(a, b) { return cmpOp(a, b, K.cmp.lt.f64, JS_LT); },
      le(a, b) { return cmpOp(a, b, K.cmp.le.f64, JS_LE); },
      gt(a, b) { return cmpOp(a, b, K.cmp.gt.f64, JS_GT); },
      ge(a, b) { return cmpOp(a, b, K.cmp.ge.f64, JS_GE); },

      // ── Conditional select ────────────────────────────────────────

      where(cond, a, b) {
        const condIsScalar = typeof cond === 'number';
        const aIsScalar = typeof a === 'number';
        const bIsScalar = typeof b === 'number';

        if (condIsScalar && aIsScalar && bIsScalar) return cond !== 0 ? a : b;

        // Determine output shape from all non-scalar operands
        let outShape = null;
        for (const op of [cond, a, b]) {
          if (typeof op !== 'number') {
            outShape = outShape ? broadcastShapes(outShape, op.shape) : [...op.shape];
          }
        }

        // Fast path: all arrays, same shape, all contiguous
        if (!condIsScalar && !aIsScalar && !bIsScalar &&
            shapesEqual(cond.shape, a.shape) && shapesEqual(a.shape, b.shape) &&
            isContiguous(cond) && isContiguous(a) && isContiguous(b)) {
          const out = allocScoped(cond.shape);
          K.where.f64(cond.ptr, a.ptr, b.ptr, out.ptr, cond.length);
          return out;
        }

        // General path: broadcast + scalars via stridedTernaryOp with scalar temporaries
        // For each scalar operand, create a temp filled array
        let condArr = cond, aArr = a, bArr = b;
        const totalLen = outShape.reduce((x, y) => x * y, 1);

        if (condIsScalar) {
          condArr = allocScoped(outShape);
          K.fill.f64(condArr.ptr, totalLen, cond);
        }
        if (aIsScalar) {
          aArr = allocScoped(outShape);
          K.fill.f64(aArr.ptr, totalLen, a);
        }
        if (bIsScalar) {
          bArr = allocScoped(outShape);
          K.fill.f64(bArr.ptr, totalLen, b);
        }

        const cStrides = broadcastStrides(condArr.shape, condArr.strides, outShape);
        const aStrides = broadcastStrides(aArr.shape, aArr.strides, outShape);
        const bStrides = broadcastStrides(bArr.shape, bArr.strides, outShape);

        const out = allocScoped(outShape);
        stridedTernaryOp(memory, condArr.ptr, cStrides, aArr.ptr, aStrides, bArr.ptr, bStrides,
          out.ptr, out.strides, outShape, JS_WHERE);
        return out;
      },

      // ── Fancy indexing ────────────────────────────────────────────

      take(a, indices) {
        if (a.ndim !== 1) throw new Error('take: a must be 1D');
        if (indices.ndim !== 1) throw new Error('take: indices must be 1D');
        const f64 = new Float64Array(memory.buffer);
        const out = allocScoped([indices.length]);
        const n = indices.length;
        for (let i = 0; i < n; i++) {
          let idxOff = indices.ptr;
          for (let d = 0; d < indices.ndim; d++) idxOff += (d === 0 ? i : 0) * indices.strides[d];
          const idx = Math.trunc(f64[idxOff >> 3]);
          let aOff = a.ptr + idx * a.strides[0];
          f64[(out.ptr >> 3) + i] = f64[aOff >> 3];
        }
        return out;
      },

      compress(a, mask) {
        const aLen = a.length;
        const mLen = mask.length;
        if (aLen !== mLen) throw new Error(`compress: length mismatch: a=${aLen} vs mask=${mLen}`);
        const f64 = new Float64Array(memory.buffer);

        // Pass 1: count nonzero
        let count = 0;
        const aNdim = a.ndim, mNdim = mask.ndim;
        const aIndices = new Array(aNdim).fill(0);
        const mIndices = new Array(mNdim).fill(0);

        for (let flat = 0; flat < aLen; flat++) {
          let mOff = mask.ptr;
          for (let d = 0; d < mNdim; d++) mOff += mIndices[d] * mask.strides[d];
          if (f64[mOff >> 3] !== 0) count++;
          for (let d = mNdim - 1; d >= 0; d--) {
            if (++mIndices[d] < mask.shape[d]) break;
            mIndices[d] = 0;
          }
        }

        // Pass 2: gather
        const out = allocScoped([count]);
        mIndices.fill(0);
        const aInd2 = new Array(aNdim).fill(0);
        let outIdx = 0;
        for (let flat = 0; flat < aLen; flat++) {
          let mOff = mask.ptr;
          for (let d = 0; d < mNdim; d++) mOff += mIndices[d] * mask.strides[d];
          if (f64[mOff >> 3] !== 0) {
            let aOff = a.ptr;
            for (let d = 0; d < aNdim; d++) aOff += aInd2[d] * a.strides[d];
            f64[(out.ptr >> 3) + outIdx++] = f64[aOff >> 3];
          }
          for (let d = mNdim - 1; d >= 0; d--) {
            if (++mIndices[d] < mask.shape[d]) break;
            mIndices[d] = 0;
          }
          for (let d = aNdim - 1; d >= 0; d--) {
            if (++aInd2[d] < a.shape[d]) break;
            aInd2[d] = 0;
          }
        }
        return out;
      },

      argsort(a) {
        if (a.ndim !== 1) throw new Error('argsort: a must be 1D');
        const f64 = new Float64Array(memory.buffer);
        const n = a.length;

        // Read values (handles strides)
        const vals = new Array(n);
        for (let i = 0; i < n; i++) {
          vals[i] = f64[(a.ptr + i * a.strides[0]) >> 3];
        }

        // Build index array and sort
        const idx = new Array(n);
        for (let i = 0; i < n; i++) idx[i] = i;
        idx.sort((i, j) => vals[i] - vals[j]);

        // Write sorted indices
        const out = allocScoped([n]);
        const outF64 = new Float64Array(memory.buffer, out.ptr, n);
        for (let i = 0; i < n; i++) outF64[i] = idx[i];
        return out;
      },

      searchsorted(a, v) {
        if (a.ndim !== 1) throw new Error('searchsorted: a must be 1D');
        const f64 = new Float64Array(memory.buffer);
        const n = a.length;

        // Read a into JS array for binary search (handles strides)
        const aVals = new Array(n);
        for (let i = 0; i < n; i++) {
          aVals[i] = f64[(a.ptr + i * a.strides[0]) >> 3];
        }

        function bisectRight(val) {
          let lo = 0, hi = n;
          while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (aVals[mid] <= val) lo = mid + 1;
            else hi = mid;
          }
          return lo;
        }

        if (typeof v === 'number') return bisectRight(v);

        // v is an ndarray
        const out = allocScoped(v.shape);
        const vLen = v.length;
        const vNdim = v.ndim;
        const vIndices = new Array(vNdim).fill(0);
        for (let flat = 0; flat < vLen; flat++) {
          let vOff = v.ptr;
          for (let d = 0; d < vNdim; d++) vOff += vIndices[d] * v.strides[d];
          const val = f64[vOff >> 3];
          f64[(out.ptr >> 3) + flat] = bisectRight(val);
          for (let d = vNdim - 1; d >= 0; d--) {
            if (++vIndices[d] < v.shape[d]) break;
            vIndices[d] = 0;
          }
        }
        return out;
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
    random, randn, seed,
    scope, reset,

    // data access as methods (also available as module functions)
    toArray(arr) { return toArray(arr); },
    toTypedArray(arr) { return toTypedArray(arr); },
    get(arr, ...indices) { return getElement(arr, ...indices); },
    set(arr, value, ...indices) { return setElement(arr, value, ...indices); },
    copy(arr) {
      const result = copyArray(arr, memory, permPtr, maxPages);
      if (heapPtr.value < permPtr.value) heapPtr.value = permPtr.value;
      return result;
    },

    trace(arr) {
      const lines = [
        `shape:      [${arr.shape}]`,
        `dtype:      ${arr.dtype}`,
        `strides:    [${arr.strides}]`,
        `length:     ${arr.length}`,
        `nbytes:     ${arr.nbytes}`,
        `ptr:        ${arr.ptr}`,
        `contiguous: ${isContiguous(arr)}`,
        _formatNdarray(arr),
      ];
      return lines.join('\n');
    },
  };
}

export { natra };
