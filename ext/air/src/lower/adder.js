// @gcu/air — adder (Python) → AIR lowerer
// Translates adder's Python AST into AIR ops. Python semantics preserved via
// calls to _py runtime helpers. Throws AirLowerError for unsupported nodes,
// triggering fallback to the tree-walker.

import {
  I32, F64, BOOL, STRING, VOID, DYNAMIC,
} from '../types.js';

export class AirLowerError extends Error {}

// ── SSA counter (shared across lowerer invocations via module state) ──

let _adderNextId = 0;
function _adderResetIds() { _adderNextId = 0; }
function _adderMkOp(op, args, type, loc, extra) {
  const id = '%' + (_adderNextId++);
  const o = { id, op, args, type: type || DYNAMIC, loc };
  if (extra) Object.assign(o, extra);
  return o;
}

// ── Lowering context ──

class AdderLowerCtx {
  constructor() {
    this.ops = [];
    this.symbols = new Map();   // name → SSA id of most recent value
    this.types = new Map();     // SSA id → type
    this.declared = new Set();  // names that have been emitted with `let` at top level
    this.topLevel = true;
    this.defines = new Set();   // names to export
    this.imports = new Set();   // referenced undefined names
    this.source = null;
  }
  emit(op, args, type, loc, extra) {
    const o = _adderMkOp(op, args, type, loc, extra);
    this.ops.push(o);
    if (type) this.types.set(o.id, type);
    return o;
  }
  loc(node) {
    return node?.line != null ? { line: node.line, col: node.col || 0 } : null;
  }
}

// ── Module-level define collection ──
// Python: any assignment at module level creates a binding in module scope.
// Descends into if/for/while/try/with blocks (no scope) but not def/class.

function collectDefines_ad(stmts, defines) {
  for (const node of stmts || []) {
    switch (node.type) {
      case 'Assign':
        for (const t of node.targets) collectTargetNames(t, defines);
        break;
      case 'AugAssign':
      case 'AnnAssign':
        collectTargetNames(node.target, defines);
        break;
      case 'FunctionDef':
      case 'AsyncFunctionDef':
      case 'ClassDef':
        defines.add(node.name);
        break;
      case 'Import':
        for (const alias of node.names) defines.add(alias.alias || alias.module);
        break;
      case 'ImportFrom':
        for (const alias of node.names) defines.add(alias.alias || alias.name);
        break;
      case 'For': case 'AsyncFor':
        collectTargetNames(node.target, defines);
        collectDefines_ad(node.body, defines);
        if (node.orelse) collectDefines_ad(node.orelse, defines);
        break;
      case 'While':
        collectDefines_ad(node.body, defines);
        if (node.orelse) collectDefines_ad(node.orelse, defines);
        break;
      case 'If':
        collectDefines_ad(node.body, defines);
        if (node.orelse) collectDefines_ad(node.orelse, defines);
        break;
      case 'With': case 'AsyncWith':
        for (const item of node.items) {
          if (item.optionalVar) collectTargetNames(item.optionalVar, defines);
        }
        collectDefines_ad(node.body, defines);
        break;
      case 'Try':
        collectDefines_ad(node.body, defines);
        if (node.handlers) for (const h of node.handlers) {
          if (h.name) defines.add(h.name);
          if (h.body) collectDefines_ad(h.body, defines);
        }
        if (node.orelse) collectDefines_ad(node.orelse, defines);
        if (node.finalbody) collectDefines_ad(node.finalbody, defines);
        break;
    }
  }
}

function collectTargetNames(target, defines) {
  if (!target) return;
  if (target.type === 'Name') { defines.add(target.id); return; }
  if (target.type === 'Tuple' || target.type === 'List') {
    for (const e of target.elts) collectTargetNames(e, defines);
    return;
  }
  if (target.type === 'Starred' && target.value) collectTargetNames(target.value, defines);
}

// ── Helper: call a _py runtime method (sync, no await needed) ──

function emitPyCall(ctx, method, args, loc, type) {
  const pyLoad = ctx.emit('load', ['_py'], DYNAMIC, loc);
  const methodGet = ctx.emit('object_get', [pyLoad.id, method], DYNAMIC, loc);
  return ctx.emit('call', [methodGet.id, ...args.map(a => a.id)], type || DYNAMIC, loc);
}

// User-facing calls (Python funcs / adder builtins) may be async — await them.
function emitAwaitedCall_ad(ctx, fnId, argIds, loc, type) {
  const call = ctx.emit('call', [fnId, ...argIds], type || DYNAMIC, loc);
  return ctx.emit('await', [call.id], type || DYNAMIC, loc);
}

// ── Main entry ──

export function lowerAdder(ast, source) {
  _adderResetIds();
  const ctx = new AdderLowerCtx();
  ctx.source = source || null;

  if (ast.type !== 'Module') throw new AirLowerError('Expected Module node');

  // Collect all module-scope defines up front (Python module-scope semantics)
  collectDefines_ad(ast.body, ctx.defines);

  // Identify names that will be declared by `function`/`class` syntax —
  // those don't need (and can't have) a `let` pre-declaration.
  const funcOrClassNames = new Set();
  for (const stmt of ast.body) {
    if ((stmt.type === 'FunctionDef' || stmt.type === 'AsyncFunctionDef' ||
         stmt.type === 'ClassDef') && stmt.name) {
      funcOrClassNames.add(stmt.name);
    }
  }

  // Pre-declare every module-level define with `let name;` at the top.
  // This ensures variables defined in nested blocks are visible at module scope.
  for (const name of ctx.defines) {
    if (name === '__lastExpr__') continue;
    if (funcOrClassNames.has(name)) continue; // declared by function/class syntax
    const undef = ctx.emit('const', [undefined], VOID, null);
    ctx.emit('store', [name, undef.id], VOID, null);
    ctx.symbols.set(name, undef.id);
  }

  // Lower each statement; track last Expr for REPL-like display
  let lastExpr = null;
  for (const stmt of ast.body) {
    const result = lowerStmt_ad(ctx, stmt);
    if (stmt.type === 'Expr' && result) lastExpr = result.id;
  }

  // If there's a trailing Expr, store it as __lastExpr__ so the caller can read it
  if (lastExpr) {
    ctx.emit('store', ['__lastExpr__', lastExpr], VOID, null);
    ctx.symbols.set('__lastExpr__', lastExpr);
    ctx.defines.add('__lastExpr__');
  }

  // Build cell module (matching shape from lowerJS)
  const exports = new Map();
  for (const name of ctx.defines) {
    const ssaId = ctx.symbols.get(name);
    const type = ssaId ? (ctx.types.get(ssaId) || DYNAMIC) : DYNAMIC;
    exports.set(name, { ssa_name: ssaId || null, type });
  }

  return {
    ops: ctx.ops,
    symbol_table: new Map(ctx.symbols),
    exports,
    imports: new Set(ctx.imports),
    defines: new Set(ctx.defines),
    side_effects: true,
    _lastExpr: lastExpr,
  };
}

// ── Statement lowering ──

