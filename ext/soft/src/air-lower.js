// @gcu/air — Soft → AIR lowerer
// Soft is simpler than Python: direct JS arithmetic, JS-semantic comparison,
// no dunder methods, no classes. Result: fewer _soft helper calls than _py needed.

import { I32, F64, BOOL, STRING, VOID, DYNAMIC } from '../../air/src/types.js';
import { BaseLowerCtx, captureOps, emitPhiSelect, AirLowerError } from '../../air/src/lower/base.js';

// Soft historically used SoftLowerError as the in-frontend name; both
// it and AirLowerError now alias to the base class so the
// `_airFallback: true` contract is consistent across frontends.
export { AirLowerError };
export const SoftLowerError = AirLowerError;

// SoftLowerCtx is just BaseLowerCtx with a Soft-specific loc(): Soft AST
// nodes carry `node.line` but no column. The shared base provides ops /
// symbols / types / topLevel / defines / imports / source / emit / id
// generation.
class SoftLowerCtx extends BaseLowerCtx {
  loc(node) {
    return node?.line != null ? { line: node.line, col: 0 } : null;
  }
}

// _soft.XYZ call — thin wrapper over the shared emitNamespacedCall.
function emitSoftCall(ctx, method, args, loc, type) {
  return ctx.emitNamespacedCall('_soft', method, args, loc, type);
}

function emitAwaitedCall_sf(ctx, fnId, argIds, loc, type) {
  const call = ctx.emit('call', [fnId, ...argIds], type || DYNAMIC, loc);
  return ctx.emit('await', [call.id], type || DYNAMIC, loc);
}

// Collect top-level defines from the AST (Set, Define, Capture, Use)
function collectDefines_sf(body, defines) {
  for (const node of body || []) {
    switch (node.type) {
      case 'Set': defines.add(node.name); break;
      case 'Define': defines.add(node.name); break;
      case 'Capture': defines.add(node.name); break;
      case 'Use': defines.add(node.alias || node.path.split('.').pop()); break;
      case 'Load': if (node.name) defines.add(node.name); break;
      case 'Take': defines.add(node.name); break;
      case 'PipeCalled': if (node.name) defines.add(node.name); break;
      case 'If':
        collectDefines_sf(node.body, defines);
        if (node.elseBody) collectDefines_sf(node.elseBody, defines);
        break;
      case 'While': case 'Repeat':
        collectDefines_sf(node.body, defines);
        break;
      case 'ForEach':
        defines.add(node.varName);
        collectDefines_sf(node.body, defines);
        break;
      case 'RangeLoop':
        defines.add(node.varName);
        collectDefines_sf(node.body, defines);
        break;
    }
  }
}

export function lowerSoft(ast, source) {
  // SSA id counter lives on SoftLowerCtx instance via BaseLowerCtx's
  // _idGen; no module-level reset.
  const ctx = new SoftLowerCtx();
  ctx.source = source || null;

  if (ast.type !== 'Program') throw new SoftLowerError('Expected Program node');

  collectDefines_sf(ast.body, ctx.defines);

  // Identify names that will be declared by `Define` (function syntax-like)
  const funcNames = new Set();
  for (const stmt of ast.body) {
    if (stmt.type === 'Define') funcNames.add(stmt.name);
  }

  // Pre-declare all module-level defines (except functions)
  for (const name of ctx.defines) {
    if (name === '__lastExpr__') continue;
    if (funcNames.has(name)) continue;
    const undef = ctx.emit('const', [undefined], VOID, null);
    ctx.emit('store', [name, undef.id], VOID, null);
    ctx.symbols.set(name, undef.id);
  }

  for (const stmt of ast.body) lowerStmt_sf(ctx, stmt);

  const exports = new Map();
  for (const name of ctx.defines) {
    const ssaId = ctx.symbols.get(name);
    const type = ssaId ? (ctx.types.get(ssaId) || DYNAMIC) : DYNAMIC;
    exports.set(name, { ssa_name: ssaId || null, type });
  }

  return {
    ops: ctx.ops,
    symbol_table: ctx.symbols.flatten(),
    exports,
    imports: new Set(ctx.imports),
    defines: new Set(ctx.defines),
    side_effects: true,
  };
}

