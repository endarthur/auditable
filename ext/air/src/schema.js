// @gcu/air — Op schema (v0.3 §3.1)
//
// Single declarative source of truth for what every AIR op contains: how
// many SSA refs, in what shape, whether it has region children, what extras
// it requires, whether it's pure or side-effecting, whether it can be async.
//
// Every pass that walks the IR (countUses, propagateTypes, foldConstants,
// needsAsync, the validator, the pretty-printer) consults the schema via
// the helper functions below, so adding a new op is one row instead of
// editing eight switch statements.
//
// Args shape vocabulary:
//   'ssa'        — bare SSA id string ('%N')
//   'literal'    — JS literal (string/number/bool/undefined/null) for const
//   'name'       — variable name (for load/store/slot_*)
//   'key'        — string key (for object_get/set, call_method)
//   'label'      — label name for break/continue/labeled
//   'kind'       — typed-array element kind for ta_new
//   'meta_name'  — meta target ('new', 'import')
//
// Variadic shapes:
//   'ssa_list'         — args is an array of bare SSA ids (call args, array_new)
//   'pair_list'        — args is an array of { key|spread, id } records (object_new)
//   'name_then_ssas'   — args[0] is name, rest are SSA ids (call_method first
//                        position is the receiver SSA, but call_method is
//                        encoded as [obj_ssa, method_string, ...arg_ssa] so
//                        it gets its own shape)
//   'method_call'      — [ssa, key, ...ssa] for call_method
//   'ta_new_args'      — [kind, ...ssa] for ta_new

const SSA = 'ssa';
const LIT = 'literal';
const NAME = 'name';
const KEY = 'key';
const LABEL = 'label';

