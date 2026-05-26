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

| Spec section | Slot | Where in this extension |
|---|---|---|
| §3.1 | `cellType` | `src/cell.js` — parses + executes `/// quip` cells |
| §3.2 | `taggedLanguage` | `src/tag.js` — `quip\`…\`` inside JS code cells |
| §3.5 | `exports` (Python adapter) | `src/adapter.js` — `from quip import …` in adder cells |
| §3.6 | `globals` | `src/register.js` — publishes the `quip` tag globally |
| §3.8 | `surfaces` + `contextMenu` | `surface.html` — Works viewer; right-click "Export as JSON" |
| §6.1 | `.gcupkg` packaging | `pack.js` — produces a distributable `.gcupkg` |

Deliberately NOT exercised: AIR lowering (§3.4, see `ext/adder/` for the canonical reference) and the cell-context hook (§3.3, narrow use case, `@gcu/natra` for an example). MCP tools (§3.7) are still pre-manifest.

## Layout

```
ext/example-quip/
├── package.json              — manifest's package.json (matches EXTENSION_SPEC §5.3)
├── LICENSE
├── README.md                 — this file
├── SPEC.md                   — the toy language definition
├── build.js                  — concat-bundle of src/ → index.js
├── pack.js                   — produces example-quip@<ver>.gcupkg
├── index.js                  — BUILD OUTPUT (run `node build.js` to refresh)
├── surface.html              — the Works surface ("Quip Viewer")
├── src/
│   ├── parse.js              — the language parser
│   ├── tokenize.js           — for syntax highlighting (§3.1 / §3.2)
│   ├── cell.js               — cellType handler (parseNames / execute)
│   ├── tag.js                — tagged template
│   ├── adapter.js            — Python-shape namespace
│   ├── register.js           — single registerExtension() call
│   └── main.js               — import manifest (concat order)
└── examples/
    ├── manifest.json
    └── quip-tour.txt         — the worked-example notebook
```

## Build + pack

```
cd ext/example-quip
node build.js                 # → ext/example-quip/index.js
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
4. `src/register.js` — manifest fields: `name`, `version`, `cellType.shortcut`, `surfaces[].kind`, `contextMenu[].label`. The rest of the structure stays the same.
5. `src/adapter.js` — what you expose to adder cells.
6. `surface.html` — your viewer's UI (or drop the surface section from `register.js` if you don't need one).
7. `pack.js` — the `meta.contributes` array (drop slots you don't use).

The rest (`build.js`, `main.js`, the directory layout) is boilerplate that should stay the same.

## Status

Pre-1.0. The example tracks the spec — when EXTENSION_SPEC.md gains a new section, this extension should grow to demonstrate it.

## License

MIT. See [LICENSE](LICENSE).
