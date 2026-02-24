# example definition format

plain-text files with `///` comment delimiters. no escaping, no parsing libraries — just `string.split()` and `string.startsWith()`.

## magic first line

```
/// auditable
```

required first line. identifies the file as an auditable notebook. AF uses this to distinguish notebook `.txt` files from arbitrary text files. `gen_examples.js` tolerates it (skips if present).

## header directives

```
/// title: my notebook
/// settings: {"theme":"dark","fontSize":13,"width":"860"}
/// module: ./ext/sql/index.js ext/sql/index.js
```

- **title** (required) — notebook title
- **settings** — JSON settings object. omit for defaults (`dark`, `13`, `860`)
- **module** — `<url> <file-path-or-blob-hash>`. for `gen_examples.js`, the second part is a file path resolved relative to project root at build time. for AF, it's a content-hash ref into the blob store. repeatable for multiple modules

## cells

```
/// code
const x = 1;

/// md
# heading
some **markdown** with `backticks`

/// css
body { color: red; }

/// html
<div>${expr}</div>

/// code collapsed
// %collapsed
workshop([...])
```

- cell type: `code`, `md`, `css`, `html`
- optional flags after type: `collapsed`
- everything between `///` lines is cell content (raw, unescaped)
- leading/trailing blank lines in cell content are trimmed

## include directive

```
/// code
const wasm = atra({ memory: mem })`
/// include: ext/atra/lib/alpack.atra alpack.dgetrf alpack.dgetrs
  function rbf.kernel(r2, eps: f64): f64
  ...
`;
```

- `/// include: <filepath>` — inserts entire file contents into the current cell
- `/// include: <filepath> <name1> <name2> ...` — extracts named subroutines/functions from the file (matches `subroutine <name>(` or `function <name>(` through the closing standalone `end`)
- only valid inside a cell (between cell type line and next `///` directive)
- file path is relative to project root
- does not flush the cell — content is appended inline

## example

```
/// auditable
/// title: my demo
/// module: ./ext/sql/index.js ext/sql/index.js

/// md
# hello world
this is **markdown** with `backticks` — no escaping needed.

/// code
const x = ui.slider("value", 50, {min: 0, max: 100});

/// code
ui.display(`x = ${x}`);
```

## generation

run `node gen_examples.js` after building `auditable.html`. it reads all `.txt` defs listed in the script, resolves module file paths, and hydrates into standalone HTML files in `examples/`.