// ── Statement lowering ──

function lowerStmt_sf(ctx, node) {
  if (!node) return null;
  const l = ctx.loc(node);

  switch (node.type) {
    case 'Set': return lowerSet(ctx, node);
    case 'Define': return lowerDefine(ctx, node);
    case 'Say': return lowerSay(ctx, node);
    case 'If': return lowerIf_sf(ctx, node);
    case 'While': return lowerWhile_sf(ctx, node);
    case 'ForEach': return lowerForEach(ctx, node);
    case 'RangeLoop': return lowerRangeLoop(ctx, node);
    case 'Repeat': return lowerRepeat(ctx, node);
    case 'Return': {
      const val = node.value ? lowerExpr_sf(ctx, node.value) : ctx.emit('const', [null], VOID, l);
      ctx.emit('return', [val.id], VOID, l);
      return null;
    }
    case 'ExprStmt': return lowerExpr_sf(ctx, node.expr);
    case 'Capture': return lowerCapture(ctx, node);
    case 'Stop': ctx.emit('break', [], VOID, l); return null;
    case 'Skip': ctx.emit('continue', [], VOID, l); return null;
    case 'Add': return lowerAddRemove(ctx, node, 'add');
    case 'Remove': return lowerAddRemove(ctx, node, 'remove');
    case 'Assume': return lowerAssume(ctx, node);
    case 'Explain': return null; // no-op for transpile

    // Fallback for complex constructs
    case 'Try':
    case 'Suppose':
    case 'Use':
    case 'On':
    case 'Load':
    case 'Save':
    case 'Make':
    case 'SetOf':
    case 'SetChunk':
    case 'Take':
    case 'Filter': case 'Sort': case 'Aggregate': case 'Count':
    case 'Limit': case 'Group': case 'Pick': case 'Round': case 'With':
    case 'PipeCalled': case 'Pipeline': case 'PipeCall':
      throw new SoftLowerError(`Soft: ${node.type} not yet supported in transpile`);

    default:
      throw new SoftLowerError(`Soft: unsupported statement: ${node.type}`);
  }
}

// ── Expression lowering ──

