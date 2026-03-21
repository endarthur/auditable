import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── shared MicroPython instance ──
const { loadMicroPython } = await import('../ext/adder/micropython.mjs');
const stdoutLines = [];
const mp = await loadMicroPython({ stdout: s => stdoutLines.push(s), stderr: () => {} });

// ── 1. BRIDGE_PY bootstrap (the real string, not a copy) ──

describe('BRIDGE_PY bootstrap', () => {
  it('loads and makes _exec_cell available', async () => {
    const { BRIDGE_PY } = await import('../ext/adder/src/bridge.js');
    assert.ok(BRIDGE_PY.includes('_exec_cell'));

    mp.runPython(BRIDGE_PY);

    // verify _exec_cell works
    mp.globals.set('_code', 'x = 42');
    mp.runPython('_ns = {}; _r = _exec_cell(_code, _ns)');
    assert.strictEqual(mp.globals.get('_r'), null);
    mp.runPython('_check = _ns["x"]');
    assert.strictEqual(mp.globals.get('_check'), 42);
  });

  it('_exec_cell detects last expression via compile()', () => {
    mp.globals.set('_code', 'a = 5\na * 3');
    mp.runPython('_ns = {}; _r = _exec_cell(_code, _ns)');
    assert.strictEqual(mp.globals.get('_r'), 15);
  });

  it('_exec_cell returns None for assignment', () => {
    mp.globals.set('_code', 'x = 99');
    mp.runPython('_ns = {}; _r = _exec_cell(_code, _ns)');
    assert.strictEqual(mp.globals.get('_r'), null);
  });

  it('_exec_cell handles indented last line (not expression)', () => {
    mp.globals.set('_code', 'if True:\n    x = 1');
    mp.runPython('_ns = {}; _r = _exec_cell(_code, _ns)');
    assert.strictEqual(mp.globals.get('_r'), null);
  });

  it('_exec_cell handles empty and comment-only code', () => {
    mp.globals.set('_code', '');
    mp.runPython('_ns = {}; _r = _exec_cell(_code, _ns)');
    assert.strictEqual(mp.globals.get('_r'), null);

    mp.globals.set('_code', '# just a comment');
    mp.runPython('_ns = {}; _r = _exec_cell(_code, _ns)');
    assert.strictEqual(mp.globals.get('_r'), null);
  });

  it('_exec_cell: expression after function definition', () => {
    mp.globals.set('_code', 'def f(x):\n    return x * 2\nf(21)');
    mp.runPython('_ns = {}; _r = _exec_cell(_code, _ns)');
    assert.strictEqual(mp.globals.get('_r'), 42);
  });

  it('_exec_cell: trailing comments after expression', () => {
    mp.globals.set('_code', 'x = 5\nx * 2\n# comment');
    mp.runPython('_ns = {}; _r = _exec_cell(_code, _ns)');
    assert.strictEqual(mp.globals.get('_r'), 10);
  });
});

// ── 2. registerJsModule — import JS extensions from Python ──

describe('registerJsModule (extension imports)', () => {
  it('imports a registered JS module from Python', () => {
    mp.registerJsModule('mockext', {
      add: (a, b) => a + b,
      PI: 3.14159,
    });

    mp.runPython('import mockext');
    mp.runPython('_result = mockext.add(2, 3)');
    assert.strictEqual(mp.globals.get('_result'), 5);
    mp.runPython('_result = mockext.PI');
    assert.ok(Math.abs(mp.globals.get('_result') - 3.14159) < 0.0001);
  });

  it('raises ImportError for unregistered modules', () => {
    assert.throws(() => {
      mp.runPython('import nonexistent_module_xyz');
    }, /no module named/i);
  });

  it('caches imported module in sys.modules', () => {
    mp.runPython('import sys; _cached = "mockext" in sys.modules');
    assert.strictEqual(mp.globals.get('_cached'), true);
  });

  it('works inside _exec_cell namespace', () => {
    mp.runPython('_ns = {}');
    mp.globals.set('_code', 'import mockext\nresult = mockext.add(10, 20)');
    mp.runPython('_exec_cell(_code, _ns)');
    mp.runPython('_check = _ns["result"]');
    assert.strictEqual(mp.globals.get('_check'), 30);
  });

  it('extension with callable functions via FFI', () => {
    mp.registerJsModule('mathext', {
      square: (x) => x * x,
      cube: (x) => x * x * x,
    });

    mp.runPython('import mathext; _r = mathext.square(7)');
    assert.strictEqual(mp.globals.get('_r'), 49);
    mp.runPython('_r = mathext.cube(3)');
    assert.strictEqual(mp.globals.get('_r'), 27);
  });

  it('_auditableExtensions registration pattern', () => {
    // simulate what initInterpreter does
    const exts = { testlib: { greet: (name) => 'hi ' + name } };
    for (const name of Object.keys(exts)) {
      mp.registerJsModule(name, exts[name]);
    }
    mp.runPython('import testlib; _r = testlib.greet("world")');
    assert.strictEqual(mp.globals.get('_r'), 'hi world');
  });
});

