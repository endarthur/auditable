// AIR interpreter vs emit-js performance comparison.
// Quick & rough — not a benchmark suite, just enough to know the
// order of magnitude.

import { lowerJS } from '../ext/air/src/lower/js.js';
import { runPasses } from '../ext/air/src/passes.js';
import { emitJS, needsAsync } from '../ext/air/src/emit-js.js';
import { Interpreter } from '../ext/air/src/interp.js';
import { Parser, tsPlugin } from '../ext/acorn/acorn.esm.min.js';

const AcornTS = Parser.extend(tsPlugin());

function lowerJsCode(code) {
  const ast = AcornTS.parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  const m = lowerJS(ast, code);
  runPasses(m);
  return m;
}

function compile(m) {
  const importNames = [...m.imports];
  const js = emitJS(m, importNames, [], { hinted: false, cellId: 'bench' });
  const isAsync = needsAsync(m);
  const FunctionCtor = isAsync ? Object.getPrototypeOf(async function(){}).constructor : Function;
  const fn = new FunctionCtor(...importNames, js);
  const args = importNames.map(n => globalThis[n]);
  return () => fn(...args);
}

async function bench(name, code, iterations = 1) {
  const m = lowerJsCode(code);
  const compiled = compile(m);
  // Warm up
  for (let i = 0; i < 3; i++) await compiled();
  const interpWarm = new Interpreter(m);
  for (let i = 0; i < 3; i++) await interpWarm.run();

  // Emit-js timing
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) await compiled();
  const emitMs = performance.now() - t0;

  // Interpreter timing
  const t1 = performance.now();
  for (let i = 0; i < iterations; i++) {
    const interp = new Interpreter(m);
    await interp.run();
  }
  const interpMs = performance.now() - t1;

  const ratio = interpMs / emitMs;
  console.log(`${name.padEnd(36)} emit-js: ${emitMs.toFixed(1)}ms   interp: ${interpMs.toFixed(1)}ms   ${ratio.toFixed(1)}× slower`);
  return { emitMs, interpMs, ratio };
}

console.log('Iterations per scenario:');
console.log('─'.repeat(80));

await bench('arithmetic loop sum 0..1000', `
  let total = 0;
  for (let i = 0; i < 1000; i++) total = total + i;
  const r = total;
`, 100);

await bench('arithmetic loop sum 0..10000', `
  let total = 0;
  for (let i = 0; i < 10000; i++) total = total + i;
  const r = total;
`, 30);

await bench('recursive fib(15)', `
  function fib(n) { return n < 2 ? n : fib(n-1) + fib(n-2); }
  const r = fib(15);
`, 50);

await bench('recursive fib(20)', `
  function fib(n) { return n < 2 ? n : fib(n-1) + fib(n-2); }
  const r = fib(20);
`, 5);

await bench('typed array dot product (n=1000)', `
  const a = new Float64Array(1000);
  const b = new Float64Array(1000);
  for (let i = 0; i < 1000; i++) { a[i] = i * 0.1; b[i] = i * 0.2; }
  let sum = 0.0;
  for (let i = 0; i < 1000; i++) sum = sum + a[i] * b[i];
  const r = sum;
`, 50);

await bench('object/array building (n=100)', `
  const xs = [];
  for (let i = 0; i < 100; i++) {
    xs.push({ idx: i, sqrt: Math.sqrt(i), label: 'item' + i });
  }
  const last = xs[xs.length - 1];
  const r = last.idx + last.sqrt;
`, 100);

await bench('string concat (n=500)', `
  let s = '';
  for (let i = 0; i < 500; i++) s = s + i + ',';
  const r = s.length;
`, 100);

// Skipped: higher-order map/reduce with async-wrapped callbacks. Native
// Array.prototype.map doesn't await the callback's Promise returns, so
// `xs.map(asyncCallback)` produces an array of Promises rather than
// values. v0 limitation matching the class-constructor issue (both stem
// from the async-wrap-everything design). v1 sync/async dispatch fixes
// both.

await bench('nested loops (50×50)', `
  let count = 0;
  for (let i = 0; i < 50; i++) {
    for (let j = 0; j < 50; j++) {
      if (i === j) count = count + 1;
    }
  }
  const r = count;
`, 100);

await bench('try/catch overhead', `
  let caught = 0;
  for (let i = 0; i < 100; i++) {
    try { if (i % 2 === 0) throw new Error('x'); }
    catch (e) { caught = caught + 1; }
  }
  const r = caught;
`, 100);

console.log('─'.repeat(80));
