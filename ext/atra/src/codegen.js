// Codegen — AST → Wasm binary
//
// Single-pass compiler: AST in, Wasm bytes out. No optimization, no intermediate
// representation. Closure-based architecture: emitFunctionBody captures index tables
// (funcIndex, globalIndex, localMap) from the outer codegen scope.
//
// Output follows Wasm binary section ordering: Type(1), Import(2), Function(3),
// Table(4), Memory(5), Global(6), Export(7), Element(9), Code(10).
//
// Most emitters branch on type (f64/f32/i32/i64/vector) because Wasm's instruction
// set is fully typed — there's no polymorphic add, only i32.add, f64.add, etc.

import { ATRA_TYPES, ATRA_VECTOR_TYPES } from './highlight.js';
import { ByteWriter } from './bytewriter.js';
import {
  OP_BLOCK, OP_LOOP, OP_IF, OP_ELSE, OP_END, OP_BR, OP_BR_IF,
  OP_RETURN, OP_CALL, OP_CALL_INDIRECT,
  OP_RETURN_CALL, OP_RETURN_CALL_INDIRECT, OP_SELECT,
  OP_LOCAL_GET, OP_LOCAL_SET, OP_GLOBAL_GET, OP_GLOBAL_SET,
  OP_I32_LOAD, OP_I64_LOAD, OP_F32_LOAD, OP_F64_LOAD,
  OP_I32_STORE, OP_I64_STORE, OP_F32_STORE, OP_F64_STORE,
  OP_MEMORY_SIZE, OP_MEMORY_GROW,
  OP_I32_CONST, OP_I64_CONST, OP_F32_CONST, OP_F64_CONST,
  OP_I32_EQZ, OP_I32_EQ, OP_I32_NE,
  OP_I32_LT_S, OP_I32_LT_U, OP_I32_GT_S, OP_I32_GT_U,
  OP_I32_LE_S, OP_I32_LE_U, OP_I32_GE_S, OP_I32_GE_U,
  OP_I64_EQ, OP_I64_NE,
  OP_I64_LT_S, OP_I64_LT_U, OP_I64_GT_S, OP_I64_GT_U,
  OP_I64_LE_S, OP_I64_LE_U, OP_I64_GE_S, OP_I64_GE_U,
  OP_F32_EQ, OP_F32_NE, OP_F32_LT, OP_F32_GT, OP_F32_LE, OP_F32_GE,
  OP_F64_EQ, OP_F64_NE, OP_F64_LT, OP_F64_GT, OP_F64_LE, OP_F64_GE,
  OP_I32_CLZ, OP_I32_CTZ, OP_I32_POPCNT,
  OP_I32_ADD, OP_I32_SUB, OP_I32_MUL,
  OP_I32_DIV_S, OP_I32_DIV_U, OP_I32_REM_S, OP_I32_REM_U,
  OP_I32_AND, OP_I32_OR, OP_I32_XOR,
  OP_I32_SHL, OP_I32_SHR_S, OP_I32_SHR_U,
  OP_I32_ROTL, OP_I32_ROTR,
  OP_I64_CLZ, OP_I64_CTZ, OP_I64_POPCNT,
  OP_I64_ADD, OP_I64_SUB, OP_I64_MUL,
  OP_I64_DIV_S, OP_I64_DIV_U, OP_I64_REM_S, OP_I64_REM_U,
  OP_I64_AND, OP_I64_OR, OP_I64_XOR,
  OP_I64_SHL, OP_I64_SHR_S, OP_I64_SHR_U,
  OP_I64_ROTL, OP_I64_ROTR,
  OP_F32_ABS, OP_F32_NEG, OP_F32_CEIL, OP_F32_FLOOR,
  OP_F32_TRUNC, OP_F32_NEAREST, OP_F32_SQRT,
  OP_F32_ADD, OP_F32_SUB, OP_F32_MUL, OP_F32_DIV,
  OP_F32_MIN, OP_F32_MAX, OP_F32_COPYSIGN,
  OP_F64_ABS, OP_F64_NEG, OP_F64_CEIL, OP_F64_FLOOR,
  OP_F64_TRUNC, OP_F64_NEAREST, OP_F64_SQRT,
  OP_F64_ADD, OP_F64_SUB, OP_F64_MUL, OP_F64_DIV,
  OP_F64_MIN, OP_F64_MAX, OP_F64_COPYSIGN,
  OP_I32_WRAP_I64,
  OP_I32_TRUNC_F32_S, OP_I32_TRUNC_F64_S,
  OP_I64_EXTEND_I32_S, OP_I64_EXTEND_I32_U,
  OP_I64_TRUNC_F32_S, OP_I64_TRUNC_F64_S,
  OP_F32_CONVERT_I32_S, OP_F32_CONVERT_I64_S,
  OP_F32_DEMOTE_F64,
  OP_F64_CONVERT_I32_S, OP_F64_CONVERT_I64_S,
  OP_F64_PROMOTE_F32,
  OP_I32_REINTERPRET_F32, OP_I64_REINTERPRET_F64,
  OP_F32_REINTERPRET_I32, OP_F64_REINTERPRET_I64,
  OP_I32_EXTEND8_S, OP_I32_EXTEND16_S,
  OP_I64_EXTEND8_S, OP_I64_EXTEND16_S, OP_I64_EXTEND32_S,
  OP_FC_PREFIX,
  OP_I32_TRUNC_SAT_F32_S, OP_I32_TRUNC_SAT_F32_U,
  OP_I32_TRUNC_SAT_F64_S, OP_I32_TRUNC_SAT_F64_U,
  OP_I64_TRUNC_SAT_F32_S, OP_I64_TRUNC_SAT_F32_U,
  OP_I64_TRUNC_SAT_F64_S, OP_I64_TRUNC_SAT_F64_U,
  WASM_I32, WASM_I64, WASM_F32, WASM_F64, WASM_V128, WASM_VOID,
  OP_SIMD_PREFIX, SIMD_OPS,
  wasmType, typeSize, isVector, vectorScalarType,
} from './opcodes.js';

// Nested JS objects → flat "a.b.c" keys. Wasm imports use a two-level namespace
// (module + name), so nested user imports like {physics: {gravity: fn}} need flattening.
export function flattenImports(obj, prefix) {
  const flat = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!prefix && (k === '__memory' || k === 'memory' || k === '__table')) continue;
    const key = prefix ? prefix + '.' + k : k;
    if (typeof v === 'function') flat[key] = v;
    else if (v && typeof v === 'object' && !ArrayBuffer.isView(v)) Object.assign(flat, flattenImports(v, key));
  }
  return flat;
}

