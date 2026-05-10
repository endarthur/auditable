// Verify: does AIR-emitted ddot still produce correct numbers AND match
// hand-tuned JS performance after the fix?

import * as Acorn from 'acorn';
import tsPlugin from 'acorn-typescript';
import { analyzeCell } from '../ext/air/src/api.js';
import { emitJS } from '../ext/air/src/emit-js.js';

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
const emitted = emitJS(result.air, [], [], { cellId: 'test', cellName: 'verify' });

// Wrap into a Function so we can call it.
const fn = new Function(emitted + '\nreturn { ddot_unrolled4 };')();

// Reference computation
const n = 1000;
const x = new Float64Array(n), y = new Float64Array(n);
for (let i = 0; i < n; i++) { x[i] = Math.sin(i * 0.1); y[i] = Math.cos(i * 0.1); }

let ref = 0;
for (let i = 0; i < n; i++) ref += x[i] * y[i];

const air = fn.ddot_unrolled4(x, y, n);

console.log('reference :', ref);
console.log('AIR result:', air);
console.log('match within 1e-9?', Math.abs(ref - air) < 1e-9);
console.log();
console.log('=== emitted code (excerpt) ===');
console.log(emitted.split('\n').slice(0, 25).join('\n'));
