// Layout engine — assign grid positions to bindings
//
// Input: AST + evalResult (from evaluate())
// Output: layout map — binding name → { col, row, rows, isColumn }

import { isColumn, isFunc } from './stdlib.js';

export function layout(ast, evalResult) {
  const sheets = {};
  const functions = [];

  for (const node of ast.body) {
    if (node.type === 'SheetBlock') {
      sheets[node.name] = layoutSheet(node.body, evalResult.sheets[node.name]);
    } else if (node.type === 'FuncDef') {
      functions.push({ name: node.name, params: node.params, body: node.body });
    } else if (node.type === 'Binding') {
      // Bare bindings go into default sheet
      if (!sheets['Sheet1']) sheets['Sheet1'] = { bindings: {}, maxRows: 0 };
      const sheet = sheets['Sheet1'];
      if (node.name.startsWith('_')) continue;
      const col = Object.keys(sheet.bindings).length;
      const val = evalResult.bindings[node.name];
      const isCol = isColumn(val);
      const rows = isCol ? val.length : 1;
      sheet.bindings[node.name] = { col, row: 1, rows, isColumn: isCol };
      if (rows > sheet.maxRows) sheet.maxRows = rows;
    }
  }

  return { sheets, functions };
}

function layoutSheet(body, sheetData) {
  const bindings = {};
  let col = 0;
  let maxRows = 0;

  for (const node of body) {
    if (node.type === 'FuncDef') continue;
    if (node.type === 'Binding' && node.name.startsWith('_')) continue;
    if (node.type !== 'Binding') continue;

    const val = sheetData ? sheetData.scope.get(node.name) : undefined;
    if (val !== undefined && isFunc(val)) continue;

    const isCol = val !== undefined && isColumn(val);
    const rows = isCol ? val.length : 1;
    bindings[node.name] = { col, row: 1, rows, isColumn: isCol };
    if (rows > maxRows) maxRows = rows;
    col++;
  }

  return { bindings, maxRows };
}