export const OP_SCHEMA = {
  // ── Constants and primitive loads ──────────────────────────────────
  const: {
    arity: 'fixed', args: [LIT],
    result: 'value', side_effecting: false, can_be_async: false,
  },
  null: {
    arity: 'fixed', args: [],
    result: 'value', side_effecting: false, can_be_async: false,
  },
  load: {
    arity: 'fixed', args: [NAME],
    result: 'value', side_effecting: false, can_be_async: false,
  },
  store: {
    arity: 'fixed', args: [NAME, SSA],
    result: 'void', side_effecting: true, can_be_async: false,
  },
  meta: {
    arity: 'fixed', args: ['meta_name', 'meta_prop'],
    result: 'value', side_effecting: false, can_be_async: false,
  },

  // ── Slot allocation (closure cells for mutable captures) ───────────
  slot_alloc: {
    arity: 'fixed', args: [NAME],
    result: 'value', side_effecting: false, can_be_async: false,
  },
  slot_load: {
    arity: 'fixed', args: [NAME],
    result: 'value', side_effecting: false, can_be_async: false,
  },
  slot_store: {
    arity: 'fixed', args: [NAME, SSA],
    result: 'void', side_effecting: true, can_be_async: false,
  },

  // ── Arithmetic ─────────────────────────────────────────────────────
  add: { arity: 'fixed', args: [SSA, SSA], result: 'value', side_effecting: false, can_be_async: false },
  sub: { arity: 'fixed', args: [SSA, SSA], result: 'value', side_effecting: false, can_be_async: false },
  mul: { arity: 'fixed', args: [SSA, SSA], result: 'value', side_effecting: false, can_be_async: false },
  div: { arity: 'fixed', args: [SSA, SSA], result: 'value', side_effecting: false, can_be_async: false },
  mod: { arity: 'fixed', args: [SSA, SSA], result: 'value', side_effecting: false, can_be_async: false },
  exp: { arity: 'fixed', args: [SSA, SSA], result: 'value', side_effecting: false, can_be_async: false },

  // ── Comparison ─────────────────────────────────────────────────────
  eq:  { arity: 'fixed', args: [SSA, SSA], result: 'value', side_effecting: false, can_be_async: false },
  neq: { arity: 'fixed', args: [SSA, SSA], result: 'value', side_effecting: false, can_be_async: false },
  lt:  { arity: 'fixed', args: [SSA, SSA], result: 'value', side_effecting: false, can_be_async: false },
  lte: { arity: 'fixed', args: [SSA, SSA], result: 'value', side_effecting: false, can_be_async: false },
  gt:  { arity: 'fixed', args: [SSA, SSA], result: 'value', side_effecting: false, can_be_async: false },
  gte: { arity: 'fixed', args: [SSA, SSA], result: 'value', side_effecting: false, can_be_async: false },

  // ── Bitwise ────────────────────────────────────────────────────────
  bitwise_or:    { arity: 'fixed', args: [SSA, SSA], result: 'value', side_effecting: false, can_be_async: false },
  bitwise_and:   { arity: 'fixed', args: [SSA, SSA], result: 'value', side_effecting: false, can_be_async: false },
  bitwise_xor:   { arity: 'fixed', args: [SSA, SSA], result: 'value', side_effecting: false, can_be_async: false },
  shift_left:    { arity: 'fixed', args: [SSA, SSA], result: 'value', side_effecting: false, can_be_async: false },
  shift_right:   { arity: 'fixed', args: [SSA, SSA], result: 'value', side_effecting: false, can_be_async: false },
  ushift_right:  { arity: 'fixed', args: [SSA, SSA], result: 'value', side_effecting: false, can_be_async: false },

  // ── Logical ────────────────────────────────────────────────────────
  logical_and:       { arity: 'fixed', args: [SSA, SSA], result: 'value', side_effecting: false, can_be_async: false },
  logical_or:        { arity: 'fixed', args: [SSA, SSA], result: 'value', side_effecting: false, can_be_async: false },
  nullish_coalesce:  { arity: 'fixed', args: [SSA, SSA], result: 'value', side_effecting: false, can_be_async: false },

  // ── Membership ─────────────────────────────────────────────────────
  in:         { arity: 'fixed', args: [SSA, SSA], result: 'value', side_effecting: false, can_be_async: false },
  instanceof: { arity: 'fixed', args: [SSA, SSA], result: 'value', side_effecting: false, can_be_async: false },

  // ── Unary ──────────────────────────────────────────────────────────
  neg:         { arity: 'fixed', args: [SSA], result: 'value', side_effecting: false, can_be_async: false },
  unary_plus:  { arity: 'fixed', args: [SSA], result: 'value', side_effecting: false, can_be_async: false },
  logical_not: { arity: 'fixed', args: [SSA], result: 'value', side_effecting: false, can_be_async: false },
  bitwise_not: { arity: 'fixed', args: [SSA], result: 'value', side_effecting: false, can_be_async: false },
  typeof:      { arity: 'fixed', args: [SSA], result: 'value', side_effecting: false, can_be_async: false },
  void:        { arity: 'fixed', args: [SSA], result: 'value', side_effecting: false, can_be_async: false },
  delete:      { arity: 'fixed', args: [SSA], result: 'value', side_effecting: true,  can_be_async: false },

  // ── Member access ──────────────────────────────────────────────────
  object_get: {
    arity: 'fixed', args: [SSA, KEY],
    result: 'value', side_effecting: false, can_be_async: false,
    extras: { optional: 'bool?' },
  },
  object_set: {
    arity: 'fixed', args: [SSA, KEY, SSA],
    result: 'void', side_effecting: true, can_be_async: false,
  },
  array_get: {
    arity: 'fixed', args: [SSA, SSA],
    result: 'value', side_effecting: false, can_be_async: false,
    extras: { optional: 'bool?' },
  },
  array_set: {
    arity: 'fixed', args: [SSA, SSA, SSA],
    result: 'void', side_effecting: true, can_be_async: false,
  },

  // ── Construction ───────────────────────────────────────────────────
  array_new: {
    arity: 'variadic', args: 'ssa_list',
    result: 'value', side_effecting: false, can_be_async: false,
  },
  object_new: {
    arity: 'variadic', args: 'pair_list',
    result: 'value', side_effecting: false, can_be_async: false,
  },
  ta_new: {
    arity: 'variadic', args: 'ta_new_args',  // [kind_string, ...ssa]
    result: 'value', side_effecting: false, can_be_async: false,
  },
  new: {
    arity: 'variadic', args: 'ssa_list',  // [ctor_ssa, ...arg_ssa]
    result: 'value', side_effecting: true, can_be_async: true,
  },

  // ── Calls ──────────────────────────────────────────────────────────
  call: {
    arity: 'variadic', args: 'ssa_list',  // [fn_ssa, ...arg_ssa]
    result: 'value', side_effecting: true, can_be_async: true,
  },
  call_method: {
    arity: 'variadic', args: 'method_call',  // [obj_ssa, method_key, ...arg_ssa]
    result: 'value', side_effecting: true, can_be_async: true,
  },
  await: {
    arity: 'fixed', args: [SSA],
    result: 'value', side_effecting: true, can_be_async: true,
  },
  spread: {
    arity: 'fixed', args: [SSA],
    result: 'value', side_effecting: false, can_be_async: false,
  },
  import: {
    arity: 'fixed', args: [SSA],
    result: 'value', side_effecting: true, can_be_async: true,
  },

  // ── Statements ─────────────────────────────────────────────────────
  throw: {
    arity: 'fixed', args: [SSA],
    result: 'void', side_effecting: true, can_be_async: false,
  },
  debugger: {
    arity: 'fixed', args: [],
    result: 'void', side_effecting: true, can_be_async: false,
  },
  return: {
    arity: 'fixed', args: [SSA],
    result: 'void', side_effecting: true, can_be_async: false,
  },
  break: {
    // args=[] for unlabeled, [label] for labeled
    arity: 'variadic', args: 'label_optional',
    result: 'void', side_effecting: true, can_be_async: false,
  },
  continue: {
    arity: 'variadic', args: 'label_optional',
    result: 'void', side_effecting: true, can_be_async: false,
  },
  yield: {
    // args=[] for `yield` no value, [ssa] for `yield expr`
    arity: 'variadic', args: 'ssa_optional',
    result: 'value', side_effecting: true, can_be_async: false,
  },
  yield_delegate: {
    arity: 'fixed', args: [SSA],
    result: 'value', side_effecting: true, can_be_async: false,
  },

  // ── Region ops ─────────────────────────────────────────────────────
  // if_region — produces a value when used as ternary (else_body present);
  // void as a statement. Conservatively 'value' here.
  if_region: {
    arity: 'fixed', args: [SSA],  // condition
    result: 'value', side_effecting: true, can_be_async: false,  // body decides actual side-effect
    regions: {
      then_body: { scope: 'block' },
      else_body: { scope: 'block', optional: true },
    },
    extras: {
      then_val: 'ssa?',
      else_val: 'ssa?',
      phis: 'phi_list?',
    },
    introduces_scope: true,
  },
  for_region: {
    arity: 'fixed', args: [],
    result: 'void', side_effecting: true, can_be_async: false,
    regions: {
      init: { scope: 'loop' },
      test: { scope: 'loop' },
      update: { scope: 'loop' },
      body: { scope: 'loop' },
    },
    extras: {
      test_val: 'ssa?',
      phis: 'phi_list?',
    },
    introduces_scope: true,
  },
  for_in_region: {
    arity: 'fixed', args: [SSA],  // iterable
    result: 'void', side_effecting: true, can_be_async: false,
    regions: { body: { scope: 'loop' } },
    extras: {
      target_name: 'string?',
      phis: 'phi_list?',
    },
    introduces_scope: true,
  },
  for_of_region: {
    arity: 'fixed', args: [SSA],  // iterable
    result: 'void', side_effecting: true, can_be_async: false,
    regions: { body: { scope: 'loop' } },
    extras: {
      target_name: 'string',  // REQUIRED (no silent _v fallback per v0.3 §3.2)
      phis: 'phi_list?',
    },
    introduces_scope: true,
  },
  loop_region: {
    arity: 'fixed', args: [],
    result: 'void', side_effecting: true, can_be_async: false,
    regions: {
      test: { scope: 'loop', optional: true },
      body: { scope: 'loop' },
      update: { scope: 'loop', optional: true },
    },
    extras: {
      test_val: 'ssa?',
      phis: 'phi_list?',
      kind: 'string?',  // 'while' | 'do_while' | 'condition_first' etc.
    },
    introduces_scope: true,
  },
  switch_region: {
    arity: 'fixed', args: [SSA],  // discriminant
    result: 'void', side_effecting: true, can_be_async: false,
    extras: {
      cases: 'case_list',  // [{ test_ops, test_val?, body }]
    },
    introduces_scope: true,
  },
  try_region: {
    arity: 'fixed', args: [],
    result: 'void', side_effecting: true, can_be_async: false,
    regions: {
      try_body: { scope: 'block' },
      catch_body: { scope: 'block', optional: true },
      finally_body: { scope: 'block', optional: true },
    },
    extras: {
      catch_param: 'string?',
    },
    introduces_scope: true,
  },
  labeled: {
    arity: 'fixed', args: [LABEL],
    result: 'void', side_effecting: true, can_be_async: false,
    regions: { body: { scope: 'block' } },
    extras: {
      is_block: 'bool?',
    },
    introduces_scope: true,
  },
  func_region: {
    // args is [name|null]; name is also kept on op for emit convenience
    arity: 'fixed', args: ['func_name'],
    result: 'value', side_effecting: false, can_be_async: false,  // declaring is pure
    regions: { body: { scope: 'function' } },
    extras: {
      name: 'string?',
      params: 'param_list',
      ret_type: 'type?',
      is_async: 'bool?',
      is_generator: 'bool?',
      is_decl: 'bool?',
    },
    introduces_scope: true,
  },
  class_region: {
    arity: 'fixed', args: ['class_name'],
    result: 'value', side_effecting: false, can_be_async: false,
    extras: {
      name: 'string?',
      members: 'member_list',  // [{ kind, key, value?, body?, ... }]
      superclass: 'ssa?',
    },
    introduces_scope: true,
  },

  // ── Special ────────────────────────────────────────────────────────
  // `opaque` is the relief valve for anything the lowerer can't model.
  // Args[0] is the JS source string; the emitter prints it verbatim.
  // Side effects unknown — conservative: yes; can be async too.
  opaque: {
    arity: 'fixed', args: ['source'],
    result: 'value', side_effecting: true, can_be_async: true,
    extras: {
      _markDeclared: 'string?',  // adder/soft global/nonlocal hint
    },
  },
};

