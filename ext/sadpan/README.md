# @gcu/sadpan

DataFrame-style structured data manipulation. Series, Table, group-by, joins, CSV/JSON IO. Inspired by pandas, scaled down for a notebook runtime.

Part of [Auditable](https://github.com/endarthur/auditable).

Pre-1.0 — APIs may break on minor version bumps.

## Install

```sh
npm install @gcu/sadpan
```

## Usage

```js
import { table, read_csv } from '@gcu/sadpan';

const df = table({
  name: ['alice', 'bob', 'carol'],
  score: [91, 84, 77],
});
df.filter(r => r.score > 80).sort('score', -1);

// Or from CSV
const t = read_csv(csvText);
t.groupBy('category').agg({ value: 'mean' });
```

Sub-path imports: `@gcu/sadpan/series`, `@gcu/sadpan/table`, `@gcu/sadpan/groupby`, `@gcu/sadpan/join`, `@gcu/sadpan/io`.

## License

MIT.
