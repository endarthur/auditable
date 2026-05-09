// @gcu/air — JS/TS lowerer: ESTree → AIR
// Spec §7: Lowering ESTree → AIR

import {
  I32, F64, BOOL, STRING, VOID, DYNAMIC,
  typedArray, array, func,
  resolveAnnotation, isDynamic,
} from '../types.js';
import { ScopeChain } from '../scope.js';
import { BaseLowerCtx, captureOps } from './base.js';

// SSA id allocation + the op record builder live on BaseLowerCtx now
// (`ctx._idGen.next()` for ids; `ctx.emit(op, args, type, loc, extra)`
// for everything else). The legacy module-level `_nextId` / `mkOp`
// were dropped during the lowerer-frontend extraction so all three
// in-tree lowerers share one source of truth.

// --- Mutable capture pre-pass (spec §3.3, §7.3) ---

function findMutableCaptured(ast) {
  const captured = new Set();
  // Scope stack uses ScopeChain (v0.3 §3.3): names declared in this scope
  // hold value `true`. `chain.hasInOuter(name)` is the closure-detection
  // primitive — "is name visible from any enclosing scope but not THIS
  // one, so an assignment captures it?".
  let chain = new ScopeChain();

  function declare(name) { chain.set(name, true); }

  function collectDeclarations(node) {
    if (!node) return;
    if (node.type === 'VariableDeclaration') {
      for (const decl of node.declarations) {
        collectPatternNames(decl.id, declare);
      }
    } else if (node.type === 'FunctionDeclaration' && node.id) {
      declare(node.id.name);
    }
  }

  function collectPatternNames(pattern, addFn) {
    if (!pattern) return;
    if (pattern.type === 'Identifier') {
      addFn(pattern.name);
    } else if (pattern.type === 'ObjectPattern') {
      for (const prop of pattern.properties) {
        if (prop.type === 'RestElement') collectPatternNames(prop.argument, addFn);
        else collectPatternNames(prop.value, addFn);
      }
    } else if (pattern.type === 'ArrayPattern') {
      for (const el of pattern.elements) {
        if (!el) continue;
        if (el.type === 'RestElement') collectPatternNames(el.argument, addFn);
        else collectPatternNames(el, addFn);
      }
    } else if (pattern.type === 'AssignmentPattern') {
      collectPatternNames(pattern.left, addFn);
    }
  }

  function walk(node, inFunction) {
    if (!node) return;

    if (Array.isArray(node)) {
      for (const n of node) walk(n, inFunction);
      return;
    }

    if (typeof node !== 'object' || !node.type) return;

    // Function boundaries push a new scope
    const isFn = node.type === 'FunctionDeclaration' ||
                 node.type === 'FunctionExpression' ||
                 node.type === 'ArrowFunctionExpression';

    if (isFn) {
      chain = chain.push();
      // Params live in the function's outer scope. The body's BlockStatement
      // gets its own scope below (via the isBlock branch), which collects
      // body declarations there. We don't double-collect into the function
      // scope — that would put body lets in BOTH scopes and cause any
      // reassignment inside the function to look like a capture from outside.
      if (node.params) {
        for (const p of node.params) collectPatternNames(p, declare);
      }
      walk(node.body, true);
      chain = chain.pop();
      return;
    }

    // Block-introducing forms get their own scope so block-scoped lets and
    // for-init declarations don't leak to the enclosing function / cell as
    // "outer-declared". Without this, `for (let i …)` made `i` visible to
    // inner closures, falsely marking it captured and forcing a slot.
    const isBlock = node.type === 'BlockStatement' ||
                    node.type === 'ForStatement' ||
                    node.type === 'ForInStatement' ||
                    node.type === 'ForOfStatement';
    if (isBlock) {
      chain = chain.push();
      if (node.type === 'BlockStatement') {
        for (const stmt of node.body) collectDeclarations(stmt);
      } else {
        if (node.init && node.init.type === 'VariableDeclaration') collectDeclarations(node.init);
        if (node.left && node.left.type === 'VariableDeclaration') collectDeclarations(node.left);
      }
      for (const key of Object.keys(node)) {
        if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' ||
            key === 'typeAnnotation' || key === 'returnType') continue;
        const child = node[key];
        if (child && typeof child === 'object') walk(child, inFunction);
      }
      chain = chain.pop();
      return;
    }

    // Check assignments to outer-scope variables inside functions
    if (inFunction) {
      if (node.type === 'AssignmentExpression' && node.left?.type === 'Identifier') {
        if (chain.hasInOuter(node.left.name)) captured.add(node.left.name);
      }
      if (node.type === 'UpdateExpression' && node.argument?.type === 'Identifier') {
        if (chain.hasInOuter(node.argument.name)) captured.add(node.argument.name);
      }
    }

    // Recurse into children
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' ||
          key === 'typeAnnotation' || key === 'returnType') continue;
      const child = node[key];
      if (child && typeof child === 'object') walk(child, inFunction);
    }
  }

  // Top-level scope: collect all declarations
  if (ast.type === 'Program') {
    for (const stmt of ast.body) collectDeclarations(stmt);
    walk(ast, false);
  }

  return captured;
}

// --- var hoisting pre-pass (spec §7.2) ---

function findVarDeclarations(body) {
  const vars = new Set();
  function walk(node) {
    if (!node) return;
    if (Array.isArray(node)) { for (const n of node) walk(n); return; }
    if (typeof node !== 'object' || !node.type) return;
    if (node.type === 'VariableDeclaration' && node.kind === 'var') {
      for (const decl of node.declarations) {
        collectPatternNamesSimple(decl.id, vars);
      }
    }
    // Don't descend into functions (var is function-scoped)
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' ||
        node.type === 'ArrowFunctionExpression') return;
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
      const child = node[key];
      if (child && typeof child === 'object') walk(child);
    }
  }
  walk(body);
  return vars;
}

