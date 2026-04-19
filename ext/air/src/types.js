// @gcu/air — Type system
// Plain objects, no classes. See spec §2.

// --- Singleton type constructors ---

const I8    = Object.freeze({ kind: 'i8' });
const U8    = Object.freeze({ kind: 'u8' });
const I16   = Object.freeze({ kind: 'i16' });
const U16   = Object.freeze({ kind: 'u16' });
const I32   = Object.freeze({ kind: 'i32' });
const U32   = Object.freeze({ kind: 'u32' });
const I64   = Object.freeze({ kind: 'i64' });
const U64   = Object.freeze({ kind: 'u64' });
const F32   = Object.freeze({ kind: 'f32' });
const F64   = Object.freeze({ kind: 'f64' });
const BOOL  = Object.freeze({ kind: 'bool' });
const STRING = Object.freeze({ kind: 'string' });
const VOID  = Object.freeze({ kind: 'void' });
const DYNAMIC = Object.freeze({ kind: 'dynamic' });

function typedArray(element) {
  return Object.freeze({ kind: 'typed_array', element });
}

function array(element) {
  return Object.freeze({ kind: 'array', element });
}

function object(fields) {
  return Object.freeze({ kind: 'object', fields });
}

function func(params, ret) {
  return Object.freeze({ kind: 'function', params, ret });
}

// --- Type annotation mapping (spec §2.2) ---

const TS_TYPE_MAP = {
  // GCU numeric types
  'i8': I8, 'u8': U8, 'i16': I16, 'u16': U16,
  'i32': I32, 'u32': U32, 'i64': I64, 'u64': U64,
  'f32': F32, 'f64': F64, 'bool': BOOL,
  // Standard TS types
  'number': F64, 'boolean': BOOL, 'string': STRING, 'void': VOID,
  // Standard typed array constructors
  'Int8Array': typedArray('i8'), 'Uint8Array': typedArray('u8'),
  'Int16Array': typedArray('i16'), 'Uint16Array': typedArray('u16'),
  'Int32Array': typedArray('i32'), 'Uint32Array': typedArray('u32'),
  'Float32Array': typedArray('f32'), 'Float64Array': typedArray('f64'),
  'BigInt64Array': typedArray('i64'), 'BigUint64Array': typedArray('u64'),
  // GCU typed array aliases
  'i8array': typedArray('i8'), 'u8array': typedArray('u8'),
  'i16array': typedArray('i16'), 'u16array': typedArray('u16'),
  'i32array': typedArray('i32'), 'u32array': typedArray('u32'),
  'f32array': typedArray('f32'), 'f64array': typedArray('f64'),
  'i64array': typedArray('i64'), 'u64array': typedArray('u64'),
};

// Resolve a TS annotation AST node to an AIR type
function resolveAnnotation(node) {
  if (!node) return DYNAMIC;
  const ann = node.typeAnnotation || node;
  switch (ann.type) {
    case 'TSTypeAnnotation':
      return resolveAnnotation(ann.typeAnnotation);
    case 'TSTypeReference':
      return TS_TYPE_MAP[ann.typeName?.name] || DYNAMIC;
    case 'TSNumberKeyword': return F64;
    case 'TSBooleanKeyword': return BOOL;
    case 'TSStringKeyword': return STRING;
    case 'TSVoidKeyword': return VOID;
    case 'TSArrayType': {
      const el = resolveAnnotation(ann.elementType);
      return array(el);
    }
    default: return DYNAMIC;
  }
}

// --- Type predicates ---

function isNumeric(t) {
  const k = t.kind;
  return k === 'i8' || k === 'u8' || k === 'i16' || k === 'u16' ||
         k === 'i32' || k === 'u32' || k === 'i64' || k === 'u64' ||
         k === 'f32' || k === 'f64';
}

function isInteger(t) {
  const k = t.kind;
  return k === 'i8' || k === 'u8' || k === 'i16' || k === 'u16' ||
         k === 'i32' || k === 'u32' || k === 'i64' || k === 'u64';
}