function lowerStmt_ad(ctx, node) {
  if (!node) return null;
  const l = ctx.loc(node);

  switch (node.type) {
    case 'Pass': return null;
    case 'Break': ctx.emit('break', [], VOID, l); return null;
    case 'Continue': ctx.emit('continue', [], VOID, l); return null;
    case 'Expr': return lowerExpr_ad(ctx, node.value);

    case 'Assign': return lowerAssign(ctx, node);
    case 'AugAssign': return lowerAugAssign(ctx, node);
    case 'AnnAssign': return lowerAnnAssign(ctx, node);
    case 'Delete': return lowerDelete(ctx, node);

    case 'Return': {
      const val = node.value ? lowerExpr_ad(ctx, node.value) : ctx.emit('const', [null], VOID, l);
      ctx.emit('return', [val.id], VOID, l);
      return null;
    }

    case 'If': return lowerIf_ad(ctx, node);
    case 'For': return lowerFor_ad(ctx, node);
    case 'While': return lowerWhile_ad(ctx, node);

    case 'FunctionDef':
    case 'AsyncFunctionDef':
      return lowerFuncDef(ctx, node);

    case 'Import': return lowerImport(ctx, node);
    case 'ImportFrom': return lowerImportFrom(ctx, node);

    case 'ClassDef':
      return lowerClassDef(ctx, node);

    case 'Try':
      return lowerTry_ad(ctx, node);

    case 'With':
    case 'AsyncWith':
      return lowerWith(ctx, node);

    case 'Raise': {
      const exc = node.exc ? lowerExpr_ad(ctx, node.exc) : ctx.emit('const', [null], VOID, l);
      emitPyCall(ctx, 'raise', [exc], l, VOID);
      return null;
    }

    case 'Assert': {
      // assert test, msg → if not _py.truthy(test) throw AssertionError(msg)
      const test = lowerExpr_ad(ctx, node.test);
      const truthy = emitPyCall(ctx, 'truthy', [test], l, BOOL);
      // if (!truthy) raise AssertionError
      const savedOps = ctx.ops;
      ctx.ops = [];
      const msg = node.msg ? lowerExpr_ad(ctx, node.msg) : ctx.emit('const', ['assertion failed'], STRING, l);
      emitPyCall(ctx, 'raise', [msg], l, VOID);
      const thenBody = ctx.ops;
      ctx.ops = savedOps;
      // Emit: if (!_py.truthy(test)) { raise msg }
      const notTruthy = ctx.emit('logical_not', [truthy.id], BOOL, l);
      ctx.emit('if_region', [notTruthy.id], VOID, l, {
        then_body: thenBody, else_body: [], phis: [],
      });
      return null;
    }

    case 'Global':
    case 'Nonlocal':
      // Declaration-only; mark names as already declared so stores don't re-declare.
      // With per-function scope tracking in the emitter, a bare `x = ...` inside
      // the function reassigns the outer binding (global/nonlocal semantics).
      for (const n of node.names) {
        // Track in ctx.symbols to signal "this name exists in enclosing scope"
        if (!ctx.symbols.has(n)) ctx.symbols.set(n, null);
        // Emit a special opaque that marks `decl:name` as set in emitter scope
        ctx.emit('opaque', [`/* ${node.type.toLowerCase()} ${n} */`], VOID, l, { _markDeclared: n });
      }
      return null;

    default:
      throw new AirLowerError(`unsupported statement: ${node.type}`);
  }
}

// ── Expression lowering ──

function lowerExpr_ad(ctx, node) {
  if (!node) return ctx.emit('const', [null], VOID, null);
  const l = ctx.loc(node);

  switch (node.type) {
    case 'Constant': {
      const v = node.value;
      if (v === null) return ctx.emit('const', [null], DYNAMIC, l);
      if (typeof v === 'boolean') return ctx.emit('const', [v], BOOL, l);
      if (typeof v === 'number') {
        const isInt = Number.isInteger(v) && v >= -2147483648 && v <= 2147483647;
        return ctx.emit('const', [v], isInt ? I32 : F64, l);
      }
      if (typeof v === 'string') return ctx.emit('const', [v], STRING, l);
      if (v && typeof v === 'object' && v._complex) {
        throw new AirLowerError('complex literal not supported in transpile');
      }
      return ctx.emit('const', [v], DYNAMIC, l);
    }

    case 'Name': {
      const name = node.id;
      if (name === 'True') return ctx.emit('const', [true], BOOL, l);
      if (name === 'False') return ctx.emit('const', [false], BOOL, l);
      if (name === 'None') return ctx.emit('const', [null], DYNAMIC, l);
      // Not an import if: already assigned (in symbols), or a module-level define
      if (!ctx.symbols.has(name) && !ctx.defines.has(name)) ctx.imports.add(name);
      return ctx.emit('load', [name], DYNAMIC, l);
    }

    case 'BinOp': return lowerBinOp_ad(ctx, node);
    case 'UnaryOp': return lowerUnaryOp(ctx, node);
    case 'BoolOp': return lowerBoolOp(ctx, node);
    case 'Compare': return lowerCompare_ad(ctx, node);

    case 'Call': return lowerCall_ad(ctx, node);

    case 'Attribute': {
      const obj = lowerExpr_ad(ctx, node.value);
      const name = ctx.emit('const', [node.attr], STRING, l);
      return emitPyCall(ctx, 'getattr', [obj, name], l);
    }

    case 'Subscript': return lowerSubscript(ctx, node);

    case 'List': return lowerListOrTuple(ctx, node);
    case 'Tuple': return lowerListOrTuple(ctx, node);

    case 'Dict': {
      // Plain object if all keys are string constants; otherwise build a Map.
      const allStringKeys = node.keys.every(k =>
        k && k.type === 'Constant' && typeof k.value === 'string');
      if (allStringKeys) {
        const pairs = [];
        for (let i = 0; i < node.keys.length; i++) {
          if (node.keys[i] === null) {
            // **unpack
            const src = lowerExpr_ad(ctx, node.values[i]);
            pairs.push({ spread: true, id: src.id });
          } else {
            const val = lowerExpr_ad(ctx, node.values[i]);
            pairs.push({ key: node.keys[i].value, id: val.id });
          }
        }
        return ctx.emit('object_new', pairs, DYNAMIC, l);
      }
      // Build a Map via _py.makeDict with arrays of keys and values
      const keys = node.keys.map(k => k ? lowerExpr_ad(ctx, k).id : null);
      const values = node.values.map(v => lowerExpr_ad(ctx, v).id);
      const keysArr = ctx.emit('array_new', keys.filter(k => k), DYNAMIC, l);
      const valsArr = ctx.emit('array_new', values, DYNAMIC, l);
      return emitPyCall(ctx, 'makeDict', [keysArr, valsArr], l);
    }

    case 'Set': {
      const elts = node.elts.map(e => lowerExpr_ad(ctx, e).id);
      const arr = ctx.emit('array_new', elts, DYNAMIC, l);
      return emitPyCall(ctx, 'makeSet', [arr], l);
    }

    case 'SetComp':
    case 'DictComp':
    case 'GeneratorExp':
      return lowerComprehension(ctx, node);

    case 'IfExp': {
      // a if cond else b — ternary
      const cond = lowerExpr_ad(ctx, node.test);
      const truthy = emitPyCall(ctx, 'truthy', [cond], l, BOOL);

      const savedOps = ctx.ops;
      ctx.ops = [];
      const thenVal = lowerExpr_ad(ctx, node.body);
      const thenBody = ctx.ops;
      ctx.ops = [];
      const elseVal = lowerExpr_ad(ctx, node.orelse);
      const elseBody = ctx.ops;
      ctx.ops = savedOps;

      return ctx.emit('if_region', [truthy.id], DYNAMIC, l, {
        then_body: thenBody,
        else_body: elseBody,
        phis: [{ then_val: thenVal.id, else_val: elseVal.id }],
      });
    }

    case 'JoinedStr': {
      // f-string — concat parts
      let result = ctx.emit('const', [''], STRING, l);
      for (const part of node.values) {
        let piece;
        if (part.type === 'Constant') {
          piece = ctx.emit('const', [part.value], STRING, l);
        } else if (part.type === 'FormattedValue') {
          const val = lowerExpr_ad(ctx, part.value);
          const spec = part.formatSpec
            ? lowerExpr_ad(ctx, part.formatSpec)
            : ctx.emit('const', [''], STRING, l);
          piece = emitPyCall(ctx, 'fmt', [val, spec], l, STRING);
        } else {
          throw new AirLowerError(`unexpected JoinedStr part: ${part.type}`);
        }
        result = ctx.emit('add', [result.id, piece.id], STRING, l);
      }
      return result;
    }

    case 'Lambda': return lowerLambda(ctx, node);

    case 'ListComp': return lowerComprehension(ctx, node);

    case 'Await': {
      const val = lowerExpr_ad(ctx, node.value);
      return ctx.emit('await', [val.id], DYNAMIC, l);
    }

    case 'NamedExpr': {
      // walrus: (name := value) — assign then evaluate as the value
      const val = lowerExpr_ad(ctx, node.value);
      const name = node.target.id;
      ctx.emit('store', [name, val.id], VOID, l);
      ctx.symbols.set(name, val.id);
      if (ctx.topLevel) ctx.defines.add(name);
      return val;
    }

    case 'Starred':
      throw new AirLowerError('starred expression in unsupported position');

    case 'Yield': {
      const val = node.value ? lowerExpr_ad(ctx, node.value) : null;
      return ctx.emit('yield', val ? [val.id] : [], DYNAMIC, l);
    }
    case 'YieldFrom': {
      const val = lowerExpr_ad(ctx, node.value);
      return ctx.emit('yield_delegate', [val.id], DYNAMIC, l);
    }

    default:
      throw new AirLowerError(`unsupported expression: ${node.type}`);
  }
}

