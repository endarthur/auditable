// Evaluator — AST → typed array results
//
// Walks the AST produced by parse.js, evaluates expressions using
// stdlib functions and broadcasting. Produces a scope of bindings.

import { stdlib, ops, broadcast, broadcastUnary, isColumn, isTable, isFunc, makeRange } from './stdlib.js';
import { lex } from './lex.js';
import { parse } from './parse.js';

export function evaluate(ast) {
  const globalScope = new Map();
  const sheets = new Map();
  const exports = new Map();

  for (const node of ast.body) {
    if (node.type === 'SheetBlock') {
      const sheetScope = new Map();
      for (const binding of node.body) {
        evalStatement(binding, sheetScope, globalScope);
      }
      // Build table from sheet bindings
      const table = buildSheetTable(sheetScope);
      globalScope.set(node.name, table);
      sheets.set(node.name, { scope: sheetScope, table });
      // Collect exports
      for (const binding of node.body) {
        if (binding.type === 'Binding' && binding.exported) {
          exports.set(node.name + '.' + binding.name, resolveInScope(binding.name, sheetScope, globalScope));
        }
      }
    } else {
      evalStatement(node, globalScope, null);
      if (node.type === 'Binding' && node.exported) {
        exports.set(node.name, globalScope.get(node.name));
      }
    }
  }

  return {
    bindings: Object.fromEntries(globalScope),
    exports: Object.fromEntries(exports),
    sheets: Object.fromEntries(sheets),
    scope: globalScope,
  };
}

function evalStatement(node, scope, parentScope) {
  if (node.type === 'Binding') {
    const value = evalExpr(node.expr, scope, parentScope);
    scope.set(node.name, value);
  } else if (node.type === 'FuncDef') {
    scope.set(node.name, {
      __func: true,
      params: node.params,
      body: node.body,
      closure: scope,
      parentScope: parentScope,
      __body: makeCallable(node.params, node.body, scope, parentScope),
    });
  }
}

function makeCallable(params, bodyAST, closure, parentScope) {
  return function(...args) {
    const callScope = new Map(closure);
    for (let i = 0; i < params.length; i++) {
      callScope.set(params[i], i < args.length ? args[i] : null);
    }
    return evalExpr(bodyAST, callScope, parentScope);
  };
}

function resolveInScope(name, scope, parentScope) {
  if (scope && scope.has(name)) return scope.get(name);
  if (parentScope && parentScope.has(name)) return parentScope.get(name);
  return undefined;
}

function buildSheetTable(scope) {
  const headers = [];
  const columns = {};
  let rows = 0;
  for (const [name, value] of scope) {
    if (isFunc(value)) continue; // skip function definitions
    headers.push(name);
    columns[name] = value;
    if (isColumn(value)) rows = Math.max(rows, value.length);
  }
  return { __table: true, columns, headers, rows };
}

