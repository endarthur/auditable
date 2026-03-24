import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// runtime.js has ZERO DOM dependencies — no document shim needed
import { createNotebook } from '../src/js/runtime.js';

describe('runtime: createNotebook', () => {
  it('creates a notebook', () => {
    const nb = createNotebook();
    assert.ok(nb);
    assert.equal(nb.cells.length, 0);
  });

  it('adds cells', () => {
    const nb = createNotebook();
    nb.addCell('code', 'const x = 1');
    nb.addCell('code', 'const y = 2');
    assert.equal(nb.cells.length, 2);
    assert.equal(nb.cells[0].type, 'code');
    assert.equal(nb.cells[0].code, 'const x = 1');
  });

  it('removes cells', () => {
    const nb = createNotebook();
    const cell = nb.addCell('code', 'const x = 1');
    nb.addCell('code', 'const y = 2');
    nb.removeCell(cell.id);
    assert.equal(nb.cells.length, 1);
  });
});

describe('runtime: run', () => {
  it('runs simple cells', async () => {
    const nb = createNotebook();
    nb.addCell('code', 'const x = 10');
    nb.addCell('code', 'const y = x * 2');
    const result = await nb.run();
    assert.equal(result.scope.x, 10);
    assert.equal(result.scope.y, 20);
  });

  it('propagates scope between cells', async () => {
    const nb = createNotebook();
    nb.addCell('code', 'const a = 3');
    nb.addCell('code', 'const b = 7');
    nb.addCell('code', 'const sum = a + b');
    const result = await nb.run();
    assert.equal(result.scope.sum, 10);
  });

  it('handles cell errors', async () => {
    const nb = createNotebook();
    nb.addCell('code', 'throw new Error("boom")');
    const result = await nb.run();
    assert.equal(result.cells[0].error, 'boom');
  });

  it('poisons downstream on error', async () => {
    const nb = createNotebook();
    nb.addCell('code', 'const x = bad_var');
    nb.addCell('code', 'const y = x + 1');
    const result = await nb.run();
    assert.ok(result.poisoned.has('x'));
    assert.equal(result.scope.y, undefined);
  });

  it('captures display output', async () => {
    const nb = createNotebook();
    nb.addCell('code', 'display("hello"); display(42)');
    const result = await nb.run();
    assert.deepEqual(result.cells[0].output, ['hello', 42]);
  });

  it('handles multiple defines', async () => {
    const nb = createNotebook();
    nb.addCell('code', 'const a = 1, b = 2');
    const result = await nb.run();
    assert.equal(result.scope.a, 1);
    assert.equal(result.scope.b, 2);
  });

  it('handles destructuring', async () => {
    const nb = createNotebook();
    nb.addCell('code', 'const { x, y } = { x: 10, y: 20 }');
    const result = await nb.run();
    assert.equal(result.scope.x, 10);
    assert.equal(result.scope.y, 20);
  });

  it('handles function declarations', async () => {
    const nb = createNotebook();
    nb.addCell('code', 'function add(a, b) { return a + b }');
    nb.addCell('code', 'const sum = add(3, 4)');
    const result = await nb.run();
    assert.equal(result.scope.sum, 7);
  });

  it('handles async code', async () => {
    const nb = createNotebook();
    nb.addCell('code', 'const x = await Promise.resolve(42)');
    const result = await nb.run();
    assert.equal(result.scope.x, 42);
  });

  it('respects manual cells', async () => {
    const nb = createNotebook();
    nb.addCell('code', '// %manual\nconst x = 1');
    const result = await nb.run();
    // manual cells are force-run in run() since all IDs are in dirtyIds
    assert.equal(result.scope.x, 1);
  });

  it('skips CSS cells', async () => {
    const nb = createNotebook();
    nb.addCell('code', 'const x = 1');
    nb.addCell('css', 'body { color: red }');
    nb.addCell('code', 'const y = x + 1');
    const result = await nb.run();
    assert.equal(result.scope.x, 1);
    assert.equal(result.scope.y, 2);
  });

  it('handles md cells', async () => {
    const nb = createNotebook();
    nb.addCell('md', '# Hello');
    const result = await nb.run();
    assert.equal(result.cells.length, 1);
  });

  it('handles empty notebook', async () => {
    const nb = createNotebook();
    const result = await nb.run();
    assert.deepEqual(result.scope, {});
    assert.deepEqual(result.cells, []);
  });
});

