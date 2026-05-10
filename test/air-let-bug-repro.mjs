// Minimal repro for AIR emit-js dropping `let` declarations.

import * as Acorn from 'acorn';
import tsPlugin from 'acorn-typescript';
import { analyzeCell } from '../ext/air/src/api.js';
import { emitJS } from '../ext/air/src/emit-js.js';

const Parser = Acorn.Parser.extend(tsPlugin());

// Same shape as the buggy notebook cell — multiple function decls in one cell.
const source = `
function ddot_naive(x, y, n) {
  let s = 0;
  for (let i = 0; i < n; i++) s += x[i] * y[i];
  return s;
}

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
console.log('analyze defines:', [...result.defines]);
console.log();

const emitted = emitJS(result.air, [], [], { cellId: 'test', cellName: 'repro' });
console.log('=== emitted JS ===');
console.log(emitted);
