# @gcu/term — Specification

**Version**: 0.1 (prototype, descriptive of `index.js`)
**Status**: working code; not yet a published package
**License**: MIT (code), CC0 (this document)

A browser-native VT/ANSI terminal emulator with a generic byte-stream
interface, designed for embedded consoles, REPLs, and log viewers in the
Auditable Works ecosystem. Williams-parser core, DOM renderer, no
dependencies, single file.

This document is the canonical specification. The reference implementation
is `index.js`. The two should remain in lockstep; where they disagree,
this document is the intent and the code is the bug.

---

## Contents

1. [Goals and non-goals](#1-goals-and-non-goals)
2. [Architecture](#2-architecture)
3. [The byte-stream contract](#3-the-byte-stream-contract)
4. [VT/ANSI parser](#4-vtansi-parser)
5. [Terminal state model](#5-terminal-state-model)
6. [Supported control sequences](#6-supported-control-sequences)
7. [SGR (Select Graphic Rendition)](#7-sgr-select-graphic-rendition)
8. [DEC private modes](#8-dec-private-modes)
9. [OSC commands](#9-osc-commands)
10. [DOM Renderer](#10-dom-renderer)
11. [Input handler](#11-input-handler)
12. [Required host CSS](#12-required-host-css)
13. [Integration patterns](#13-integration-patterns)
14. [Known limitations](#14-known-limitations)
15. [Roadmap](#15-roadmap)
16. [Performance characteristics](#16-performance-characteristics)
17. [References](#17-references)

---

## 1. Goals and non-goals

### Goals

- **Single-file, zero-dependency** library suitable for embedding in any
  browser-runtime application without a build step.
- **Generic byte-stream interface**: the emulator consumes bytes and emits
  bytes. It does not know or care about the host on the other side. A real
  PTY over WebSocket, an in-page interpreter like adder, a recorded session
  replayer, and a unit-test mock are all the same to it.
- **Embeddable**: small (≈20 KB minified, ≈6 KB gzipped), self-contained,
  no global side effects, no global event listeners outside the host
  element it is mounted in (after `Input.dispose()`).
- **Correct enough for real TUIs**: vim, htop, less, mc, nano, ncurses
  applications, and REPLs all render correctly out of the box for the
  features the spec covers.
- **Accessible by default**: the canonical renderer uses real DOM with
  `role="log"` and `aria-live="polite"`, so screen readers announce
  output without additional plumbing.
- **Small surface, big leverage**: prefer browser primitives over
  reimplementation. Native selection, native clipboard, native font
  rendering, native search are all free when the renderer is DOM.

### Non-goals

- **Not a replacement for xterm.js at scale.** xterm.js targets
  high-throughput log viewers, terminal multiplexers, and remote-shell
  apps with strict performance budgets. `@gcu/term` is intentionally
  smaller and accepts performance compromises (single renderer, redraw on
  any change, simple cell model) that xterm.js would not.
- **No BIDI / RTL.** Not implemented. Will not be implemented.
- **No Sixel, no iTerm2 image protocol, no kitty graphics.** Out of
  scope.
- **No legacy compatibility** for terminal types older than VT100/xterm.
- **No plugin / addon API**. The package is curated. If something is
  missing, it goes into the package.

---

## 2. Architecture

`@gcu/term` is composed of four cooperating layers:

```
  bytes in                                  bytes out
     │                                          ▲
     ▼                                          │
  ┌──────────┐    ┌──────────────┐    ┌────────────────┐
  │  Parser  │───▶│   Terminal   │◀───│     Input      │
  │ (state   │    │  (cells +    │    │ (keyboard,     │
  │  machine)│    │   cursor +   │    │  mouse,        │
  └──────────┘    │   attrs +    │    │  paste,        │
                  │   modes)     │    │  selection)    │
                  └──────────────┘    └────────────────┘
                          │                    ▲
                          ▼                    │
                  ┌──────────────────────────────────┐
                  │           DomRenderer            │
                  │  (rows of <span> runs in DOM)    │
                  └──────────────────────────────────┘
```

- **Parser** turns a stream of codepoints into semantic events
  (`print(cp)`, `execute(cp)`, `csi(params, intermediates, final)`,
  `osc(data)`, `esc(intermediates, final)`).
- **Terminal** is the state model: cell buffers, cursor, attributes,
  modes, alternate screen, scroll region. It implements the parser's
  handler interface and exposes `write(bytes)` and `onData(cb)` as its
  public byte-stream API.
- **DomRenderer** reads the Terminal's cell state and projects it into
  the DOM as one `<div>` per row, with attribute-coalesced `<span>` runs
  inside each row.
- **Input** captures user events (keyboard via a hidden textarea, mouse
  on the screen container, paste via the textarea's native paste event)
  and translates them into bytes sent through the Terminal's outbound
  byte-stream.

The layers communicate only through narrow, named interfaces. The Parser
is independent of any rendering. The Terminal is independent of any input
device. The Renderer and Input share a coordinate system (cell-grid)
but are otherwise decoupled.

---

## 3. The byte-stream contract

The Terminal exposes exactly two methods for byte-stream interop:

### `term.write(input)`

Push bytes *into* the terminal (i.e., output from the host program).
`input` may be a `string` (interpreted as UTF-8 text), a `Uint8Array`
(decoded as UTF-8), or any value the platform's `TextDecoder` accepts.

Returns nothing. Idempotent under same input. Synchronous and immediate;
the terminal state is updated before the call returns. Rendering happens
on the next animation frame.

**Re-entrancy.** `write` may safely be called from inside an `onData`
callback or from a cursor-blink tick — the parser is purely synchronous
and holds no mutable state between bytes within a `write` call. A
subsequent `write` started while another is in progress is *not*
explicitly defined and should be avoided; in practice the renderer's
once-per-frame model means re-entrant writes are rare.

### `term.onData(callback)`

Subscribe to bytes *coming out of* the terminal (i.e., keystrokes, mouse
events, terminal replies to host queries). The callback receives a
`Uint8Array` of UTF-8-encoded bytes.

Returns an unsubscribe function:

```js
const off = term.onData(bytes => websocket.send(bytes));
// ...later...
off();
```

Multiple subscribers are supported. Listeners are invoked synchronously
and in subscription order.

**Listener exception policy.** Listener exceptions are caught by the
emulator and logged via `console.error` (best-effort; ignored if no
console exists). A single misbehaving listener cannot interrupt the rest
of the chain or the in-progress CSI handler that triggered the send.
Hosts that need stricter error propagation should wrap their listener
body in their own error-handling logic.

### `term.onText(callback)`

Convenience subscription: same semantics as `onData`, but the callback
receives an already-decoded `string` instead of a `Uint8Array`. Most
consumers want the string form. Internally this uses a single shared
`TextDecoder` (one decoder per Terminal, not one per fanout). Returns
an unsubscribe function.

### `term.onBell(callback)`

Subscribe to BEL (`0x07`). The callback receives no arguments — fire is
the signal. Hosts decide what to do (sound, screen flash, status badge,
ignore). Returns an unsubscribe function.

### `term.onTitleChange(callback)`

Subscribe to OSC 0/1/2 window-title changes. The callback receives the
new title `string`. The library does **not** mutate `document.title` on
its own — mirroring to the document title is an opt-in side effect the
host configures explicitly:

```js
term.onTitleChange(t => document.title = `MyApp — ${t}`);
```

Returns an unsubscribe function.

### Lifecycle: `term.dispose()`

Detach all listeners (data / bell / title), drop both cell buffers, and
mark the terminal inert. Subsequent `write()` and `_send()` are no-ops.
Idempotent. Hosts call this when the terminal is no longer needed (cell
re-run, tab close) so the cell buffers and listener closures can be
collected. Use alongside `Input.dispose()` and `DomRenderer.dispose()`
— the three layers each own their own resources.

### Symmetry

This is the same contract on both sides. A host program writes bytes to
the terminal; the terminal writes bytes back to the host. The host might
be a PTY, an interpreter, a mock, or another terminal. The contract does
not specify.

---

## 4. VT/ANSI parser

The parser implements Paul Williams' state machine from
[vt100.net/emu/dec_ansi_parser](https://vt100.net/emu/dec_ansi_parser),
lightly adapted for codepoint-rather-than-byte input.

### Why codepoints rather than bytes

The canonical Williams parser was designed for 8-bit terminals and
operates on bytes. In a UTF-8 environment, we run a `TextDecoder` upstream
of the parser and feed it codepoints (as integers from `String.codePointAt`).
This works because:

- Every control byte that drives a state transition is in the 7-bit ASCII
  range (`0x00`–`0x7F`) and survives UTF-8 decoding unchanged.
- Codepoints `>= 0x20` (and `!= 0x7F`) are all printable for our purposes
  and are handled by the `print` action in any state where they apply.

The C1 control range (`0x80`–`0x9F`) is supported for completeness when
the upstream decoder happens to deliver such codepoints (e.g., legacy
encodings); in practice this rarely happens with UTF-8 input.

### States

| State | Constant | Description |
|---|---|---|
| Ground | `S_GROUND` | Normal input; printable → `print`, controls → `execute` |
| Escape | `S_ESCAPE` | Saw `ESC`; awaiting next byte |
| Escape intermediate | `S_ESC_INT` | `ESC` followed by intermediate bytes |
| CSI entry | `S_CSI_ENTRY` | Saw `CSI` (`ESC [`); awaiting parameters |
| CSI param | `S_CSI_PARAM` | Collecting parameter bytes |
| CSI intermediate | `S_CSI_INT` | Collecting intermediate bytes |
| CSI ignore | `S_CSI_IGNORE` | Malformed; swallow until final byte |
| OSC string | `S_OSC_STRING` | Collecting OSC payload |
| DCS entry | `S_DCS_ENTRY` | DCS introduced; payload ignored |
| DCS ignore | `S_DCS_IGNORE` | DCS in progress; ignoring |
| SOS/PM/APC string | `S_SOSPMAPC` | Strings we don't process; consumed |

### Handler interface

The parser is parameterized over a handler object with these methods:

- `print(codepoint: number)` — a printable codepoint should be placed at
  the cursor and the cursor advanced.
- `execute(codepoint: number)` — a C0 or C1 control byte should be acted
  on (BS, LF, CR, BEL, etc.).
- `csi(params: number[], intermediates: string, final: number)` — a
  complete CSI sequence has been parsed; dispatch by `final` byte.
- `osc(data: string)` — a complete OSC string has arrived; the data is
  the payload between `ESC ]` and the terminator (`BEL` or `ST`).
- `esc(intermediates: string, final: number)` — a complete ESC sequence
  (not CSI/OSC/DCS/etc.) has been parsed.

DCS and SOS/PM/APC strings are consumed but no handler method is invoked
for them in this version.

### Parameter parsing

CSI parameters use ECMA-48 semantics: `;` separates parameters, digits
build the current parameter, and zero is the default value for any
missing or empty parameter.

Sub-parameter form (using `:` as separator within a parameter) is
supported for SGR truecolor — both `38;2;R;G;B` and `38:2::R:G:B` are
accepted, though `:` sub-parameters are not preserved as separate values
in the params array; they are flattened. This is sufficient for the SGR
forms in practice but is a known limitation for any future use of
sub-parameters in other CSI sequences.

A `?` prefix byte (DEC private parameter prefix) is collected in the
`intermediates` string and dispatched as a private-mode CSI.

### Reset

`parser.reset()` returns the parser to ground state and clears any
collected parameters or strings. Called automatically on hard reset
(`RIS`, `ESC c`).

---

## 5. Terminal state model

### Cells

Each cell is a JavaScript object with four properties:

```js
{
  ch: number,      // Unicode codepoint (default 0x20 = space)
  fg: ColorRef,    // foreground color
  bg: ColorRef,    // background color
  flags: number,   // bitmask of attribute flags
}
```

#### ColorRef

A color reference is one of three discriminated-union forms:

| Form | Meaning |
|---|---|
| `{t: 'd'}` | Default; renderer picks from theme |
| `{t: 'p', i: number}` | Palette index (0–255) |
| `{t: 'r', r: number, g: number, b: number}` | 24-bit RGB truecolor |

The sentinels `DEFAULT_FG` and `DEFAULT_BG` are frozen instances of
`{t: 'd'}` used to avoid allocation when SGR resets occur.

#### Flags

Bitmask values defined as exported constants:

| Flag | Value | SGR set | SGR reset |
|---|---|---|---|
| `FLAG_BOLD` | `1 << 0` | `1` | `22` |
| `FLAG_DIM` | `1 << 1` | `2` | `22` |
| `FLAG_ITALIC` | `1 << 2` | `3` | `23` |
| `FLAG_UNDER` | `1 << 3` | `4` | `24` |
| `FLAG_BLINK` | `1 << 4` | `5` | `25` |
| `FLAG_REVERSE` | `1 << 5` | `7` | `27` |
| `FLAG_INVIS` | `1 << 6` | `8` | `28` |
| `FLAG_STRIKE` | `1 << 7` | `9` | `29` |

`FLAG_BLINK` is recorded on the cell when SGR `5` is received but the
default DOM renderer does **not** render it as actual blinking text — the
per-frame animation cost isn't justified for a feature most modern
terminals also de-emphasize. Hosts that want true blinking can subclass
`DomRenderer` or read `FLAG_BLINK` directly during render to drive their
own animation.

### Buffer

The terminal maintains a 2D array of cells: `buffer[row][col]` where row
0 is the top. A separate `altBuffer` is allocated on demand when an app
switches to the alternate screen (DECSET 1049 or 47/1047).

`term.resize(cols, rows)` adjusts dimensions in place WITHOUT reflowing
previously-wrapped lines (that's the genuinely hard case, on the v1.0
roadmap). Width changes pad / truncate every row in both buffers and
in scrollback. Height growth appends empty rows; height shrink drops
rows from the top — pushing them to scrollback ONLY for the primary
buffer when not currently in alt-screen. Cursor clamps; scroll region
resets to full-screen.

Hosts call `term.resize(cols, rows)` then `renderer.resize()` so the
row `<div>`s and the container's pixel dimensions update together.

### Cursor

The cursor has integer `x` (column, 0-based) and `y` (row, 0-based)
coordinates. A `pendingWrap` boolean implements the DECAWM "phantom
column" semantics: when the cursor is at the rightmost column and a
character is printed, the cursor is *not* immediately wrapped — it stays
in the phantom column position. A subsequent `print` will first wrap to
the next line. A subsequent cursor-movement CSI clears the phantom flag.

This is the same behavior as xterm and is required for correct line
wrapping in vim and other editors.

### Saved cursor

`DECSC` (`ESC 7`), CSI `s`, and DECSET 1048 save the cursor's `x`, `y`,
`fg`, `bg`, and `flags` to a separate slot. `DECRC` (`ESC 8`), CSI `u`,
and DECRST 1048 restore them.

DECSET 1049 (alt-screen enter) implicitly saves the cursor before
switching; DECRST 1049 (alt-screen exit) implicitly restores it.

### Scroll region

`scrollTop` and `scrollBottom` (inclusive, 0-based row indices) define
the active scroll region. By default `scrollTop = 0` and
`scrollBottom = rows - 1`. The region is modified by DECSTBM (CSI `r`).
Line feed at the scroll bottom causes the region to scroll up by one;
reverse index at the scroll top scrolls it down.

`IL` (insert lines) and `DL` (delete lines) only operate when the cursor
is inside the scroll region.

### Scrollback

Rows that scroll off the top of the **primary** buffer's full-screen
scroll region (`scrollTop === 0 && scrollBottom === rows - 1`) are
pushed onto `term.scrollback` (oldest first). Capped at
`term.maxScrollback` (default 1000; configurable via the `Terminal`
constructor's third options argument: `new Terminal(80, 24,
{ maxScrollback: 5000 })`).

Three deliberate exclusions:

1. **Alt-screen never feeds scrollback.** Apps that use the alt screen
   (vim, less, htop) own their own scrollback and would double-up if we
   captured rows there too.
2. **DECSTBM-shrunk regions don't push.** A status-bar-style app that
   carves a scroll region within the screen and scrolls inside it is
   doing app-driven layout work, not producing history.
3. **Hard reset (RIS) clears scrollback** along with everything else.

The `DomRenderer` reads `term.scrollback` to compose the viewport when
its `scrollOffset` is non-zero (see §10).

### Modes

A `modes` object holds boolean and integer toggles. The relevant ones:

| Mode | Default | Set/reset |
|---|---|---|
| `wrap` | `true` | DECSET/DECRST 7 |
| `cursorVisible` | `true` | DECSET/DECRST 25 |
| `appCursor` | `false` | DECSET/DECRST 1 |
| `appKeypad` | `false` | `ESC =` / `ESC >` |
| `mouseProto` | `0` | DECSET 1000/1002/1003 (one active at a time) |
| `mouseEncoding` | `0` | DECSET 1006 |
| `bracketedPaste` | `false` | DECSET/DECRST 2004 |
| `reverseVideo` | `false` | DECSET/DECRST 5 |

`mouseProto` and `mouseEncoding` are typed as integers (0 means off; any
non-zero value is a specific protocol/encoding number). They retain their
integer type across hard reset (`RIS`) — the implementation rebuilds the
mode object from a `defaultModes()` factory rather than blindly setting
each key to `false`. Code that compares `modes.mouseProto === 1000` will
read correctly after reset.

Unrecognized DECSET/DECRST modes are silently ignored.

### Outbound queue

`term._send(string)` is the internal entry point that pushes bytes out
to all `onData` subscribers. It is called by:

- CSI handlers responding to DSR/DA queries
- Input class for keystrokes, mouse sequences, paste, etc.

External code should not call `_send` directly; it is part of the
internal API and may be renamed.

Listener exception handling is described in §3.

---

## 6. Supported control sequences

This section enumerates every control sequence the terminal recognizes.
Sequences not listed are silently consumed without effect.

### C0 controls (single bytes in ground state)

| Hex | Name | Action |
|---|---|---|
| `0x07` | BEL | (no-op; reserved for future host notification) |
| `0x08` | BS | Backspace: cursor left one column (no wrap) |
| `0x09` | HT | Tab: move to next 8-column tab stop |
| `0x0A` | LF | Line feed: cursor down one row, scrolling if at bottom |
| `0x0B` | VT | Same as LF |
| `0x0C` | FF | Same as LF |
| `0x0D` | CR | Carriage return: cursor to column 0; clears phantom wrap |

### ESC (non-CSI) sequences

| Sequence | Name | Action |
|---|---|---|
| `ESC 7` | DECSC | Save cursor |
| `ESC 8` | DECRC | Restore cursor |
| `ESC c` | RIS | Reset to Initial State (hard reset) |
| `ESC D` | IND | Index (line feed) |
| `ESC E` | NEL | Next Line (CR + LF) |
| `ESC M` | RI | Reverse Index (cursor up, scrolling at top) |
| `ESC =` | DECPAM | Application keypad mode on |
| `ESC >` | DECPNM | Application keypad mode off |
| `ESC ( c` | SCS G0 | Designate character set `c` into G0 |
| `ESC ) c` | SCS G1 | Designate character set `c` into G1 |

`SO` (`0x0E`) selects G1 as the active charset; `SI` (`0x0F`) selects
G0. See §10.5 for the supported charset designators.

### CSI sequences

Notation: parameters are 1-based and default to the value in parentheses
when omitted. `P1`, `P2` etc. denote the first, second parameter.

| Final | Sequence | Name | Action |
|---|---|---|---|
| `@` | `CSI Pn @` | ICH | Insert blank chars (1) |
| `A` | `CSI Pn A` | CUU | Cursor up (1), clipped to scroll region |
| `B` | `CSI Pn B` | CUD | Cursor down (1), clipped |
| `C` | `CSI Pn C` | CUF | Cursor forward (1) |
| `D` | `CSI Pn D` | CUB | Cursor back (1) |
| `E` | `CSI Pn E` | CNL | Cursor next line (1), x=0 |
| `F` | `CSI Pn F` | CPL | Cursor previous line (1), x=0 |
| `G` | `CSI Pn G` | CHA | Cursor horizontal absolute (1) |
| `H` | `CSI P1;P2 H` | CUP | Cursor position (row=1, col=1) |
| `J` | `CSI Pn J` | ED | Erase display: 0=to end, 1=to start, 2=all |
| `K` | `CSI Pn K` | EL | Erase line: 0=to end, 1=to start, 2=all |
| `L` | `CSI Pn L` | IL | Insert lines (1), within scroll region |
| `M` | `CSI Pn M` | DL | Delete lines (1), within scroll region |
| `P` | `CSI Pn P` | DCH | Delete chars (1) |
| `S` | `CSI Pn S` | SU | Scroll up (1) |
| `T` | `CSI Pn T` | SD | Scroll down (1) |
| `X` | `CSI Pn X` | ECH | Erase chars (1) |
| `c` | `CSI c` | DA | Device Attributes; replies `ESC[?6c` (VT102) |
| `d` | `CSI Pn d` | VPA | Vertical Position Absolute (1) |
| `f` | `CSI P1;P2 f` | HVP | Horizontal Vertical Position (same as CUP) |
| `h` | `CSI ? Pm h` | DECSET | Set DEC private mode (§8) |
| `l` | `CSI ? Pm l` | DECRST | Reset DEC private mode (§8) |
| `m` | `CSI Pm m` | SGR | Select Graphic Rendition (§7) |
| `n` | `CSI Pn n` | DSR | Device Status Report: 5 → `ESC[0n`, 6 → cursor pos |
| `r` | `CSI P1;P2 r` | DECSTBM | Set scroll region (top=1, bottom=rows) |
| `s` | `CSI s` | SCOSC | Save cursor (ANSI form) |
| `u` | `CSI u` | SCORC | Restore cursor (ANSI form) |

### Cursor position report

A DSR 6 (`CSI 6 n`) causes the terminal to send back
`CSI {row} ; {col} R` with 1-based coordinates.

### Device attributes

A `CSI c` (DA primary) causes the terminal to send back `CSI ? 6 c`
identifying as a VT102. This is required for ncurses-based applications
and tmux to start up correctly; without it they may hang or assume the
worst-case fallback terminal type.

---

## 7. SGR (Select Graphic Rendition)

CSI `m` sets graphic attributes. Parameters are processed left to right.
Default parameter is `0` (reset).

### Attribute parameters

| Parameter | Effect |
|---|---|
| `0` | Reset all attributes and colors to default |
| `1` | Bold |
| `2` | Dim |
| `3` | Italic |
| `4` | Underline |
| `5` | Blink — `FLAG_BLINK` is set on the cell; default renderer ignores it (see §5) |
| `7` | Reverse video (swap fg/bg) |
| `8` | Invisible |
| `9` | Strikethrough |
| `22` | Reset bold + dim |
| `23` | Reset italic |
| `24` | Reset underline |
| `25` | Reset blink |
| `27` | Reset reverse |
| `28` | Reset invisible |
| `29` | Reset strikethrough |

### Foreground colors

| Parameter | Color |
|---|---|
| `30`–`37` | Palette 0–7 (basic 16-color, dim half) |
| `38;5;N` or `38:5:N` | Palette N (256-color) |
| `38;2;R;G;B` or `38:2::R:G:B` | RGB truecolor |
| `39` | Default foreground |
| `90`–`97` | Palette 8–15 (basic 16-color, bright half) |

### Background colors

Same as foreground, with `40`–`47`, `48`, `49`, `100`–`107`.

### Combined example

`CSI 1 ; 3 ; 4 ; 38 ; 5 ; 215 m` sets bold + italic + underline + palette
color 215 as foreground.

### Reset semantics

`CSI m` and `CSI 0 m` both reset everything: flags to 0, fg to default,
bg to default. They are equivalent.

---

## 8. DEC private modes

CSI `? Pm h` sets a mode; CSI `? Pm l` resets it.

| Mode | Default | DECSET (h) | DECRST (l) |
|---|---|---|---|
| `1` | off | Application cursor keys on | Application cursor keys off |
| `5` | off | Reverse video on (whole screen) | Reverse video off |
| `7` | on | Auto-wrap on | Auto-wrap off |
| `25` | on | Cursor visible | Cursor hidden |
| `47` | off | Use alternate screen | Use normal screen |
| `1000` | off | X11 mouse tracking | Disable |
| `1002` | off | Button-event tracking | Disable |
| `1003` | off | Any-event tracking | Disable |
| `1006` | off | SGR mouse encoding | Disable |
| `1047` | off | Alternate screen (same as 47) | Normal screen |
| `1048` | — | Save cursor | Restore cursor |
| `1049` | off | Save cursor + alt screen + clear | Restore + normal screen |
| `2004` | off | Bracketed paste on | Bracketed paste off |

### Application cursor keys

When mode 1 is set, cursor key sequences use the `SS3` prefix (`ESC O`)
instead of `CSI` (`ESC [`). This is required by vim and other readline
consumers, which use it to distinguish arrows-as-navigation from
arrows-typed-into-a-text-field.

| Key | Normal | Application |
|---|---|---|
| Up | `ESC [ A` | `ESC O A` |
| Down | `ESC [ B` | `ESC O B` |
| Right | `ESC [ C` | `ESC O C` |
| Left | `ESC [ D` | `ESC O D` |

### Alternate screen

When mode 47/1047/1049 is set, the terminal allocates a second buffer
and renders it instead of the primary buffer. When the mode is cleared,
the alternate buffer is discarded and the primary buffer becomes visible
again.

Mode 1049 additionally implicitly saves the cursor on enter and
restores it on exit. Mode 47 and 1047 do not; programs using those
modes are expected to save/restore the cursor themselves.

### Mouse tracking

See §11 (Input handler) for the encoding and bytes-on-the-wire details.
The DEC mode bits here control *which* mouse events get reported:

- `1000`: button press and release only
- `1002`: button press, release, and motion while a button is held
- `1003`: all mouse events including motion without buttons

Only one tracking mode is active at a time; setting one implicitly
clears the others. `1006` is independent and controls the *encoding*
of the report.

---

## 8a. Character sets (G0 / G1)

The terminal maintains two charset slots, `G0` and `G1`, each holding
a designator character. The active GL slot (G0 by default) is consulted
by `print(cp)` to translate codepoints in the 0x60-0x7E range.

| Designator | Character set |
|---|---|
| `B` | USASCII (default; pass-through) |
| `0` | DEC Special Graphics — line drawing + math glyphs |

The DEC Special Graphics map (used when the active slot is `0`):

| ASCII | Glyph | Codepoint |
|---|---|---|
| `j` `k` `l` `m` | `┘` `┐` `┌` `└` | corners |
| `q` `x` | `─` `│` | horizontal / vertical |
| `t` `u` `v` `w` `n` | `├` `┤` `┴` `┬` `┼` | tee + cross |
| `f` `g` `y` `z` `{` `\|` `}` `~` | `°` `±` `≤` `≥` `π` `≠` `£` `·` | math + currency |
| `_` `a` | `◆` `▒` | filled glyphs |

Other designators are kept verbatim in the slot but the print path
only branches on `0`. UK (`A`), DEC technical (`>`), and various
national replacement charsets are out of scope.

`SI`/`SO` (`0x0F` / `0x0E`) toggle the active slot at runtime — apps
typically designate G1 once with `ESC ) 0` and then SO/SI in and out
of line-drawing mode for box rendering. `ESC ( 0` / `ESC ( B` rebind
G0 instead and are simpler when only one charset is needed.

Hard reset (`RIS`) returns both slots to `B` and the active slot to G0.

## 9. OSC commands

OSC commands are introduced by `ESC ]`, followed by a numeric command
code, a `;`, the payload, and terminated by `BEL` (`0x07`) or `ST`
(`ESC \`).

| Command | Name | Action |
|---|---|---|
| `0`, `1`, `2` | Window title | Set `term.title`; mirror to `document.title` if available |
| `8` | Hyperlink | Recognized; no-op in this version (see Roadmap §15) |

Unrecognized OSC commands are silently ignored.

---

## 10. DOM Renderer

The canonical renderer projects the Terminal's cell state into the DOM.

### DOM structure

The renderer is attached to a host element (typically a `<div>`):

```html
<div id="screen" class="screen"
     role="log" aria-live="polite" aria-atomic="false">
  <div class="row"><span>...</span><span style="...">...</span>...</div>
  <div class="row">...</div>
  ...
  <div class="cur"></div>   <!-- cursor overlay -->
</div>
```

- One `<div class="row">` per row in the terminal buffer.
- Each row contains zero or more `<span>` elements, each one a *run* of
  consecutive cells sharing the same SGR attributes.
- A single `<div class="cur">` lives at the end as a positioned overlay;
  it does not belong to any row.

### Per-frame render

`renderer.render()` performs three passes:

1. **Row diff and update.** For each row, the renderer computes the HTML
   string that would represent that row and compares it to the
   previously-rendered HTML for the same row. If identical, the row is
   skipped entirely (no DOM mutation). If different, the row's
   `innerHTML` is replaced.
2. **Cursor overlay update.** The cursor's position, size, and visibility
   are updated based on the terminal's cursor state and the cursor blink
   phase.
3. **Mouse-tracking class sync.** A CSS class `.app-mouse` is toggled on
   the screen container based on whether an application has enabled
   mouse tracking. This allows CSS to disable text-selection visuals
   while mouse-tracking is active.

### Run coalescing

Within a row, consecutive cells with identical SGR attributes are merged
into a single `<span>`. A typical 80-column row has 1–10 spans, not 80.
For an idle terminal (no SGR variety), a whole row collapses to a single
`<span>`. This both reduces DOM node count and improves browser style-recalc
costs.

### Style attribute generation

For each unique attribute combination encountered in a row, the renderer
generates a CSS inline-style string:

```
color:{fg-css}; background:{bg-css}; font-weight:bold; opacity:.6;
font-style:italic; text-decoration:underline line-through;
visibility:hidden;
```

Only the parts that differ from defaults are emitted. A cell with no
attributes generates `<span>` with no `style` attribute (browser uses
inherited styles).

### Cursor

The cursor is an absolutely-positioned overlay with `mix-blend-mode:
difference`. This inverts the cell underneath, including its text,
without requiring the renderer to re-write the row when the cursor blinks.

Cursor blink is host-driven: an external tick should toggle
`renderer.cursorOn` and set `term.dirty = true` to schedule a redraw.
A typical blink interval is 530ms.

### Cell measurement

On construction, the renderer measures the rendered width of `'M'` and
the line height of an empty row, both inside the screen container so
that fonts and line-height inherit correctly. These measurements lock
the screen's pixel dimensions immediately — the container's `width` and
`height` are set to `cellW * cols` and `cellH * rows`.

**Web fonts must be ready before construction.** If a custom monospace
font finishes loading after the renderer is built, the `'M'` measurement
is taken in the fallback font and the screen is permanently sized to
that. When the real font swaps in, every cell is rendered at a slightly
different pixel width, making cursor positioning and mouse hit-testing
off across the whole screen until the host reloads. Production embedders
**must** `await document.fonts.ready` before instantiating the renderer.

### Viewport + scrollback rendering

When `term.scrollback` is non-empty and `renderer.scrollOffset > 0`,
the renderer composes the viewport from a tail of `scrollback` followed
by a leading slice of the active buffer. `scrollOffset = N` means N
rows of scrollback are visible above the active buffer's contents; the
last `rows - N` rows of the active buffer are visible below. Clamped
each frame against the current scrollback length (which can shrink
under `maxScrollback` eviction).

While `scrollOffset > 0`, the cursor overlay is hidden if its logical
y position would land below the visible viewport. This avoids the
illusion that an active typing position is somewhere in your history.

`renderer.scrollBy(delta)` adjusts the offset (negative = scroll up
into history, positive = scroll down toward live). `renderer.scrollToBottom()`
snaps back. The `Input` layer wires both to mouse wheel (when no app
mouse tracking) and to Shift+PgUp / Shift+PgDn — bare PgUp/PgDn still
go to the host so vim and friends keep working.

### Theme integration

Two layered mechanisms — use whichever fits the host.

**1. Constructor `theme` (static or programmatic).**

```js
new DomRenderer(term, container, { theme: {
  palette: (idx, layer) => {
    // idx is 0-255, layer is 'fg' | 'bg'
    if (idx < 16) return getCssVar(`--my-term-color-${idx}`);
    return null;  // fall back to built-in PAL256
  },
  defaultFg: getCssVar('--my-term-fg'),
  defaultBg: getCssVar('--my-term-bg'),
}})
```

Recognized keys:

- `palette`: either a 16-color array or a `(idx, layer) => string | null`
  function. Returning `null` falls through to the next theme source.
- `defaultFg` / `defaultBg`: CSS colors used when a cell carries the
  DEFAULT sentinel.

`renderer.setTheme(theme)` hot-swaps and forces a full re-render. The
previous palette / defaults are dropped.

**2. CSS custom properties (opt in via `{ cssVarTheme: true }`).**

```js
const renderer = new DomRenderer(term, screen, { cssVarTheme: true });
```

Then in CSS, override variables on the host element (or any ancestor):

```css
.screen { --gcu-term-fg: #c8cdd4; --gcu-term-bg: #0a0c10; }
.screen.theme-amber {
  --gcu-term-fg: #ffb86c;
  --gcu-term-bg: #1a1410;
  --gcu-term-color-3: #ffb86c;
  ...
}
```

Recognized variables:
- `--gcu-term-bg` / `--gcu-term-fg` — default cell colors
- `--gcu-term-color-{0..15}` — basic 16-color palette overrides
- `--gcu-term-cursor` — cursor color (read by CSS, not by JS)

The renderer reads these via `getComputedStyle` once per frame and
detects changes via a signature comparison so a CSS theme swap (toggling
a class on the host) forces a full repaint on the next frame. Indices
16-255 still come from the built-in `PAL256`; cell 0-15 overrides are
what the standard ANSI 16-color terminal output uses.

**Resolution order**, when both mechanisms are present:

1. Constructor theme palette / defaultFg / defaultBg (if non-null)
2. CSS custom property (if set and cssVarTheme is on)
3. Built-in `PAL256` (palette only, indices 0-255)
4. `null` — emits no color declaration; browser inherits from CSS

Use one or the other, not both, unless you specifically want the
constructor-theme override semantics (e.g. an "always-amber-on-error"
view that wins over the host theme).

### What the renderer does *not* do

- It does not own the cell buffer; it reads from `term._curBuf()`.
- It does not handle input; that is Input's job.
- It does not implement selection; the browser does.
- It does not blink the cursor on its own; an external tick must call it.

### Lifecycle: `renderer.dispose()`

Removes every DOM node the renderer created (rows + cursor overlay) and
drops the references. Idempotent. Hosts call this when the host element
is being torn down so the renderer's row arrays can be collected. Use
alongside `Input.dispose()` and `Terminal.dispose()`.

---

## 11. Input handler

The Input layer captures user actions and produces bytes that are sent
through `term._send(...)` to all `onData` subscribers.

### The hidden-textarea pattern

A `<textarea>` is positioned absolutely on top of the screen container,
sized to fill it, with the following critical CSS:

```css
position: absolute;
top: 0; left: 0;
width: 100%; height: 100%;
opacity, color, background, caret-color: transparent;
pointer-events: none;
z-index: 1;
```

`pointer-events: none` means mouse events fall through to the screen
underneath; the textarea exists *only* as the keyboard / paste / IME
target. The screen handles mouse; the textarea handles keys.

This pattern is necessary because:

- **Canvas (and naked `<div>`) cannot reliably receive `paste` events.**
  Paste events fire on `<input>`, `<textarea>`, and `contenteditable`
  elements. A focused canvas with `tabindex` does not receive them.
- **Programmatic clipboard read requires permission** (and fails in
  sandboxed iframes). The native paste event on a focused textarea does
  not require any permission and works in all contexts.
- **IME composition events** (`compositionstart`, `compositionend`)
  also require a real text-editing element. The textarea handles
  Japanese / Chinese / Korean input compositions natively.

### Focus management

The textarea is focused at construction. On any mousedown on the
screen, `e.preventDefault()` is called (to prevent the browser from
re-stealing focus to body) and `hidden.focus()` is called synchronously
to ensure focus stays on the textarea.

This requires the renderer to handle selection manually (§ below)
because `preventDefault` on mousedown also disables the browser's
native selection-start.

### Keyboard mapping

For each `keydown` event on the textarea:

1. **Copy chord** (Cmd+C on Mac, Ctrl+Shift+C otherwise): if there is a
   non-empty document selection, the handler returns without
   `preventDefault`, allowing the browser to copy natively.
2. **Paste chord** (Cmd+V on Mac, Ctrl+V or Ctrl+Shift+V otherwise): the
   handler returns without `preventDefault`. The browser's native paste
   then fires a `paste` event on the textarea, which the handler
   processes (see Paste below).
3. **Named special keys** (Enter, Backspace, Tab, Escape, Arrows, Home,
   End, PageUp, PageDown, Delete, Insert, F1–F12): mapped to their
   standard byte sequences. Arrows use the `ESC [` prefix in normal
   mode and `ESC O` prefix in application cursor mode.
4. **Ctrl-letter**: converted to its C0 byte (Ctrl+A → `0x01`,
   Ctrl+C → `0x03`, etc.).
5. **Alt-letter** (Alt+key when key is a single character): prefixed
   with `ESC` (Meta convention).
6. **Plain character**: sent as-is.

IME composition is detected via `compositionstart` / `compositionend`;
during composition, keydown events are suppressed and the composed text
is sent on `compositionend` via `e.data`.

### Mouse

Mouse events on the screen container drive two distinct flows:

#### App mouse tracking

If `mouseProto` is non-zero and shift is **not** held, mouse events are
encoded according to the active tracking mode and encoding and sent
through `term._send`. The shift-held bypass is the user's escape valve
into native text selection while a TUI program is consuming the mouse
— xterm convention, universally expected. See encoding details below.

#### Local selection

If app mouse tracking is off, or shift is held:

- **mousedown**: `caretRangeFromPoint(x, y)` (or `caretPositionFromPoint`
  on Firefox) resolves the click into a text-node/offset pair. A new
  `Range` is created at that point and made the document's selection.
  On double-click (`detail === 2`), `selection.modify` extends the
  selection by word in both directions. On triple-click (`detail >= 3`),
  extension by `lineboundary` in both directions.
- **mousemove while drag**: a new caret is resolved at the current
  position, and `selection.setBaseAndExtent` extends the selection
  from the anchor to the new focus point.
- **mouseup**: the drag tracking flag is cleared. The selection remains
  on the document; the user can copy it via Cmd+C / Ctrl+Shift+C.

### Mouse encoding

When the active encoding is SGR (DECSET 1006), mouse events are
encoded as:

```
CSI < {btn} ; {col} ; {row} M     (press or motion)
CSI < {btn} ; {col} ; {row} m     (release)
```

Coordinates are 1-based. `{btn}` is the button code with modifiers and
flags combined:

- 0 = left, 1 = middle, 2 = right
- + 4 if Shift held
- + 8 if Alt held
- + 16 if Ctrl held
- + 32 if motion (no button transition; pointer moving)
- + 64 for wheel up
- + 65 for wheel down

When the encoding is legacy/X10, mouse events use the older form:

```
CSI M {code} {col} {row}
```

where `{code}` is `32 + btn` (or `32 + 3` on release, since legacy
encoding cannot distinguish which button released), and `{col}` and
`{row}` are `32 + position`. Coordinates above 223 are unrepresentable
in this encoding.

SGR encoding should be preferred and is universally supported.

### Paste

On a `paste` event on the textarea:

1. The browser-provided `clipboardData` is read for `text/plain`.
2. If `bracketedPaste` mode is on (DECSET 2004), the text is wrapped in
   `ESC [ 200 ~` and `ESC [ 201 ~` markers.
3. The bytes are sent through `term._send`.
4. The textarea's value is cleared so the next paste fires cleanly.

### Lifecycle: `input.dispose()`

The Input constructor installs listeners on three targets — the hidden
textarea, the screen container, and `window` (for mouseup). When the
host is being torn down (cell re-run, tab close, panel removal), the
host **must** call `input.dispose()` to detach all listeners.

```js
const input = new Input(term, screen, hidden, renderer);
// ...later, on teardown...
input.dispose();
```

`dispose()` is idempotent. After it returns, the Input instance is
inert and eligible for garbage collection. Skipping `dispose()` leaks
the global window mouseup listener and prevents the Input, Terminal,
DomRenderer, and host element from being collected — a real concern
in long-running notebook sessions where cells re-run frequently.

---

## 12. Required host CSS

The DOM renderer requires the host to provide some baseline CSS. The
following is the minimum:

```css
.screen {
  position: relative;
  display: block;
  font-family: "JetBrains Mono", "Berkeley Mono", "IBM Plex Mono",
               "Space Mono", ui-monospace, monospace;
  font-size: 14px;
  line-height: 1.35;
  white-space: pre;
  overflow: hidden;
  user-select: text;
  cursor: text;
}
.screen .row {
  display: block;
  height: 1.35em;
  white-space: pre;
  contain: layout style;
}
.screen .cur {
  position: absolute;
  background: #d9a85f;          /* theme-dependent */
  mix-blend-mode: difference;
  pointer-events: none;
  z-index: 2;
}
.screen.app-mouse {
  user-select: none;
  cursor: default;
}

/* host container around .screen and the hidden textarea */
.termhost {
  position: relative;
  display: inline-block;
  line-height: 0;
}

textarea {
  position: absolute;
  top: 0; left: 0;
  width: 100%; height: 100%;
  margin: 0; padding: 0; border: 0; outline: 0;
  background: transparent;
  color: transparent;
  caret-color: transparent;
  font: inherit;
  pointer-events: none;
  z-index: 1;
  resize: none;
  overflow: hidden;
  white-space: pre;
}
```

The font family, font size, line height, cursor color, and screen
background are intended to be host-customizable. The `position`,
`pointer-events`, `mix-blend-mode`, `contain`, and `user-select`
declarations are not — they encode the rendering contract and changing
them will break things.

The package ships two CSS files:

- `term.css` — structural rules (the contract above, minus host-tunable parts)
- `term-default.css` — decorative defaults (font stack, font size, line
  height, cursor color, screen background)

Hosts load `term.css` always, `term-default.css` when they want the
out-of-box look. CSS custom-property hooks for finer-grained theming
land in v0.2 (see §15).

---

## 13. Integration patterns

### Skeleton

```js
import {
  Terminal, DomRenderer, Input,
} from '@gcu/term';

const term = new Terminal(80, 24);
const screen = document.querySelector('#screen');
const hidden = document.querySelector('#hidden-input');
const renderer = new DomRenderer(term, screen);
const input = new Input(term, screen, hidden, renderer);

// Render loop with cursor blink
let lastBlink = performance.now();
function tick(now) {
  if (now - lastBlink > 530) {
    renderer.cursorOn = !renderer.cursorOn;
    lastBlink = now;
    term.dirty = true;
  }
  if (term.dirty) {
    renderer.render();
    term.dirty = false;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// Wire the byte streams
term.onData(bytes => { /* send to host */ });
function fromHost(bytes) { term.write(bytes); }

// On teardown:
// input.dispose();
```

### REPL (adder, etc.)

```js
const lineBuf = { value: '', history: [], cursor: 0 };
function prompt() { term.write('\x1b[32m>>> \x1b[0m'); }

term.onData(bytes => {
  const s = new TextDecoder().decode(bytes);
  for (const ch of s) {
    if (ch === '\r') {
      term.write('\r\n');
      const line = lineBuf.value;
      lineBuf.value = '';
      const result = adder.evalLine(line);
      if (result.incomplete) {
        term.write('\x1b[32m... \x1b[0m');     // continuation prompt
      } else {
        if (result.error)  term.write(`\x1b[31m${result.error}\x1b[0m\r\n`);
        else if (result.value !== undefined) term.write(`${result.value}\r\n`);
        prompt();
      }
    } else if (ch === '\x7f') {
      if (lineBuf.value) {
        lineBuf.value = lineBuf.value.slice(0, -1);
        term.write('\b \b');
      }
    } else if (ch === '\x15') {
      term.write('\r\x1b[2K'); prompt();
      lineBuf.value = '';
    } else if (ch >= ' ') {
      lineBuf.value += ch;
      term.write(ch);
    }
  }
});

prompt();
```

A robust REPL host would additionally handle: cursor movement inside
the line (^A, ^E, ^B, ^F), history navigation (^P / ^N or
ArrowUp / ArrowDown), bracketed paste mode, syntax highlighting, and
multi-line history. These are out of scope for `@gcu/term` itself.

### WebSocket bridge to a real PTY

```js
const ws = new WebSocket('wss://host/pty');
ws.binaryType = 'arraybuffer';
ws.onmessage = e => term.write(new Uint8Array(e.data));
term.onData(bytes => ws.send(bytes));
```

That is the entire bridge. The host-side PTY can be bash, fish, anything.

### Log viewer (one-way, output only)

```js
const off = term.onData(() => { /* discard outbound keystrokes */ });
fetch('/log.txt')
  .then(r => r.body.getReader())
  .then(async reader => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      term.write(value);
    }
  });
```

Disable cursor blink for log viewers; it's noise:
`term.modes.cursorVisible = false`.

---

## 14. Known limitations

These are deliberate compromises in the v0.1 prototype. Some have
roadmap entries (§15); some are forever-skip.

### Hard limits, won't be fixed

- **BIDI / RTL.** Not implemented. Bidirectional text will render with
  incorrect visual ordering for cursor positioning and selection.
- **Sixel / iTerm2 / kitty graphics.** Inline graphics protocols are
  out of scope.

### Layout limits, will be addressed (see Roadmap)

- **No reflow.** `resize()` ships in v0.2 but lines that wrapped at the
  old width will not re-wrap at the new width — they stay padded /
  truncated. Reflow needs a soft-wrap flag on the cell to know which
  line breaks were soft vs. hard, and is genuinely hard. v1.0+.

### Display model limits, partially mitigated by DOM

- **One cell per Unicode codepoint.** The cell model does not understand
  graphemes, combining marks, or East Asian Width. A `café` typed as
  `c` `a` `f` `e` `◌́` occupies 5 cells; the DOM renderer will visually
  collapse the combining mark onto the preceding `e`, but cursor
  positioning and selection use the cell model and will be off by one.
  Similarly, CJK wide characters render at their natural width but
  collide with the next cell's content.

### Mode coverage limits

- Only the DEC private modes listed in §8 are implemented. Less-common
  modes (Origin Mode, 132-column switch, smooth scroll, etc.) are silently
  ignored.
- Tab stops are hardcoded to every 8 columns. `HTS` and `TBC` are not
  implemented.
- Insert/replace mode (IRM) is not implemented; the terminal is always
  in replace mode.

### Performance limits

- The renderer redraws all rows on every dirty frame (with the row-diff
  optimization meaning only changed rows hit the DOM, but every row is
  evaluated). At 80×24 this is invisible; at 200×60 with constant churn
  it may drop frames.
- Cell objects use heap allocation. A packed `Uint32Array` cell layout
  is roughly 5–10× more memory-efficient and is planned.
- No glyph atlas. The browser caches its own font rendering; this is
  sufficient for DOM rendering but would matter for a canvas backend.

---

## 15. Roadmap

### v0.1 → v0.2 (in flight)

Shipped in v0.2:
- ~~**Scrollback ring buffer** with mouse-wheel + Shift+PgUp/PgDn.~~
- ~~**`resize(cols, rows)`** without reflow + matching `renderer.resize()`.~~
- ~~**`LineBuffer` helper** for REPL hosts.~~
- ~~Lifecycle: `Terminal.dispose()`, `DomRenderer.dispose()`, `Input.dispose()`.~~
- ~~Convenience callbacks: `onText`, `onBell`, `onTitleChange`.~~

Shipped in v0.2:
- ~~**Theme integration via CSS custom properties.** Renderer constructor
  takes `{ cssVarTheme: true }`; reads `--gcu-term-fg`, `--gcu-term-bg`,
  `--gcu-term-color-{0..15}` per frame. Toggle a CSS class on a parent
  to retheme — no JS-side reconstruction.~~
- ~~**DEC line drawing charsets** (G0/G1 with `SI`/`SO` and `ESC ( 0` /
  `ESC ( B` switching). Necessary for mc, ncurses dialogs, older TUIs.~~

v0.2 is now feature-complete; v1.0 is gated on packaging + scrollback
search + recorded test fixtures (see below).

### v0.2 → v1.0

- **Module packaging.** Already in place (ES module). Add a `package.json`
  with `exports` map and minified `dist/` build.
- **Scrollback search API.** The ring buffer + viewport scrolling shipped
  in v0.2; v1.0 adds a `term.scrollback.search(query)` method returning
  `{ row, col }` matches that the renderer can highlight.
- **Real-program test fixtures.** v0.2 ships hand-crafted parser /
  Terminal tests; v1.0 adds a corpus of byte-stream fixtures recorded
  from real programs (vim, htop, tmux), replayed with expected
  buffer-state snapshots, plus property tests on the parser.

### v1.0+ (production-ready)

- **Event API**: `onTitle`, `onBell`, `onCursorMove`, `onResize`,
  `onBufferChange`, `onSelectionChange`.
- **OSC 8 hyperlinks**: emit `<a href target="_blank">` in DOM; cell-level
  hyperlink IDs in the model.
- **OSC 7 working directory** tracking, with an `onWorkingDirectory`
  event.
- **OSC 133 shell integration** (semantic prompt marks), with an API for
  the host to jump between commands or fold output.
- **OSC 52 clipboard set** (app pushes to system clipboard). Gated by
  a host-provided permission callback.
- **Dirty-row tracking** at write time (not just at render time) to avoid
  iterating clean rows.
- **Packed cell layout** with `Uint32Array` of attribute bits and a
  separate codepoint array. Reduces memory ~10× and speeds up scrolling.
- **Reflow on resize**: re-wrap previously-wrapped lines at the new
  width. The genuinely hard one; uses a wrap-tag on the cell to know
  which line breaks were soft.

### Long tail

- **CJK East Asian Width**: compact Unicode width table (~5 KB
  run-length encoded), wide-char support in cell model and cursor
  movement.
- **Grapheme clustering**: use `Intl.Segmenter` to cluster combining
  marks with their base; one grapheme per cell instead of one codepoint.
- **Touch event handling** for mobile/tablet drag-to-select.
- **Drag-to-scroll** when selection drag extends past the viewport edge.
- **Block selection** (Alt+drag).
- **Canvas renderer** as an optional secondary renderer for
  high-throughput log viewer use cases. Glyph atlas, dirty-row tracking,
  packed-cell consumption.

### Forever-skip

- BIDI / RTL.
- Sixel, iTerm2 image protocols, kitty graphics.
- Legacy mouse encodings beyond X10 and SGR 1006.
- Full DEC private mode coverage.
- Plugin / addon API.

---

## 16. Performance characteristics

These numbers are approximate, measured on a modern laptop (Apple M-series
or Ryzen AI 9 HX), Chromium-class browser, 14px JetBrains Mono on a 80×24
grid. They are not benchmarks, they are expectations.

| Operation | Cost |
|---|---|
| Idle frame (no changes) | ~0 ms (early exit on `!term.dirty`) |
| Single-line update | ~0.1 ms (one row's innerHTML replaced) |
| Full-screen redraw (80×24) | ~1–3 ms |
| Full-screen redraw (200×60) | ~5–15 ms |
| Parser throughput | >10 MB/s (state machine is the only hot loop) |
| Memory per cell | ~80 bytes (object overhead) |
| Total memory at 80×24 | ~200 KB |

The renderer is comfortable up to ~120×40 with frequent updates. Past
~200×60 with constant churn (heavy `htop` or `tail -f` of a hot log) you
may drop frames; this is where a canvas + glyph atlas backend would win.

---

## 17. References

### Standards and source material

- Paul Williams' canonical VT/ANSI parser state machine —
  <https://vt100.net/emu/dec_ansi_parser>
- xterm control sequences (Thomas Dickey) —
  <https://invisible-island.net/xterm/ctlseqs/ctlseqs.html>
- VT510 Programmer Reference Manual (Digital, 1993; PDF reproductions
  widely available)
- ECMA-48: Control Functions for Coded Character Sets, 5th ed., 1991

### Prior art

- **xterm.js** (<https://xtermjs.org/>) — the reference web terminal
  emulator. Larger and more featureful; valuable as a behavioral oracle
  for edge cases.
- **hterm** (Chromium OS) — the DOM-rendered terminal underlying the
  ChromeOS SSH client. Demonstrates that DOM rendering is viable at
  serious scale.
- **alacritty** and **kitty** — native (non-web) reference implementations
  for performance comparisons and modern feature scope.

### Sibling packages in the GCU ecosystem

- **adder** — pure-JS Python interpreter; primary REPL consumer.
- **@gcu/sideact** — signals library; used by Auditable Works for
  reactive DAG management. `@gcu/term` exposes simple callbacks rather
  than signals; bridging code is trivial.
- **@gcu/menu**, **@gcu/dialog** — UI primitives used elsewhere in the
  GCU stack. `@gcu/term` shares the same "host-themed via CSS variables"
  pattern.
- **@gcu/vfs** — mount-table virtual filesystem; relevant if `@gcu/term`
  is ever connected to a host that serves files (e.g., for `cat`-like
  commands in a sandboxed shell).

---

## Appendix A: Public exports

```js
// Classes
export class Parser
export class Terminal       // onData / onText / onBell / onTitleChange / resize / dispose
export class DomRenderer    // constructor { theme }, setTheme, scrollBy, scrollToBottom, resize, dispose
export class Input          // dispose() to detach all listeners
export class LineBuffer     // optional REPL helper; line discipline + history

// Color tables
export const PALETTE       // 16-color base
export const PAL256        // 256-color cube

// Color sentinels
export const DEFAULT_FG
export const DEFAULT_BG

// Attribute flags
export const FLAG_BOLD
export const FLAG_DIM
export const FLAG_ITALIC
export const FLAG_UNDER
export const FLAG_BLINK
export const FLAG_REVERSE
export const FLAG_INVIS
export const FLAG_STRIKE
```

## Appendix B: Glossary

- **CSI** — Control Sequence Introducer. The `ESC [` byte pair (or
  single C1 byte `0x9B`) that introduces most modern terminal control
  sequences.
- **OSC** — Operating System Command. The `ESC ]` byte pair. Used for
  out-of-band terminal control like setting the window title.
- **DCS** — Device Control String. The `ESC P` byte pair. Used for
  device-specific protocols like Sixel; not handled by this terminal.
- **SGR** — Select Graphic Rendition. The CSI sequence ending in `m`
  that sets colors and text attributes.
- **DECSET / DECRST** — DEC private mode set/reset; CSI with `?` prefix.
- **DSR** — Device Status Report; a query from the host to which the
  terminal replies with status information (cursor position, etc.).
- **DA** — Device Attributes; a similar query identifying the terminal type.
- **DECAWM** — DEC Auto Wrap Mode. Mode 7 in DECSET/DECRST.
- **DECSTBM** — DEC Set Top and Bottom Margins; the scroll region.
- **DECSC / DECRC** — DEC Save/Restore Cursor.
- **SS3** — Single Shift 3, the `ESC O` byte pair used in application
  cursor key mode.
- **VT100, VT102, VT220, VT510** — historical DEC terminal models whose
  control sequences are reproduced here. `@gcu/term` identifies as a
  VT102 in DA replies.