function lowerExpr_sf(ctx, node) {
  if (!node) return ctx.emit('const', [null], VOID, null);
  const l = ctx.loc(node);

  switch (node.type) {
    case 'Num': {
      const v = node.value;
      const isInt = Number.isInteger(v) && v >= -2147483648 && v <= 2147483647;
      return ctx.emit('const', [v], isInt ? I32 : F64, l);
    }
    case 'Str': return ctx.emit('const', [node.value], STRING, l);
    case 'Bool': return ctx.emit('const', [node.value], BOOL, l);
    case 'Nothing': return ctx.emit('const', [null], DYNAMIC, l);
    case 'Ref': return lowerRef(ctx, node);
    case 'Group': return lowerExpr_sf(ctx, node.expr);

    case 'BinOp': return lowerBinOp_sf(ctx, node);
    case 'Unary': return lowerUnary_sf(ctx, node);
    case 'Compare': return lowerCompare_sf(ctx, node);
    case 'Logic': return lowerLogic(ctx, node);
    case 'Between': return lowerBetween(ctx, node);
    case 'TypeCheck': return lowerTypeCheck(ctx, node);
    case 'Ternary': return lowerTernary(ctx, node);

    case 'Of': return lowerOf(ctx, node);
    case 'LengthOf': {
      const e = lowerExpr_sf(ctx, node.expr);
      return emitSoftCall(ctx, 'lengthOf', [e], l);
    }

    case 'Call': return lowerCall_sf(ctx, node);
    case 'Invoke': return lowerInvoke(ctx, node);

    case 'List': {
      const items = node.items.map(e => lowerExpr_sf(ctx, e).id);
      return ctx.emit('array_new', items, DYNAMIC, l);
    }

    case 'Record': return lowerRecord(ctx, node);
    case 'RecordWith': return lowerRecordWith(ctx, node);

    case 'Juxtapose': {
      // String concat — a & b & c or implicit juxtaposition in say
      const parts = node.parts.map(p => lowerExpr_sf(ctx, p));
      if (parts.length === 0) return ctx.emit('const', [''], STRING, l);
      let result = emitSoftCall(ctx, 'str', [parts[0]], l, STRING);
      for (let i = 1; i < parts.length; i++) {
        const s = emitSoftCall(ctx, 'str', [parts[i]], l, STRING);
        result = ctx.emit('add', [result.id, s.id], STRING, l);
      }
      return result;
    }

    case 'Chunk': {
      const target = lowerExpr_sf(ctx, node.target);
      const index = lowerExpr_sf(ctx, node.index);
      const kind = ctx.emit('const', [node.kind], STRING, l);
      return emitSoftCall(ctx, 'chunk', [kind, index, target], l);
    }
    case 'ChunkRange': {
      const target = lowerExpr_sf(ctx, node.target);
      const from = lowerExpr_sf(ctx, node.from);
      const to = lowerExpr_sf(ctx, node.to);
      const kind = ctx.emit('const', [node.kind], STRING, l);
      return emitSoftCall(ctx, 'chunkRange', [kind, from, to, target], l);
    }
    case 'CountChunks': {
      const e = lowerExpr_sf(ctx, node.expr);
      const kind = ctx.emit('const', [node.kind], STRING, l);
      return emitSoftCall(ctx, 'countChunks', [kind, e], l);
    }

    case 'ThereIs': {
      // There is X — X in scope and not null/undefined
      if (!ctx.symbols.has(node.name) && !ctx.defines.has(node.name)) {
        ctx.imports.add(node.name);
      }
      // Emit: (x !== undefined && x !== null)
      const load = ctx.emit('load', [node.name], DYNAMIC, l);
      const undef = ctx.emit('const', [undefined], VOID, l);
      const nullVal = ctx.emit('const', [null], VOID, l);
      const notUndef = ctx.emit('neq', [load.id, undef.id], BOOL, l);
      const notNull = ctx.emit('neq', [load.id, nullVal.id], BOOL, l);
      return ctx.emit('logical_and', [notUndef.id, notNull.id], BOOL, l);
    }
    case 'ThereIsNo': {
      if (!ctx.symbols.has(node.name) && !ctx.defines.has(node.name)) {
        ctx.imports.add(node.name);
      }
      const load = ctx.emit('load', [node.name], DYNAMIC, l);
      const undef = ctx.emit('const', [undefined], VOID, l);
      const nullVal = ctx.emit('const', [null], VOID, l);
      const isUndef = ctx.emit('eq', [load.id, undef.id], BOOL, l);
      const isNull = ctx.emit('eq', [load.id, nullVal.id], BOOL, l);
      return ctx.emit('logical_or', [isUndef.id, isNull.id], BOOL, l);
    }

    case 'Regex':
      throw new SoftLowerError('Soft: Regex not yet supported');

    case 'RoundExpr':
    case 'PipeCall':
      throw new SoftLowerError(`Soft: ${node.type} not yet supported in transpile`);

    default:
      throw new SoftLowerError(`Soft: unsupported expression: ${node.type}`);
  }
}

// ── Reference ──

function lowerRef(ctx, node) {
  const l = ctx.loc(node);
  const name = node.name;
  if (name.includes('.')) {
    // Dot path: resolve as Of chain
    const parts = name.split('.');
    const rootName = parts[0];
    if (!ctx.symbols.has(rootName) && !ctx.defines.has(rootName)) {
      ctx.imports.add(rootName);
    }
    let v = ctx.emit('load', [rootName], DYNAMIC, l);
    for (let i = 1; i < parts.length; i++) {
      v = ctx.emit('object_get', [v.id, parts[i]], DYNAMIC, l);
    }
    return v;
  }
  if (!ctx.symbols.has(name) && !ctx.defines.has(name)) {
    ctx.imports.add(name);
  }
  return ctx.emit('load', [name], DYNAMIC, l);
}

// ── BinOp / Unary / Compare / Logic ──

