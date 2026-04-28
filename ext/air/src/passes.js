// @gcu/air — Optimization passes
// Spec §8: Type propagation, constant folding, DCE, dependency extraction

import {
  I32, F64, BOOL, STRING, VOID, DYNAMIC,
  isDynamic, isConcrete, isNumeric, isFloat, isInteger,
  arithmeticResult, typeEq,
} from './types.js';

// Helper: take union of two types. Identical → that type. Otherwise DYNAMIC.
function unionType(a, b) {
  if (!a) return b || DYNAMIC;
  if (!b) return a;
  if (typeEq(a, b)) return a;
  return DYNAMIC;
}

// Infer the element type from an iterable's SSA id.
// Handles: `range(...)` → i32, `_py.iter(range(...))` → i32,
//          Float64Array-typed arrays → f64, etc.
function inferIterableElementType(ssaId, allOps) {
  const op = findOpAnywhere(allOps, ssaId);
  if (!op) return null;

  // Typed array → element type
  if (op.op === 'ta_new' || (op.type && op.type.kind === 'typed_array')) {
    const elName = op.type?.element;
    if (elName === 'f64') return F64;
    if (elName === 'f32') return { kind: 'f32' };
    if (elName && elName !== 'i64' && elName !== 'u64') return I32;
  }

  // Peel off _py.iter(X) or await _py.iter(X) wrapping
  if (op.op === 'await') return inferIterableElementType(op.args[0], allOps);
  if (op.op === 'call') {
    // Check if callee is _py.iter
    const calleeOp = findOpAnywhere(allOps, op.args[0]);
    if (calleeOp && calleeOp.op === 'object_get' && calleeOp.args[1] === 'iter') {
      const rtOp = findOpAnywhere(allOps, calleeOp.args[0]);
      if (rtOp && rtOp.op === 'load' && rtOp.args[0] === '_py') {
        // Recurse into inner: _py.iter(X) has element = element-of(X)
        return inferIterableElementType(op.args[1], allOps);
      }
    }
    // Check if it's a call to `range(...)` — builtin that yields i32
    // The callee is a load of 'range'
    if (calleeOp && calleeOp.op === 'load' && calleeOp.args[0] === 'range') {
      return I32;
    }
  }
  return null;
}

// Typed-array element type lookup
function taElementType(t) {
  if (!t || t.kind !== 'typed_array') return null;
  const k = t.element;
  if (k === 'i8' || k === 'u8' || k === 'i16' || k === 'u16' ||
      k === 'i32' || k === 'u32') return I32;
  if (k === 'i64' || k === 'u64') return DYNAMIC; // BigInt
  if (k === 'f32') return { kind: 'f32' };
  if (k === 'f64') return F64;
  return DYNAMIC;
}

// =============================================================================
// §8.1 — Type propagation (enhanced: tracks name → type across stores/loads)
// =============================================================================

