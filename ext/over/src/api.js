// @gcu/over — public API. compile(text, opts) → a transform: parse → schema pass
// → emit the row function → return { outputColumns, source, run(rows) }.
//
//   const t = compile('FE_N = FE / 100\nsaveonly(FE, FE_N)', { inputSchema });
//   t.outputColumns        // resolved BEFORE running (the schema-pass preview)
//   t.run(rows)            // → { columns, rows }
//
// If inputSchema is omitted it's inferred from the rows at run time (so
// `compile(text).run(rows)` just works); pass it when you want the preview.

import { parse } from './parse.js';
import { schemaPass } from './schema.js';
import { compileRowFn } from './emit.js';
import { applyRows } from './driver.js';

function inferSchema(rows) {
  if (!rows || !rows.length) return [];
  const r0 = rows[0];
  return Object.keys(r0).map((name) => {
    const v = r0[name];
    const type = typeof v === 'number' ? (Number.isInteger(v) ? 'int' : 'float')
      : typeof v === 'boolean' ? 'bool' : 'string';
    return { name, type };
  });
}

export function compile(text, opts = {}) {
  const ast = parse(text);
  const rowFn = compileRowFn(ast);
  const staticSchema = opts.inputSchema ? schemaPass(ast, opts.inputSchema, opts) : null;
  return {
    ast,
    dialect: ast.dialect,
    source: rowFn.source,
    outputColumns: staticSchema ? staticSchema.columns : null,
    warnings: staticSchema ? staticSchema.warnings : null,
    run(rows) {
      const sch = staticSchema || schemaPass(ast, inferSchema(rows), opts);
      return { columns: sch.columns, rows: applyRows(rowFn, sch.columns, rows) };
    },
  };
}
