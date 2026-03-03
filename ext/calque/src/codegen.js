// Codegen — AST → xlsx formula strings + workbook assembly
//
// Walks AST nodes and emits xlsx formula strings. Produces a workbook
// structure that ext/sheet/ can write to an xlsx file.

import { isColumn, isFunc } from './stdlib.js';

// ── Helpers ──

function colLetter(index) {
  let s = '';
  let n = index + 1;
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

function escapeExcelString(s) {
  return '"' + s.replace(/"/g, '""') + '"';
}

// ── Function mapping ──

const FUNC_MAP = {
  sum: 'SUM', mean: 'AVERAGE', count: 'COUNT', min: 'MIN', max: 'MAX',
  left: 'LEFT', right: 'RIGHT', mid: 'MID', len: 'LEN', trim: 'TRIM',
  text: 'TEXT', str: 'TEXT', date: 'DATE', year: 'YEAR', month: 'MONTH',
  day: 'DAY', today: 'TODAY', iferror: 'IFERROR', ifna: 'IFNA',
  round: 'ROUND', abs: 'ABS', floor: 'FLOOR', ceil: 'CEILING',
  sqrt: 'SQRT', log: 'LOG', exp: 'EXP', mod: 'MOD',
  scan: 'SCAN', sort: 'SORT', unique: 'UNIQUE', lookup: 'XLOOKUP',
};

// Reductions: their column args emit as ranges
const REDUCTIONS = new Set(['sum', 'mean', 'count', 'min', 'max']);

// Spilled: single formula produces dynamic array (only first cell gets formula)
const SPILLED = new Set(['scan', 'sort', 'unique']);

// Pointwise functions safe inside reductions (emit as range-applied)
const POINTWISE = new Set(['abs', 'round', 'floor', 'ceil', 'sqrt', 'log', 'exp', 'mod',
  'left', 'right', 'mid', 'len', 'trim', 'text', 'str', 'iferror', 'ifna']);

// Operator mapping calque → xlsx
const OP_MAP = { '==': '=', '/=': '<>', '!=': '<>' };

// ── Spilled formula detection ──

function isSpilledNode(node) {
  if (node.type === 'Subscript') return true;
  if (node.type === 'FuncCall' && SPILLED.has(node.name)) return true;
  return false;
}

// ── Baked pattern detection ──

function shouldBake(node, ctx) {
  if (node.type === 'ArrayLit') return 'array literal (data entry)';
  if (node.type === 'Range') return 'range expression (no xlsx equivalent)';
  if (node.type === 'FuncCall') {
    if (node.name === 'rolling') return 'rolling() (no clean formula)';
    // Nested reduction: allow if inner is a known pointwise function, otherwise bake
    if (REDUCTIONS.has(node.name) && node.args.length > 0) {
      const arg = node.args[0];
      if (arg.type === 'FuncCall' && !POINTWISE.has(arg.name) && !REDUCTIONS.has(arg.name)) {
        return `nested reduction ${node.name}(${arg.name}()) (no formula pattern)`;
      }
    }
  }
  return null;
}

// ── Reference emission ──

function emitRef(name, ctx, asRange) {
  // Resolve binding → grid position
  const sheetName = ctx.currentSheet;
  let bindingSheet = sheetName;
  let bindingName = name;

  // Check cross-sheet: "Sheet.col" already split by caller via MemberAccess
  // Direct ident — look in current sheet first, then all sheets
  const layout = ctx.layout;
  let info = null;

  if (sheetName && layout.sheets[sheetName]) {
    info = layout.sheets[sheetName].bindings[bindingName];
  }
  if (!info) {
    // Search all sheets
    for (const [sn, sd] of Object.entries(layout.sheets)) {
      if (sd.bindings[bindingName]) {
        info = sd.bindings[bindingName];
        bindingSheet = sn;
        break;
      }
    }
  }

  if (!info) return null; // not a layout binding — will be baked

  const col = colLetter(info.col);
  const prefix = (bindingSheet !== sheetName && bindingSheet !== 'Sheet1') ?
    bindingSheet + '!' : '';

  if (asRange) {
    // Reduction range: column relative, rows absolute
    const startRow = info.row + 1; // 1-indexed xlsx
    const endRow = info.row + info.rows; // 1-indexed
    return `${prefix}${col}$${startRow}:${col}$${endRow}`;
  }

  if (!info.isColumn || info.rows === 1) {
    // Scalar → absolute reference
    const row = info.row + 1; // 1-indexed
    return `${prefix}$${col}$${row}`;
  }

  // Column → relative reference (row varies per cell)
  const row = ctx.row + info.row + 1; // 1-indexed
  return `${prefix}${col}${row}`;
}

function emitCrossSheetRef(sheetName, fieldName, ctx, asRange) {
  const layout = ctx.layout;
  const sd = layout.sheets[sheetName];
  if (!sd) return null;
  const info = sd.bindings[fieldName];
  if (!info) return null;

  const col = colLetter(info.col);
  const prefix = sheetName + '!';

  if (asRange) {
    const startRow = info.row + 1;
    const endRow = info.row + info.rows;
    return `${prefix}${col}$${startRow}:${col}$${endRow}`;
  }

  if (!info.isColumn || info.rows === 1) {
    const row = info.row + 1;
    return `${prefix}$${col}$${row}`;
  }

  const row = ctx.row + info.row + 1;
  return `${prefix}${col}${row}`;
}

// ── Formula emission ──

function emitFormula(node, ctx) {
  switch (node.type) {
    case 'NumberLit':
      return String(node.value);

    case 'StringLit':
      return escapeExcelString(node.value);

    case 'BoolLit':
      return node.value ? 'TRUE' : 'FALSE';

    case 'NullLit':
      return '""';

    case 'Ident': {
      // In LAMBDA context, params are bare names
      if (ctx.lambdaParams && ctx.lambdaParams.has(node.name)) {
        return node.name;
      }
      const ref = emitRef(node.name, ctx, ctx.inReduction);
      if (ref) return ref;
      // Not in layout — might be a stdlib function name used directly
      return null;
    }

    case 'BinOp': {
      const left = emitFormula(node.left, ctx);
      const right = emitFormula(node.right, ctx);
      if (left === null || right === null) return null;

      let op = OP_MAP[node.op] || node.op;

      if (op === 'and') return `AND(${left},${right})`;
      if (op === 'or') return `OR(${left},${right})`;

      return `${left}${op}${right}`;
    }

    case 'UnaryOp': {
      const operand = emitFormula(node.operand, ctx);
      if (operand === null) return null;
      if (node.op === '-') return `-${operand}`;
      if (node.op === 'not') return `NOT(${operand})`;
      return null;
    }

    case 'FuncCall': {
      // Check for baked patterns
      const bakeReason = shouldBake(node, ctx);
      if (bakeReason) return null;

      const xlsxName = FUNC_MAP[node.name];

      // User-defined function call (via definedNames LAMBDA)
      if (!xlsxName) {
        // Check if it's a user-defined function
        const udfNames = ctx.layout.functions.map(f => f.name);
        if (udfNames.includes(node.name)) {
          const args = node.args.map(a => emitFormula(a, ctx));
          if (args.some(a => a === null)) return null;
          return `${node.name}(${args.join(',')})`;
        }
        return null;
      }

      // Reduction functions — args emit as ranges
      if (REDUCTIONS.has(node.name)) {
        const reductionCtx = { ...ctx, inReduction: true };
        const args = node.args.map(a => emitFormula(a, reductionCtx));
        if (args.some(a => a === null)) return null;
        return `${xlsxName}(${args.join(',')})`;
      }

      // SCAN(init, range, LAMBDA) — spilled
      if (node.name === 'scan') {
        if (node.args.length < 3) return null;
        const rangeCtx = { ...ctx, inReduction: true };
        const col = emitFormula(node.args[0], rangeCtx);
        const init = emitFormula(node.args[1], ctx);
        const lambda = emitInlineLambda(node.args[2], ctx);
        if (!col || init === null || !lambda) return null;
        return `SCAN(${init},${col},${lambda})`;
      }

      // SORT(range) — spilled
      if (node.name === 'sort') {
        if (node.args.length < 1) return null;
        const rangeCtx = { ...ctx, inReduction: true };
        const col = emitFormula(node.args[0], rangeCtx);
        if (!col) return null;
        return `SORT(${col})`;
      }

      // UNIQUE(range) — spilled
      if (node.name === 'unique') {
        if (node.args.length < 1) return null;
        const rangeCtx = { ...ctx, inReduction: true };
        const col = emitFormula(node.args[0], rangeCtx);
        if (!col) return null;
        return `UNIQUE(${col})`;
      }

      // XLOOKUP(needle, keys, vals [, , match_mode]) — scalar or spilled
      if (node.name === 'lookup') {
        if (node.args.length < 3) return null;
        const needle = emitFormula(node.args[0], ctx);
        const rangeCtx = { ...ctx, inReduction: true };
        const keys = emitFormula(node.args[1], rangeCtx);
        const vals = emitFormula(node.args[2], rangeCtx);
        if (!needle || !keys || !vals) return null;
        // Check for nearest: "below" kwarg
        const nearestKw = node.kwargs && node.kwargs.find(k => k.name === 'nearest');
        if (nearestKw) {
          return `XLOOKUP(${needle},${keys},${vals},,-1)`;
        }
        return `XLOOKUP(${needle},${keys},${vals})`;
      }

      // Regular functions — pointwise
      const args = node.args.map(a => emitFormula(a, ctx));
      if (args.some(a => a === null)) return null;
      return `${xlsxName}(${args.join(',')})`;
    }

    case 'MemberAccess': {
      // Cross-sheet reference: Sales.revenue
      if (node.object.type === 'Ident') {
        const ref = emitCrossSheetRef(node.object.name, node.field, ctx, ctx.inReduction);
        if (ref) return ref;
      }
      return null;
    }

    case 'IfExpr': {
      const cond = emitFormula(node.cond, ctx);
      const then = emitFormula(node.then, ctx);
      const els = emitFormula(node.else, ctx);
      if (cond === null || then === null || els === null) return null;
      return `IF(${cond},${then},${els})`;
    }

    case 'TemplateStr': {
      // `${name} earned ${revenue:$#,##0.00}` → A2&" earned "&TEXT(B2,"$#,##0.00")
      const parts = [];
      for (const part of node.parts) {
        if (typeof part === 'string') {
          if (part.length > 0) parts.push(escapeExcelString(part));
        } else {
          // Parse the expression from the template part
          const exprFormula = emitTemplateExpr(part, ctx);
          if (exprFormula === null) return null;
          parts.push(exprFormula);
        }
      }
      if (parts.length === 0) return '""';
      if (parts.length === 1) return parts[0];
      return parts.join('&');
    }

    // Subscript → FILTER(range, condition)
    case 'Subscript': {
      const rangeCtx = { ...ctx, inReduction: true };
      const col = emitFormula(node.object, rangeCtx);
      const cond = emitFormula(node.index, rangeCtx);
      if (!col || !cond) return null;
      return `FILTER(${col},${cond})`;
    }

    // Baked patterns
    case 'ArrayLit':
    case 'Range':
      return null;

    case 'Lambda': {
      return emitInlineLambda(node, ctx);
    }

    default:
      return null;
  }
}

function emitTemplateExpr(part, ctx) {
  // part = { expr: "revenue", format: "$#,##0.00" } or { expr: "name" }
  // We need to parse the expression string into an AST node
  // For simplicity, handle the common case: identifier or member access
  const exprStr = part.expr.trim();

  // Try to resolve as simple ident
  let formula = emitRef(exprStr, ctx, false);
  if (!formula) {
    // Try member access: "Sales.revenue"
    const dot = exprStr.indexOf('.');
    if (dot > 0) {
      formula = emitCrossSheetRef(exprStr.slice(0, dot), exprStr.slice(dot + 1), ctx, false);
    }
  }
  if (!formula) return null;

  if (part.format) {
    return `TEXT(${formula},${escapeExcelString(part.format)})`;
  }
  return formula;
}

// ── Inline LAMBDA (for scan, etc.) ──

function emitInlineLambda(node, ctx) {
  if (node.type !== 'Lambda') return null;
  const lambdaParams = new Set(node.params);
  const lambdaCtx = { ...ctx, row: 0, lambdaParams };
  const bodyFormula = emitFormula(node.body, lambdaCtx);
  if (!bodyFormula) return null;
  const params = node.params.join(',');
  return `LAMBDA(${params},${bodyFormula})`;
}

// ── UDF → definedNames LAMBDA ──

function emitLambda(funcDef, ctx) {
  // Emit body at row 0 (scalars), with params as bare names
  const lambdaParams = new Set(funcDef.params);
  const lambdaCtx = { ...ctx, row: 0, lambdaParams };
  const bodyFormula = emitFormula(funcDef.body, lambdaCtx);
  if (!bodyFormula) return null;

  const params = funcDef.params.join(',');
  return `LAMBDA(${params},${bodyFormula})`;
}

// ── Workbook assembly ──

export function codegen(ast, layoutResult, evalResult, opts) {
  const warnings = [];
  const workbook = { sheets: [], definedNames: [] };

  // Process UDFs → definedNames
  for (const func of layoutResult.functions) {
    const ctx = { layout: layoutResult, currentSheet: null, row: 0, inReduction: false };
    const formula = emitLambda(func, ctx);
    if (formula) {
      workbook.definedNames.push({ name: func.name, formula });
    } else {
      warnings.push(`Function ${func.name}(): could not emit LAMBDA, skipped`);
    }
  }

  // Process each sheet
  for (const [sheetName, sheetLayout] of Object.entries(layoutResult.sheets)) {
    const sheetData = evalResult.sheets[sheetName] || null;
    const globalBindings = evalResult.bindings;
    const columns = {};

    for (const [bindingName, info] of Object.entries(sheetLayout.bindings)) {
      // Get evaluated value
      let val;
      if (sheetData) {
        val = sheetData.scope.get(bindingName);
      } else {
        val = globalBindings[bindingName];
      }

      // Find the AST node for this binding
      const astNode = findBindingAST(ast, sheetName, bindingName);

      // Try to generate formulas
      const ctx = {
        layout: layoutResult,
        currentSheet: sheetName,
        row: 0,
        inReduction: false,
      };

      let formulas = null;
      let bakeReason = null;

      if (astNode) {
        bakeReason = shouldBake(astNode, ctx);

        if (!bakeReason) {
          const numRows = info.isColumn ? info.rows : 1;
          const spilled = isSpilledNode(astNode);

          if (spilled) {
            // Spilled formula: single formula at row 0, null for rest
            const f = emitFormula(astNode, { ...ctx, row: 0 });
            if (f !== null) {
              const formulaArr = ['=' + f];
              for (let r = 1; r < numRows; r++) formulaArr.push(null);
              formulas = formulaArr;
            }
          } else {
            // Per-row formulas
            const formulaArr = [];
            let allOk = true;
            for (let r = 0; r < numRows; r++) {
              const rowCtx = { ...ctx, row: r };
              const f = emitFormula(astNode, rowCtx);
              if (f === null) { allOk = false; break; }
              formulaArr.push('=' + f);
            }
            if (allOk) formulas = formulaArr;
          }
        }
      }

      if (formulas) {
        // Formulaic column
        const values = bakeValues(val, info);
        columns[bindingName] = { values, formulas };
      } else {
        // Baked column
        if (bakeReason) {
          warnings.push(`${sheetName}.${bindingName}: baked — ${bakeReason}`);
        } else if (astNode) {
          warnings.push(`${sheetName}.${bindingName}: baked — could not emit formula`);
        }
        columns[bindingName] = bakeValues(val, info);
      }
    }

    workbook.sheets.push({ name: sheetName, columns });
  }

  return { workbook, warnings };
}

function bakeValues(val, info) {
  if (val instanceof Float64Array) return val;
  if (isColumn(val)) return val;
  // Scalar — wrap in array
  return [val];
}

function findBindingAST(ast, sheetName, bindingName) {
  for (const node of ast.body) {
    if (node.type === 'SheetBlock' && node.name === sheetName) {
      for (const b of node.body) {
        if (b.type === 'Binding' && b.name === bindingName) return b.expr;
      }
    }
    if (sheetName === 'Sheet1' && node.type === 'Binding' && node.name === bindingName) {
      return node.expr;
    }
  }
  return null;
}