// ── Helper API ────────────────────────────────────────────────────────

/**
 * Iterate every SSA reference an op contains. Replaces per-op switch-style
 * walkers in countUses, type propagation, dead-code elimination, etc.
 *
 * Calls fn(id) for each '%N' SSA reference found in args, region phis,
 * member declarations, switch case test_vals, and `extras` declared as
 * 'ssa'/'ssa?' in the schema.
 *
 * Does NOT recurse into region bodies — callers handle that explicitly via
 * forEachRegion (so they can control traversal order, scope tracking, etc).
 */
export function forEachSsaRef(op, fn) {
  const schema = OP_SCHEMA[op.op];
  if (!schema) return;

  // 1. Direct args based on shape
  if (schema.arity === 'fixed') {
    for (let i = 0; i < schema.args.length; i++) {
      if (schema.args[i] === SSA && _isSsaId(op.args[i])) fn(op.args[i]);
    }
  } else if (schema.args === 'ssa_list') {
    for (const a of op.args) if (_isSsaId(a)) fn(a);
  } else if (schema.args === 'pair_list') {
    for (const p of op.args) {
      if (p && _isSsaId(p.id)) fn(p.id);
    }
  } else if (schema.args === 'method_call') {
    // [ssa, key, ...ssa]
    if (_isSsaId(op.args[0])) fn(op.args[0]);
    for (let i = 2; i < op.args.length; i++) {
      if (_isSsaId(op.args[i])) fn(op.args[i]);
    }
  } else if (schema.args === 'ta_new_args') {
    // [kind, ...ssa]
    for (let i = 1; i < op.args.length; i++) {
      if (_isSsaId(op.args[i])) fn(op.args[i]);
    }
  } else if (schema.args === 'label_optional') {
    /* args[0] is label string if present, no SSA */
  } else if (schema.args === 'ssa_optional') {
    if (op.args.length && _isSsaId(op.args[0])) fn(op.args[0]);
  }

  // 2. Extras declared as ssa/ssa?
  if (schema.extras) {
    for (const [key, spec] of Object.entries(schema.extras)) {
      if (spec === 'ssa' || spec === 'ssa?') {
        const v = op[key];
        if (_isSsaId(v)) fn(v);
      }
    }
  }

  // 3. phi lists (then_val/else_val per phi entry)
  if (op.phis) {
    for (const p of op.phis) {
      if (_isSsaId(p.then_val)) fn(p.then_val);
      if (_isSsaId(p.else_val)) fn(p.else_val);
    }
  }

  // 4. Switch case test_vals + member computed-key SSA refs + member-init
  //    values (class members store {value: ssa, computedKeyId: ssa}).
  if (op.cases) {
    for (const c of op.cases) {
      if (_isSsaId(c.test_val)) fn(c.test_val);
    }
  }
  if (op.members) {
    for (const m of op.members) {
      if (_isSsaId(m.value)) fn(m.value);
      if (_isSsaId(m.computedKeyId)) fn(m.computedKeyId);
    }
  }
  if (_isSsaId(op.superclass)) fn(op.superclass);
}