function isFloat(t) {
  return t.kind === 'f32' || t.kind === 'f64';
}

function isSigned(t) {
  const k = t.kind;
  return k === 'i8' || k === 'i16' || k === 'i32' || k === 'i64';
}

function isDynamic(t) {
  return t.kind === 'dynamic';
}

function isConcrete(t) {
  return t.kind !== 'dynamic';
}

// --- Type width (bits) for promotion ---

const TYPE_WIDTH = {
  'i8': 8, 'u8': 8, 'i16': 16, 'u16': 16,
  'i32': 32, 'u32': 32, 'i64': 64, 'u64': 64,
  'f32': 32, 'f64': 64,
};

// Promotion hierarchy lookup
const PROMOTE_RANK = {
  'i8': 0, 'u8': 0, 'i16': 1, 'u16': 1,
  'i32': 2, 'u32': 2, 'i64': 3, 'u64': 3,
  'f32': 4, 'f64': 5,
};

const RANK_TO_SIGNED   = { 0: I8, 1: I16, 2: I32, 3: I64 };
const RANK_TO_UNSIGNED = { 0: U8, 1: U16, 2: U32, 3: U64 };

// --- Arithmetic result type (spec §2.5) ---

function arithmeticResult(lhs, rhs) {
  if (isDynamic(lhs) || isDynamic(rhs)) return DYNAMIC;
  if (!isNumeric(lhs) || !isNumeric(rhs)) return DYNAMIC;

  const lr = PROMOTE_RANK[lhs.kind];
  const rr = PROMOTE_RANK[rhs.kind];

  // Both float
  if (isFloat(lhs) && isFloat(rhs)) {
    return lr >= rr ? lhs : rhs;
  }
  // One float, one integer → float wins
  if (isFloat(lhs)) return lhs;
  if (isFloat(rhs)) return rhs;

  // Both integer — promote narrower, signed wins on same width
  if (lr !== rr) {
    const maxRank = Math.max(lr, rr);
    // use signed if either is signed
    if (isSigned(lhs) || isSigned(rhs)) return RANK_TO_SIGNED[maxRank];
    return RANK_TO_UNSIGNED[maxRank];
  }
  // Same width — signed wins
  if (isSigned(lhs) || isSigned(rhs)) return RANK_TO_SIGNED[lr];
  return RANK_TO_UNSIGNED[lr];
}

// Comparison always → bool
function comparisonResult(lhs, rhs) {
  return BOOL;
}

// Bitwise ops always → i32
function bitwiseResult() {
  return I32;
}

// --- Type equality ---

function typeEq(a, b) {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'typed_array') return a.element === b.element;
  if (a.kind === 'array') return typeEq(a.element, b.element);
  if (a.kind === 'function') {
    if (a.params.length !== b.params.length) return false;
    if (!typeEq(a.ret, b.ret)) return false;
    return a.params.every((p, i) => typeEq(p, b.params[i]));
  }
  if (a.kind === 'object') {
    const aKeys = [...a.fields.keys()].sort();
    const bKeys = [...b.fields.keys()].sort();
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k, i) => k === bKeys[i] && typeEq(a.fields.get(k), b.fields.get(k)));
  }
  return true;
}

export {
  // Primitive singletons
  I8, U8, I16, U16, I32, U32, I64, U64, F32, F64,
  BOOL, STRING, VOID, DYNAMIC,
  // Compound constructors
  typedArray, array, object, func,
  // Annotation resolution
  TS_TYPE_MAP, resolveAnnotation,
  // Predicates
  isNumeric, isInteger, isFloat, isSigned, isDynamic, isConcrete,
  // Width/promotion
  TYPE_WIDTH, PROMOTE_RANK,
  // Result type computation
  arithmeticResult, comparisonResult, bitwiseResult,
  // Equality
  typeEq,
};
