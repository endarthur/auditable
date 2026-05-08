// Performance comparison: soft tree-walker vs AIR transpile.

import { softParse } from '../ext/soft/src/parse.js';
import { softEval } from '../ext/soft/src/eval.js';
import { lowerSoft } from '../ext/soft/src/air-lower.js';
import { runPasses } from '../ext/air/src/passes.js';
import { emitJS } from '../ext/air/src/emit-js.js';
import { _soft } from '../ext/soft/src/runtime.js';

async function runTreeWalker(code) {
  return softEval(code, { maxSteps: 10_000_000 });
}

async function compileTranspile(code) {
  const say = () => null;
  const ast = softParse(code);
  const air = lowerSoft(ast, code);
  runPasses(air);
  const importNames = [...air.imports];
  const js = emitJS(air, importNames, [], { hinted: false, cellId: 'bench' });
  const AF = Object.getPrototypeOf(async function(){}).constructor;
  const fn = new AF('_soft', ...importNames, js);
  const args = importNames.map(n => n === 'say' ? say : undefined);
  return () => fn(_soft, ...args);
}

async function time(label, runs, fn) {
  for (let i = 0; i < Math.min(3, runs); i++) await fn();
  const start = performance.now();
  for (let i = 0; i < runs; i++) await fn();
  const elapsed = performance.now() - start;
  console.log(`  ${label.padEnd(22)}: ${elapsed.toFixed(1)}ms (${(elapsed/runs).toFixed(3)}ms/run)`);
  return elapsed / runs;
}

async function bench(name, code, runs) {
  console.log(`\n=== ${name} (${runs} runs) ===`);
  const compiled = await compileTranspile(code);
  const tw = await time('tree-walker', runs, () => runTreeWalker(code));
  const tr = await time('transpile (compiled)', runs, () => compiled());
  console.log(`  → speedup: ${(tw / tr).toFixed(1)}x`);
}

console.log('Soft performance comparison');
console.log('===========================');

await bench('sum 1..10000', `
set total to 0
repeat from 1 to 10000 as i
  set total to total + i
end
`, 10);

await bench('nested loop 100x100', `
set total to 0
repeat from 1 to 100 as i
  repeat from 1 to 100 as j
    set total to total + i * j
  end
end
`, 10);

await bench('list iteration (1000 * 10)', `
set data to list 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
set total to 0
repeat from 1 to 1000 as _
  repeat each x in data
    set total to total + x
  end
end
`, 10);
