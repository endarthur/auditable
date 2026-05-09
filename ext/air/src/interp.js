// @gcu/air — AIR interpreter (tree-walker, v0)
//
// Walks AIR ops directly without going through emit-js + new Function().
// Use cases:
//   - Sanity-check the JS emitter (run cells through both, compare results)
//   - Foundation for a step debugger (pause at any op, inspect SSA values)
//   - CSP-locked browser builds (no eval, no Function constructor)
//   - Reference for AIR op semantics
//
// v0 scope:
//   - JS cells lowered via lower/js.js (pure JS host, no _py/_soft runtime)
//   - All standard control flow: if/for/while/loop/switch/try/labeled
//   - Functions, closures, classes (basic — no instance fields)
//   - Async/await: every execOp is async, so awaits chain naturally
//   - Schema-driven dispatch via the same OP_SCHEMA the validator uses
//
// v0 NOT supported:
//   - opaque ops (CSP-friendly mode default; throws AirInterpError)
//   - yield / yield_delegate (generators)
//   - Class instance fields
//   - Adder/Soft runtime (_py/_soft) — JS frontend only
//
// Known divergence from emit-js:
//   - logical_and / logical_or / nullish_coalesce: JS lowerer emits these
//     as flat ops with both operands eagerly evaluated. emit-js relies on
//     ctx.exprs inlining to recover JS short-circuit semantics; the
//     interpreter executes ops in declaration order, so the RHS runs even
//     when LHS short-circuits the result. Pure RHS works fine; impure RHS
//     (side-effecting calls inside `&&`/`||`) diverges. Fix is a JS-lowerer
//     refactor to use phi-select for logical ops, matching adder/soft —
//     deferred.
//
// Performance: ~50× slower than emit-js. Acceptable for tooling; not a
// production execution path.

import { ScopeChain } from './scope.js';
import { forEachRegion } from './schema.js';

class AirInterpError extends Error {
  constructor(message) { super(message); this.name = 'AirInterpError'; }
}

// Control-flow signals used to bubble up break / continue / return / throw
// without allocating exception traces. Plain classes so caller can
// instanceof-check.
class _ReturnSignal { constructor(value) { this.value = value; } }
class _BreakSignal { constructor(label) { this.label = label; } }
class _ContinueSignal { constructor(label) { this.label = label; } }

// Marker for a spread arg in array_new / call — wraps an iterable value
// that consumer ops should expand into their argument list.
class _SpreadValue { constructor(iter) { this.iter = iter; } }

const _TA_CTORS = {
  i8: Int8Array, u8: Uint8Array, i16: Int16Array, u16: Uint16Array,
  i32: Int32Array, u32: Uint32Array, f32: Float32Array, f64: Float64Array,
  i64: BigInt64Array, u64: BigUint64Array,
};

// Expand spread markers in an args array
function _expandArgs(values) {
  const out = [];
  for (const v of values) {
    if (v instanceof _SpreadValue) {
      for (const item of v.iter) out.push(item);
    } else {
      out.push(v);
    }
  }
  return out;
}

class Interpreter {
  /**
   * @param {object} module - AIR module (output of lowerJS + runPasses)
   * @param {object} [options]
   * @param {object} [options.scope] - upstream cell-scope values (name → value)
   * @param {object} [options.globals] - ambient globals (Math, console, etc.)
   * @param {boolean} [options.allowOpaque] - if true, eval() opaque ops
   *   (defeats CSP-friendliness; only enable in trusted-script contexts)
   */
  constructor(module, options = {}) {
    this.module = module;
    // SSA id → JS value
    this.values = new Map();
    // Lexical scope: name → value
    this.scope = new ScopeChain();
    // Ambient host globals
    this.globals = options.globals || _defaultGlobals();
    this.allowOpaque = !!options.allowOpaque;

    // Seed scope with input bindings (cell imports)
    for (const [k, v] of Object.entries(options.scope || {})) {
      this.scope.set(k, v);
    }

    // Pre-compute slot SSA-id → variable-name mapping. Slot ops use the
    // slot_alloc's SSA id as their args[0]; the actual variable name is
    // in slot_alloc's args[0]. emit-js keeps this mapping in ctx.exprs;
    // the interpreter precomputes it so closures (which capture lexical
    // scope, not per-invocation SSA values) can resolve slot names.
    this.slotNames = new Map();
    this._collectSlotNames(module.ops);
  }

