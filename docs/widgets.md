# Widgets

Auditable provides four interactive widget types for building reactive UIs:
**slider**, **dropdown**, **checkbox**, and **text input**. Widgets can be
created in two ways — via JavaScript in code cells, or via HTML markup in
HTML cells.

All widgets are custom elements using **light DOM** (no shadow DOM). They work
in both notebook mode and exported standalone HTML apps.

---

## Code cell widgets

In code cells, widgets are created through the `ui` object. Each widget is
**keyed by its label string** — the same label always returns the same DOM
element, so widgets persist their values across cell re-executions.

### Reactive mode (default)

When a widget has no callback, changing it **re-runs the cell and all
downstream dependents** through the DAG:

```js
const n = ui.slider("count", 50, { min: 1, max: 100 })
const mode = ui.dropdown("mode", ["linear", "log"])
const show = ui.checkbox("show grid", true)
const name = ui.textInput("label", "untitled")
```

The return value is the widget's current value — a number for sliders, a
string for dropdowns and text inputs, a boolean for checkboxes.

### Callback mode

When you provide `onInput` or `onChange`, the widget runs your closure
**directly** — no DAG re-execution, no reparse, no scope rebuild. This is
ideal for high-frequency updates like animation or canvas drawing:

```js
const n = ui.slider("count", 50, { min: 1, max: 100, onInput: val => {
  // runs closure directly, no DAG re-execution
  ctx.clearRect(0, 0, 400, 300);
  drawParticles(val);
}})
```

!!! tip "When to use callbacks"
    Use `onInput` for continuous feedback (slider dragging, typing). Use
    `onChange` for discrete commits (slider release, dropdown selection).
    Without either, the widget triggers reactive DAG execution with
    debouncing (80ms for sliders, 300ms for text inputs).

---

## HTML cell widgets

In HTML cells, widgets are placed directly in markup. The `name` attribute
**defines a reactive scope variable** that downstream code cells can use:

```html
<audit-slider name="power" label="power" min="0" max="100" value="50"></audit-slider>
<audit-dropdown name="color" label="color" options="red,green,blue" value="red"></audit-dropdown>
<audit-checkbox name="showGrid" label="show grid" checked></audit-checkbox>
<audit-text-input name="title" label="title" value="hello"></audit-text-input>
```

Downstream code cells reference the variables directly:

```js
// power, color, showGrid, title are all in scope
const area = power * power;
ui.display(`Color: ${color}, Grid: ${showGrid}, Title: ${title}`);
```

!!! note
    HTML cell widgets are wired to the DAG via `wireWidgets()`. Changing a
    widget value updates `S.scope` and triggers `runDAG()` on the cell and
    its dependents. Widget values persist across upstream scope changes
    because HTML cell re-renders patch only bound nodes — no `innerHTML`
    replacement, no DOM destruction.

---

## Widget reference

### `audit-slider`

A range slider with a numeric display.

| Attribute | Type   | Default | Description                |
|-----------|--------|---------|----------------------------|
| `name`    | string | —     | Scope variable name        |
| `label`   | string | —     | Display label              |
| `min`     | number | `0`     | Minimum value              |
| `max`     | number | `100`   | Maximum value              |
| `step`    | number | `1`     | Step increment             |
| `value`   | number | `50`    | Initial value              |

**Value type:** `number` (via `parseFloat`)

**Code cell API:**

```js
ui.slider(label, defaultValue?, opts?)
```

- `label` — string key (also used as display label)
- `defaultValue` — initial numeric value (default: `50`)
- `opts` — `{ min, max, step, onInput, onChange, id, class }`

---

### `audit-dropdown`

A `<select>` element built from a comma-separated options list.

| Attribute | Type   | Default | Description                          |
|-----------|--------|---------|--------------------------------------|
| `name`    | string | —     | Scope variable name                  |
| `label`   | string | —     | Display label                        |
| `options` | string | —     | Comma-separated list of option values |
| `value`   | string | —     | Initially selected value             |

**Value type:** `string`

**Code cell API:**

```js
ui.dropdown(label, options, defaultValue?, opts?)
```

- `label` — string key (also used as display label)
- `options` — array of strings, e.g. `["red", "green", "blue"]`
- `defaultValue` — initial selection (default: first option)
- `opts` — `{ onInput, onChange, id, class }`

---

### `audit-checkbox`

A single checkbox toggle.

| Attribute | Type    | Default | Description                              |
|-----------|---------|---------|------------------------------------------|
| `name`    | string  | —     | Scope variable name                      |
| `label`   | string  | —     | Display label                            |
| `checked` | boolean | `false` | Initial state (presence = true)          |

**Value type:** `boolean`

**Code cell API:**

```js
ui.checkbox(label, defaultValue?, opts?)
```

- `label` — string key (also used as display label)
- `defaultValue` — initial boolean (default: `false`)
- `opts` — `{ onInput, onChange, id, class }`

---

### `audit-text-input`

A single-line text input field.

| Attribute     | Type   | Default | Description             |
|---------------|--------|---------|-------------------------|
| `name`        | string | —     | Scope variable name     |
| `label`       | string | —     | Display label           |
| `value`       | string | `""`    | Initial text value      |
| `placeholder` | string | `""`    | Placeholder text        |

**Value type:** `string`

**Code cell API:**

```js
ui.textInput(label, defaultValue?, opts?)
```

- `label` — string key (also used as display label)
- `defaultValue` — initial string (default: `""`)
- `opts` — `{ onInput, onChange, id, class }`

---

## Debouncing behavior

Widgets that fire rapidly (sliders and text inputs) are debounced before
triggering DAG re-execution:

| Widget     | Debounce delay |
|------------|----------------|
| slider     | 80 ms          |
| text input | 300 ms         |
| dropdown   | immediate      |
| checkbox   | immediate      |

In callback mode (`onInput`/`onChange`), there is no debouncing — the closure
runs on every event.

---

## Persistence

- **Code cell widgets** are keyed by label. The `cell._inputs` map stores
  current values. When a cell re-executes, `mkInput()` checks for an existing
  widget DOM element with a matching `data-widget-key` attribute and reuses it.
  Unused widgets are pruned after execution.

- **HTML cell widgets** store values in `cell._inputs` keyed by `name`.
  On re-render (upstream scope change), previously stored values are restored
  to the widget DOM, preserving user state.

Widget values do **not** survive saves — only cell source code and collapsed
state are serialized. After reloading a saved notebook, widgets reset to their
default values as defined in code or markup attributes.