// ── 3. pythonExecute patterns (JS-side execution wrapper) ──

describe('pythonExecute patterns', () => {
  it('builds namespace from upstream scope', () => {
    mp.runPython('_adder_ns = {}');
    const scopeIn = { x: 10, name: 'hello' };
    for (const [k, v] of Object.entries(scopeIn)) {
      mp.globals.set('_adder_inject_v', v);
      mp.runPython(`_adder_ns["${k}"] = _adder_inject_v`);
    }
    mp.globals.delete('_adder_inject_v');

    mp.runPython('_check = _adder_ns["x"]');
    assert.strictEqual(mp.globals.get('_check'), 10);
    mp.runPython('_check = _adder_ns["name"]');
    assert.strictEqual(mp.globals.get('_check'), 'hello');
    mp.globals.delete('_adder_ns');
  });

  it('executes code and extracts defines', async () => {
    const { pythonParseNames } = await import('../ext/adder/src/cell.js');

    mp.runPython('_adder_ns = {}');
    mp.globals.set('_adder_inject_v', 10);
    mp.runPython('_adder_ns["upstream"] = _adder_inject_v');

    mp.globals.set('_adder_code', 'result = upstream * 3');
    mp.runPython('_exec_cell(_adder_code, _adder_ns)');

    const defines = {};
    const cellDefines = pythonParseNames('result = upstream * 3');
    for (const name of cellDefines) {
      mp.runPython(`_adder_extract = _adder_ns.get("${name}", None)`);
      const val = mp.globals.get('_adder_extract');
      if (val !== undefined && val !== null) defines[name] = val;
    }

    assert.strictEqual(defines.result, 30);
    mp.globals.delete('_adder_ns');
    mp.globals.delete('_adder_code');
    mp.globals.delete('_adder_extract');
    mp.globals.delete('_adder_inject_v');
  });

  it('returns last expression separately from defines', () => {
    mp.runPython('_adder_ns = {}');
    mp.globals.set('_adder_code', 'x = 5\nx + 10');
    mp.runPython('_adder_result = _exec_cell(_adder_code, _adder_ns)');
    assert.strictEqual(mp.globals.get('_adder_result'), 15);

    mp.runPython('_adder_extract = _adder_ns.get("x", None)');
    assert.strictEqual(mp.globals.get('_adder_extract'), 5);

    mp.globals.delete('_adder_ns');
    mp.globals.delete('_adder_code');
    mp.globals.delete('_adder_extract');
    mp.globals.delete('_adder_result');
  });

  it('cleans up globals after execution', () => {
    mp.runPython('_adder_ns = {}');
    mp.globals.set('_adder_code', 'y = 1');
    mp.runPython('_exec_cell(_adder_code, _adder_ns)');
    mp.globals.delete('_adder_ns');
    mp.globals.delete('_adder_code');

    mp.runPython('_cleanup_check = "_adder_ns" not in dir()');
    assert.strictEqual(mp.globals.get('_cleanup_check'), true);
  });

  it('handles errors without leaking namespace', () => {
    mp.runPython('_adder_ns = {"a": 1}');
    mp.globals.set('_adder_code', '1/0');
    try { mp.runPython('_exec_cell(_adder_code, _adder_ns)'); } catch {}

    mp.runPython('_check = _adder_ns.get("a", -1)');
    assert.strictEqual(mp.globals.get('_check'), 1);
    mp.globals.delete('_adder_ns');
    mp.globals.delete('_adder_code');
  });

  it('function defines are extractable and callable', () => {
    mp.runPython('_adder_ns = {}');
    mp.globals.set('_adder_code', 'def greet(name):\n    return "hi " + name');
    mp.runPython('_exec_cell(_adder_code, _adder_ns)');

    mp.runPython('_adder_extract = _adder_ns.get("greet", None)');
    const fn = mp.globals.get('_adder_extract');
    assert.ok(fn !== null && fn !== undefined);

    mp.globals.set('_test_fn', fn);
    mp.runPython('_call_result = _test_fn("world")');
    assert.strictEqual(mp.globals.get('_call_result'), 'hi world');

    mp.globals.delete('_adder_ns');
    mp.globals.delete('_adder_code');
    mp.globals.delete('_adder_extract');
    mp.globals.delete('_test_fn');
  });

  it('multiple upstream values', () => {
    mp.runPython('_adder_ns = {}');
    for (const [k, v] of Object.entries({ a: 1, b: 2, c: 3 })) {
      mp.globals.set('_adder_inject_v', v);
      mp.runPython(`_adder_ns["${k}"] = _adder_inject_v`);
    }
    mp.globals.set('_adder_code', 'total = a + b + c');
    mp.runPython('_exec_cell(_adder_code, _adder_ns)');
    mp.runPython('_adder_extract = _adder_ns.get("total", None)');
    assert.strictEqual(mp.globals.get('_adder_extract'), 6);

    mp.globals.delete('_adder_ns');
    mp.globals.delete('_adder_code');
    mp.globals.delete('_adder_extract');
    mp.globals.delete('_adder_inject_v');
  });
});

