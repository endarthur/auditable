// @gcu/air — Optimization passes
// Spec §8: Type propagation, constant folding, DCE, dependency extraction

import {
  I32, F64, BOOL, STRING, VOID, DYNAMIC,
  isDynamic, isConcrete, isNumeric,
  arithmeticResult, typeEq,
} from './types.js';

// =============================================================================
// §8.1 — Type propagation
// =============================================================================

export function propagateTypes(module) {
  const types = new Map(); // SSA id → type

  function propagate(ops) {
    for (const op of ops) {
      // Carry existing type
      if (op.type && !isDynamic(op.type)) {
        types.set(op.id, op.type);
      }

      switch (op.op) {
        case 'const':
          types.set(op.id, op.type);
          break;

        case 'add': case 'sub': case 'mul': case 'div': case 'mod': {
          const lt = types.get(op.args[0]) || DYNAMIC;
          const rt = types.get(op.args[1]) || DYNAMIC;
          if (op.op === 'add' && (lt.kind === 'string' || rt.kind === 'string')) {
            op.type = STRING;
          } else if (!isDynamic(lt) && !isDynamic(rt) && isNumeric(lt) && isNumeric(rt)) {
            op.type = arithmeticResult(lt, rt);
          }
          types.set(op.id, op.type);
          break;
        }

        case 'neg': {
          const t = types.get(op.args[0]) || DYNAMIC;
          op.type = t;
          types.set(op.id, t);
          break;
        }

        case 'bitwise_or': case 'bitwise_and': case 'bitwise_xor':
        case 'shift_left': case 'shift_right': case 'ushift_right':
          op.type = I32;
          types.set(op.id, I32);
          break;

        case 'eq': case 'neq': case 'lt': case 'lte': case 'gt': case 'gte':
        case 'logical_not':
          op.type = BOOL;
          types.set(op.id, BOOL);
          break;

        case 'logical_and': case 'logical_or': {
          const rt = types.get(op.args[1]) || DYNAMIC;
          op.type = rt;
          types.set(op.id, rt);
          break;
        }

        case 'load': {
          // Keep existing type (may have been set by annotation)
          types.set(op.id, op.type || DYNAMIC);
          break;
        }

        case 'store': {
          // Transfer type from value to the stored name
          const valType = types.get(op.args[1]) || DYNAMIC;
          types.set(op.id, VOID);
          break;
        }

        case 'slot_load': {
          types.set(op.id, op.type || DYNAMIC);
          break;
        }

        case 'object_get': case 'array_get': {
          types.set(op.id, op.type || DYNAMIC);
          break;
        }

        case 'ta_new': {
          types.set(op.id, op.type);
          break;
        }

        case 'ta_get': {
          types.set(op.id, op.type || DYNAMIC);
          break;
        }

        case 'call': case 'call_method': {
          types.set(op.id, op.type || DYNAMIC);
          break;
        }

        case 'func_region': {
          types.set(op.id, op.type);
          if (op.body) propagate(op.body);
          break;
        }

        case 'if_region': {
          if (op.then_body) propagate(op.then_body);
          if (op.else_body) propagate(op.else_body);
          types.set(op.id, op.type || VOID);
          break;
        }

        case 'for_region': {
          if (op.init) propagate(op.init);
          if (op.test) propagate(op.test);
          if (op.update) propagate(op.update);
          if (op.body) propagate(op.body);
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
          if (op.body) propagate(op.body);
          types.set(op.id, VOID);
          break;
        }

        default:
          if (!types.has(op.id)) types.set(op.id, op.type || DYNAMIC);
      }
    }
  }

  propagate(module.ops);
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
// Combined pass runner
// =============================================================================

export function runPasses(module) {
  const typeMap = propagateTypes(module);
  foldConstants(module);
  insertHints(module, typeMap);
  const deps = extractDependencies(module);
  return { typeMap, deps };
}
