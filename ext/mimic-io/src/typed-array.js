// @gcu/mimic-io — typed-array codec
//
// The `{ $dtype, $shape, $data }` form (spec §5) packs homogeneous numeric
// arrays as base64-encoded raw bytes. ~2.5× smaller than JSON arrays of
// decimal floats and substantially faster to parse (no per-element
// string→number).
//
// Endianness: little-endian on both sides. Host TypedArrays are host-
// endian; on the (vanishingly rare) big-endian browser we'd byte-swap
// here, but every consumer-relevant target is LE.

const DTYPES = {
  // name → { ctor, bytesPerElement, jsLossy: boolean }
  // jsLossy means values can lose precision when read into Number — currently
  // only int64/uint64. JS implementations may reject these or use BigInt;
  // we reject by default (consumer can override). See spec §5.2.
  float64: { ctor: Float64Array, bytes: 8, jsLossy: false },
  float32: { ctor: Float32Array, bytes: 4, jsLossy: false },
  int32:   { ctor: Int32Array,   bytes: 4, jsLossy: false },
  uint32:  { ctor: Uint32Array,  bytes: 4, jsLossy: false },
  int16:   { ctor: Int16Array,   bytes: 2, jsLossy: false },
  uint16:  { ctor: Uint16Array,  bytes: 2, jsLossy: false },
  int8:    { ctor: Int8Array,    bytes: 1, jsLossy: false },
  uint8:   { ctor: Uint8Array,   bytes: 1, jsLossy: false },
  // bool packs each element as one byte (0 or 1), not bit-packed. Spec §5.5.
  bool:    { ctor: Uint8Array,   bytes: 1, jsLossy: false, isBool: true },
  // int64/uint64 require BigInt typed arrays in JS for precision preservation.
  int64:   { ctor: BigInt64Array,  bytes: 8, jsLossy: true },
  uint64:  { ctor: BigUint64Array, bytes: 8, jsLossy: true },
};

/**
 * True if a value looks like a typed-array reference `{ $dtype, $shape,
 * $data }`. Used by the load path to decide between this codec and a
 * plain JSON array of numbers (both are valid per §5.3).
 */
export function isTypedArrayRef(v) {
  return v != null && typeof v === 'object'
    && typeof v.$dtype === 'string'
    && Array.isArray(v.$shape)
    && typeof v.$data === 'string';
}

/**
 * Encode a typed array (or a plain array if you really want, but the spec's
 * threshold is "homogeneous numeric, length ≥ 16 or rank ≥ 2") into the
 * `{ $dtype, $shape, $data }` form.
 *
 * @param {TypedArray|BigInt64Array|BigUint64Array} arr
 * @param {number[]} [shape] — defaults to [arr.length]
 * @returns {{ $dtype: string, $shape: number[], $data: string }}
 */
export function encodeTypedArray(arr, shape) {
  const dtype = _dtypeOf(arr);
  if (!dtype) throw new Error(`encodeTypedArray: unsupported typed-array kind`);
  const resolvedShape = shape ?? [arr.length];
  const elementCount = resolvedShape.reduce((a, b) => a * b, 1);
  if (elementCount !== arr.length) {
    throw new Error(
      `encodeTypedArray: shape ${JSON.stringify(resolvedShape)} ` +
      `claims ${elementCount} elements; array has ${arr.length}`,
    );
  }
  // Convert to a Uint8Array view over the same memory, then base64.
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  return {
    $dtype: dtype,
    $shape: resolvedShape,
    $data: _bytesToBase64(bytes),
  };
}

/**
 * Decode a typed-array reference into a real typed array. Supports either
 * the `{ $dtype, $shape, $data }` form or a plain JSON array of numbers
 * (which is returned as a Float64Array — the spec is agnostic about exact
 * type for the plain-array form).
 *
 * @param {object|number[]} ref
 * @param {object} [opts]
 * @param {boolean} [opts.rejectBigInt=true] — if false, int64/uint64 load
 *        into BigInt64Array/BigUint64Array. If true (default), int64/uint64
 *        refs throw because most consumers can't handle BigInt values cleanly.
 * @returns {TypedArray|BigInt64Array|BigUint64Array}
 */
export function decodeTypedArray(ref, opts = {}) {
  const rejectBigInt = opts.rejectBigInt ?? true;
  if (Array.isArray(ref)) return new Float64Array(ref);
  if (!isTypedArrayRef(ref)) {
    throw new Error('decodeTypedArray: input is neither a typed-array ref nor a plain array');
  }
  const spec = DTYPES[ref.$dtype];
  if (!spec) throw new Error(`decodeTypedArray: unsupported dtype "${ref.$dtype}"`);
  if (spec.jsLossy && rejectBigInt) {
    throw new Error(
      `decodeTypedArray: dtype "${ref.$dtype}" requires BigInt typed arrays; ` +
      `pass { rejectBigInt: false } to opt in to BigInt loading`,
    );
  }
  const bytes = _base64ToBytes(ref.$data);
  const elementCount = ref.$shape.reduce((a, b) => a * b, 1);
  const expected = elementCount * spec.bytes;
  if (bytes.byteLength !== expected) {
    throw new Error(
      `decodeTypedArray: decoded ${bytes.byteLength} bytes; ` +
      `expected ${expected} (${elementCount} × ${spec.bytes} for ${ref.$dtype})`,
    );
  }
  // Construct a typed-array view over a fresh, aligned buffer. SubtleCrypto
  // and BigInt typed arrays require contiguous, aligned buffers; copying via
  // .slice() guarantees both.
  const aligned = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.slice().buffer;
  return new spec.ctor(aligned);
}

function _dtypeOf(arr) {
  if (arr instanceof Float64Array) return 'float64';
  if (arr instanceof Float32Array) return 'float32';
  if (arr instanceof Int32Array)   return 'int32';
  if (arr instanceof Uint32Array)  return 'uint32';
  if (arr instanceof Int16Array)   return 'int16';
  if (arr instanceof Uint16Array)  return 'uint16';
  if (arr instanceof Int8Array)    return 'int8';
  if (arr instanceof Uint8Array)   return 'uint8';
  if (typeof BigInt64Array !== 'undefined' && arr instanceof BigInt64Array)   return 'int64';
  if (typeof BigUint64Array !== 'undefined' && arr instanceof BigUint64Array) return 'uint64';
  return null;
}

// Browser-side: btoa/atob exist as globals and handle "binary string" input.
// We avoid `Buffer` to keep this zero-deps and bundle-able for the browser.
function _bytesToBase64(bytes) {
  let s = '';
  // Chunk to avoid call-stack overflow on huge arrays (apply has an arg limit).
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function _base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
