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

## License

MIT.