// ── Binary/unary/bool/compare ops ──

const BINOP_HELPER = {
  '+': 'add', '-': 'sub', '*': 'mul', '/': 'div',
  '//': 'floordiv', '%': 'mod', '**': 'pow',
  '&': 'and_', '|': 'or_', '^': 'xor',  // bitwise — Python has __and__ etc.
  '<<': 'lshift', '>>': 'rshift',
};

function lowerBinOp_ad(ctx, node) {
  const l = ctx.loc(node);
  const lhs = lowerExpr_ad(ctx, node.left);
  const rhs = lowerExpr_ad(ctx, node.right);
  const op = node.op;

  // Bitwise ops: just use JS — Python int bitwise matches JS i32 bitwise
  if (op === '&') return ctx.emit('bitwise_and', [lhs.id, rhs.id], I32, l);
  if (op === '|') return ctx.emit('bitwise_or', [lhs.id, rhs.id], I32, l);
  if (op === '^') return ctx.emit('bitwise_xor', [lhs.id, rhs.id], I32, l);
  if (op === '<<') return ctx.emit('shift_left', [lhs.id, rhs.id], I32, l);
  if (op === '>>') return ctx.emit('shift_right', [lhs.id, rhs.id], I32, l);

  const helper = BINOP_HELPER[op];
  if (!helper) throw new AirLowerError(`unsupported binop: ${op}`);
  return emitPyCall(ctx, helper, [lhs, rhs], l);
}

function lowerUnaryOp(ctx, node) {
  const l = ctx.loc(node);
  const arg = lowerExpr_ad(ctx, node.operand);
  const op = node.op;
  if (op === 'not') {
    // not x → !_py.truthy(x)
    const truthy = emitPyCall(ctx, 'truthy', [arg], l, BOOL);
    return ctx.emit('logical_not', [truthy.id], BOOL, l);
  }
  if (op === '-') return emitPyCall(ctx, 'neg', [arg], l);
  if (op === '+') return emitPyCall(ctx, 'pos', [arg], l);
  if (op === '~') return emitPyCall(ctx, 'invert', [arg], l);
  throw new AirLowerError(`unsupported unary op: ${op}`);
}

function lowerBoolOp(ctx, node) {
  // and / or — short-circuit. Python semantics: return the actual value, not a bool.
  // x and y → (_py.truthy(x) ? y : x)
  // x or y  → (_py.truthy(x) ? x : y)
  // For n-ary, chain: a and b and c → a_and_b-result and c
  const l = ctx.loc(node);
  if (node.values.length < 2) return lowerExpr_ad(ctx, node.values[0]);

  let result = lowerExpr_ad(ctx, node.values[0]);
  for (let i = 1; i < node.values.length; i++) {
    const truthy = emitPyCall(ctx, 'truthy', [result], l, BOOL);
    const savedOps = ctx.ops;

    ctx.ops = [];
    const next = lowerExpr_ad(ctx, node.values[i]);
    const nextBody = ctx.ops;
    ctx.ops = savedOps;

    if (node.op === 'and') {
      // if truthy(prev): next else: prev
      result = ctx.emit('if_region', [truthy.id], DYNAMIC, l, {
        then_body: nextBody,
        else_body: [],
        phis: [{ then_val: next.id, else_val: result.id }],
      });
    } else {
      // or: if truthy(prev): prev else: next
      result = ctx.emit('if_region', [truthy.id], DYNAMIC, l, {
        then_body: [],
        else_body: nextBody,
        phis: [{ then_val: result.id, else_val: next.id }],
      });
    }
  }
  return result;
}

const CMP_HELPER = {
  '==': 'eq', '!=': 'neq', '<': 'lt', '<=': 'lte', '>': 'gt', '>=': 'gte',
};

function lowerCompare_ad(ctx, node) {
  const l = ctx.loc(node);
  // Chained compare: a < b < c → (a < b) && (b < c)
  // Note: Python evaluates b only once, but for simplicity we re-evaluate it.
  // This is observable but rare in practice.
  let left = lowerExpr_ad(ctx, node.left);
  let result = null;
  for (let i = 0; i < node.ops.length; i++) {
    const op = node.ops[i];
    const right = lowerExpr_ad(ctx, node.comparators[i]);

    let cmp;
    if (op === 'in') {
      cmp = emitPyCall(ctx, 'contains', [right, left], l, BOOL);
    } else if (op === 'not in') {
      const c = emitPyCall(ctx, 'contains', [right, left], l, BOOL);
      cmp = ctx.emit('logical_not', [c.id], BOOL, l);
    } else if (op === 'is') {
      cmp = ctx.emit('eq', [left.id, right.id], BOOL, l);
    } else if (op === 'is not') {
      cmp = ctx.emit('neq', [left.id, right.id], BOOL, l);
    } else {
      const helper = CMP_HELPER[op];
      if (!helper) throw new AirLowerError(`unsupported compare: ${op}`);
      cmp = emitPyCall(ctx, helper, [left, right], l, BOOL);
    }

    result = result ? ctx.emit('logical_and', [result.id, cmp.id], BOOL, l) : cmp;
    left = right;
  }
  return result;
}

// ── Subscript ──

function lowerSubscript(ctx, node) {
  const l = ctx.loc(node);
  const obj = lowerExpr_ad(ctx, node.value);
  if (node.slice.type === 'Slice') {
    const lower = node.slice.lower ? lowerExpr_ad(ctx, node.slice.lower) : ctx.emit('const', [null], VOID, l);
    const upper = node.slice.upper ? lowerExpr_ad(ctx, node.slice.upper) : ctx.emit('const', [null], VOID, l);
    const step = node.slice.step ? lowerExpr_ad(ctx, node.slice.step) : ctx.emit('const', [null], VOID, l);
    return emitPyCall(ctx, 'slice', [obj, lower, upper, step], l);
  }
  const key = lowerExpr_ad(ctx, node.slice);
  return emitPyCall(ctx, 'getitem', [obj, key], l);
}

// ── Call ──