describe('runtime: loadTxt', () => {
  it('loads /// format', () => {
    const nb = createNotebook();
    const txt = `/// auditable
/// title: test

/// code
const x = 1

/// code
const y = x + 1
`;
    const meta = nb.loadTxt(txt);
    assert.equal(meta.title, 'test');
    assert.equal(nb.cells.length, 2);
    assert.equal(nb.cells[0].code, 'const x = 1');
    assert.equal(nb.cells[1].code, 'const y = x + 1');
  });

  it('loads and runs', async () => {
    const nb = createNotebook();
    nb.loadTxt(`/// auditable

/// code
const x = 10

/// code
const y = x * 3
`);
    const result = await nb.run();
    assert.equal(result.scope.y, 30);
  });

  it('handles collapsed flag', () => {
    const nb = createNotebook();
    nb.loadTxt(`/// auditable

/// code collapsed
const x = 1
`);
    assert.equal(nb.cells[0].collapsed, true);
  });

  it('handles module directives', () => {
    const nb = createNotebook();
    const meta = nb.loadTxt(`/// auditable
/// module: https://example.com/mod.js

/// code
const x = 1
`);
    assert.deepEqual(meta.moduleUrls, ['https://example.com/mod.js']);
  });
});

describe('runtime: loadHtml', () => {
  it('loads cells from HTML', () => {
    const cells = [{ type: 'code', code: 'const x = 1' }, { type: 'md', code: '# Hi' }];
    const html = `<title>Auditable \u2014 My NB</title><!--AUDITABLE-DATA\n${JSON.stringify(cells)}\nAUDITABLE-DATA-->`;
    const nb = createNotebook();
    const meta = nb.loadHtml(html);
    assert.equal(meta.title, 'My NB');
    assert.equal(nb.cells.length, 2);
    assert.equal(nb.cells[0].code, 'const x = 1');
  });

  it('loads and runs', async () => {
    const cells = [
      { type: 'code', code: 'const a = 5' },
      { type: 'code', code: 'const b = a * 4' },
    ];
    const html = `<!--AUDITABLE-DATA\n${JSON.stringify(cells)}\nAUDITABLE-DATA-->`;
    const nb = createNotebook();
    nb.loadHtml(html);
    const result = await nb.run();
    assert.equal(result.scope.b, 20);
  });
});

describe('runtime: serialize', () => {
  it('serializes cells', () => {
    const nb = createNotebook();
    nb.addCell('code', 'const x = 1');
    nb.addCell('md', '# Hello');
    const data = nb.serialize();
    assert.equal(data.length, 2);
    assert.equal(data[0].type, 'code');
    assert.equal(data[0].code, 'const x = 1');
    assert.equal(data[1].type, 'md');
  });
});

describe('runtime: toTxt', () => {
  it('round-trips through txt', async () => {
    const nb1 = createNotebook();
    nb1.addCell('code', 'const x = 10');
    nb1.addCell('code', 'const y = x + 5');
    const txt = nb1.toTxt('test');

    const nb2 = createNotebook();
    nb2.loadTxt(txt);
    const result = await nb2.run();
    assert.equal(result.scope.x, 10);
    assert.equal(result.scope.y, 15);
  });
});

describe('runtime: error isolation', () => {
  it('cells after error still run if independent', async () => {
    const nb = createNotebook();
    nb.addCell('code', 'const x = bad_var'); // errors
    nb.addCell('code', 'const y = 42');       // independent — should run
    const result = await nb.run();
    assert.equal(result.scope.y, 42);
    assert.ok(result.cells[0].error);
    assert.equal(result.cells[1].error, null);
  });

  it('chained errors propagate', async () => {
    const nb = createNotebook();
    nb.addCell('code', 'const x = bad_var');   // errors
    nb.addCell('code', 'const y = x + 1');     // depends on x — blocked
    nb.addCell('code', 'const z = y + 1');     // depends on y — blocked
    const result = await nb.run();
    assert.ok(result.poisoned.has('x'));
    assert.ok(result.poisoned.has('y'));
    assert.equal(result.scope.z, undefined);
  });
});

describe('runtime: std injection', () => {
  it('std is available in cells', async () => {
    const nb = createNotebook();
    nb.addCell('code', 'const s = std.sum([1, 2, 3])');
    const result = await nb.run();
    assert.equal(result.scope.s, 6);
  });

  it('std.csv parses data', async () => {
    const nb = createNotebook();
    nb.addCell('code', `const data = std.csv("a,b\\n1,2\\n3,4", { typed: true })`);
    nb.addCell('code', 'const total = std.sum(data, d => d.a)');
    const result = await nb.run();
    assert.equal(result.scope.total, 4);
  });

  it('std.linspace generates array', async () => {
    const nb = createNotebook();
    nb.addCell('code', 'const arr = std.linspace(0, 1, 5)');
    const result = await nb.run();
    assert.equal(result.scope.arr.length, 5);
    assert.equal(result.scope.arr[0], 0);
    assert.equal(result.scope.arr[4], 1);
  });

  it('std.color works', async () => {
    const nb = createNotebook();
    nb.addCell('code', `const c = std.color('#ff0000')`);
    nb.addCell('code', 'const r = c.r');
    const result = await nb.run();
    assert.equal(result.scope.r, 255);
  });
});