export function propagateTypes(module, opts = {}) {
  const types = new Map();     // SSA id → type
  const nameTypes = new Map(); // variable name → current type
  const nameOrigins = new Map(); // variable name → current value SSA id

  // Resolve a value ssa id through load ops (using currently-tracked origins)
  function resolveValue(ssaId) {
    const op = findOpAnywhere(module.ops, ssaId);
    if (!op) return null;
    if (op.op === 'load' && typeof op.args[0] === 'string') {
      const originId = nameOrigins.get(op.args[0]);
      if (originId) return resolveValue(originId);
    }
    return op;
  }

  // Seed nameTypes from imports (cross-cell type flow)
  // opts.importTypes: Map<importName, Type>
  if (opts.importTypes) {
    for (const [name, t] of opts.importTypes) {
      nameTypes.set(name, t);
    }
  }

  function typeOf(id) {
    return types.get(id) || DYNAMIC;
  }

  // When processing a branched region, collect writes so outer scope can union/invalidate
  function collectWrittenNames(ops, writes) {
    for (const op of ops || []) {
      if (op.op === 'store' && typeof op.args[0] === 'string') {
        writes.add(op.args[0]);
      }
      // Recurse into sub-regions
      if (op.then_body) collectWrittenNames(op.then_body, writes);
      if (op.else_body) collectWrittenNames(op.else_body, writes);
      if (op.body) collectWrittenNames(op.body, writes);
      if (op.init) collectWrittenNames(op.init, writes);
      if (op.test) collectWrittenNames(op.test, writes);
      if (op.update) collectWrittenNames(op.update, writes);
      if (op.try_body) collectWrittenNames(op.try_body, writes);
      if (op.catch_body) collectWrittenNames(op.catch_body, writes);
      if (op.finally_body) collectWrittenNames(op.finally_body, writes);
      if (op.cases) for (const c of op.cases) collectWrittenNames(c.body, writes);
    }
  }

  function propagate(ops) {
    for (const op of ops) {
      // Carry existing type (set at lowering time via annotation or literal)
      if (op.type && !isDynamic(op.type)) {
        types.set(op.id, op.type);
      }

      switch (op.op) {
        case 'const':
          types.set(op.id, op.type);
          break;

        case 'add': case 'sub': case 'mul': case 'div': case 'mod': case 'exp': {
          const lt = typeOf(op.args[0]);
          const rt = typeOf(op.args[1]);
          if (op.op === 'add' && (lt.kind === 'string' || rt.kind === 'string')) {
            op.type = STRING;
          } else if (!isDynamic(lt) && !isDynamic(rt) && isNumeric(lt) && isNumeric(rt)) {
            op.type = arithmeticResult(lt, rt);
          }
          types.set(op.id, op.type);
          break;
        }

        case 'neg': {
          const t = typeOf(op.args[0]);
          if (isNumeric(t)) op.type = t;
          types.set(op.id, op.type);
          break;
        }

        case 'bitwise_or': case 'bitwise_and': case 'bitwise_xor':
        case 'shift_left': case 'shift_right': case 'ushift_right':
        case 'bitwise_not':
          op.type = I32;
          types.set(op.id, I32);
          break;

        case 'eq': case 'neq': case 'lt': case 'lte': case 'gt': case 'gte':
        case 'logical_not': case 'in': case 'instanceof':
          op.type = BOOL;
          types.set(op.id, BOOL);
          break;

        case 'logical_and': case 'logical_or': case 'nullish_coalesce': {
          const lt = typeOf(op.args[0]);
          const rt = typeOf(op.args[1]);
          op.type = typeEq(lt, rt) ? lt : DYNAMIC;
          types.set(op.id, op.type);
          break;
        }

        case 'typeof':
          op.type = STRING;
          types.set(op.id, STRING);
          break;

        case 'load': {
          const name = op.args[0];
          // Prefer tracked name type; fallback to op's declared type
          const t = nameTypes.has(name) ? nameTypes.get(name) : (op.type || DYNAMIC);
          op.type = t;
          types.set(op.id, t);
          break;
        }

        case 'store': {
          const name = op.args[0];
          const valId = op.args[1];
          const valType = typeOf(valId);
          // If store has a declared type (from annotation), prefer it.
          // Otherwise inherit the value's type.
          const declared = op.type && !isDynamic(op.type) && op.type.kind !== 'void';
          const t = declared ? op.type : valType;
          nameTypes.set(name, t);
          nameOrigins.set(name, valId);
          types.set(op.id, VOID);
          break;
        }

        case 'slot_load': {
          types.set(op.id, op.type || DYNAMIC);
          break;
        }

        case 'slot_store': {
          types.set(op.id, VOID);
          break;
        }

        case 'object_get': {
          // If the object was produced (possibly through a load chain) by an
          // object_new with a statically-known field matching this key, infer
          // the field's type.
          const objId = op.args[0];
          const key = op.args[1];
          let inferred = op.type || DYNAMIC;
          if (typeof key === 'string' && isDynamic(inferred)) {
            const srcOp = resolveValue(objId);
            if (srcOp && srcOp.op === 'object_new' && Array.isArray(srcOp.args)) {
              for (const pair of srcOp.args) {
                if (pair && pair.key === key && pair.id) {
                  const fieldT = types.get(pair.id);
                  if (fieldT && !isDynamic(fieldT)) inferred = fieldT;
                  break;
                }
              }
            }
          }
          op.type = inferred;
          types.set(op.id, inferred);
          break;
        }
        case 'array_get': {
          types.set(op.id, op.type || DYNAMIC);
          break;
        }

        case 'ta_new': {
          types.set(op.id, op.type);
          break;
        }

        case 'ta_get': {
          // Typed array indexing returns the element type
          const arrT = typeOf(op.args[0]);
          const elT = taElementType(arrT);
          if (elT) { op.type = elT; }
          types.set(op.id, op.type || DYNAMIC);
          break;
        }

        case 'array_new': {
          types.set(op.id, op.type || DYNAMIC);
          break;
        }

        case 'object_new': {
          types.set(op.id, op.type || DYNAMIC);
          break;
        }

        case 'call': case 'call_method': {
          // If the callee carries a function type, use its declared return.
          // The callee's SSA type may be a `func(params, ret)` set on the
          // func_region (e.g. by adder/JS lowering with a `-> Type` annotation),
          // or DYNAMIC. We propagate ret only — params aren't used here.
          let inferred = op.type || DYNAMIC;
          if (isDynamic(inferred) && op.op === 'call' && op.args.length > 0) {
            const calleeT = typeOf(op.args[0]);
            if (calleeT && calleeT.kind === 'function' && calleeT.ret) {
              inferred = calleeT.ret;
            }
          }
          op.type = inferred;
          types.set(op.id, inferred);
          break;
        }

        case 'await': {
          // await unwraps Promise but we don't track Promise<T> explicitly.
          // We carry the inner type through directly: emit-side, async funcs
          // declared with `ret_type: T` return T-when-awaited as the user
          // sees it. So pass through whatever the awaited expression's type
          // resolved to.
          const innerT = typeOf(op.args[0]);
          const t = isDynamic(op.type) ? (innerT || DYNAMIC) : op.type;
          op.type = t;
          types.set(op.id, t);
          break;
        }

        case 'func_region': {
          types.set(op.id, op.type);
          // Recurse into body with a scope snapshot
          const saved = new Map(nameTypes);
          // Seed self-recursion: when the body loads its own name, give it
          // the function's own type so recursive calls infer ret_type
          // correctly (e.g. fib's body calling fib). Without this, the load
          // would default to DYNAMIC and binary helpers wouldn't specialise.
          if (op.name && op.type && op.type.kind === 'function') {
            nameTypes.set(op.name, op.type);
          }
          // Seed params with their declared types
          if (op.params) {
            for (const p of op.params) {
              if (p.type && !isDynamic(p.type)) {
                nameTypes.set(p.name, p.type);
              }
            }
          }
          if (op.body) propagate(op.body);
          // Restore outer scope
          nameTypes.clear();
          for (const [k, v] of saved) nameTypes.set(k, v);
          break;
        }

        case 'class_region': {
          types.set(op.id, op.type || DYNAMIC);
          // Classes don't (currently) contribute to type propagation
          break;
        }

        case 'if_region': {
          // Save types, walk each branch, then union writes.
          const saved = new Map(nameTypes);
          const thenTypes = new Map(saved);

          nameTypes.clear();
          for (const [k, v] of saved) nameTypes.set(k, v);
          if (op.then_body) propagate(op.then_body);
          const afterThen = new Map(nameTypes);

          nameTypes.clear();
          for (const [k, v] of saved) nameTypes.set(k, v);
          if (op.else_body) propagate(op.else_body);
          const afterElse = new Map(nameTypes);

          // Merge: union of both branches, plus original for names written in neither
          nameTypes.clear();
          for (const [k, v] of saved) nameTypes.set(k, v);
          const written = new Set();
          collectWrittenNames(op.then_body || [], written);
          collectWrittenNames(op.else_body || [], written);
          for (const name of written) {
            const t1 = afterThen.has(name) ? afterThen.get(name) : saved.get(name);
            const t2 = afterElse.has(name) ? afterElse.get(name) : saved.get(name);
            nameTypes.set(name, unionType(t1, t2));
          }

          types.set(op.id, op.type || VOID);
          break;
        }

        case 'for_region': {
          // Variables written in the loop become dynamic (could be any iteration's type)
          const writtenNames = new Set();
          collectWrittenNames(op.init || [], writtenNames);
          collectWrittenNames(op.body || [], writtenNames);
          collectWrittenNames(op.update || [], writtenNames);

          if (op.init) propagate(op.init);
          if (op.test) propagate(op.test);
          if (op.update) propagate(op.update);
          if (op.body) propagate(op.body);

          // After the loop, loop-variable types may differ from the pre-loop state.
          // Leave current nameTypes as-is (last iteration's types).
          types.set(op.id, VOID);
          break;
        }

        case 'loop_region': {
          if (op.test) propagate(op.test);
          if (op.body) propagate(op.body);
          types.set(op.id, VOID);
          break;
        }

        case 'for_in_region': case 'for_of_region': {
          // If the iterable is `_py.iter(range(...))` or `range(...)`, element is i32.
          // This covers the common "for i in range(n)" pattern in transpiled adder.
          if (op.op === 'for_of_region' && op.target_name) {
            const elT = inferIterableElementType(op.args[0], module.ops);
            if (elT) nameTypes.set(op.target_name, elT);
          }
          if (op.body) propagate(op.body);
          types.set(op.id, VOID);
          break;
        }

        case 'try_region': {
          if (op.try_body) propagate(op.try_body);
          if (op.catch_body) propagate(op.catch_body);
          if (op.finally_body) propagate(op.finally_body);
          // After try, names written in try/catch could be either's type.
          // Conservatively dynamic.
          const written = new Set();
          collectWrittenNames(op.try_body || [], written);
          collectWrittenNames(op.catch_body || [], written);
          for (const name of written) nameTypes.set(name, DYNAMIC);
          types.set(op.id, VOID);
          break;
        }

        case 'switch_region': {
          if (op.cases) {
            for (const c of op.cases) {
              if (c.test_ops) propagate(c.test_ops);
              if (c.body) propagate(c.body);
            }
          }
          types.set(op.id, VOID);
          break;
        }

        default:
          if (!types.has(op.id)) types.set(op.id, op.type || DYNAMIC);
      }
    }
  }

  propagate(module.ops);

  // Update the module's exports map with inferred types
  if (module.exports) {
    for (const [name, exp] of module.exports) {
      if (nameTypes.has(name)) {
        const t = nameTypes.get(name);
        if (t && !isDynamic(t)) {
          exp.type = t;
        }
      }
    }
  }

  return types;
}