function collectPatternNamesSimple(pattern, set) {
  if (!pattern) return;
  if (pattern.type === 'Identifier') set.add(pattern.name);
  else if (pattern.type === 'ObjectPattern') {
    for (const prop of pattern.properties) {
      if (prop.type === 'RestElement') collectPatternNamesSimple(prop.argument, set);
      else collectPatternNamesSimple(prop.value, set);
    }
  } else if (pattern.type === 'ArrayPattern') {
    for (const el of pattern.elements) {
      if (!el) continue;
      if (el.type === 'RestElement') collectPatternNamesSimple(el.argument, set);
      else collectPatternNamesSimple(el, set);
    }
  } else if (pattern.type === 'AssignmentPattern') {
    collectPatternNamesSimple(pattern.left, set);
  }
}

// --- Known typed array constructors ---

const TYPED_ARRAY_CTORS = new Set([
  'Int8Array', 'Uint8Array', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
  'BigInt64Array', 'BigUint64Array',
]);

const CTOR_TO_ELEMENT = {
  Int8Array: 'i8', Uint8Array: 'u8', Int16Array: 'i16', Uint16Array: 'u16',
  Int32Array: 'i32', Uint32Array: 'u32', Float32Array: 'f32', Float64Array: 'f64',
  BigInt64Array: 'i64', BigUint64Array: 'u64',
};

// --- Lowering context ---
//
// JS-specific extras over BaseLowerCtx:
//   mutableCaptured — names mutated inside an inner function but declared
//     in an outer scope (closures need slot allocation, not bare lets).
//   slots           — name → SSA id of the slot (closure cell) for each
//     name in mutableCaptured.
// loc() picks line/col from ESTree's `node.loc.start` (other lowerers'
// AST shapes differ).

class LowerCtx extends BaseLowerCtx {
  constructor(mutableCaptured) {
    super();
    this.mutableCaptured = mutableCaptured;
    this.slots = new Map();
  }

  loc(node) {
    return node?.loc?.start ? { line: node.loc.start.line, col: node.loc.start.column } : null;
  }
}

// --- Main lowering entry point ---

export function lowerJS(ast, source) {
  // SSA id counter lives on the LowerCtx instance now (via BaseLowerCtx's
  // `_idGen`); no module-level reset needed.

  const mutableCaptured = findMutableCaptured(ast);
  const ctx = new LowerCtx(mutableCaptured);
  ctx.source = source || null;

  if (ast.type !== 'Program') throw new Error('Expected Program node');

  // var hoisting: allocate all var declarations as undefined at top
  const hoistedVars = findVarDeclarations(ast.body);
  for (const name of hoistedVars) {
    const undef = ctx.emit('const', [undefined], VOID, null);
    ctx.emit('store', [name, undef.id], VOID, null);
    ctx.symbols.set(name, undef.id);
  }

  // Allocate slots for mutable captured variables
  for (const name of mutableCaptured) {
    const slot = ctx.emit('slot_alloc', [name], DYNAMIC, null);
    ctx.slots.set(name, slot.id);
  }

  // Lower each statement
  for (const stmt of ast.body) {
    lowerStatement(ctx, stmt);
  }

  // Build cell module
  const exports = new Map();
  for (const name of ctx.defines) {
    const ssaId = ctx.symbols.get(name);
    const type = ssaId ? (ctx.types.get(ssaId) || DYNAMIC) : DYNAMIC;
    exports.set(name, { ssa_name: ssaId || null, type });
  }

  return {
    ops: ctx.ops,
    // Snapshot every visible binding (inner-wins) for downstream consumers
    // that want a flat lookup of names → ssa ids.
    symbol_table: ctx.symbols.flatten(),
    exports,
    imports: new Set(ctx.imports),
    defines: new Set(ctx.defines),
    side_effects: ctx.ops.some(o => o.op === 'opaque' || o.op === 'call' || o.op === 'call_method'),
  };
}

// --- Statement lowering ---

function lowerStatement(ctx, node) {
  if (!node) return;
  const l = ctx.loc(node);

  switch (node.type) {
    case 'VariableDeclaration':
      return lowerVarDecl(ctx, node);

    case 'FunctionDeclaration':
      return lowerFuncDecl(ctx, node);

    case 'ExpressionStatement':
      return lowerExpr(ctx, node.expression);

    case 'IfStatement':
      return lowerIf(ctx, node);

    case 'ForStatement':
      return lowerFor(ctx, node);

    case 'ForInStatement':
      return lowerForIn(ctx, node);

    case 'ForOfStatement':
      return lowerForOf(ctx, node);

    case 'WhileStatement':
      return lowerWhile(ctx, node);

    case 'DoWhileStatement':
      return lowerDoWhile(ctx, node);

    case 'ReturnStatement':
      return lowerReturn(ctx, node);

    case 'BreakStatement':
      ctx.emit('break', [], VOID, l);
      return null;

    case 'ContinueStatement':
      ctx.emit('continue', [], VOID, l);
      return null;

    case 'BlockStatement': {
      // Block scope — lexical declarations inside are not cell-level exports.
      // Wrappers like lowerIf/lowerFor/etc. don't need to set this themselves;
      // their bodies are always either a BlockStatement (handled here) or a
      // single statement (which can't host let/const/class declarations).
      // Push a fresh ctx.symbols frame so block-scoped lets don't leak.
      // Function bodies don't enter this case — they bypass it by iterating
      // node.body.body directly in lowerFuncDecl/Expr (which push their own
      // frame).
      const savedTopLevel = ctx.topLevel;
      ctx.topLevel = false;
      ctx.symbols = ctx.symbols.push();
      for (const s of node.body) lowerStatement(ctx, s);
      ctx.symbols = ctx.symbols.pop();
      ctx.topLevel = savedTopLevel;
      return null;
    }

    case 'EmptyStatement':
      return null;

    case 'ThrowStatement': {
      const arg = lowerExpr(ctx, node.argument);
      ctx.emit('throw', [arg.id], VOID, l);
      return null;
    }

    case 'SwitchStatement':
      return lowerSwitch(ctx, node);

    case 'TryStatement':
      return lowerTry(ctx, node);

    case 'LabeledStatement':
      return lowerLabeled(ctx, node);

    case 'ClassDeclaration':
      return lowerClassDecl(ctx, node);

    case 'DebuggerStatement':
      ctx.emit('debugger', [], VOID, l);
      return null;

    // Opaque fallback for truly unsupported statements
    default:
      return lowerOpaque(ctx, node);
  }
}