// ── 4. mpy tagged template patterns ──

describe('mpy tagged template patterns', () => {
  it('basic execution returns namespace', () => {
    mp.runPython('_adder_ns = {}');
    mp.globals.set('_adder_code', 'x = 42\ny = x + 8');
    mp.runPython('_exec_cell(_adder_code, _adder_ns)');

    mp.runPython('import json as _adder_json; _adder_keys = _adder_json.dumps([k for k in _adder_ns if not k.startswith("_")])');
    const keys = JSON.parse(mp.globals.get('_adder_keys'));
    assert.ok(keys.includes('x'));
    assert.ok(keys.includes('y'));

    const result = {};
    for (const k of keys) {
      mp.runPython(`_adder_extract = _adder_ns["${k}"]`);
      result[k] = mp.globals.get('_adder_extract');
    }
    assert.strictEqual(result.x, 42);
    assert.strictEqual(result.y, 50);

    mp.globals.delete('_adder_ns');
    mp.globals.delete('_adder_code');
    mp.globals.delete('_adder_keys');
    mp.globals.delete('_adder_extract');
  });

  it('interpolation injects values as _v0, _v1', () => {
    mp.runPython('_adder_ns = {}');
    mp.globals.set('_adder_inject_v', 10);
    mp.runPython('_adder_ns["_v0"] = _adder_inject_v');
    mp.globals.set('_adder_inject_v', 20);
    mp.runPython('_adder_ns["_v1"] = _adder_inject_v');

    mp.globals.set('_adder_code', 'result = _v0 + _v1');
    mp.runPython('_exec_cell(_adder_code, _adder_ns)');

    mp.runPython('_adder_keys = _adder_json.dumps([k for k in _adder_ns if not k.startswith("_")])');
    const keys = JSON.parse(mp.globals.get('_adder_keys'));
    assert.deepStrictEqual(keys, ['result']);

    mp.runPython('_adder_extract = _adder_ns["result"]');
    assert.strictEqual(mp.globals.get('_adder_extract'), 30);

    mp.globals.delete('_adder_ns');
    mp.globals.delete('_adder_code');
    mp.globals.delete('_adder_keys');
    mp.globals.delete('_adder_extract');
    mp.globals.delete('_adder_inject_v');
  });

  it('filters out _-prefixed names from result', () => {
    mp.runPython('_adder_ns = {}');
    mp.globals.set('_adder_code', '_private = 1\npublic = 2\n__dunder = 3');
    mp.runPython('_exec_cell(_adder_code, _adder_ns)');

    mp.runPython('_adder_keys = _adder_json.dumps([k for k in _adder_ns if not k.startswith("_")])');
    const keys = JSON.parse(mp.globals.get('_adder_keys'));
    assert.deepStrictEqual(keys, ['public']);

    mp.globals.delete('_adder_ns');
    mp.globals.delete('_adder_code');
    mp.globals.delete('_adder_keys');
  });

  it('string interpolation', () => {
    mp.runPython('_adder_ns = {}');
    mp.globals.set('_adder_inject_v', 'world');
    mp.runPython('_adder_ns["_v0"] = _adder_inject_v');
    mp.globals.set('_adder_code', 'msg = "hello " + _v0');
    mp.runPython('_exec_cell(_adder_code, _adder_ns)');

    mp.runPython('_adder_extract = _adder_ns["msg"]');
    assert.strictEqual(mp.globals.get('_adder_extract'), 'hello world');

    mp.globals.delete('_adder_ns');
    mp.globals.delete('_adder_code');
    mp.globals.delete('_adder_extract');
    mp.globals.delete('_adder_inject_v');
  });

  it('function definition extractable from mpy result', () => {
    mp.runPython('_adder_ns = {}');
    mp.globals.set('_adder_code', 'def double(x):\n    return x * 2');
    mp.runPython('_exec_cell(_adder_code, _adder_ns)');

    mp.runPython('_adder_keys = _adder_json.dumps([k for k in _adder_ns if not k.startswith("_")])');
    const keys = JSON.parse(mp.globals.get('_adder_keys'));
    assert.ok(keys.includes('double'));

    mp.runPython('_adder_extract = _adder_ns["double"]');
    const fn = mp.globals.get('_adder_extract');
    mp.globals.set('_test_fn', fn);
    mp.runPython('_test_result = _test_fn(21)');
    assert.strictEqual(mp.globals.get('_test_result'), 42);

    mp.globals.delete('_adder_ns');
    mp.globals.delete('_adder_code');
    mp.globals.delete('_adder_keys');
    mp.globals.delete('_adder_extract');
    mp.globals.delete('_test_fn');
  });
});

