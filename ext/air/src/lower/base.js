// @gcu/air — Shared lowering scaffolding
//
// First step of the lowerer-frontend extraction (spec_inbox/lang/
// air-lowerer-frontend-spec.md). Three lowerers (JS / adder / soft)
// each had their own LowerCtx, mkOp, and id-counter — identical fields
// and methods, divergent only in language-specific extras (mutable-
// capture analysis for JS, sync-function detection for adder, etc.).
//
// This module hosts the common parts; each lowerer extends `BaseLowerCtx`
// with whatever it needs on top. Cross-package consumers (adder, soft)
// inline this file at build time the same way they already inline
// types.js — see their build.js scripts.
//
// Subsequent extraction sessions can lift more shared scaffolding here:
// BinOp dispatch tables (BINARY_OP_MAP), control-flow lowering helpers,
// class-lowering primitives. Today's scope is just the context object.

import { DYNAMIC, VOID, BOOL } from '../types.js';
import { ScopeChain } from '../scope.js';

/**
 * Lowering failure that the wrapper at ext/air/src/api.js treats as
 * "fall back to the tree-walker / opaque path" rather than "real bug,
 * propagate." The `_airFallback: true` marker is the load-bearing
 * contract — every frontend's lowerer should throw this (or a subclass
 * of it) for nodes it can't handle.
 *
 * Lifted to base.js so all frontends share one definition; previously
 * adder + soft each defined their own identical class.
 */
class AirLowerError extends Error {
  constructor(message) {
    super(message);
    this._airFallback = true;
    this.name = 'AirLowerError';
  }
}

/**
 * Per-instance SSA-id generator. Each lowering invocation gets its own,
 * so cell A's ids don't collide with cell B's even when both lowerers
 * share this module.
 */
function makeIdGen() {
  let n = 0;
  return {
    next: () => '%' + (n++),
    reset: () => { n = 0; },
    peek: () => n,
  };
}

/**
 * Build an op record. Mirror of the per-language mkOp helpers each
 * lowerer used to keep — identical except for the type default. We
 * default to DYNAMIC across the board, matching adder/soft's prior
 * behavior; JS's lowerer used to leave type undefined for some ops,
 * but downstream `if (type) types.set(...)` checks make the difference
 * unobservable.
 */
function mkOp(id, op, args, type, loc, extra) {
  const o = { id, op, args, type: type || DYNAMIC, loc };
  if (extra) Object.assign(o, extra);
  return o;
}

/**
 * Shared lowering context. Each lowerer subclasses this to add
 * language-specific fields (mutable-capture set, sync-function set,
 * adder-specific declared tracker, etc.) and provides a per-language
 * `loc(node)` because AST shapes differ.
 *
 * Fields:
 *   ops      — flat list of ops emitted into the current region. Region
 *              lowering swaps ops to a sub-list, lowers the body, and
 *              restores ops to the parent list (regions hold their body
 *              in their own ops array).
 *   symbols  — ScopeChain<name, ssa_id>. Push at function/block
 *              boundaries to scope inner-fn shadows correctly (see F's
 *              ctx.symbols migration). Adder/soft have not yet added
 *              push/pop discipline; today they treat the chain as a
 *              flat root frame.
 *   types    — Map<ssa_id, Type> for value tracking inside the lowerer
 *              (passes do their own; this is the lowerer's local view).
 *   topLevel — true when emitting at the cell's root scope (so let/const
 *              declarations register as cell exports). Each region
 *              lowering toggles to false.
 *   defines  — set of names this cell exports.
 *   imports  — set of free names this cell references but doesn't define
 *              (cross-cell deps).
 *   source   — original source string, for the opaque escape hatch.
 */
class BaseLowerCtx {
  constructor() {
    this.ops = [];
    this.symbols = new ScopeChain();
    this.types = new Map();
    this.topLevel = true;
    this.defines = new Set();
    this.imports = new Set();
    this.source = null;
    this._idGen = makeIdGen();
  }

