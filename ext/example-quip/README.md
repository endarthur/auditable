# @example/quip

**The reference example extension for [EXTENSION_SPEC.md](../EXTENSION_SPEC.md).**

A toy templating language. Each statement is `name = template` with `{var}` interpolation. The point isn't the language — it's that this single extension wires every capability slot the spec defines, so you can read the source as a working answer to "how do I do X in an extension?"

```
/// quip
// %cellName greetings
hello   = Hi, {name}!
bye     = See you, {name}.

/// code
greetings.hello({ name: "Ada" });   // "Hi, Ada!"
```

## What it exercises

The extension ships **two entry points** (EXTENSION_SPEC §2.5) — `index.js` for notebook-context capabilities, `works.js` for shell-context capabilities. Each runs in its own JS context with its own `window.auditable.registerExtension`.

| Spec section | Slot | Entry file | Where in this extension |
|---|---|---|---|
| §3.1 | `cellType` | `index.js` | `src/cell.js` — parses + executes `/// quip` cells |
| §3.2 | `taggedLanguage` | `index.js` | `src/tag.js` — `quip\`…\`` inside JS code cells |
| §3.5 | `exports` (Python adapter) | `index.js` | `src/adapter.js` — `from quip import …` in adder cells |
| §3.6 | `globals` | `index.js` | `src/register.js` — publishes the `quip` tag globally |
| §3.8 | `surfaces` + `contextMenu` | **`works.js`** | `src/works-register.js` + `surface.html` |
| §6.1 | `.gcupkg` packaging | — | `pack.js` — produces a distributable `.gcupkg` |

Deliberately NOT exercised: AIR lowering (§3.4, see `ext/adder/` for the canonical reference) and the cell-context hook (§3.3, narrow use case, `@gcu/natra` for an example). MCP tools (§3.7) are still pre-manifest.

## Layout

```
ext/example-quip/
├── package.json              — manifest's package.json (matches EXTENSION_SPEC §5.3)
├── LICENSE
├── README.md                 — this file
├── SPEC.md                   — the toy language definition
├── build.js                  — concat-bundle: src/ → index.js + works.js
├── pack.js                   — produces example-quip@<ver>.gcupkg
├── index.js                  — BUILD OUTPUT, notebook-context entry
├── works.js                  — BUILD OUTPUT, shell-context entry
├── surface.html              — the Works surface ("Quip Viewer"), referenced by works.js
├── src/
│   ├── parse.js              — the language parser
│   ├── tokenize.js           — for syntax highlighting (§3.1 / §3.2)
│   ├── cell.js               — cellType handler (parseNames / execute)
│   ├── tag.js                — tagged template
│   ├── adapter.js            — Python-shape namespace
│   ├── register.js           — notebook-context manifest (→ index.js)
│   ├── works-register.js     — shell-context manifest (→ works.js)
│   └── main.js               — import manifest (concat order for index.js)
└── examples/
    ├── manifest.json
    └── quip-tour.txt         — the worked-example notebook
```

## Build + pack

```
cd ext/example-quip
node build.js                 # → ext/example-quip/index.js + works.js
node pack.js                  # → ext/example-quip/@example_quip@0.1.0.gcupkg
```

## Try it

In a notebook or Works:

```js
await install("ext/example-quip/@example_quip@0.1.0.gcupkg");
```

Or drag the `.gcupkg` onto the Works tree. After install, open `examples/quip-tour.txt` from the Help → Open Example picker (or the workspace's `/usr/share/examples/@example_quip/` folder in Works) for the guided tour.

## Use as a template

Fork the directory. The bits to change:

1. `package.json` — `name`, `description`, `keywords`.
2. `src/parse.js` — your language semantics.
3. `src/tokenize.js` — your syntax highlighting (optional).
4. `src/register.js` — notebook-context manifest: `name`, `version`, `cellType.shortcut`, etc.
5. `src/works-register.js` — shell-context manifest: `surfaces[].kind`, `contextMenu[].label`, etc. Drop this file (and the build.js stanza) if your extension contributes no Works UI.
6. `src/adapter.js` — what you expose to adder cells.
7. `surface.html` — your viewer's UI.
8. `pack.js` — the `meta.contributes` array (drop slots you don't use).

The rest (`build.js`, `main.js`, the directory layout) is boilerplate that should stay the same.

## Status

Pre-1.0. The example tracks the spec — when EXTENSION_SPEC.md gains a new section, this extension should grow to demonstrate it.

## License

MIT. See [LICENSE](LICENSE).