function evalExpr(node, scope, parentScope) {
  switch (node.type) {
    case 'NumberLit': return node.value;
    case 'StringLit': return node.value;
    case 'BoolLit':   return node.value;
    case 'NullLit':   return null;

    case 'Ident': {
      const v = resolveInScope(node.name, scope, parentScope);
      if (v === undefined && stdlib[node.name]) return stdlib[node.name];
      if (v === undefined) throw new Error(`Undefined variable: ${node.name}`);
      return v;
    }

    case 'BinOp': {
      const left = evalExpr(node.left, scope, parentScope);
      const right = evalExpr(node.right, scope, parentScope);
      const op = ops[node.op];
      if (!op) throw new Error(`Unknown operator: ${node.op}`);
      return broadcast(op, left, right);
    }

    case 'UnaryOp': {
      const operand = evalExpr(node.operand, scope, parentScope);
      if (node.op === '-') return broadcastUnary(ops.neg, operand);
      if (node.op === 'not') return broadcastUnary(ops.not, operand);
      throw new Error(`Unknown unary operator: ${node.op}`);
    }

    case 'ArrayLit': {
      const elements = node.elements.map(e => evalExpr(e, scope, parentScope));
      // Determine array type from elements
      if (elements.length === 0) return new Float64Array(0);
      if (elements.every(e => typeof e === 'number')) {
        return Float64Array.from(elements);
      }
      if (elements.every(e => typeof e === 'string')) {
        return elements;
      }
      if (elements.every(e => typeof e === 'boolean')) {
        return Uint8Array.from(elements.map(e => e ? 1 : 0));
      }
      return elements;
    }

    case 'TableLit': {
      const columns = {};
      const headers = [];
      let rows = 0;
      for (const col of node.columns) {
        const value = evalExpr(col.values, scope, parentScope);
        columns[col.name] = value;
        headers.push(col.name);
        if (isColumn(value)) rows = Math.max(rows, value.length);
      }
      return { __table: true, columns, headers, rows };
    }

    case 'Range': {
      const start = evalExpr(node.start, scope, parentScope);
      const end = evalExpr(node.end, scope, parentScope);
      return makeRange(start, end);
    }

    case 'MemberAccess': {
      const obj = evalExpr(node.object, scope, parentScope);
      if (isTable(obj)) {
        if (obj.columns[node.field] !== undefined) return obj.columns[node.field];
        throw new Error(`Table has no column '${node.field}'`);
      }
      if (obj && typeof obj === 'object' && node.field in obj) return obj[node.field];
      throw new Error(`Cannot access '${node.field}' on ${typeof obj}`);
    }

    case 'Subscript': {
      const obj = evalExpr(node.object, scope, parentScope);
      const index = evalExpr(node.index, scope, parentScope);
      // Filter: col[boolCol]
      if (isColumn(obj) && isColumn(index)) {
        const result = [];
        for (let i = 0; i < obj.length; i++) {
          if (index[i]) result.push(obj[i]);
        }
        if (result.length === 0) return obj instanceof Float64Array ? new Float64Array(0) : [];
        if (obj instanceof Float64Array) return Float64Array.from(result);
        return result;
      }
      // Numeric index
      if (typeof index === 'number') {
        return obj[Math.round(index)];
      }
      throw new Error('Invalid subscript');
    }

    case 'FuncCall': {
      const fn = resolveInScope(node.name, scope, parentScope) || stdlib[node.name];
      if (!fn) throw new Error(`Undefined function: ${node.name}`);

      const args = node.args.map(a => evalExpr(a, scope, parentScope));

      // Build kwargs object if any
      let kwargsObj = null;
      if (node.kwargs.length > 0) {
        kwargsObj = {};
        for (const kw of node.kwargs) {
          kwargsObj[kw.name] = evalExpr(kw.value, scope, parentScope);
        }
      }

      // User-defined function
      if (isFunc(fn)) {
        return fn.__body(...args);
      }

      // Stdlib function — pass kwargs as last argument if present
      if (typeof fn === 'function') {
        if (kwargsObj) args.push(kwargsObj);
        return fn(...args);
      }

      throw new Error(`'${node.name}' is not callable`);
    }

    case 'Lambda': {
      return {
        __func: true,
        params: node.params,
        body: node.body,
        closure: scope,
        parentScope: parentScope,
        __body: makeCallable(node.params, node.body, scope, parentScope),
      };
    }

    case 'IfExpr': {
      const cond = evalExpr(node.cond, scope, parentScope);
      const then = evalExpr(node.then, scope, parentScope);
      const els = evalExpr(node.else, scope, parentScope);

      if (isColumn(cond)) {
        // Pointwise if
        const len = cond.length;
        const result = new Array(len);
        for (let i = 0; i < len; i++) {
          const c = cond[i];
          const t = isColumn(then) ? then[i] : then;
          const e = isColumn(els) ? els[i] : els;
          result[i] = c ? t : e;
        }
        // infer type
        if (result.length > 0 && typeof result[0] === 'number') return Float64Array.from(result);
        return result;
      }

      return cond ? then : els;
    }

    case 'TemplateStr': {
      // Desugar: concatenate parts with & and text() for formatted expressions
      let result = '';
      let isColumnResult = false;
      let colLen = 0;

      // First pass: evaluate all parts and detect columns
      const evaluated = [];
      for (const part of node.parts) {
        if (typeof part === 'string') {
          evaluated.push(part);
        } else {
          // Parse and evaluate the expression
          const tokens = lex(part.expr);
          const exprAST = parse(tokens);
          // The parsed result is a Program; we want the first binding's expr or the first expression
          let val;
          if (exprAST.body.length === 1 && exprAST.body[0].type === 'Binding') {
            val = evalExpr(exprAST.body[0].expr, scope, parentScope);
          } else {
            // Try evaluating as expression — wrap in a binding for simplicity
            // Actually, a bare expression at top level would fail our parser.
            // Template expressions are simple, so re-parse as expression via a binding.
            const wrappedTokens = lex('_tmp = ' + part.expr);
            const wrappedAST = parse(wrappedTokens);
            val = evalExpr(wrappedAST.body[0].expr, scope, parentScope);
          }
          if (part.format) {
            val = stdlib.text(val, part.format);
          }
          if (isColumn(val)) { isColumnResult = true; colLen = val.length; }
          evaluated.push(val);
        }
      }

      if (!isColumnResult) {
        // All scalar
        return evaluated.map(v => typeof v === 'string' ? v : String(v == null ? '' : v)).join('');
      }

      // Broadcast to column
      const resultArr = new Array(colLen);
      for (let i = 0; i < colLen; i++) {
        let s = '';
        for (const v of evaluated) {
          if (typeof v === 'string') s += v;
          else if (isColumn(v)) s += String(v[i] == null ? '' : v[i]);
          else s += String(v == null ? '' : v);
        }
        resultArr[i] = s;
      }
      return resultArr;
    }

    case 'Import': {
      // Import is a runtime operation that would need file access
      // For Phase 1, return a placeholder
      throw new Error('import requires runtime file access (not available in evaluator)');
    }

    default:
      throw new Error(`Unknown AST node type: ${node.type}`);
  }
}