// ── 5. stdout buffering ──

describe('stdout buffering', () => {
  it('captures print output via callback', () => {
    const before = stdoutLines.length;
    mp.runPython('print("stdout_test_1")');
    assert.ok(stdoutLines.slice(before).includes('stdout_test_1'));
  });

  it('captures print inside _exec_cell', () => {
    const before = stdoutLines.length;
    mp.runPython('_ns = {}');
    mp.globals.set('_code', 'print("from_exec_cell")');
    mp.runPython('_exec_cell(_code, _ns)');
    assert.ok(stdoutLines.slice(before).includes('from_exec_cell'));
  });

  it('captures multiple prints in order', () => {
    const before = stdoutLines.length;
    mp.runPython('for i in range(3): print(i)');
    assert.deepStrictEqual(stdoutLines.slice(before), ['0', '1', '2']);
  });
});

// ── 5b. pythonExecute output assembly ──

describe('output assembly (stdout + last expr)', () => {
  // simulate the output assembly logic from pythonExecute

  function simulateExecute(code, scopeIn = {}) {
    // drain
    stdoutLines.length = 0;

    // inject upstream
    mp.runPython('_adder_ns = {}');
    for (const [k, v] of Object.entries(scopeIn)) {
      mp.globals.set('_adder_inject_v', v);
      mp.runPython(`_adder_ns["${k}"] = _adder_inject_v`);
    }
    if (Object.keys(scopeIn).length) {
      try { mp.globals.delete('_adder_inject_v'); } catch {}
    }

    // execute
    const before = stdoutLines.length;
    mp.globals.set('_adder_code', code);
    mp.runPython('_adder_result = _exec_cell(_adder_code, _adder_ns)');
    const lastExpr = mp.globals.get('_adder_result');

    // collect stdout captured during execution
    const stdout = stdoutLines.slice(before);

    // assemble output (same logic as pythonExecute)
    const parts = [];
    if (stdout.length) parts.push(stdout.join('\n'));
    if (lastExpr !== undefined && lastExpr !== null) parts.push(String(lastExpr));
    const output = parts.length ? parts.join('\n') : undefined;

    // extract defines
    const { pythonParseNames } = { pythonParseNames: (code) => {
      // inline minimal version for test
      const defines = new Set();
      for (const line of code.split('\n')) {
        if (!line || line[0] === ' ' || line[0] === '\t') continue;
        const m = line.match(/^([a-zA-Z_]\w*)\s*=/);
        if (m) defines.add(m[1]);
        const dm = line.match(/^def\s+(\w+)/);
        if (dm) defines.add(dm[1]);
      }
      return defines;
    }};

    const defines = {};
    for (const name of pythonParseNames(code)) {
      mp.runPython(`_adder_extract = _adder_ns.get("${name}", None)`);
      const val = mp.globals.get('_adder_extract');
      if (val !== undefined && val !== null) defines[name] = val;
    }

    try { mp.globals.delete('_adder_ns'); } catch {}
    try { mp.globals.delete('_adder_code'); } catch {}
    try { mp.globals.delete('_adder_result'); } catch {}
    try { mp.globals.delete('_adder_extract'); } catch {}

    return { defines, output };
  }

  it('print only → output is stdout text', () => {
    const { output } = simulateExecute('print("hello")\nprint("world")');
    assert.strictEqual(output, 'hello\nworld');
  });

  it('last expr only → output is expression value', () => {
    const { output } = simulateExecute('x = 5\nx + 10');
    assert.strictEqual(output, '15');
  });

  it('print + last expr → both in output', () => {
    const { output } = simulateExecute('print("log")\n42');
    assert.ok(output.includes('log'));
    assert.ok(output.includes('42'));
  });

  it('assignment only → no output', () => {
    const { output } = simulateExecute('x = 42');
    assert.strictEqual(output, undefined);
  });

  it('defines are extracted alongside output', () => {
    const { defines, output } = simulateExecute('x = 10\nx * 2');
    assert.strictEqual(defines.x, 10);
    assert.strictEqual(output, '20');
  });
});