export function codegen(ast, interpValues, userImports) {
  const w = new ByteWriter();

  // ── Collect info ──
  const globals = [];    // { name, vtype, mutable, init }
  const functions = [];  // AST nodes
  const imports = [];    // { name, moduleName, params, retType, interpIdx }
  const localFuncNames = new Set();

  for (const node of ast.body) {
    if (node.type === 'ConstDecl') globals.push({ name: node.name, vtype: node.vtype, mutable: false, init: node.init });
    else if (node.type === 'VarDecl') {
      const g = { name: node.name, vtype: node.vtype, mutable: true, init: node.init };
      if (node.funcSig) g.funcSig = node.funcSig;
      globals.push(g);
    }
    else if (node.type === 'Function' || node.type === 'Subroutine') { functions.push(node); localFuncNames.add(node.name); }
    else if (node.type === 'ImportDecl') imports.push(node);
  }

  // Math builtins: imported from JS Math object. Value = param count.
  const MATH_BUILTINS = { sin: 1, cos: 1, ln: 1, exp: 1, pow: 2, atan2: 2 };
  // Native builtins: map directly to Wasm opcodes, no import needed
  const NATIVE_BUILTINS = new Set([
    'sqrt','abs','floor','ceil','trunc','nearest','copysign',
    'min','max','select',
    'clz','ctz','popcnt','rotl','rotr',
    'memory_size','memory_grow','memory_copy','memory_fill',
    'i32','i64','f32','f64', // type conversions
    'f64x2','f32x4','i32x4','i64x2', // vector constructors
  ]);

  // Scan all function bodies for unresolved calls
  const usedCalls = new Set();
  function scanCalls(stmts) {
    for (const s of stmts) {
      if (s.type === 'Call' || s.type === 'FuncCall') usedCalls.add(s.name);
      if (s.type === 'If') { scanCalls(s.body); if (s.elseBody) scanCalls(s.elseBody); }
      if (s.type === 'For' || s.type === 'While' || s.type === 'DoWhile') scanCalls(s.body);
      // scan expressions
      scanExprCalls(s);
    }
  }
  function scanExprCalls(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FuncCall') usedCalls.add(node.name);
    // ** operator may need pow import (for non-sqrt, non-small-int exponents)
    if (node.type === 'BinOp' && node.op === '**') usedCalls.add('pow');
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach(scanExprCalls);
      else if (v && typeof v === 'object' && v.type) scanExprCalls(v);
    }
  }
  for (const fn of functions) scanCalls(fn.body);

  // Auto-import math builtins that are actually used
  const mathImports = [];
  for (const name of usedCalls) {
    if (MATH_BUILTINS[name] !== undefined && !localFuncNames.has(name) && !imports.find(im => im.name === name)) {
      const nParams = MATH_BUILTINS[name];
      const params = [];
      for (let k = 0; k < nParams; k++) params.push({ type: 'Param', name: 'x' + k, vtype: 'f64', isArray: false, arrayDims: null });
      mathImports.push({ name, moduleName: 'math', params, retType: 'f64', interpIdx: null });
    }
  }

  // Auto-import: scan AST for unresolved calls, check userImports then globalThis.
  // Param types default to f64 — inferred from the JS function's .length.
  const flatImports = userImports ? flattenImports(userImports) : {};
  const hostImports = [];
  for (const name of usedCalls) {
    if (localFuncNames.has(name) || NATIVE_BUILTINS.has(name) || name.startsWith('wasm.') ||
        name.startsWith('v128.') || ATRA_VECTOR_TYPES.has(name.split('.')[0]) ||
        MATH_BUILTINS[name] !== undefined || imports.find(im => im.name === name)) continue;
    // check flattened userImports then globalThis
    let fn = flatImports[name];
    if (!fn && typeof globalThis !== 'undefined') fn = globalThis[name];
    if (typeof fn === 'function') {
      const nParams = fn.length;
      const params = [];
      for (let k = 0; k < nParams; k++) params.push({ type: 'Param', name: 'x' + k, vtype: 'f64', isArray: false, arrayDims: null });
      hostImports.push({ name, moduleName: 'host', params, retType: 'f64', interpIdx: null, jsFn: fn });
    }
  }

  const allImports = [...mathImports, ...imports, ...hostImports];

  // Build function index table: imports first, then local functions
  const funcIndex = {};
  let idx = 0;
  for (const im of allImports) { funcIndex[im.name] = idx++; }
  for (const fn of functions) { funcIndex[fn.name] = idx++; }

  // Global index table (+ track funcSig for function-typed globals)
  const globalIndex = {};
  const globalFuncSig = {}; // name → funcSig for function-typed globals
  for (let gi = 0; gi < globals.length; gi++) {
    globalIndex[globals[gi].name] = gi;
    if (globals[gi].funcSig) globalFuncSig[globals[gi].name] = globals[gi].funcSig;
  }

  // ── Scan for function references (bare function names used as values) ──
  const referencedFuncs = new Set();
  function scanFuncRefs(stmts, localNames) {
    for (const s of stmts) scanNodeRefs(s, localNames);
  }
  function scanNodeRefs(node, localNames) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FuncRef' && funcIndex[node.name] !== undefined) {
      referencedFuncs.add(node.name);
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach(c => scanNodeRefs(c, localNames));
      else if (v && typeof v === 'object' && v.type) scanNodeRefs(v, localNames);
    }
  }
  for (const fn of functions) {
    const localNames = new Set();
    for (const p of fn.params) localNames.add(p.name);
    for (const l of fn.locals) localNames.add(l.name);
    if (fn.type === 'Function') localNames.add(fn.name); // return var
    scanFuncRefs(fn.body, localNames);
  }

  // Detect if call_indirect is needed (function-typed params/locals/globals exist)
  let hasIndirectCalls = Object.keys(globalFuncSig).length > 0;
  if (!hasIndirectCalls) {
    for (const fn of functions) {
      if (fn.params.some(p => p.funcSig) || fn.locals.some(l => l.funcSig)) { hasIndirectCalls = true; break; }
    }
  }

  // Build table: explicitly referenced funcs always; if call_indirect used, also explicit imports + local functions.
  // Auto-imports only enter the table if explicitly referenced by bare name.
  const autoImportNames = new Set([...mathImports.map(m => m.name), ...hostImports.map(m => m.name)]);
  let tableFuncSet;
  if (hasIndirectCalls) {
    tableFuncSet = new Set([
      ...imports.map(im => im.name),
      ...functions.map(fn => fn.name),
      ...referencedFuncs,
    ]);
    // Exclude auto-imports that aren't explicitly referenced by bare name
    for (const name of autoImportNames) {
      if (!referencedFuncs.has(name)) tableFuncSet.delete(name);
    }
  } else {
    tableFuncSet = new Set(referencedFuncs);
  }
  const tableFuncs = [...tableFuncSet].sort((a, b) => funcIndex[a] - funcIndex[b]);
  const tableSlot = {}; // funcName → table index
  for (let ti = 0; ti < tableFuncs.length; ti++) tableSlot[tableFuncs[ti]] = ti;

  // ── Build type signatures ── every unique function signature, deduped by sigKey
  function paramWasmType(p) { return p.isArray ? 'i32' : p.vtype; }
  function sigKey(params, retType) {
    return params.map(p => paramWasmType(p)).join(',') + ':' + (retType || '');
  }
  const sigMap = new Map();
  const sigList = []; // [{params, retType}]
  function getOrAddSig(params, retType) {
    const key = sigKey(params, retType);
    if (sigMap.has(key)) return sigMap.get(key);
    const id = sigList.length;
    sigList.push({ params, retType });
    sigMap.set(key, id);
    return id;
  }

  // Register all signatures
  const importSigIds = allImports.map(im => getOrAddSig(im.params, im.retType));
  const funcSigIds = functions.map(fn => {
    const retType = fn.type === 'Subroutine' ? null : fn.retType;
    return getOrAddSig(fn.params, retType);
  });

  // ── Determine memory ──
  const hasMemory = functions.some(fn => fn.params.some(p => p.isArray));
  const importMemory = userImports && userImports.__memory;

  // ── Emit Wasm binary ──
  // Magic + version
  w.bytes([0x00, 0x61, 0x73, 0x6d]); // \0asm
  w.bytes([0x01, 0x00, 0x00, 0x00]); // version 1

  // Type section (1) — every unique (params → retType) signature
  w.section(1, s => {
    s.u32(sigList.length);
    for (const sig of sigList) {
      s.byte(0x60); // func type
      s.u32(sig.params.length);
      for (const p of sig.params) s.byte(wasmType(paramWasmType(p)));
      if (sig.retType) { s.u32(1); s.byte(wasmType(sig.retType)); }
      else s.u32(0);
    }
  });

  // Import section (2) — math builtins (auto-detected), explicit imports, host functions
  if (allImports.length > 0 || importMemory) {
    w.section(2, s => {
      s.u32(allImports.length + (importMemory ? 1 : 0));
      for (let ii = 0; ii < allImports.length; ii++) {
        const im = allImports[ii];
        s.str(im.moduleName);
        s.str(im.name);
        s.byte(0x00); // func import
        s.u32(importSigIds[ii]);
      }
      if (importMemory) {
        s.str('env');
        s.str('memory');
        s.byte(0x02); // memory import
        s.byte(0x00); // no max
        s.u32(1); // initial 1 page
      }
    });
  }

  // Function section (3)
  w.section(3, s => {
    s.u32(functions.length);
    for (const sigId of funcSigIds) s.u32(sigId);
  });

  // Table section (4) — funcref table for call_indirect (function pointers)
  if (tableFuncs.length > 0) {
    w.section(4, s => {
      s.u32(1); // one table
      s.byte(0x70); // funcref
      s.byte(0x00); // no max
      s.u32(tableFuncs.length); // initial size = number of referenced functions
    });
  }

  // Memory section (5) — only if arrays used and no imported memory
  if (hasMemory && !importMemory) {
    w.section(5, s => {
      s.u32(1);
      s.byte(0x00); // no max
      s.u32(1); // initial: 1 page (64KB)
    });
  }

  // Global section (6)
  if (globals.length > 0) {
    w.section(6, s => {
      s.u32(globals.length);
      for (const g of globals) {
        s.byte(wasmType(g.vtype));
        s.byte(g.mutable ? 0x01 : 0x00);
        // init expression
        emitConstExpr(s, g.init, g.vtype);
        s.byte(OP_END);
      }
    });
  }

  // Export section (7)
  w.section(7, s => {
    const exports = functions.map((fn, i) => ({ name: fn.name, idx: allImports.length + i }));
    const memExport = (hasMemory && !importMemory) ? 1 : 0;
    s.u32(exports.length + memExport);
    for (const e of exports) {
      s.str(e.name);
      s.byte(0x00); // func export
      s.u32(e.idx);
    }
    if (memExport) {
      s.str('memory');
      s.byte(0x02); // memory export
      s.u32(0);
    }
  });

  // Element section (9) — populate table with function references at offset 0
  if (tableFuncs.length > 0) {
    w.section(9, s => {
      s.u32(1); // one element segment
      s.u32(0); // table index 0
      // offset expression: i32.const 0
      s.byte(OP_I32_CONST); s.s32(0); s.byte(OP_END);
      s.u32(tableFuncs.length);
      for (const fname of tableFuncs) s.u32(funcIndex[fname]);
    });
  }

  // Code section (10) — one body per local function, each with compressed locals + bytecode
  w.section(10, s => {
    s.u32(functions.length);
    for (const fn of functions) {
      const bodyWriter = new ByteWriter();
      emitFunctionBody(bodyWriter, fn);
      s.u32(bodyWriter.buf.length);
      s.bytes(bodyWriter.buf);
    }
  });

  const bytes = w.toUint8Array();
  const table = tableFuncs.length > 0 ? { ...tableSlot } : null;
  return { bytes, table };

  // ── Helper: emit constant init expression ──
  function emitConstExpr(s, node, vtype) {
    if (!node) {
      // default zero
      if (vtype === 'i32') { s.byte(OP_I32_CONST); s.s32(0); }
      else if (vtype === 'i64') { s.byte(OP_I64_CONST); s.s64(0n); }
      else if (vtype === 'f32') { s.byte(OP_F32_CONST); s.f32(0); }
      else if (vtype === 'f64') { s.byte(OP_F64_CONST); s.f64(0); }
      else if (isVector(vtype)) {
        // v128.const with 16 zero bytes
        s.byte(OP_SIMD_PREFIX); s.u32(SIMD_OPS['v128.const']);
        for (let vi = 0; vi < 16; vi++) s.byte(0);
      }
      return;
    }
    if (node.type === 'NumberLit') {
      const val = parseNumericValue(node, vtype);
      emitTypedConst(s, vtype, val);
      return;
    }
    if (node.type === 'UnaryOp' && node.op === '-' && node.operand.type === 'NumberLit') {
      const val = -parseNumericValue(node.operand, vtype);
      emitTypedConst(s, vtype, val);
      return;
    }
    throw new Error('Global init must be a constant expression');
  }

  function parseNumericValue(node, defaultType) {
    const raw = node.value;
    if (raw.includes('.') || raw.includes('e') || raw.includes('E') || node.isFloat) return parseFloat(raw);
    return parseInt(raw, 10);
  }

  function emitTypedConst(s, vtype, val) {
    if (vtype === 'i32') { s.byte(OP_I32_CONST); s.s32(val | 0); }
    else if (vtype === 'i64') { s.byte(OP_I64_CONST); s.s64(BigInt(val)); }
    else if (vtype === 'f32') { s.byte(OP_F32_CONST); s.f32(val); }
    else if (vtype === 'f64') { s.byte(OP_F64_CONST); s.f64(val); }
  }

  // ── Emit function body ──
  function emitFunctionBody(bw, fn) {
    const isFunc = fn.type === 'Function';
    const retType = isFunc ? fn.retType : null;

    // ── Local layout ── params, declared locals, hidden return variable
    const localMap = {}; // name → { idx, vtype }
    let localIdx = 0;
    for (const p of fn.params) {
      const entry = {
        idx: localIdx++,
        vtype: p.isArray ? 'i32' : p.vtype, // Wasm has no array type; arrays are i32 memory pointers
        isArray: p.isArray,
        arrayDims: p.arrayDims,
        elemType: p.isArray ? p.vtype : null  // element type for load/store
      };
      if (p.funcSig) entry.funcSig = p.funcSig;
      localMap[p.name] = entry;
    }
    const declaredLocals = [...fn.locals];
    if (isFunc) {
      // $_return: Fortran convention — assigning to the function name sets the return value.
      // Mapped to a hidden local; the function epilogue reads it with local.get.
      declaredLocals.push({ name: '$_return', vtype: retType });
    }
    for (const loc of declaredLocals) {
      const entry = { idx: localIdx++, vtype: loc.vtype };
      if (loc.funcSig) entry.funcSig = loc.funcSig;
      localMap[loc.name] = entry;
    }

    // Emit local declarations (only the non-param ones)
    const localTypes = declaredLocals.map(l => l.vtype);
    // Compress: runs of same type
    const localRuns = [];
    for (const lt of localTypes) {
      if (localRuns.length > 0 && localRuns[localRuns.length - 1].type === lt) localRuns[localRuns.length - 1].count++;
      else localRuns.push({ count: 1, type: lt });
    }
    bw.u32(localRuns.length);
    for (const run of localRuns) {
      bw.u32(run.count);
      bw.byte(wasmType(run.type));
    }

    // SIMD helper
    function emitSimd(op) { bw.byte(OP_SIMD_PREFIX); bw.u32(op); }

    // ── Statement emission ──
    let depth = 0; // current block nesting depth
    const breakTargets = []; // stack of {depth} for each enclosing loop's break block

    function emitStmts(stmts) { for (const s of stmts) emitStmt(s); }

    function emitStmt(stmt) {
      switch (stmt.type) {
        case 'Assign': {
          const target = stmt.name;
          // Assignment to function name = set return variable
          if (isFunc && target === fn.name) {
            emitExpr(stmt.value, retType);
            bw.byte(OP_LOCAL_SET);
            bw.u32(localMap['$_return'].idx);
          } else if (localMap[target]) {
            emitExpr(stmt.value, localMap[target].vtype);
            bw.byte(OP_LOCAL_SET);
            bw.u32(localMap[target].idx);
          } else if (globalIndex[target] !== undefined) {
            emitExpr(stmt.value, globals[globalIndex[target]].vtype);
            bw.byte(OP_GLOBAL_SET);
            bw.u32(globalIndex[target]);
          } else {
            throw new Error(`Undefined variable: ${target}`);
          }
          break;
        }
        case 'ArrayStore': {
          const info = localMap[stmt.name];
          if (!info) throw new Error(`Undefined array: ${stmt.name}`);
          const elemType = info.elemType || info.vtype;
          // compute address
          emitArrayAddr(stmt.name, stmt.indices, info, elemType);
          // compute value
          emitExpr(stmt.value, elemType);
          // store
          emitStore(elemType);
          break;
        }
        case 'If': {
          emitExpr(stmt.cond, 'i32');
          bw.byte(OP_IF);
          bw.byte(WASM_VOID);
          depth++;
          emitStmts(stmt.body);
          if (stmt.elseBody) {
            bw.byte(OP_ELSE);
            emitStmts(stmt.elseBody);
          }
          depth--;
          bw.byte(OP_END);
          break;
        }
        case 'For': {
          const vInfo = localMap[stmt.varName];
          if (!vInfo) throw new Error(`Undefined loop variable: ${stmt.varName}`);
          const vt = vInfo.vtype;
          emitExpr(stmt.start, vt);
          bw.byte(OP_LOCAL_SET);
          bw.u32(vInfo.idx);

          const hasStep = stmt.step !== null;

          bw.byte(OP_BLOCK); bw.byte(WASM_VOID); depth++;
          const breakDepth = depth; // break target = this block
          bw.byte(OP_LOOP); bw.byte(WASM_VOID); depth++;
          breakTargets.push(breakDepth);

          // condition check: br_if to break block
          bw.byte(OP_LOCAL_GET); bw.u32(vInfo.idx);
          emitExpr(stmt.end, vt);
          if (!hasStep) {
            emitCmp('>=', vt);
          } else {
            const stepIsNegLit = stmt.step.type === 'UnaryOp' && stmt.step.op === '-' && stmt.step.operand.type === 'NumberLit';
            const stepIsNegConst = stepIsNegLit || (stmt.step.type === 'NumberLit' && parseFloat(stmt.step.value) < 0);
            emitCmp(stepIsNegConst ? '<=' : '>=', vt);
          }
          bw.byte(OP_BR_IF); bw.u32(depth - breakDepth);

          emitStmts(stmt.body);

          // increment
          bw.byte(OP_LOCAL_GET); bw.u32(vInfo.idx);
          if (hasStep) { emitExpr(stmt.step, vt); } else { emitTypedConst(bw, vt, 1); }
          emitAdd(vt);
          bw.byte(OP_LOCAL_SET); bw.u32(vInfo.idx);

          bw.byte(OP_BR); bw.u32(0); // continue to loop
          depth--; bw.byte(OP_END); // end loop
          breakTargets.pop();
          depth--; bw.byte(OP_END); // end block
          break;
        }
        case 'While': {
          bw.byte(OP_BLOCK); bw.byte(WASM_VOID); depth++;
          const breakDepth = depth;
          bw.byte(OP_LOOP); bw.byte(WASM_VOID); depth++;
          breakTargets.push(breakDepth);

          emitExpr(stmt.cond, 'i32');
          bw.byte(OP_I32_EQZ);
          bw.byte(OP_BR_IF); bw.u32(depth - breakDepth);

          emitStmts(stmt.body);

          bw.byte(OP_BR); bw.u32(0); // continue loop
          depth--; bw.byte(OP_END); // end loop
          breakTargets.pop();
          depth--; bw.byte(OP_END); // end block
          break;
        }
        case 'DoWhile': {
          bw.byte(OP_BLOCK); bw.byte(WASM_VOID); depth++;
          const breakDepth = depth;
          bw.byte(OP_LOOP); bw.byte(WASM_VOID); depth++;
          breakTargets.push(breakDepth);

          emitStmts(stmt.body);

          emitExpr(stmt.cond, 'i32');
          bw.byte(OP_BR_IF); bw.u32(0); // continue if true

          depth--; bw.byte(OP_END); // end loop
          breakTargets.pop();
          depth--; bw.byte(OP_END); // end block
          break;
        }
        case 'Break': {
          if (breakTargets.length === 0) throw new Error('break outside loop');
          const targetDepth = breakTargets[breakTargets.length - 1];
          bw.byte(OP_BR);
          bw.u32(depth - targetDepth);
          break;
        }
        case 'Call': {
          // Early return: call return(expr) or call return()
          if (stmt.name === 'return') {
            if (isFunc) {
              if (stmt.args.length !== 1) throw new Error('return() in a function requires exactly one argument');
              emitExpr(stmt.args[0], retType);
            } else {
              if (stmt.args.length !== 0) throw new Error('return() in a subroutine takes no arguments');
            }
            bw.byte(OP_RETURN);
            break;
          }
          // SIMD namespaced builtins used as statements (e.g. call v128.store(...))
          const callDotIdx = stmt.name.indexOf('.');
          if (callDotIdx !== -1) {
            const callPrefix = stmt.name.slice(0, callDotIdx);
            const callMethod = stmt.name.slice(callDotIdx + 1);
            if (isVector(callPrefix) || callPrefix === 'v128') {
              emitSimdBuiltin(callPrefix, callMethod, stmt, null);
              break;
            }
          }
          // Native builtins used as statements (e.g. call memory_copy(...))
          if (NATIVE_BUILTINS.has(stmt.name)) {
            emitFuncCall(stmt, null);
            break;
          }
          // Indirect call via function-typed variable used as statement
          const callLocalInfo = localMap[stmt.name];
          const callGSig = globalFuncSig[stmt.name];
          if ((callLocalInfo && callLocalInfo.funcSig) || callGSig) {
            emitFuncCall(stmt, null);
            break;
          }
          // subroutine call or function call (result discarded)
          const fIdx = funcIndex[stmt.name];
          if (fIdx === undefined) throw new Error(`Undefined function: ${stmt.name}`);
          for (let ai = 0; ai < stmt.args.length; ai++) {
            // infer param type from declaration
            const paramType = getParamType(stmt.name, ai);
            emitExpr(stmt.args[ai], paramType);
          }
          bw.byte(OP_CALL);
          bw.u32(fIdx);
          break;
        }
        case 'TailCall': {
          const tcName = stmt.name;

          // Indirect tail call via function-typed variable
          const tcLocalInfo = localMap[tcName];
          const tcGSig = globalFuncSig[tcName];
          if ((tcLocalInfo && tcLocalInfo.funcSig) || tcGSig) {
            const sig = (tcLocalInfo && tcLocalInfo.funcSig) || tcGSig;
            const calleeRet = sig.retType || null;
            if (calleeRet !== retType)
              throw new Error(`tailcall type mismatch: ${tcName} returns ${calleeRet || 'void'}, current function returns ${retType || 'void'}`);
            for (let ai = 0; ai < stmt.args.length; ai++) {
              const pt = sig.params[ai] ? (sig.params[ai].isArray ? 'i32' : sig.params[ai].vtype) : 'f64';
              emitExpr(stmt.args[ai], pt);
            }
            if (tcLocalInfo) { bw.byte(OP_LOCAL_GET); bw.u32(tcLocalInfo.idx); }
            else { bw.byte(OP_GLOBAL_GET); bw.u32(globalIndex[tcName]); }
            const indirectSigId = getOrAddSig(sig.params, sig.retType);
            bw.byte(OP_RETURN_CALL_INDIRECT);
            bw.u32(indirectSigId);
            bw.u32(0);
            break;
          }

          // Direct tail call — type validation
          const calleeFn = functions.find(f => f.name === tcName);
          const calleeIm = !calleeFn && allImports.find(i => i.name === tcName);
          const calleeRet = calleeFn ? (calleeFn.type === 'Subroutine' ? null : calleeFn.retType)
                          : calleeIm ? calleeIm.retType : null;
          if (calleeRet !== retType)
            throw new Error(`tailcall type mismatch: ${tcName} returns ${calleeRet || 'void'}, current function returns ${retType || 'void'}`);

          const tcFIdx = funcIndex[tcName];
          if (tcFIdx === undefined) throw new Error(`Undefined function: ${tcName}`);
          for (let ai = 0; ai < stmt.args.length; ai++) {
            emitExpr(stmt.args[ai], getParamType(tcName, ai));
          }
          bw.byte(OP_RETURN_CALL);
          bw.u32(tcFIdx);
          break;
        }
        default:
          throw new Error(`Unknown statement type: ${stmt.type}`);
      }
    }

    function getParamType(funcName, paramIdx) {
      // check local functions
      const fn = functions.find(f => f.name === funcName);
      if (fn && fn.params[paramIdx]) return fn.params[paramIdx].isArray ? 'i32' : fn.params[paramIdx].vtype;
      // check imports
      const im = allImports.find(i => i.name === funcName);
      if (im && im.params[paramIdx]) return im.params[paramIdx].vtype;
      return 'f64'; // default
    }

    function resolveType(name) {
      if (localMap[name]) return localMap[name].vtype;
      if (globalIndex[name] !== undefined) return globals[globalIndex[name]].vtype;
      return null;
    }

    // Type inference fallback: when expectedType is null, guess from AST shape. Default is f64.
    function inferExprType(expr) {
      switch (expr.type) {
        case 'NumberLit': {
          if (expr.typeSuffix) return expr.typeSuffix;
          if (expr.isFloat || expr.value.includes('.') || expr.value.includes('e') || expr.value.includes('E')) return 'f64';
          return 'i32';
        }
        case 'FuncRef': return 'i32';
        case 'Ident': return resolveType(expr.name) || 'f64';
        case 'BinOp': {
          const op = expr.op;
          if (op === '==' || op === '/=' || op === '<' || op === '>' || op === '<=' || op === '>='
            || op === 'and' || op === 'or') return 'i32';
          return inferExprType(expr.left);
        }
        case 'UnaryOp': return inferExprType(expr.operand);
        case 'FuncCall': {
          // type conversions / vector constructors
          if (ATRA_TYPES.has(expr.name)) return expr.name;
          // SIMD namespaced builtins
          const dotIdx = expr.name.indexOf('.');
          if (dotIdx !== -1) {
            const prefix = expr.name.slice(0, dotIdx);
            const method = expr.name.slice(dotIdx + 1);
            if (isVector(prefix)) {
              // extract_lane returns the scalar type
              if (method === 'extract_lane') return vectorScalarType(prefix);
              // splat, replace_lane, add, sub, mul, div, neg, abs, sqrt, eq, etc. return the vector type
              return prefix;
            }
            if (prefix === 'v128') {
              // v128.and/or/xor/not/load return v128 — infer from first arg
              if (method === 'load') return inferExprType(expr.args[0]) || 'f64x2'; // default to f64x2
              if (['and','or','xor','not'].includes(method)) return inferExprType(expr.args[0]);
              if (method === 'store') return 'i32'; // store is a statement, but type doesn't matter much
            }
          }
          // Indirect call via function-typed variable
          const callInfo = localMap[expr.name];
          if (callInfo && callInfo.funcSig && callInfo.funcSig.retType) return callInfo.funcSig.retType;
          if (globalFuncSig[expr.name] && globalFuncSig[expr.name].retType) return globalFuncSig[expr.name].retType;
          // known return types
          const fn = functions.find(f => f.name === expr.name);
          if (fn && fn.retType) return fn.retType;
          return 'f64';
        }
        case 'ArrayAccess': {
          const info = localMap[expr.name];
          return info ? (info.elemType || info.vtype) : 'f64';
        }
        case 'IfExpr': return inferExprType(expr.thenExpr);
        default: return 'f64';
      }
    }

    // ── Expression emission ──
    function emitExpr(expr, expectedType) {
      const actualType = expectedType || inferExprType(expr);

      switch (expr.type) {
        case 'NumberLit': {
          const t = expectedType || inferExprType(expr);
          const raw = expr.value;
          if (t === 'i32') { bw.byte(OP_I32_CONST); bw.s32(parseInt(raw, 10) | 0); }
          else if (t === 'i64') { bw.byte(OP_I64_CONST); bw.s64(BigInt(parseInt(raw, 10))); }
          else if (t === 'f32') { bw.byte(OP_F32_CONST); bw.f32(parseFloat(raw)); }
          else { bw.byte(OP_F64_CONST); bw.f64(parseFloat(raw)); }
          break;
        }
        case 'FuncRef': {
          const name = expr.name;
          if (tableSlot[name] === undefined) throw new Error(`Unknown function: ${name}`);
          bw.byte(OP_I32_CONST); bw.s32(tableSlot[name]);
          break;
        }
        case 'Ident': {
          const name = expr.name;
          if (isFunc && name === fn.name) {
            // Fortran convention: bare function name reads the return accumulator
            bw.byte(OP_LOCAL_GET); bw.u32(localMap['$_return'].idx);
          }
          else if (localMap[name]) { bw.byte(OP_LOCAL_GET); bw.u32(localMap[name].idx); }
          else if (globalIndex[name] !== undefined) { bw.byte(OP_GLOBAL_GET); bw.u32(globalIndex[name]); }
          else throw new Error(`Undefined variable: ${name}`);
          break;
        }
        case 'BinOp': {
          const t = expectedType || inferExprType(expr);
          emitBinOp(expr, t);
          break;
        }
        case 'UnaryOp': {
          const t = expectedType || inferExprType(expr);
          if (expr.op === '-') {
            if (t === 'f64') { emitExpr(expr.operand, t); bw.byte(OP_F64_NEG); }
            else if (t === 'f32') { emitExpr(expr.operand, t); bw.byte(OP_F32_NEG); }
            else if (t === 'i32') { bw.byte(OP_I32_CONST); bw.s32(0); emitExpr(expr.operand, t); bw.byte(OP_I32_SUB); }
            else if (t === 'i64') { bw.byte(OP_I64_CONST); bw.s64(0n); emitExpr(expr.operand, t); bw.byte(OP_I64_SUB); }
            else if (isVector(t)) { emitExpr(expr.operand, t); emitSimd(SIMD_OPS[t + '.neg']); }
          } else if (expr.op === 'not') {
            emitExpr(expr.operand, 'i32');
            bw.byte(OP_I32_EQZ);
          } else if (expr.op === '~') {
            emitExpr(expr.operand, t);
            if (t === 'i32') { bw.byte(OP_I32_CONST); bw.s32(-1); bw.byte(OP_I32_XOR); }
            else if (t === 'i64') { bw.byte(OP_I64_CONST); bw.s64(-1n); bw.byte(OP_I64_XOR); }
          } else {
            emitExpr(expr.operand, t);
          }
          break;
        }
        case 'FuncCall': {
          emitFuncCall(expr, expectedType);
          break;
        }
        case 'ArrayAccess': {
          const info = localMap[expr.name];
          if (!info) throw new Error(`Undefined array: ${expr.name}`);
          const elemType = info.elemType || info.vtype;
          emitArrayAddr(expr.name, expr.indices, info, elemType);
          emitLoad(elemType);
          break;
        }
        case 'IfExpr': {
          const t = expectedType || inferExprType(expr.thenExpr);
          emitExpr(expr.cond, 'i32');
          bw.byte(OP_IF);
          bw.byte(wasmType(t));
          emitExpr(expr.thenExpr, t);
          bw.byte(OP_ELSE);
          emitExpr(expr.elseExpr, t);
          bw.byte(OP_END);
          break;
        }
        default:
          throw new Error(`Unknown expression type: ${expr.type}`);
      }
    }

    // ── Binary operators ──
    function emitBinOp(expr, t) {
      const op = expr.op;

      // Exponentiation
      if (op === '**') {
        emitPow(expr, t);
        return;
      }

      // Comparison operators return i32
      if (op === '==' || op === '/=' || op === '<' || op === '>' || op === '<=' || op === '>=') {
        const operandType = inferExprType(expr.left);
        emitExpr(expr.left, operandType);
        emitExpr(expr.right, operandType);
        emitCmp(op, operandType);
        return;
      }

      // Logical: and, or
      if (op === 'and') {
        emitExpr(expr.left, 'i32');
        emitExpr(expr.right, 'i32');
        bw.byte(OP_I32_AND);
        return;
      }
      if (op === 'or') {
        emitExpr(expr.left, 'i32');
        emitExpr(expr.right, 'i32');
        bw.byte(OP_I32_OR);
        return;
      }

      emitExpr(expr.left, t);
      emitExpr(expr.right, t);

      if (op === '+') emitAdd(t);
      else if (op === '-') emitSub(t);
      else if (op === '*') emitMul(t);
      else if (op === '/') emitDiv(t);
      else if (op === 'mod') {
        if (t === 'i32') bw.byte(OP_I32_REM_S);
        else if (t === 'i64') bw.byte(OP_I64_REM_S);
        else throw new Error('mod requires integer type');
      }
      else if (op === '&') { if (t === 'i32') bw.byte(OP_I32_AND); else bw.byte(OP_I64_AND); }
      else if (op === '|') { if (t === 'i32') bw.byte(OP_I32_OR); else bw.byte(OP_I64_OR); }
      else if (op === '^') { if (t === 'i32') bw.byte(OP_I32_XOR); else bw.byte(OP_I64_XOR); }
      else if (op === '<<') { if (t === 'i32') bw.byte(OP_I32_SHL); else bw.byte(OP_I64_SHL); }
      else if (op === '>>') { if (t === 'i32') bw.byte(OP_I32_SHR_S); else bw.byte(OP_I64_SHR_S); }
      else throw new Error(`Unknown operator: ${op}`);
    }

    function emitPow(expr, t) {
      // **0.5 → sqrt
      if (expr.right.type === 'NumberLit' && (expr.right.value === '0.5' || expr.right.value === '.5')) {
        emitExpr(expr.left, t);
        if (t === 'f64') bw.byte(OP_F64_SQRT);
        else if (t === 'f32') bw.byte(OP_F32_SQRT);
        return;
      }
      // General: call pow import (works for all cases including **2, **3)
      emitExpr(expr.left, 'f64');
      emitExpr(expr.right, 'f64');
      bw.byte(OP_CALL);
      bw.u32(funcIndex['pow']);
      // Convert result back if needed
      if (t === 'f32') bw.byte(OP_F32_DEMOTE_F64);
    }

    // ── Function call dispatch ──
    // Priority: vector constructors > type conversions > SIMD builtins > native builtins
    //         > wasm.* escape hatch > indirect calls (call_indirect) > regular calls
    function emitFuncCall(expr, expectedType) {
      const name = expr.name;

      // Vector constructors: f64x2(a, b), f32x4(a, b, c, d), etc.
      if (isVector(name)) {
        emitVectorConstructor(name, expr.args);
        return;
      }

      // Scalar type conversions: i32(x), f64(x), etc.
      if (ATRA_TYPES.has(name)) {
        const fromType = inferExprType(expr.args[0]);
        const toType = name;
        emitExpr(expr.args[0], fromType);
        emitConversion(fromType, toType);
        return;
      }

      // SIMD namespaced builtins: f64x2.splat, v128.and, etc.
      const dotIdx = name.indexOf('.');
      if (dotIdx !== -1) {
        const prefix = name.slice(0, dotIdx);
        const method = name.slice(dotIdx + 1);
        if (isVector(prefix) || prefix === 'v128') {
          emitSimdBuiltin(prefix, method, expr, expectedType);
          return;
        }
      }

      // Native builtins — with vector type support
      if (name === 'sqrt') {
        emitExpr(expr.args[0], expectedType);
        if (isVector(expectedType)) { const op = SIMD_OPS[expectedType + '.sqrt']; if (op === undefined) throw new Error('sqrt not supported for ' + expectedType); emitSimd(op); }
        else if (expectedType === 'f32') bw.byte(OP_F32_SQRT);
        else bw.byte(OP_F64_SQRT);
        return;
      }
      if (name === 'abs') {
        emitExpr(expr.args[0], expectedType);
        if (isVector(expectedType)) { const op = SIMD_OPS[expectedType + '.abs']; if (op === undefined) throw new Error('abs not supported for ' + expectedType); emitSimd(op); }
        else if (expectedType === 'f32') bw.byte(OP_F32_ABS);
        else bw.byte(OP_F64_ABS);
        return;
      }
      if (name === 'floor') { emitExpr(expr.args[0], expectedType); if (expectedType === 'f32') bw.byte(OP_F32_FLOOR); else bw.byte(OP_F64_FLOOR); return; }
      if (name === 'ceil') { emitExpr(expr.args[0], expectedType); if (expectedType === 'f32') bw.byte(OP_F32_CEIL); else bw.byte(OP_F64_CEIL); return; }
      if (name === 'trunc') { emitExpr(expr.args[0], expectedType); if (expectedType === 'f32') bw.byte(OP_F32_TRUNC); else bw.byte(OP_F64_TRUNC); return; }
      if (name === 'nearest') { emitExpr(expr.args[0], expectedType); if (expectedType === 'f32') bw.byte(OP_F32_NEAREST); else bw.byte(OP_F64_NEAREST); return; }
      if (name === 'min') {
        if (isVector(expectedType)) {
          emitExpr(expr.args[0], expectedType); emitExpr(expr.args[1], expectedType);
          const op = SIMD_OPS[expectedType + '.min']; if (op === undefined) throw new Error('min not supported for ' + expectedType); emitSimd(op);
        } else if (expectedType === 'i32' || expectedType === 'i64') {
          // Wasm has no i32.min/i64.min — emit: a b a b lt_s select
          emitExpr(expr.args[0], expectedType);
          emitExpr(expr.args[1], expectedType);
          emitExpr(expr.args[0], expectedType);
          emitExpr(expr.args[1], expectedType);
          bw.byte(expectedType === 'i32' ? OP_I32_LT_S : OP_I64_LT_S);
          bw.byte(OP_SELECT);
        } else {
          emitExpr(expr.args[0], expectedType); emitExpr(expr.args[1], expectedType);
          if (expectedType === 'f32') bw.byte(OP_F32_MIN);
          else bw.byte(OP_F64_MIN);
        }
        return;
      }
      if (name === 'max') {
        if (isVector(expectedType)) {
          emitExpr(expr.args[0], expectedType); emitExpr(expr.args[1], expectedType);
          const op = SIMD_OPS[expectedType + '.max']; if (op === undefined) throw new Error('max not supported for ' + expectedType); emitSimd(op);
        } else if (expectedType === 'i32' || expectedType === 'i64') {
          // Wasm has no i32.max/i64.max — emit: a b a b gt_s select
          emitExpr(expr.args[0], expectedType);
          emitExpr(expr.args[1], expectedType);
          emitExpr(expr.args[0], expectedType);
          emitExpr(expr.args[1], expectedType);
          bw.byte(expectedType === 'i32' ? OP_I32_GT_S : OP_I64_GT_S);
          bw.byte(OP_SELECT);
        } else {
          emitExpr(expr.args[0], expectedType); emitExpr(expr.args[1], expectedType);
          if (expectedType === 'f32') bw.byte(OP_F32_MAX);
          else bw.byte(OP_F64_MAX);
        }
        return;
      }
      if (name === 'copysign') { emitExpr(expr.args[0], expectedType); emitExpr(expr.args[1], expectedType); if (expectedType === 'f32') bw.byte(OP_F32_COPYSIGN); else bw.byte(OP_F64_COPYSIGN); return; }
      if (name === 'select') {
        // select(a, b, cond) — Wasm select picks a if cond!=0, b otherwise
        const t = expectedType || inferExprType(expr.args[0]);
        emitExpr(expr.args[0], t);
        emitExpr(expr.args[1], t);
        emitExpr(expr.args[2], 'i32');
        bw.byte(OP_SELECT);
        return;
      }
      if (name === 'clz') { emitExpr(expr.args[0], expectedType); if (expectedType === 'i64') bw.byte(OP_I64_CLZ); else bw.byte(OP_I32_CLZ); return; }
      if (name === 'ctz') { emitExpr(expr.args[0], expectedType); if (expectedType === 'i64') bw.byte(OP_I64_CTZ); else bw.byte(OP_I32_CTZ); return; }
      if (name === 'popcnt') { emitExpr(expr.args[0], expectedType); if (expectedType === 'i64') bw.byte(OP_I64_POPCNT); else bw.byte(OP_I32_POPCNT); return; }
      if (name === 'rotl') { emitExpr(expr.args[0], expectedType); emitExpr(expr.args[1], expectedType); if (expectedType === 'i64') bw.byte(OP_I64_ROTL); else bw.byte(OP_I32_ROTL); return; }
      if (name === 'rotr') { emitExpr(expr.args[0], expectedType); emitExpr(expr.args[1], expectedType); if (expectedType === 'i64') bw.byte(OP_I64_ROTR); else bw.byte(OP_I32_ROTR); return; }
      if (name === 'memory_size') { bw.byte(OP_MEMORY_SIZE); bw.u32(0); return; }
      if (name === 'memory_grow') { emitExpr(expr.args[0], 'i32'); bw.byte(OP_MEMORY_GROW); bw.u32(0); return; }
      if (name === 'memory_copy') {
        emitExpr(expr.args[0], 'i32'); emitExpr(expr.args[1], 'i32'); emitExpr(expr.args[2], 'i32');
        bw.byte(OP_FC_PREFIX); bw.u32(10); bw.u32(0); bw.u32(0); // memory.copy, dst_mem=0, src_mem=0
        return;
      }
      if (name === 'memory_fill') {
        emitExpr(expr.args[0], 'i32'); emitExpr(expr.args[1], 'i32'); emitExpr(expr.args[2], 'i32');
        bw.byte(OP_FC_PREFIX); bw.u32(11); bw.u32(0); // memory.fill, mem=0
        return;
      }

      // wasm.* escape hatch
      if (name.startsWith('wasm.')) {
        emitWasmBuiltin(name.slice(5), expr, expectedType);
        return;
      }

      // Indirect call via function-typed variable
      const localInfo = localMap[name];
      const gSig = globalFuncSig[name];
      if ((localInfo && localInfo.funcSig) || gSig) {
        const sig = (localInfo && localInfo.funcSig) || gSig;
        // Emit arguments using funcSig param types
        for (let ai = 0; ai < expr.args.length; ai++) {
          const pt = sig.params[ai] ? (sig.params[ai].isArray ? 'i32' : sig.params[ai].vtype) : 'f64';
          emitExpr(expr.args[ai], pt);
        }
        // Push the table index (the variable value)
        if (localInfo) { bw.byte(OP_LOCAL_GET); bw.u32(localInfo.idx); }
        else { bw.byte(OP_GLOBAL_GET); bw.u32(globalIndex[name]); }
        // call_indirect type_index table_index
        const indirectSigId = getOrAddSig(sig.params, sig.retType);
        bw.byte(OP_CALL_INDIRECT);
        bw.u32(indirectSigId);
        bw.u32(0); // table index 0
        return;
      }

      // Regular function call
      const fIdx = funcIndex[name];
      if (fIdx === undefined) throw new Error(`Undefined function: ${name}`);
      for (let ai = 0; ai < expr.args.length; ai++) {
        const paramType = getParamType(name, ai);
        emitExpr(expr.args[ai], paramType);
      }
      bw.byte(OP_CALL);
      bw.u32(fIdx);
    }

    function emitWasmBuiltin(op, expr, expectedType) {
      const t = expectedType || 'i32';
      if (op === 'div_u') { emitExpr(expr.args[0], t); emitExpr(expr.args[1], t); bw.byte(t === 'i64' ? OP_I64_DIV_U : OP_I32_DIV_U); return; }
      if (op === 'rem_u') { emitExpr(expr.args[0], t); emitExpr(expr.args[1], t); bw.byte(t === 'i64' ? OP_I64_REM_U : OP_I32_REM_U); return; }
      if (op === 'shr_u') { emitExpr(expr.args[0], t); emitExpr(expr.args[1], t); bw.byte(t === 'i64' ? OP_I64_SHR_U : OP_I32_SHR_U); return; }
      if (op === 'lt_u') { emitExpr(expr.args[0], t); emitExpr(expr.args[1], t); bw.byte(t === 'i64' ? OP_I64_LT_U : OP_I32_LT_U); return; }
      if (op === 'gt_u') { emitExpr(expr.args[0], t); emitExpr(expr.args[1], t); bw.byte(t === 'i64' ? OP_I64_GT_U : OP_I32_GT_U); return; }
      if (op === 'le_u') { emitExpr(expr.args[0], t); emitExpr(expr.args[1], t); bw.byte(t === 'i64' ? OP_I64_LE_U : OP_I32_LE_U); return; }
      if (op === 'ge_u') { emitExpr(expr.args[0], t); emitExpr(expr.args[1], t); bw.byte(t === 'i64' ? OP_I64_GE_U : OP_I32_GE_U); return; }
      if (op === 'reinterpret_f64') { emitExpr(expr.args[0], 'f64'); bw.byte(OP_I64_REINTERPRET_F64); return; }
      if (op === 'reinterpret_f32') { emitExpr(expr.args[0], 'f32'); bw.byte(OP_I32_REINTERPRET_F32); return; }
      if (op === 'reinterpret_i64') { emitExpr(expr.args[0], 'i64'); bw.byte(OP_F64_REINTERPRET_I64); return; }
      if (op === 'reinterpret_i32') { emitExpr(expr.args[0], 'i32'); bw.byte(OP_F32_REINTERPRET_I32); return; }
      if (op === 'extend8_s') { emitExpr(expr.args[0], t); bw.byte(t === 'i64' ? OP_I64_EXTEND8_S : OP_I32_EXTEND8_S); return; }
      if (op === 'extend16_s') { emitExpr(expr.args[0], t); bw.byte(t === 'i64' ? OP_I64_EXTEND16_S : OP_I32_EXTEND16_S); return; }
      if (op === 'trunc_sat_s') {
        const fromType = inferExprType(expr.args[0]);
        emitExpr(expr.args[0], fromType);
        bw.byte(OP_FC_PREFIX);
        if (t === 'i32' && fromType === 'f32') bw.u32(OP_I32_TRUNC_SAT_F32_S);
        else if (t === 'i32' && fromType === 'f64') bw.u32(OP_I32_TRUNC_SAT_F64_S);
        else if (t === 'i64' && fromType === 'f32') bw.u32(OP_I64_TRUNC_SAT_F32_S);
        else if (t === 'i64' && fromType === 'f64') bw.u32(OP_I64_TRUNC_SAT_F64_S);
        return;
      }
      if (op === 'trunc_sat_u') {
        const fromType = inferExprType(expr.args[0]);
        emitExpr(expr.args[0], fromType);
        bw.byte(OP_FC_PREFIX);
        if (t === 'i32' && fromType === 'f32') bw.u32(OP_I32_TRUNC_SAT_F32_U);
        else if (t === 'i32' && fromType === 'f64') bw.u32(OP_I32_TRUNC_SAT_F64_U);
        else if (t === 'i64' && fromType === 'f32') bw.u32(OP_I64_TRUNC_SAT_F32_U);
        else if (t === 'i64' && fromType === 'f64') bw.u32(OP_I64_TRUNC_SAT_F64_U);
        return;
      }
      throw new Error(`Unknown wasm builtin: wasm.${op}`);
    }

    function emitVectorConstructor(vecType, args) {
      const scalar = vectorScalarType(vecType);
      const laneCount = vecType === 'f32x4' || vecType === 'i32x4' ? 4 : 2;

      if (args.length !== laneCount) throw new Error(`${vecType} constructor expects ${laneCount} args, got ${args.length}`);

      // Check if all args are constant (NumberLit or negative NumberLit)
      const allConst = args.every(a =>
        a.type === 'NumberLit' ||
        (a.type === 'UnaryOp' && a.op === '-' && a.operand.type === 'NumberLit'));

      if (allConst) {
        // Emit v128.const with inline bytes
        emitSimd(SIMD_OPS['v128.const']);
        const abuf = new ArrayBuffer(16);
        const view = new DataView(abuf);
        for (let li = 0; li < laneCount; li++) {
          const a = args[li];
          const raw = a.type === 'NumberLit' ? a.value : a.operand.value;
          const val = a.type === 'UnaryOp' ? -parseFloat(raw) : parseFloat(raw);
          if (scalar === 'f64') view.setFloat64(li * 8, val, true);
          else if (scalar === 'f32') view.setFloat32(li * 4, val, true);
          else if (scalar === 'i32') view.setInt32(li * 4, val | 0, true);
          else if (scalar === 'i64') {
            // BigInt64 as two i32s, little-endian
            const bv = BigInt(Math.trunc(val));
            view.setInt32(li * 8, Number(bv & 0xffffffffn), true);
            view.setInt32(li * 8 + 4, Number((bv >> 32n) & 0xffffffffn), true);
          }
        }
        bw.bytes(new Uint8Array(abuf));
      } else {
        // Splat first arg, then replace_lane for the rest
        emitExpr(args[0], scalar);
        emitSimd(SIMD_OPS[vecType + '.splat']);
        for (let li = 1; li < laneCount; li++) {
          emitExpr(args[li], scalar);
          emitSimd(SIMD_OPS[vecType + '.replace_lane']);
          bw.byte(li);
        }
      }
    }

    // ── SIMD builtins ──
    function emitSimdBuiltin(prefix, method, expr, expectedType) {
      // f64x2.splat(x), i32x4.splat(x), etc.
      if (method === 'splat') {
        const scalar = vectorScalarType(prefix);
        emitExpr(expr.args[0], scalar);
        emitSimd(SIMD_OPS[prefix + '.splat']);
        return;
      }

      // f64x2.extract_lane(v, lane)
      if (method === 'extract_lane') {
        emitExpr(expr.args[0], prefix);
        emitSimd(SIMD_OPS[prefix + '.extract_lane']);
        // lane must be a constant
        if (expr.args[1].type !== 'NumberLit') throw new Error('extract_lane requires constant lane index');
        bw.byte(parseInt(expr.args[1].value, 10));
        return;
      }

      // f64x2.replace_lane(v, lane, x)
      if (method === 'replace_lane') {
        const scalar = vectorScalarType(prefix);
        emitExpr(expr.args[0], prefix); // v128 value
        emitExpr(expr.args[2], scalar); // replacement scalar
        emitSimd(SIMD_OPS[prefix + '.replace_lane']);
        if (expr.args[1].type !== 'NumberLit') throw new Error('replace_lane requires constant lane index');
        bw.byte(parseInt(expr.args[1].value, 10));
        return;
      }

      // f64x2.eq, f64x2.ne, f64x2.lt, f64x2.gt, f64x2.le, f64x2.ge
      if (['eq','ne','lt','gt','le','ge','lt_s','gt_s','le_s','ge_s'].includes(method)) {
        emitExpr(expr.args[0], prefix);
        emitExpr(expr.args[1], prefix);
        const key = prefix + '.' + method;
        const op = SIMD_OPS[key];
        if (op === undefined) throw new Error(`Unknown SIMD op: ${key}`);
        emitSimd(op);
        return;
      }

      // f64x2.neg, f64x2.abs, f64x2.sqrt (unary)
      if (['neg','abs','sqrt'].includes(method)) {
        emitExpr(expr.args[0], prefix);
        const key = prefix + '.' + method;
        const op = SIMD_OPS[key];
        if (op === undefined) throw new Error(`Unknown SIMD op: ${key}`);
        emitSimd(op);
        return;
      }

      // f64x2.add, f64x2.sub, f64x2.mul, f64x2.div, f64x2.min, f64x2.max (binary)
      if (['add','sub','mul','div','min','max'].includes(method)) {
        emitExpr(expr.args[0], prefix);
        emitExpr(expr.args[1], prefix);
        const key = prefix + '.' + method;
        const op = SIMD_OPS[key];
        if (op === undefined) throw new Error(`Unknown SIMD op: ${key}`);
        emitSimd(op);
        return;
      }

      // f64x2.relaxed_madd(a, b, c), f64x2.relaxed_nmadd(a, b, c) (ternary: a*b+c / -(a*b)+c)
      if (['relaxed_madd','relaxed_nmadd'].includes(method)) {
        emitExpr(expr.args[0], prefix);
        emitExpr(expr.args[1], prefix);
        emitExpr(expr.args[2], prefix);
        const key = prefix + '.' + method;
        const op = SIMD_OPS[key];
        if (op === undefined) throw new Error(`Unknown SIMD op: ${key}`);
        emitSimd(op);
        return;
      }

      // v128.and, v128.or, v128.xor (binary bitwise)
      if (prefix === 'v128' && ['and','or','xor'].includes(method)) {
        // Infer operand type from first arg
        const vt = inferExprType(expr.args[0]);
        emitExpr(expr.args[0], vt);
        emitExpr(expr.args[1], vt);
        emitSimd(SIMD_OPS['v128.' + method]);
        return;
      }

      // v128.not (unary bitwise)
      if (prefix === 'v128' && method === 'not') {
        const vt = inferExprType(expr.args[0]);
        emitExpr(expr.args[0], vt);
        emitSimd(SIMD_OPS['v128.not']);
        return;
      }

      // v128.load(arr, i) — load 16 bytes from memory at arr + i * 16
      if (prefix === 'v128' && method === 'load') {
        // Compute address: arr + i * 16
        emitExpr(expr.args[0], 'i32'); // base pointer
        emitExpr(expr.args[1], 'i32'); // index
        bw.byte(OP_I32_CONST); bw.s32(16);
        bw.byte(OP_I32_MUL);
        bw.byte(OP_I32_ADD);
        emitSimd(SIMD_OPS['v128.load']); bw.u32(4); bw.u32(0); // align=16
        return;
      }

      // v128.store(arr, i, v) — store 16 bytes to memory at arr + i * 16
      if (prefix === 'v128' && method === 'store') {
        // Compute address
        emitExpr(expr.args[0], 'i32');
        emitExpr(expr.args[1], 'i32');
        bw.byte(OP_I32_CONST); bw.s32(16);
        bw.byte(OP_I32_MUL);
        bw.byte(OP_I32_ADD);
        // Emit value
        const vt = inferExprType(expr.args[2]);
        emitExpr(expr.args[2], vt);
        emitSimd(SIMD_OPS['v128.store']); bw.u32(4); bw.u32(0);
        return;
      }

      throw new Error(`Unknown SIMD builtin: ${prefix}.${method}`);
    }

    // ── Type conversion ──
    function emitConversion(from, to) {
      if (from === to) return;
      if (from === 'i32' && to === 'f64') bw.byte(OP_F64_CONVERT_I32_S);
      else if (from === 'i32' && to === 'f32') bw.byte(OP_F32_CONVERT_I32_S);
      else if (from === 'i32' && to === 'i64') bw.byte(OP_I64_EXTEND_I32_S);
      else if (from === 'i64' && to === 'i32') bw.byte(OP_I32_WRAP_I64);
      else if (from === 'i64' && to === 'f64') bw.byte(OP_F64_CONVERT_I64_S);
      else if (from === 'i64' && to === 'f32') bw.byte(OP_F32_CONVERT_I64_S);
      else if (from === 'f64' && to === 'i32') bw.byte(OP_I32_TRUNC_F64_S);
      else if (from === 'f64' && to === 'i64') bw.byte(OP_I64_TRUNC_F64_S);
      else if (from === 'f64' && to === 'f32') bw.byte(OP_F32_DEMOTE_F64);
      else if (from === 'f32' && to === 'f64') bw.byte(OP_F64_PROMOTE_F32);
      else if (from === 'f32' && to === 'i32') bw.byte(OP_I32_TRUNC_F32_S);
      else if (from === 'f32' && to === 'i64') bw.byte(OP_I64_TRUNC_F32_S);
      else throw new Error(`Cannot convert ${from} to ${to}`);
    }

    // ── Memory access ── array addressing: base + index * sizeof(elemType)
    function emitArrayAddr(name, indices, info, elemType) {
      // Base pointer
      bw.byte(OP_LOCAL_GET);
      bw.u32(info.idx);

      const sz = typeSize(elemType);

      if (indices.length === 1) {
        // 1D: base + i * sizeof
        emitExpr(indices[0], 'i32');
        bw.byte(OP_I32_CONST); bw.s32(sz);
        bw.byte(OP_I32_MUL);
        bw.byte(OP_I32_ADD);
      } else if (indices.length === 3 && !info.arrayDims) {
        // 2D with explicit stride: a[i, stride, j] → base + (i*stride + j) * sizeof
        emitExpr(indices[0], 'i32');
        emitExpr(indices[1], 'i32');
        bw.byte(OP_I32_MUL);
        emitExpr(indices[2], 'i32');
        bw.byte(OP_I32_ADD);
        bw.byte(OP_I32_CONST); bw.s32(sz);
        bw.byte(OP_I32_MUL);
        bw.byte(OP_I32_ADD);
      } else if (indices.length === 2 && info.arrayDims && info.arrayDims.length === 2) {
        // 2D with declared dims: a[i, j] → base + (i*dim1 + j) * sizeof
        emitExpr(indices[0], 'i32');
        emitExpr(info.arrayDims[1], 'i32');
        bw.byte(OP_I32_MUL);
        emitExpr(indices[1], 'i32');
        bw.byte(OP_I32_ADD);
        bw.byte(OP_I32_CONST); bw.s32(sz);
        bw.byte(OP_I32_MUL);
        bw.byte(OP_I32_ADD);
      } else {
        throw new Error(`Unsupported array index pattern for ${name}`);
      }
    }

    function emitLoad(t) {
      if (t === 'i32') { bw.byte(OP_I32_LOAD); bw.u32(2); bw.u32(0); } // align=4
      else if (t === 'i64') { bw.byte(OP_I64_LOAD); bw.u32(3); bw.u32(0); }
      else if (t === 'f32') { bw.byte(OP_F32_LOAD); bw.u32(2); bw.u32(0); }
      else if (t === 'f64') { bw.byte(OP_F64_LOAD); bw.u32(3); bw.u32(0); }
      else if (isVector(t)) { emitSimd(SIMD_OPS['v128.load']); bw.u32(4); bw.u32(0); } // align=16
    }

    function emitStore(t) {
      if (t === 'i32') { bw.byte(OP_I32_STORE); bw.u32(2); bw.u32(0); }
      else if (t === 'i64') { bw.byte(OP_I64_STORE); bw.u32(3); bw.u32(0); }
      else if (t === 'f32') { bw.byte(OP_F32_STORE); bw.u32(2); bw.u32(0); }
      else if (t === 'f64') { bw.byte(OP_F64_STORE); bw.u32(3); bw.u32(0); }
      else if (isVector(t)) { emitSimd(SIMD_OPS['v128.store']); bw.u32(4); bw.u32(0); } // align=16
    }

    // ── Comparison + arithmetic helpers ──
    function emitCmp(op, t) {
      if (t === 'f64') {
        if (op === '==') bw.byte(OP_F64_EQ);
        else if (op === '/=') bw.byte(OP_F64_NE);
        else if (op === '<') bw.byte(OP_F64_LT);
        else if (op === '>') bw.byte(OP_F64_GT);
        else if (op === '<=') bw.byte(OP_F64_LE);
        else if (op === '>=') bw.byte(OP_F64_GE);
      } else if (t === 'f32') {
        if (op === '==') bw.byte(OP_F32_EQ);
        else if (op === '/=') bw.byte(OP_F32_NE);
        else if (op === '<') bw.byte(OP_F32_LT);
        else if (op === '>') bw.byte(OP_F32_GT);
        else if (op === '<=') bw.byte(OP_F32_LE);
        else if (op === '>=') bw.byte(OP_F32_GE);
      } else if (t === 'i32') {
        if (op === '==') bw.byte(OP_I32_EQ);
        else if (op === '/=') bw.byte(OP_I32_NE);
        else if (op === '<') bw.byte(OP_I32_LT_S);
        else if (op === '>') bw.byte(OP_I32_GT_S);
        else if (op === '<=') bw.byte(OP_I32_LE_S);
        else if (op === '>=') bw.byte(OP_I32_GE_S);
      } else if (t === 'i64') {
        if (op === '==') bw.byte(OP_I64_EQ);
        else if (op === '/=') bw.byte(OP_I64_NE);
        else if (op === '<') bw.byte(OP_I64_LT_S);
        else if (op === '>') bw.byte(OP_I64_GT_S);
        else if (op === '<=') bw.byte(OP_I64_LE_S);
        else if (op === '>=') bw.byte(OP_I64_GE_S);
      } else if (isVector(t)) {
        // Vector comparisons — map atra ops to SIMD opcode keys
        const isIntVec = (t === 'i32x4' || t === 'i64x2');
        const suffix = isIntVec ? '_s' : '';
        let key;
        if (op === '==') key = t + '.eq';
        else if (op === '/=') key = t + '.ne';
        else if (op === '<') key = t + (isIntVec ? '.lt_s' : '.lt');
        else if (op === '>') key = t + (isIntVec ? '.gt_s' : '.gt');
        else if (op === '<=') key = t + (isIntVec ? '.le_s' : '.le');
        else if (op === '>=') key = t + (isIntVec ? '.ge_s' : '.ge');
        const opcode = SIMD_OPS[key];
        if (opcode === undefined) throw new Error(`Comparison ${op} not supported for ${t}`);
        emitSimd(opcode);
      }
    }

    function emitAdd(t) {
      if (t === 'f64') bw.byte(OP_F64_ADD);
      else if (t === 'f32') bw.byte(OP_F32_ADD);
      else if (t === 'i32') bw.byte(OP_I32_ADD);
      else if (t === 'i64') bw.byte(OP_I64_ADD);
      else if (isVector(t)) emitSimd(SIMD_OPS[t + '.add']);
    }

    function emitSub(t) {
      if (t === 'f64') bw.byte(OP_F64_SUB);
      else if (t === 'f32') bw.byte(OP_F32_SUB);
      else if (t === 'i32') bw.byte(OP_I32_SUB);
      else if (t === 'i64') bw.byte(OP_I64_SUB);
      else if (isVector(t)) emitSimd(SIMD_OPS[t + '.sub']);
    }

    function emitMul(t) {
      if (t === 'f64') bw.byte(OP_F64_MUL);
      else if (t === 'f32') bw.byte(OP_F32_MUL);
      else if (t === 'i32') bw.byte(OP_I32_MUL);
      else if (t === 'i64') bw.byte(OP_I64_MUL);
      else if (isVector(t)) emitSimd(SIMD_OPS[t + '.mul']);
    }

    function emitDiv(t) {
      if (t === 'f64') bw.byte(OP_F64_DIV);
      else if (t === 'f32') bw.byte(OP_F32_DIV);
      else if (t === 'i32') bw.byte(OP_I32_DIV_S);
      else if (t === 'i64') bw.byte(OP_I64_DIV_S);
      else if (isVector(t)) {
        const op = SIMD_OPS[t + '.div'];
        if (!op) throw new Error('Division not supported for ' + t);
        emitSimd(op);
      }
    }

    // ── Emit function body statements ──
    emitStmts(fn.body);

    // ── End of function body: return value ──
    if (isFunc) {
      bw.byte(OP_LOCAL_GET);
      bw.u32(localMap['$_return'].idx);
    }
    bw.byte(OP_END);
  }
}
