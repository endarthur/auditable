// @gcu/air — JS emitter (Phase 2)
// Spec §9: AIR → optimized JavaScript
// Walks AIR ops and produces V8-friendly JS with type hints.

import { isDynamic, isNumeric, isInteger, isFloat, isConcrete } from './types.js';
import { forEachSsaRef, forEachRegion, canBeAsync } from './schema.js';
import { ScopeChain } from './scope.js';

// =============================================================================
// Async detection
// =============================================================================

export function needsAsync(module) {
  // Schema-derived. canBeAsync(op) consults OP_SCHEMA's `can_be_async`
  // flag; forEachRegion walks every region (incl. try/catch/finally,
  // switch cases, class members) — the legacy walker missed those, so
  // a try-block containing `await` in catch could compile under a sync
  // wrapper and fail at runtime. Conservative on call/call_method/new
  // matches the legacy intent: anything that calls user code may load/
  // install/fetch and want awaiting.
  function check(ops) {
    for (const op of ops) {
      if (canBeAsync(op)) return true;
      let found = false;
      forEachRegion(op, (_name, rops) => { if (!found && check(rops)) found = true; });
      if (found) return true;
    }
    return false;
  }
  return check(module.ops);
}

// =============================================================================
// Use counting — determines which SSA values become let bindings vs inline
// =============================================================================

// Schema-derived. The bespoke 50-line walker this replaces had to
// re-implement op-by-op knowledge of where SSA refs live (object_new pair
// records, switch case test_vals, phi then_val/else_val, class member
// computed keys, etc.). The schema's `forEachSsaRef` knows all that;
// `forEachRegion` handles every region/synthetic-region traversal. Adding
// a new op type is one schema row; this walker picks it up automatically.
function countUses(ops, counts) {
  for (const op of ops) {
    forEachSsaRef(op, (id) => {
      counts.set(id, (counts.get(id) || 0) + 1);
    });
    forEachRegion(op, (_name, rops) => countUses(rops, counts));
  }
}

// =============================================================================
// Emit context
// =============================================================================

// Lexical scope for emitted name bindings. Each block-introducing emit
// (for/for-of/for-in/while/do-while/if/switch/try/labeled-block/function)
// pushes a fresh scope around its body; on exit, every name declared
// inside falls out of scope so a sibling region can re-`let` the same
// name. The cell's top-level (root) scope is not popped — exports live
// there and their `let` only needs to be emitted once.
//
// Backed by ScopeChain (v0.3 §3.3) — same shape, shared with lower/js.js
// findMutableCaptured.
class Scope {
  constructor(parent) {
    this._chain = parent ? parent._chain.push() : new ScopeChain();
    this.parent = parent;
  }
  has(name) {
    return this._chain.has(name);
  }
  declare(name) {
    this._chain.set(name, true);
  }
}

class EmitCtx {
  constructor(module, options) {
    this.module = module;
    this.hinted = options.hinted ?? true;
    this.cellId = options.cellId || '?';
    this.cellName = options.cellName || '';

    // Count uses of each SSA name
    this.useCounts = new Map();
    countUses(module.ops, this.useCounts);

    // SSA id → expression string (for inlining single-use values).
    //
    // Backed by ScopeChain (v0.3 §3.3): each region body pushes a fresh
    // frame, popped on exit. Single-use values registered inside a region
    // body are consumed within that region; cross-region reference would
    // resolve to a region-local `_N` JS binding and be a runtime error,
    // so the pop-time invariant warns under dev validator (see popScope).
    this.exprs = new ScopeChain();

    // SSA id → type
    this.types = new Map();

    // Tracks which multi-use SSA ids have been emitted as `let _N = …`
    // bindings. SSA ids are unique across the whole module so this set
    // is module-global — no scoping. Distinct from `scope.declared`
    // which tracks user-named bindings (i, raf, fy, etc).
    this.emitted = new Set();

    // Current lexical scope for named bindings.
    this.scope = new Scope(null);

    this.lines = [];
    this.indent = 0;

    // Loop-context stack for `continue` rewriting. Each entry is either:
    //   - a string label: `continue` should emit `break <label>;` (used by
    //     the for-loop fallback path where update must run before re-check)
    //   - null: `continue` should emit plain `continue;` (native JS loops
    //     handle continue correctly: while/do-while/for-in/for-of, plus
    //     the compact for-loop path)
    // pushLoop/popLoop are called by each loop emitter when entering and
    // leaving its body. The top of the stack is consulted by the 'continue'
    // case in emitOps.
    this.loopStack = [];
    this._forLabelCount = 0;
  }

  line(s) { this.lines.push('  '.repeat(this.indent) + s); }
  push() { this.indent++; }
  pop() { this.indent--; }

  pushLoop(contLabel) { this.loopStack.push(contLabel); }
  popLoop() { this.loopStack.pop(); }
  currentLoopCont() {
    return this.loopStack.length > 0
      ? this.loopStack[this.loopStack.length - 1]
      : null;
  }
  freshForLabel() { return `_forCont${++this._forLabelCount}`; }

