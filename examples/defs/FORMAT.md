# example definition format

plain-text files with `///` comment delimiters. no escaping, no parsing libraries — just `string.split()` and `string.startsWith()`.

## header directives

```
/// title: my notebook
/// settings: {"theme":"dark","fontSize":13,"width":"860"}
/// module: ./ext/sql/index.js ext/sql/index.js
```

- **title** (required) — notebook title
- **settings** — JSON settings object. omit for defaults (`dark`, `13`, `860`)
- **module** — `<url> <file-path>`. file path is resolved relative to project root at build time. repeatable for multiple modules

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

## example

```
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