const BINOP_TO_AIR = {
  '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'mod', '**': 'exp',
  '<<': 'shift_left', '>>': 'shift_right',
  'bitand': 'bitwise_and', 'bitor': 'bitwise_or', 'bitxor': 'bitwise_xor',
};

function lowerBinOp_sf(ctx, node) {
  const l = ctx.loc(node);
  if (node.op === '&') {
    // String concat — softString both, then +
    const left = lowerExpr_sf(ctx, node.left);
    const right = lowerExpr_sf(ctx, node.right);
    const ls = emitSoftCall(ctx, 'str', [left], l, STRING);
    const rs = emitSoftCall(ctx, 'str', [right], l, STRING);
    return ctx.emit('add', [ls.id, rs.id], STRING, l);
  }
  const airOp = BINOP_TO_AIR[node.op];
  if (!airOp) throw new SoftLowerError(`Soft: unknown binop ${node.op}`);
  const left = lowerExpr_sf(ctx, node.left);
  const right = lowerExpr_sf(ctx, node.right);
  // Soft uses direct JS arithmetic — no runtime dispatch. Result type
  // is dynamic (could be number, string concat via '+', etc.) but we
  // emit the JS op directly which is correct.
  const typeHint = airOp === 'shift_left' || airOp === 'shift_right' ||
    airOp.startsWith('bitwise_') ? I32 : DYNAMIC;
  return ctx.emit(airOp, [left.id, right.id], typeHint, l);
}

function lowerUnary_sf(ctx, node) {
  const l = ctx.loc(node);
  const arg = lowerExpr_sf(ctx, node.expr);
  switch (node.op) {
    case 'not': {
      // !_soft.truthy(v) — Soft's "not" uses its own truthiness
      const truthy = emitSoftCall(ctx, 'truthy', [arg], l, BOOL);
      return ctx.emit('logical_not', [truthy.id], BOOL, l);
    }
    case 'neg': return ctx.emit('neg', [arg.id], DYNAMIC, l);
    case 'bitnot': return ctx.emit('bitwise_not', [arg.id], I32, l);
    default: throw new SoftLowerError(`Soft: unknown unary ${node.op}`);
  }
}

function lowerCompare_sf(ctx, node) {
  const l = ctx.loc(node);
  const left = lowerExpr_sf(ctx, node.left);
  const right = lowerExpr_sf(ctx, node.right);
  switch (node.op) {
    case '<': return ctx.emit('lt', [left.id, right.id], BOOL, l);
    case '>': return ctx.emit('gt', [left.id, right.id], BOOL, l);
    case '<=': return ctx.emit('lte', [left.id, right.id], BOOL, l);
    case '>=': return ctx.emit('gte', [left.id, right.id], BOOL, l);
    case '==':
      // Case-insensitive for strings — use _soft.eq helper
      return emitSoftCall(ctx, 'eq', [left, right], l, BOOL);
    case '!=':
      return emitSoftCall(ctx, 'neq', [left, right], l, BOOL);
    case 'contains':
      return emitSoftCall(ctx, 'contains', [left, right], l, BOOL);
    case 'matches':
      return emitSoftCall(ctx, 'matches', [left, right], l, BOOL);
    default: throw new SoftLowerError(`Soft: unknown comparison ${node.op}`);
  }
}

function lowerLogic(ctx, node) {
  const l = ctx.loc(node);
  // Soft's and/or: short-circuit, return actual value not bool
  // a and b → truthy(a) ? b : a
  // a or b  → truthy(a) ? a : b
  const left = lowerExpr_sf(ctx, node.left);
  const truthy = emitSoftCall(ctx, 'truthy', [left], l, BOOL);
  // and: if truthy(left) → right else → left
  // or:  if truthy(left) → left else → right
  return emitPhiSelect(ctx, truthy.id,
    node.op === 'and' ? () => lowerExpr_sf(ctx, node.right) : () => left,
    node.op === 'and' ? () => left : () => lowerExpr_sf(ctx, node.right),
    l, DYNAMIC);
}

function lowerBetween(ctx, node) {
  const l = ctx.loc(node);
  const v = lowerExpr_sf(ctx, node.value);
  const lo = lowerExpr_sf(ctx, node.lo);
  const hi = lowerExpr_sf(ctx, node.hi);
  return emitSoftCall(ctx, 'between', [v, lo, hi], l, BOOL);
}