// =============================================================================
// §8.2 — Constant folding
// =============================================================================

export function foldConstants(module) {
  let changed = false;

  function fold(ops) {
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];

      // Recurse into regions
      if (op.then_body) fold(op.then_body);
      if (op.else_body) fold(op.else_body);
      if (op.body) fold(op.body);
      if (op.init) fold(op.init);
      if (op.test) fold(op.test);
      if (op.update) fold(op.update);

      // Fold binary ops on constants
      if ((op.op === 'add' || op.op === 'sub' || op.op === 'mul' ||
           op.op === 'div' || op.op === 'mod') && op.args.length === 2) {
        const lhsOp = findOpById(module.ops, op.args[0]);
        const rhsOp = findOpById(module.ops, op.args[1]);
        if (lhsOp?.op === 'const' && rhsOp?.op === 'const' &&
            typeof lhsOp.args[0] === 'number' && typeof rhsOp.args[0] === 'number') {
          let val;
          switch (op.op) {
            case 'add': val = lhsOp.args[0] + rhsOp.args[0]; break;
            case 'sub': val = lhsOp.args[0] - rhsOp.args[0]; break;
            case 'mul': val = lhsOp.args[0] * rhsOp.args[0]; break;
            case 'div': val = lhsOp.args[0] / rhsOp.args[0]; break;
            case 'mod': val = lhsOp.args[0] % rhsOp.args[0]; break;
          }
          if (val !== undefined && isFinite(val)) {
            op.op = 'const';
            op.args = [val];
            op.type = Number.isInteger(val) && val >= -2147483648 && val <= 2147483647 ? I32 : F64;
            changed = true;
          }
        }
      }

      // Fold negation of constant
      if (op.op === 'neg' && op.args.length === 1) {
        const argOp = findOpById(module.ops, op.args[0]);
        if (argOp?.op === 'const' && typeof argOp.args[0] === 'number') {
          op.op = 'const';
          op.args = [-argOp.args[0]];
          changed = true;
        }
      }
    }
  }

  fold(module.ops);
  return changed;
}

