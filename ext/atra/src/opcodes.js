// Opcodes — Wasm opcode constants, type codes, and SIMD ops
//
// The Wasm opcode space is organized by category: control flow at 0x00, variable access
// at 0x20, memory at 0x28, constants at 0x41. Within the arithmetic region (0x45–0xa6),
// opcodes form a type×operation grid: each operation has four variants (i32/i64/f32/f64)
// laid out in contiguous blocks. Two-byte opcodes (0xFC/0xFD prefix) extend the space
// for saturating truncation and SIMD.

// ── Control flow (0x00–0x1b) ──
export const OP_UNREACHABLE = 0x00, OP_NOP = 0x01, OP_BLOCK = 0x02, OP_LOOP = 0x03,
  OP_IF = 0x04, OP_ELSE = 0x05, OP_END = 0x0b, OP_BR = 0x0c, OP_BR_IF = 0x0d,
  OP_RETURN = 0x0f, OP_CALL = 0x10, OP_CALL_INDIRECT = 0x11,
  OP_RETURN_CALL = 0x12, OP_RETURN_CALL_INDIRECT = 0x13, OP_SELECT = 0x1b,

// ── Variable access (0x20–0x24) ──
  OP_LOCAL_GET = 0x20, OP_LOCAL_SET = 0x21, OP_LOCAL_TEE = 0x22,
  OP_GLOBAL_GET = 0x23, OP_GLOBAL_SET = 0x24,

// ── Memory (0x28–0x40) ──
  OP_I32_LOAD = 0x28, OP_I64_LOAD = 0x29, OP_F32_LOAD = 0x2a, OP_F64_LOAD = 0x2b,
  OP_I32_STORE = 0x36, OP_I64_STORE = 0x37, OP_F32_STORE = 0x38, OP_F64_STORE = 0x39,
  OP_MEMORY_SIZE = 0x3f, OP_MEMORY_GROW = 0x40,

// ── Constants (0x41–0x44) ──
  OP_I32_CONST = 0x41, OP_I64_CONST = 0x42, OP_F32_CONST = 0x43, OP_F64_CONST = 0x44,

// ── Comparison (0x45–0x66) — type×operation grid: eqz/eq/ne/lt/gt/le/ge per type ──
  OP_I32_EQZ = 0x45, OP_I32_EQ = 0x46, OP_I32_NE = 0x47,
  OP_I32_LT_S = 0x48, OP_I32_LT_U = 0x49, OP_I32_GT_S = 0x4a, OP_I32_GT_U = 0x4b,
  OP_I32_LE_S = 0x4c, OP_I32_LE_U = 0x4d, OP_I32_GE_S = 0x4e, OP_I32_GE_U = 0x4f,
  OP_I64_EQZ = 0x50, OP_I64_EQ = 0x51, OP_I64_NE = 0x52,
  OP_I64_LT_S = 0x53, OP_I64_LT_U = 0x54, OP_I64_GT_S = 0x55, OP_I64_GT_U = 0x56,
  OP_I64_LE_S = 0x57, OP_I64_LE_U = 0x58, OP_I64_GE_S = 0x59, OP_I64_GE_U = 0x5a,
  OP_F32_EQ = 0x5b, OP_F32_NE = 0x5c, OP_F32_LT = 0x5d, OP_F32_GT = 0x5e, OP_F32_LE = 0x5f, OP_F32_GE = 0x60,
  OP_F64_EQ = 0x61, OP_F64_NE = 0x62, OP_F64_LT = 0x63, OP_F64_GT = 0x64, OP_F64_LE = 0x65, OP_F64_GE = 0x66,

// ── i32 arithmetic (0x67–0x78) ──
  OP_I32_CLZ = 0x67, OP_I32_CTZ = 0x68, OP_I32_POPCNT = 0x69,
  OP_I32_ADD = 0x6a, OP_I32_SUB = 0x6b, OP_I32_MUL = 0x6c,
  OP_I32_DIV_S = 0x6d, OP_I32_DIV_U = 0x6e, OP_I32_REM_S = 0x6f, OP_I32_REM_U = 0x70,
  OP_I32_AND = 0x71, OP_I32_OR = 0x72, OP_I32_XOR = 0x73,
  OP_I32_SHL = 0x74, OP_I32_SHR_S = 0x75, OP_I32_SHR_U = 0x76,
  OP_I32_ROTL = 0x77, OP_I32_ROTR = 0x78,