// --- Variable declaration ---

function lowerVarDecl(ctx, node) {
  const isTopLevel = ctx.topLevel;

  for (const decl of node.declarations) {
    if (decl.id.type === 'Identifier') {
      // Simple: const x = expr or const x: type = expr
      const name = decl.id.name;
      const annotation = resolveAnnotation(decl.id.typeAnnotation);
      const init = decl.init ? lowerExpr(ctx, decl.init) : ctx.emit('const', [undefined], VOID, ctx.loc(decl));
      const type = isDynamic(annotation) ? (ctx.types.get(init.id) || DYNAMIC) : annotation;

      // Propagate annotation type to the init op so the emitter can hint correctly
      if (!isDynamic(annotation)) init.type = annotation;

      if (ctx.mutableCaptured.has(name)) {
        const slot = ctx.slots.get(name);
        ctx.emit('slot_store', [slot, init.id], VOID, ctx.loc(decl));
      } else {
        ctx.emit('store', [name, init.id], VOID, ctx.loc(decl));
        ctx.symbols.set(name, init.id);
        ctx.types.set(init.id, type);
      }

      if (isTopLevel) ctx.defines.add(name);
    } else {
      // Destructuring pattern
      const init = decl.init ? lowerExpr(ctx, decl.init) : ctx.emit('const', [undefined], VOID, ctx.loc(decl));
      lowerPattern(ctx, decl.id, init, isTopLevel);
    }
  }
}

// --- Destructuring patterns (spec §7.1) ---

function lowerPattern(ctx, pattern, sourceOp, isTopLevel) {
  if (!pattern) return;
  const l = ctx.loc(pattern);

  if (pattern.type === 'Identifier') {
    const name = pattern.name;
    const annotation = resolveAnnotation(pattern.typeAnnotation);
    const type = isDynamic(annotation) ? (ctx.types.get(sourceOp.id) || DYNAMIC) : annotation;

    if (ctx.mutableCaptured.has(name)) {
      const slot = ctx.slots.get(name);
      ctx.emit('slot_store', [slot, sourceOp.id], VOID, l);
    } else {
      ctx.emit('store', [name, sourceOp.id], VOID, l);
      ctx.symbols.set(name, sourceOp.id);
      ctx.types.set(sourceOp.id, type);
    }
    if (isTopLevel) ctx.defines.add(name);
    return;
  }

  if (pattern.type === 'ObjectPattern') {
    for (const prop of pattern.properties) {
      if (prop.type === 'RestElement') {
        // ...rest in object destructuring → opaque for now
        const restOp = ctx.emit('opaque', ['/* object rest */'], DYNAMIC, l);
        lowerPattern(ctx, prop.argument, restOp, isTopLevel);
        continue;
      }
      const key = prop.key.type === 'Identifier' ? prop.key.name : String(prop.key.value);
      const get = ctx.emit('object_get', [sourceOp.id, key], DYNAMIC, l);

      if (prop.value.type === 'AssignmentPattern') {
        // Default value: { a = 5 }
        const defaultVal = lowerExpr(ctx, prop.value.right);
        const check = ctx.emit('eq', [get.id, ctx.emit('const', [undefined], VOID, l).id], BOOL, l);
        const selected = ctx.emit('if_region', [check.id], DYNAMIC, l, {
          then_body: [defaultVal],
          else_body: [get],
          phis: [],
        });
        // For simplicity in v1, just use the get and trust runtime
        lowerPattern(ctx, prop.value.left, get, isTopLevel);
      } else {
        lowerPattern(ctx, prop.value, get, isTopLevel);
      }
    }
    return;
  }

  if (pattern.type === 'ArrayPattern') {
    for (let i = 0; i < pattern.elements.length; i++) {
      const el = pattern.elements[i];
      if (!el) continue;
      if (el.type === 'RestElement') {
        const restOp = ctx.emit('opaque', ['/* array rest */'], DYNAMIC, l);
        lowerPattern(ctx, el.argument, restOp, isTopLevel);
        continue;
      }
      const idx = ctx.emit('const', [i], I32, l);
      const get = ctx.emit('array_get', [sourceOp.id, idx.id], DYNAMIC, l);

      if (el.type === 'AssignmentPattern') {
        lowerPattern(ctx, el.left, get, isTopLevel);
      } else {
        lowerPattern(ctx, el, get, isTopLevel);
      }
    }
    return;
  }

  if (pattern.type === 'AssignmentPattern') {
    lowerPattern(ctx, pattern.left, sourceOp, isTopLevel);
    return;
  }
}

// --- Function declaration ---

function lowerFuncDecl(ctx, node) {
  const name = node.id?.name;
  const l = ctx.loc(node);

  const params = node.params.map(p => {
    if (p.type === 'Identifier') {
      const type = resolveAnnotation(p.typeAnnotation);
      return { name: p.name, type };
    }
    return { name: '?', type: DYNAMIC };
  });

  const retType = node.returnType ? resolveAnnotation(node.returnType) : DYNAMIC;

  // Lower function body in a new "scope" context. Push a new ctx.symbols
  // frame so let/const declarations inside the body don't leak to outer
  // reads (the spec §2.3 fix).
  const savedTopLevel = ctx.topLevel;
  ctx.topLevel = false;
  ctx.symbols = ctx.symbols.push();
  const bodyOps = captureOps(ctx, () => {
    if (node.body?.type === 'BlockStatement') {
      for (const stmt of node.body.body) lowerStatement(ctx, stmt);
    }
  });
  ctx.symbols = ctx.symbols.pop();
  ctx.topLevel = savedTopLevel;

  const fType = func(params.map(p => p.type), retType);
  const op = ctx.emit('func_region', [name], fType, l, {
    name, params, body: bodyOps, ret_type: retType,
    is_async: node.async || false,
    is_generator: node.generator || false,
    // FunctionDeclaration → emit as `function name(...) {}` statement at
    // wherever this op sits, not as an expression. Without the flag, a
    // nested function decl was registered as an inline `function name(){}`
    // expression — body callers found the name unbound.
    is_decl: true,
  });

  if (name && ctx.topLevel) {
    ctx.defines.add(name);
    ctx.symbols.set(name, op.id);
  }

  return op;
}