function lowerCall_ad(ctx, node) {
  const l = ctx.loc(node);

  const hasStarred = node.args.some(a => a.type === 'Starred');
  const hasKwargs = node.keywords && node.keywords.length > 0;
  const hasSplatKw = hasKwargs && node.keywords.some(kw => kw.name === null);

  // Lower positional args, spreading any starred ones
  const argIds = [];
  for (const a of node.args) {
    if (a.type === 'Starred') {
      const inner = lowerExpr_ad(ctx, a.value);
      // Emit spread on the iter-converted value so JS ...spread works
      const arr = emitPyCall(ctx, 'iter', [inner], l);
      argIds.push(ctx.emit('spread', [arr.id], DYNAMIC, l).id);
    } else {
      argIds.push(lowerExpr_ad(ctx, a).id);
    }
  }

  // Build kwargs if present
  let kwObjId = null;
  if (hasKwargs) {
    const pairs = [];
    let hasSplat = false;
    for (const kw of node.keywords) {
      if (kw.name === null) {
        // **kw splat
        hasSplat = true;
        const src = lowerExpr_ad(ctx, kw.value);
        pairs.push({ spread: true, id: src.id });
      } else {
        const val = lowerExpr_ad(ctx, kw.value);
        pairs.push({ key: kw.name, id: val.id });
      }
    }
    // Always include _kw: true marker (for adder's calling convention)
    pairs.unshift({ key: '_kw', id: ctx.emit('const', [true], BOOL, l).id });
    kwObjId = ctx.emit('object_new', pairs, DYNAMIC, l).id;
  }

  // Assemble final call
  if (node.func.type === 'Attribute') {
    const obj = lowerExpr_ad(ctx, node.func.value);
    const name = ctx.emit('const', [node.func.attr], STRING, l);
    const method = emitPyCall(ctx, 'getattr', [obj, name], l);
    const finalArgs = kwObjId ? [...argIds, kwObjId] : argIds;
    return emitAwaitedCall_ad(ctx, method.id, finalArgs, l);
  }

  const fn = lowerExpr_ad(ctx, node.func);
  const finalArgs = kwObjId ? [...argIds, kwObjId] : argIds;
  return emitAwaitedCall_ad(ctx, fn.id, finalArgs, l);
}

// ── Assignment ──

function lowerAssign(ctx, node) {
  const l = ctx.loc(node);
  const value = lowerExpr_ad(ctx, node.value);
  for (const target of node.targets) {
    lowerAssignTarget(ctx, target, value, l);
  }
  return null;
}

function lowerAssignTarget(ctx, target, value, l) {
  if (target.type === 'Name') {
    const name = target.id;
    ctx.emit('store', [name, value.id], VOID, l);
    ctx.symbols.set(name, value.id);
    if (ctx.topLevel) ctx.defines.add(name);
    return;
  }
  if (target.type === 'Tuple' || target.type === 'List') {
    // Tuple/list unpacking: a, b = value, or a, *rest = value
    // First ensure value is an array-like via _py.iter
    const iterArr = emitPyCall(ctx, 'iter', [value], l);
    // Find starred index (if any) — only one allowed
    let starredIdx = -1;
    for (let i = 0; i < target.elts.length; i++) {
      if (target.elts[i].type === 'Starred') {
        if (starredIdx !== -1) throw new AirLowerError('multiple starred targets');
        starredIdx = i;
      }
    }

    if (starredIdx === -1) {
      // Simple: index each
      for (let i = 0; i < target.elts.length; i++) {
        const idx = ctx.emit('const', [i], I32, l);
        const item = emitPyCall(ctx, 'getitem', [iterArr, idx], l);
        lowerAssignTarget(ctx, target.elts[i], item, l);
      }
    } else {
      // Before starred: index 0..starredIdx
      for (let i = 0; i < starredIdx; i++) {
        const idx = ctx.emit('const', [i], I32, l);
        const item = emitPyCall(ctx, 'getitem', [iterArr, idx], l);
        lowerAssignTarget(ctx, target.elts[i], item, l);
      }
      // Starred: slice [starredIdx : len - (n - starredIdx - 1)]
      const afterCount = target.elts.length - starredIdx - 1;
      const startConst = ctx.emit('const', [starredIdx], I32, l);
      const endExpr = afterCount === 0
        ? ctx.emit('const', [null], VOID, l)  // no end → slice to end
        : ctx.emit('const', [-afterCount], I32, l);
      const stepNull = ctx.emit('const', [null], VOID, l);
      const restArr = emitPyCall(ctx, 'slice', [iterArr, startConst, endExpr, stepNull], l);
      lowerAssignTarget(ctx, target.elts[starredIdx].value, restArr, l);
      // After starred: index from end
      for (let i = starredIdx + 1; i < target.elts.length; i++) {
        // negative index: (len - (target.elts.length - i))
        const relIdx = -(target.elts.length - i);
        const idx = ctx.emit('const', [relIdx], I32, l);
        const item = emitPyCall(ctx, 'getitem', [iterArr, idx], l);
        lowerAssignTarget(ctx, target.elts[i], item, l);
      }
    }
    return;
  }
  if (target.type === 'Starred') {
    // Bare starred in assignment — just unwrap to its value
    return lowerAssignTarget(ctx, target.value, value, l);
  }
  if (target.type === 'Attribute') {
    const obj = lowerExpr_ad(ctx, target.value);
    const name = ctx.emit('const', [target.attr], STRING, l);
    emitPyCall(ctx, 'setattr', [obj, name, value], l, VOID);
    return;
  }
  if (target.type === 'Subscript') {
    const obj = lowerExpr_ad(ctx, target.value);
    if (target.slice.type === 'Slice') {
      throw new AirLowerError('slice assignment not yet supported');
    }
    const key = lowerExpr_ad(ctx, target.slice);
    emitPyCall(ctx, 'setitem', [obj, key, value], l, VOID);
    return;
  }
  throw new AirLowerError(`unsupported assign target: ${target.type}`);
}

function lowerAugAssign(ctx, node) {
  // x += y → x = x + y (simplified — no __iadd__ dispatch for now)
  const l = ctx.loc(node);
  // Load current value
  let current;
  if (node.target.type === 'Name') {
    current = ctx.emit('load', [node.target.id], DYNAMIC, l);
  } else if (node.target.type === 'Attribute') {
    const obj = lowerExpr_ad(ctx, node.target.value);
    const name = ctx.emit('const', [node.target.attr], STRING, l);
    current = emitPyCall(ctx, 'getattr', [obj, name], l);
  } else if (node.target.type === 'Subscript') {
    const obj = lowerExpr_ad(ctx, node.target.value);
    const key = lowerExpr_ad(ctx, node.target.slice);
    current = emitPyCall(ctx, 'getitem', [obj, key], l);
  } else {
    throw new AirLowerError(`unsupported augassign target: ${node.target.type}`);
  }

  const rhs = lowerExpr_ad(ctx, node.value);
  const op = node.op;
  let result;
  if (op === '&') result = ctx.emit('bitwise_and', [current.id, rhs.id], I32, l);
  else if (op === '|') result = ctx.emit('bitwise_or', [current.id, rhs.id], I32, l);
  else if (op === '^') result = ctx.emit('bitwise_xor', [current.id, rhs.id], I32, l);
  else if (op === '<<') result = ctx.emit('shift_left', [current.id, rhs.id], I32, l);
  else if (op === '>>') result = ctx.emit('shift_right', [current.id, rhs.id], I32, l);
  else {
    const helper = BINOP_HELPER[op];
    if (!helper) throw new AirLowerError(`unsupported augassign op: ${op}`);
    result = emitPyCall(ctx, helper, [current, rhs], l);
  }

  lowerAssignTarget(ctx, node.target, result, l);
  return null;
}

function lowerAnnAssign(ctx, node) {
  // Annotated assignment: `x: int = 5`. Ignore annotation for now.
  if (!node.value) return null;
  const l = ctx.loc(node);
  const value = lowerExpr_ad(ctx, node.value);
  lowerAssignTarget(ctx, node.target, value, l);
  return null;
}