  pushScope() {
    this.scope = new Scope(this.scope);
    this.exprs = this.exprs.push();
  }
  popScope() {
    if (!this.scope.parent) throw new Error('popScope: already at root');
    // Invariant: every entry in the popped frame should be consumed
    // (single-use, deleted by ref) or dead (countUses === 0). An
    // unconsumed live entry means the lowerer placed a use cross-region;
    // ref() outside this region would fall through to `_N` referring to
    // a never-emitted binding. We could throw, but that would block
    // lowering progress; instead warn under dev validator and best-effort
    // leave the entry visible to the parent frame so the consumer at
    // least gets the inline expression (not necessarily correctly scoped).
    if (typeof window !== 'undefined' && window._airValidate) {
      for (const [id, expr] of this.exprs.bindings) {
        const uses = this.useCounts.get(id) || 0;
        if (uses > 0) {
          console.warn(
            `[AIR] emit-js consume invariant: ${id} (uses=${uses}) unconsumed at scope pop. expr: ${String(expr).slice(0, 80)}`
          );
        }
      }
    }
    // Promote unconsumed live entries to the parent frame. This is the
    // best-effort recovery: the inline expression text references things
    // that may have been block-scoped, but at least ref() won't return a
    // stale `_N` for a never-emitted binding.
    for (const [id, expr] of this.exprs.bindings) {
      if (this.useCounts.get(id) > 0) this.exprs.parent.set(id, expr);
    }
    this.scope = this.scope.parent;
    this.exprs = this.exprs.pop();
  }

  // Resolve an SSA ref to an expression string.
  // Single-use values are inlined; multi-use values are variable names.
  ref(id) {
    if (!id) return 'undefined';
    if (typeof id !== 'string' || !id.startsWith('%')) return String(id);
    if (this.exprs.has(id)) {
      const uses = this.useCounts.get(id) || 0;
      if (uses <= 1) {
        // Inline: consume the expression (chain-aware delete walks up to
        // wherever the binding was registered).
        const expr = this.exprs.get(id);
        this.exprs.delete(id);
        return expr;
      }
    }
    // Multi-use: must be a let binding, return the variable name
    return this.varName(id);
  }

  varName(id) {
    return '_' + id.slice(1); // %0 → _0
  }

  // Apply V8 type hints to an expression.
  // Wrap the whole result in parens so precedence survives when inlined
  // into an outer expression: `((a+b) | 0)` instead of `(a+b) | 0`.
  hintExpr(expr, type) {
    if (!this.hinted || !type || isDynamic(type)) return expr;
    if (type.kind === 'i32' || type.kind === 'u32') return `((${expr}) | 0)`;
    if (type.kind === 'f32') return `Math.fround(${expr})`;
    return expr;
  }

  // Emit initialization value for a type (V8 initialization discipline)
  initLiteral(type) {
    if (!type || isDynamic(type)) return null;
    if (type.kind === 'f64') return '0.0';
    if (type.kind === 'f32') return 'Math.fround(0)';
    if (type.kind === 'i32' || type.kind === 'u32') return '0';
    return null;
  }
}

// =============================================================================
// Main entry point
// =============================================================================

/**
 * Emit JavaScript code from an AIR module.
 * @param {object} module - AIR cell module (from lowerJS + runPasses)
 * @param {string[]} scopeKeys - upstream variable names (cell params)
 * @param {string[]} injectedNames - builtin names (ui, std, etc.)
 * @param {object} options - { hinted, cellId, cellName }
 * @returns {string} JS function body (to wrap in new Function/AsyncFunction)
 */
export function emitJS(module, scopeKeys, injectedNames, options = {}) {
  const ctx = new EmitCtx(module, options);

  ctx.line('"use strict";');

  emitOps(ctx, module.ops);

  // Return exports
  const exports = [...module.defines].sort();
  if (exports.length) {
    ctx.line(`return { ${exports.join(', ')} };`);
  }

  // Source URL
  const slug = ctx.cellName
    ? '-' + ctx.cellName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
    : '';
  ctx.line(`//# sourceURL=auditable://cell-${ctx.cellId}${slug}.js`);

  return ctx.lines.join('\n');
}

// =============================================================================
// Op emission
// =============================================================================

function emitOps(ctx, ops) {
  for (const op of ops) {
    emitOp(ctx, op);
  }
}

