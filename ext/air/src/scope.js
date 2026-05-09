// @gcu/air — ScopeChain (v0.3 §3.3)
//
// Single shared lexical-scope abstraction for everything in AIR that
// tracks names → values across nested scopes. Today three places do
// this independently:
//
//   1. lower/js.js findMutableCaptured — closure-detection scope walker
//      using a `scopes` array of Sets directly.
//   2. emit-js.js Scope — `let` declaration tracker (Set-of-names with
//      a parent pointer).
//   3. lower/js.js ctx.symbols — flat Map<name, ssaId>. Doesn't pop at
//      scope exit, leading to silent type-prop wrongness when an inner
//      scope shadows an outer name (the spec's §2.3 latent bug).
//
// This class is the abstraction the first two migrate to in v0.3. The
// ctx.symbols migration is its own session — adding push/pop semantics
// to a previously-flat lookup is a real behavior change, not a rename.
//
// Design: name → any value (ssa id, boolean, type, …). Each layer is a
// Map so a name can be set to falsy values (null, 0, false). `has`
// distinguishes "name exists with value undefined" from "name not bound".

class ScopeChain {
  /**
   * @param {ScopeChain | null} parent
   */
  constructor(parent = null) {
    this.parent = parent;
    this.bindings = new Map();
  }

  /**
   * Bind a name in THIS scope (does not propagate up).
   */
  set(name, value) {
    this.bindings.set(name, value);
    return this;
  }

  /**
   * Look up a name. Returns the binding from the innermost scope where
   * it exists, or undefined if unbound at every level.
   */
  get(name) {
    if (this.bindings.has(name)) return this.bindings.get(name);
    return this.parent ? this.parent.get(name) : undefined;
  }

  /**
   * True if the name is bound at this scope or any enclosing scope.
   */
  has(name) {
    if (this.bindings.has(name)) return true;
    return this.parent ? this.parent.has(name) : false;
  }

  /**
   * True if the name is bound in any enclosing scope, but NOT in this
   * scope. Used by closure-detection: "is this name visible from outer
   * lexical context, such that an assignment captures it?"
   */
  hasInOuter(name) {
    return this.parent ? this.parent.has(name) : false;
  }

  /**
   * Remove a binding. Walks up the chain and deletes from the innermost
   * scope where the name is bound. Returns true if a binding was removed,
   * false if the name wasn't bound anywhere visible.
   *
   * Used by emit-js's `ctx.exprs` consume semantics — when a single-use
   * SSA value is inlined at its consumer, the entry is deleted from
   * whichever frame registered it.
   */
  delete(name) {
    if (this.bindings.has(name)) { this.bindings.delete(name); return true; }
    return this.parent ? this.parent.delete(name) : false;
  }

  /**
   * Return a new child scope with `this` as parent. Caller is responsible
   * for assigning the result somewhere — e.g. `chain = chain.push()`.
   */
  push() {
    return new ScopeChain(this);
  }

  /**
   * Return the parent scope, dropping `this`. Throws if at root.
   */
  pop() {
    if (!this.parent) {
      throw new Error('ScopeChain: cannot pop the root scope');
    }
    return this.parent;
  }

  /**
   * Snapshot every binding visible from this scope, with the innermost
   * value winning for shadowed names. Useful for debugging and for
   * code that needs a flat Map (legacy callers like lower/js.js's
   * `symbol_table: new Map(ctx.symbols)` snapshot).
   */
  flatten() {
    const out = new Map();
    // Walk from root → leaf so inner shadows the outer naturally
    const chain = [];
    for (let s = this; s; s = s.parent) chain.push(s);
    for (let i = chain.length - 1; i >= 0; i--) {
      for (const [k, v] of chain[i].bindings) out.set(k, v);
    }
    return out;
  }

  /**
   * Iterate every binding visible from this scope (innermost wins).
   * Yields [name, value] pairs.
   */
  *entries() {
    yield* this.flatten();
  }

  /**
   * Depth from root. Root is 0, first child is 1, etc.
   */
  depth() {
    let d = 0;
    for (let s = this.parent; s; s = s.parent) d++;
    return d;
  }
}

export { ScopeChain };
