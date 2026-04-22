# @gcu/adder

Python-in-JavaScript. AST parser + tree-walking evaluator in pure JS, no WASM. A full Python dialect (classes, decorators, generators, try/except, comprehensions, async/await, import machinery) implemented as a regular JS library — values pass between Python and JS without any FFI boundary.

Ships with an optional AIR-transpilation fast path (`@gcu/adder/air`) that compiles adder source to V8-hinted JavaScript via [@gcu/air](https://www.npmjs.com/package/@gcu/air), typically 15–300× faster than the tree-walker on numeric workloads.

Originally built for [Auditable](https://github.com/endarthur/auditable) notebooks; usable as a standalone library anywhere ESM runs — browsers, Node, workers, Deno.

Pre-1.0 — APIs may change on minor version bumps.

## Install

```sh
npm install @gcu/adder

# optional: install @gcu/air for the fast-path transpiler
npm install @gcu/air
```

## Quick start

```js
import { run } from '@gcu/adder';

const scope = await run(`
  def fib(n):
      return n if n < 2 else fib(n-1) + fib(n-2)

  answer = fib(10)
`);

console.log(scope.answer);   // 55
console.log(scope.fib);      // [AsyncFunction: fib]
```

For 15–300× faster execution, the same program through the AIR transpile path:

```js
import { run } from '@gcu/adder/air';

const scope = await run(code);  // identical API
```

## API

All four functions share the same options shape and exist in both `@gcu/adder` (tree-walker) and `@gcu/adder/air` (AIR-transpile).

### `run(code, opts?): Promise<scope>`

Execute adder source as a module. Returns an object mapping bound names to values.

### `evalExpr(code, opts?): Promise<value>`

Evaluate a single adder expression and return its value. Useful for REPL expression-mode or embedding Python expressions in other workflows.

```js
await evalExpr('sum(range(10))')         // 45
await evalExpr('"hello".upper()')        // "HELLO"
```

### `compile(code)`

Parse the source once, reuse for many executions. The AIR path additionally caches the emitted JavaScript.

```js
import { compile } from '@gcu/adder/air';

const m = await compile(`result = base ** exp`);
m.imports;                                       // ['base', 'exp']
(await m.run({ globals: { base: 2, exp: 10 } })).result;    // 1024
(await m.run({ globals: { base: 3, exp: 5 } })).result;     // 243
```

### `isIncomplete(code)`

True if the parser would want more input (unclosed bracket, missing block body, trailing comma). REPLs use this to decide whether to keep reading.

```js
isIncomplete('def foo():')            // true  — body is missing
isIncomplete('def foo():\n  pass')    // false
isIncomplete('(1 + 2')                // true  — unclosed paren
isIncomplete('1 + 2')                 // false
```

## Options

```ts
{
  // Bindings (Python exec() style)
  globals?: Record<string, unknown>    // lowest precedence
  locals?:  Record<string, unknown>    // higher precedence than globals

  // IO hooks
  print?:   (...args) => void           // override print() (gets raw args)
  stdout?:  (s: string) => void         // where default print writes
  stderr?:  (s: string) => void
  stdin?:   () => string | null | Promise<string | null>   // next line for input()
  input?:   (prompt?) => string | Promise<string>          // override input() entirely

  // Filesystem
  vfs?:     VFSLike                     // @gcu/vfs-shaped object for open(), os, pathlib
}
```

Name resolution order: `locals` → `globals` → adder builtins (print, input, len, range, int, str, etc.) → NameError.

## Usage patterns

### Script runner

```js
import { run } from '@gcu/adder/air';
import { readFile } from 'node:fs/promises';
import readline from 'node:readline';

// Line-by-line stdin reader, returns null on EOF.
const rl = readline.createInterface({ input: process.stdin });
const buffered = [];
let resolveNext = null;
let closed = false;
rl.on('line',  line => resolveNext ? (resolveNext(line), resolveNext = null) : buffered.push(line));
rl.on('close', ()   => { closed = true; if (resolveNext) { resolveNext(null); resolveNext = null; } });
const nextLine = () => buffered.length ? Promise.resolve(buffered.shift())
                     : closed         ? Promise.resolve(null)
                                      : new Promise(r => { resolveNext = r; });

const script = await readFile(process.argv[2], 'utf8');
await run(script, {
  stdin:  nextLine,
  stdout: s => process.stdout.write(s),
  stderr: s => process.stderr.write(s),
  globals: {
    sys: { argv: process.argv.slice(2) },
  },
});
rl.close();
```

### Capturing output (tests, server-side rendering)

```js
const lines = [];
await run(`
  print("hello")
  for i in range(3):
      print(i * i)
`, {
  stdout: s => lines.push(s),
});
// lines: ['hello\n', '0\n', '1\n', '4\n']
```

### Custom print (raw args, not formatted string)

```js
await run(`print("x =", x, "squared:", x*x)`, {
  globals: { x: 7 },
  print: (...args) => myLogger.info('py:', args),
});
// myLogger receives: ['x =', 7, 'squared:', 49]
```

### Input / interactive

```js
const lines = ['Arthur', '42'];
await run(`
  name = input("Name? ")
  age = int(input("Age? "))
  print(f"Hello {name}, age {age}")
`, {
  stdin:  () => lines.shift(),
  stdout: s => process.stdout.write(s),
});
```

### Filesystem via VFS

```js
import { VFS, MemoryBackend } from '@gcu/vfs';

const vfs = new VFS({ backend: new MemoryBackend() });
await vfs.writeFile('/hello.txt', new TextEncoder().encode('hi from vfs'));

await run(`
  from pathlib import Path
  text = Path("/hello.txt").read_text()
  print(text.upper())
`, { vfs, stdout: s => process.stdout.write(s) });
// → HI FROM VFS
```

### Building a REPL

```js
import { isIncomplete, evalExpr, run } from '@gcu/adder/air';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { inspect } from 'node:util';

const rl = readline.createInterface({ input: stdin, output: stdout });
const scope = {};
const opts = { locals: scope, stdout: s => stdout.write(s) };

let buffer = '';
while (true) {
  const line = await rl.question(buffer ? '... ' : '>>> ');
  buffer = buffer ? buffer + '\n' + line : line;
  if (isIncomplete(buffer)) continue;

  try {
    // Try as an expression first — if it parses, display its value
    const value = await evalExpr(buffer, opts);
    if (value !== undefined) stdout.write(inspect(value) + '\n');
  } catch {
    // Not a single expression — run as a statement block and absorb the scope
    Object.assign(scope, await run(buffer, opts));
  }
  buffer = '';
}
```

### Tagged template (inline Python in JS)

```js
import { adderTag } from '@gcu/adder';

const scale = 2.5;
const { result } = await adderTag`
  result = ${scale} * 10
`;
// result: 25
```

## Data model

Python values ARE JavaScript values. No FFI boundary:

| Python type    | JS representation                                       |
|----------------|---------------------------------------------------------|
| `int`, `float` | `number`                                                |
| `str`          | `string`                                                |
| `bool`         | `boolean`                                               |
| `None`         | `null`                                                  |
| `list`, `tuple`| `Array`                                                 |
| `dict`         | plain `Object` (or `Map` for non-string keys)           |
| `set`          | `Set`                                                   |
| `range`        | `AdderRange` (lazy, iterable)                           |
| `bytes`        | `Uint8Array`                                            |

A list defined in a `run()` call is a regular `Array` — pass it to any JS function, return it from a Promise, store it in IndexedDB, it's just an array.

## Built-in modules

Available via `import` inside adder code:

| module        | what's there |
|---------------|--------------|
| `math`        | constants + functions (pi, sin, sqrt, factorial, gcd, ...) |
| `json`        | `dumps()`, `loads()` (Map/Set aware) |
| `random`      | `random()`, `randint()`, `choice()`, `shuffle()`, `gauss()` (xoshiro128 PRNG) |
| `itertools`   | `chain`, `product`, `combinations`, `permutations`, `accumulate`, `groupby`, ... |
| `functools`   | `reduce`, `partial`, `lru_cache` |
| `collections` | `OrderedDict`, `defaultdict`, `Counter`, `namedtuple` |
| `re`          | `match`, `search`, `findall`, `sub`, `split`, `compile` |
| `string`      | `ascii_lowercase`, `digits`, `punctuation`, etc. |
| `sys`         | `version`, `platform`, `path`, `argv`, `exit` |
| `js`          | proxy to `globalThis` — reach any host API |
| `this`        | the Zen of Python |

When `opts.vfs` is set, additional filesystem modules are available: `os`, `os.path`, `pathlib`, `shutil`, `glob`. The built-in `open()` also works with `with` context managers.

## Importing from paths and URLs

In addition to built-in and VFS modules, adder supports loading modules directly by path or URL. Two forms:

### String-literal imports

Address a module directly — alias required for the `import` form since a path isn't a valid identifier:

```python
import "./utils.py" as utils                          # relative to document.baseURI
import "https://cdn.example.com/lib.py" as lib        # absolute URL
import "/home/nb/helpers.py" as helpers               # absolute VFS path

from "./math_extras.py" import gcd, lcm               # no alias needed
from "https://cdn.example.com/ml.py" import train     # works with from-import too
```

The `import X as Y` form requires the `as` alias; the `from X import ...` form does not.

### HTTP module loading via sys.path

Append URL bases to `sys.path` and import by short name — adder tries VFS first, then HTTP:

```python
import sys
sys.path.append('https://cdn.example.com/mylib/')

import utils          # fetches https://cdn.example.com/mylib/utils.py
import pkg            # tries pkg.py, then pkg/__init__.py
```

Relative sys.path entries (`./lib/`, `../shared/`) resolve against `document.baseURI` in browser contexts. `sys.modules` caches successful loads — repeat imports are free.

Resolution chain for a bare `import foo`:
1. Built-in module table (math, json, re, ...)
2. VFS `sys.path` search (if VFS is configured)
3. HTTP `sys.path` search (URL bases and page-relative paths)
4. `ModuleNotFoundError`

Existing notebooks are unaffected — they don't have URL entries in sys.path by default.

## Using @gcu/adder inside Auditable

Load as a cell type from a notebook:

```js
await install("@gcu/adder")   // or load() in dev
```

This fetches the full bundled build and registers `adder` as a cell type. Press `n` to convert a cell or use the cell-header button. See also `@gcu/adder/register` for the side-effect entry point.

`@gcu/adder/cell` exposes `pythonParseNames`, `pythonFindUses`, `pythonExecute` for custom DAG integration. `@gcu/adder/highlight` exposes `tokenizePython` and `pythonCompletions`. `@gcu/adder/vfs` exposes `setAdderVFS`/`getAdderVFS` for global VFS configuration (prefer the per-call `opts.vfs` above).

## What's not supported

- Generators / `yield` are parsed but not evaluated
- Multiple inheritance
- Metaclasses
- `match` / `case`
- `exec()` / `eval()`

See [SPEC.md](./SPEC.md) for language details.

## License

MIT — see [LICENSE](./LICENSE).