function lowerTry_ad(ctx, node) {
  // try: body [except [Type] [as name]: handler] [else: orelse] [finally: finalbody]
  const l = ctx.loc(node);

  const savedOps = ctx.ops;

  // try body
  ctx.ops = [];
  for (const s of node.body) lowerStmt_ad(ctx, s);
  // If there's an else clause and no exception, run it too. Represent as:
  // try { body; else_body } catch { handlers } finally { finalbody }
  if (node.orelse && node.orelse.length) {
    for (const s of node.orelse) lowerStmt_ad(ctx, s);
  }
  const tryBody = ctx.ops;

  // Catch handlers — build a combined catch body that checks each handler's type
  // Use a single JS catch(__e) that does an if/else chain of _py.matchException.
  let catchParam = null;
  let catchBody = [];
  if (node.handlers && node.handlers.length) {
    catchParam = '__exc';
    ctx.ops = [];
    // Build if/elif chain
    let elseChain = ctx.ops; // initially the current ops
    let firstHandlerOps = null;
    let lastElseBody = null;

    // We'll manually build a nested if_region ladder
    function buildHandler(idx) {
      if (idx >= node.handlers.length) {
        // No handler matched — re-throw
        const excLoad = ctx.emit('load', [catchParam], DYNAMIC, l);
        ctx.emit('throw', [excLoad.id], VOID, l);
        return;
      }
      const h = node.handlers[idx];
      if (!h.excType) {
        // bare except: catches everything
        if (h.name) {
          const excLoad = ctx.emit('load', [catchParam], DYNAMIC, l);
          ctx.emit('store', [h.name, excLoad.id], VOID, l);
          ctx.symbols.set(h.name, excLoad.id);
        }
        for (const s of h.body) lowerStmt_ad(ctx, s);
        return;
      }
      const excType = lowerExpr_ad(ctx, h.excType);
      const excLoad = ctx.emit('load', [catchParam], DYNAMIC, l);
      const cond = emitPyCall(ctx, 'matchException', [excLoad, excType], l, BOOL);

      const savedInner = ctx.ops;
      // then branch: bind name and run handler body
      ctx.ops = [];
      if (h.name) {
        const excLoad2 = ctx.emit('load', [catchParam], DYNAMIC, l);
        ctx.emit('store', [h.name, excLoad2.id], VOID, l);
        ctx.symbols.set(h.name, excLoad2.id);
      }
      for (const s of h.body) lowerStmt_ad(ctx, s);
      const thenBody = ctx.ops;
      // else branch: next handler
      ctx.ops = [];
      buildHandler(idx + 1);
      const elseBody = ctx.ops;
      ctx.ops = savedInner;
      ctx.emit('if_region', [cond.id], VOID, l, {
        then_body: thenBody, else_body: elseBody, phis: [],
      });
    }
    buildHandler(0);
    catchBody = ctx.ops;
  }

  // Finally
  let finallyBody = [];
  if (node.finalbody && node.finalbody.length) {
    ctx.ops = [];
    for (const s of node.finalbody) lowerStmt_ad(ctx, s);
    finallyBody = ctx.ops;
  }

  ctx.ops = savedOps;
  return ctx.emit('try_region', [], VOID, l, {
    try_body: tryBody,
    catch_param: catchParam,
    catch_body: catchBody,
    finally_body: finallyBody,
  });
}

function lowerWith(ctx, node) {
  // with ctx1 as a, ctx2 as b: body
  // → Lower as try/finally with __enter__/__exit__ calls.
  // For simplicity, just emit a sequence of enters, then the body, then exits in reverse.
  // This misses __exit__ exception suppression semantics — acceptable for v1.
  const l = ctx.loc(node);

  const savedOps = ctx.ops;

  // Enter each context manager; record (mgr, exit) pairs as synthetic locals
  const enterOps = [];
  const tempNames = [];
  for (let i = 0; i < node.items.length; i++) {
    const item = node.items[i];
    const mgr = lowerExpr_ad(ctx, item.contextExpr);
    const mgrName = `__with_mgr_${_adderNextId}`;
    ctx.emit('store', [mgrName, mgr.id], VOID, l);
    ctx.symbols.set(mgrName, mgr.id);
    tempNames.push(mgrName);
    // enter = _py.getattr(mgr, '__enter__')(); then bind to optionalVar
    const mgrLoad = ctx.emit('load', [mgrName], DYNAMIC, l);
    const enterName = ctx.emit('const', ['__enter__'], STRING, l);
    const enterFn = emitPyCall(ctx, 'getattr', [mgrLoad, enterName], l);
    const enterCall = emitAwaitedCall_ad(ctx, enterFn.id, [], l);
    if (item.optionalVar) {
      lowerAssignTarget(ctx, item.optionalVar, enterCall, l);
    }
  }

  // try { body } finally { for each manager in reverse: __exit__(None, None, None) }
  ctx.ops = [];
  for (const s of node.body) lowerStmt_ad(ctx, s);
  const tryBody = ctx.ops;

  ctx.ops = [];
  for (let i = tempNames.length - 1; i >= 0; i--) {
    const mgrLoad = ctx.emit('load', [tempNames[i]], DYNAMIC, l);
    const exitName = ctx.emit('const', ['__exit__'], STRING, l);
    const exitFn = emitPyCall(ctx, 'getattr', [mgrLoad, exitName], l);
    const noneVal = ctx.emit('const', [null], VOID, l);
    emitAwaitedCall_ad(ctx, exitFn.id, [noneVal.id, noneVal.id, noneVal.id], l);
  }
  const finallyBody = ctx.ops;

  ctx.ops = savedOps;
  return ctx.emit('try_region', [], VOID, l, {
    try_body: tryBody,
    catch_param: null,
    catch_body: [],
    finally_body: finallyBody,
  });
}

function lowerClassDef(ctx, node) {
  // Lower class via a _py.createClass runtime helper that mirrors the tree-walker.
  const l = ctx.loc(node);
  const name = node.name;

  // Evaluate bases
  const bases = (node.bases || []).map(b => lowerExpr_ad(ctx, b));
  const basesArr = ctx.emit('array_new', bases.map(b => b.id), DYNAMIC, l);

  // Lower class body as a function that receives an empty object and populates it.
  // The class body is a sequence of statements (method defs, assignments, etc.)
  // that assign to names. We collect them into an object we return.
  const savedOps = ctx.ops;
  const savedTopLevel = ctx.topLevel;
  const savedSymbols = ctx.symbols;

  ctx.topLevel = false;
  ctx.ops = [];
  ctx.symbols = new Map(savedSymbols);

  // Run class body — method defs become locals, assignments become locals
  for (const stmt of node.body) lowerStmt_ad(ctx, stmt);

  // Build the class members dict from the locals
  // We need to track which names were defined in the class body.
  // Use a synthetic approach: collect names via post-analysis of the ops.
  const classMemberNames = [];
  for (const op of ctx.ops) {
    if (op.op === 'store' && typeof op.args[0] === 'string' &&
        !op.args[0].startsWith('__') && !classMemberNames.includes(op.args[0])) {
      classMemberNames.push(op.args[0]);
    }
    // Also catch func_region direct defines
    if (op.op === 'func_region' && op.name && !classMemberNames.includes(op.name)) {
      classMemberNames.push(op.name);
    }
  }
  // Append object literal containing all member names
  const pairs = classMemberNames.map(n => ({
    key: n,
    id: ctx.emit('load', [n], DYNAMIC, l).id,
  }));
  const membersObj = ctx.emit('object_new', pairs, DYNAMIC, l);
  ctx.emit('return', [membersObj.id], VOID, l);

  const body = ctx.ops;
  ctx.ops = savedOps;
  ctx.topLevel = savedTopLevel;
  ctx.symbols = savedSymbols;

  // Wrap body in a function: async () => { ...body; return {...} }
  const bodyFn = ctx.emit('func_region', [null], DYNAMIC, l, {
    name: null, params: [], body, ret_type: DYNAMIC,
    is_async: true, is_generator: false,
  });

  // decorators, bottom-up
  const decorators = (node.decorators || []).map(d => lowerExpr_ad(ctx, d));

  // Call class body to get members
  const membersCall = ctx.emit('call', [bodyFn.id], DYNAMIC, l);
  const membersAwaited = ctx.emit('await', [membersCall.id], DYNAMIC, l);

  // _py.createClass(name, bases, members)
  const nameConst = ctx.emit('const', [name], STRING, l);
  let classOp = emitPyCall(ctx, 'createClass', [nameConst, basesArr, membersAwaited], l);

  // Apply decorators bottom-up
  for (let i = decorators.length - 1; i >= 0; i--) {
    const d = decorators[i];
    const call = ctx.emit('call', [d.id, classOp.id], DYNAMIC, l);
    classOp = ctx.emit('await', [call.id], DYNAMIC, l);
  }

  ctx.emit('store', [name, classOp.id], VOID, l);
  ctx.symbols.set(name, classOp.id);
  if (savedTopLevel) ctx.defines.add(name);
  return null;
}