function emitOp(ctx, op) {
  switch (op.op) {
    case 'const': return emitConst(ctx, op);
    case 'null': return emitInline(ctx, op, 'null');
    case 'load': return emitLoad(ctx, op);
    case 'store': return emitStore(ctx, op);
    case 'slot_alloc': return emitSlotAlloc(ctx, op);
    case 'slot_load': return emitSlotLoad(ctx, op);
    case 'slot_store': return emitSlotStore(ctx, op);
    case 'add': case 'sub': case 'mul': case 'div': case 'mod': case 'exp':
      return emitBinary(ctx, op);
    case 'neg': return emitUnary(ctx, op, '-');
    case 'unary_plus': return emitUnary(ctx, op, '+');
    case 'logical_not': return emitUnary(ctx, op, '!');
    case 'bitwise_or': case 'bitwise_and': case 'bitwise_xor':
    case 'shift_left': case 'shift_right': case 'ushift_right':
      return emitBinary(ctx, op);
    case 'eq': case 'neq': case 'lt': case 'lte': case 'gt': case 'gte':
    case 'in': case 'instanceof':
      return emitBinary(ctx, op);
    case 'logical_and': case 'logical_or': case 'nullish_coalesce':
      return emitBinary(ctx, op);
    case 'object_get': return emitObjectGet(ctx, op);
    case 'object_set': return emitObjectSet(ctx, op);
    case 'array_get': return emitArrayGet(ctx, op);
    case 'array_set': return emitArraySet(ctx, op);
    case 'ta_new': return emitTaNew(ctx, op);
    case 'array_new': return emitArrayNew(ctx, op);
    case 'object_new': return emitObjectNew(ctx, op);
    case 'new': return emitNew(ctx, op);
    case 'call': return emitCall(ctx, op);
    case 'call_method': return emitCallMethod(ctx, op);
    case 'await': return emitAwait(ctx, op);
    case 'spread': return emitSpread(ctx, op);
    case 'typeof': return emitPrefixOp(ctx, op, 'typeof ');
    case 'void': return emitPrefixOp(ctx, op, 'void ');
    case 'delete': return emitPrefixOp(ctx, op, 'delete ');
    case 'bitwise_not': return emitUnary(ctx, op, '~');
    case 'import': return emitImport(ctx, op);
    case 'meta': register(ctx, op, `${op.args[0]}.${op.args[1]}`); return;
    case 'throw': { const v = ctx.ref(op.args[0]); ctx.line(`throw ${v};`); return; }
    case 'debugger': ctx.line('debugger;'); return;
    case 'return': return emitReturn(ctx, op);
    case 'break': ctx.line('break;'); return;
    case 'continue': {
      const lbl = ctx.currentLoopCont();
      ctx.line(lbl ? `break ${lbl};` : 'continue;');
      return;
    }
    case 'if_region': return emitIf(ctx, op);
    case 'for_region': return emitFor(ctx, op);
    case 'for_in_region': return emitForIn(ctx, op);
    case 'for_of_region': return emitForOf(ctx, op);
    case 'loop_region': return emitLoop(ctx, op);
    case 'switch_region': return emitSwitch(ctx, op);
    case 'try_region': return emitTry(ctx, op);
    case 'labeled': return emitLabeled(ctx, op);
    case 'func_region': return emitFunc(ctx, op);
    case 'class_region': return emitClass(ctx, op);
    case 'yield': {
      const v = op.args[0] ? ctx.ref(op.args[0]) : '';
      const expr = v ? `(yield ${v})` : '(yield)';
      const uses = ctx.useCounts.get(op.id) || 0;
      if (uses === 0) { ctx.line(`${expr};`); } else { register(ctx, op, expr); }
      return;
    }
    case 'yield_delegate': {
      const v = ctx.ref(op.args[0]);
      const uses = ctx.useCounts.get(op.id) || 0;
      if (uses === 0) { ctx.line(`(yield* ${v});`); } else { register(ctx, op, `(yield* ${v})`); }
      return;
    }
    case 'opaque': return emitOpaque(ctx, op);
    default: return;
  }
}

// --- Inline expression registration ---
// Some ops produce expressions that should be inlined into their consumer.
// We register them in ctx.exprs; when ref() is called, single-use values
// are inlined and multi-use values become let bindings.

const SIDE_EFFECTING = new Set([
  'call', 'call_method', 'await', 'new', 'import',
  'object_set', 'array_set', 'ta_set', 'delete',
]);

function register(ctx, op, expr) {
  const uses = ctx.useCounts.get(op.id) || 0;
  ctx.types.set(op.id, op.type);

  if (uses === 0) {
    if (SIDE_EFFECTING.has(op.op)) {
      // Side-effecting with zero uses: emit as statement
      ctx.line(`${expr};`);
    }
    // Non-side-effecting zero uses: dead value, skip
    ctx.exprs.set(op.id, expr);
    return;
  }

  if (uses === 1) {
    // Single use: inline — defer to ref() call
    ctx.exprs.set(op.id, expr);
    return;
  }

  // Multi-use: emit a let binding now
  ctx.line(`let ${ctx.varName(op.id)} = ${expr};`);
  ctx.emitted.add(op.id);
}

// --- Helpers: force-flush a value to a let binding if it hasn't been emitted ---

function flush(ctx, id) {
  if (!id || !id.startsWith('%')) return;
  if (ctx.emitted.has(id)) return;
  if (ctx.exprs.has(id)) {
    const expr = ctx.exprs.get(id);
    ctx.exprs.delete(id);
    ctx.line(`let ${ctx.varName(id)} = ${expr};`);
    ctx.emitted.add(id);
  }
}

// =============================================================================
// Op emitters
// =============================================================================

const OP_TO_JS = {
  'add': '+', 'sub': '-', 'mul': '*', 'div': '/', 'mod': '%', 'exp': '**',
  'eq': '===', 'neq': '!==', 'lt': '<', 'lte': '<=', 'gt': '>', 'gte': '>=',
  'in': 'in', 'instanceof': 'instanceof',
  'bitwise_or': '|', 'bitwise_and': '&', 'bitwise_xor': '^',
  'shift_left': '<<', 'shift_right': '>>', 'ushift_right': '>>>',
  'logical_and': '&&', 'logical_or': '||', 'nullish_coalesce': '??',
};

function emitConst(ctx, op) {
  const v = op.args[0];
  let expr;
  if (v === undefined) expr = 'undefined';
  else if (v === null) expr = 'null';
  else if (typeof v === 'string') expr = JSON.stringify(v);
  else if (typeof v === 'boolean') expr = String(v);
  else if (typeof v === 'number') {
    // V8 initialization discipline:
    // f64 zero → 0.0 (starts as Double, avoids Smi→Double transition)
    // f32 zero → Math.fround(0) (keeps f32 representation)
    // Everything else: plain number literal (V8 handles Smi fine)
    if (ctx.hinted && op.type?.kind === 'f64' && v === 0) expr = '0.0';
    else if (ctx.hinted && op.type?.kind === 'f64' && Number.isInteger(v)) expr = v + '.0';
    else if (ctx.hinted && op.type?.kind === 'f32' && v === 0) expr = 'Math.fround(0)';
    else expr = String(v);
  }
  else expr = String(v);
  register(ctx, op, expr);
}

