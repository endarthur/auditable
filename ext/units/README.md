# @gcu/units

Unit conversion for length, mass, area, volume, angle, grade, density, and magnetic quantities. Plus sieve mesh conversions, drill-core utilities, formatting helpers. Used by geoscientific notebooks in [Auditable](https://github.com/endarthur/auditable).

Pre-1.0 — APIs may break on minor version bumps.

## Install

```sh
npm install @gcu/units
```

## Usage

```js
import { convert, length, grade, sieve, format } from '@gcu/units';

length(100, 'm').to('ft');         // 328.084...
grade(1.5, '%').to('ppm');         // 15000
convert(1.5, 'g/t', 'ppm');        // 1.5
sieve.mesh(200);                   // { micron: 75, ... }
format(0.0023, { sig: 3 });        // '2.30e-3'
```

Sub-path imports: `@gcu/units/convert`, `@gcu/units/sieve`, `@gcu/units/core`, `@gcu/units/format`.

## License

MIT.
