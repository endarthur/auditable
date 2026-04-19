// ⚠ GENERATED FILE — DO NOT EDIT. Source: ext/air/src/  Build: node ext/air/build.js
// @gcu/air — Auditable Intermediate Representation
// SSA IR for JS/TS analysis, type propagation, and optimized emission.

// -- types.js --

// @gcu/air — Type system
// Plain objects, no classes. See spec §2.

// --- Singleton type constructors ---

const I8    = Object.freeze({ kind: 'i8' });
const U8    = Object.freeze({ kind: 'u8' });
const I16   = Object.freeze({ kind: 'i16' });
const U16   = Object.freeze({ kind: 'u16' });
const I32   = Object.freeze({ kind: 'i32' });
const U32   = Object.freeze({ kind: 'u32' });
const I64   = Object.freeze({ kind: 'i64' });
const U64   = Object.freeze({ kind: 'u64' });
const F32   = Object.freeze({ kind: 'f32' });
const F64   = Object.freeze({ kind: 'f64' });
const BOOL  = Object.freeze({ kind: 'bool' });
const STRING = Object.freeze({ kind: 'string' });
const VOID  = Object.freeze({ kind: 'void' });
const DYNAMIC = Object.freeze({ kind: 'dynamic' });

function typedArray(element) {
  return Object.freeze({ kind: 'typed_array', element });
}

function array(element) {
  return Object.freeze({ kind: 'array', element });
}

function object(fields) {
  return Object.freeze({ kind: 'object', fields });
}

function func(params, ret) {
  return Object.freeze({ kind: 'function', params, ret });
}

// --- Type annotation mapping (spec §2.2) ---

const TS_TYPE_MAP = {
  // GCU numeric types
  'i8': I8, 'u8': U8, 'i16': I16, 'u16': U16,
  'i32': I32, 'u32': U32, 'i64': I64, 'u64': U64,
  'f32': F32, 'f64': F64, 'bool': BOOL,
  // Standard TS types
  'number': F64, 'boolean': BOOL, 'string': STRING, 'void': VOID,
  // Standard typed array constructors
  'Int8Array': typedArray('i8'), 'Uint8Array': typedArray('u8'),
  'Int16Array': typedArray('i16'), 'Uint16Array': typedArray('u16'),
  'Int32Array': typedArray('i32'), 'Uint32Array': typedArray('u32'),
  'Float32Array': typedArray('f32'), 'Float64Array': typedArray('f64'),
  'BigInt64Array': typedArray('i64'), 'BigUint64Array': typedArray('u64'),
  // GCU typed array aliases
  'i8array': typedArray('i8'), 'u8array': typedArray('u8'),
  'i16array': typedArray('i16'), 'u16array': typedArray('u16'),
  'i32array': typedArray('i32'), 'u32array': typedArray('u32'),
  'f32array': typedArray('f32'), 'f64array': typedArray('f64'),
  'i64array': typedArray('i64'), 'u64array': typedArray('u64'),
};

// Resolve a TS annotation AST node to an AIR type
function resolveAnnotation(node) {
  if (!node) return DYNAMIC;
  const ann = node.typeAnnotation || node;
  switch (ann.type) {
    case 'TSTypeAnnotation':
      return resolveAnnotation(ann.typeAnnotation);
    case 'TSTypeReference':
      return TS_TYPE_MAP[ann.typeName?.name] || DYNAMIC;
    case 'TSNumberKeyword': return F64;
    case 'TSBooleanKeyword': return BOOL;
    case 'TSStringKeyword': return STRING;
    case 'TSVoidKeyword': return VOID;
    case 'TSArrayType': {
      const el = resolveAnnotation(ann.elementType);
      return array(el);
    }
    default: return DYNAMIC;
  }
}

// --- Type predicates ---

function isNumeric(t) {
  const k = t.kind;
  return k === 'i8' || k === 'u8' || k === 'i16' || k === 'u16' ||
         k === 'i32' || k === 'u32' || k === 'i64' || k === 'u64' ||
         k === 'f32' || k === 'f64';
}

function isInteger(t) {
  const k = t.kind;
  return k === 'i8' || k === 'u8' || k === 'i16' || k === 'u16' ||
         k === 'i32' || k === 'u32' || k === 'i64' || k === 'u64';
}

function isFloat(t) {
  return t.kind === 'f32' || t.kind === 'f64';
}

function isSigned(t) {
  const k = t.kind;
  return k === 'i8' || k === 'i16' || k === 'i32' || k === 'i64';
}

function isDynamic(t) {
  return t.kind === 'dynamic';
}

function isConcrete(t) {
  return t.kind !== 'dynamic';
}

// --- Type width (bits) for promotion ---

const TYPE_WIDTH = {
  'i8': 8, 'u8': 8, 'i16': 16, 'u16': 16,
  'i32': 32, 'u32': 32, 'i64': 64, 'u64': 64,
  'f32': 32, 'f64': 64,
};

// Promotion hierarchy lookup
const PROMOTE_RANK = {
  'i8': 0, 'u8': 0, 'i16': 1, 'u16': 1,
  'i32': 2, 'u32': 2, 'i64': 3, 'u64': 3,
  'f32': 4, 'f64': 5,
};

const RANK_TO_SIGNED   = { 0: I8, 1: I16, 2: I32, 3: I64 };
const RANK_TO_UNSIGNED = { 0: U8, 1: U16, 2: U32, 3: U64 };

// --- Arithmetic result type (spec §2.5) ---

function arithmeticResult(lhs, rhs) {
  if (isDynamic(lhs) || isDynamic(rhs)) return DYNAMIC;
  if (!isNumeric(lhs) || !isNumeric(rhs)) return DYNAMIC;

  const lr = PROMOTE_RANK[lhs.kind];
  const rr = PROMOTE_RANK[rhs.kind];

  // Both float
  if (isFloat(lhs) && isFloat(rhs)) {
    return lr >= rr ? lhs : rhs;
  }
  // One float, one integer → float wins
  if (isFloat(lhs)) return lhs;
  if (isFloat(rhs)) return rhs;

  // Both integer — promote narrower, signed wins on same width
  if (lr !== rr) {
    const maxRank = Math.max(lr, rr);
    // use signed if either is signed
    if (isSigned(lhs) || isSigned(rhs)) return RANK_TO_SIGNED[maxRank];
    return RANK_TO_UNSIGNED[maxRank];
  }
  // Same width — signed wins
  if (isSigned(lhs) || isSigned(rhs)) return RANK_TO_SIGNED[lr];
  return RANK_TO_UNSIGNED[lr];
}

// Comparison always → bool
function comparisonResult(lhs, rhs) {
  return BOOL;
}

// Bitwise ops always → i32
function bitwiseResult() {
  return I32;
}

// --- Type equality ---

function typeEq(a, b) {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'typed_array') return a.element === b.element;
  if (a.kind === 'array') return typeEq(a.element, b.element);
  if (a.kind === 'function') {
    if (a.params.length !== b.params.length) return false;
    if (!typeEq(a.ret, b.ret)) return false;
    return a.params.every((p, i) => typeEq(p, b.params[i]));
  }
  if (a.kind === 'object') {
    const aKeys = [...a.fields.keys()].sort();
    const bKeys = [...b.fields.keys()].sort();
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k, i) => k === bKeys[i] && typeEq(a.fields.get(k), b.fields.get(k)));
  }
  return true;
}

// -- lower_js.js --

// @gcu/air — JS/TS lowerer: ESTree → AIR
// Spec §7: Lowering ESTree → AIR


// --- Op constructors ---

let _nextId = 0;

function resetIds() { _nextId = 0; }

function mkOp(op, args, type, loc, extra) {
  const id = '%' + (_nextId++);
  const o = { id, op, args, type, loc };
  if (extra) Object.assign(o, extra);
  return o;
}

// --- Mutable capture pre-pass (spec §3.3, §7.3) ---

