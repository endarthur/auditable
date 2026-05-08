// Tests for Soft → AIR → JS transpilation path.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { softParse } from '../ext/soft/src/parse.js';
import { softString } from '../ext/soft/src/eval.js';
import { lowerSoft, SoftLowerError } from '../ext/soft/src/air-lower.js';
import { runPasses } from '../ext/air/src/passes.js';
import { emitJS } from '../ext/air/src/emit-js.js';
import { _soft } from '../ext/soft/src/runtime.js';

async function runTranspile(code) {
  const output = [];
  const say = (v) => { output.push(v); return null; };
  const ast = softParse(code);
  const air = lowerSoft(ast, code);
  runPasses(air);
  const importNames = [...air.imports];
  const js = emitJS(air, importNames, [], { hinted: false, cellId: 'test' });
  const AF = Object.getPrototypeOf(async function(){}).constructor;
  const fn = new AF('_soft', ...importNames, js);
  const args = importNames.map(n => n === 'say' ? say : undefined);
  await fn(_soft, ...args);
  return { output, outputStr: output.map(v => typeof v === 'string' ? v : softString(v)).join('\n') };
}

describe('soft transpile — arithmetic', () => {
  it('integer add', async () => {
    const r = await runTranspile('set x to 1 + 2\nsay x');
    assert.deepEqual(r.output, [3]);
  });
  it('multiply', async () => {
    const r = await runTranspile('set x to 6 * 7\nsay x');
    assert.deepEqual(r.output, [42]);
  });
  it('division', async () => {
    const r = await runTranspile('set x to 10 / 4\nsay x');
    assert.deepEqual(r.output, [2.5]);
  });
  it('modulo', async () => {
    const r = await runTranspile('set x to 10 mod 3\nsay x');
    assert.deepEqual(r.output, [1]);
  });
});

describe('soft transpile — strings', () => {
  it('concat with &', async () => {
    const r = await runTranspile('set n to "world"\nsay "hello " & n');
    assert.deepEqual(r.output, ['hello world']);
  });
  it('juxtaposition', async () => {
    const r = await runTranspile('set x to 5\nsay "value: " x');
    assert.deepEqual(r.output, ['value: 5']);
  });
  it('length of', async () => {
    const r = await runTranspile('say length of "hello"');
    assert.deepEqual(r.output, [5]);
  });
});

describe('soft transpile — comparison and logic', () => {
  it('greater than', async () => {
    const r = await runTranspile('say 5 > 3');
    assert.deepEqual(r.output, [true]);
  });
  it('equal (case-insensitive strings)', async () => {
    const r = await runTranspile('say "Hello" is "hello"');
    assert.deepEqual(r.output, [true]);
  });
  it('and short-circuit', async () => {
    const r = await runTranspile('set x to true and "yes"\nsay x');
    assert.deepEqual(r.output, ['yes']);
  });
  it('or short-circuit', async () => {
    const r = await runTranspile('set x to false or "backup"\nsay x');
    assert.deepEqual(r.output, ['backup']);
  });
  it('between', async () => {
    const r = await runTranspile('set x to 5\nsay x between 1 and 10');
    assert.deepEqual(r.output, [true]);
  });
});

describe('soft transpile — control flow', () => {
  it('if / else', async () => {
    const r = await runTranspile('set x to 5\nif x > 3\n  say "big"\notherwise\n  say "small"\nend');
    assert.deepEqual(r.output, ['big']);
  });
  it('repeat N times', async () => {
    const r = await runTranspile('set t to 0\nrepeat 5 times\n  set t to t + 1\nend\nsay t');
    assert.deepEqual(r.output, [5]);
  });
  it('range loop', async () => {
    const r = await runTranspile('set t to 0\nrepeat from 1 to 10 as i\n  set t to t + i\nend\nsay t');
    assert.deepEqual(r.output, [55]);
  });
  it('range loop with step', async () => {
    const r = await runTranspile('set t to 0\nrepeat from 0 to 10 by 2 as i\n  set t to t + i\nend\nsay t');
    assert.deepEqual(r.output, [30]);
  });
  it('while loop', async () => {
    const r = await runTranspile('set n to 5\nrepeat while n > 0\n  set n to n - 1\nend\nsay n');
    assert.deepEqual(r.output, [0]);
  });
  it('repeat each in list', async () => {
    const r = await runTranspile('set lst to list 10, 20, 30\nset total to 0\nrepeat each x in lst\n  set total to total + x\nend\nsay total');
    assert.deepEqual(r.output, [60]);
  });
});

describe('soft transpile — functions', () => {
  it('define and call', async () => {
    const r = await runTranspile('define double takes x\n  return x * 2\nend\nsay call double 21');
    assert.deepEqual(r.output, [42]);
  });
  it('recursive', async () => {
    const r = await runTranspile('define fact takes n\n  if n <= 1\n    return 1\n  end\n  return n * call fact (n - 1)\nend\nsay call fact 5');
    assert.deepEqual(r.output, [120]);
  });
});

describe('soft transpile — collections', () => {
  it('list literal', async () => {
    const r = await runTranspile('set lst to list 1, 2, 3\nsay lst');
    assert.deepEqual(r.output, [[1, 2, 3]]);
  });
  it('length of list', async () => {
    const r = await runTranspile('set lst to list 1, 2, 3\nsay length of lst');
    assert.deepEqual(r.output, [3]);
  });
  it('record literal', async () => {
    const r = await runTranspile('set r to record x 10 y 20\nsay x of r');
    assert.deepEqual(r.output, [10]);
  });
});
