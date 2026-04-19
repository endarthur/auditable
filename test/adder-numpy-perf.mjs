// Compare pure-adder (transpiled) array ops against NumPy (run separately).
import { adderParse } from '../ext/adder/src/parse.js';
import { lowerAdder } from '../ext/air/src/lower/adder.js';
import { runPasses } from '../ext/air/src/passes.js';
import { emitJS } from '../ext/air/src/emit-js.js';
import { _py } from '../ext/adder/src/runtime.js';
import { adderBuiltins } from '../ext/adder/src/builtins.js';

const SILENT = () => null;

async function compileTranspile(code) {
  const ast = adderParse(code);
  const air = lowerAdder(ast, code);
  runPasses(air);
  const importNames = [...air.imports];
  const js = emitJS(air, importNames, [], { hinted: false, cellId: 'bench' });
  const builtins = adderBuiltins(SILENT);
  const AF = Object.getPrototypeOf(async function(){}).constructor;
  const fn = new AF('_py', ...importNames, js);
  const args = importNames.map(n => builtins[n] !== undefined ? builtins[n] : undefined);
  return () => fn(_py, ...args);
}

async function time(label, runs, fn) {
  for (let i = 0; i < Math.min(3, runs); i++) await fn();
  const start = performance.now();
  for (let i = 0; i < runs; i++) await fn();
  const elapsed = performance.now() - start;
  console.log(`  ${label.padEnd(30)}: ${elapsed.toFixed(1)}ms (${(elapsed/runs).toFixed(3)}ms/run)`);
  return elapsed / runs;
}

console.log('=== 10,000 element vector add (pure adder list) ===');
console.log('CPython pure list:              11.5ms total (0.576ms/run)');
console.log('CPython NumPy (with alloc):      0.5ms total (0.010ms/run)');
console.log('CPython NumPy (op only):         0.2ms total (0.002ms/run)');
const add1 = await compileTranspile(`
n = 10000
a = list(range(n))
b = list(range(n))
c = [a[i] + b[i] for i in range(n)]
`);
await time('adder transpile (list)', 20, add1);

const add2 = await compileTranspile(`
n = 10000
a = list(range(n))
b = list(range(n))
c = []
for i in range(n):
    c.append(a[i] + b[i])
`);
await time('adder transpile (loop+append)', 20, add2);

console.log('\n=== sum of 100,000 elements ===');
console.log('CPython pure:                    80.6ms (4.028ms/run)');
console.log('CPython NumPy (with alloc):      22.9ms (0.229ms/run)');
console.log('CPython NumPy (op only):          4.1ms (0.020ms/run)');
const sum1 = await compileTranspile(`
n = 100000
a = list(range(n))
total = 0
for x in a:
    total = total + x
`);
await time('adder transpile', 20, sum1);

console.log('\n=== dot product of 10,000 elements ===');
console.log('CPython pure:                    16.7ms (0.836ms/run)');
console.log('CPython NumPy (with alloc):       3.8ms (0.038ms/run)');
console.log('CPython NumPy (op only):          4.9ms (0.024ms/run)');
const dot1 = await compileTranspile(`
n = 10000
a = list(range(n))
b = list(range(n))
total = 0
for i in range(n):
    total = total + a[i] * b[i]
`);
await time('adder transpile', 20, dot1);