function emitInline(ctx, op, expr) {
  register(ctx, op, expr);
}

function emitLoad(ctx, op) {
  const name = op.args[0];
  register(ctx, op, name);
}

function emitStore(ctx, op) {
  const name = op.args[0];
  const valId = op.args[1];
  const val = ctx.ref(valId);

  // First store of a name in the current scope chain emits a fresh
  // `let`; subsequent stores within the same scope emit a bare
  // assignment. Cell-export names (top-level defines) are stored in
  // the root scope and persist for the whole module — they get one
  // `let` and any further updates assign. Block-scoped names live in
  // an inner scope that's popped on exit, so siblings can re-`let`.
  if (ctx.scope.has(name)) {
    ctx.line(`${name} = ${val};`);
  } else {
    ctx.line(`let ${name} = ${val};`);
    ctx.scope.declare(name);
  }
}

function emitSlotAlloc(ctx, op) {
  const name = op.args[0];
  // Slots are mutable-captured variables — emit as let
  ctx.line(`let ${name};`);
  ctx.scope.declare(name);
  // Map the slot id so slot_load/slot_store can find the name
  ctx.exprs.set(op.id, name);
  ctx.types.set(op.id, op.type);
}

function emitSlotLoad(ctx, op) {
  const slotId = op.args[0];
  const name = ctx.exprs.get(slotId) || ctx.ref(slotId);
  register(ctx, op, name);
}

function emitSlotStore(ctx, op) {
  const slotId = op.args[0];
  const valId = op.args[1];
  const name = ctx.exprs.get(slotId) || ctx.ref(slotId);
  const val = ctx.ref(valId);
  ctx.line(`${name} = ${val};`);
}

function emitBinary(ctx, op) {
  const jsOp = OP_TO_JS[op.op];
  const lhs = ctx.ref(op.args[0]);
  const rhs = ctx.ref(op.args[1]);
  let expr = `(${lhs} ${jsOp} ${rhs})`;

  // V8 hints for typed results
  if (ctx.hinted && op.meta?.hint === 'typed') {
    expr = ctx.hintExpr(expr, op.type);
  }

  register(ctx, op, expr);
}

function emitUnary(ctx, op, jsOp) {
  const arg = ctx.ref(op.args[0]);
  register(ctx, op, `${jsOp}(${arg})`);
}

// Prefix keyword ops (typeof, void, delete) — parenthesized so
// member access on the result works: (typeof x).length, not typeof x.length
function emitPrefixOp(ctx, op, jsOp) {
  const arg = ctx.ref(op.args[0]);
  register(ctx, op, `(${jsOp}${arg})`);
}

function emitObjectGet(ctx, op) {
  const obj = ctx.ref(op.args[0]);
  const key = op.args[1]; // string key, not SSA ref
  const dot = op.optional ? '?.' : '.';
  register(ctx, op, `${obj}${dot}${key}`);
}

function emitObjectSet(ctx, op) {
  const obj = ctx.ref(op.args[0]);
  const key = op.args[1];
  const val = ctx.ref(op.args[2]);
  ctx.line(`${obj}.${key} = ${val};`);
}

function emitArrayGet(ctx, op) {
  const arr = ctx.ref(op.args[0]);
  const idx = ctx.ref(op.args[1]);
  // Only coerce the index to i32 when AIR has typed it as an integer.
  // Without the type guard, `obj[stringKey]` got wrapped as
  // `obj[(stringKey) | 0]` → `obj[0]` (since string|0 === 0), so any
  // dynamic property access with a string key silently returned undefined.
  const idxType = ctx.types.get(op.args[1]);
  const hintIdx = ctx.hinted && idxType && isInteger(idxType);
  const idxExpr = hintIdx ? `(${idx}) | 0` : idx;
  const bracket = op.optional ? '?.[' : '[';
  register(ctx, op, `${arr}${bracket}${idxExpr}]`);
}

function emitArraySet(ctx, op) {
  const arr = ctx.ref(op.args[0]);
  const idx = ctx.ref(op.args[1]);
  const val = ctx.ref(op.args[2]);
  ctx.line(`${arr}[${idx}] = ${val};`);
}

function emitTaNew(ctx, op) {
  const element = op.args[0]; // string: 'f64', 'i32', etc.
  const ctorMap = {
    'i8': 'Int8Array', 'u8': 'Uint8Array', 'i16': 'Int16Array', 'u16': 'Uint16Array',
    'i32': 'Int32Array', 'u32': 'Uint32Array', 'f32': 'Float32Array', 'f64': 'Float64Array',
    'i64': 'BigInt64Array', 'u64': 'BigUint64Array',
  };
  const ctor = ctorMap[element] || 'Float64Array';
  const args = op.args.slice(1).map(a => ctx.ref(a));
  register(ctx, op, `new ${ctor}(${args.join(', ')})`);
}

function emitArrayNew(ctx, op) {
  const elements = op.args.map(a => ctx.ref(a));
  register(ctx, op, `[${elements.join(', ')}]`);
}

function emitObjectNew(ctx, op) {
  const pairs = op.args; // array of { key, id } or { spread, id }
  const parts = pairs.map(p => {
    if (p.spread) return `...${ctx.ref(p.id)}`;
    return `${p.key}: ${ctx.ref(p.id)}`;
  });
  register(ctx, op, `{ ${parts.join(', ')} }`);
}