// --- Control flow ---

function lowerIf(ctx, node) {
  const l = ctx.loc(node);
  const cond = lowerExpr(ctx, node.test);
  const thenBody = captureOps(ctx, () => lowerStatement(ctx, node.consequent));
  const elseBody = captureOps(ctx, () => {
    if (node.alternate) lowerStatement(ctx, node.alternate);
  });
  return ctx.emit('if_region', [cond.id], VOID, l, {
    then_body: thenBody,
    else_body: elseBody,
    phis: [],
  });
}

function lowerFor(ctx, node) {
  const l = ctx.loc(node);

  // for-header let/const are block-scoped — push a fresh ctx.symbols frame
  // so `for (let i …)` doesn't leak `i` into the outer scope, where outer
  // type-prop would then read the loop var's last-iteration ssa id.
  ctx.symbols = ctx.symbols.push();
  const savedTopLevel = ctx.topLevel;
  ctx.topLevel = false;

  let test = null;
  const initOps = captureOps(ctx, () => {
    if (node.init) {
      if (node.init.type === 'VariableDeclaration') lowerVarDecl(ctx, node.init);
      else lowerExpr(ctx, node.init);
    }
  });
  const testOps = captureOps(ctx, () => {
    if (node.test) test = lowerExpr(ctx, node.test);
  });
  const updateOps = captureOps(ctx, () => {
    if (node.update) lowerExpr(ctx, node.update);
  });
  const bodyOps = captureOps(ctx, () => lowerStatement(ctx, node.body));

  ctx.topLevel = savedTopLevel;
  ctx.symbols = ctx.symbols.pop();

  return ctx.emit('for_region', [], VOID, l, {
    init: initOps,
    test: testOps,
    test_val: test?.id || null,
    update: updateOps,
    body: bodyOps,
    phis: [],
  });
}

function lowerForIn(ctx, node) {
  const l = ctx.loc(node);
  const iter = lowerExpr(ctx, node.right);
  ctx.symbols = ctx.symbols.push();

  // Declare the iteration variable (block-scoped, not top-level)
  if (node.left.type === 'VariableDeclaration') {
    const name = node.left.declarations[0]?.id?.name;
    if (name) {
      ctx.symbols.set(name, null);
    }
  }

  const bodyOps = captureOps(ctx, () => lowerStatement(ctx, node.body));
  ctx.symbols = ctx.symbols.pop();

  return ctx.emit('for_in_region', [iter.id], VOID, l, { body: bodyOps, phis: [] });
}

function lowerForOf(ctx, node) {
  const l = ctx.loc(node);

  // Destructuring loop variables (`for (const [i, s] of …)`, `for (const {a} of …)`)
  // would need a synthetic temp + a destructure in the body, which the IR
  // doesn't model directly. Preserve the source verbatim — the emitter
  // round-trips opaque text and `scanIdentifiers` still picks up cross-cell
  // deps.
  const isPatternTarget =
    (node.left.type === 'VariableDeclaration' &&
     node.left.declarations[0]?.id?.type !== 'Identifier') ||
    (node.left.type !== 'VariableDeclaration' && node.left.type !== 'Identifier');
  if (isPatternTarget) return lowerOpaque(ctx, node);

  const iter = lowerExpr(ctx, node.right);
  ctx.symbols = ctx.symbols.push();

  // Capture the loop variable's name so the emitter can use it instead of
  // falling back to a synthetic `_v`. References inside the body (`s.x`,
  // etc.) emit as bare identifiers, so the for-of header has to bind the
  // same name.
  let targetName = null;
  if (node.left.type === 'VariableDeclaration') {
    const name = node.left.declarations[0]?.id?.name;
    if (name) {
      targetName = name;
      ctx.symbols.set(name, null);
    }
  } else if (node.left.type === 'Identifier') {
    targetName = node.left.name;
  }

  const bodyOps = captureOps(ctx, () => lowerStatement(ctx, node.body));
  ctx.symbols = ctx.symbols.pop();

  return ctx.emit('for_of_region', [iter.id], VOID, l, {
    body: bodyOps, phis: [], target_name: targetName,
  });
}

function lowerWhile(ctx, node) {
  const l = ctx.loc(node);
  let cond = null;
  const testOps = captureOps(ctx, () => { cond = lowerExpr(ctx, node.test); });
  const bodyOps = captureOps(ctx, () => lowerStatement(ctx, node.body));
  return ctx.emit('loop_region', [], VOID, l, {
    test: testOps, test_val: cond.id,
    body: bodyOps, phis: [],
    loop_kind: 'while',
  });
}

function lowerDoWhile(ctx, node) {
  const l = ctx.loc(node);
  const bodyOps = captureOps(ctx, () => lowerStatement(ctx, node.body));
  let cond = null;
  const testOps = captureOps(ctx, () => { cond = lowerExpr(ctx, node.test); });
  return ctx.emit('loop_region', [], VOID, l, {
    test: testOps, test_val: cond.id,
    body: bodyOps, phis: [],
    loop_kind: 'do_while',
  });
}

function lowerSwitch(ctx, node) {
  const l = ctx.loc(node);
  const disc = lowerExpr(ctx, node.discriminant);
  const cases = [];
  for (const c of node.cases) {
    let test = null;
    const testOps = captureOps(ctx, () => {
      if (c.test) test = lowerExpr(ctx, c.test);
    });
    const body = captureOps(ctx, () => {
      for (const stmt of c.consequent) lowerStatement(ctx, stmt);
    });
    cases.push({ test_ops: testOps, test_val: test?.id || null, body });
  }
  return ctx.emit('switch_region', [disc.id], VOID, l, { cases });
}