  emit(op, args, type, loc, extra) {
    const o = mkOp(this._idGen.next(), op, args, type, loc, extra);
    this.ops.push(o);
    if (type) this.types.set(o.id, type);
    return o;
  }

  // Subclasses override to provide language-specific node→{line, col}.
  loc(_node) { return null; }

  /**
   * Synthesize a unique-per-cell identifier with a readable prefix.
   * Used wherever a lowering needs a temporary name visible in emitted
   * JS — e.g. comprehensions' result accumulator, with-block managers,
   * for-of unpacking targets, repeat-loop counters.
   *
   *   ctx.makeTempName('rep')      → '__rep_42'
   *   ctx.makeTempName('with_mgr') → '__with_mgr_43'
   *
   * Convention: `__` prefix marks synthetic names so user code can't
   * accidentally shadow them; the trailing `_N` ties the name to
   * lowering progress and stays stable across re-emits.
   */
  makeTempName(prefix) {
    return `__${prefix}_${this._idGen.peek()}`;
  }

  /**
   * Emit a runtime-helper call: `<namespace>.<method>(<args>)`. Each
   * frontend dispatches differently to its runtime — adder uses
   * `_py.add(a, b)` for dunder semantics, soft uses `_soft.eq(a, b)`
   * for case-insensitive string compare, etc. — but the AIR shape is
   * identical:
   *
   *   load(namespace) → object_get(method) → call(method_id, …args)
   *
   * Frontends keep thin wrappers (e.g. `emitPyCall = (ctx, m, a, l, t) =>
   * ctx.emitNamespacedCall('_py', m, a, l, t)`) for ergonomics, but
   * the canonical path lives here.
   *
   * @param {string} namespace - the runtime helper's variable name
   * @param {string} method    - method to call on the namespace
   * @param {Array<{id: string}>} args - SSA-typed argument ops
   * @param {object|null} loc  - source location
   * @param {object|null} type - result type hint, defaults to DYNAMIC
   */
  emitNamespacedCall(namespace, method, args, loc, type) {
    const ns = this.emit('load', [namespace], DYNAMIC, loc);
    const methodGet = this.emit('object_get', [ns.id, method], DYNAMIC, loc);
    return this.emit(
      'call',
      [methodGet.id, ...args.map(a => a.id)],
      type || DYNAMIC,
      loc,
    );
  }

  /**
   * Coerce a value to a boolean for branching contexts (if / while /
   * and / or / ternary). Default is JS-style pass-through — the if_region
   * op accepts the value as-is. Frontends with non-JS truthiness
   * semantics (Python's _py.truthy with empty-list/empty-dict cases,
   * Soft's case-folding rules) override:
   *
   *   class AdderLowerCtx extends BaseLowerCtx {
   *     truthy(valueOp, loc) {
   *       return this.emitNamespacedCall('_py', 'truthy', [valueOp], loc, BOOL);
   *     }
   *   }
   *
   * Used by lowerIfRegion, lowerLoopRegion, and (soon) phi-select for
   * and/or short-circuiting.
   */
  truthy(valueOp, _loc) { return valueOp; }
}

/**
 * The "two branches, pick a value via phi" pattern that shows up in
 * every ternary-ish construct: JS `cond ? a : b`, adder `a if c else b`,
 * adder `a and b` / `a or b`, soft `X if cond otherwise Y`, etc.
 *
 * Caller provides:
 *   - condId  - SSA id of the (already-truthy-coerced) condition
 *   - thenFn  - callback that lowers the then-branch and returns its
 *               value op; called inside captureOps so its emits become
 *               then_body
 *   - elseFn  - same for else-branch
 *
 * Returns the if_region op, with phi wired so downstream consumers
 * can reference it as a single value.
 */