function lowerTypeCheck(ctx, node) {
  const l = ctx.loc(node);
  const e = lowerExpr_sf(ctx, node.expr);
  const tn = ctx.emit('const', [node.typeName], STRING, l);
  return emitSoftCall(ctx, 'isType', [e, tn], l, BOOL);
}

function lowerTernary(ctx, node) {
  const l = ctx.loc(node);
  // X if cond otherwise Y → _soft.truthy(cond) ? X : Y
  const cond = lowerExpr_sf(ctx, node.cond);
  const truthy = emitSoftCall(ctx, 'truthy', [cond], l, BOOL);
  return emitPhiSelect(ctx, truthy.id,
    () => lowerExpr_sf(ctx, node.ifTrue),
    () => lowerExpr_sf(ctx, node.ifFalse),
    l, DYNAMIC);
}

// ── Of: x of y → y.x (with null-safety) ──

function lowerOf(ctx, node) {
  const l = ctx.loc(node);
  const obj = lowerExpr_sf(ctx, node.obj);
  // node.prop is a node like Ref — get its name
  let propName;
  if (node.prop.type === 'Ref') propName = node.prop.name;
  else if (node.prop.type === 'Str') propName = node.prop.value;
  else {
    // Computed — use array_get (dynamic property)
    const prop = lowerExpr_sf(ctx, node.prop);
    return emitSoftCall(ctx, 'of', [obj, prop], l);
  }
  const name = ctx.emit('const', [propName], STRING, l);
  return emitSoftCall(ctx, 'of', [obj, name], l);
}

// ── Call ──

function lowerCall_sf(ctx, node) {
  const l = ctx.loc(node);
  const name = node.name;
  const args = node.args.map(a => lowerExpr_sf(ctx, a));

  // Dotted names (Text.upper, List.reverse, etc.) — lower as nested object_gets + call
  if (name.includes('.')) {
    const parts = name.split('.');
    const rootName = parts[0];
    if (!ctx.symbols.has(rootName) && !ctx.defines.has(rootName)) {
      ctx.imports.add(rootName);
    }
    let fn = ctx.emit('load', [rootName], DYNAMIC, l);
    for (let i = 1; i < parts.length; i++) {
      fn = ctx.emit('object_get', [fn.id, parts[i]], DYNAMIC, l);
    }
    return emitAwaitedCall_sf(ctx, fn.id, args.map(a => a.id), l);
  }

  if (!ctx.symbols.has(name) && !ctx.defines.has(name)) {
    ctx.imports.add(name);
  }
  const fn = ctx.emit('load', [name], DYNAMIC, l);
  return emitAwaitedCall_sf(ctx, fn.id, args.map(a => a.id), l);
}

function lowerInvoke(ctx, node) {
  const l = ctx.loc(node);
  const fn = lowerExpr_sf(ctx, node.expr);
  const args = node.args.map(a => lowerExpr_sf(ctx, a));
  // Use _soft.invoke to handle the "already resolved to non-function" case
  const argsArr = ctx.emit('array_new', args.map(a => a.id), DYNAMIC, l);
  const call = emitSoftCall(ctx, 'invoke', [fn, argsArr], l);
  return ctx.emit('await', [call.id], DYNAMIC, l);
}

// ── Records ──

function lowerRecord(ctx, node) {
  const l = ctx.loc(node);
  const pairs = node.fields.map(f => ({
    key: f.name,
    id: lowerExpr_sf(ctx, f.value).id,
  }));
  return ctx.emit('object_new', pairs, DYNAMIC, l);
}

function lowerRecordWith(ctx, node) {
  // Same as Record — field names spell out the shape
  return lowerRecord(ctx, node);
}

// ── Set ──

function lowerSet(ctx, node) {
  const l = ctx.loc(node);
  const val = lowerExpr_sf(ctx, node.value);
  ctx.emit('store', [node.name, val.id], VOID, l);
  ctx.symbols.set(node.name, val.id);
  if (ctx.topLevel) ctx.defines.add(node.name);
  return null;
}

