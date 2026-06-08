# @gcu/soft

Soft — a programming language with English keywords, designed for soft-keyboard input. Every keyword is a common English word; the language can be written without symbols entirely. Usable as a standalone interpreter library or as an [Auditable](https://github.com/gentropic/auditable) cell type.

Pure JS tree-walking interpreter. Ships with an optional AIR-transpilation fast path (`@gcu/soft/air`) via [@gcu/air](https://www.npmjs.com/package/@gcu/air).

Locale-aware — the same language is available in English and Brazilian Portuguese (`pt-BR`) via `softSetLocale()`.

Pre-1.0 — APIs may change on minor version bumps.

## Install

```sh
npm install @gcu/soft

# optional: install @gcu/air for the fast-path transpiler
npm install @gcu/air
```

## Quick start

```js
import { run } from '@gcu/soft';

const { scope, output } = run(`
  set name to "Arthur"
  set greeting to "Hello, " & name
  say greeting
`);

console.log(scope.greeting);   // "Hello, Arthur"
console.log(output);           // ["Hello, Arthur"]
```

AIR fast path — same API shape:

```js
import { run } from '@gcu/soft/air';
const { scope, output } = await run(code);
```

## API

Same shape as @gcu/adder but soft's `run()` returns `{ scope, output }` — the `output` array collects every value emitted by `say` in order.

### `run(code, opts?): { scope, output }`

### `evalExpr(code, opts?): value`

Evaluate a soft expression. Returns the implicit `it` result.

### `compile(code): { ast, run(opts?) }`

Compile once, run many.

### `isIncomplete(code): boolean`

For REPL line-continuation.

## Options

```ts
{
  globals?: Record<string, unknown>
  locals?:  Record<string, unknown>
  say?:     (value: unknown) => void     // receives raw values from `say`
  stdout?:  (s: string) => void           // default say formats & writes here
  stderr?:  (s: string) => void
  stdin?:   () => string | null | Promise<string | null>
  host?:    Record<string, unknown>       // cell-handler host integration
}
```

`say` is soft's output verb. Unlike Python's `print`, it passes the raw value (number, string, list, record) to the `say` callback so consumers can format as they wish. The default `say` formats via `softString()` and writes to `stdout` with a newline.

## Usage patterns

### Capturing output (tests)

```js
const captured = [];
run(`
  say 1
  say "two"
  say 3.14
`, {
  say: v => captured.push(v),
});
// captured: [1, "two", 3.14]
```

### Stream to stdout

```js
run(`say "hello"`, {
  stdout: s => process.stdout.write(s),
});
// prints "hello\n"
```

### Compile once, vary bindings

```js
const m = compile(`
  set doubled to n * 2
`);
m.run({ globals: { n: 5 } }).scope.doubled;   // 10
m.run({ globals: { n: 10 } }).scope.doubled;  // 20
```

### Inject host globals

```js
run(`
  set π to Math.PI
  set area to π times r times r
  say area
`, {
  globals: {
    Math: Math,
    r: 5,
  },
});
```

### Portuguese locale

Pass a locale object to `softSetLocale`. Locale JSON files ship with the
package under `locales/` — load one and pass its parsed contents:

```js
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { run, softSetLocale } from '@gcu/soft';

const ptBrPath = fileURLToPath(new URL('../node_modules/@gcu/soft/locales/pt-BR.json', import.meta.url));
const ptBR = JSON.parse(await readFile(ptBrPath, 'utf8'));
softSetLocale(ptBR);

const { scope } = run(`
  defina nome para "Arthur"
  defina saudação para "Olá, " & nome
  diga saudação
`);
console.log(scope['saudação']);   // "Olá, Arthur"

softSetLocale(null);   // back to English
```

`softSetLocale(null)` resets to English (the base language). `softGetLocale()` returns the active lookup table or null.

### Building a REPL

```js
import { isIncomplete, run } from '@gcu/soft/air';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const rl = readline.createInterface({ input: stdin, output: stdout });
const scope = {};

let buffer = '';
while (true) {
  const line = await rl.question(buffer ? '... ' : '> ');
  buffer = buffer ? buffer + '\n' + line : line;
  if (isIncomplete(buffer)) continue;

  const r = await run(buffer, {
    locals: scope,
    say: v => stdout.write(String(v) + '\n'),
  });
  Object.assign(scope, r.scope);
  buffer = '';
}
```

### Tagged template

```js
import { softTag } from '@gcu/soft';

const { scope } = softTag`
  set name to "Arthur"
  set greeting to "Hello, " & name
`;
```

## Using @gcu/soft inside Auditable

```js
await install("@gcu/soft")
```

Registers `soft` as a cell type. Press `y` or use the cell-header button to convert a cell. `@gcu/soft/register` is the side-effect entry point.

## License

Implementation: MIT — see [LICENSE](./LICENSE).
Language specification (grammar, keywords, semantics as documented in SPEC.md): CC0-1.0 — anyone is free to produce a clean-room reimplementation.
