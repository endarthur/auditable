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
};

// Reductions: their column args emit as ranges
const REDUCTIONS = new Set(['sum', 'mean', 'count', 'min', 'max']);

// Operator mapping calque → xlsx
const OP_MAP = { '==': '=', '/=': '<>', '!=': '<>' };

// ── Baked pattern detection ──

function shouldBake(node, ctx) {
  if (node.type === 'ArrayLit') return 'array literal (data entry)';
  if (node.type === 'Range') return 'range expression (no xlsx equivalent)';
  if (node.type === 'Subscript') return 'subscript/filter (no xlsx equivalent)';
  if (node.type === 'FuncCall') {
    if (node.name === 'rolling') return 'rolling() (no clean formula)';
    if (node.name === 'scan') return 'scan() (modern-only)';
    if (node.name === 'sort') return 'sort() (modern-only)';
    if (node.name === 'unique') return 'unique() (modern-only)';
    if (node.name === 'lookup') return 'lookup() (complex semantics)';
    // Nested reduction: sum(abs(col)) — would need CSE
    if (REDUCTIONS.has(node.name) && node.args.length > 0) {
      const arg = node.args[0];
      if (arg.type !== 'Ident' && arg.type !== 'MemberAccess') {
        return `nested reduction ${node.name}() (would need array formula)`;
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

    // Baked patterns
    case 'ArrayLit':
    case 'Range':
    case 'Subscript':
      return null;

    case 'Lambda':
      return null;

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
          // Try emitting per-row formulas
          const numRows = info.isColumn ? info.rows : 1;
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
