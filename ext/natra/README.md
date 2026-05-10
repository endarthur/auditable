# @gcu/natra

ndarray operations for JavaScript, backed by [atra](https://www.npmjs.com/package/@gcu/atra)-compiled Wasm kernels. NumPy-compatible element-wise ops, reductions (sum, min, max, prod, nan-variants), broadcasting, strided views. Designed to pair with [adder](https://www.npmjs.com/package/@gcu/adder) for numpy-style Python code; standalone JS API also available.

Part of [Auditable](https://github.com/endarthur/auditable). Architecture notes at [NATRA.md](./NATRA.md).

Pre-1.0 — APIs may break on minor version bumps.

## Install

```sh
npm install @gcu/natra @gcu/atra
```

## Usage

```js
import { natra } from '@gcu/natra';

const nx = await natra({ pages: 256 });
const a = nx.array([1, 2, 3, 4]);
const b = nx.array([10, 20, 30, 40]);
nx.add(a, b);          // [11, 22, 33, 44]
nx.sum(a);             // 10
nx.reshape(nx.arange(12), [3, 4]);
```

### Adder integration (numpy-style)

```js
import '@gcu/natra/adder';   // registers with adder's import hook
// Now in an adder cell: `import numpy as np` — resolves to natra.
```

## Memory model — scope promotion and the discard pattern

natra runs each operation in a bump-allocated arena and reclaims everything
when the arena exits. **Returning an array from `scope()` promotes it** to
permanent memory so it survives past the scope. There is no public free
API (yet) — promoted arrays live for the lifetime of the natra context.

This matters in tight loops. If you call `scope` many times and don't
need the result of each iteration:

```js
// Leaks: each iteration promotes a fresh result to permanent memory.
for (let i = 0; i < 1000; i++) ctx.scope(s => s.add(big, big));

// Discards: braced arrow returns undefined, scope reclaims the result.
for (let i = 0; i < 1000; i++) ctx.scope(s => { s.add(big, big); });
```

For 1 M-element arrays the leak is 8 MB per call; ~125 iterations
exhaust the default 1 GB `maxPages` cap. For benchmark loops, side-effect
work, or anywhere you don't capture the result, prefer the braced form.

When you DO need the result, capture it once and reuse it across the
scope's lifetime, rather than re-allocating on each iteration.

## License

MIT.