function lowerTry(ctx, node) {
  const l = ctx.loc(node);

  // try / catch / finally blocks are each their own block scope. Push
  // around each so let-bindings (and the catch param) don't leak.
  ctx.symbols = ctx.symbols.push();
  const tryBody = captureOps(ctx, () => lowerStatement(ctx, node.block));
  ctx.symbols = ctx.symbols.pop();

  let catchParam = null;
  let catchBody = [];
  if (node.handler) {
    ctx.symbols = ctx.symbols.push();
    if (node.handler.param?.type === 'Identifier') {
      catchParam = node.handler.param.name;
      ctx.symbols.set(catchParam, null);
    }
    catchBody = captureOps(ctx, () => lowerStatement(ctx, node.handler.body));
    ctx.symbols = ctx.symbols.pop();
  }

  let finallyBody = [];
  if (node.finalizer) {
    ctx.symbols = ctx.symbols.push();
    finallyBody = captureOps(ctx, () => lowerStatement(ctx, node.finalizer));
    ctx.symbols = ctx.symbols.pop();
  }

  return ctx.emit('try_region', [], VOID, l, {
    try_body: tryBody,
    catch_param: catchParam,
    catch_body: catchBody,
    finally_body: finallyBody,
  });
}

function lowerLabeled(ctx, node) {
  const l = ctx.loc(node);
  // Track whether body was a block — emitter needs to re-wrap in braces so
  // `label: let x = 1;` (a JS strict-mode error) becomes `label: { let x; }`.
  // Loop bodies bring their own braces; we only wrap when the label was on a
  // bare block.
  const isBlock = node.body?.type === 'BlockStatement';
  const body = captureOps(ctx, () => lowerStatement(ctx, node.body));
  return ctx.emit('labeled', [node.label.name], VOID, l, { body, is_block: isBlock });
}

function lowerClassDecl(ctx, node) {
  const l = ctx.loc(node);
  const name = node.id?.name;
  const op = lowerClassNode(ctx, node, l);
  if (name && ctx.topLevel) {
    ctx.defines.add(name);
    ctx.symbols.set(name, op.id);
  }
  return op;
}

function lowerClassExpr(ctx, node) {
  return lowerClassNode(ctx, node, ctx.loc(node));
}

function lowerClassNode(ctx, node, l) {
  const name = node.id?.name || null;
  const superClass = node.superClass ? lowerExpr(ctx, node.superClass) : null;

  const savedTopLevel = ctx.topLevel;
  ctx.topLevel = false;

  const members = [];
  for (const member of (node.body?.body || [])) {
    const mLoc = ctx.loc(member);

    if (member.type === 'StaticBlock') {
      ctx.symbols = ctx.symbols.push();
      const body = captureOps(ctx, () => {
        for (const stmt of member.body) lowerStatement(ctx, stmt);
      });
      ctx.symbols = ctx.symbols.pop();
      members.push({ kind: 'static_block', body, loc: mLoc });
      continue;
    }

    // MethodDefinition or PropertyDefinition
    const isStatic = member.static || false;
    const isPrivate = member.key?.type === 'PrivateIdentifier';
    const computed = member.computed || false;

    // Key
    let key = null;
    let computedKeyId = null;
    if (isPrivate) {
      key = '#' + member.key.name;
    } else if (computed) {
      const k = lowerExpr(ctx, member.key);
      computedKeyId = k.id;
    } else if (member.key?.type === 'Identifier') {
      key = member.key.name;
    } else if (member.key?.type === 'Literal') {
      key = member.key.value;
    }

    if (member.type === 'PropertyDefinition') {
      // Class field
      const valueId = member.value ? lowerExpr(ctx, member.value).id : null;
      members.push({
        kind: 'field', key, computedKeyId, computed, static: isStatic,
        private: isPrivate, value: valueId, loc: mLoc,
      });
      continue;
    }

    // MethodDefinition — lower value as func_region
    const kind = member.kind || 'method'; // 'constructor', 'method', 'get', 'set'
    const fn = member.value;

    const params = (fn.params || []).map(p => {
      if (p.type === 'Identifier') return { name: p.name, type: resolveAnnotation(p.typeAnnotation) };
      // Destructuring/rest params in methods — use name as placeholder
      return { name: '?', type: DYNAMIC };
    });
    const retType = fn.returnType ? resolveAnnotation(fn.returnType) : DYNAMIC;

    ctx.symbols = ctx.symbols.push();
    const bodyOps = captureOps(ctx, () => {
      if (fn.body?.type === 'BlockStatement') {
        for (const stmt of fn.body.body) lowerStatement(ctx, stmt);
      }
    });
    ctx.symbols = ctx.symbols.pop();

    const fType = func(params.map(p => p.type), retType);
    const fnOp = ctx.emit('func_region', [null], fType, mLoc, {
      name: null, params, body: bodyOps, ret_type: retType,
      is_async: fn.async || false,
      is_generator: fn.generator || false,
      is_method: true,
    });

    members.push({
      kind, key, computedKeyId, computed, static: isStatic,
      private: isPrivate, value: fnOp.id, loc: mLoc,
    });
  }

  ctx.topLevel = savedTopLevel;

  return ctx.emit('class_region', [name], DYNAMIC, l, {
    name,
    super_class: superClass?.id || null,
    members,
  });
}

function lowerReturn(ctx, node) {
  const l = ctx.loc(node);
  const val = node.argument ? lowerExpr(ctx, node.argument) : ctx.emit('const', [undefined], VOID, l);
  return ctx.emit('return', [val.id], VOID, l);
}

// --- Expression lowering ---