// ── i64 arithmetic (0x79–0x8a) ──
  OP_I64_CLZ = 0x79, OP_I64_CTZ = 0x7a, OP_I64_POPCNT = 0x7b,
  OP_I64_ADD = 0x7c, OP_I64_SUB = 0x7d, OP_I64_MUL = 0x7e,
  OP_I64_DIV_S = 0x7f, OP_I64_DIV_U = 0x80, OP_I64_REM_S = 0x81, OP_I64_REM_U = 0x82,
  OP_I64_AND = 0x83, OP_I64_OR = 0x84, OP_I64_XOR = 0x85,
  OP_I64_SHL = 0x86, OP_I64_SHR_S = 0x87, OP_I64_SHR_U = 0x88,
  OP_I64_ROTL = 0x89, OP_I64_ROTR = 0x8a,

// ── f32 unary + binary (0x8b–0x98) ──
  OP_F32_ABS = 0x8b, OP_F32_NEG = 0x8c, OP_F32_CEIL = 0x8d, OP_F32_FLOOR = 0x8e,
  OP_F32_TRUNC = 0x8f, OP_F32_NEAREST = 0x90, OP_F32_SQRT = 0x91,
  OP_F32_ADD = 0x92, OP_F32_SUB = 0x93, OP_F32_MUL = 0x94, OP_F32_DIV = 0x95,
  OP_F32_MIN = 0x96, OP_F32_MAX = 0x97, OP_F32_COPYSIGN = 0x98,

// ── f64 unary + binary (0x99–0xa6) ──
  OP_F64_ABS = 0x99, OP_F64_NEG = 0x9a, OP_F64_CEIL = 0x9b, OP_F64_FLOOR = 0x9c,
  OP_F64_TRUNC = 0x9d, OP_F64_NEAREST = 0x9e, OP_F64_SQRT = 0x9f,
  OP_F64_ADD = 0xa0, OP_F64_SUB = 0xa1, OP_F64_MUL = 0xa2, OP_F64_DIV = 0xa3,
  OP_F64_MIN = 0xa4, OP_F64_MAX = 0xa5, OP_F64_COPYSIGN = 0xa6,

// ── Conversions (0xa7–0xc4) ──
  OP_I32_WRAP_I64 = 0xa7,
  OP_I32_TRUNC_F32_S = 0xa8, OP_I32_TRUNC_F64_S = 0xaa,
  OP_I64_EXTEND_I32_S = 0xac, OP_I64_EXTEND_I32_U = 0xad,
  OP_I64_TRUNC_F32_S = 0xae, OP_I64_TRUNC_F64_S = 0xb0,
  OP_F32_CONVERT_I32_S = 0xb2, OP_F32_CONVERT_I64_S = 0xb4,
  OP_F32_DEMOTE_F64 = 0xb6,
  OP_F64_CONVERT_I32_S = 0xb7, OP_F64_CONVERT_I64_S = 0xb9,
  OP_F64_PROMOTE_F32 = 0xbb,
  OP_I32_REINTERPRET_F32 = 0xbc, OP_I64_REINTERPRET_F64 = 0xbd,
  OP_F32_REINTERPRET_I32 = 0xbe, OP_F64_REINTERPRET_I64 = 0xbf,
  OP_I32_EXTEND8_S = 0xc0, OP_I32_EXTEND16_S = 0xc1,
  OP_I64_EXTEND8_S = 0xc2, OP_I64_EXTEND16_S = 0xc3, OP_I64_EXTEND32_S = 0xc4;

// ── FC prefix (0xFC + u32) — saturating truncation ──
export const OP_FC_PREFIX = 0xfc;
export const OP_I32_TRUNC_SAT_F32_S = 0, OP_I32_TRUNC_SAT_F32_U = 1,
  OP_I32_TRUNC_SAT_F64_S = 2, OP_I32_TRUNC_SAT_F64_U = 3,
  OP_I64_TRUNC_SAT_F32_S = 4, OP_I64_TRUNC_SAT_F32_U = 5,
  OP_I64_TRUNC_SAT_F64_S = 6, OP_I64_TRUNC_SAT_F64_U = 7;

// ── Type codes ──
// Descending from 0x7f: i32, i64, f32, f64, v128. These are negative values in
// signed LEB128, which is how they appear in function signatures and local declarations.
export const WASM_I32 = 0x7f, WASM_I64 = 0x7e, WASM_F32 = 0x7d, WASM_F64 = 0x7c;
export const WASM_V128 = 0x7b;
export const WASM_VOID = 0x40;