function findMutableCaptured(ast) {
  const captured = new Set();
  const scopes = [new Set()]; // stack of variable scopes

  function currentScope() { return scopes[scopes.length - 1]; }
  function outerDeclared(name) {
    for (let i = scopes.length - 2; i >= 0; i--) {
      if (scopes[i].has(name)) return true;
    }
    return false;
  }

  function collectDeclarations(node) {
    if (!node) return;
    if (node.type === 'VariableDeclaration') {
      for (const decl of node.declarations) {
        collectPatternNames(decl.id, currentScope());
      }
    } else if (node.type === 'FunctionDeclaration' && node.id) {
      currentScope().add(node.id.name);
    }
  }

  function collectPatternNames(pattern, set) {
    if (!pattern) return;
    if (pattern.type === 'Identifier') {
      set.add(pattern.name);
    } else if (pattern.type === 'ObjectPattern') {
      for (const prop of pattern.properties) {
        if (prop.type === 'RestElement') collectPatternNames(prop.argument, set);
        else collectPatternNames(prop.value, set);
      }
    } else if (pattern.type === 'ArrayPattern') {
      for (const el of pattern.elements) {
        if (!el) continue;
        if (el.type === 'RestElement') collectPatternNames(el.argument, set);
        else collectPatternNames(el, set);
      }
    } else if (pattern.type === 'AssignmentPattern') {
      collectPatternNames(pattern.left, set);
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
      scopes.push(new Set());
      // collect params
      if (node.params) {
        for (const p of node.params) collectPatternNames(p, currentScope());
      }
      // collect body declarations
      if (node.body?.type === 'BlockStatement') {
        for (const stmt of node.body.body) collectDeclarations(stmt);
      }
      // walk body in nested function context
      walk(node.body, true);
      scopes.pop();
      return;
    }

    // Collect declarations for current scope
    collectDeclarations(node);

    // Check assignments to outer-scope variables inside functions
    if (inFunction) {
      if (node.type === 'AssignmentExpression' && node.left?.type === 'Identifier') {
        if (outerDeclared(node.left.name)) captured.add(node.left.name);
      }
      if (node.type === 'UpdateExpression' && node.argument?.type === 'Identifier') {
        if (outerDeclared(node.argument.name)) captured.add(node.argument.name);
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

class LowerCtx {
  constructor(mutableCaptured) {
    this.ops = [];
    this.symbols = new Map(); // name → current SSA id
    this.types = new Map();   // SSA id → type
    this.mutableCaptured = mutableCaptured;
    this.slots = new Map();   // name → slot SSA id
    this.topLevel = true;     // are we at cell top-level scope?
    this.defines = new Set(); // top-level definitions (for cell_export)
    this.imports = new Set(); // names referenced but not defined (cell_import candidates)
  }

  emit(op, args, type, loc, extra) {
    const o = mkOp(op, args, type, loc, extra);
    this.ops.push(o);
    if (type) this.types.set(o.id, type);
    return o;
  }

  loc(node) {
    return node?.loc?.start ? { line: node.loc.start.line, col: node.loc.start.column } : null;
  }
}

// --- Main lowering entry point ---

function lowerJS(ast, source) {
  resetIds();

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
    symbol_table: new Map(ctx.symbols),
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

    case 'BlockStatement':
      for (const s of node.body) lowerStatement(ctx, s);
      return null;

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

  // Lower function body in a new "scope" context
  const savedTopLevel = ctx.topLevel;
  ctx.topLevel = false;
  const bodyOps = [];
  const savedOps = ctx.ops;
  ctx.ops = bodyOps;

  if (node.body?.type === 'BlockStatement') {
    for (const stmt of node.body.body) lowerStatement(ctx, stmt);
  }

  ctx.ops = savedOps;
  ctx.topLevel = savedTopLevel;

  const fType = func(params.map(p => p.type), retType);
  const op = ctx.emit('func_region', [name], fType, l, {
    name, params, body: bodyOps, ret_type: retType,
    is_async: node.async || false,
    is_generator: node.generator || false,
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

  const savedOps = ctx.ops;

  ctx.ops = [];
  lowerStatement(ctx, node.consequent);
  const thenBody = ctx.ops;

  ctx.ops = [];
  if (node.alternate) lowerStatement(ctx, node.alternate);
  const elseBody = ctx.ops;

  ctx.ops = savedOps;

  return ctx.emit('if_region', [cond.id], VOID, l, {
    then_body: thenBody,
    else_body: elseBody,
    phis: [],
  });
}

function lowerFor(ctx, node) {
  const l = ctx.loc(node);
  const savedOps = ctx.ops;

  // init — for-header let/const are block-scoped, not top-level defines
  ctx.ops = [];
  const savedTopLevel = ctx.topLevel;
  ctx.topLevel = false;
  if (node.init) {
    if (node.init.type === 'VariableDeclaration') lowerVarDecl(ctx, node.init);
    else lowerExpr(ctx, node.init);
  }
  ctx.topLevel = savedTopLevel;
  const initOps = ctx.ops;

  // test
  ctx.ops = [];
  const test = node.test ? lowerExpr(ctx, node.test) : null;
  const testOps = ctx.ops;

  // update
  ctx.ops = [];
  if (node.update) lowerExpr(ctx, node.update);
  const updateOps = ctx.ops;

  // body
  ctx.ops = [];
  lowerStatement(ctx, node.body);
  const bodyOps = ctx.ops;

  ctx.ops = savedOps;

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
  const savedOps = ctx.ops;
  ctx.ops = [];

  // Declare the iteration variable (block-scoped, not top-level)
  if (node.left.type === 'VariableDeclaration') {
    const name = node.left.declarations[0]?.id?.name;
    if (name) {
      ctx.symbols.set(name, null);
    }
  }

  lowerStatement(ctx, node.body);
  const bodyOps = ctx.ops;
  ctx.ops = savedOps;

  return ctx.emit('for_in_region', [iter.id], VOID, l, { body: bodyOps, phis: [] });
}

function lowerForOf(ctx, node) {
  const l = ctx.loc(node);
  const iter = lowerExpr(ctx, node.right);
  const savedOps = ctx.ops;
  ctx.ops = [];

  if (node.left.type === 'VariableDeclaration') {
    const name = node.left.declarations[0]?.id?.name;
    if (name) {
      ctx.symbols.set(name, null);
    }
  }

  lowerStatement(ctx, node.body);
  const bodyOps = ctx.ops;
  ctx.ops = savedOps;

  return ctx.emit('for_of_region', [iter.id], VOID, l, { body: bodyOps, phis: [] });
}

function lowerWhile(ctx, node) {
  const l = ctx.loc(node);
  const savedOps = ctx.ops;

  ctx.ops = [];
  const cond = lowerExpr(ctx, node.test);
  const testOps = ctx.ops;

  ctx.ops = [];
  lowerStatement(ctx, node.body);
  const bodyOps = ctx.ops;

  ctx.ops = savedOps;

  return ctx.emit('loop_region', [], VOID, l, {
    test: testOps, test_val: cond.id,
    body: bodyOps, phis: [],
    loop_kind: 'while',
  });
}

function lowerDoWhile(ctx, node) {
  const l = ctx.loc(node);
  const savedOps = ctx.ops;

  ctx.ops = [];
  lowerStatement(ctx, node.body);
  const bodyOps = ctx.ops;

  ctx.ops = [];
  const cond = lowerExpr(ctx, node.test);
  const testOps = ctx.ops;

  ctx.ops = savedOps;

  return ctx.emit('loop_region', [], VOID, l, {
    test: testOps, test_val: cond.id,
    body: bodyOps, phis: [],
    loop_kind: 'do_while',
  });
}

function lowerSwitch(ctx, node) {
  const l = ctx.loc(node);
  const disc = lowerExpr(ctx, node.discriminant);
  const savedOps = ctx.ops;

  const cases = [];
  for (const c of node.cases) {
    // Lower test expression separately from body
    ctx.ops = [];
    const test = c.test ? lowerExpr(ctx, c.test) : null;
    const testOps = ctx.ops;

    ctx.ops = [];
    for (const stmt of c.consequent) lowerStatement(ctx, stmt);
    cases.push({ test_ops: testOps, test_val: test?.id || null, body: ctx.ops });
  }

  ctx.ops = savedOps;
  return ctx.emit('switch_region', [disc.id], VOID, l, { cases });
}

function lowerTry(ctx, node) {
  const l = ctx.loc(node);
  const savedOps = ctx.ops;

  ctx.ops = [];
  lowerStatement(ctx, node.block);
  const tryBody = ctx.ops;

  let catchParam = null;
  let catchBody = [];
  if (node.handler) {
    ctx.ops = [];
    if (node.handler.param?.type === 'Identifier') {
      catchParam = node.handler.param.name;
    }
    lowerStatement(ctx, node.handler.body);
    catchBody = ctx.ops;
  }

  let finallyBody = [];
  if (node.finalizer) {
    ctx.ops = [];
    lowerStatement(ctx, node.finalizer);
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

function lowerLabeled(ctx, node) {
  const l = ctx.loc(node);
  const savedOps = ctx.ops;
  ctx.ops = [];
  lowerStatement(ctx, node.body);
  const body = ctx.ops;
  ctx.ops = savedOps;
  return ctx.emit('labeled', [node.label.name], VOID, l, { body });
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
      const savedOps = ctx.ops;
      ctx.ops = [];
      for (const stmt of member.body) lowerStatement(ctx, stmt);
      const body = ctx.ops;
      ctx.ops = savedOps;
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

    const savedOps = ctx.ops;
    ctx.ops = [];
    if (fn.body?.type === 'BlockStatement') {
      for (const stmt of fn.body.body) lowerStatement(ctx, stmt);
    }
    const bodyOps = ctx.ops;
    ctx.ops = savedOps;

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

    case 'TaggedTemplateExpression': {
      // Lower the tag (e.g. atra, glsl, sql) to capture its reference
      const tag = lowerExpr(ctx, node.tag);
      // Lower template expressions to capture their references
      for (const expr of node.quasi.expressions) lowerExpr(ctx, expr);
      return ctx.emit('call', [tag.id], DYNAMIC, l);
    }

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
    // Unary + is a ToNumber coercion
    const arg = lowerExpr(ctx, node.argument);
    return ctx.emit('add', [arg.id], F64, l); // coercion hint
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
      return ctx.emit('array_set', [obj.id, key.id, rhs.id], VOID, l);
    } else {
      const key = (node.left.property.type === 'PrivateIdentifier' ? '#' : '') + node.left.property.name;
      return ctx.emit('object_set', [obj.id, key, rhs.id], VOID, l);
    }
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

  const savedOps = ctx.ops;

  ctx.ops = [];
  const thenVal = lowerExpr(ctx, node.consequent);
  const thenBody = ctx.ops;

  ctx.ops = [];
  const elseVal = lowerExpr(ctx, node.alternate);
  const elseBody = ctx.ops;

  ctx.ops = savedOps;

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
  const savedOps = ctx.ops;
  ctx.topLevel = false;
  ctx.ops = [];

  const body = node.body;
  if (body.type === 'BlockStatement') {
    for (const stmt of body.body) lowerStatement(ctx, stmt);
  } else {
    // Arrow with expression body
    const val = lowerExpr(ctx, body);
    ctx.emit('return', [val.id], VOID, ctx.loc(body));
  }

  const bodyOps = ctx.ops;
  ctx.ops = savedOps;
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

// -- lower_adder.js --

// @gcu/air — adder (Python) → AIR lowerer
// Translates adder's Python AST into AIR ops. Python semantics preserved via
// calls to _py runtime helpers. Throws AirLowerError for unsupported nodes,
// triggering fallback to the tree-walker.


class AirLowerError extends Error {}

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

function lowerAdder(ast, source) {
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
  // import a, b as c, d.e as f
  for (const { module, alias } of node.names) {
    const nameConst = ctx.emit('const', [module], STRING, l);
    const mod = emitPyCall(ctx, 'import', [nameConst], l);
    // For dotted names like `a.b`, bind the top-level `a` unless aliased.
    const bindName = alias || module.split('.')[0];
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
  const moduleName = ctx.emit('const', [node.module], STRING, l);
  const result = emitPyCall(ctx, 'importFrom', [moduleName, namesArr], l);
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

// -- lower_soft.js --

// @gcu/air — Soft → AIR lowerer
// Soft is simpler than Python: direct JS arithmetic, JS-semantic comparison,
// no dunder methods, no classes. Result: fewer _soft helper calls than _py needed.


class SoftLowerError extends Error {}

let _softNextId = 0;
function _softResetIds() { _softNextId = 0; }
function _softMkOp(op, args, type, loc, extra) {
  const id = '%' + (_softNextId++);
  const o = { id, op, args, type: type || DYNAMIC, loc };
  if (extra) Object.assign(o, extra);
  return o;
}

class SoftLowerCtx {
  constructor() {
    this.ops = [];
    this.symbols = new Map();
    this.types = new Map();
    this.topLevel = true;
    this.defines = new Set();
    this.imports = new Set();
    this.source = null;
  }
  emit(op, args, type, loc, extra) {
    const o = _softMkOp(op, args, type, loc, extra);
    this.ops.push(o);
    if (type) this.types.set(o.id, type);
    return o;
  }
  loc(node) {
    return node?.line != null ? { line: node.line, col: 0 } : null;
  }
}

// _soft.XYZ call
function emitSoftCall(ctx, method, args, loc, type) {
  const softLoad = ctx.emit('load', ['_soft'], DYNAMIC, loc);
  const methodGet = ctx.emit('object_get', [softLoad.id, method], DYNAMIC, loc);
  return ctx.emit('call', [methodGet.id, ...args.map(a => a.id)], type || DYNAMIC, loc);
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

function lowerSoft(ast, source) {
  _softResetIds();
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
    symbol_table: new Map(ctx.symbols),
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

  const savedOps = ctx.ops;
  ctx.ops = [];
  const right = lowerExpr_sf(ctx, node.right);
  const rightBody = ctx.ops;
  ctx.ops = savedOps;

  if (node.op === 'and') {
    return ctx.emit('if_region', [truthy.id], DYNAMIC, l, {
      then_body: rightBody,
      else_body: [],
      phis: [{ then_val: right.id, else_val: left.id }],
    });
  }
  // or
  return ctx.emit('if_region', [truthy.id], DYNAMIC, l, {
    then_body: [],
    else_body: rightBody,
    phis: [{ then_val: left.id, else_val: right.id }],
  });
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

  const savedOps = ctx.ops;
  ctx.ops = [];
  const thenVal = lowerExpr_sf(ctx, node.ifTrue);
  const thenBody = ctx.ops;
  ctx.ops = [];
  const elseVal = lowerExpr_sf(ctx, node.ifFalse);
  const elseBody = ctx.ops;
  ctx.ops = savedOps;

  return ctx.emit('if_region', [truthy.id], DYNAMIC, l, {
    then_body: thenBody,
    else_body: elseBody,
    phis: [{ then_val: thenVal.id, else_val: elseVal.id }],
  });
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
  const savedOps = ctx.ops;
  const savedSymbols = ctx.symbols;

  ctx.topLevel = false;
  ctx.ops = [];
  ctx.symbols = new Map(savedSymbols);
  for (const p of params) {
    const pname = p.name.replace(/^\.\.\./, '');
    ctx.symbols.set(pname, null);
  }
  // Soft functions use `it` as implicit result
  ctx.symbols.set('it', null);

  for (const s of node.body) lowerStmt_sf(ctx, s);
  const body = ctx.ops;

  ctx.ops = savedOps;
  ctx.topLevel = savedTopLevel;
  ctx.symbols = savedSymbols;

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

  const savedOps = ctx.ops;
  ctx.ops = [];
  for (const s of node.body) lowerStmt_sf(ctx, s);
  const thenBody = ctx.ops;
  ctx.ops = [];
  if (node.elseBody) for (const s of node.elseBody) lowerStmt_sf(ctx, s);
  const elseBody = ctx.ops;
  ctx.ops = savedOps;

  return ctx.emit('if_region', [truthy.id], VOID, l, {
    then_body: thenBody, else_body: elseBody, phis: [],
  });
}

function lowerWhile_sf(ctx, node) {
  const l = ctx.loc(node);
  const savedOps = ctx.ops;

  ctx.ops = [];
  const cond = lowerExpr_sf(ctx, node.cond);
  const truthy = emitSoftCall(ctx, 'truthy', [cond], l, BOOL);
  const testOps = ctx.ops;

  ctx.ops = [];
  for (const s of node.body) lowerStmt_sf(ctx, s);
  const body = ctx.ops;
  ctx.ops = savedOps;

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

  const savedOps = ctx.ops;
  ctx.ops = [];
  for (const s of node.body) lowerStmt_sf(ctx, s);
  const body = ctx.ops;
  ctx.ops = savedOps;

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

  const savedOps = ctx.ops;

  ctx.ops = [];
  const from = lowerExpr_sf(ctx, node.from);
  ctx.emit('store', [varName, from.id], VOID, l);
  ctx.symbols.set(varName, from.id);
  const initOps = ctx.ops;

  ctx.ops = [];
  const to = lowerExpr_sf(ctx, node.to);
  const vLoad = ctx.emit('load', [varName], DYNAMIC, l);
  const testOp = ctx.emit('lte', [vLoad.id, to.id], BOOL, l);
  const testOps = ctx.ops;

  ctx.ops = [];
  const stepVal = node.step ? lowerExpr_sf(ctx, node.step) : ctx.emit('const', [1], I32, l);
  const vLoad2 = ctx.emit('load', [varName], DYNAMIC, l);
  const newV = ctx.emit('add', [vLoad2.id, stepVal.id], DYNAMIC, l);
  ctx.emit('store', [varName, newV.id], VOID, l);
  const updateOps = ctx.ops;

  ctx.ops = [];
  for (const s of node.body) lowerStmt_sf(ctx, s);
  const body = ctx.ops;

  ctx.ops = savedOps;

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
  const tempVar = `__rep_${_softNextId}`;

  const savedOps = ctx.ops;

  ctx.ops = [];
  const zero = ctx.emit('const', [0], I32, l);
  ctx.emit('store', [tempVar, zero.id], VOID, l);
  ctx.symbols.set(tempVar, zero.id);
  const initOps = ctx.ops;

  ctx.ops = [];
  const vLoad = ctx.emit('load', [tempVar], DYNAMIC, l);
  const testOp = ctx.emit('lt', [vLoad.id, countExpr.id], BOOL, l);
  const testOps = ctx.ops;

  ctx.ops = [];
  const one = ctx.emit('const', [1], I32, l);
  const vLoad2 = ctx.emit('load', [tempVar], DYNAMIC, l);
  const newV = ctx.emit('add', [vLoad2.id, one.id], I32, l);
  ctx.emit('store', [tempVar, newV.id], VOID, l);
  const updateOps = ctx.ops;

  ctx.ops = [];
  for (const s of node.body) lowerStmt_sf(ctx, s);
  const body = ctx.ops;

  ctx.ops = savedOps;

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

  const savedOps = ctx.ops;
  ctx.ops = [];
  const msg = node.message ? lowerExpr_sf(ctx, node.message)
    : ctx.emit('const', ['assumption failed'], STRING, l);
  ctx.emit('throw', [msg.id], VOID, l);
  const thenBody = ctx.ops;
  ctx.ops = savedOps;

  const notTruthy = ctx.emit('logical_not', [truthy.id], BOOL, l);
  ctx.emit('if_region', [notTruthy.id], VOID, l, {
    then_body: thenBody, else_body: [], phis: [],
  });
  return null;
}

// -- passes.js --

// @gcu/air — Optimization passes
// Spec §8: Type propagation, constant folding, DCE, dependency extraction


// Helper: take union of two types. Identical → that type. Otherwise DYNAMIC.
function unionType(a, b) {
  if (!a) return b || DYNAMIC;
  if (!b) return a;
  if (typeEq(a, b)) return a;
  return DYNAMIC;
}

// Infer the element type from an iterable's SSA id.
// Handles: `range(...)` → i32, `_py.iter(range(...))` → i32,
//          Float64Array-typed arrays → f64, etc.
function inferIterableElementType(ssaId, allOps) {
  const op = findOpAnywhere(allOps, ssaId);
  if (!op) return null;

  // Typed array → element type
  if (op.op === 'ta_new' || (op.type && op.type.kind === 'typed_array')) {
    const elName = op.type?.element;
    if (elName === 'f64') return F64;
    if (elName === 'f32') return { kind: 'f32' };
    if (elName && elName !== 'i64' && elName !== 'u64') return I32;
  }

  // Peel off _py.iter(X) or await _py.iter(X) wrapping
  if (op.op === 'await') return inferIterableElementType(op.args[0], allOps);
  if (op.op === 'call') {
    // Check if callee is _py.iter
    const calleeOp = findOpAnywhere(allOps, op.args[0]);
    if (calleeOp && calleeOp.op === 'object_get' && calleeOp.args[1] === 'iter') {
      const rtOp = findOpAnywhere(allOps, calleeOp.args[0]);
      if (rtOp && rtOp.op === 'load' && rtOp.args[0] === '_py') {
        // Recurse into inner: _py.iter(X) has element = element-of(X)
        return inferIterableElementType(op.args[1], allOps);
      }
    }
    // Check if it's a call to `range(...)` — builtin that yields i32
    // The callee is a load of 'range'
    if (calleeOp && calleeOp.op === 'load' && calleeOp.args[0] === 'range') {
      return I32;
    }
  }
  return null;
}

// Typed-array element type lookup
function taElementType(t) {
  if (!t || t.kind !== 'typed_array') return null;
  const k = t.element;
  if (k === 'i8' || k === 'u8' || k === 'i16' || k === 'u16' ||
      k === 'i32' || k === 'u32') return I32;
  if (k === 'i64' || k === 'u64') return DYNAMIC; // BigInt
  if (k === 'f32') return { kind: 'f32' };
  if (k === 'f64') return F64;
  return DYNAMIC;
}

// =============================================================================
// §8.1 — Type propagation (enhanced: tracks name → type across stores/loads)
// =============================================================================

function propagateTypes(module, opts = {}) {
  const types = new Map();     // SSA id → type
  const nameTypes = new Map(); // variable name → current type
  const nameOrigins = new Map(); // variable name → current value SSA id

  // Resolve a value ssa id through load ops (using currently-tracked origins)
  function resolveValue(ssaId) {
    const op = findOpAnywhere(module.ops, ssaId);
    if (!op) return null;
    if (op.op === 'load' && typeof op.args[0] === 'string') {
      const originId = nameOrigins.get(op.args[0]);
      if (originId) return resolveValue(originId);
    }
    return op;
  }

  // Seed nameTypes from imports (cross-cell type flow)
  // opts.importTypes: Map<importName, Type>
  if (opts.importTypes) {
    for (const [name, t] of opts.importTypes) {
      nameTypes.set(name, t);
    }
  }

  function typeOf(id) {
    return types.get(id) || DYNAMIC;
  }

  // When processing a branched region, collect writes so outer scope can union/invalidate
  function collectWrittenNames(ops, writes) {
    for (const op of ops || []) {
      if (op.op === 'store' && typeof op.args[0] === 'string') {
        writes.add(op.args[0]);
      }
      // Recurse into sub-regions
      if (op.then_body) collectWrittenNames(op.then_body, writes);
      if (op.else_body) collectWrittenNames(op.else_body, writes);
      if (op.body) collectWrittenNames(op.body, writes);
      if (op.init) collectWrittenNames(op.init, writes);
      if (op.test) collectWrittenNames(op.test, writes);
      if (op.update) collectWrittenNames(op.update, writes);
      if (op.try_body) collectWrittenNames(op.try_body, writes);
      if (op.catch_body) collectWrittenNames(op.catch_body, writes);
      if (op.finally_body) collectWrittenNames(op.finally_body, writes);
      if (op.cases) for (const c of op.cases) collectWrittenNames(c.body, writes);
    }
  }

  function propagate(ops) {
    for (const op of ops) {
      // Carry existing type (set at lowering time via annotation or literal)
      if (op.type && !isDynamic(op.type)) {
        types.set(op.id, op.type);
      }

      switch (op.op) {
        case 'const':
          types.set(op.id, op.type);
          break;

        case 'add': case 'sub': case 'mul': case 'div': case 'mod': case 'exp': {
          const lt = typeOf(op.args[0]);
          const rt = typeOf(op.args[1]);
          if (op.op === 'add' && (lt.kind === 'string' || rt.kind === 'string')) {
            op.type = STRING;
          } else if (!isDynamic(lt) && !isDynamic(rt) && isNumeric(lt) && isNumeric(rt)) {
            op.type = arithmeticResult(lt, rt);
          }
          types.set(op.id, op.type);
          break;
        }

        case 'neg': {
          const t = typeOf(op.args[0]);
          if (isNumeric(t)) op.type = t;
          types.set(op.id, op.type);
          break;
        }

        case 'bitwise_or': case 'bitwise_and': case 'bitwise_xor':
        case 'shift_left': case 'shift_right': case 'ushift_right':
        case 'bitwise_not':
          op.type = I32;
          types.set(op.id, I32);
          break;

        case 'eq': case 'neq': case 'lt': case 'lte': case 'gt': case 'gte':
        case 'logical_not': case 'in': case 'instanceof':
          op.type = BOOL;
          types.set(op.id, BOOL);
          break;

        case 'logical_and': case 'logical_or': case 'nullish_coalesce': {
          const lt = typeOf(op.args[0]);
          const rt = typeOf(op.args[1]);
          op.type = typeEq(lt, rt) ? lt : DYNAMIC;
          types.set(op.id, op.type);
          break;
        }

        case 'typeof':
          op.type = STRING;
          types.set(op.id, STRING);
          break;

        case 'load': {
          const name = op.args[0];
          // Prefer tracked name type; fallback to op's declared type
          const t = nameTypes.has(name) ? nameTypes.get(name) : (op.type || DYNAMIC);
          op.type = t;
          types.set(op.id, t);
          break;
        }

        case 'store': {
          const name = op.args[0];
          const valId = op.args[1];
          const valType = typeOf(valId);
          // If store has a declared type (from annotation), prefer it.
          // Otherwise inherit the value's type.
          const declared = op.type && !isDynamic(op.type) && op.type.kind !== 'void';
          const t = declared ? op.type : valType;
          nameTypes.set(name, t);
          nameOrigins.set(name, valId);
          types.set(op.id, VOID);
          break;
        }

        case 'slot_load': {
          types.set(op.id, op.type || DYNAMIC);
          break;
        }

        case 'slot_store': {
          types.set(op.id, VOID);
          break;
        }

        case 'object_get': {
          // If the object was produced (possibly through a load chain) by an
          // object_new with a statically-known field matching this key, infer
          // the field's type.
          const objId = op.args[0];
          const key = op.args[1];
          let inferred = op.type || DYNAMIC;
          if (typeof key === 'string' && isDynamic(inferred)) {
            const srcOp = resolveValue(objId);
            if (srcOp && srcOp.op === 'object_new' && Array.isArray(srcOp.args)) {
              for (const pair of srcOp.args) {
                if (pair && pair.key === key && pair.id) {
                  const fieldT = types.get(pair.id);
                  if (fieldT && !isDynamic(fieldT)) inferred = fieldT;
                  break;
                }
              }
            }
          }
          op.type = inferred;
          types.set(op.id, inferred);
          break;
        }
        case 'array_get': {
          types.set(op.id, op.type || DYNAMIC);
          break;
        }

        case 'ta_new': {
          types.set(op.id, op.type);
          break;
        }

        case 'ta_get': {
          // Typed array indexing returns the element type
          const arrT = typeOf(op.args[0]);
          const elT = taElementType(arrT);
          if (elT) { op.type = elT; }
          types.set(op.id, op.type || DYNAMIC);
          break;
        }

        case 'array_new': {
          types.set(op.id, op.type || DYNAMIC);
          break;
        }

        case 'object_new': {
          types.set(op.id, op.type || DYNAMIC);
          break;
        }

        case 'call': case 'call_method': {
          // TODO: infer return type from typed callee signatures
          types.set(op.id, op.type || DYNAMIC);
          break;
        }

        case 'await': {
          // await unwraps Promise but we don't track Promise<T> — pass-through
          types.set(op.id, op.type || DYNAMIC);
          break;
        }

        case 'func_region': {
          types.set(op.id, op.type);
          // Recurse into body with a scope snapshot
          const saved = new Map(nameTypes);
          // Seed params with their declared types
          if (op.params) {
            for (const p of op.params) {
              if (p.type && !isDynamic(p.type)) {
                nameTypes.set(p.name, p.type);
              }
            }
          }
          if (op.body) propagate(op.body);
          // Restore outer scope
          nameTypes.clear();
          for (const [k, v] of saved) nameTypes.set(k, v);
          break;
        }

        case 'class_region': {
          types.set(op.id, op.type || DYNAMIC);
          // Classes don't (currently) contribute to type propagation
          break;
        }

        case 'if_region': {
          // Save types, walk each branch, then union writes.
          const saved = new Map(nameTypes);
          const thenTypes = new Map(saved);

          nameTypes.clear();
          for (const [k, v] of saved) nameTypes.set(k, v);
          if (op.then_body) propagate(op.then_body);
          const afterThen = new Map(nameTypes);

          nameTypes.clear();
          for (const [k, v] of saved) nameTypes.set(k, v);
          if (op.else_body) propagate(op.else_body);
          const afterElse = new Map(nameTypes);

          // Merge: union of both branches, plus original for names written in neither
          nameTypes.clear();
          for (const [k, v] of saved) nameTypes.set(k, v);
          const written = new Set();
          collectWrittenNames(op.then_body || [], written);
          collectWrittenNames(op.else_body || [], written);
          for (const name of written) {
            const t1 = afterThen.has(name) ? afterThen.get(name) : saved.get(name);
            const t2 = afterElse.has(name) ? afterElse.get(name) : saved.get(name);
            nameTypes.set(name, unionType(t1, t2));
          }

          types.set(op.id, op.type || VOID);
          break;
        }

        case 'for_region': {
          // Variables written in the loop become dynamic (could be any iteration's type)
          const writtenNames = new Set();
          collectWrittenNames(op.init || [], writtenNames);
          collectWrittenNames(op.body || [], writtenNames);
          collectWrittenNames(op.update || [], writtenNames);

          if (op.init) propagate(op.init);
          if (op.test) propagate(op.test);
          if (op.update) propagate(op.update);
          if (op.body) propagate(op.body);

          // After the loop, loop-variable types may differ from the pre-loop state.
          // Leave current nameTypes as-is (last iteration's types).
          types.set(op.id, VOID);
          break;
        }

        case 'loop_region': {
          if (op.test) propagate(op.test);
          if (op.body) propagate(op.body);
          types.set(op.id, VOID);
          break;
        }

        case 'for_in_region': case 'for_of_region': {
          // If the iterable is `_py.iter(range(...))` or `range(...)`, element is i32.
          // This covers the common "for i in range(n)" pattern in transpiled adder.
          if (op.op === 'for_of_region' && op.target_name) {
            const elT = inferIterableElementType(op.args[0], module.ops);
            if (elT) nameTypes.set(op.target_name, elT);
          }
          if (op.body) propagate(op.body);
          types.set(op.id, VOID);
          break;
        }

        case 'try_region': {
          if (op.try_body) propagate(op.try_body);
          if (op.catch_body) propagate(op.catch_body);
          if (op.finally_body) propagate(op.finally_body);
          // After try, names written in try/catch could be either's type.
          // Conservatively dynamic.
          const written = new Set();
          collectWrittenNames(op.try_body || [], written);
          collectWrittenNames(op.catch_body || [], written);
          for (const name of written) nameTypes.set(name, DYNAMIC);
          types.set(op.id, VOID);
          break;
        }

        case 'switch_region': {
          if (op.cases) {
            for (const c of op.cases) {
              if (c.test_ops) propagate(c.test_ops);
              if (c.body) propagate(c.body);
            }
          }
          types.set(op.id, VOID);
          break;
        }

        default:
          if (!types.has(op.id)) types.set(op.id, op.type || DYNAMIC);
      }
    }
  }

  propagate(module.ops);

  // Update the module's exports map with inferred types
  if (module.exports) {
    for (const [name, exp] of module.exports) {
      if (nameTypes.has(name)) {
        const t = nameTypes.get(name);
        if (t && !isDynamic(t)) {
          exp.type = t;
        }
      }
    }
  }

  return types;
}

// =============================================================================
// §8.2 — Constant folding
// =============================================================================

function foldConstants(module) {
  let changed = false;

  function fold(ops) {
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];

      // Recurse into regions
      if (op.then_body) fold(op.then_body);
      if (op.else_body) fold(op.else_body);
      if (op.body) fold(op.body);
      if (op.init) fold(op.init);
      if (op.test) fold(op.test);
      if (op.update) fold(op.update);

      // Fold binary ops on constants
      if ((op.op === 'add' || op.op === 'sub' || op.op === 'mul' ||
           op.op === 'div' || op.op === 'mod') && op.args.length === 2) {
        const lhsOp = findOpById(module.ops, op.args[0]);
        const rhsOp = findOpById(module.ops, op.args[1]);
        if (lhsOp?.op === 'const' && rhsOp?.op === 'const' &&
            typeof lhsOp.args[0] === 'number' && typeof rhsOp.args[0] === 'number') {
          let val;
          switch (op.op) {
            case 'add': val = lhsOp.args[0] + rhsOp.args[0]; break;
            case 'sub': val = lhsOp.args[0] - rhsOp.args[0]; break;
            case 'mul': val = lhsOp.args[0] * rhsOp.args[0]; break;
            case 'div': val = lhsOp.args[0] / rhsOp.args[0]; break;
            case 'mod': val = lhsOp.args[0] % rhsOp.args[0]; break;
          }
          if (val !== undefined && isFinite(val)) {
            op.op = 'const';
            op.args = [val];
            op.type = Number.isInteger(val) && val >= -2147483648 && val <= 2147483647 ? I32 : F64;
            changed = true;
          }
        }
      }

      // Fold negation of constant
      if (op.op === 'neg' && op.args.length === 1) {
        const argOp = findOpById(module.ops, op.args[0]);
        if (argOp?.op === 'const' && typeof argOp.args[0] === 'number') {
          op.op = 'const';
          op.args = [-argOp.args[0]];
          changed = true;
        }
      }
    }
  }

  fold(module.ops);
  return changed;
}

function findOpById(ops, id) {
  for (const op of ops) {
    if (op.id === id) return op;
    if (op.then_body) { const r = findOpById(op.then_body, id); if (r) return r; }
    if (op.else_body) { const r = findOpById(op.else_body, id); if (r) return r; }
    if (op.body) { const r = findOpById(op.body, id); if (r) return r; }
    if (op.init) { const r = findOpById(op.init, id); if (r) return r; }
    if (op.test) { const r = findOpById(op.test, id); if (r) return r; }
    if (op.update) { const r = findOpById(op.update, id); if (r) return r; }
  }
  return null;
}

// =============================================================================
// §8.3 — Dead code elimination
// =============================================================================

function eliminateDeadCode(module) {
  // Mark roots: exports, calls, opaques, slot_stores
  const live = new Set();

  function markReachable(ops) {
    for (const op of ops) {
      // Always-live ops
      if (op.op === 'opaque' || op.op === 'call' || op.op === 'call_method' ||
          op.op === 'slot_store' || op.op === 'store' || op.op === 'object_set' ||
          op.op === 'array_set' || op.op === 'ta_set' || op.op === 'await' ||
          op.op === 'return' || op.op === 'break' || op.op === 'continue') {
        live.add(op.id);
      }

      // Recurse into regions (all region contents are potentially live)
      if (op.then_body) markReachable(op.then_body);
      if (op.else_body) markReachable(op.else_body);
      if (op.body) markReachable(op.body);
      if (op.init) markReachable(op.init);
      if (op.test) markReachable(op.test);
      if (op.update) markReachable(op.update);

      // Regions themselves are live
      if (op.op === 'if_region' || op.op === 'for_region' || op.op === 'loop_region' ||
          op.op === 'for_in_region' || op.op === 'for_of_region' || op.op === 'func_region') {
        live.add(op.id);
      }
    }
  }

  markReachable(module.ops);

  // For now, don't actually remove ops — just mark them.
  // Full DCE requires backward reachability analysis which we can add later.
  return live;
}

// =============================================================================
// §8.4 — Dependency extraction
// =============================================================================

function extractDependencies(module) {
  // Extract which names are defined and used
  return {
    defines: new Set(module.defines),
    uses: new Set(module.imports),
  };
}

// =============================================================================
// §8.5 — Hint insertion
// =============================================================================

function insertHints(module, typeMap) {
  function hint(ops) {
    for (const op of ops) {
      if ((op.op === 'add' || op.op === 'sub' || op.op === 'mul' || op.op === 'div' || op.op === 'mod') &&
          isConcrete(op.type) && isNumeric(op.type)) {
        if (!op.meta) op.meta = {};
        op.meta.hint = 'typed';
      }

      // Recurse
      if (op.then_body) hint(op.then_body);
      if (op.else_body) hint(op.else_body);
      if (op.body) hint(op.body);
      if (op.init) hint(op.init);
      if (op.test) hint(op.test);
      if (op.update) hint(op.update);
    }
  }

  hint(module.ops);
}

// =============================================================================
// §8.7 — Runtime helper specialization
// =============================================================================
// Detect calls to runtime helpers (`_py.add`, `_soft.eq`, etc.) where we can
// prove the operands' types, and replace with raw AIR ops. The emitter then
// outputs direct JS operators, skipping the helper call entirely.
//
// This is the big win for typed numeric loops in adder/Soft — instead of
// `_py.add(a, b)` → `a + b` directly.

// Helper method name → { op, resultType, check(lt, rt) }
// check() returns true if the operands' types allow this specialization.
const PY_SPECIALIZATIONS = {
  add: {
    op: 'add',
    // Numbers: same-type addition. Strings: concat. Mixed: skip.
    check: (lt, rt) => {
      if (isNumeric(lt) && isNumeric(rt)) return true;
      if (lt.kind === 'string' && rt.kind === 'string') return true;
      return false;
    },
    resultType: (lt, rt) => {
      if (isNumeric(lt) && isNumeric(rt)) return arithmeticResult(lt, rt);
      return STRING;
    },
  },
  sub: { op: 'sub', check: bothNumeric, resultType: arithmeticResult },
  mul: { op: 'mul', check: bothNumeric, resultType: arithmeticResult },
  // div/mod/floordiv stay in helpers: Python raises ZeroDivisionError, JS returns Infinity/NaN
  pow: { op: 'exp', check: bothNumeric, resultType: arithmeticResult },
  eq: {
    op: 'eq',
    check: (lt, rt) => isNumeric(lt) && isNumeric(rt),
    resultType: () => BOOL,
  },
  neq: {
    op: 'neq',
    check: (lt, rt) => isNumeric(lt) && isNumeric(rt),
    resultType: () => BOOL,
  },
  lt:  { op: 'lt',  check: bothNumeric, resultType: () => BOOL },
  lte: { op: 'lte', check: bothNumeric, resultType: () => BOOL },
  gt:  { op: 'gt',  check: bothNumeric, resultType: () => BOOL },
  gte: { op: 'gte', check: bothNumeric, resultType: () => BOOL },
  neg: {
    op: 'neg',
    arity: 1,
    check: (t) => isNumeric(t),
    resultType: (t) => t,
  },
  truthy: {
    // _py.truthy(true) → just the value (already bool)
    // _py.truthy(x) where x is numeric → x !== 0 (handled via coerce)
    op: null, arity: 1, // handled specially below
    check: (t) => t.kind === 'bool',
    resultType: () => BOOL,
    // For bool input, the helper call is redundant; inline the arg.
    passthrough: true,
  },
};

// Soft specializations — very similar semantics to Python for numeric ops
const SOFT_SPECIALIZATIONS = {
  // Note: Soft's _soft.eq is case-insensitive for strings, so only specialize for numbers.
  eq:  { op: 'eq',  check: bothNumeric, resultType: () => BOOL },
  neq: { op: 'neq', check: bothNumeric, resultType: () => BOOL },
  between: {
    op: null, arity: 3,
    check: (v, lo, hi) => isNumeric(v) && isNumeric(lo) && isNumeric(hi),
    resultType: () => BOOL,
    // Will be handled as: (v >= lo) && (v <= hi). Custom emit.
    customEmit: true,
  },
};

function bothNumeric(lt, rt) {
  return isNumeric(lt) && isNumeric(rt);
}

// Detect sequences like:
//   %A = load "_py"
//   %B = object_get %A, "methodName"
//   %C = call [%B, arg1, arg2]
// and replace %C with a direct AIR op if specialization applies.
//
// We also handle the adder's "awaited call" pattern:
//   %A = load "_py"
//   %B = object_get %A, "methodName"
//   %C = call [%B, arg1, arg2]
//   %D = await [%C]
// In that case we replace both %C and %D; subsequent uses of %D get redirected to the new op.
// Walks ops in order; for each name, tracks the origin op of its current value.
// If a name has a unique origin, we can trace `load name` back to that origin
// for specialization purposes. If reassigned with different origins, the current
// value can change — we use the most recent.
function computeNameOrigins(allOps) {
  const origins = new Map(); // name → SSA id of the value stored
  const opsById = new Map(); // SSA id → op, for fast lookup
  function visit(ops) {
    for (const op of ops) {
      if (op.id) opsById.set(op.id, op);
      if (op.op === 'store' && typeof op.args[0] === 'string') {
        origins.set(op.args[0], op.args[1]);
      }
      for (const key of ['then_body', 'else_body', 'body', 'init', 'test',
                         'update', 'try_body', 'catch_body', 'finally_body']) {
        if (op[key]) visit(op[key]);
      }
      if (op.cases) for (const c of op.cases) {
        if (c.test_ops) visit(c.test_ops);
        if (c.body) visit(c.body);
      }
    }
  }
  visit(allOps);
  return { origins, opsById };
}

// Resolve an SSA id through load ops to its source op (object_new, array_new, etc.)
function resolveOrigin(ssaId, origins, opsById) {
  let op = opsById.get(ssaId);
  if (!op) return null;
  if (op.op === 'load' && typeof op.args[0] === 'string') {
    const originId = origins.get(op.args[0]);
    if (originId) return resolveOrigin(originId, origins, opsById);
  }
  return op;
}

function specializeRuntimeHelpers(module, types) {
  const replacements = new Map(); // old SSA id → new SSA id (for arg rewrites)
  let changed = false;
  const { origins, opsById } = computeNameOrigins(module.ops);

  // Helper: find op or follow load chains
  function traceOp(ssaId) {
    return resolveOrigin(ssaId, origins, opsById);
  }

  function specialize(ops) {
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];

      // Rewrite args through replacements (in case an earlier op was replaced)
      if (op.args) {
        for (let j = 0; j < op.args.length; j++) {
          const a = op.args[j];
          if (typeof a === 'string' && replacements.has(a)) {
            op.args[j] = replacements.get(a);
          }
        }
      }

      // Recurse into regions first so nested ops are processed
      if (op.then_body) specialize(op.then_body);
      if (op.else_body) specialize(op.else_body);
      if (op.body) specialize(op.body);
      if (op.init) specialize(op.init);
      if (op.test) specialize(op.test);
      if (op.update) specialize(op.update);
      if (op.try_body) specialize(op.try_body);
      if (op.catch_body) specialize(op.catch_body);
      if (op.finally_body) specialize(op.finally_body);
      if (op.cases) for (const c of op.cases) {
        if (c.test_ops) specialize(c.test_ops);
        if (c.body) specialize(c.body);
      }

      // Look for call to a runtime helper method
      if (op.op !== 'call') continue;
      const calleeOp = findOpAnywhere(module.ops, op.args[0]);
      if (!calleeOp || calleeOp.op !== 'object_get') continue;

      const rtOp = findOpAnywhere(module.ops, calleeOp.args[0]);
      if (!rtOp || rtOp.op !== 'load') continue;

      const rtName = rtOp.args[0];
      const specs = rtName === '_py' ? PY_SPECIALIZATIONS :
                    rtName === '_soft' ? SOFT_SPECIALIZATIONS : null;
      if (!specs) continue;

      const method = calleeOp.args[1];

      // --- Special: getattr on plain objects / typed arrays ---
      // _py.getattr(obj, "name") → obj.name when obj is provably a plain value.
      if (method === 'getattr' && op.args.length === 3) {
        const objId = op.args[1];
        const nameId = op.args[2];
        const nameOp = traceOp(nameId);
        if (nameOp && nameOp.op === 'const' && typeof nameOp.args[0] === 'string') {
          const attrName = nameOp.args[0];
          const objOp = traceOp(objId);
          // Plain object literal → direct dot access (no class dispatch needed)
          // Typed/plain array .length → direct (very common)
          const isPlainObject = objOp && objOp.op === 'object_new';
          const isArrayLength = (objOp?.op === 'array_new' || objOp?.op === 'ta_new') && attrName === 'length';
          if (isPlainObject || isArrayLength) {
            op.op = 'object_get';
            op.args = [objId, attrName];
            op.type = isArrayLength ? I32 : DYNAMIC;
            types.set(op.id, op.type);
            changed = true;
            // Absorb trailing await if present
            const nextOp = ops[i + 1];
            if (nextOp && nextOp.op === 'await' && nextOp.args[0] === op.id) {
              nextOp.op = 'const';
              nextOp.args = [undefined];
              nextOp.type = VOID;
              types.set(nextOp.id, VOID);
              replacements.set(nextOp.id, op.id);
            }
            continue;
          }
        }
      }

      // --- Special: getitem specialization ---
      // Plain object literal + const string key → obj.key
      // Plain/typed array + const non-negative index → arr[idx]
      // (Skip the helper's negative-index/dict/dunder handling.)
      if (method === 'getitem' && op.args.length === 3) {
        const objId = op.args[1];
        const idxId = op.args[2];
        const objOp = traceOp(objId);
        const idxOp = traceOp(idxId);

        const isArray = objOp && (objOp.op === 'array_new' || objOp.op === 'ta_new');
        const isObject = objOp && objOp.op === 'object_new';
        const isNonNegNumConst = idxOp?.op === 'const' &&
                                  typeof idxOp.args[0] === 'number' && idxOp.args[0] >= 0;
        const isStringConst = idxOp?.op === 'const' && typeof idxOp.args[0] === 'string';

        let specialized = false;
        if (isArray && isNonNegNumConst) {
          op.op = 'array_get';
          op.args = [objId, idxId];
          op.type = objOp.op === 'ta_new' ? (taElementType(objOp.type) || DYNAMIC) : DYNAMIC;
          specialized = true;
        } else if (isObject && isStringConst) {
          // Dict-as-object: direct property access with string key
          op.op = 'object_get';
          op.args = [objId, idxOp.args[0]];
          op.type = DYNAMIC;
          specialized = true;
        }

        if (specialized) {
          types.set(op.id, op.type);
          changed = true;
          const nextOp = ops[i + 1];
          if (nextOp && nextOp.op === 'await' && nextOp.args[0] === op.id) {
            nextOp.op = 'const';
            nextOp.args = [undefined];
            nextOp.type = VOID;
            types.set(nextOp.id, VOID);
            replacements.set(nextOp.id, op.id);
          }
          continue;
        }
      }

      const spec = specs[method];
      if (!spec) continue;

      // Gather arg types
      const argIds = op.args.slice(1);
      const argTypes = argIds.map(id => types.get(id) || DYNAMIC);
      const arity = spec.arity ?? 2;
      if (argIds.length !== arity) continue;

      // Check if types qualify
      if (!spec.check(...argTypes)) continue;

      // Determine result type
      const resT = spec.resultType(...argTypes);

      // Passthrough: replace the call result with the single arg
      if (spec.passthrough) {
        replacements.set(op.id, argIds[0]);
        // Also replace the outer await if it directly wraps this call
        const nextOp = ops[i + 1];
        if (nextOp && nextOp.op === 'await' && nextOp.args[0] === op.id) {
          replacements.set(nextOp.id, argIds[0]);
        }
        continue;
      }

      // Custom emit (between = v >= lo && v <= hi)
      if (spec.customEmit && method === 'between') {
        const [v, lo, hi] = argIds;
        // Replace in-place with a logical_and wrapping two comparisons.
        // Approach: keep `op` but change it into a `logical_and` that
        // references two new compare ops we insert before it.
        const gteId = '%s' + op.id; // synthetic intermediate
        const lteId = '%s2' + op.id;
        // Rewrite op.op to 'logical_and' with args pointing to stable synthetic IDs.
        // We'll emit two new `ge` and `le` ops right before op in the array.
        const gteOp = { id: gteId, op: 'gte', args: [v, lo], type: BOOL, loc: op.loc };
        const lteOp = { id: lteId, op: 'lte', args: [v, hi], type: BOOL, loc: op.loc };
        ops.splice(i, 0, gteOp, lteOp);
        types.set(gteId, BOOL);
        types.set(lteId, BOOL);
        // Now op is at index i+2; rewrite it to logical_and
        const target = ops[i + 2];
        target.op = 'logical_and';
        target.args = [gteId, lteId];
        target.type = BOOL;
        types.set(target.id, BOOL);
        i += 2; // skip the inserted ops
        continue;
      }

      // Standard case: rewrite the call into a direct AIR op
      // Also absorb a trailing await if present (the op result is sync).
      op.op = spec.op;
      op.args = argIds;
      op.type = resT;
      types.set(op.id, resT);
      changed = true;
      // Fall through to async-absorb handling below
      const nextOp = ops[i + 1];
      if (nextOp && nextOp.op === 'await' && nextOp.args[0] === op.id) {
        // The await is now redundant (we produced a direct value, not a promise)
        replacements.set(nextOp.id, op.id);
        // Replace the await op with a no-op const — cleaner to just remove.
        // But removing shifts indices; instead, turn it into a load of the call result.
        // Simplest: change the await into a store-less pass-through.
        nextOp.op = 'const';  // harmless; DCE should remove
        nextOp.args = [undefined];
        nextOp.type = VOID;
        types.set(nextOp.id, VOID);
      }
    }
  }

  specialize(module.ops);
  return { replacements, changed };
}

function findOpAnywhere(ops, id) {
  for (const op of ops) {
    if (op.id === id) return op;
    for (const field of ['then_body','else_body','body','init','test','update',
                         'try_body','catch_body','finally_body']) {
      if (op[field]) { const r = findOpAnywhere(op[field], id); if (r) return r; }
    }
    if (op.cases) {
      for (const c of op.cases) {
        if (c.test_ops) { const r = findOpAnywhere(c.test_ops, id); if (r) return r; }
        if (c.body) { const r = findOpAnywhere(c.body, id); if (r) return r; }
      }
    }
  }
  return null;
}

// =============================================================================
// Combined pass runner
// =============================================================================

function runPasses(module, opts = {}) {
  let typeMap = propagateTypes(module, opts);
  foldConstants(module);
  // Iterate specialize ↔ re-propagate until fixed point (typically 2-3 rounds).
  for (let i = 0; i < 5; i++) {
    const { changed } = specializeRuntimeHelpers(module, typeMap);
    if (!changed) break;
    typeMap = propagateTypes(module, opts);
  }
  insertHints(module, typeMap);
  const deps = extractDependencies(module);
  return { typeMap, deps };
}

// -- emit-js.js --

// @gcu/air — JS emitter (Phase 2)
// Spec §9: AIR → optimized JavaScript
// Walks AIR ops and produces V8-friendly JS with type hints.


// =============================================================================
// Async detection
// =============================================================================

function needsAsync(module) {
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
function emitJS(module, scopeKeys, injectedNames, options = {}) {
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
  ctx.line(`${label}:`);
  if (op.body) emitOps(ctx, op.body);
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

// -- api.js --

// @gcu/air — Public API
// Clean interface matching existing parseNames/findUses output shapes






// Debug logging — true during development, settable via window._airDebug
let _airDebug = (typeof window !== 'undefined') ? (window._airDebug ?? true) : false;

// JS_GLOBALS: names that are not cell imports (built-in globals)
const JS_GLOBALS = new Set([
  'Math', 'console', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean',
  'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Symbol',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'NaN', 'Infinity',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback',
  'fetch', 'Response', 'Request', 'Headers', 'URL', 'URLSearchParams',
  'Blob', 'File', 'FileReader', 'FormData',
  'Int8Array', 'Uint8Array', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
  'BigInt64Array', 'BigUint64Array', 'ArrayBuffer', 'SharedArrayBuffer',
  'DataView', 'TextEncoder', 'TextDecoder',
  'WebAssembly', 'Atomics',
  'document', 'window', 'navigator', 'location', 'history',
  'localStorage', 'sessionStorage', 'indexedDB',
  'crypto', 'performance', 'queueMicrotask',
  'structuredClone', 'atob', 'btoa',
  'CompressionStream', 'DecompressionStream',
  'Worker', 'MessageChannel', 'MessagePort', 'BroadcastChannel',
  'AbortController', 'AbortSignal',
  'EventSource', 'WebSocket',
  'Image', 'CanvasRenderingContext2D', 'OffscreenCanvas',
  'globalThis', 'self', 'this',
  'arguments',
]);

/**
 * Analyze a JS/TS cell: parse, lower to AIR, run passes, extract defines/uses.
 * Returns { defines: Set<string>, uses: Set<string>, air: CellModule } on success,
 * or null if parsing/lowering fails.
 *
 * @param {string} code - Cell source code
 * @param {object} parser - Acorn parser instance (Parser.extend(tsPlugin()))
 * @param {Set<string>} allDefined - All names defined across all cells (for use detection)
 * @returns {{ defines: Set<string>, uses: Set<string>, air: object } | null}
 */
function analyzeCell(code, parser, allDefined) {
  try {
    const ast = parser.parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      locations: true,
    });

    const module = lowerJS(ast, code);
    runPasses(module);

    const defines = module.defines;

    // Filter imports: only keep names that are defined by other cells
    // (not JS globals, not self-defined)
    const uses = new Set();
    for (const name of module.imports) {
      if (allDefined && allDefined.has(name) && !defines.has(name) && !JS_GLOBALS.has(name)) {
        uses.add(name);
      }
    }

    return { defines, uses, air: module };
  } catch (e) {
    if (_airDebug) console.warn('[AIR] fallback for cell:', e.message);
    return null;
  }
}

/**
 * Extract defines only (for cases where we just need the names).
 * Lighter than full analyzeCell — no passes, no use filtering.
 */
function extractDefines(code, parser) {
  try {
    const ast = parser.parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      locations: true,
    });
    const module = lowerJS(ast, code);
    return module.defines;
  } catch (e) {
    if (_airDebug) console.warn('[AIR] extractDefines fallback:', e.message);
    return null;
  }
}

/**
 * Get export types for a cell (for fine-grained change detection).
 */
function extractExportTypes(module) {
  if (!module) return null;
  const types = new Map();
  for (const [name, exp] of module.exports) {
    types.set(name, exp.type);
  }
  return types;
}


// --- Browser init: register AIR on window ---
// When loaded in the browser with Acorn available, create the parser
// and set window._air for dag.js and exec.js to pick up.

if (typeof window !== 'undefined' && window.Acorn) {
  const { Parser, tsPlugin } = window.Acorn;
  const _airParser = Parser.extend(tsPlugin());
  window._airAnalyzer = function(code, allDefined) {
    return analyzeCell(code, _airParser, allDefined);
  };
  // Phase 2: emitter functions for exec.js
  window._airEmit = emitJS;
  window._airNeedsAsync = needsAsync;
  // Phase 3: adder transpile entry — returns { air, defines } or null on failure
  window._airLowerAdder = function(ast, code) {
    try {
      const air = lowerAdder(ast, code);
      runPasses(air);
      return { air, defines: air.defines };
    } catch (e) {
      if (e instanceof AirLowerError) return null;
      throw e;
    }
  };
  // Soft transpile entry
  window._airLowerSoft = function(ast, code) {
    try {
      const air = lowerSoft(ast, code);
      runPasses(air);
      return { air, defines: air.defines };
    } catch (e) {
      if (e instanceof SoftLowerError) return null;
      throw e;
    }
  };
  // Re-run passes on an existing air module with given import types.
  // Used for cross-cell type flow: upstream cell's export types seed
  // downstream cell's imports. Returns true if anything changed.
  window._airRePropagate = function(air, opts) {
    try {
      runPasses(air, opts || {});
      return true;
    } catch (e) {
      return false;
    }
  };
}
