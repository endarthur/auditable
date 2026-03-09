# Tagged Languages

Auditable supports **tagged language extensions** — tagged template literals that register
syntax highlighting and completions for domain-specific languages. Extensions self-register
when loaded via `install()`, and all code cells are immediately re-highlighted.

## How It Works

The extension system is built around the `window._taggedLanguages` registry. Each extension
provides two functions:

| Function | Purpose |
|---|---|
| `tokenize(code)` | Returns an array of `{ type, text }` tokens for syntax highlighting |
| `completions()` | Returns completion entries for the autocomplete engine |

When a new language registers, every code cell in the notebook is re-tokenized so
highlighting appears instantly — no page reload needed.

## Built-in Extensions

### atra — WebAssembly Compiler

A Fortran/Pascal-style language that compiles directly to WebAssembly bytecode.
Use the `atra` tagged template to compile and instantiate Wasm modules inline.

```js
const { dot } = atra`
  function dot(a: f64[], b: f64[], n: i32): f64
    var s: f64 := 0.0
    for i := 0 to n do
      s := s + a[i] * b[i]
    end for
    return s
  end
`
dot(new Float64Array([1,2,3]), new Float64Array([4,5,6]), 3) // 32.0
```

!!! info "Dedicated page"
    See [atra Extension](extensions-atra.md) for the full language overview,
    import syntax, libraries, and memory declarations.

---

### GLSL — Fragment Shaders

Shadertoy-compatible WebGL 2 fragment shaders with live hot-compile. The `glsl` tagged
template creates a full-screen shader canvas with an animation loop.

```js
await install("./ext/shader/index.js");

glsl`
void mainImage(out vec4 O, in vec2 U) {
    vec2 uv = U / iResolution.xy;
    O = vec4(uv, 0.5 + 0.5 * sin(iTime), 1.0);
}
`
```

**Shadertoy uniforms** are provided automatically:

| Uniform | Type | Description |
|---|---|---|
| `iResolution` | `vec3` | Canvas width, height, pixel ratio |
| `iTime` | `float` | Elapsed time in seconds |
| `iTimeDelta` | `float` | Time since last frame |
| `iFrame` | `int` | Frame counter |
| `iMouse` | `vec4` | Mouse position (xy = current, zw = click) |
| `iChannel0`–`iChannel3` | `sampler2D` | Texture channels |
| `iChannelResolution` | `vec3[4]` | Resolution of each channel |
| `iDate` | `vec4` | Year, month, day, seconds |

!!! tip "Live editing"
    Shaders recompile on every cell execution — edit the source and press
    Ctrl+Enter to see changes instantly.

---

### SQL — Query Language

SQL syntax highlighting and keyword/type/function completions. The `sql` tag is a
pass-through template literal — it returns the interpolated SQL string. You bring your
own database engine (e.g., sql.js loaded via `installBinary`).

```js
await install("./ext/sql/index.js");

// load sql.js (SQLite compiled to Wasm)
const sqlWasm = await installBinary(
  "https://sql.js.org/dist/sql-wasm.wasm",
  { compress: false }
);
const SQL = await load("https://sql.js.org/dist/sql-wasm.js");
const db = await SQL({ locateFile: () => sqlWasm });

db.run(sql`CREATE TABLE points (x REAL, y REAL, value REAL)`);
db.run(sql`INSERT INTO points VALUES (1.0, 2.0, 42.5)`);

const result = db.exec(sql`SELECT * FROM points WHERE value > 10`);
ui.table(result[0].values, { headers: result[0].columns });
```

**Completions include:**

- SQL keywords (`SELECT`, `FROM`, `WHERE`, `JOIN`, ...)
- Data types (`INTEGER`, `REAL`, `TEXT`, `BLOB`, ...)
- Built-in functions (`COUNT`, `SUM`, `AVG`, `json_extract`, ...)

---

## Loading Extensions

Extensions are installed with `install()` and self-register on import:

```js
// shader extension — provides glsl`` tag
await install("./ext/shader/index.js");

// SQL extension — provides sql`` tag
await install("./ext/sql/index.js");
```

!!! note "Persistence"
    `install()` stores the extension source in the notebook's module storage.
    The extension will be available offline and in saved copies of the notebook.
    Use `load()` instead if you only need the extension for the current session.

## Writing Custom Extensions

Any module can register a tagged language by adding an entry to
`window._taggedLanguages`:

```js
window._taggedLanguages = window._taggedLanguages || {};
window._taggedLanguages["mylang"] = {
    tokenize(code) {
        // return array of { type, text } tokens
        // type: "kw" | "str" | "num" | "cmt" | "const" | "fn" | "op" | "plain"
        return [{ type: "plain", text: code }];
    },
    completions() {
        // return array of { label, type, detail? }
        return [
            { label: "myKeyword", type: "keyword" },
        ];
    }
};

// trigger re-highlight of all cells
window.dispatchEvent(new Event("auditable:langchange"));
```

The `type` field on each token maps to CSS classes for syntax coloring, matching
the same token types used by the JavaScript highlighter.