function emitCall(ctx, op) {
  let fn = ctx.ref(op.args[0]);
  // Wrap non-identifier fn expressions in parens so they call correctly:
  // `async () => {...}()` is invalid, `(async () => {...})()` is valid.
  if (!/^[$_a-zA-Z][\w$]*$/.test(fn) && !fn.startsWith('(')) {
    fn = `(${fn})`;
  }
  const args = op.args.slice(1).map(a => ctx.ref(a));
  const paren = op.optional ? '?.(' : '(';
  register(ctx, op, `${fn}${paren}${args.join(', ')})`);
}

function emitCallMethod(ctx, op) {
  const obj = ctx.ref(op.args[0]);
  const method = op.args[1]; // string
  const args = op.args.slice(2).map(a => ctx.ref(a));
  const dot = op.member_optional ? '?.' : '.';
  const paren = op.optional ? '?.(' : '(';
  register(ctx, op, `${obj}${dot}${method}${paren}${args.join(', ')})`);
}

function emitAwait(ctx, op) {
  const arg = ctx.ref(op.args[0]);
  // Parenthesize so member access on the result works correctly:
  // (await expr).prop, not await expr.prop
  register(ctx, op, `(await ${arg})`);
}

function emitSpread(ctx, op) {
  const arg = ctx.ref(op.args[0]);
  register(ctx, op, `...${arg}`);
}

function emitReturn(ctx, op) {
  const val = ctx.ref(op.args[0]);
  ctx.line(`return ${val};`);
}

// =============================================================================
// Regions
// =============================================================================

function emitIf(ctx, op) {
  const cond = ctx.ref(op.args[0]);
  const phi = op.phis && op.phis[0]; // expression-level if (ternary, bool op) has one phi
  let phiVar = null;
  if (phi) {
    // Declare phi variable before the if — value will be assigned in each branch
    phiVar = ctx.varName(op.id);
    ctx.line(`let ${phiVar};`);
  }
  ctx.line(`if (${cond}) {`);
  ctx.push();
  ctx.pushScope();
  if (op.then_body) emitOps(ctx, op.then_body);
  if (phi && phi.then_val) {
    const thenVal = ctx.ref(phi.then_val);
    ctx.line(`${phiVar} = ${thenVal};`);
  }
  ctx.popScope();
  ctx.pop();
  const hasElse = (op.else_body && op.else_body.length) || (phi && phi.else_val);
  if (hasElse) {
    ctx.line('} else {');
    ctx.push();
    ctx.pushScope();
    if (op.else_body) emitOps(ctx, op.else_body);
    if (phi && phi.else_val) {
      const elseVal = ctx.ref(phi.else_val);
      ctx.line(`${phiVar} = ${elseVal};`);
    }
    ctx.popScope();
    ctx.pop();
  }
  ctx.line('}');
  if (phi) {
    // Register phiVar as the expression for this op; mark as emitted
    ctx.exprs.set(op.id, phiVar);
    ctx.emitted.add(op.id);
    ctx.types.set(op.id, op.type);
  }
}

// Combine a sequence of single-statement lines into a comma-separated form
// suitable for a for-header init clause, e.g.
//   ['let i = 0;', 'let j = 0;'] -> 'let i = 0, j = 0'
// Returns null if the lines can't be safely combined (mixed declarators,
// non-trivial statements, multi-line expressions, etc.).
function combineForInit(lines) {
  if (lines.length === 0) return '';
  let kind = null;
  const parts = [];
  for (const line of lines) {
    const m = line.match(/^\s*(let|const|var)\s+(.+);\s*$/);
    if (!m) return null;
    if (kind === null) kind = m[1];
    else if (kind !== m[1]) return null;
    parts.push(m[2]);
  }
  return `${kind} ${parts.join(', ')}`;
}

// Combine simple assignment statements into a comma expression for the
// for-header update clause:
//   ['i = i + 1;', 'j = j + 4;'] -> 'i = i + 1, j = j + 4'
// Rejects anything that contains a declarator keyword or doesn't end with `;`.
function combineForUpdate(lines) {
  if (lines.length === 0) return '';
  const parts = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t.endsWith(';')) return null;
    if (/^(let|const|var)\b/.test(t)) return null;
    parts.push(t.slice(0, -1).trim());
  }
  return parts.join(', ');
}