// ── SIMD prefix (0xFD + u32) ──
export const OP_SIMD_PREFIX = 0xfd;

// SIMD opcode table — keyed by "type.operation" for easy lookup from codegen
export const SIMD_OPS = {
  // splat
  'i32x4.splat': 0x11, 'i64x2.splat': 0x12, 'f32x4.splat': 0x13, 'f64x2.splat': 0x14,
  // extract_lane
  'i32x4.extract_lane': 0x1b, 'i64x2.extract_lane': 0x1d, 'f32x4.extract_lane': 0x1f, 'f64x2.extract_lane': 0x21,
  // replace_lane
  'i32x4.replace_lane': 0x1c, 'i64x2.replace_lane': 0x1e, 'f32x4.replace_lane': 0x20, 'f64x2.replace_lane': 0x22,
  // add
  'i32x4.add': 0xae, 'i64x2.add': 0xce, 'f32x4.add': 0xe4, 'f64x2.add': 0xf0,
  // sub
  'i32x4.sub': 0xb1, 'i64x2.sub': 0xd1, 'f32x4.sub': 0xe5, 'f64x2.sub': 0xf1,
  // mul
  'i32x4.mul': 0xb5, 'i64x2.mul': 0xd5, 'f32x4.mul': 0xe6, 'f64x2.mul': 0xf2,
  // div (float only)
  'f32x4.div': 0xe7, 'f64x2.div': 0xf3,
  // neg
  'i32x4.neg': 0xa1, 'i64x2.neg': 0xc1, 'f32x4.neg': 0xe1, 'f64x2.neg': 0xed,
  // abs (float only)
  'f32x4.abs': 0xe0, 'f64x2.abs': 0xec,
  // sqrt (float only)
  'f32x4.sqrt': 0xe3, 'f64x2.sqrt': 0xef,
  // min/max (float only)
  'f32x4.min': 0xe8, 'f64x2.min': 0xf4, 'f32x4.max': 0xe9, 'f64x2.max': 0xf5,
  // comparison — eq
  'i32x4.eq': 0x37, 'i64x2.eq': 0xd6, 'f32x4.eq': 0x41, 'f64x2.eq': 0x47,
  // ne
  'i32x4.ne': 0x38, 'f32x4.ne': 0x42, 'f64x2.ne': 0x48,
  // lt
  'i32x4.lt_s': 0x39, 'i64x2.lt_s': 0xd7, 'f32x4.lt': 0x43, 'f64x2.lt': 0x49,
  // gt
  'i32x4.gt_s': 0x3b, 'i64x2.gt_s': 0xd9, 'f32x4.gt': 0x44, 'f64x2.gt': 0x4a,
  // le
  'i32x4.le_s': 0x3d, 'i64x2.le_s': 0xdb, 'f32x4.le': 0x45, 'f64x2.le': 0x4b,
  // ge
  'i32x4.ge_s': 0x3f, 'i64x2.ge_s': 0xdd, 'f32x4.ge': 0x46, 'f64x2.ge': 0x4c,
  // v128 bitwise
  'v128.not': 0x4d, 'v128.and': 0x4e, 'v128.or': 0x50, 'v128.xor': 0x51,
  // v128 memory
  'v128.load': 0x00, 'v128.store': 0x0b, 'v128.const': 0x0c,
};

export function wasmType(t) {
  if (t === 'i32') return WASM_I32;
  if (t === 'i64') return WASM_I64;
  if (t === 'f32') return WASM_F32;
  if (t === 'f64') return WASM_F64;
  if (isVector(t)) return WASM_V128;
  throw new Error('Unknown type: ' + t);
}

export function typeSize(t) {
  if (t === 'i32' || t === 'f32') return 4;
  if (t === 'i64' || t === 'f64') return 8;
  if (isVector(t)) return 16;
  throw new Error('Unknown type: ' + t);
}

export function isVector(t) { return t === 'f64x2' || t === 'f32x4' || t === 'i32x4' || t === 'i64x2'; }
export function vectorScalarType(t) {
  if (t === 'f64x2') return 'f64';
  if (t === 'f32x4') return 'f32';
  if (t === 'i32x4') return 'i32';
  if (t === 'i64x2') return 'i64';
  return null;
}
