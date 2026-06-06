# @gcu/dimensions

Zero-dependency **dimension algebra** — the small, exact core that sits under dimensional analysis.

A *dimension* is a sparse object `{ axis: integerExponent }`. Dimensions form a [free abelian group](https://en.wikipedia.org/wiki/Free_abelian_group) under multiplication: you multiply dimensions by adding exponents componentwise, the identity is `{}` (dimensionless), and the inverse is negation. That's the whole model — total, exact (integer exponents, no floats), and ~80 lines.

```js
import { dimMul, dimDiv, dimEq, dimEmpty, dimFormat, DimRegistry } from '@gcu/dimensions';

const length = { length: 1 };
const mass   = { mass: 1 };

const volume  = dimMul(dimMul(length, length), length);  // { length: 3 }
const density = dimDiv(mass, volume);                     // { mass: 1, length: -3 }
const tonnes  = dimMul(density, volume);                  // { mass: 1 }  — density · volume

dimEq(tonnes, mass);     // true
dimEmpty({});            // true  (dimensionless)
dimFormat(density);      // "mass·length^-3"
```

## API

| Export | Signature | Meaning |
|---|---|---|
| `dimMul(a, b)` | dim, dim → dim | product (componentwise exponent add) |
| `dimDiv(a, b)` | dim, dim → dim | quotient (subtract) |
| `dimPow(d, n)` | dim, int → dim | raise to an integer power |
| `dimInv(d)` | dim → dim | reciprocal (negate exponents) |
| `dimEq(a, b)` | dim, dim → bool | equal (missing axis = 0; order-independent) |
| `dimEmpty(d)` | dim → bool | dimensionless? |
| `dimFormat(d)` | dim → string | `"mass·length^-3"` / `"-"` |
| `DimRegistry` | class | name → dim-vector table (`defineBase`, `defineDerived`, `resolve`, `has`, `list`) |

The axis **keys are the caller's vocabulary.** A physics layer uses `length` / `mass` / `time` / …; a domain layer can mint its own. That flexibility is the point: [@gcu/over](../over) deliberately gives mining grade units (`%`, `g/t`, `ppm`, `oz/t`) **distinct axes** so they never silently mix — even though a physics engine would reduce all of them to *dimensionless*. The algebra doesn't care; it just adds exponents over whatever axes you choose.

## Who uses it

- **@gcu/numbat** (ep) — full unit resolution, conversion, and a quantity type on top of this core.
- **@gcu/over** (auditable) — compile-time grade-math checking (unit propagation through a transform's column graph, mismatches warn).

## Build / test

```
node build.js                       # src/ → index.js (bundled single-file)
node --test test/dimensions.test.mjs # (run from the auditable repo root)
```

MIT · Arthur Endlein Correia · [Geoscientific Chaos Union](https://gentropic.org)
