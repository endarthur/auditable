// Performance comparison: adder tree-walker vs AIR transpile
// Not a test file — run directly: node test/adder-perf.mjs

import { adderParse } from '../ext/adder/src/parse.js';
import { adderEval, AdderScope } from '../ext/adder/src/eval.js';
import { lowerAdder } from '../ext/adder/src/air-lower.js';
import { runPasses } from '../ext/air/src/passes.js';
import { emitJS } from '../ext/air/src/emit-js.js';
import { _py } from '../ext/adder/src/runtime.js';
import { adderBuiltins } from '../ext/adder/src/builtins.js';

const SILENT_PRINT = () => null;

async function runTreeWalker(code) {
  const ast = adderParse(code);
  const scope = new AdderScope();
  const builtins = adderBuiltins(SILENT_PRINT);
  for (const [k, v] of Object.entries(builtins)) scope.set(k, v);
  return adderEval(ast, scope);
}

async function runTranspile(code) {
  const ast = adderParse(code);
  const air = lowerAdder(ast, code);
  runPasses(air);
  const importNames = [...air.imports];
  const js = emitJS(air, importNames, [], { hinted: false, cellId: 'bench' });
  const builtins = adderBuiltins(SILENT_PRINT);
  const AF = Object.getPrototypeOf(async function(){}).constructor;
  const fn = new AF('_py', ...importNames, js);
  const args = importNames.map(n => builtins[n] !== undefined ? builtins[n] : undefined);
  return fn(_py, ...args);
}

// Cache the transpile output for pure-runtime comparison
async function compileTranspile(code) {
  const ast = adderParse(code);
  const air = lowerAdder(ast, code);
  runPasses(air);
  const importNames = [...air.imports];
  const js = emitJS(air, importNames, [], { hinted: false, cellId: 'bench' });
  const builtins = adderBuiltins(SILENT_PRINT);
  const AF = Object.getPrototypeOf(async function(){}).constructor;
  const fn = new AF('_py', ...importNames, js);
  const args = importNames.map(n => builtins[n] !== undefined ? builtins[n] : undefined);
  return () => fn(_py, ...args);
}

async function time(label, runs, fn) {
  // Warmup
  for (let i = 0; i < Math.min(3, runs); i++) await fn();
  // Measure
  const start = performance.now();
  for (let i = 0; i < runs; i++) await fn();
  const elapsed = performance.now() - start;
  const each = elapsed / runs;
  console.log(`  ${label.padEnd(20)}: ${elapsed.toFixed(1)}ms total (${each.toFixed(3)}ms/run)`);
  return elapsed;
}

async function bench(name, code, runs, cpythonMs) {
  console.log(`\n=== ${name} (${runs} runs) ===`);

  const compiled = await compileTranspile(code);

  const tw = await time('tree-walker', runs, () => runTreeWalker(code));
  const tr = await time('transpile (fresh)', runs, () => runTranspile(code));
  const trPre = await time('transpile (compiled)', runs, () => compiled());

  const twEach = tw / runs, trEach = trPre / runs;
  if (cpythonMs !== undefined) {
    console.log(`  CPython 3.12:         ${(cpythonMs * runs).toFixed(1)}ms total (${cpythonMs.toFixed(3)}ms/run)`);
    console.log(`  → AIR vs tree-walker:  ${(tw/trPre).toFixed(1)}x`);
    console.log(`  → AIR vs CPython:      ${(cpythonMs / trEach).toFixed(2)}x ${cpythonMs / trEach > 1 ? 'faster' : 'slower'}`);
    console.log(`  → CPython vs tw:       ${(twEach / cpythonMs).toFixed(1)}x faster than tree-walker`);
  } else {
    console.log(`  speedup:             ${(tw/trPre).toFixed(1)}x (compiled vs tree-walker)`);
  }
}

console.log('Adder performance comparison');
console.log('============================');

// CPython times (ms/run) from `python test/perf_py.py`. Update manually after running.
const CPY = {
  sum: 0.730,
  fib: 8.661,
  listcomp: 0.335,
  nested: 0.809,
  strcat: 0.820,
  memo: 0.046,
};

// Numeric: sum of range
await bench('sum 1..10000', `
total = 0
for i in range(10000):
    total = total + i
total
`, 20, CPY.sum);

// Recursion: fibonacci
await bench('fib(25)', `
def fib(n):
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)
fib(25)
`, 5, CPY.fib);

// List comprehension
await bench('list comp 10000', `
data = [i * 2 for i in range(10000)]
len(data)
`, 20, CPY.listcomp);

// Nested loops
await bench('nested loop 100x100', `
total = 0
for i in range(100):
    for j in range(100):
        total = total + i * j
total
`, 10, CPY.nested);

// String work
await bench('string concat 5000', `
s = ""
for i in range(5000):
    s = s + "x"
len(s)
`, 10, CPY.strcat);

// Mixed
await bench('fibonacci via memo', `
def fib_memo(n, memo):
    if n < 2:
        return n
    if n not in memo:
        memo[n] = fib_memo(n - 1, memo) + fib_memo(n - 2, memo)
    return memo[n]
fib_memo(30, {})
`, 20, CPY.memo);

// ──────────────────────────────────────────────────────────────────────
// Annotated variants — same workloads with type hints. Lets AIR specialise
// _py.add → raw +, _py.lt → raw <, etc. Only the cases where annotations
// can actually help (numeric arithmetic) — list comp and string concat
// don't change because their bottlenecks aren't typed binary ops.
// ──────────────────────────────────────────────────────────────────────

console.log('\n--- annotated variants ---');

await bench('sum 1..10000 [annotated]', `
total: int = 0
for i in range(10000):
    total = total + i
total
`, 20, CPY.sum);

await bench('fib(25) [annotated]', `
def fib(n: int) -> int:
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)
fib(25)
`, 5, CPY.fib);

await bench('nested loop 100x100 [annotated]', `
total: int = 0
for i in range(100):
    for j in range(100):
        total = total + i * j
total
`, 10, CPY.nested);

await bench('fibonacci via memo [annotated]', `
def fib_memo(n: int, memo) -> int:
    if n < 2:
        return n
    if n not in memo:
        memo[n] = fib_memo(n - 1, memo) + fib_memo(n - 2, memo)
    return memo[n]
fib_memo(30, {})
`, 20, CPY.memo);