function lowerImport(ctx, node) {
  const l = ctx.loc(node);
  // import a, b as c, d.e as f, "./utils.py" as u
  for (const { module, alias, path } of node.names) {
    let mod;
    let bindName;
    if (path) {
      // Path import: `import "./utils.py" as u`. Alias always present (required by parser).
      const pathConst = ctx.emit('const', [path], STRING, l);
      const call = emitPyCall(ctx, 'importPath', [pathConst], l);
      mod = ctx.emit('await', [call.id], DYNAMIC, l);
      bindName = alias;
    } else {
      const nameConst = ctx.emit('const', [module], STRING, l);
      // _py.import is async (it may need to async-load a module from VFS), so
      // the emitted call must be awaited. Unlike the sync `_py.*` helpers
      // (add, sub, truthy, ...), the result is a Promise, not the module.
      const call = emitPyCall(ctx, 'import', [nameConst], l);
      mod = ctx.emit('await', [call.id], DYNAMIC, l);
      // For dotted names like `a.b`, bind the top-level `a` unless aliased.
      bindName = alias || module.split('.')[0];
    }
    ctx.emit('store', [bindName, mod.id], VOID, l);
    ctx.symbols.set(bindName, mod.id);
    if (ctx.topLevel) ctx.defines.add(bindName);
  }
  return null;
}

function lowerImportFrom(ctx, node) {
  const l = ctx.loc(node);
  // Build names array: [{name, alias}, ...]
  const pairs = node.names.map(({ name, alias }) => {
    const p = [];
    p.push({ key: 'name', id: ctx.emit('const', [name], STRING, l).id });
    if (alias) p.push({ key: 'alias', id: ctx.emit('const', [alias], STRING, l).id });
    else p.push({ key: 'alias', id: ctx.emit('const', [null], VOID, l).id });
    return ctx.emit('object_new', p, DYNAMIC, l);
  });
  const namesArr = ctx.emit('array_new', pairs.map(p => p.id), DYNAMIC, l);
  // Path form: `from "./utils.py" import foo` → _py.importFromPath(path, names).
  // Logical form: `from os import path` → _py.importFrom(module, names).
  let importCall;
  if (node.path) {
    const pathConst = ctx.emit('const', [node.path], STRING, l);
    importCall = emitPyCall(ctx, 'importFromPath', [pathConst, namesArr], l);
  } else {
    const moduleName = ctx.emit('const', [node.module], STRING, l);
    importCall = emitPyCall(ctx, 'importFrom', [moduleName, namesArr], l);
  }
  const result = ctx.emit('await', [importCall.id], DYNAMIC, l);
  // Destructure result into scope: for each name, bind (alias || name) to result[name]
  for (const { name, alias } of node.names) {
    if (name === '*') continue; // wildcard — would need runtime enumeration
    const bindName = alias || name;
    const keyConst = ctx.emit('const', [bindName], STRING, l);
    const val = emitPyCall(ctx, 'getitem', [result, keyConst], l);
    ctx.emit('store', [bindName, val.id], VOID, l);
    ctx.symbols.set(bindName, val.id);
    if (ctx.topLevel) ctx.defines.add(bindName);
  }
  return null;
}

function lowerDelete(ctx, node) {
  const l = ctx.loc(node);
  for (const target of node.targets) {
    if (target.type === 'Name') {
      // Setting to undefined — not truly `del` but close enough.
      const undef = ctx.emit('const', [undefined], VOID, l);
      ctx.emit('store', [target.id, undef.id], VOID, l);
      ctx.symbols.set(target.id, undef.id);
    } else if (target.type === 'Subscript') {
      const obj = lowerExpr_ad(ctx, target.value);
      const key = lowerExpr_ad(ctx, target.slice);
      emitPyCall(ctx, 'delitem', [obj, key], l, VOID);
    } else if (target.type === 'Attribute') {
      const obj = lowerExpr_ad(ctx, target.value);
      const name = ctx.emit('const', [target.attr], STRING, l);
      emitPyCall(ctx, 'delattr', [obj, name], l, VOID);
    } else {
      throw new AirLowerError(`unsupported del target: ${target.type}`);
    }
  }
  return null;
}

// ── Control flow ──

function lowerIf_ad(ctx, node) {
  const l = ctx.loc(node);
  const test = lowerExpr_ad(ctx, node.test);
  const truthy = emitPyCall(ctx, 'truthy', [test], l, BOOL);

  const savedOps = ctx.ops;

  ctx.ops = [];
  for (const s of node.body) lowerStmt_ad(ctx, s);
  const thenBody = ctx.ops;

  ctx.ops = [];
  if (node.orelse) for (const s of node.orelse) lowerStmt_ad(ctx, s);
  const elseBody = ctx.ops;

  ctx.ops = savedOps;

  return ctx.emit('if_region', [truthy.id], VOID, l, {
    then_body: thenBody,
    else_body: elseBody,
    phis: [],
  });
}

function lowerFor_ad(ctx, node) {
  // for target in iter: body (target may be Name or Tuple/List)
  const l = ctx.loc(node);
  if (node.orelse && node.orelse.length) {
    throw new AirLowerError('for/else not yet supported');
  }

  const iter = lowerExpr_ad(ctx, node.iter);
  const iterArr = emitPyCall(ctx, 'iter', [iter], l);

  // Simple case: target is an Identifier
  if (node.target.type === 'Name') {
    const loopVar = node.target.id;
    const undefOp = ctx.emit('const', [undefined], VOID, l);
    ctx.emit('store', [loopVar, undefOp.id], VOID, l);
    ctx.symbols.set(loopVar, undefOp.id);
    if (ctx.topLevel) ctx.defines.add(loopVar);

    const savedOps = ctx.ops;
    ctx.ops = [];
    for (const s of node.body) lowerStmt_ad(ctx, s);
    const body = ctx.ops;
    ctx.ops = savedOps;

    return ctx.emit('for_of_region', [iterArr.id], VOID, l, {
      body, phis: [], target_name: loopVar,
    });
  }

  // Tuple/List target: use a synthetic temp variable, unpack in body
  if (node.target.type === 'Tuple' || node.target.type === 'List') {
    const tempName = `__forv_${_adderNextId}`;
    // Pre-declare each target element at module scope if top-level
    _preDeclareTargetNames(ctx, node.target, l);

    const savedOps = ctx.ops;
    ctx.ops = [];
    // Unpack temp into target
    const tempLoad = ctx.emit('load', [tempName], DYNAMIC, l);
    for (let i = 0; i < node.target.elts.length; i++) {
      const elt = node.target.elts[i];
      const idx = ctx.emit('const', [i], I32, l);
      const item = emitPyCall(ctx, 'getitem', [tempLoad, idx], l);
      lowerAssignTarget(ctx, elt, item, l);
    }
    for (const s of node.body) lowerStmt_ad(ctx, s);
    const body = ctx.ops;
    ctx.ops = savedOps;

    return ctx.emit('for_of_region', [iterArr.id], VOID, l, {
      body, phis: [], target_name: tempName,
    });
  }

  throw new AirLowerError(`unsupported for-loop target: ${node.target.type}`);
}

function _preDeclareTargetNames(ctx, target, l) {
  if (!target) return;
  if (target.type === 'Name') {
    if (!ctx.symbols.has(target.id)) {
      const undef = ctx.emit('const', [undefined], VOID, l);
      ctx.emit('store', [target.id, undef.id], VOID, l);
      ctx.symbols.set(target.id, undef.id);
      if (ctx.topLevel) ctx.defines.add(target.id);
    }
    return;
  }
  if (target.type === 'Tuple' || target.type === 'List') {
    for (const elt of target.elts) _preDeclareTargetNames(ctx, elt, l);
  }
  if (target.type === 'Starred') _preDeclareTargetNames(ctx, target.value, l);
}

