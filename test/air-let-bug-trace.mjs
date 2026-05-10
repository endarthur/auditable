// Dump AIR ops with types to trace where i32 propagation goes wrong.

import * as Acorn from 'acorn';
import tsPlugin from 'acorn-typescript';
import { analyzeCell } from '../ext/air/src/api.js';

const Parser = Acorn.Parser.extend(tsPlugin());

const source = `
function ddot_unrolled4(x, y, n) {
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
  const n4 = n - (n & 3);
  let i = 0;
  for (; i < n4; i += 4) {
    s0 += x[i  ] * y[i  ];
    s1 += x[i+1] * y[i+1];
    s2 += x[i+2] * y[i+2];
    s3 += x[i+3] * y[i+3];
  }
  let s = (s0 + s1) + (s2 + s3);
  for (; i < n; i++) s += x[i] * y[i];
  return s;
}
`;

const result = analyzeCell(source, Parser, new Set());

function fmtType(t) {
  if (!t) return '?';
  if (t.kind === 'function') return 'fn';
  return t.kind || JSON.stringify(t);
}

function dumpOps(ops, indent = '') {
  for (const op of ops) {
    const args = (op.args || []).map(a =>
      typeof a === 'string' && a.startsWith('%') ? a :
      typeof a === 'string' ? `"${a}"` :
      a === undefined ? 'undef' :
      JSON.stringify(a)
    ).join(', ');
    console.log(`${indent}${op.id} = ${op.op}[${fmtType(op.type)}](${args})`);
    // Recurse into regions
    for (const key of ['body', 'init', 'test', 'update', 'then_body', 'else_body', 'try_body', 'catch_body', 'finally_body']) {
      if (op[key] && Array.isArray(op[key])) {
        console.log(`${indent}  ${key}:`);
        dumpOps(op[key], indent + '    ');
      }
    }
  }
}

dumpOps(result.air.ops);
