# Standard Library

Every cell receives a `std` object with utility functions for data processing, math, DOM manipulation, color science, and more. It is also available via `load("@std")`.

## Data

### `std.csv(text, opts?)`

Parse CSV text into an array of objects. The first row is treated as headers.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `separator` | string | `","` | Field delimiter |
| `typed` | boolean | `false` | Auto-convert numbers, booleans, and nulls |

Handles quoted fields (including escaped `""` inside quotes) and both `\r\n` and `\n` line endings.

```js
const text = "name,value\nAlice,42\nBob,17"
const rows = std.csv(text, { typed: true })
// [{ name: "Alice", value: 42 }, { name: "Bob", value: 17 }]
```

!!! note "Typed mode conversions"

    When `typed: true`, the following conversions apply:

    - Numeric strings become numbers
    - `"true"` / `"false"` become booleans
    - Empty strings become `null`

### `std.fetchJSON(url)`

Fetch a URL and parse the response as JSON. Throws on non-OK responses.

```js
const data = await std.fetchJSON("https://api.example.com/data.json")
```

---

## Math / Stats

All stat functions accept an optional accessor function `fn` that maps each element before computation.

### `std.sum(arr, fn?)`

Sum all values in an array.

```js
std.sum([1, 2, 3])           // 6
std.sum(points, p => p.x)    // sum of x coordinates
```

### `std.mean(arr, fn?)`

Arithmetic mean. Returns `NaN` for empty arrays.

```js
std.mean([10, 20, 30])  // 20
```

### `std.median(arr, fn?)`

Median value. For even-length arrays, returns the average of the two middle values. Returns `NaN` for empty arrays.

```js
std.median([1, 3, 5, 7])  // 4
```

### `std.extent(arr, fn?)`

Returns `[min, max]` of the array.

```js
std.extent([3, 1, 4, 1, 5])  // [1, 5]
```

### `std.bin(arr, n?, fn?)`

Create histogram bins. Returns an array of `{ x0, x1, values }` objects.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `arr` | number[] | required | Input values |
| `n` | number | `10` | Number of bins |
| `fn` | function | --- | Accessor function |

```js
const bins = std.bin(data, 20, d => d.score)
// [{ x0: 0, x1: 5, values: [...] }, ...]
```

### `std.linspace(start, stop, n)`

Generate `n` evenly-spaced numbers from `start` to `stop` (inclusive). The endpoint is exact (not subject to floating-point drift).

```js
std.linspace(0, 1, 5)  // [0, 0.25, 0.5, 0.75, 1]
```

---

## Arrays

### `std.unique(arr, fn?)`

Return unique values. Without `fn`, uses `Set` equality. With `fn`, deduplicates by the key returned by the function (keeps first occurrence).

```js
std.unique([1, 2, 2, 3])                    // [1, 2, 3]
std.unique(people, p => p.department)        // one person per department
```

### `std.zip(...arrays)`

Zip arrays together. Output length is the minimum input length.

```js
std.zip([1, 2, 3], ["a", "b", "c"])
// [[1, "a"], [2, "b"], [3, "c"]]
```

### `std.cross(...arrays)`

Cartesian product of all input arrays.

```js
std.cross([1, 2], ["a", "b"])
// [[1, "a"], [1, "b"], [2, "a"], [2, "b"]]
```

---

## Color

Auditable's color system uses the **OKLAB** perceptual color space for all operations (mixing, lightening, darkening, saturation). This produces more uniform results than HSL-based manipulation.

### `std.color(input)`

Create a color object from various input formats:

| Input | Example |
|-------|---------|
| Hex string | `"#c89b3c"`, `"#fff"`, `"#fff8"`, `"#ff000080"` |
| RGB string | `"rgb(200, 155, 60)"`, `"rgba(200, 155, 60, 0.5)"` |
| HSL string | `"hsl(40, 70%, 50%)"` |
| Array | `[200, 155, 60]` or `[200, 155, 60, 0.5]` |
| Object | `{ r: 200, g: 155, b: 60 }` |

The returned color object is **frozen** (immutable). All transform methods return new color objects.

**Properties:** `r`, `g`, `b`, `a`

**Methods:**

| Method | Description |
|--------|-------------|
| `.lighten(amount)` | Increase OKLAB lightness |
| `.darken(amount)` | Decrease OKLAB lightness |
| `.saturate(amount)` | Increase OKLCH chroma |
| `.desaturate(amount)` | Decrease OKLCH chroma |
| `.rotate(degrees)` | Rotate OKLCH hue |
| `.mix(other, t?)` | Blend with another color in OKLAB space (t=0.5 by default) |
| `.alpha(a)` | Set alpha channel |
| `.css()` | Output as `rgb(...)` or `rgba(...)` string |
| `.hex()` | Output as `#rrggbb` string |
| `.hsl()` | Return `{ h, s, l }` object |
| `.oklab()` | Return `{ L, a, b }` object |
| `.oklch()` | Return `{ L, C, h }` object |
| `.linear()` | Return `{ r, g, b }` in linear RGB |
| `.toString()` | Same as `.css()` |