function lowerWhile_ad(ctx, node) {
  const l = ctx.loc(node);
  if (node.orelse && node.orelse.length) {
    throw new AirLowerError('while/else not yet supported');
  }

  const savedOps = ctx.ops;

  ctx.ops = [];
  const test = lowerExpr_ad(ctx, node.test);
  const truthy = emitPyCall(ctx, 'truthy', [test], l, BOOL);
  const testOps = ctx.ops;

  ctx.ops = [];
  for (const s of node.body) lowerStmt_ad(ctx, s);
  const body = ctx.ops;

  ctx.ops = savedOps;

  return ctx.emit('loop_region', [], VOID, l, {
    test: testOps,
    test_val: truthy.id,
    body,
    phis: [],
    loop_kind: 'while',
  });
}

// ── Functions and lambdas ──

// Detect if a function body contains yield (makes it a generator)
function _containsYield(stmts) {
  for (const s of stmts || []) {
    if (!s || typeof s !== 'object') continue;
    if (s.type === 'Yield' || s.type === 'YieldFrom') return true;
    // Don't descend into nested functions/classes/lambdas
    if (s.type === 'FunctionDef' || s.type === 'AsyncFunctionDef' ||
        s.type === 'ClassDef' || s.type === 'Lambda') continue;
    for (const key of Object.keys(s)) {
      if (key === 'type' || key === 'line' || key === 'col') continue;
      const v = s[key];
      if (Array.isArray(v)) { if (_containsYield(v)) return true; }
      else if (v && typeof v === 'object' && v.type) {
        if (_containsYield([v])) return true;
      }
    }
  }
  return false;
}

// Build a parameter list + prologue ops that binds positional/vararg/kwonly/kwarg
// Returns { jsParams, prologueOps } where jsParams is the JS function signature
// and prologueOps are ops to emit at the start of the body.
function _buildParamBinding(ctx, node, l) {
  const positionalParams = node.params || [];
  const kwonly = node.kwonly || [];
  const vararg = node.vararg;
  const kwarg = node.kwarg;

  // JS parameters: all positional (with optional defaults inlined as JS default values
  // via a special dynamic mechanism), then one rest parameter for the remaining.
  // For simplicity we collect everything in ...callArgs and bind in the prologue.
  // Naming: use the original Python parameter names in the body.

  // For the simple fast path (no vararg, no kwarg, no kwonly, no defaults), use native
  // JS params directly. This avoids the prologue overhead for common functions.
  const hasAnyDefault = positionalParams.some(p => p.default);
  const hasKwonly = kwonly.length > 0;
  const isSimple = !vararg && !kwarg && !hasKwonly && !hasAnyDefault;

  if (isSimple) {
    // Fast path: native JS params, with handling for a trailing kwargs bag that
    // may be ignored or matched by name.
    const params = positionalParams.map(p => ({ name: p.name, type: DYNAMIC }));
    // Prologue: strip trailing _kw bag if present (caller may pass kwargs)
    const prologueOps = [];
    return { params, prologueOps, isSimple: true };
  }

  // Complex path: use ...callArgs and bind in prologue.
  // The JS function signature is `function(...__args)`, and we extract from __args.
  const params = [{ name: '...__args', type: DYNAMIC }];

  const savedOps = ctx.ops;
  ctx.ops = [];

  // _kwObj = (last arg has _kw marker) ? args.pop() : null
  // const _kwObj = (__args.length > 0 && __args[__args.length-1]?._kw) ? __args.pop() : null;
  emitRaw(ctx, `let __kw = null;`);
  emitRaw(ctx, `if (__args.length > 0 && __args[__args.length-1] && __args[__args.length-1]._kw) __kw = __args.pop();`);

  // Track parameter names used (for **kwargs exclusion)
  const usedNames = [];

  // Positional parameters
  for (let i = 0; i < positionalParams.length; i++) {
    const p = positionalParams[i];
    usedNames.push(p.name);
    if (p.default) {
      // Evaluate default in case not provided
      const defVal = lowerExpr_ad(ctx, p.default);
      emitRaw(ctx, `let ${p.name} = (__args.length > ${i}) ? __args[${i}] : (__kw && '${p.name}' in __kw ? __kw['${p.name}'] : ${_refExpr(ctx, defVal.id)});`);
    } else {
      emitRaw(ctx, `let ${p.name} = (__args.length > ${i}) ? __args[${i}] : (__kw && '${p.name}' in __kw ? __kw['${p.name}'] : (() => { throw new Error("${node.name || '<fn>'}() missing required argument: '${p.name}'"); })());`);
    }
    ctx.symbols.set(p.name, null);
  }

  // *args — vararg
  if (vararg) {
    emitRaw(ctx, `let ${vararg} = __args.slice(${positionalParams.length});`);
    ctx.symbols.set(vararg, null);
    usedNames.push(vararg);
  }

  // Keyword-only params
  for (const p of kwonly) {
    usedNames.push(p.name);
    if (p.default) {
      const defVal = lowerExpr_ad(ctx, p.default);
      emitRaw(ctx, `let ${p.name} = (__kw && '${p.name}' in __kw) ? __kw['${p.name}'] : ${_refExpr(ctx, defVal.id)};`);
    } else {
      emitRaw(ctx, `let ${p.name} = (__kw && '${p.name}' in __kw) ? __kw['${p.name}'] : (() => { throw new Error("${node.name || '<fn>'}() missing keyword argument: '${p.name}'"); })();`);
    }
    ctx.symbols.set(p.name, null);
  }

  // **kwargs — collect remaining
  if (kwarg) {
    const excludeList = [...usedNames, '_kw'].map(n => `'${n}'`).join(',');
    emitRaw(ctx, `let ${kwarg} = {}; if (__kw) { const __used = new Set([${excludeList}]); for (const __k in __kw) if (!__used.has(__k)) ${kwarg}[__k] = __kw[__k]; }`);
    ctx.symbols.set(kwarg, null);
  }

  const prologueOps = ctx.ops;
  ctx.ops = savedOps;
  return { params, prologueOps, isSimple: false };
}

// Helper: emit a raw JS line via an 'opaque' op (statement-level)
function emitRaw(ctx, jsLine) {
  ctx.emit('opaque', [jsLine], VOID, null);
}

// Helper: stringify SSA id into a ref that the emitter will resolve.
// Since we're building raw JS strings for prologue, we need the SSA value as a JS expression.
// Approach: emit a store to a synthetic name, then use that name in the raw line.
function _refExpr(ctx, ssaId) {
  // Emit a store to a fresh name, then reference it
  const name = `__tmp_${ssaId.slice(1)}`;
  ctx.emit('store', [name, ssaId], VOID, null);
  ctx.symbols.set(name, ssaId);
  return name;
}