// ── 5c. async execution (top-level await) ──

describe('async execution (top-level await)', () => {
  // simulate the async path from pythonExecute: wrap in async def with
  // global declarations, exec with ns as globals, await — isolated, no __main__

  async function execAsync(code, scopeIn = {}) {
    const { pythonParseNames } = await import('../ext/adder/src/cell.js');

    mp.runPython('_adder_ns = {}');
    for (const [k, v] of Object.entries(scopeIn)) {
      mp.globals.set('_adder_inject_v', v);
      mp.runPython(`_adder_ns["${k}"] = _adder_inject_v`);
    }
    try { mp.globals.delete('_adder_inject_v'); } catch {}

    const defines = [...pythonParseNames(code)];
    mp.globals.set('_adder_defines', defines);
    mp.globals.set('_adder_code', code);

    // inject sys.modules into ns so imports resolve
    mp.runPython('import sys as _adder_sys');
    mp.runPython('for _m in _adder_sys.modules: _adder_ns.setdefault(_m, _adder_sys.modules[_m])');

    // build and exec the async wrapper
    mp.runPython('_adder_wrapper = _build_async_wrapper(_adder_code, _adder_defines)');
    mp.runPython('exec(compile(_adder_wrapper, "<cell>", "exec"), _adder_ns)');

    // await the wrapper
    await mp.runPythonAsync('await _adder_ns["_adder_cell"]()');

    // extract last expression
    mp.runPython('_adder_result = _adder_ns.get("_adder_last_expr", None)');
    const lastExpr = mp.globals.get('_adder_result');

    // verify __main__ is clean
    for (const name of defines) {
      mp.runPython(`_adder_check = "${name}" not in dir()`);
      if (!mp.globals.get('_adder_check')) {
        throw new Error(`${name} leaked into __main__`);
      }
    }

    // clean up
    try { mp.globals.delete('_adder_ns'); } catch {}
    try { mp.globals.delete('_adder_code'); } catch {}
    try { mp.globals.delete('_adder_defines'); } catch {}
    try { mp.globals.delete('_adder_result'); } catch {}
    try { mp.globals.delete('_adder_wrapper'); } catch {}
    try { mp.globals.delete('_adder_check'); } catch {}

    return lastExpr;
  }

  it('resolves a JS Promise via await', async () => {
    const r = await execAsync('import js\nresult = await js.globalThis.Promise.resolve(42)\nresult');
    assert.strictEqual(r, 42);
  });

  it('await with upstream scope', async () => {
    const r = await execAsync('import js\nx = await js.globalThis.Promise.resolve(base + 5)\nx', { base: 100 });
    assert.strictEqual(r, 105);
  });

  it('await with last expression', async () => {
    const r = await execAsync('import js\nval = await js.globalThis.Promise.resolve(7)\nval * 2');
    assert.strictEqual(r, 14);
  });

  it('await without last expression', async () => {
    const r = await execAsync('import js\nx = await js.globalThis.Promise.resolve(99)');
    assert.strictEqual(r, null);
  });

  it('print + await', async () => {
    const before = stdoutLines.length;
    const r = await execAsync('print("before")\nimport js\nval = await js.globalThis.Promise.resolve(3)\nprint("after")\nval');
    assert.strictEqual(r, 3);
    const captured = stdoutLines.slice(before);
    assert.ok(captured.includes('before'));
    assert.ok(captured.includes('after'));
  });
});

