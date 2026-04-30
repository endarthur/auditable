// @gcu/air — JS emitter (Phase 2)
// Spec §9: AIR → optimized JavaScript
// Walks AIR ops and produces V8-friendly JS with type hints.

import { isDynamic, isNumeric, isInteger, isFloat, isConcrete } from './types.js';

// =============================================================================
// Async detection
// =============================================================================

export function needsAsync(module) {
  function check(ops) {
    for (const op of ops) {
      if (op.op === 'await') return true;
      if (op.op === 'opaque') return true; // may contain await
      if (op.op === 'call') return true;   // may call load/install/fetch
      if (op.then_body && check(op.then_body)) return true;
      if (op.else_body && check(op.else_body)) return true;
      if (op.body && check(op.body)) return true;
      if (op.init && check(op.init)) return true;
      if (op.test && check(op.test)) return true;
      if (op.update && check(op.update)) return true;
    }
    return false;
  }
  return check(module.ops);
}

// =============================================================================
// Use counting — determines which SSA values become let bindings vs inline
// =============================================================================

function countUses(ops, counts) {
  for (const op of ops) {
    if (op.args) {
      for (const arg of op.args) {
        if (typeof arg === 'string' && arg.startsWith('%')) {
          counts.set(arg, (counts.get(arg) || 0) + 1);
        }
      }
    }
    if (op.then_body) countUses(op.then_body, counts);
    if (op.else_body) countUses(op.else_body, counts);
    if (op.body) countUses(op.body, counts);
    if (op.init) countUses(op.init, counts);
    if (op.test) countUses(op.test, counts);
    if (op.update) countUses(op.update, counts);
    if (op.try_body) countUses(op.try_body, counts);
    if (op.catch_body) countUses(op.catch_body, counts);
    if (op.finally_body) countUses(op.finally_body, counts);
    if (op.cases) {
      for (const c of op.cases) {
        if (c.test_ops) countUses(c.test_ops, counts);
        if (c.test_val) counts.set(c.test_val, (counts.get(c.test_val) || 0) + 1);
        countUses(c.body, counts);
      }
    }
    if (op.members) {
      for (const m of op.members) {
        if (m.value) counts.set(m.value, (counts.get(m.value) || 0) + 1);
        if (m.computedKeyId) counts.set(m.computedKeyId, (counts.get(m.computedKeyId) || 0) + 1);
        if (m.body) countUses(m.body, counts);
      }
    }
    if (op.phis) {
      for (const p of op.phis) {
        if (p.then_val) counts.set(p.then_val, (counts.get(p.then_val) || 0) + 1);
        if (p.else_val) counts.set(p.else_val, (counts.get(p.else_val) || 0) + 1);
      }
    }
  }
}

// =============================================================================
// Emit context
// =============================================================================

class EmitCtx {
  constructor(module, options) {
    this.module = module;
    this.hinted = options.hinted ?? true;
    this.cellId = options.cellId || '?';
    this.cellName = options.cellName || '';

    // Count uses of each SSA name
    this.useCounts = new Map();
    countUses(module.ops, this.useCounts);

    // SSA id → expression string (for inlining single-use values)
    this.exprs = new Map();

    // SSA id → type
    this.types = new Map();

    // Track which SSA ids have been emitted as let bindings
    this.emitted = new Set();

    this.lines = [];
    this.indent = 0;
  }

  line(s) { this.lines.push('  '.repeat(this.indent) + s); }
  push() { this.indent++; }
  pop() { this.indent--; }