  _collectSlotNames(ops) {
    for (const op of ops) {
      if (op.op === 'slot_alloc' && op.id) {
        this.slotNames.set(op.id, op.args[0]);
      }
      forEachRegion(op, (_n, rops) => this._collectSlotNames(rops));
    }
  }

  async run() {
    return await this.execOps(this.module.ops);
  }

  /**
   * Execute a sequence of ops, returning the last value. Records each
   * op's result in `this.values` for downstream `ref()` lookups.
   */
  async execOps(ops) {
    let last;
    for (const op of ops) {
      const v = await this.execOp(op);
      if (op.id) this.values.set(op.id, v);
      last = v;
    }
    return last;
  }

  // SSA id → value lookup
  ref(id) {
    if (id == null) return undefined;
    return this.values.get(id);
  }

  async execOp(op) {
    const args = op.args;
    switch (op.op) {
      // ── Constants & loads ────────────────────────────────────────────
      case 'const': return args[0];
      case 'null':  return null;
      case 'load': {
        const name = args[0];
        if (this.scope.has(name)) return this.scope.get(name);
        if (Object.prototype.hasOwnProperty.call(this.globals, name)) return this.globals[name];
        // Fall through to ambient JS globals (Math, JSON, etc.)
        if (typeof globalThis !== 'undefined' && name in globalThis) return globalThis[name];
        return undefined;
      }
      case 'store': {
        // Reassign the existing binding wherever it lives in the chain,
        // or declare a new binding in the current frame. Mirrors emit-js's
        // "let X = …" (first sight) vs "X = …" (already in scope) split.
        this.scope.setOrExisting(args[0], this.ref(args[1]));
        return undefined;
      }
      case 'meta': {
        // import.meta.X / new.target — best-effort; tests rarely hit
        const root = (typeof globalThis !== 'undefined' && globalThis[args[0]]) || {};
        return root[args[1]];
      }

      // ── Slot allocation (closure cells for mutable captures) ─────────
      // emit-js renders these as bare `let name;` — a regular JS variable
      // closures naturally capture. We mirror that: slots are scope
      // bindings keyed by name. The slot_alloc op's args[0] IS the name;
      // slot_load/slot_store receive the slot_alloc's SSA id (not a name)
      // and we resolve via the precomputed slotNames map.
      case 'slot_alloc': {
        this.scope.set(args[0], undefined);
        return args[0];  // op's value is the variable name
      }
      case 'slot_load': {
        const name = this.slotNames.get(args[0]);
        return name != null ? this.scope.get(name) : undefined;
      }
      case 'slot_store': {
        const name = this.slotNames.get(args[0]);
        if (name != null) {
          // setOrExisting walks up to update the binding wherever it
          // was declared (outer scope where slot_alloc happened), so
          // closures' mutations are visible to the outer scope.
          this.scope.setOrExisting(name, this.ref(args[1]));
        }
        return undefined;
      }

      // ── Arithmetic ───────────────────────────────────────────────────
      case 'add': return this.ref(args[0]) + this.ref(args[1]);
      case 'sub': return this.ref(args[0]) - this.ref(args[1]);
      case 'mul': return this.ref(args[0]) * this.ref(args[1]);
      case 'div': return this.ref(args[0]) / this.ref(args[1]);
      case 'mod': return this.ref(args[0]) % this.ref(args[1]);
      case 'exp': return this.ref(args[0]) ** this.ref(args[1]);
      case 'neg': return -this.ref(args[0]);
      case 'unary_plus': return +this.ref(args[0]);

      // ── Comparison ───────────────────────────────────────────────────
      case 'eq':  return this.ref(args[0]) === this.ref(args[1]);
      case 'neq': return this.ref(args[0]) !== this.ref(args[1]);
      case 'lt':  return this.ref(args[0]) <  this.ref(args[1]);
      case 'lte': return this.ref(args[0]) <= this.ref(args[1]);
      case 'gt':  return this.ref(args[0]) >  this.ref(args[1]);
      case 'gte': return this.ref(args[0]) >= this.ref(args[1]);
      case 'in':         return this.ref(args[0]) in this.ref(args[1]);
      case 'instanceof': return this.ref(args[0]) instanceof this.ref(args[1]);

      // ── Bitwise ──────────────────────────────────────────────────────
      case 'bitwise_or':   return this.ref(args[0])  | this.ref(args[1]);
      case 'bitwise_and':  return this.ref(args[0])  & this.ref(args[1]);
      case 'bitwise_xor':  return this.ref(args[0])  ^ this.ref(args[1]);
      case 'shift_left':   return this.ref(args[0]) << this.ref(args[1]);
      case 'shift_right':  return this.ref(args[0]) >> this.ref(args[1]);
      case 'ushift_right': return this.ref(args[0]) >>> this.ref(args[1]);
      case 'bitwise_not':  return ~this.ref(args[0]);

      // ── Logical (see top-of-file note about short-circuit divergence) ─
      case 'logical_and':       return this.ref(args[0]) && this.ref(args[1]);
      case 'logical_or':        return this.ref(args[0]) || this.ref(args[1]);
      case 'nullish_coalesce':  return this.ref(args[0]) ?? this.ref(args[1]);
      case 'logical_not':       return !this.ref(args[0]);

      // ── Unary ────────────────────────────────────────────────────────
      case 'typeof': return typeof this.ref(args[0]);
      case 'void':   return void this.ref(args[0]);
      case 'delete': return true;  // best-effort; rarely meaningful in cells

      // ── Member access ────────────────────────────────────────────────
      case 'object_get': {
        const obj = this.ref(args[0]);
        if (op.optional && (obj == null)) return undefined;
        return obj?.[args[1]];
      }
      case 'object_set': {
        const obj = this.ref(args[0]);
        obj[args[1]] = this.ref(args[2]);
        return undefined;
      }
      case 'array_get': {
        const obj = this.ref(args[0]);
        const idx = this.ref(args[1]);
        if (op.optional && (obj == null)) return undefined;
        return obj?.[idx];
      }
      case 'array_set': {
        const obj = this.ref(args[0]);
        const idx = this.ref(args[1]);
        obj[idx] = this.ref(args[2]);
        return undefined;
      }

      // ── Construction ─────────────────────────────────────────────────
      case 'array_new': {
        const elements = args.map(id => this.ref(id));
        return _expandArgs(elements);
      }
      case 'object_new': {
        const obj = {};
        for (const pair of args) {
          if (pair && pair.spread) Object.assign(obj, this.ref(pair.id));
          else if (pair) obj[pair.key] = this.ref(pair.id);
        }
        return obj;
      }
      case 'ta_new': {
        const ctor = _TA_CTORS[args[0]];
        if (!ctor) throw new AirInterpError(`unknown typed-array kind: ${args[0]}`);
        const ctorArgs = _expandArgs(args.slice(1).map(id => this.ref(id)));
        return new ctor(...ctorArgs);
      }
      case 'new': {
        const ctor = this.ref(args[0]);
        const ctorArgs = _expandArgs(args.slice(1).map(id => this.ref(id)));
        return new ctor(...ctorArgs);
      }

      // ── Calls ────────────────────────────────────────────────────────
      case 'call': {
        const fn = this.ref(args[0]);
        if (typeof fn !== 'function') {
          throw new TypeError(`interp: callee is not a function (got ${typeof fn})`);
        }
        const callArgs = _expandArgs(args.slice(1).map(id => this.ref(id)));
        return await fn(...callArgs);
      }
      case 'call_method': {
        const obj = this.ref(args[0]);
        const method = args[1];
        const callArgs = _expandArgs(args.slice(2).map(id => this.ref(id)));
        if (op.optional && (obj == null)) return undefined;
        const fn = obj[method];
        if (typeof fn !== 'function') {
          throw new TypeError(`interp: ${method} is not a method of ${typeof obj}`);
        }
        return await fn.apply(obj, callArgs);
      }
      case 'await':  return await this.ref(args[0]);
      case 'spread': return new _SpreadValue(this.ref(args[0]));
      case 'import': return import(this.ref(args[0]));

      // ── Statements (control-flow signals) ─────────────────────────────
      case 'throw':    throw this.ref(args[0]);
      case 'debugger': return undefined;  // no-op
      case 'return':   throw new _ReturnSignal(args.length ? this.ref(args[0]) : undefined);
      case 'break':    throw new _BreakSignal(args[0] || null);
      case 'continue': throw new _ContinueSignal(args[0] || null);
      case 'yield':
      case 'yield_delegate':
        throw new AirInterpError('interp v0: yield/generators not supported');

      // ── Region ops ───────────────────────────────────────────────────
      case 'if_region': {
        const cond = this.ref(args[0]);
        const branch = cond ? op.then_body : op.else_body;
        if (branch && branch.length) await this.execOps(branch);
        // Phi: select value from the taken branch
        if (op.phis && op.phis.length) {
          const phi = op.phis[0];
          if (cond) return phi.then_val ? this.ref(phi.then_val) : undefined;
          return phi.else_val ? this.ref(phi.else_val) : undefined;
        }
        return undefined;
      }

      case 'for_region': {
        this.scope = this.scope.push();
        try {
          if (op.init) await this.execOps(op.init);
          while (true) {
            if (op.test) await this.execOps(op.test);
            const cond = op.test_val ? this.ref(op.test_val) : true;
            if (!cond) break;
            try {
              if (op.body) await this.execOps(op.body);
            } catch (e) {
              if (e instanceof _BreakSignal) return undefined;
              if (!(e instanceof _ContinueSignal)) throw e;
            }
            if (op.update) await this.execOps(op.update);
          }
          return undefined;
        } finally {
          this.scope = this.scope.pop();
        }
      }

      case 'for_of_region': {
        const iter = this.ref(args[0]);
        if (iter == null) return undefined;
        this.scope = this.scope.push();
        try {
          for (const item of iter) {
            if (op.target_name) this.scope.set(op.target_name, item);
            try {
              if (op.body) await this.execOps(op.body);
            } catch (e) {
              if (e instanceof _BreakSignal) return undefined;
              if (e instanceof _ContinueSignal) continue;
              throw e;
            }
          }
          return undefined;
        } finally {
          this.scope = this.scope.pop();
        }
      }

      case 'for_in_region': {
        const iter = this.ref(args[0]);
        if (iter == null) return undefined;
        this.scope = this.scope.push();
        try {
          for (const key in iter) {
            if (op.target_name) this.scope.set(op.target_name, key);
            try {
              if (op.body) await this.execOps(op.body);
            } catch (e) {
              if (e instanceof _BreakSignal) return undefined;
              if (e instanceof _ContinueSignal) continue;
              throw e;
            }
          }
          return undefined;
        } finally {
          this.scope = this.scope.pop();
        }
      }

      case 'loop_region': {
        const isDoWhile = op.loop_kind === 'do_while';
        this.scope = this.scope.push();
        try {
          while (true) {
            if (!isDoWhile) {
              if (op.test) await this.execOps(op.test);
              const cond = op.test_val ? this.ref(op.test_val) : true;
              if (!cond) break;
            }
            try {
              if (op.body) await this.execOps(op.body);
            } catch (e) {
              if (e instanceof _BreakSignal) return undefined;
              if (!(e instanceof _ContinueSignal)) throw e;
            }
            if (isDoWhile) {
              if (op.test) await this.execOps(op.test);
              const cond = op.test_val ? this.ref(op.test_val) : true;
              if (!cond) break;
            }
            if (op.update) await this.execOps(op.update);
          }
          return undefined;
        } finally {
          this.scope = this.scope.pop();
        }
      }

      case 'switch_region': {
        const disc = this.ref(args[0]);
        this.scope = this.scope.push();
        try {
          let matched = false;
          for (const c of op.cases || []) {
            if (!matched) {
              if (c.test_val == null) {
                matched = true;  // default
              } else {
                if (c.test_ops) await this.execOps(c.test_ops);
                if (disc === this.ref(c.test_val)) matched = true;
              }
            }
            if (matched) {
              try {
                if (c.body) await this.execOps(c.body);
              } catch (e) {
                if (e instanceof _BreakSignal) return undefined;
                throw e;
              }
            }
          }
          return undefined;
        } finally {
          this.scope = this.scope.pop();
        }
      }

      case 'try_region': {
        let caughtError = null;
        let caught = false;
        try {
          if (op.try_body) await this.execOps(op.try_body);
        } catch (e) {
          // Control-flow signals propagate through (after finally runs)
          if (e instanceof _ReturnSignal || e instanceof _BreakSignal ||
              e instanceof _ContinueSignal) {
            if (op.finally_body) await this.execOps(op.finally_body);
            throw e;
          }
          caughtError = e;
          caught = true;
        }
        if (caught && op.catch_body) {
          this.scope = this.scope.push();
          if (op.catch_param) this.scope.set(op.catch_param, caughtError);
          try {
            await this.execOps(op.catch_body);
          } catch (e2) {
            if (op.finally_body) await this.execOps(op.finally_body);
            throw e2;
          } finally {
            this.scope = this.scope.pop();
          }
        } else if (caught) {
          // No catch — rethrow after finally
          if (op.finally_body) await this.execOps(op.finally_body);
          throw caughtError;
        }
        if (op.finally_body) await this.execOps(op.finally_body);
        return undefined;
      }

      case 'labeled': {
        const label = args[0];
        try {
          if (op.body) await this.execOps(op.body);
        } catch (e) {
          if (e instanceof _BreakSignal && e.label === label) return undefined;
          if (e instanceof _ContinueSignal && e.label === label) return undefined;
          throw e;
        }
        return undefined;
      }

      case 'func_region': {
        const params = op.params || [];
        const body = op.body || [];
        const capturedScope = this.scope;
        const interp = this;
        // `function` (not arrow) so `this` binds to the JS receiver at
        // call time. Methods invoked via call_method get the correct
        // `obj` here; constructors via `new` get the new instance;
        // free calls get undefined (strict mode). NOTE: arrow functions
        // SHOULD inherit `this` from the lexical scope, but the IR
        // doesn't currently distinguish arrow vs declaration via
        // is_arrow. v0 limitation; arrows that reference `this` in
        // their body will see the call-site receiver instead.
        const fn = async function fn(...callArgs) {
          // Each invocation needs its own SSA-value frame: ssa ids are
          // module-global in the IR, but the same body's ops are
          // re-entered across recursive calls. Without this, fib(10)'s
          // %5 would be clobbered by fib(9)'s %5 and recursion returns
          // the wrong value.
          const savedScope = interp.scope;
          const savedValues = interp.values;
          interp.scope = capturedScope.push();
          interp.values = new Map();
          // Bind `this` from the JS receiver. Methods on prototypes get
          // the right `this` because call_method does fn.apply(obj, args).
          interp.scope.set('this', this);
          // Bind parameters
          for (let i = 0; i < params.length; i++) {
            const p = params[i];
            const name = (typeof p === 'string') ? p : p?.name;
            if (name && name.startsWith('...')) {
              interp.scope.set(name.slice(3), callArgs.slice(i));
              break;
            }
            if (name) interp.scope.set(name, callArgs[i]);
          }
          try {
            await interp.execOps(body);
            return undefined;
          } catch (e) {
            if (e instanceof _ReturnSignal) return e.value;
            throw e;
          } finally {
            interp.scope = savedScope;
            interp.values = savedValues;
          }
        };
        // Function declaration form: also store in current scope by name
        if (op.is_decl && op.name) this.scope.set(op.name, fn);
        return fn;
      }

      case 'class_region': {
        const name = op.name || null;
        const superClass = op.super_class ? this.ref(op.super_class)
                         : op.superclass  ? this.ref(op.superclass)
                         : null;
        const cls = superClass ? class extends superClass {} : class {};
        if (name) Object.defineProperty(cls, 'name', { value: name });

        for (const m of (op.members || [])) {
          const target = m.static ? cls : cls.prototype;
          const key = m.computedKeyId ? this.ref(m.computedKeyId) : m.key;
          if (m.kind === 'method' || m.kind === 'constructor') {
            const fn = this.ref(m.value);
            target[key] = fn;
          } else if (m.kind === 'get' || m.kind === 'set') {
            const fn = this.ref(m.value);
            const desc = Object.getOwnPropertyDescriptor(target, key) ||
                         { configurable: true, enumerable: false };
            if (m.kind === 'get') desc.get = fn;
            else desc.set = fn;
            Object.defineProperty(target, key, desc);
          } else if (m.kind === 'field') {
            // Static field: assign now. Instance fields would need
            // constructor wrapping — deferred.
            if (m.static) cls[key] = m.value ? this.ref(m.value) : undefined;
          }
        }
        if (name) this.scope.set(name, cls);
        return cls;
      }

      // ── Special / opaque ─────────────────────────────────────────────
      case 'opaque': {
        if (this.allowOpaque) {
          // Eval the source string in the current scope. Defeats CSP-friendliness;
          // only enabled when caller opts in. Used for tooling that wants to
          // run arbitrary cells outside the JS emit path.
          const src = String(args[0] || '');
          // eslint-disable-next-line no-eval
          return (0, eval)(src);
        }
        throw new AirInterpError(
          `opaque op encountered (CSP-friendly mode); enable options.allowOpaque to eval. source: ${
            String(args[0] || '').slice(0, 60)}`
        );
      }

      default:
        throw new AirInterpError(`unknown op '${op.op}'`);
    }
  }
}

/**
 * Convenience: create an interpreter, run, return result.
 */
async function interpret(module, options) {
  return new Interpreter(module, options).run();
}

// Default ambient globals — common JS host names that cells reference.
function _defaultGlobals() {
  const g = {};
  if (typeof globalThis === 'undefined') return g;
  // Just a permissive default — interpreter falls through to globalThis
  // anyway in `load`. This is more for the explicit override.
  return g;
}

export {
  Interpreter,
  interpret,
  AirInterpError,
};
