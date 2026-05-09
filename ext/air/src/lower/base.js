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

import { DYNAMIC } from '../types.js';
import { ScopeChain } from '../scope.js';

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
}

export { BaseLowerCtx, mkOp, makeIdGen };