/**
 * Iterate every region of an op. Calls fn(name, ops, scopeKind) for each
 * region declared in the schema. Also walks switch cases' bodies (treated
 * as a synthetic 'cases' region group) and class members' bodies.
 *
 * @param op   the op object
 * @param fn   (name, ops, scopeKind) called per region
 */
export function forEachRegion(op, fn) {
  const schema = OP_SCHEMA[op.op];
  if (!schema || !schema.regions) {
    // Switch/class don't have schema.regions; they have synthetic regions.
    if (op.cases) {
      for (let i = 0; i < op.cases.length; i++) {
        const c = op.cases[i];
        if (c.test_ops) fn(`cases[${i}].test_ops`, c.test_ops, 'block');
        if (c.body) fn(`cases[${i}].body`, c.body, 'block');
      }
    }
    if (op.members) {
      for (let i = 0; i < op.members.length; i++) {
        const m = op.members[i];
        if (m.body) fn(`members[${i}].body`, m.body, 'function');
      }
    }
    return;
  }
  for (const [name, info] of Object.entries(schema.regions)) {
    const ops = op[name];
    if (ops) fn(name, ops, info.scope);
  }
  // Switch cases / class members may also coexist with declared regions
  // (e.g. some hypothetical region op with both — none currently). For
  // future-proofing, mirror the synthetic-region branch above.
  if (op.cases) {
    for (let i = 0; i < op.cases.length; i++) {
      const c = op.cases[i];
      if (c.test_ops) fn(`cases[${i}].test_ops`, c.test_ops, 'block');
      if (c.body) fn(`cases[${i}].body`, c.body, 'block');
    }
  }
  if (op.members) {
    for (let i = 0; i < op.members.length; i++) {
      const m = op.members[i];
      if (m.body) fn(`members[${i}].body`, m.body, 'function');
    }
  }
}

