const { workshopCell } = require('../workshop-helpers');

module.exports = {
  file: 'example_sql.html',
  title: 'SQL notebook',
  _buildModule: { url: './ext/sql/index.js', path: 'ext/sql/index.js' },
  cells: [
    workshopCell('SQL notebook', [
      `{
    title: 'installBinary()',
    content: md\`\\\`installBinary(url)\\\` fetches a binary
asset (here, the SQLite WASM file), gzip-compresses
it, and stores it as base64 in the notebook HTML.

On subsequent loads, the binary is decoded from the
embedded data \\u2014 no network fetch needed. This is
how a 1+ MB WASM file loads instantly from a saved
notebook. The returned blob URL has the correct MIME
type for \\\`fetch()\\\`.\`
  }`,
      `{
    title: 'Tagged language extensions',
    content: md\`The \\\`sql\\\` tag from \\\`@auditable/sql\\\`
provides **syntax highlighting** and **completions**
inside template literals. When you type
\\\`sql\\\`\\\`SELECT ...\\\`\\\`, the editor highlights SQL
keywords, types, and functions.

Language extensions register via
\\\`window._taggedLanguages\\\`. Each provides
\\\`tokenize(code)\\\` for highlighting and
\\\`completions()\\\` for autocomplete. The \\\`glsl\\\` tag
from \\\`@auditable/shader\\\` works the same way.\`
  }`,
      `{
    title: 'Reactive queries',
    content: md\`The slider and dropdown define
\\\`minPop\\\` and \\\`sortBy\\\`. The query cells use these
values via template interpolation:
\\\`sql\\\`WHERE pop >= \\\${minPop}\\\`\\\`.

Change a filter \\u2192 the query cell re-runs \\u2192
results update \\u2192 the table re-renders. The database
itself (\\\`db\\\`) is defined upstream and persists
across re-executions. Only the queries re-run, not
the table creation.\`
  }`
    ]),
    { type: 'md', code: "# SQL notebook\n\nSQLite running entirely in the browser via **sql.js** (WebAssembly). the `sql` language tag from `@auditable/sql` provides syntax highlighting and completions inside template literals.\n\n`installBinary()` embeds the WASM binary (gzip-compressed) \u2014 after saving, the 1+ MB asset loads instantly with no network fetch.\n\ncreate tables, insert data, and query it \u2014 all reactive. change the filter and downstream cells re-run." },
    { type: 'code', code: "const { sql } = await load(\"./ext/sql/index.js\");\nconst wasmUrl = await installBinary(\"https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.12.0/sql-wasm.wasm\");\nconst wasmBinary = new Uint8Array(await fetch(wasmUrl).then(r => r.arrayBuffer()));\nconst initSqlJs = await load(\"https://esm.sh/sql.js@1.12.0\");\nconst SQL = await initSqlJs.default({ wasmBinary });\nconst db = new SQL.Database();" },
    { type: 'code', code: "db.run(sql`\n  CREATE TABLE IF NOT EXISTS cities (\n    name    TEXT PRIMARY KEY,\n    country TEXT NOT NULL,\n    pop     REAL,\n    lat     REAL,\n    lon     REAL\n  )\n`);\n\ndb.run(sql`DELETE FROM cities`);\n\nconst data = [\n  ['Tokyo',        'Japan',      37.4,  35.68,  139.69],\n  ['Delhi',        'India',      32.9,  28.61,   77.23],\n  ['Shanghai',     'China',      29.2,  31.23,  121.47],\n  ['S\\u00e3o Paulo',    'Brazil',     22.6, -23.55,  -46.63],\n  ['Mexico City',  'Mexico',     22.1,  19.43,  -99.13],\n  ['Cairo',        'Egypt',      21.8,  30.04,   31.24],\n  ['Mumbai',       'India',      21.7,  19.08,   72.88],\n  ['Beijing',      'China',      21.5,  39.90,  116.41],\n  ['Osaka',        'Japan',      19.1,  34.69,  135.50],\n  ['New York',     'USA',        18.8,  40.71,  -74.01],\n  ['Buenos Aires', 'Argentina',  15.4, -34.60,  -58.38],\n  ['Lagos',        'Nigeria',    15.3,   6.52,    3.38],\n  ['Istanbul',     'Turkey',     15.6,  41.01,   28.98],\n  ['Manila',       'Philippines', 14.4, 14.60,  120.98],\n  ['Guangzhou',    'China',      13.9,  23.13,  113.26],\n];\n\nconst stmt = db.prepare(sql`INSERT INTO cities VALUES (?, ?, ?, ?, ?)`);\nfor (const row of data) { stmt.run(row); }\nstmt.free();\n\nui.display(`loaded ${data.length} cities`);" },
    { type: 'code', code: "const minPop = ui.slider(\"min population (M)\", 15, {min: 5, max: 35, step: 0.5});\nconst sortBy = ui.dropdown(\"sort by\", [\"pop DESC\", \"name ASC\", \"lat DESC\", \"lon ASC\"]);" },
    { type: 'code', code: "const results = db.exec(sql`\n  SELECT name, country, pop, lat, lon\n  FROM cities\n  WHERE pop >= ${minPop}\n  ORDER BY ` + sortBy);\n\nconst rows = results[0] ? results[0].values.map(r => ({\n  city: r[0], country: r[1], pop: r[2], lat: r[3], lon: r[4]\n})) : [];\n\nui.table(rows);\nui.display(`${rows.length} cities with pop \\u2265 ${minPop}M`);" },
    { type: 'code', code: "// aggregate query\nconst stats = db.exec(sql`\n  SELECT\n    country,\n    COUNT(*)       AS n,\n    ROUND(SUM(pop), 1) AS total_pop,\n    ROUND(AVG(pop), 1) AS avg_pop\n  FROM cities\n  WHERE pop >= ${minPop}\n  GROUP BY country\n  ORDER BY total_pop DESC\n`);\n\nconst agg = stats[0] ? stats[0].values.map(r => ({\n  country: r[0], cities: r[1], total_pop: r[2], avg_pop: r[3]\n})) : [];\n\nui.table(agg);" }
  ]
};