function lowerExpr(ctx, node) {
  if (!node) return ctx.emit('const', [undefined], VOID, null);
  const l = ctx.loc(node);

  switch (node.type) {
    case 'Literal':
      return lowerLiteral(ctx, node);

    case 'Identifier':
      return lowerIdentifier(ctx, node);

    case 'BinaryExpression':
      return lowerBinary(ctx, node);

    case 'LogicalExpression':
      return lowerLogical(ctx, node);

    case 'UnaryExpression':
      return lowerUnary(ctx, node);

    case 'UpdateExpression':
      return lowerUpdate(ctx, node);

    case 'AssignmentExpression':
      return lowerAssignment(ctx, node);

    case 'CallExpression':
      return lowerCall(ctx, node);

    case 'MemberExpression':
      return lowerMember(ctx, node);

    case 'ArrayExpression':
      return lowerArrayExpr(ctx, node);

    case 'ObjectExpression':
      return lowerObjectExpr(ctx, node);

    case 'ConditionalExpression':
      return lowerConditional(ctx, node);

    case 'TemplateLiteral':
      return lowerTemplateLiteral(ctx, node);

    case 'TaggedTemplateExpression':
      // Tagged templates have unique call semantics — the tag is invoked with
      // (stringsArray, ...interpolatedValues), where stringsArray carries the
      // raw source segments. AIR's plain `call` op can't represent this, so
      // we keep the original source verbatim. lowerOpaque scans for cross-cell
      // identifier references so dependency tracking still works.
      return lowerOpaque(ctx, node);

    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
      return lowerFuncExpr(ctx, node);

    case 'AwaitExpression': {
      const arg = lowerExpr(ctx, node.argument);
      return ctx.emit('await', [arg.id], DYNAMIC, l);
    }

    case 'NewExpression':
      return lowerNew(ctx, node);

    case 'SpreadElement': {
      const arg = lowerExpr(ctx, node.argument);
      return ctx.emit('spread', [arg.id], DYNAMIC, l);
    }

    case 'SequenceExpression': {
      let last = null;
      for (const expr of node.expressions) last = lowerExpr(ctx, expr);
      return last;
    }

    case 'ParenthesizedExpression':
      return lowerExpr(ctx, node.expression);

    case 'ChainExpression':
      return lowerExpr(ctx, node.expression);

    case 'ClassExpression':
      return lowerClassExpr(ctx, node);

    case 'YieldExpression': {
      const arg = node.argument ? lowerExpr(ctx, node.argument) : null;
      const op = node.delegate ? 'yield_delegate' : 'yield';
      return ctx.emit(op, arg ? [arg.id] : [], DYNAMIC, l);
    }

    case 'ImportExpression': {
      const source = lowerExpr(ctx, node.source);
      return ctx.emit('import', [source.id], DYNAMIC, l);
    }

    case 'MetaProperty':
      return ctx.emit('meta', [node.meta.name, node.property.name], DYNAMIC, l);

    default:
      return lowerOpaque(ctx, node);
  }
}

// --- Literal ---

function lowerLiteral(ctx, node) {
  const l = ctx.loc(node);
  const v = node.value;
  if (v === null) return ctx.emit('null', [], DYNAMIC, l);
  if (typeof v === 'number') {
    // Infer type from value: integer if no decimal point and within i32 range
    const isInt = Number.isInteger(v) && v >= -2147483648 && v <= 2147483647;
    return ctx.emit('const', [v], isInt ? I32 : F64, l);
  }
  if (typeof v === 'string') return ctx.emit('const', [v], STRING, l);
  if (typeof v === 'boolean') return ctx.emit('const', [v], BOOL, l);
  if (v instanceof RegExp) return ctx.emit('opaque', [node.raw || String(v)], DYNAMIC, l);
  return ctx.emit('const', [v], DYNAMIC, l);
}

// --- Identifier ---

function lowerIdentifier(ctx, node) {
  const l = ctx.loc(node);
  const name = node.name;

  if (name === 'undefined') return ctx.emit('const', [undefined], VOID, l);
  if (name === 'true') return ctx.emit('const', [true], BOOL, l);
  if (name === 'false') return ctx.emit('const', [false], BOOL, l);

  // Mutable captured → slot_load
  if (ctx.mutableCaptured.has(name) && ctx.slots.has(name)) {
    const slot = ctx.slots.get(name);
    return ctx.emit('slot_load', [slot], DYNAMIC, l);
  }

  // Known in symbol table
  if (ctx.symbols.has(name)) {
    return ctx.emit('load', [name], ctx.types.get(ctx.symbols.get(name)) || DYNAMIC, l);
  }

  // Unknown — could be a cell import or global
  ctx.imports.add(name);
  return ctx.emit('load', [name], DYNAMIC, l);
}

// --- Binary operations ---

const BINARY_OP_MAP = {
  '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'mod',
  '==': 'eq', '!=': 'neq', '===': 'eq', '!==': 'neq',
  '<': 'lt', '<=': 'lte', '>': 'gt', '>=': 'gte',
  '|': 'bitwise_or', '&': 'bitwise_and', '^': 'bitwise_xor',
  '<<': 'shift_left', '>>': 'shift_right', '>>>': 'ushift_right',
  '**': 'exp', 'in': 'in', 'instanceof': 'instanceof',
};

function lowerBinary(ctx, node) {
  const l = ctx.loc(node);
  const opName = BINARY_OP_MAP[node.operator];

  if (opName === 'opaque') return lowerOpaque(ctx, node);

  const lhs = lowerExpr(ctx, node.left);
  const rhs = lowerExpr(ctx, node.right);

  const lt = ctx.types.get(lhs.id) || DYNAMIC;
  const rt = ctx.types.get(rhs.id) || DYNAMIC;

  let resultType;
  if (opName === 'in' || opName === 'instanceof') {
    resultType = BOOL;
  } else if (opName === 'eq' || opName === 'neq' || opName === 'lt' || opName === 'lte' ||
      opName === 'gt' || opName === 'gte') {
    resultType = BOOL;
  } else if (opName === 'bitwise_or' || opName === 'bitwise_and' || opName === 'bitwise_xor' ||
             opName === 'shift_left' || opName === 'shift_right' || opName === 'ushift_right') {
    resultType = I32;
  } else if (opName === 'exp') {
    resultType = arithmeticResultFn(lt, rt);
  } else {
    resultType = isDynamic(lt) || isDynamic(rt) ? DYNAMIC :
      (opName === 'add' && (lt.kind === 'string' || rt.kind === 'string')) ? STRING :
      arithmeticResultFn(lt, rt);
  }

  return ctx.emit(opName, [lhs.id, rhs.id], resultType, l);
}

// --- Logical operations ---

function lowerLogical(ctx, node) {
  const l = ctx.loc(node);
  const lhs = lowerExpr(ctx, node.left);
  const rhs = lowerExpr(ctx, node.right);
  const opName = node.operator === '&&' ? 'logical_and' :
                 node.operator === '||' ? 'logical_or' :
                 node.operator === '??' ? 'nullish_coalesce' : 'opaque';
  if (opName === 'opaque') return lowerOpaque(ctx, node);
  const rt = ctx.types.get(rhs.id) || DYNAMIC;
  return ctx.emit(opName, [lhs.id, rhs.id], rt, l);
}