function lowerFuncDef(ctx, node) {
  const l = ctx.loc(node);
  const name = node.name;
  const isGenerator = _containsYield(node.body);

  // Lower decorators (evaluated at def time, applied bottom-up after def)
  const decorators = (node.decorators || []).map(d => lowerExpr_ad(ctx, d));

  // Lower body in nested scope
  const savedTopLevel = ctx.topLevel;
  const savedOps = ctx.ops;
  const savedSymbols = ctx.symbols;

  ctx.topLevel = false;
  ctx.ops = [];
  ctx.symbols = new Map(savedSymbols);

  // Build parameter binding (prologue + JS params)
  const { params, prologueOps, isSimple } = _buildParamBinding(ctx, node, l);

  // Emit prologue ops
  for (const op of prologueOps) ctx.ops.push(op);

  // Docstring skip (first string expression)
  let startIdx = 0;
  if (node.body.length > 0 && node.body[0].type === 'Expr' &&
      node.body[0].value.type === 'Constant' &&
      typeof node.body[0].value.value === 'string') {
    startIdx = 1;
  }
  for (let i = startIdx; i < node.body.length; i++) lowerStmt_ad(ctx, node.body[i]);
  const body = ctx.ops;

  ctx.ops = savedOps;
  ctx.topLevel = savedTopLevel;
  ctx.symbols = savedSymbols;

  const op = ctx.emit('func_region', [name], DYNAMIC, l, {
    name, params, body, ret_type: DYNAMIC,
    // Async in transpile (for builtin await) unless generator
    is_async: !isGenerator,
    is_generator: isGenerator,
  });

  // Always emit a store so the function name is visible in the enclosing scope.
  // (At module scope, this becomes `let name = funcExpr` via the emitter.
  //  At function scope, nested defs also need to be stored so sibling code can see them.)
  ctx.emit('store', [name, op.id], VOID, l);
  ctx.symbols.set(name, op.id);
  let finalId = op.id;

  // Apply decorators bottom-up: name = decorator(name)
  for (let i = decorators.length - 1; i >= 0; i--) {
    const dec = decorators[i];
    const loadFn = ctx.emit('load', [name], DYNAMIC, l);
    const call = ctx.emit('call', [dec.id, loadFn.id], DYNAMIC, l);
    const awaited = ctx.emit('await', [call.id], DYNAMIC, l);
    ctx.emit('store', [name, awaited.id], VOID, l);
    ctx.symbols.set(name, awaited.id);
    finalId = awaited.id;
  }

  if (ctx.topLevel) {
    ctx.defines.add(name);
    ctx.symbols.set(name, finalId);
  }

  return op;
}

function lowerLambda(ctx, node) {
  const l = ctx.loc(node);
  const savedTopLevel = ctx.topLevel;
  const savedOps = ctx.ops;
  const savedSymbols = ctx.symbols;

  ctx.topLevel = false;
  ctx.ops = [];
  ctx.symbols = new Map(savedSymbols);

  // Reuse the function param binding logic
  const { params, prologueOps } = _buildParamBinding(ctx, node, l);
  for (const op of prologueOps) ctx.ops.push(op);

  const val = lowerExpr_ad(ctx, node.body);
  ctx.emit('return', [val.id], VOID, l);
  const body = ctx.ops;

  ctx.ops = savedOps;
  ctx.topLevel = savedTopLevel;
  ctx.symbols = savedSymbols;

  return ctx.emit('func_region', [null], DYNAMIC, l, {
    name: null, params, body, ret_type: DYNAMIC,
    is_async: true, is_generator: false,
  });
}

// ── List comprehension ──
// [expr for target in iter if cond ...] → loop + array.push

function lowerListOrTuple(ctx, node) {
  const l = ctx.loc(node);
  // If no starred elements, use array_new directly
  const hasStarred = node.elts.some(e => e.type === 'Starred');
  if (!hasStarred) {
    const elts = node.elts.map(e => lowerExpr_ad(ctx, e).id);
    return ctx.emit('array_new', elts, DYNAMIC, l);
  }
  // With starred elements: build via _py.buildList which flattens starred iterables
  const parts = node.elts.map(e => {
    if (e.type === 'Starred') {
      const inner = lowerExpr_ad(ctx, e.value);
      return { spread: true, id: inner.id };
    }
    return { spread: false, id: lowerExpr_ad(ctx, e).id };
  });
  // Emit object with spread markers — use object_new with mixed spread/plain
  // Actually, easier: use _py.buildList with an array of {spread, value} pairs.
  // Simplest JS: emit an array literal with ...spread directly.
  const argIds = [];
  for (const p of parts) {
    if (p.spread) {
      argIds.push(ctx.emit('spread', [p.id], DYNAMIC, l).id);
    } else {
      argIds.push(p.id);
    }
  }
  return ctx.emit('array_new', argIds, DYNAMIC, l);
}

function lowerComprehension(ctx, node) {
  const l = ctx.loc(node);
  const kind = node.type; // 'ListComp' | 'SetComp' | 'DictComp' | 'GeneratorExp'

  // Result storage depends on kind
  let tempName, initOp;
  if (kind === 'ListComp' || kind === 'GeneratorExp') {
    initOp = ctx.emit('array_new', [], DYNAMIC, l);
    tempName = '__comp_' + _adderNextId;
  } else if (kind === 'SetComp') {
    const arr = ctx.emit('array_new', [], DYNAMIC, l);
    initOp = emitPyCall(ctx, 'makeSet', [arr], l);
    tempName = '__setc_' + _adderNextId;
  } else {
    // DictComp — use a Map
    const empty1 = ctx.emit('array_new', [], DYNAMIC, l);
    const empty2 = ctx.emit('array_new', [], DYNAMIC, l);
    initOp = emitPyCall(ctx, 'makeDict', [empty1, empty2], l);
    tempName = '__dictc_' + _adderNextId;
  }
  ctx.emit('store', [tempName, initOp.id], VOID, l);
  ctx.symbols.set(tempName, initOp.id);

  function buildComp(genIdx) {
    if (genIdx >= node.generators.length) {
      // innermost: append/add/set to result
      const loadResult = ctx.emit('load', [tempName], DYNAMIC, l);
      if (kind === 'ListComp' || kind === 'GeneratorExp') {
        const val = lowerExpr_ad(ctx, node.elt);
        ctx.emit('call_method', [loadResult.id, 'push', val.id], VOID, l);
      } else if (kind === 'SetComp') {
        const val = lowerExpr_ad(ctx, node.elt);
        ctx.emit('call_method', [loadResult.id, 'add', val.id], VOID, l);
      } else {
        // DictComp: key and value
        const key = lowerExpr_ad(ctx, node.key);
        const val = lowerExpr_ad(ctx, node.value);
        ctx.emit('call_method', [loadResult.id, 'set', key.id, val.id], VOID, l);
      }
      return;
    }
    const gen = node.generators[genIdx];
    const iter = lowerExpr_ad(ctx, gen.iter);
    const iterArr = emitPyCall(ctx, 'iter', [iter], l);

    const savedOps = ctx.ops;
    ctx.ops = [];

    // Handle target (Name or Tuple/List for unpacking)
    let targetName;
    if (gen.target.type === 'Name') {
      targetName = gen.target.id;
      ctx.symbols.set(targetName, null);
    } else if (gen.target.type === 'Tuple' || gen.target.type === 'List') {
      targetName = `__gen_${_adderNextId}`;
      _preDeclareTargetNames(ctx, gen.target, l);
      // Unpack inside the loop body
      const tempLoad = ctx.emit('load', [targetName], DYNAMIC, l);
      for (let i = 0; i < gen.target.elts.length; i++) {
        const elt = gen.target.elts[i];
        const idx = ctx.emit('const', [i], I32, l);
        const item = emitPyCall(ctx, 'getitem', [tempLoad, idx], l);
        lowerAssignTarget(ctx, elt, item, l);
      }
    } else {
      throw new AirLowerError('unsupported comprehension target type');
    }

    function withFilters(filterIdx) {
      if (!gen.ifs || filterIdx >= gen.ifs.length) {
        buildComp(genIdx + 1);
        return;
      }
      const cond = lowerExpr_ad(ctx, gen.ifs[filterIdx]);
      const truthy = emitPyCall(ctx, 'truthy', [cond], l, BOOL);
      const savedInner = ctx.ops;
      ctx.ops = [];
      withFilters(filterIdx + 1);
      const thenBody = ctx.ops;
      ctx.ops = savedInner;
      ctx.emit('if_region', [truthy.id], VOID, l, {
        then_body: thenBody, else_body: [], phis: [],
      });
    }
    withFilters(0);

    const body = ctx.ops;
    ctx.ops = savedOps;

    ctx.emit('for_of_region', [iterArr.id], VOID, l, {
      body, phis: [], target_name: targetName,
    });
  }

  buildComp(0);

  return ctx.emit('load', [tempName], DYNAMIC, l);
}
