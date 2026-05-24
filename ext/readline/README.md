# @gcu/readline

**A line editor for browser terminals — history, autosuggest, tab-completion, syntax highlighting, kill ring, all the bash/fish keystrokes.**

Drop-in replacement for the line editor inside [@gcu/geas](https://www.npmjs.com/package/@gcu/geas) (and any other interactive shell-shaped surface), implemented as a single `await readLine({ prompt })` call that returns the line the user typed when they hit Enter. Works against any input adapter that can post key events; ships with a renderer that talks to [@gcu/term](https://www.npmjs.com/package/@gcu/term) or xterm.js.

Pre-1.0 — APIs may change on minor version bumps.

## Install

```sh
npm install @gcu/readline
```

## Quick start

```js
import { createReadline } from '@gcu/readline';

const readLine = createReadline(adapter, {
  history: [],
  complete: (line, cursor) => ['help', 'history', 'exit'],
  highlight: (line) => [{ start: 0, end: 4, ansi: '\x1b[36m' }],
  autosuggestFromHistory: true,
});

while (true) {
  const { line, eof } = await readLine({ prompt: '$ ' });
  if (eof) break;
  if (line) console.log('got:', line);
}
```

`adapter` is anything with an `onInput(handler)` method that fires for each keystroke (xterm.js's `Terminal.onData` works directly). The same shape as `makeLineEditor()` inside geas — they're swappable.

## API

### `createReadline(adapter, opts)`

Returns an `async readLine(lineOpts)` function. Each call resolves to `{ line, eof }`:

- `line` — the string the user committed with Enter (without the trailing newline)
- `eof` — `true` when the user pressed Ctrl+D on an empty line

`opts`:

| Key | Type | Default | Notes |
|---|---|---|---|
| `history` | `string[]` | `[]` | Mutated in place; new lines are appended on commit |
| `complete` | `(line, cursor) => string[]` | none | Tab handler. First Tab fills the longest common prefix or lists candidates; subsequent Tabs cycle |
| `highlight` | `(line) => HighlightSpan[]` | none | Each `{start, end, ansi}` colours a slice of the buffer with an ANSI escape |
| `autosuggestFromHistory` | `bool` | `true` | Fish-style ghost suggestion from history; Right arrow / End accepts |
| `onPersistHistory` | `async (line) => void` | none | Called once per committed line — write to a history file |

`lineOpts` per call:

- `prompt` — the prompt string (with ANSI colour escapes if you like)
- `silent` — true to render `*`s instead of the character (for password input)
- `nChars` — stop after this many characters (for raw `read -n`)
- `delim` — single-character terminator other than `\n`
- `timeout` — milliseconds before the call resolves with whatever's in the buffer

## Key bindings

Matches bash + fish conventions.

| Keystroke | Action |
|---|---|
| ++ctrl+a++ / ++home++ | Move to start of line |
| ++ctrl+e++ / ++end++ | Move to end of line |
| ++ctrl+b++ / ++left++ | Move left one character |
| ++ctrl+f++ / ++right++ | Move right one character (or accept autosuggestion) |
| ++alt+b++ / ++ctrl+left++ | Move left one word |
| ++alt+f++ / ++ctrl+right++ | Move right one word (or accept one word of autosuggestion) |
| ++ctrl+d++ | Delete character right (or EOF on empty line) |
| ++ctrl+h++ / ++backspace++ | Delete character left |
| ++alt+d++ | Kill word right (into kill ring) |
| ++ctrl+w++ | Kill word left |
| ++ctrl+u++ | Kill to start of line |
| ++ctrl+k++ | Kill to end of line |
| ++ctrl+y++ | Yank (paste from kill ring) |
| ++alt+y++ | Yank-pop (cycle the kill ring) |
| ++up++ | Previous history entry |
| ++down++ | Next history entry |
| ++tab++ | Complete / cycle completions |
| ++ctrl+c++ | Abort current line |
| ++ctrl+l++ | Clear the screen |
| ++enter++ | Commit the line |

## Autosuggestions

If `autosuggestFromHistory` is on and the buffer matches the prefix of a previous history entry, the rest of that entry renders dimly to the right of the cursor. Right arrow / End accepts the whole suggestion; ++alt+f++ accepts one word at a time.

## Files

```
ext/readline/
  src/
    api.js       — public createReadline entry point
    editor.js    — buffer + cursor + kill ring + history state machine
    keys.js      — keystroke parser (escape sequences → semantic ops)
    render.js    — buffer → ANSI-rendered prompt line (incremental redraw)
    main.js      — concat manifest
  build.js       — concatenates src/ into index.js
  index.js       — BUILD OUTPUT
```

## What's not supported

- Multi-line editing (no `\` continuations) — single-line buffer only. (geas wraps multi-line scripts at a higher level.)
- Bracketed paste mode — not yet; ++ctrl+y++ + clipboard works.
- ++ctrl+r++ reverse-incremental-search — fish-style autosuggest covers most of the use case for us; reverse search may land later.

## Status

Pre-1.0. Powers geas, the GCU shell, since 2026-05.

## License

MIT.
