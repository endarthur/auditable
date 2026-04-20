# @gcu/air

Auditable Intermediate Representation — an SSA-based compiler IR with structured regions, used by [Auditable](https://github.com/endarthur/auditable) for analysis, optimization, and V8-hinted JavaScript emission across JavaScript/TypeScript, [adder](https://www.npmjs.com/package/@gcu/adder) (Python), and [Soft](https://www.npmjs.com/package/@gcu/soft) dialects.

Normal consumers don't touch @gcu/air directly — they use `@gcu/adder/air` or `@gcu/soft/air`, which are thin wrappers over this package. Reach for @gcu/air directly when you want to compile your own language to JS, add passes, or emit hinted JavaScript from your own AST pipeline.

Pre-1.0 — APIs may change on minor version bumps.

## Install

```sh
npm install @gcu/air acorn acorn-typescript
```

`acorn` and `acorn-typescript` are optional peer dependencies — supply whichever parser you prefer (or pre-parsed ASTs) to `analyzeModule()`.

## Usage

### Analyze a JS/TS source module

```js
import { Parser } from 'acorn';
import tsPlugin from 'acorn-typescript';
import { analyzeModule } from '@gcu/air';

const parser = Parser.extend(tsPlugin());
const result = analyzeModule('const y = x + 1; const z = y * 2;', parser, null);
// result.defines: Set(['y', 'z'])
// result.uses:    Set(['x'])       — free names
// result.air:     the full AIR module
```

Pass a non-null `allDefined` set to restrict `uses` to names defined in a sibling-module environment (Auditable's cell-scope semantics).

### Lower and emit directly

```js
import { Parser } from 'acorn';
import { lowerJS, runPasses, emitJS, needsAsync } from '@gcu/air';

const ast = Parser.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
const air = lowerJS(ast, source);
runPasses(air);

const scopeKeys = ['x', 'y'];
const injected  = ['ui', 'std'];
const js = emitJS(air, scopeKeys, injected);
const isAsync = needsAsync(air);

const Ctor = isAsync ? Object.getPrototypeOf(async function(){}).constructor : Function;
const fn = new Ctor(...scopeKeys, js);
const result = await fn(xValue, yValue);
```

### Compile a Python-like language (adder)

```js
import { adderParse, _py } from '@gcu/adder';
import { lowerAdder, runPasses, emitJS, needsAsync } from '@gcu/air';

const ast = adderParse(pythonSource);
const air = lowerAdder(ast, pythonSource);
runPasses(air);

const scopeKeys = ['_py', ...[...air.imports]];
const js = emitJS(air, scopeKeys, []);
// wrap in (Async)Function, call with _py + binding values
```

This is what `@gcu/adder/air` does internally. If you just want to run Python code, use that package instead.

### Sub-path imports (tree-shaking, targeted use)

```js
import { I32, F64, DYNAMIC } from '@gcu/air/types';
import { runPasses }         from '@gcu/air/passes';
import { emitJS }            from '@gcu/air/emit';
import { lowerJS }           from '@gcu/air/lower/js';
import { lowerAdder }        from '@gcu/air/lower/adder';
import { lowerSoft }         from '@gcu/air/lower/soft';
```

### Pre-bundled single file

```js
import '@gcu/air/bundled';
```

The concat'd `index.js` — all source modules merged into one file. Used by Auditable's embedded runtime.

## What AIR does

Four phases, of which the first three are shipped:

- **Analysis** — parse (via your chosen parser), lower to AIR (structured SSA, typed operands, regions for control flow). `analyzeModule()` returns `{ defines, uses, air }`.
- **Passes** — type propagation (dataflow, branch merges, range-loop induction, object fields), constant folding, runtime-helper specialization (`_py.add` rewrites to raw `+` when both operands are typed numbers), DCE, hint insertion.
- **Emission** — V8-friendly JS: `|0` for i32, `0.0` initialization for f64, `Math.fround()` for f32, sync function detection, SSA inlining, opaque regions preserving source text verbatim.
- **(Planned) WASM** — emit directly to atra bytecode for hot kernels.

Cross-language support: ESTree → AIR via `lowerJS`, adder AST → AIR via `lowerAdder`, Soft AST → AIR via `lowerSoft`. All three share the same passes and the same JS emitter.

## Type annotations

AIR understands opt-in type annotations on JS/TS source: `: i32`, `: f64`, `: f32array`, `: Int32Array`, etc. Performance hints, not a type system — mismatches warn, they don't error, and when annotations are absent the passes fall back to dataflow inference.

```js
function hotLoop(arr: f64array, n: i32): f64 {
  let sum: f64 = 0.0;
  for (let i = 0; i < n; i = i + 1 | 0) {
    sum = sum + arr[i];
  }
  return sum;
}
```

Parsed via `acorn-typescript`. Users who don't want annotations never need them.

## Module layout

| Sub-path | File | Contents |
|---|---|---|
| `@gcu/air` | `src/api.js` | `analyzeModule`, `analyzeCell` (back-compat alias), `extractDefines`, `extractExportTypes`, re-exports |
| `@gcu/air/types` | `src/types.js` | Primitive type singletons (i8–u64, f32/f64, bool, string, void, dynamic), compound constructors |
| `@gcu/air/lower/js` | `src/lower/js.js` | ESTree → AIR |
| `@gcu/air/lower/adder` | `src/lower/adder.js` | adder (Python) AST → AIR |
| `@gcu/air/lower/soft` | `src/lower/soft.js` | Soft AST → AIR |
| `@gcu/air/passes` | `src/passes.js` | Type propagation, constant folding, specialization, DCE |
| `@gcu/air/emit` | `src/emit-js.js` | `emitJS(module, scopeKeys, injected)`, `needsAsync(module)` |
| `@gcu/air/bundled` | `index.js` | Full concat build, single-file ES module |

## License

MIT — see [LICENSE](./LICENSE).