function findOpById(ops, id) {
  for (const op of ops) {
    if (op.id === id) return op;
    if (op.then_body) { const r = findOpById(op.then_body, id); if (r) return r; }
    if (op.else_body) { const r = findOpById(op.else_body, id); if (r) return r; }
    if (op.body) { const r = findOpById(op.body, id); if (r) return r; }
    if (op.init) { const r = findOpById(op.init, id); if (r) return r; }
    if (op.test) { const r = findOpById(op.test, id); if (r) return r; }
    if (op.update) { const r = findOpById(op.update, id); if (r) return r; }
  }
  return null;
}

// =============================================================================
// §8.3 — Dead code elimination
// =============================================================================

export function eliminateDeadCode(module) {
  // Mark roots: exports, calls, opaques, slot_stores
  const live = new Set();

  function markReachable(ops) {
    for (const op of ops) {
      // Always-live ops
      if (op.op === 'opaque' || op.op === 'call' || op.op === 'call_method' ||
          op.op === 'slot_store' || op.op === 'store' || op.op === 'object_set' ||
          op.op === 'array_set' || op.op === 'ta_set' || op.op === 'await' ||
          op.op === 'return' || op.op === 'break' || op.op === 'continue') {
        live.add(op.id);
      }

      // Recurse into regions (all region contents are potentially live)
      if (op.then_body) markReachable(op.then_body);
      if (op.else_body) markReachable(op.else_body);
      if (op.body) markReachable(op.body);
      if (op.init) markReachable(op.init);
      if (op.test) markReachable(op.test);
      if (op.update) markReachable(op.update);

      // Regions themselves are live
      if (op.op === 'if_region' || op.op === 'for_region' || op.op === 'loop_region' ||
          op.op === 'for_in_region' || op.op === 'for_of_region' || op.op === 'func_region') {
        live.add(op.id);
      }
    }
  }

  markReachable(module.ops);

  // For now, don't actually remove ops — just mark them.
  // Full DCE requires backward reachability analysis which we can add later.
  return live;
}