function emitFor(ctx, op) {
  // The whole loop is its own scope: init declarations + body-level lets
  // fall out on exit so a sibling `for (let i …)` (or for-of over the
  // same name) later in the cell starts fresh.
  ctx.pushScope();
  try {
    const captureLines = (fn) => {
      const saved = ctx.lines;
      ctx.lines = [];
      fn();
      const out = ctx.lines;
      ctx.lines = saved;
      return out;
    };

    const initLines = op.init && op.init.length
      ? captureLines(() => emitOps(ctx, op.init)) : [];

    let testExpr = '';
    const testLines = captureLines(() => {
      if (op.test) emitOps(ctx, op.test);
      if (op.test_val) testExpr = ctx.ref(op.test_val);
    });

    const updateLines = op.update && op.update.length
      ? captureLines(() => emitOps(ctx, op.update)) : [];

    const initStr = combineForInit(initLines);
    const updateStr = combineForUpdate(updateLines);
    const compact = initStr !== null && updateStr !== null && testLines.length === 0;

    if (compact) {
      ctx.line(`for (${initStr}; ${testExpr}; ${updateStr}) {`);
      ctx.push();
      ctx.pushLoop(null);  // native for: `continue;` works correctly
      if (op.body) emitOps(ctx, op.body);
      ctx.popLoop();
      ctx.pop();
      ctx.line('}');
      return;
    }

    // Fallback: desugar to `{ init; while (true) { test; <labeled-block>;
    // update } }`. The labeled block around the body lets `continue` inside
    // the body emit `break <label>;` — which exits only the inner block,
    // allowing `update` to run before the next iteration. Without the
    // label, a `continue` would skip the update entirely (causing an
    // infinite loop if the rest of the body depends on the update advancing).
    // The outer `break;` still works as expected: it targets the innermost
    // *loop*, which is the surrounding `while (true)`, terminating the for.
    const contLabel = ctx.freshForLabel();
    ctx.line('{');
    ctx.push();
    for (const l of initLines) ctx.lines.push(l);
    ctx.line('while (true) {');
    ctx.push();
    for (const l of testLines) ctx.lines.push(l);
    if (testExpr) ctx.line(`if (!(${testExpr})) break;`);
    ctx.line(`${contLabel}: {`);
    ctx.push();
    ctx.pushLoop(contLabel);
    if (op.body) emitOps(ctx, op.body);
    ctx.popLoop();
    ctx.pop();
    ctx.line('}');
    for (const l of updateLines) ctx.lines.push(l);
    ctx.pop();
    ctx.line('}');
    ctx.pop();
    ctx.line('}');
  } finally {
    ctx.popScope();
  }
}

function emitForIn(ctx, op) {
  const iter = ctx.ref(op.args[0]);
  ctx.line(`for (const _k in ${iter}) {`);
  ctx.push();
  ctx.pushScope();
  ctx.pushLoop(null);
  if (op.body) emitOps(ctx, op.body);
  ctx.popLoop();
  ctx.popScope();
  ctx.pop();
  ctx.line('}');
}

function emitForOf(ctx, op) {
  const iter = ctx.ref(op.args[0]);
  const target = op.target_name || '_v';
  // Loop variable is scoped to this loop unless it's a cell-export
  // (adder/Soft Python-style loop-var leak); in that case the outer
  // root scope already declares it, so `scope.has()` returns true and
  // we emit `for (target of …)` (no `let`), letting the loop assign
  // to the cell-level binding so the value persists past the loop.
  ctx.pushScope();
  try {
    let kind;
    if (ctx.scope.has(target)) {
      kind = '';
    } else {
      kind = 'let ';
      ctx.scope.declare(target);
    }
    ctx.line(`for (${kind}${target} of ${iter}) {`);
    ctx.push();
    ctx.pushLoop(null);
    if (op.body) emitOps(ctx, op.body);
    ctx.popLoop();
    ctx.pop();
    ctx.line('}');
  } finally {
    ctx.popScope();
  }
}

function emitLoop(ctx, op) {
  if (op.loop_kind === 'do_while') {
    ctx.line('do {');
    ctx.push();
    ctx.pushScope();
    ctx.pushLoop(null);
    if (op.body) emitOps(ctx, op.body);
    ctx.popLoop();
    ctx.popScope();
    ctx.pop();
    if (op.test) emitOps(ctx, op.test);
    const testExpr = op.test_val ? ctx.ref(op.test_val) : 'true';
    ctx.line(`} while (${testExpr});`);
  } else {
    // while loop
    ctx.line('while (true) {');
    ctx.push();
    ctx.pushScope();
    ctx.pushLoop(null);
    if (op.test) emitOps(ctx, op.test);
    if (op.test_val) {
      const testExpr = ctx.ref(op.test_val);
      ctx.line(`if (!(${testExpr})) break;`);
    }
    if (op.body) emitOps(ctx, op.body);
    ctx.popLoop();
    ctx.popScope();
    ctx.pop();
    ctx.line('}');
  }
}

// Body-level await check — does this op list contain an EXPLICIT `await`
// op? Used to promote `function*` to `async function*` (JS rejects await
// inside a sync generator). Conservative: only triggers on explicit
// awaits, not on every `can_be_async` op (calls are can_be_async too, but
// the lowerer's syncFunctions analysis means many calls aren't actually
// awaited — over-promoting here would turn every fib/fact recursion into
// a Promise-returning function and break sync callers).
//
// Doesn't recurse into nested func/class regions — they manage their own
// async-ness.
function _bodyHasAwait(body) {
  if (!body || !body.length) return false;
  for (const op of body) {
    if (op.op === 'await') return true;
    if (op.op === 'func_region' || op.op === 'class_region') continue;
    let found = false;
    forEachRegion(op, (_n, rops) => { if (!found && _bodyHasAwait(rops)) found = true; });
    if (found) return true;
  }
  return false;
}

