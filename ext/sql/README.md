# @gcu/sql

SQL language tag with syntax highlighting and completions for [Auditable](https://github.com/gentropic/auditable) and anywhere else you want a `sql` tagged template helper.

Pre-1.0 — APIs may break on minor version bumps.

## Install

```sh
npm install @gcu/sql
```

## Usage

```js
import { sql } from '@gcu/sql';

const tableName = 'users';
const query = sql`SELECT * FROM ${tableName} WHERE id = 1`;
```

`sql` is a tagged template that returns `{ raw, values }` — parameterize with your own executor. `tokenizeSql` and `sqlCompletions` are also exported for editor integration.

## License

MIT.