// --- Unary operations ---

function lowerUnary(ctx, node) {
  const l = ctx.loc(node);
  if (node.operator === '-') {
    const arg = lowerExpr(ctx, node.argument);
    return ctx.emit('neg', [arg.id], ctx.types.get(arg.id) || DYNAMIC, l);
  }
  if (node.operator === '!') {
    const arg = lowerExpr(ctx, node.argument);
    return ctx.emit('logical_not', [arg.id], BOOL, l);
  }
  if (node.operator === '+') {
    // Unary `+` is a ToNumber coercion in JS (e.g. `+"42" === 42`).
    // Emit as a dedicated unary op — used to be `add` with a single
    // arg, which the emitter rendered as `(arg + undefined)` because
    // emitBinary expected two operands.
    const arg = lowerExpr(ctx, node.argument);
    return ctx.emit('unary_plus', [arg.id], F64, l);
  }
  if (node.operator === 'typeof') {
    const arg = lowerExpr(ctx, node.argument);
    return ctx.emit('typeof', [arg.id], STRING, l);
  }
  if (node.operator === 'void') {
    const arg = lowerExpr(ctx, node.argument);
    return ctx.emit('void', [arg.id], VOID, l);
  }
  if (node.operator === 'delete') {
    const arg = lowerExpr(ctx, node.argument);
    return ctx.emit('delete', [arg.id], BOOL, l);
  }
  if (node.operator === '~') {
    const arg = lowerExpr(ctx, node.argument);
    return ctx.emit('bitwise_not', [arg.id], I32, l);
  }
  return lowerOpaque(ctx, node);
}

// --- Update expressions (++/--) ---

function lowerUpdate(ctx, node) {
  const l = ctx.loc(node);
  if (node.argument.type !== 'Identifier') return lowerOpaque(ctx, node);

  const name = node.argument.name;
  const current = lowerIdentifier(ctx, node.argument);
  const one = ctx.emit('const', [1], I32, l);
  const opName = node.operator === '++' ? 'add' : 'sub';
  const result = ctx.emit(opName, [current.id, one.id], ctx.types.get(current.id) || DYNAMIC, l);

  if (ctx.mutableCaptured.has(name)) {
    const slot = ctx.slots.get(name);
    ctx.emit('slot_store', [slot, result.id], VOID, l);
  } else {
    ctx.emit('store', [name, result.id], VOID, l);
    ctx.symbols.set(name, result.id);
  }

  return node.prefix ? result : current;
}

// --- Assignment ---

function lowerAssignment(ctx, node) {
  const l = ctx.loc(node);

  if (node.left.type === 'Identifier') {
    const name = node.left.name;
    let val;
    if (node.operator === '=') {
      val = lowerExpr(ctx, node.right);
    } else {
      // Compound assignment: +=, -=, etc.
      const current = lowerIdentifier(ctx, node.left);
      const rhs = lowerExpr(ctx, node.right);
      const opMap = { '+=': 'add', '-=': 'sub', '*=': 'mul', '/=': 'div', '%=': 'mod',
                      '|=': 'bitwise_or', '&=': 'bitwise_and', '^=': 'bitwise_xor',
                      '<<=': 'shift_left', '>>=': 'shift_right', '>>>=': 'ushift_right' };
      const opName = opMap[node.operator];
      if (!opName) return lowerOpaque(ctx, node);
      val = ctx.emit(opName, [current.id, rhs.id], ctx.types.get(current.id) || DYNAMIC, l);
    }

    if (ctx.mutableCaptured.has(name)) {
      const slot = ctx.slots.get(name);
      ctx.emit('slot_store', [slot, val.id], VOID, l);
    } else {
      ctx.emit('store', [name, val.id], VOID, l);
      ctx.symbols.set(name, val.id);
    }
    return val;
  }

  if (node.left.type === 'MemberExpression') {
    const obj = lowerExpr(ctx, node.left.object);
    const rhs = lowerExpr(ctx, node.right);
    if (node.left.computed) {
      const key = lowerExpr(ctx, node.left.property);
      ctx.emit('array_set', [obj.id, key.id, rhs.id], VOID, l);
    } else {
      const key = (node.left.property.type === 'PrivateIdentifier' ? '#' : '') + node.left.property.name;
      ctx.emit('object_set', [obj.id, key, rhs.id], VOID, l);
    }
    // Assignment expressions evaluate to their rhs in JS — return `rhs`,
    // not the void store op, so chained assignments like
    // `a[i] = b[j] = c[k] = 0` find a real value at each rhs slot.
    return rhs;
  }

  // Destructuring assignment
  if (node.left.type === 'ObjectPattern' || node.left.type === 'ArrayPattern') {
    const val = lowerExpr(ctx, node.right);
    lowerPattern(ctx, node.left, val, false);
    return val;
  }

  return lowerOpaque(ctx, node);
}

// --- Call expressions ---

function lowerCall(ctx, node) {
  const l = ctx.loc(node);
  const optional = node.optional || false;
  const extra = optional ? { optional } : undefined;

  // Method call: obj.method(args)
  if (node.callee.type === 'MemberExpression' && !node.callee.computed) {
    const obj = lowerExpr(ctx, node.callee.object);
    const method = node.callee.property.name;
    const callerOptional = node.callee.optional || false;
    const args = node.arguments.map(a => lowerExpr(ctx, a));
    return ctx.emit('call_method', [obj.id, method, ...args.map(a => a.id)], DYNAMIC, l,
      (optional || callerOptional) ? { optional, member_optional: callerOptional } : undefined);
  }

  // Regular call: fn(args)
  const fn = lowerExpr(ctx, node.callee);
  const args = node.arguments.map(a => lowerExpr(ctx, a));
  return ctx.emit('call', [fn.id, ...args.map(a => a.id)], DYNAMIC, l, extra);
}

// --- Member expressions ---