// =============================================================================
// §8.4 — Dependency extraction
// =============================================================================

export function extractDependencies(module) {
  // Extract which names are defined and used
  return {
    defines: new Set(module.defines),
    uses: new Set(module.imports),
  };
}

// =============================================================================
// §8.5 — Hint insertion
// =============================================================================

export function insertHints(module, typeMap) {
  function hint(ops) {
    for (const op of ops) {
      if ((op.op === 'add' || op.op === 'sub' || op.op === 'mul' || op.op === 'div' || op.op === 'mod') &&
          isConcrete(op.type) && isNumeric(op.type)) {
        if (!op.meta) op.meta = {};
        op.meta.hint = 'typed';
      }

      // Recurse
      if (op.then_body) hint(op.then_body);
      if (op.else_body) hint(op.else_body);
      if (op.body) hint(op.body);
      if (op.init) hint(op.init);
      if (op.test) hint(op.test);
      if (op.update) hint(op.update);
    }
  }

  hint(module.ops);
}

// =============================================================================
// §8.7 — Runtime helper specialization
// =============================================================================
// Detect calls to runtime helpers (`_py.add`, `_soft.eq`, etc.) where we can
// prove the operands' types, and replace with raw AIR ops. The emitter then
// outputs direct JS operators, skipping the helper call entirely.
//
// This is the big win for typed numeric loops in adder/Soft — instead of
// `_py.add(a, b)` → `a + b` directly.

// Helper method name → { op, resultType, check(lt, rt) }
// check() returns true if the operands' types allow this specialization.
const PY_SPECIALIZATIONS = {
  add: {
    op: 'add',
    // Numbers: same-type addition. Strings: concat. Mixed: skip.
    check: (lt, rt) => {
      if (isNumeric(lt) && isNumeric(rt)) return true;
      if (lt.kind === 'string' && rt.kind === 'string') return true;
      return false;
    },
    resultType: (lt, rt) => {
      if (isNumeric(lt) && isNumeric(rt)) return arithmeticResult(lt, rt);
      return STRING;
    },
  },
  sub: { op: 'sub', check: bothNumeric, resultType: arithmeticResult },
  mul: { op: 'mul', check: bothNumeric, resultType: arithmeticResult },
  // div/mod/floordiv stay in helpers: Python raises ZeroDivisionError, JS returns Infinity/NaN
  pow: { op: 'exp', check: bothNumeric, resultType: arithmeticResult },
  eq: {
    op: 'eq',
    check: (lt, rt) => isNumeric(lt) && isNumeric(rt),
    resultType: () => BOOL,
  },
  neq: {
    op: 'neq',
    check: (lt, rt) => isNumeric(lt) && isNumeric(rt),
    resultType: () => BOOL,
  },
  lt:  { op: 'lt',  check: bothNumeric, resultType: () => BOOL },
  lte: { op: 'lte', check: bothNumeric, resultType: () => BOOL },
  gt:  { op: 'gt',  check: bothNumeric, resultType: () => BOOL },
  gte: { op: 'gte', check: bothNumeric, resultType: () => BOOL },
  neg: {
    op: 'neg',
    arity: 1,
    check: (t) => isNumeric(t),
    resultType: (t) => t,
  },
  truthy: {
    // _py.truthy(true) → just the value (already bool)
    // _py.truthy(x) where x is numeric → x !== 0 (handled via coerce)
    op: null, arity: 1, // handled specially below
    check: (t) => t.kind === 'bool',
    resultType: () => BOOL,
    // For bool input, the helper call is redundant; inline the arg.
    passthrough: true,
  },
};