// Python-style function-local hoisting: any name `store`d anywhere in the
// body (including inside if-branches, loops, try/finally, etc.) becomes a
// function-local binding. Pre-declare them all at function scope so an
// in-region store emits a bare assignment, matching Python semantics
// where `if x: y = 1; return y` doesn't NameError on the `return y` path.
// Intentional limitation: a read on a path that never assigned the local
// returns undefined, whereas CPython raises UnboundLocalError. This only
// diverges on *buggy* code (correct Python never reads an unassigned local);
// the alternative — per-path assignment guards that throw — would defeat the
// whole point of hoisting (the perf win for `if/else assigns both branches`
// patterns like richards' runTask). So we accept the undefined read.
//
// Names already declared by an `opaque(_markDeclared=N)` prologue line
// (adder's param/varargs unpacking) are skipped — those will emit their
// own `let N = …;` declaration, and JS forbids redeclaration of let.
//
// Walk skips into nested func_region / class_region — those have their
// own scope and their own hoist pass when they emit.
function _hoistFunctionLocals(ctx, body) {
  if (!body || !body.length) return;
  const stored = new Set();
  const prologueDeclared = new Set();
  const walk = (ops) => {
    for (const op of ops) {
      if (op.op === 'store' && typeof op.args[0] === 'string') stored.add(op.args[0]);
      if (op.op === 'opaque' && op._markDeclared) prologueDeclared.add(op._markDeclared);
      if (op.op === 'func_region' || op.op === 'class_region') continue;
      forEachRegion(op, (_n, rops) => walk(rops));
    }
  };
  walk(body);
  for (const name of stored) {
    if (prologueDeclared.has(name)) continue;
    if (ctx.scope.has(name)) continue;
    ctx.line(`let ${name};`);
    ctx.scope.declare(name);
  }
}

function emitFunc(ctx, op) {
  // Method func_regions are emitted by emitClassMember, not here
  if (op.is_method) return;

  const name = op.name || '';
  const params = (op.params || []).map(p => p.name).join(', ');
  // Sync generator functions can't use `await` in their body — JS rejects
  // `function* foo() { … await x … }` as a syntax error and requires
  // `async function*` instead. The adder lowerer marks `def gen` as
  // is_generator without is_async, but the lowered body may still emit
  // `await tuple(...)` etc. from runtime-helper calls. Promote to async
  // whenever the body contains any can_be_async op (calls, awaits, etc.)
  // so generator-with-helper-calls compiles.
  const needsAsyncBody = !op.is_async && _bodyHasAwait(op.body);
  const asyncPrefix = (op.is_async || needsAsyncBody) ? 'async ' : '';
  const star = op.is_generator ? '*' : '';

  // Check if this function is stored to a top-level name
  // If so, emit as function declaration or const assignment
  const uses = ctx.useCounts.get(op.id) || 0;

  // Emit as a real `function name(...) {}` declaration whenever the
  // source had a FunctionDeclaration — the binding is hoisted to the
  // enclosing block in JS, and callers reference the name directly.
  // Cell-export functions (top-level FunctionDeclarations) were always
  // handled this way; this branch now also covers nested function decls.
  const emitAsDecl = name && (ctx.module.defines.has(name) || op.is_decl);
  if (emitAsDecl) {
    ctx.line(`${asyncPrefix}function${star} ${name}(${params}) {`);
    ctx.push();
    // Function body is its own scope; pre-declare params so a `let p = …`
    // inside the body emits as `p = …` rather than re-declaring.
    ctx.pushScope();
    for (const p of (op.params || [])) ctx.scope.declare(p.name);
    _hoistFunctionLocals(ctx, op.body);
    if (op.body) emitOps(ctx, op.body);
    ctx.popScope();
    ctx.pop();
    ctx.line('}');
    // Register the function name in the enclosing scope so subsequent
    // stores don't re-declare it.
    ctx.scope.declare(name);
    ctx.exprs.set(op.id, name);
    ctx.types.set(op.id, op.type);
  } else {
    // Anonymous or non-top-level: register as expression
    const savedLines = ctx.lines;
    ctx.lines = [];
    ctx.push();
    ctx.pushScope();
    for (const p of (op.params || [])) ctx.scope.declare(p.name);
    _hoistFunctionLocals(ctx, op.body);
    if (op.body) emitOps(ctx, op.body);
    ctx.popScope();
    ctx.pop();
    const bodyLines = ctx.lines;
    ctx.lines = savedLines;

    const bodyStr = bodyLines.length
      ? '\n' + bodyLines.join('\n') + '\n' + '  '.repeat(ctx.indent)
      : '';

    if (name || op.is_generator) {
      register(ctx, op, `${asyncPrefix}function${star}${name ? ' ' + name : ''}(${params}) {${bodyStr}}`);
    } else {
      register(ctx, op, `${asyncPrefix}(${params}) => {${bodyStr}}`);
    }
  }
}

function emitNew(ctx, op) {
  const ctor = ctx.ref(op.args[0]);
  const args = op.args.slice(1).map(a => ctx.ref(a));
  register(ctx, op, `new ${ctor}(${args.join(', ')})`);
}

function emitImport(ctx, op) {
  const source = ctx.ref(op.args[0]);
  register(ctx, op, `import(${source})`);
}

function emitSwitch(ctx, op) {
  const disc = ctx.ref(op.args[0]);
  ctx.line(`switch (${disc}) {`);
  ctx.push();
  // Each case body is its own block scope so two cases declaring the
  // same name (`case 1: { let x = … } case 2: { let x = … }`) each get
  // their own `let`. Source-level cases that wrap their body in `{}`
  // already get scoping from the BlockStatement op, but the scope
  // pushed here also covers cases whose body is a flat statement list.
  for (const c of op.cases || []) {
    if (c.test_val) {
      if (c.test_ops) emitOps(ctx, c.test_ops);
      const test = ctx.ref(c.test_val);
      ctx.line(`case ${test}:`);
    } else {
      ctx.line('default:');
    }
    ctx.push();
    ctx.pushScope();
    emitOps(ctx, c.body);
    ctx.popScope();
    ctx.pop();
  }
  ctx.pop();
  ctx.line('}');
}