// ── Define (function) ──

function lowerDefine(ctx, node) {
  const l = ctx.loc(node);
  const name = node.name;

  // Extract params from signature. Soft sig is an array of { param, variadic? }
  const params = [];
  for (const s of node.sig || []) {
    if (typeof s === 'object' && s !== null && s.param) {
      if (s.variadic) {
        params.push({ name: '...' + s.param, type: DYNAMIC });
      } else {
        params.push({ name: s.param, type: DYNAMIC });
      }
    }
  }

  const savedTopLevel = ctx.topLevel;
  ctx.topLevel = false;
  ctx.symbols = ctx.symbols.push();
  for (const p of params) {
    const pname = p.name.replace(/^\.\.\./, '');
    ctx.symbols.set(pname, null);
  }
  // Soft functions use `it` as implicit result
  ctx.symbols.set('it', null);

  const body = captureOps(ctx, () => {
    for (const s of node.body) lowerStmt_sf(ctx, s);
  });

  ctx.topLevel = savedTopLevel;
  ctx.symbols = ctx.symbols.pop();

  const op = ctx.emit('func_region', [name], DYNAMIC, l, {
    name, params, body, ret_type: DYNAMIC,
    is_async: true,
    is_generator: false,
  });

  ctx.emit('store', [name, op.id], VOID, l);
  ctx.symbols.set(name, op.id);
  if (ctx.topLevel) ctx.defines.add(name);
  return op;
}

// ── Say ──

function lowerSay(ctx, node) {
  const l = ctx.loc(node);
  const val = lowerExpr_sf(ctx, node.value);
  // Soft's say calls `say` builtin (or the cell's display). Just call `say`.
  if (!ctx.symbols.has('say') && !ctx.defines.has('say')) {
    ctx.imports.add('say');
  }
  const sayFn = ctx.emit('load', ['say'], DYNAMIC, l);
  return emitAwaitedCall_sf(ctx, sayFn.id, [val.id], l);
}

// ── If / While / ForEach / RangeLoop / Repeat ──

function lowerIf_sf(ctx, node) {
  const l = ctx.loc(node);
  const cond = lowerExpr_sf(ctx, node.cond);
  const truthy = emitSoftCall(ctx, 'truthy', [cond], l, BOOL);
  const thenBody = captureOps(ctx, () => {
    for (const s of node.body) lowerStmt_sf(ctx, s);
  });
  const elseBody = captureOps(ctx, () => {
    if (node.elseBody) for (const s of node.elseBody) lowerStmt_sf(ctx, s);
  });
  return ctx.emit('if_region', [truthy.id], VOID, l, {
    then_body: thenBody, else_body: elseBody, phis: [],
  });
}

function lowerWhile_sf(ctx, node) {
  const l = ctx.loc(node);
  let truthy = null;
  const testOps = captureOps(ctx, () => {
    const cond = lowerExpr_sf(ctx, node.cond);
    truthy = emitSoftCall(ctx, 'truthy', [cond], l, BOOL);
  });
  const body = captureOps(ctx, () => {
    for (const s of node.body) lowerStmt_sf(ctx, s);
  });
  return ctx.emit('loop_region', [], VOID, l, {
    test: testOps, test_val: truthy.id,
    body, phis: [], loop_kind: 'while',
  });
}

function lowerForEach(ctx, node) {
  const l = ctx.loc(node);
  const iter = lowerExpr_sf(ctx, node.iter);
  // Pre-declare var
  if (ctx.topLevel) ctx.defines.add(node.varName);
  const body = captureOps(ctx, () => {
    for (const s of node.body) lowerStmt_sf(ctx, s);
  });
  return ctx.emit('for_of_region', [iter.id], VOID, l, {
    body, phis: [], target_name: node.varName,
  });
}

