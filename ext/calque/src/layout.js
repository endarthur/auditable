// Layout engine — assign grid positions to bindings
//
// Input: AST + evalResult (from evaluate())
// Output: layout map — binding name → { col, row, rows, isColumn }
//
// Supports layout directives: @below(ref), @right(ref), @anchor(col, row)
// with optional gap: N kwarg on @below/@right.

import { isColumn, isFunc } from './stdlib.js';

export function layout(ast, evalResult) {
  const sheets = {};
  const functions = [];

  // Collect bare bindings for Sheet1
  const bareBindings = [];

  for (const node of ast.body) {
    if (node.type === 'SheetBlock') {
      sheets[node.name] = layoutSheet(node.body, evalResult.sheets[node.name]);
    } else if (node.type === 'FuncDef') {
      functions.push({ name: node.name, params: node.params, body: node.body });
    } else if (node.type === 'Binding') {
      bareBindings.push(node);
    }
  }

  if (bareBindings.length > 0) {
    sheets['Sheet1'] = layoutBindings(bareBindings, (name) => evalResult.bindings[name]);
  }

  return { sheets, functions };
}

function layoutSheet(body, sheetData) {
  const nodes = body.filter(n => n.type === 'Binding');
  return layoutBindings(nodes, (name) => sheetData ? sheetData.scope.get(name) : undefined);
}

function layoutBindings(nodes, getVal) {
  const bindings = {};
  let maxRows = 0;
  let nextCol = 0;

  // Separate auto-placed and directive-placed bindings
  const autoNodes = [];
  const dirNodes = [];

  for (const node of nodes) {
    if (node.name.startsWith('_')) continue;
    const val = getVal(node.name);
    if (val !== undefined && isFunc(val)) continue;

    if (node.directives && node.directives.length > 0) {
      dirNodes.push(node);
    } else {
      autoNodes.push(node);
    }
  }

  // Pass 1: auto-place non-directive bindings sequentially
  for (const node of autoNodes) {
    const val = getVal(node.name);
    const isCol = val !== undefined && isColumn(val);
    const rows = isCol ? val.length : 1;
    bindings[node.name] = { col: nextCol, row: 1, rows, isColumn: isCol };
    if (rows > maxRows) maxRows = rows;
    nextCol++;
  }

  // Pass 2: resolve directive bindings
  for (const node of dirNodes) {
    const val = getVal(node.name);
    const isCol = val !== undefined && isColumn(val);
    const rows = isCol ? val.length : 1;

    const pos = resolveDirectives(node.directives, bindings, nextCol, node.name, isCol);
    const info = { col: pos.col, row: pos.row, rows, isColumn: isCol };
    if (pos.label !== undefined) info.label = pos.label;
    bindings[node.name] = info;
    if (pos.row + rows > maxRows + 1) maxRows = pos.row + rows - 1;
    // Don't increment nextCol — directive bindings use explicit positions
  }

  return { bindings, maxRows };
}

function resolveDirectives(directives, bindings, nextCol, name, isCol) {
  // Use the last positioning directive
  for (let i = directives.length - 1; i >= 0; i--) {
    const d = directives[i];
    const gap = getGap(d);
    const label = getLabel(d, isCol);

    if (d.name === 'below') {
      if (d.args.length < 1 || d.args[0].type !== 'Ident') {
        throw new Error(`@below requires a binding reference in '${name}'`);
      }
      const refName = d.args[0].name;
      const ref = bindings[refName];
      if (!ref) throw new Error(`@below(${refName}): unknown binding '${refName}' in '${name}'`);
      // label "above" adds +1 for header row; "left"/false do not
      const headerOffset = label === 'above' ? 1 : 0;
      return { col: ref.col, row: ref.row + ref.rows + gap + headerOffset, label };
    }

    if (d.name === 'right') {
      if (d.args.length < 1 || d.args[0].type !== 'Ident') {
        throw new Error(`@right requires a binding reference in '${name}'`);
      }
      const refName = d.args[0].name;
      const ref = bindings[refName];
      if (!ref) throw new Error(`@right(${refName}): unknown binding '${refName}' in '${name}'`);
      return { col: ref.col + 1 + gap, row: ref.row };
    }

    if (d.name === 'anchor') {
      if (d.args.length < 2) {
        throw new Error(`@anchor requires (col, row) in '${name}'`);
      }
      const col = d.args[0].type === 'NumberLit' ? d.args[0].value : null;
      const row = d.args[1].type === 'NumberLit' ? d.args[1].value : null;
      if (col === null || row === null) {
        throw new Error(`@anchor requires numeric col and row in '${name}'`);
      }
      const anchorLabel = getLabel(d, isCol);
      // label false: data at exact row, no header offset
      // label "above" (default): header at row, data at row + 1
      // label "left": data at row + 1, header to the left
      const headerOffset = anchorLabel === false ? 0 : 1;
      return { col, row: row + headerOffset, label: anchorLabel };
    }

    if (d.name === 'formula') continue; // codegen-only, no layout effect
    throw new Error(`Unknown directive @${d.name} in '${name}'`);
  }

  // No positioning directive found — auto-place
  return { col: nextCol, row: 1 };
}

function getGap(directive) {
  if (!directive.kwargs) return 0;
  const gapKw = directive.kwargs.find(k => k.name === 'gap');
  if (!gapKw) return 0;
  if (gapKw.value.type === 'NumberLit') return gapKw.value.value;
  return 0;
}

function getLabel(directive, isCol) {
  if (!directive.kwargs) {
    // Default: @below + scalar → "left", else "above"
    return directive.name === 'below' && !isCol ? 'left' : 'above';
  }
  const labelKw = directive.kwargs.find(k => k.name === 'label');
  if (!labelKw) {
    return directive.name === 'below' && !isCol ? 'left' : 'above';
  }
  if (labelKw.value.type === 'BoolLit' && labelKw.value.value === false) return false;
  if (labelKw.value.type === 'StringLit') return labelKw.value.value;
  return 'above';
}