function emitTry(ctx, op) {
  // Each of try / catch / finally is its own block scope. The catch
  // parameter is pre-declared so a body-level `let e = …` would be
  // detected (and emit a fresh declaration in JS, matching semantics).
  ctx.line('try {');
  ctx.push();
  ctx.pushScope();
  if (op.try_body) emitOps(ctx, op.try_body);
  ctx.popScope();
  ctx.pop();
  if (op.catch_param != null || (op.catch_body && op.catch_body.length)) {
    const param = op.catch_param ? `(${op.catch_param})` : '';
    ctx.line(`} catch${param} {`);
    ctx.push();
    ctx.pushScope();
    if (op.catch_param) ctx.scope.declare(op.catch_param);
    if (op.catch_body) emitOps(ctx, op.catch_body);
    ctx.popScope();
    ctx.pop();
  }
  if (op.finally_body && op.finally_body.length) {
    ctx.line('} finally {');
    ctx.push();
    ctx.pushScope();
    emitOps(ctx, op.finally_body);
    ctx.popScope();
    ctx.pop();
  }
  ctx.line('}');
}

function emitLabeled(ctx, op) {
  const label = op.args[0];
  if (op.is_block) {
    ctx.line(`${label}: {`);
    ctx.push();
    ctx.pushScope();
    if (op.body) emitOps(ctx, op.body);
    ctx.popScope();
    ctx.pop();
    ctx.line('}');
  } else {
    ctx.line(`${label}:`);
    if (op.body) emitOps(ctx, op.body);
  }
}

function emitClass(ctx, op) {
  const name = op.name || '';
  const superClass = op.super_class ? ctx.ref(op.super_class) : null;
  const ext = superClass ? ` extends ${superClass}` : '';
  const isDecl = name && ctx.module.defines.has(name);

  // Emit class header
  if (isDecl) {
    ctx.line(`class ${name}${ext} {`);
  } else {
    // For class expressions, capture body into lines then wrap
    var savedForExpr = ctx.lines;
    ctx.lines = [];
  }

  if (!isDecl) ctx.line(`class${name ? ' ' + name : ''}${ext} {`);

  ctx.push();
  for (const m of (op.members || [])) {
    emitClassMember(ctx, m);
  }
  ctx.pop();
  ctx.line('}');

  if (isDecl) {
    ctx.scope.declare(name);
    ctx.exprs.set(op.id, name);
    ctx.types.set(op.id, op.type);
  } else {
    const classLines = ctx.lines;
    ctx.lines = savedForExpr;
    register(ctx, op, classLines.join('\n'));
  }
}

function emitClassMember(ctx, m) {
  if (m.kind === 'static_block') {
    ctx.line('static {');
    ctx.push();
    emitOps(ctx, m.body);
    ctx.pop();
    ctx.line('}');
    return;
  }

  const prefix = m.static ? 'static ' : '';
  const keyStr = m.computed ? `[${ctx.ref(m.computedKeyId)}]` :
                 typeof m.key === 'string' ? m.key : JSON.stringify(m.key);

  if (m.kind === 'field') {
    if (m.value) {
      const val = ctx.ref(m.value);
      ctx.line(`${prefix}${keyStr} = ${val};`);
    } else {
      ctx.line(`${prefix}${keyStr};`);
    }
    return;
  }

  // Method, constructor, getter, setter
  const fnOp = findOpInModule(ctx, m.value);
  const kindPrefix = m.kind === 'get' ? 'get ' : m.kind === 'set' ? 'set ' : '';
  const asyncPrefix = fnOp?.is_async ? 'async ' : '';
  const star = fnOp?.is_generator ? '*' : '';
  const params = fnOp ? (fnOp.params || []).map(p => p.name).join(', ') : '';

  ctx.line(`${prefix}${asyncPrefix}${kindPrefix}${star}${keyStr}(${params}) {`);
  ctx.push();
  if (fnOp?.body) emitOps(ctx, fnOp.body);
  ctx.pop();
  ctx.line('}');
}

function findOpInModule(ctx, id) {
  // Find a func_region op by its SSA id in the module
  function find(ops) {
    for (const op of ops) {
      if (op.id === id) return op;
      if (op.then_body) { const r = find(op.then_body); if (r) return r; }
      if (op.else_body) { const r = find(op.else_body); if (r) return r; }
      if (op.body) { const r = find(op.body); if (r) return r; }
      if (op.init) { const r = find(op.init); if (r) return r; }
      if (op.test) { const r = find(op.test); if (r) return r; }
      if (op.update) { const r = find(op.update); if (r) return r; }
      if (op.try_body) { const r = find(op.try_body); if (r) return r; }
      if (op.catch_body) { const r = find(op.catch_body); if (r) return r; }
      if (op.finally_body) { const r = find(op.finally_body); if (r) return r; }
    }
    return null;
  }
  return find(ctx.module.ops);
}

function emitOpaque(ctx, op) {
  // Opaque regions contain original source text — emit verbatim.
  // Distinguish statement-level (class, try/catch — zero uses) from
  // expression-level (instanceof, **, typeof — have consumers).
  const src = op.args[0] || '(void 0)';
  const uses = ctx.useCounts.get(op.id) || 0;
  // Side signal: mark a name as already declared in the current scope
  // (used by adder/Soft for `nonlocal` / `global` markers AND by adder's
  // function-param prologue where the raw line IS `let X = …;` and X
  // needs to be in scope for later stores). Always emit the line —
  // pure-marker uses produce harmless `/* nonlocal x */` comments.
  if (op._markDeclared) ctx.scope.declare(op._markDeclared);
  if (uses === 0) {
    ctx.line(src);
  } else {
    register(ctx, op, src);
  }
}
