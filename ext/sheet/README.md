# @gcu/sheet

XLSX file reader and writer in pure JavaScript. Zero runtime dependencies — bundles its own zip and XML handling.

Part of [Auditable](https://github.com/gentropic/auditable). Used by [@gcu/calque](https://www.npmjs.com/package/@gcu/calque) and [@gcu/plan](https://www.npmjs.com/package/@gcu/plan) for xlsx export.

Pre-1.0 — APIs may break on minor version bumps.

## Install

```sh
npm install @gcu/sheet
```

## Usage

```js
import { sheet } from '@gcu/sheet';

// Write
const bytes = sheet.write({
  Sheet1: [
    ['name', 'score'],
    ['alice', 91],
    ['bob', 84],
  ],
});

// Read
const workbook = sheet.read(bytes);
```

## License

MIT.