describe('runtime: load / modules', () => {
  it('load(@std) returns std', async () => {
    const nb = createNotebook();
    nb.addCell('code', 'const { sum } = await load("@std")');
    nb.addCell('code', 'const s = sum([10, 20, 30])');
    const result = await nb.run();
    assert.equal(result.scope.s, 60);
  });

  it('load custom module from registry', async () => {
    const myLib = { greet: (name) => `hello ${name}` };
    const nb = createNotebook({ modules: { 'my-lib': myLib } });
    nb.addCell('code', 'const lib = await load("my-lib")');
    nb.addCell('code', 'const msg = lib.greet("world")');
    const result = await nb.run();
    assert.equal(result.scope.msg, 'hello world');
  });

  it('load with custom fallback loader', async () => {
    const nb = createNotebook({
      load: async (url) => {
        if (url === 'dynamic://math') return { double: x => x * 2 };
        throw new Error('not found');
      },
    });
    nb.addCell('code', 'const m = await load("dynamic://math")');
    nb.addCell('code', 'const y = m.double(21)');
    const result = await nb.run();
    assert.equal(result.scope.y, 42);
  });

  it('load throws for unknown module without fallback', async () => {
    const nb = createNotebook();
    nb.addCell('code', 'const m = await load("nonexistent")');
    const result = await nb.run();
    assert.ok(result.cells[0].error);
    assert.ok(result.cells[0].error.includes('headless'));
  });

  it('install delegates to load', async () => {
    const nb = createNotebook({ modules: { 'test-mod': { x: 99 } } });
    nb.addCell('code', 'const m = await install("test-mod")');
    nb.addCell('code', 'const v = m.x');
    const result = await nb.run();
    assert.equal(result.scope.v, 99);
  });

  it('modules are cached across cells', async () => {
    let loadCount = 0;
    const nb = createNotebook({
      load: async () => { loadCount++; return { val: 1 }; },
    });
    nb.addCell('code', 'const a = await load("x")');
    nb.addCell('code', 'const b = await load("x")');
    const result = await nb.run();
    assert.equal(loadCount, 1); // second call hits cache
  });
});

describe('runtime: plugin cell types', () => {
  it('executes plugin cells with cellTypes option', async () => {
    const mockPlugin = {
      parseNames: (code) => {
        const m = code.match(/^(\w+)\s*=/);
        return m ? new Set([m[1]]) : new Set();
      },
      findUses: (code, allDefined) => {
        const uses = new Set();
        const idRe = /\b([a-zA-Z_$]\w*)\b/g;
        let m;
        while ((m = idRe.exec(code))) {
          if (allDefined.has(m[1])) uses.add(m[1]);
        }
        return uses;
      },
      execute: async (code, upstream) => {
        // simple "name = expr" evaluator
        const m = code.match(/^(\w+)\s*=\s*(.+)$/);
        if (!m) return { defines: {} };
        const fn = new Function(...Object.keys(upstream), `return (${m[2]})`);
        const val = fn(...Object.values(upstream));
        return { defines: { [m[1]]: val } };
      },
    };

    const nb = createNotebook({ cellTypes: { calc: mockPlugin } });
    nb.addCell('code', 'const x = 10');
    nb.addCell('calc', 'y = x * 3');
    nb.addCell('code', 'const z = y + 1');
    const result = await nb.run();
    assert.equal(result.scope.x, 10);
    assert.equal(result.scope.y, 30);
    assert.equal(result.scope.z, 31);
  });

  it('plugin errors propagate to downstream', async () => {
    const failPlugin = {
      parseNames: () => new Set(['val']),
      execute: async () => { throw new Error('plugin failed'); },
    };

    const nb = createNotebook({ cellTypes: { fail: failPlugin } });
    nb.addCell('fail', 'val = 1');
    nb.addCell('code', 'const y = val + 1');
    const result = await nb.run();
    assert.ok(result.poisoned.has('val'));
    assert.equal(result.scope.y, undefined);
  });

  it('plugin cells without handler are skipped as fallback', async () => {
    const nb = createNotebook(); // no cellTypes
    nb.addCell('unknown', 'something');
    nb.addCell('code', 'const x = 1');
    const result = await nb.run();
    assert.equal(result.scope.x, 1);
  });
});