// Soft specializations — very similar semantics to Python for numeric ops
const SOFT_SPECIALIZATIONS = {
  // Note: Soft's _soft.eq is case-insensitive for strings, so only specialize for numbers.
  eq:  { op: 'eq',  check: bothNumeric, resultType: () => BOOL },
  neq: { op: 'neq', check: bothNumeric, resultType: () => BOOL },
  between: {
    op: null, arity: 3,
    check: (v, lo, hi) => isNumeric(v) && isNumeric(lo) && isNumeric(hi),
    resultType: () => BOOL,
    // Will be handled as: (v >= lo) && (v <= hi). Custom emit.
    customEmit: true,
  },
};

function bothNumeric(lt, rt) {
  return isNumeric(lt) && isNumeric(rt);
}

// Detect sequences like:
//   %A = load "_py"
//   %B = object_get %A, "methodName"
//   %C = call [%B, arg1, arg2]
// and replace %C with a direct AIR op if specialization applies.
//
// We also handle the adder's "awaited call" pattern:
//   %A = load "_py"
//   %B = object_get %A, "methodName"
//   %C = call [%B, arg1, arg2]
//   %D = await [%C]
// In that case we replace both %C and %D; subsequent uses of %D get redirected to the new op.
// Walks ops in order; for each name, tracks the origin op of its current value.
// If a name has a unique origin, we can trace `load name` back to that origin
// for specialization purposes. If reassigned with different origins, the current
// value can change — we use the most recent.
function computeNameOrigins(allOps) {
  const origins = new Map(); // name → SSA id of the value stored
  const opsById = new Map(); // SSA id → op, for fast lookup
  function visit(ops) {
    for (const op of ops) {
      if (op.id) opsById.set(op.id, op);
      if (op.op === 'store' && typeof op.args[0] === 'string') {
        origins.set(op.args[0], op.args[1]);
      }
      for (const key of ['then_body', 'else_body', 'body', 'init', 'test',
                         'update', 'try_body', 'catch_body', 'finally_body']) {
        if (op[key]) visit(op[key]);
      }
      if (op.cases) for (const c of op.cases) {
        if (c.test_ops) visit(c.test_ops);
        if (c.body) visit(c.body);
      }
    }
  }
  visit(allOps);
  return { origins, opsById };
}

// Resolve an SSA id through load ops to its source op (object_new, array_new, etc.)
function resolveOrigin(ssaId, origins, opsById) {
  let op = opsById.get(ssaId);
  if (!op) return null;
  if (op.op === 'load' && typeof op.args[0] === 'string') {
    const originId = origins.get(op.args[0]);
    if (originId) return resolveOrigin(originId, origins, opsById);
  }
  return op;
}