function lowerMember(ctx, node) {
  const l = ctx.loc(node);
  const obj = lowerExpr(ctx, node.object);
  const optional = node.optional || false;

  if (node.computed) {
    const key = lowerExpr(ctx, node.property);
    return ctx.emit('array_get', [obj.id, key.id], DYNAMIC, l, optional ? { optional } : undefined);
  }

  const key = (node.property.type === 'PrivateIdentifier' ? '#' : '') + node.property.name;
  return ctx.emit('object_get', [obj.id, key], DYNAMIC, l, optional ? { optional } : undefined);
}

// --- Array/Object expressions ---

function lowerArrayExpr(ctx, node) {
  const l = ctx.loc(node);
  const elements = node.elements.map(el => {
    if (!el) return ctx.emit('const', [undefined], VOID, l);
    return lowerExpr(ctx, el);
  });
  return ctx.emit('array_new', elements.map(e => e.id), DYNAMIC, l);
}

function lowerObjectExpr(ctx, node) {
  const l = ctx.loc(node);
  const pairs = [];
  for (const prop of node.properties) {
    if (prop.type === 'SpreadElement') {
      // Object spread: { ...obj }
      const spread = lowerExpr(ctx, prop.argument);
      pairs.push({ spread: true, id: spread.id });
      continue;
    }
    const key = prop.key.type === 'Identifier' ? prop.key.name :
                prop.key.type === 'Literal' ? String(prop.key.value) : null;
    if (key === null) return lowerOpaque(ctx, node); // computed key
    const val = lowerExpr(ctx, prop.value);
    pairs.push({ key, id: val.id });
  }
  return ctx.emit('object_new', pairs, DYNAMIC, l);
}

// --- Conditional (ternary) ---

function lowerConditional(ctx, node) {
  const l = ctx.loc(node);
  const cond = lowerExpr(ctx, node.test);
  let thenVal = null, elseVal = null;
  const thenBody = captureOps(ctx, () => { thenVal = lowerExpr(ctx, node.consequent); });
  const elseBody = captureOps(ctx, () => { elseVal = lowerExpr(ctx, node.alternate); });
  return ctx.emit('if_region', [cond.id], DYNAMIC, l, {
    then_body: thenBody,
    else_body: elseBody,
    phis: [{ then_val: thenVal.id, else_val: elseVal.id }],
  });
}

// --- Template literals ---

function lowerTemplateLiteral(ctx, node) {
  const l = ctx.loc(node);
  let result = ctx.emit('const', [node.quasis[0].value.cooked || ''], STRING, l);

  for (let i = 0; i < node.expressions.length; i++) {
    const expr = lowerExpr(ctx, node.expressions[i]);
    result = ctx.emit('add', [result.id, expr.id], STRING, l);
    if (node.quasis[i + 1]?.value?.cooked) {
      const tail = ctx.emit('const', [node.quasis[i + 1].value.cooked], STRING, l);
      result = ctx.emit('add', [result.id, tail.id], STRING, l);
    }
  }

  return result;
}

// --- Function expressions ---

function lowerFuncExpr(ctx, node) {
  const name = node.id?.name || null;
  const l = ctx.loc(node);

  const params = node.params.map(p => {
    if (p.type === 'Identifier') {
      return { name: p.name, type: resolveAnnotation(p.typeAnnotation) };
    }
    return { name: '?', type: DYNAMIC };
  });

  const retType = node.returnType ? resolveAnnotation(node.returnType) : DYNAMIC;

  const savedTopLevel = ctx.topLevel;
  ctx.topLevel = false;
  ctx.symbols = ctx.symbols.push();
  const body = node.body;
  const bodyOps = captureOps(ctx, () => {
    if (body.type === 'BlockStatement') {
      for (const stmt of body.body) lowerStatement(ctx, stmt);
    } else {
      // Arrow with expression body
      const val = lowerExpr(ctx, body);
      ctx.emit('return', [val.id], VOID, ctx.loc(body));
    }
  });
  ctx.symbols = ctx.symbols.pop();
  ctx.topLevel = savedTopLevel;

  const fType = func(params.map(p => p.type), retType);
  return ctx.emit('func_region', [name], fType, l, {
    name, params, body: bodyOps, ret_type: retType,
    is_async: node.async || false,
    is_generator: node.generator || false,
  });
}

// --- New expressions ---

function lowerNew(ctx, node) {
  const l = ctx.loc(node);

  // Typed array constructors
  if (node.callee.type === 'Identifier' && TYPED_ARRAY_CTORS.has(node.callee.name)) {
    const element = CTOR_TO_ELEMENT[node.callee.name];
    const args = node.arguments.map(a => lowerExpr(ctx, a));
    return ctx.emit('ta_new', [element, ...args.map(a => a.id)], typedArray(element), l);
  }

  // All other new expressions
  const ctor = lowerExpr(ctx, node.callee);
  const args = node.arguments.map(a => lowerExpr(ctx, a));
  return ctx.emit('new', [ctor.id, ...args.map(a => a.id)], DYNAMIC, l);
}

// --- Opaque fallback ---

function lowerOpaque(ctx, node) {
  const l = ctx.loc(node);
  // Scan the AST subtree for identifier references (conservative dependency)
  // so that opaque regions don't lose cross-cell dependencies.
  scanIdentifiers(ctx, node);
  // Preserve original source text for the emitter
  const src = (ctx.source && node.start != null && node.end != null) ?
    ctx.source.slice(node.start, node.end) : `(void 0) /* opaque: ${node.type} */`;
  return ctx.emit('opaque', [src], DYNAMIC, l);
}

function scanIdentifiers(ctx, node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) scanIdentifiers(ctx, n); return; }
  if (node.type === 'Identifier' && node.name && !ctx.symbols.has(node.name)) {
    ctx.imports.add(node.name);
  }
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' ||
        key === 'typeAnnotation' || key === 'returnType') continue;
    const child = node[key];
    if (child && typeof child === 'object') scanIdentifiers(ctx, child);
  }
}

// --- Utility: import arithmeticResult ---
// (Already imported at top of file)
import { arithmeticResult as arithmeticResultFn } from '../types.js';