  // Resolve an SSA ref to an expression string.
  // Single-use values are inlined; multi-use values are variable names.
  ref(id) {
    if (!id) return 'undefined';
    if (typeof id !== 'string' || !id.startsWith('%')) return String(id);
    if (this.exprs.has(id)) {
      const uses = this.useCounts.get(id) || 0;
      if (uses <= 1) {
        // Inline: consume the expression
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
    case 'continue': ctx.line('continue;'); return;
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

  // If this is a top-level define, emit as let/const
  // Don't apply hints here — the value's own emission handles V8 hints.
  if (ctx.module.defines.has(name)) {
    if (ctx.emitted.has('decl:' + name)) {
      ctx.line(`${name} = ${val};`);
    } else {
      ctx.line(`let ${name} = ${val};`);
      ctx.emitted.add('decl:' + name);
    }
  } else {
    if (!ctx.emitted.has('decl:' + name)) {
      ctx.line(`let ${name} = ${val};`);
      ctx.emitted.add('decl:' + name);
    } else {
      ctx.line(`${name} = ${val};`);
    }
  }
}

function emitSlotAlloc(ctx, op) {
  const name = op.args[0];
  // Slots are mutable-captured variables — emit as let
  ctx.line(`let ${name};`);
  ctx.emitted.add('decl:' + name);
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
  const hintedIdx = ctx.hinted ? `(${idx}) | 0` : idx;
  const bracket = op.optional ? '?.[' : '[';
  register(ctx, op, `${arr}${bracket}${hintedIdx}]`);
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
  if (op.then_body) emitOps(ctx, op.then_body);
  if (phi && phi.then_val) {
    const thenVal = ctx.ref(phi.then_val);
    ctx.line(`${phiVar} = ${thenVal};`);
  }
  ctx.pop();
  const hasElse = (op.else_body && op.else_body.length) || (phi && phi.else_val);
  if (hasElse) {
    ctx.line('} else {');
    ctx.push();
    if (op.else_body) emitOps(ctx, op.else_body);
    if (phi && phi.else_val) {
      const elseVal = ctx.ref(phi.else_val);
      ctx.line(`${phiVar} = ${elseVal};`);
    }
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

function emitFor(ctx, op) {
  // Emit init, test, update as separate regions
  // The init may contain let declarations, so we wrap in a block
  if (op.init && op.init.length) {
    // Capture init as inline statements
    const savedLines = ctx.lines;
    ctx.lines = [];
    emitOps(ctx, op.init);
    const initLines = ctx.lines;
    ctx.lines = savedLines;

    // Single-line init goes in the for header
    if (initLines.length === 1) {
      const initStr = initLines[0].trim().replace(/;$/, '');

      const savedLines2 = ctx.lines;
      ctx.lines = [];
      if (op.test) emitOps(ctx, op.test);
      const testExpr = op.test_val ? ctx.ref(op.test_val) : '';
      const testLines = ctx.lines;
      ctx.lines = savedLines2;

      const savedLines3 = ctx.lines;
      ctx.lines = [];
      if (op.update) emitOps(ctx, op.update);
      const updateLines = ctx.lines;
      ctx.lines = savedLines3;
      const updateStr = updateLines.length === 1 ? updateLines[0].trim().replace(/;$/, '') : '';

      ctx.line(`for (${initStr}; ${testExpr}; ${updateStr}) {`);
    } else {
      // Multi-line init: emit separately
      for (const l of initLines) ctx.lines.push(l);
      const testExpr = op.test_val ? ctx.ref(op.test_val) : '';
      ctx.line(`for (; ${testExpr};) {`);
    }
  } else {
    const testExpr = op.test_val ? ctx.ref(op.test_val) : '';
    ctx.line(`for (; ${testExpr};) {`);
  }

  ctx.push();
  if (op.body) emitOps(ctx, op.body);
  // update at end of body if we couldn't put it in the header
  ctx.pop();
  ctx.line('}');
}

function emitForIn(ctx, op) {
  const iter = ctx.ref(op.args[0]);
  ctx.line(`for (const _k in ${iter}) {`);
  ctx.push();
  if (op.body) emitOps(ctx, op.body);
  ctx.pop();
  ctx.line('}');
}

function emitForOf(ctx, op) {
  const iter = ctx.ref(op.args[0]);
  const target = op.target_name || '_v';
  // If target_name is a Python-style variable that wasn't pre-declared,
  // use `let` to declare per-iteration. The emitter tracks via emitted set.
  const kind = ctx.emitted.has('decl:' + target) ? '' : 'let ';
  ctx.line(`for (${kind}${target} of ${iter}) {`);
  if (kind === 'let ') ctx.emitted.add('decl:' + target);
  ctx.push();
  if (op.body) emitOps(ctx, op.body);
  ctx.pop();
  ctx.line('}');
}

function emitLoop(ctx, op) {
  if (op.loop_kind === 'do_while') {
    ctx.line('do {');
    ctx.push();
    if (op.body) emitOps(ctx, op.body);
    ctx.pop();
    if (op.test) emitOps(ctx, op.test);
    const testExpr = op.test_val ? ctx.ref(op.test_val) : 'true';
    ctx.line(`} while (${testExpr});`);
  } else {
    // while loop
    ctx.line('while (true) {');
    ctx.push();
    if (op.test) emitOps(ctx, op.test);
    if (op.test_val) {
      const testExpr = ctx.ref(op.test_val);
      ctx.line(`if (!(${testExpr})) break;`);
    }
    if (op.body) emitOps(ctx, op.body);
    ctx.pop();
    ctx.line('}');
  }
}

function emitFunc(ctx, op) {
  // Method func_regions are emitted by emitClassMember, not here
  if (op.is_method) return;

  const name = op.name || '';
  const params = (op.params || []).map(p => p.name).join(', ');
  const asyncPrefix = op.is_async ? 'async ' : '';
  const star = op.is_generator ? '*' : '';

  // Check if this function is stored to a top-level name
  // If so, emit as function declaration or const assignment
  const uses = ctx.useCounts.get(op.id) || 0;

  if (name && ctx.module.defines.has(name)) {
    ctx.line(`${asyncPrefix}function${star} ${name}(${params}) {`);
    ctx.push();
    // Enter new scope: function body has its own local decl tracking
    const savedEmitted = ctx.emitted;
    ctx.emitted = new Set(savedEmitted);
    if (op.body) emitOps(ctx, op.body);
    ctx.emitted = savedEmitted;
    ctx.pop();
    ctx.line('}');
    ctx.emitted.add('decl:' + name);
    // Register so store doesn't re-declare
    ctx.exprs.set(op.id, name);
    ctx.types.set(op.id, op.type);
  } else {
    // Anonymous or non-top-level: register as expression
    const savedLines = ctx.lines;
    ctx.lines = [];
    ctx.push();
    const savedEmitted = ctx.emitted;
    ctx.emitted = new Set(savedEmitted);
    if (op.body) emitOps(ctx, op.body);
    ctx.emitted = savedEmitted;
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
  for (const c of op.cases || []) {
    if (c.test_val) {
      if (c.test_ops) emitOps(ctx, c.test_ops);
      const test = ctx.ref(c.test_val);
      ctx.line(`case ${test}:`);
    } else {
      ctx.line('default:');
    }
    ctx.push();
    emitOps(ctx, c.body);
    ctx.pop();
  }
  ctx.pop();
  ctx.line('}');
}

function emitTry(ctx, op) {
  ctx.line('try {');
  ctx.push();
  if (op.try_body) emitOps(ctx, op.try_body);
  ctx.pop();
  if (op.catch_param != null || (op.catch_body && op.catch_body.length)) {
    const param = op.catch_param ? `(${op.catch_param})` : '';
    ctx.line(`} catch${param} {`);
    ctx.push();
    if (op.catch_body) emitOps(ctx, op.catch_body);
    ctx.pop();
  }
  if (op.finally_body && op.finally_body.length) {
    ctx.line('} finally {');
    ctx.push();
    emitOps(ctx, op.finally_body);
    ctx.pop();
  }
  ctx.line('}');
}

function emitLabeled(ctx, op) {
  const label = op.args[0];
  if (op.is_block) {
    ctx.line(`${label}: {`);
    ctx.push();
    if (op.body) emitOps(ctx, op.body);
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
    ctx.emitted.add('decl:' + name);
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
  // Side signal: mark a name as already declared (for global/nonlocal)
  if (op._markDeclared) ctx.emitted.add('decl:' + op._markDeclared);
  if (uses === 0) {
    // Statement-level: emit as a line (skip the marker comment itself)
    if (op._markDeclared) return;
    ctx.line(src);
  } else {
    register(ctx, op, src);
  }
}
