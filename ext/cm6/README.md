# CM6 — CodeMirror 6 bundle for auditable

Pre-built CodeMirror 6 bundle that gets inlined into `auditable.html` by `build.js`.

## Build

```bash
cd ext/cm6
npm install
node build.js
```

This produces `cm6.min.js` (~490KB minified), which exposes `window.CM6` as an IIFE.

## Update

To update CM6 versions:

1. Edit `package.json` dependency versions
2. `npm install`
3. `node build.js`
4. Rebuild auditable: `node build.js` (from repo root)

## Exported symbols

See `entry.mjs` for the full list. Key exports:

- `EditorView`, `EditorState`, `Compartment`, `StateEffect`, `StateField`
- `keymap`, `lineNumbers`, `highlightActiveLine`, `drawSelection`
- `ViewPlugin`, `Decoration`, `WidgetType`
- `javascript`, `css`, `html` (language modes)
- `indentWithTab`, `toggleComment`, `history`, `undo`, `redo`
- `bracketMatching`, `syntaxHighlighting`, `HighlightStyle`, `syntaxTree`
- `autocompletion`, `CompletionContext`, `closeBrackets`
- `tags` (Lezer highlight tags)

## Future considerations

- Cell-to-cell arrow key navigation: CM6 traps arrow keys within the editor. Need custom keybindings that detect cursor at first/last line and delegate to notebook navigation.
- Custom language modes: tagged template literals (glsl, sql) need ViewPlugin-based decoration since CM6 doesn't natively support embedded languages in tagged templates.
