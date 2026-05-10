// NdArray — contiguous row-major Float64Array with shape metadata.
//
// Always contiguous: shape changes (reshape, slice, transpose, row/col) produce
// new arrays. No views, no buffer sharing. This keeps inner loops flat-iterating
// the backing Float64Array — exactly the shape V8 inlines and vectorizes hardest.

export function shapeProduct(shape) {
  let n = 1;
  for (let i = 0; i < shape.length; i++) n *= shape[i];
  return n;
}

export function computeStrides(shape) {
  const n = shape.length;
  const strides = new Array(n);
  let s = 1;
  for (let i = n - 1; i >= 0; i--) {
    strides[i] = s;
    s *= shape[i];
  }
  return strides;
}

export function validateShape(shape) {
  if (!Array.isArray(shape)) {
    throw new TypeError(`shape must be an array, got ${typeof shape}`);
  }
  for (let i = 0; i < shape.length; i++) {
    const d = shape[i];
    if (!Number.isInteger(d) || d < 0) {
      throw new RangeError(`shape[${i}] must be a non-negative integer, got ${d}`);
    }
  }
}

export class NdArray {
  constructor(data, shape) {
    if (!(data instanceof Float64Array)) {
      throw new TypeError('NdArray data must be Float64Array');
    }
    validateShape(shape);
    const size = shapeProduct(shape);
    if (data.length !== size) {
      throw new RangeError(
        `data length ${data.length} does not match shape product ${size} (shape=[${shape.join(',')}])`
      );
    }
    this.data = data;
    this.shape = shape.slice();
    this.strides = computeStrides(this.shape);
    this.size = size;
    this.ndim = shape.length;
    this.dtype = 'f64';
  }

  get(...indices) {
    if (indices.length !== this.ndim) {
      throw new RangeError(`expected ${this.ndim} indices, got ${indices.length}`);
    }
    let off = 0;
    for (let i = 0; i < indices.length; i++) {
      const ix = indices[i];
      const dim = this.shape[i];
      if (!Number.isInteger(ix) || ix < 0 || ix >= dim) {
        throw new RangeError(`index ${ix} out of bounds for axis ${i} with size ${dim}`);
      }
      off += ix * this.strides[i];
    }
    return this.data[off];
  }

  set(...args) {
    if (args.length !== this.ndim + 1) {
      throw new RangeError(`expected ${this.ndim} indices + 1 value, got ${args.length} args`);
    }
    let off = 0;
    for (let i = 0; i < this.ndim; i++) {
      const ix = args[i];
      const dim = this.shape[i];
      if (!Number.isInteger(ix) || ix < 0 || ix >= dim) {
        throw new RangeError(`index ${ix} out of bounds for axis ${i} with size ${dim}`);
      }
      off += ix * this.strides[i];
    }
    this.data[off] = args[this.ndim];
  }

  row(i) {
    if (this.ndim !== 2) {
      throw new RangeError(`row() requires 2D array, got ${this.ndim}D`);
    }
    const cols = this.shape[1];
    if (!Number.isInteger(i) || i < 0 || i >= this.shape[0]) {
      throw new RangeError(`row index ${i} out of bounds for shape [${this.shape.join(',')}]`);
    }
    const out = new Float64Array(cols);
    const off = i * cols;
    for (let j = 0; j < cols; j++) out[j] = this.data[off + j];
    return new NdArray(out, [cols]);
  }

  col(j) {
    if (this.ndim !== 2) {
      throw new RangeError(`col() requires 2D array, got ${this.ndim}D`);
    }
    const rows = this.shape[0];
    const cols = this.shape[1];
    if (!Number.isInteger(j) || j < 0 || j >= cols) {
      throw new RangeError(`col index ${j} out of bounds for shape [${this.shape.join(',')}]`);
    }
    const out = new Float64Array(rows);
    for (let i = 0; i < rows; i++) out[i] = this.data[i * cols + j];
    return new NdArray(out, [rows]);
  }

  toArray() {
    if (this.ndim === 0) return this.data[0];
    if (this.ndim === 1) return Array.from(this.data);
    return _nestArray(this.data, this.shape, 0, 0);
  }

  toString() {
    return `NdArray(${_formatNested(this.data, this.shape, 0, 0)}, shape=[${this.shape.join(',')}])`;
  }
}

function _nestArray(data, shape, axis, offset) {
  const dim = shape[axis];
  if (axis === shape.length - 1) {
    const out = new Array(dim);
    for (let i = 0; i < dim; i++) out[i] = data[offset + i];
    return out;
  }
  let stride = 1;
  for (let k = axis + 1; k < shape.length; k++) stride *= shape[k];
  const out = new Array(dim);
  for (let i = 0; i < dim; i++) {
    out[i] = _nestArray(data, shape, axis + 1, offset + i * stride);
  }
  return out;
}

function _formatNested(data, shape, axis, offset) {
  const dim = shape[axis];
  if (axis === shape.length - 1) {
    const parts = new Array(dim);
    for (let i = 0; i < dim; i++) parts[i] = String(data[offset + i]);
    return '[' + parts.join(', ') + ']';
  }
  let stride = 1;
  for (let k = axis + 1; k < shape.length; k++) stride *= shape[k];
  const parts = new Array(dim);
  for (let i = 0; i < dim; i++) {
    parts[i] = _formatNested(data, shape, axis + 1, offset + i * stride);
  }
  return '[' + parts.join(', ') + ']';
}