/**
 * True if this op type introduces a new lexical scope. Used by ScopeChain
 * (v0.3 step 7) to decide push/pop boundaries.
 */
export function introducesScope(op) {
  const schema = OP_SCHEMA[op.op];
  return !!(schema && schema.introduces_scope);
}

/**
 * True if this op has observable side effects — must be kept by DCE even
 * with zero uses.
 */
export function isSideEffecting(op) {
  const schema = OP_SCHEMA[op.op];
  return !!(schema && schema.side_effecting);
}

/**
 * True if this op may produce or contain an async point. Used by
 * needsAsync to decide whether the cell wrapper is sync or AsyncFunction.
 */
export function canBeAsync(op) {
  const schema = OP_SCHEMA[op.op];
  return !!(schema && schema.can_be_async);
}

/**
 * Returns the list of extras keys that must be present on ops of this
 * type (i.e. extras whose schema spec doesn't end with '?').
 */
export function requiredExtras(opName) {
  const schema = OP_SCHEMA[opName];
  if (!schema || !schema.extras) return [];
  return Object.entries(schema.extras)
    .filter(([, spec]) => typeof spec === 'string' && !spec.endsWith('?'))
    .map(([k]) => k);
}

/**
 * Returns the schema row for an op type, or undefined if unknown.
 */
export function getSchema(opName) {
  return OP_SCHEMA[opName];
}

/**
 * Compute coverage stats for an AIR module. Walks every op (including
 * inside regions) and counts:
 *   - opCount        total ops
 *   - opaqueCount    ops emitted as 'opaque' (lowering relief valve)
 *   - dynCount       ops whose result type is 'dynamic' (no specialization)
 *   - byKind         { [opName]: count }
 *
 * Cheap (single walk, no allocations per-op beyond the counter map).
 * Stored on `module._airStats` after passes run.
 *
 * Lets future debug panels show "21/26 cells used AIR" / "this cell has
 * 5 opaque ops" as structured data instead of console-spam parsing.
 */
export function computeStats(module) {
  let opCount = 0;
  let opaqueCount = 0;
  let dynCount = 0;
  const byKind = Object.create(null);

  function walk(ops) {
    for (const op of ops) {
      opCount++;
      byKind[op.op] = (byKind[op.op] || 0) + 1;
      if (op.op === 'opaque') opaqueCount++;
      if (op.type && op.type.kind === 'dynamic') dynCount++;
      forEachRegion(op, (_n, rops) => walk(rops));
    }
  }
  walk(module.ops);

  return { opCount, opaqueCount, dynCount, byKind };
}

// ── internals ─────────────────────────────────────────────────────────

// Exported so validate.js can share it — both files used to declare local
// copies, which collided at concat-build time. (See test/bundles-smoke.test.mjs.)
export function _isSsaId(v) {
  return typeof v === 'string' && v.length > 0 && v[0] === '%';
}
