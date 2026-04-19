# @gcu/calque

Calque — a spreadsheet language that compiles to xlsx. Tagged-template `calque` parses formulas, evaluates, and renders as tables. Language spec at [SPEC.md](./SPEC.md).

Part of [Auditable](https://github.com/endarthur/auditable). Standalone editor at [gentropic.org/calque](https://gentropic.org/calque).

Pre-1.0 — APIs may break on minor version bumps.

## Install

```sh
npm install @gcu/calque
```

## Usage

```js
import { calque } from '@gcu/calque';

const result = calque`
  sheet "Sales"
    x = 10
    y = 20
    total = x + y
`;

result.sheets.Sales.scope.get('total'); // 30
```

Lower-level compiler API via sub-path `@gcu/calque/api`.

## License

MIT.