function lowerRangeLoop(ctx, node) {
  const l = ctx.loc(node);
  // for each i from X to Y [by step]: body
  // Lower as: let i = X; while (step > 0 ? i <= Y : i >= Y) { body; i += step }
  // Use a standard for_region.
  const varName = node.varName;
  if (ctx.topLevel) ctx.defines.add(varName);

  const initOps = captureOps(ctx, () => {
    const from = lowerExpr_sf(ctx, node.from);
    ctx.emit('store', [varName, from.id], VOID, l);
    ctx.symbols.set(varName, from.id);
  });
  let testOp = null;
  const testOps = captureOps(ctx, () => {
    const to = lowerExpr_sf(ctx, node.to);
    const vLoad = ctx.emit('load', [varName], DYNAMIC, l);
    testOp = ctx.emit('lte', [vLoad.id, to.id], BOOL, l);
  });
  const updateOps = captureOps(ctx, () => {
    const stepVal = node.step ? lowerExpr_sf(ctx, node.step) : ctx.emit('const', [1], I32, l);
    const vLoad2 = ctx.emit('load', [varName], DYNAMIC, l);
    const newV = ctx.emit('add', [vLoad2.id, stepVal.id], DYNAMIC, l);
    ctx.emit('store', [varName, newV.id], VOID, l);
  });
  const body = captureOps(ctx, () => {
    for (const s of node.body) lowerStmt_sf(ctx, s);
  });

  return ctx.emit('for_region', [], VOID, l, {
    init: initOps,
    test: testOps,
    test_val: testOp.id,
    update: updateOps,
    body,
    phis: [],
  });
}

function lowerRepeat(ctx, node) {
  const l = ctx.loc(node);
  // repeat N times: body → for-loop 0..N
  const countExpr = lowerExpr_sf(ctx, node.count);
  const tempVar = ctx.makeTempName('rep');

  const initOps = captureOps(ctx, () => {
    const zero = ctx.emit('const', [0], I32, l);
    ctx.emit('store', [tempVar, zero.id], VOID, l);
    ctx.symbols.set(tempVar, zero.id);
  });
  let testOp = null;
  const testOps = captureOps(ctx, () => {
    const vLoad = ctx.emit('load', [tempVar], DYNAMIC, l);
    testOp = ctx.emit('lt', [vLoad.id, countExpr.id], BOOL, l);
  });
  const updateOps = captureOps(ctx, () => {
    const one = ctx.emit('const', [1], I32, l);
    const vLoad2 = ctx.emit('load', [tempVar], DYNAMIC, l);
    const newV = ctx.emit('add', [vLoad2.id, one.id], I32, l);
    ctx.emit('store', [tempVar, newV.id], VOID, l);
  });
  const body = captureOps(ctx, () => {
    for (const s of node.body) lowerStmt_sf(ctx, s);
  });

  return ctx.emit('for_region', [], VOID, l, {
    init: initOps, test: testOps, test_val: testOp.id,
    update: updateOps, body, phis: [],
  });
}

// ── Capture ──

function lowerCapture(ctx, node) {
  const l = ctx.loc(node);
  const val = lowerExpr_sf(ctx, node.expr);
  ctx.emit('store', [node.name, val.id], VOID, l);
  ctx.symbols.set(node.name, val.id);
  if (ctx.topLevel) ctx.defines.add(node.name);
  return null;
}

// ── Add / Remove ──

function lowerAddRemove(ctx, node, kind) {
  const l = ctx.loc(node);
  const value = lowerExpr_sf(ctx, node.value);
  const target = lowerExpr_sf(ctx, node.target);
  emitSoftCall(ctx, kind, [value, target], l, VOID);
  return null;
}

// ── Assume ──

function lowerAssume(ctx, node) {
  const l = ctx.loc(node);
  const cond = lowerExpr_sf(ctx, node.cond);
  const truthy = emitSoftCall(ctx, 'truthy', [cond], l, BOOL);

  const thenBody = captureOps(ctx, () => {
    const msg = node.message ? lowerExpr_sf(ctx, node.message)
      : ctx.emit('const', ['assumption failed'], STRING, l);
    ctx.emit('throw', [msg.id], VOID, l);
  });

  const notTruthy = ctx.emit('logical_not', [truthy.id], BOOL, l);
  ctx.emit('if_region', [notTruthy.id], VOID, l, {
    then_body: thenBody, else_body: [], phis: [],
  });
  return null;
}
