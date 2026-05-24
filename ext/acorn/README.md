# @gcu/acorn

**Vendored [acorn](https://github.com/acornjs/acorn) + [acorn-typescript](https://github.com/TyrealHu/acorn-typescript), bundled as one IIFE + ESM module.**

The JavaScript parser AIR uses to lower JS / TS source into its SSA IR. Vendored so the auditable runtime doesn't depend on npm at load time, and so the IIFE + ESM dual output lets both the browser bootstrap (`window.Acorn`) and Node test harnesses (ESM `import`) load from one file.

Bundled exports:

```js
import { Parser, tsPlugin } from '@gcu/acorn';

const TsParser = Parser.extend(tsPlugin());
const ast = TsParser.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
```

## Files

```
ext/acorn/
  entry.mjs            — rollup entry, re-exports Parser + tsPlugin
  acorn.min.js         — BUILD OUTPUT (IIFE; sets window.Acorn)
  acorn.esm.min.js     — BUILD OUTPUT (ESM; for Node tests + tools)
  build.js             — rollup invocation (terser-minified, dual output)
```

The IIFE bundle is loaded by auditable.html as a classic `<script>` before any of the runtime modules; it populates `window.Acorn = { Parser, tsPlugin }`. The ESM bundle is what AIR's `air.test.mjs` and other Node-side tools import.

## Building

```sh
cd ext/acorn && node build.js
```

Rebuilds after an upstream version bump. Both outputs are committed.

## Status

Vendored — tracks `acorn` 8.x + `acorn-typescript` 1.x. Not published as `@gcu/acorn` on npm.

## License

acorn is MIT (Copyright © Marijn Haverbeke); acorn-typescript is MIT (Copyright © TyrealHu); this bundle is also MIT.