// ── 6. FFI marshalling ──

describe('FFI marshalling', () => {
  it('number roundtrip', () => {
    mp.globals.set('_ffi', 3.14);
    mp.runPython('_ffi_out = _ffi * 2');
    assert.ok(Math.abs(mp.globals.get('_ffi_out') - 6.28) < 0.001);
  });

  it('string roundtrip', () => {
    mp.globals.set('_ffi', 'hello');
    mp.runPython('_ffi_out = _ffi + " world"');
    assert.strictEqual(mp.globals.get('_ffi_out'), 'hello world');
  });

  it('boolean roundtrip', () => {
    mp.globals.set('_ffi', true);
    mp.runPython('_ffi_out = not _ffi');
    assert.strictEqual(mp.globals.get('_ffi_out'), false);
  });

  it('null to None', () => {
    mp.globals.set('_ffi', null);
    mp.runPython('_ffi_out = _ffi is None');
    assert.strictEqual(mp.globals.get('_ffi_out'), true);
  });

  it('Python int to JS number', () => {
    mp.runPython('_ffi_out = 2 ** 20');
    assert.strictEqual(mp.globals.get('_ffi_out'), 1048576);
  });

  it('JS object properties accessible from Python', () => {
    globalThis._testObj = { x: 10, y: 20 };
    mp.runPython('import js; _ffi_out = js.globalThis._testObj.x + js.globalThis._testObj.y');
    assert.strictEqual(mp.globals.get('_ffi_out'), 30);
    delete globalThis._testObj;
  });
});

// ── 7. error handling ──

describe('error handling', () => {
  it('SyntaxError', () => {
    assert.throws(() => mp.runPython('def'), /SyntaxError/);
  });

  it('NameError', () => {
    assert.throws(() => mp.runPython('print(undef_xyz)'), /NameError/);
  });

  it('TypeError', () => {
    assert.throws(() => mp.runPython('"a" + 1'), /TypeError/);
  });

  it('ZeroDivisionError', () => {
    assert.throws(() => mp.runPython('1/0'), /ZeroDivisionError/);
  });

  it('interpreter recovers after error', () => {
    try { mp.runPython('1/0'); } catch {}
    mp.runPython('_recovery = 42');
    assert.strictEqual(mp.globals.get('_recovery'), 42);
  });
});

// ── 8. namespace isolation ──

describe('namespace isolation', () => {
  it('cell namespaces are independent', () => {
    mp.runPython('_ns1 = {}');
    mp.globals.set('_code', 'x = 1');
    mp.runPython('_exec_cell(_code, _ns1)');
    mp.runPython('_ns2 = {}');
    mp.globals.set('_code', 'y = 2');
    mp.runPython('_exec_cell(_code, _ns2)');
    mp.runPython('_iso = "y" not in _ns1 and "x" not in _ns2');
    assert.strictEqual(mp.globals.get('_iso'), true);
  });

  it('sys.modules persists across cells', () => {
    mp.runPython('_ns1 = {}');
    mp.globals.set('_code', 'import sys');
    mp.runPython('_exec_cell(_code, _ns1)');
    mp.runPython('_ns2 = {}');
    mp.globals.set('_code', 'import sys; p = sys.platform');
    mp.runPython('_exec_cell(_code, _ns2)');
    mp.runPython('_has_p = "p" in _ns2');
    assert.strictEqual(mp.globals.get('_has_p'), true);
  });
});