```js
const amber = std.color("#c89b3c")
const light = amber.lighten(0.15)
const blend = amber.mix("#2255aa", 0.3)
print(light.hex(), blend.css())
```

### `std.hsl(h, s, l, a?)`

Create a color from HSL values. Ranges: h in 0–360, s in 0–100, l in 0–100, a in 0–1 (default 1).

```js
const c = std.hsl(210, 80, 50)
print(c.hex())  // a blue
```

### `std.colorScale(domain, colors)`

Create a function that maps numeric values to colors. Interpolation uses OKLAB for perceptual uniformity.

**With color stops:**

```js
const scale = std.colorScale([0, 50, 100], ["#00f", "#fff", "#f00"])
scale(25)   // blended blue-white
scale(75)   // blended white-red
```

**With a colormap function:**

```js
const scale = std.colorScale([0, 1000], std.viridis)
scale(500)  // viridis color at t=0.5
```

Values are clamped to the domain range.

### Colormaps

Scientific colormaps that map a value `t` in [0, 1] to an `rgb(...)` string. Polynomial approximations of the matplotlib originals.

| Function | Description |
|----------|-------------|
| `std.viridis(t)` | Purple to yellow (perceptually uniform) |
| `std.magma(t)` | Black to light yellow via magenta |
| `std.inferno(t)` | Black to light yellow via red |
| `std.plasma(t)` | Purple to yellow via pink |
| `std.turbo(t)` | Rainbow (improved jet) |

```js
// draw a colormap gradient
const c = ui.canvas(400, 50)
const ctx = c.getContext("2d")
for (let x = 0; x < 400; x++) {
  ctx.fillStyle = std.viridis(x / 399)
  ctx.fillRect(x, 0, 1, 50)
}
```

### `std.palette10`

Array of 10 categorical hex color strings (Tableau 10 palette). Suitable for distinguishing discrete categories in charts.

```js
std.palette10[0]  // "#4e79a7"
std.palette10[1]  // "#f28e2b"
```

---

## DOM / IO

### `std.el(tag, attrs?, ...children)`

Create a DOM element with attributes and children.

| Parameter | Type | Description |
|-----------|------|-------------|
| `tag` | string | HTML tag name |
| `attrs` | object | Attributes, `style` object, or `on*` event handlers |
| `children` | Node/string | Child nodes or text content |

Event handlers are attached via `addEventListener` (strip the `on` prefix). If `attrs` is a Node or string, it is treated as the first child.

```js
const btn = std.el("button",
  { onclick: () => alert("clicked"), style: { color: "red" } },
  "Click me"
)
ui.display(btn)
```

### `std.copy(text)`

Copy text to the clipboard. Returns a promise.

```js
await std.copy("copied text")
```

### `std.file(accept?)`

Open a native file picker dialog. Returns a promise resolving to `{ name, text, size }`. Optional `accept` string filters file types.

```js
const f = await std.file(".csv")
const rows = std.csv(f.text, { typed: true })
```

### `std.download(data, filename, mimeType?)`

Trigger a file download. `data` can be a string or an object (auto-serialized as JSON). MIME type defaults to `text/plain` for strings or `application/json` for objects.

```js
std.download(JSON.stringify(results), "output.json")
```

!!! tip "ui.download vs std.download"

    `ui.download()` renders a persistent download **button** in the cell output. `std.download()` triggers an **immediate** browser download. Use `ui.download` when you want the user to click on demand; use `std.download` in scripts.

### `std.fmt(number, opts?)`

Format a number as a string.

| Option | Type | Description |
|--------|------|-------------|
| `decimals` | number | Fixed decimal places (uses `toFixed`) |
| `prefix` | string | Prepend to result |
| `suffix` | string | Append to result |

Without `decimals`, uses `Intl.NumberFormat` with up to 6 fraction digits.

```js
std.fmt(1234.5678, { decimals: 2 })                // "1234.57"
std.fmt(0.95, { decimals: 1, suffix: "%" })         // "95.0%"
std.fmt(42000, { prefix: "$" })                     // "$42,000"
```

---

## Atra Integration

### `std.include(libs, ...names)`

Resolve atra routine dependencies and return concatenated source code for template interpolation. Accepts a single library object or an array of libraries. Each library must have `sources` and `deps` properties (as produced by atra library builds).

Dependencies are automatically resolved via topological sort — if routine B depends on routine A, A's source appears first.

```js
const { stdlib } = await load("@atra/stdlib")
const src = std.include(stdlib, "mat_mul", "mat_inv")

// use in an atra tagged template:
const mod = await atra`
${src}
procedure my_algo(n: integer; a: array of real)
  ...
end
`
```
