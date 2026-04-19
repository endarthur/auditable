# @gcu/air

Auditable Intermediate Representation — an SSA-based compiler IR with structured regions, used by [Auditable](https://github.com/endarthur/auditable) for analysis, optimization, and V8-hinted JS emission across JavaScript/TypeScript, [adder](https://github.com/endarthur/auditable/tree/main/ext/adder) (Python), and [Soft](https://github.com/endarthur/auditable/tree/main/ext/soft).

- Parse front-ends → AIR (structured SSA, typed operands, regions for control flow)
- Passes: type propagation (dataflow, branch merges, range-loop induction, object fields), constant folding, runtime-helper specialization, DCE, hint insertion
- Emit V8-friendly JS: `|0` for i32, `0.0` init for f64, `Math.fround()` for f32, sync-function detection, SSA inlining
- Cross-cell type flow (in Auditable): upstream cell's export types seed downstream cell's imports, iterated to fixed point

Pre-1.0 — APIs may break on minor version bumps.

## Install

```sh
npm install @gcu/air acorn acorn-typescript
```

`acorn` and `acorn-typescript` are optional peer dependencies — supply whichever parser you prefer (or pre-parsed ASTs) to the analysis entry points.

## Usage

### Analyze a JS/TS source fragment

```js
import { Parser } from 'acorn';
import tsPlugin from 'acorn-typescript';
import { analyzeCell } from '@gcu/air';

const parser = Parser.extend(tsPlugin());
const allDefined = new Set(['x']); // names defined elsewhere in the environment

const result = analyzeCell('const y = x + 1;', parser, allDefined);
// → { defines: Set('y'), uses: Set('x'), air: CellModule }
```

### Lower and emit directly

```js
import { Parser } from 'acorn';
import { lowerJS, runPasses, emitJS, needsAsync } from '@gcu/air';

const ast = Parser.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
const air = lowerJS(ast, source);
runPasses(air);

const scopeKeys = ['x', 'y'];        // names the cell may read from outer scope
const injected  = ['ui', 'std'];     // extra parameter names to inject
const js = emitJS(air, scopeKeys, injected);
const isAsync = needsAsync(air);
```

### Sub-path imports (tree-shaking, targeted use)

```js
import { I32, F64, DYNAMIC } from '@gcu/air/types';
import { runPasses } from '@gcu/air/passes';
import { emitJS } from '@gcu/air/emit';
import { lowerJS } from '@gcu/air/lower/js';
import { lowerAdder } from '@gcu/air/lower/adder';
import { lowerSoft } from '@gcu/air/lower/soft';
```

### Pre-bundled single file

```js
import '@gcu/air/bundled';
```

A concat of every source module into a single ES module — handy for `<script type="module">` or bundlers that prefer a single file. This is what Auditable itself ships in its HTML runtime.

## Module layout

| Sub-path | File | Contents |
| --- | --- | --- |
| `@gcu/air` | `src/api.js` | `analyzeCell`, `extractDefines`, `extractExportTypes`, and re-exports of the pieces below |
| `@gcu/air/types` | `src/types.js` | 14 primitive type singletons (i8–u64, f32/f64, bool, string, void, dynamic), compound type constructors, annotation resolution, arithmetic/comparison result rules |
| `@gcu/air/lower/js` | `src/lower/js.js` | ESTree → AIR (full modern JS, including classes, try/catch, generators, destructuring) |
| `@gcu/air/lower/adder` | `src/lower/adder.js` | adder (Python) AST → AIR |
| `@gcu/air/lower/soft` | `src/lower/soft.js` | Soft AST → AIR |
| `@gcu/air/passes` | `src/passes.js` | Type propagation, constant folding, runtime-helper specialization, DCE, dependency extraction |
| `@gcu/air/emit` | `src/emit-js.js` | `emitJS(module, scopeKeys, injected)`, `needsAsync(module)` |

## Annotations

AIR understands opt-in type annotations (`: i32`, `: f64`, `: f32array`, `: Int32Array`, ...). These are performance hints, not a type system — mismatches warn, they don't error, and when annotations are absent the passes fall back to dataflow inference.

## License

MIT — see [LICENSE](../../LICENSE).