function emitPhiSelect(ctx, condId, thenFn, elseFn, loc, type) {
  let thenVal = null;
  let elseVal = null;
  const thenBody = captureOps(ctx, () => { thenVal = thenFn(); });
  const elseBody = captureOps(ctx, () => { elseVal = elseFn(); });
  return ctx.emit('if_region', [condId], type || DYNAMIC, loc, {
    then_body: thenBody,
    else_body: elseBody,
    phis: [{ then_val: thenVal.id, else_val: elseVal.id }],
  });
}

/**
 * Run `fn` with `ctx.ops` swapped to a fresh array, capturing whatever ops
 * `fn` emits during its execution. Restore the previous `ctx.ops` and
 * return the captured array.
 *
 * Replaces the save-ops / lower-body / restore-ops idiom that every
 * region-introducing lowering function in all three lowerers used to
 * inline:
 *
 *   const savedOps = ctx.ops;
 *   ctx.ops = [];
 *   for (const s of body) lowerStmt(ctx, s);
 *   const bodyOps = ctx.ops;
 *   ctx.ops = savedOps;
 *
 * Becomes:
 *
 *   const bodyOps = captureOps(ctx, () => {
 *     for (const s of body) lowerStmt(ctx, s);
 *   });
 *
 * Restores `ctx.ops` even if `fn` throws, so partial errors don't leave
 * the lowerer with a stale ops array referencing a half-built region.
 */
function captureOps(ctx, fn) {
  const saved = ctx.ops;
  ctx.ops = [];
  try {
    fn();
    return ctx.ops;
  } finally {
    ctx.ops = saved;
  }
}

/**
 * Lower an `if` / `else` construct into AIR. Frontend-agnostic — picks up
 * the truthy-coercion via `ctx.truthy()` so each language's bool-coercion
 * semantics fold in. Frontend wrapper is just AST-shape adaptation:
 *
 *   function lowerIf(ctx, node) {        // adder
 *     return lowerIfRegion(ctx,
 *       () => lowerExpr_ad(ctx, node.test),
 *       () => { for (const s of node.body) lowerStmt_ad(ctx, s); },
 *       () => { if (node.orelse) for (const s of node.orelse) lowerStmt_ad(ctx, s); },
 *       ctx.loc(node));
 *   }
 *
 * Frontends that need extra phi-tracking, special else-if folding, or
 * other quirks keep their own inline lowerIf — the helper is opt-in.
 */
function lowerIfRegion(ctx, condFn, thenFn, elseFn, loc) {
  const condValue = condFn();
  const cond = ctx.truthy(condValue, loc);
  const thenBody = captureOps(ctx, thenFn);
  const elseBody = captureOps(ctx, elseFn);
  return ctx.emit('if_region', [cond.id], VOID, loc, {
    then_body: thenBody, else_body: elseBody, phis: [],
  });
}

/**
 * Lower a `while`-style loop region. `kind` matches AIR's loop_region
 * extras (`'while'` | `'do_while'` | …) so the emitter picks the right
 * JS construct.
 *
 *   function lowerWhile(ctx, node) {     // soft
 *     return lowerLoopRegion(ctx,
 *       () => lowerExpr_sf(ctx, node.cond),
 *       () => { for (const s of node.body) lowerStmt_sf(ctx, s); },
 *       ctx.loc(node), 'while');
 *   }
 */
function lowerLoopRegion(ctx, condFn, bodyFn, loc, kind = 'while') {
  let truthy = null;
  const testOps = captureOps(ctx, () => {
    truthy = ctx.truthy(condFn(), loc);
  });
  const body = captureOps(ctx, bodyFn);
  return ctx.emit('loop_region', [], VOID, loc, {
    test: testOps,
    test_val: truthy.id,
    body,
    phis: [],
    loop_kind: kind,
  });
}

export {
  BaseLowerCtx, mkOp, makeIdGen, captureOps, emitPhiSelect, AirLowerError,
  lowerIfRegion, lowerLoopRegion,
};