export function specializeRuntimeHelpers(module, types) {
  const replacements = new Map(); // old SSA id → new SSA id (for arg rewrites)
  let changed = false;
  const { origins, opsById } = computeNameOrigins(module.ops);

  // Helper: find op or follow load chains
  function traceOp(ssaId) {
    return resolveOrigin(ssaId, origins, opsById);
  }

  function specialize(ops) {
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];

      // Rewrite args through replacements (in case an earlier op was replaced)
      if (op.args) {
        for (let j = 0; j < op.args.length; j++) {
          const a = op.args[j];
          if (typeof a === 'string' && replacements.has(a)) {
            op.args[j] = replacements.get(a);
          }
        }
      }

      // Recurse into regions first so nested ops are processed
      if (op.then_body) specialize(op.then_body);
      if (op.else_body) specialize(op.else_body);
      if (op.body) specialize(op.body);
      if (op.init) specialize(op.init);
      if (op.test) specialize(op.test);
      if (op.update) specialize(op.update);
      if (op.try_body) specialize(op.try_body);
      if (op.catch_body) specialize(op.catch_body);
      if (op.finally_body) specialize(op.finally_body);
      if (op.cases) for (const c of op.cases) {
        if (c.test_ops) specialize(c.test_ops);
        if (c.body) specialize(c.body);
      }

      // Look for call to a runtime helper method
      if (op.op !== 'call') continue;
      const calleeOp = findOpAnywhere(module.ops, op.args[0]);
      if (!calleeOp || calleeOp.op !== 'object_get') continue;

      const rtOp = findOpAnywhere(module.ops, calleeOp.args[0]);
      if (!rtOp || rtOp.op !== 'load') continue;

      const rtName = rtOp.args[0];
      const specs = rtName === '_py' ? PY_SPECIALIZATIONS :
                    rtName === '_soft' ? SOFT_SPECIALIZATIONS : null;
      if (!specs) continue;

      const method = calleeOp.args[1];

      // --- Special: getattr on plain objects / typed arrays ---
      // _py.getattr(obj, "name") → obj.name when obj is provably a plain value.
      if (method === 'getattr' && op.args.length === 3) {
        const objId = op.args[1];
        const nameId = op.args[2];
        const nameOp = traceOp(nameId);
        if (nameOp && nameOp.op === 'const' && typeof nameOp.args[0] === 'string') {
          const attrName = nameOp.args[0];
          const objOp = traceOp(objId);
          // Plain object literal → direct dot access (no class dispatch needed)
          // Typed/plain array .length → direct (very common)
          const isPlainObject = objOp && objOp.op === 'object_new';
          const isArrayLength = (objOp?.op === 'array_new' || objOp?.op === 'ta_new') && attrName === 'length';
          if (isPlainObject || isArrayLength) {
            op.op = 'object_get';
            op.args = [objId, attrName];
            op.type = isArrayLength ? I32 : DYNAMIC;
            types.set(op.id, op.type);
            changed = true;
            // Absorb trailing await if present
            const nextOp = ops[i + 1];
            if (nextOp && nextOp.op === 'await' && nextOp.args[0] === op.id) {
              nextOp.op = 'const';
              nextOp.args = [undefined];
              nextOp.type = VOID;
              types.set(nextOp.id, VOID);
              replacements.set(nextOp.id, op.id);
            }
            continue;
          }
        }
      }

      // --- Special: getitem specialization ---
      // Plain object literal + const string key → obj.key
      // Plain/typed array + const non-negative index → arr[idx]
      // (Skip the helper's negative-index/dict/dunder handling.)
      if (method === 'getitem' && op.args.length === 3) {
        const objId = op.args[1];
        const idxId = op.args[2];
        const objOp = traceOp(objId);
        const idxOp = traceOp(idxId);

        const isArray = objOp && (objOp.op === 'array_new' || objOp.op === 'ta_new');
        const isObject = objOp && objOp.op === 'object_new';
        const isNonNegNumConst = idxOp?.op === 'const' &&
                                  typeof idxOp.args[0] === 'number' && idxOp.args[0] >= 0;
        const isStringConst = idxOp?.op === 'const' && typeof idxOp.args[0] === 'string';

        let specialized = false;
        if (isArray && isNonNegNumConst) {
          op.op = 'array_get';
          op.args = [objId, idxId];
          op.type = objOp.op === 'ta_new' ? (taElementType(objOp.type) || DYNAMIC) : DYNAMIC;
          specialized = true;
        } else if (isObject && isStringConst) {
          // Dict-as-object: direct property access with string key
          op.op = 'object_get';
          op.args = [objId, idxOp.args[0]];
          op.type = DYNAMIC;
          specialized = true;
        }

        if (specialized) {
          types.set(op.id, op.type);
          changed = true;
          const nextOp = ops[i + 1];
          if (nextOp && nextOp.op === 'await' && nextOp.args[0] === op.id) {
            nextOp.op = 'const';
            nextOp.args = [undefined];
            nextOp.type = VOID;
            types.set(nextOp.id, VOID);
            replacements.set(nextOp.id, op.id);
          }
          continue;
        }
      }

      const spec = specs[method];
      if (!spec) continue;

      // Gather arg types
      const argIds = op.args.slice(1);
      const argTypes = argIds.map(id => types.get(id) || DYNAMIC);
      const arity = spec.arity ?? 2;
      if (argIds.length !== arity) continue;

      // Check if types qualify
      if (!spec.check(...argTypes)) continue;

      // Determine result type
      const resT = spec.resultType(...argTypes);

      // Passthrough: replace the call result with the single arg
      if (spec.passthrough) {
        replacements.set(op.id, argIds[0]);
        // Also replace the outer await if it directly wraps this call
        const nextOp = ops[i + 1];
        if (nextOp && nextOp.op === 'await' && nextOp.args[0] === op.id) {
          replacements.set(nextOp.id, argIds[0]);
        }
        continue;
      }

      // Custom emit (between = v >= lo && v <= hi)
      if (spec.customEmit && method === 'between') {
        const [v, lo, hi] = argIds;
        // Replace in-place with a logical_and wrapping two comparisons.
        // Approach: keep `op` but change it into a `logical_and` that
        // references two new compare ops we insert before it.
        const gteId = '%s' + op.id; // synthetic intermediate
        const lteId = '%s2' + op.id;
        // Rewrite op.op to 'logical_and' with args pointing to stable synthetic IDs.
        // We'll emit two new `ge` and `le` ops right before op in the array.
        const gteOp = { id: gteId, op: 'gte', args: [v, lo], type: BOOL, loc: op.loc };
        const lteOp = { id: lteId, op: 'lte', args: [v, hi], type: BOOL, loc: op.loc };
        ops.splice(i, 0, gteOp, lteOp);
        types.set(gteId, BOOL);
        types.set(lteId, BOOL);
        // Now op is at index i+2; rewrite it to logical_and
        const target = ops[i + 2];
        target.op = 'logical_and';
        target.args = [gteId, lteId];
        target.type = BOOL;
        types.set(target.id, BOOL);
        i += 2; // skip the inserted ops
        continue;
      }

      // Standard case: rewrite the call into a direct AIR op
      // Also absorb a trailing await if present (the op result is sync).
      op.op = spec.op;
      op.args = argIds;
      op.type = resT;
      types.set(op.id, resT);
      changed = true;
      // Fall through to async-absorb handling below
      const nextOp = ops[i + 1];
      if (nextOp && nextOp.op === 'await' && nextOp.args[0] === op.id) {
        // The await is now redundant (we produced a direct value, not a promise)
        replacements.set(nextOp.id, op.id);
        // Replace the await op with a no-op const — cleaner to just remove.
        // But removing shifts indices; instead, turn it into a load of the call result.
        // Simplest: change the await into a store-less pass-through.
        nextOp.op = 'const';  // harmless; DCE should remove
        nextOp.args = [undefined];
        nextOp.type = VOID;
        types.set(nextOp.id, VOID);
      }
    }
  }

  specialize(module.ops);
  return { replacements, changed };
}

function findOpAnywhere(ops, id) {
  for (const op of ops) {
    if (op.id === id) return op;
    for (const field of ['then_body','else_body','body','init','test','update',
                         'try_body','catch_body','finally_body']) {
      if (op[field]) { const r = findOpAnywhere(op[field], id); if (r) return r; }
    }
    if (op.cases) {
      for (const c of op.cases) {
        if (c.test_ops) { const r = findOpAnywhere(c.test_ops, id); if (r) return r; }
        if (c.body) { const r = findOpAnywhere(c.body, id); if (r) return r; }
      }
    }
  }
  return null;
}

// =============================================================================
// Combined pass runner
// =============================================================================

export function runPasses(module, opts = {}) {
  let typeMap = propagateTypes(module, opts);
  foldConstants(module);
  // Iterate specialize ↔ re-propagate until fixed point (typically 2-3 rounds).
  for (let i = 0; i < 5; i++) {
    const { changed } = specializeRuntimeHelpers(module, typeMap);
    if (!changed) break;
    typeMap = propagateTypes(module, opts);
  }
  insertHints(module, typeMap);
  const deps = extractDependencies(module);
  return { typeMap, deps };
}
