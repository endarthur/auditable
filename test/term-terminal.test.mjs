// @gcu/term Terminal state-model tests.
//
// Drives the Terminal via write() with realistic byte sequences and
// inspects the cell buffer / cursor / mode state. Focus is on the
// observable contract: what does buffer[y][x] hold after a given input?
//
// These tests run pure-Node — no DOM. The DomRenderer + Input layers
// are exercised via the demo page, not here.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  Terminal, FLAG_BOLD, FLAG_ITALIC, FLAG_UNDER, FLAG_REVERSE,
  DEFAULT_FG, DEFAULT_BG,
} from '../ext/term/src/index.js';

function ch(cell) { return String.fromCodePoint(cell.ch); }
function rowText(t, y) {
  const row = t._curBuf()[y];
  let s = '';
  for (const c of row) s += ch(c);
  return s.replace(/ +$/, '');
}

// ────────────────────────────────────────────────────────────────────
// printing + cursor advancement
// ────────────────────────────────────────────────────────────────────

describe('Terminal print / cursor', () => {
  test('prints text starting at top-left', () => {
    const t = new Terminal(20, 5);
    t.write('hello');
    assert.equal(rowText(t, 0), 'hello');
    assert.deepEqual(t.cursor, { x: 5, y: 0 });
  });

  test('CR returns cursor to column 0', () => {
    const t = new Terminal(20, 5);
    t.write('hello\rworld');
    assert.equal(rowText(t, 0), 'world');
    assert.equal(t.cursor.x, 5);
  });

  test('CRLF advances row, scrolling at bottom', () => {
    // LF alone advances the row but does NOT return to column 0 — that
    // matches real terminal behavior. Tests use CR+LF (the universal
    // newline) so the cursor lands at column 0 of the next row.
    const t = new Terminal(20, 3);
    t.write('a\r\nb\r\nc');
    assert.equal(rowText(t, 0), 'a');
    assert.equal(rowText(t, 1), 'b');
    assert.equal(rowText(t, 2), 'c');

    // Now scroll
    t.write('\r\nd');
    assert.equal(rowText(t, 0), 'b');
    assert.equal(rowText(t, 1), 'c');
    assert.equal(rowText(t, 2), 'd');
  });

  test('DECAWM phantom column: cursor stays at last col after print', () => {
    const t = new Terminal(5, 3);
    t.write('abcde');
    assert.equal(rowText(t, 0), 'abcde');
    assert.equal(t.cursor.x, 4);  // still at last col
    assert.equal(t.pendingWrap, true);

    // Next print wraps first
    t.write('f');
    assert.equal(rowText(t, 1), 'f');
    assert.equal(t.cursor.y, 1);
    assert.equal(t.cursor.x, 1);
  });

  test('cursor-movement CSI clears pending wrap', () => {
    const t = new Terminal(5, 3);
    t.write('abcde');
    assert.equal(t.pendingWrap, true);
    t.write('\x1b[A');  // CUU
    assert.equal(t.pendingWrap, false);
  });
});

// ────────────────────────────────────────────────────────────────────
// erase ops
// ────────────────────────────────────────────────────────────────────

describe('Terminal erase', () => {
  test('ED 2 (erase all) clears the screen', () => {
    const t = new Terminal(10, 3);
    t.write('hello\nworld');
    t.write('\x1b[2J');
    assert.equal(rowText(t, 0), '');
    assert.equal(rowText(t, 1), '');
  });

  test('EL 0 (erase to end of line) clears from cursor', () => {
    const t = new Terminal(10, 3);
    t.write('hello world');  // wraps
    // cursor is somewhere after the wrap; move to start and erase to end
    t.write('\x1b[H');  // home
    t.write('\x1b[K');  // EL 0
    assert.equal(rowText(t, 0), '');
  });
});

// ────────────────────────────────────────────────────────────────────
// SGR
// ────────────────────────────────────────────────────────────────────

describe('Terminal SGR', () => {
  test('basic 16-color foreground', () => {
    const t = new Terminal(10, 3);
    t.write('\x1b[31mred\x1b[0m');
    const cell = t.buffer[0][0];
    assert.deepEqual(cell.fg, { t: 'p', i: 1 });
    assert.equal(cell.flags, 0);
    // After reset, cursor attrs are back to default
    t.write('a');
    assert.equal(t.buffer[0][3].fg, DEFAULT_FG);
  });

  test('bold + italic + underline accumulate', () => {
    const t = new Terminal(10, 3);
    t.write('\x1b[1;3;4mtext');
    const cell = t.buffer[0][0];
    assert.equal(cell.flags & FLAG_BOLD, FLAG_BOLD);
    assert.equal(cell.flags & FLAG_ITALIC, FLAG_ITALIC);
    assert.equal(cell.flags & FLAG_UNDER, FLAG_UNDER);
  });

  test('256-color foreground via 38;5;N', () => {
    const t = new Terminal(10, 3);
    t.write('\x1b[38;5;215mx');
    assert.deepEqual(t.buffer[0][0].fg, { t: 'p', i: 215 });
  });

  test('truecolor foreground via 38;2;R;G;B', () => {
    const t = new Terminal(10, 3);
    t.write('\x1b[38;2;255;128;0mx');
    assert.deepEqual(t.buffer[0][0].fg, { t: 'r', r: 255, g: 128, b: 0 });
  });

  test('CSI m (no params) resets', () => {
    const t = new Terminal(10, 3);
    t.write('\x1b[1;31mfoo\x1b[mbar');
    assert.equal(t.buffer[0][3].flags, 0);
    assert.equal(t.buffer[0][3].fg, DEFAULT_FG);
  });
});

// ────────────────────────────────────────────────────────────────────
// alt-screen
// ────────────────────────────────────────────────────────────────────

describe('Terminal alt screen', () => {
  test('DECSET 1049 enters alt screen, DECRST 1049 exits', () => {
    const t = new Terminal(10, 3);
    t.write('primary');
    t.write('\x1b[?1049h');
    assert.equal(t.usingAlt, true);
    t.write('alt');
    assert.equal(rowText(t, 0), 'alt');

    t.write('\x1b[?1049l');
    assert.equal(t.usingAlt, false);
    assert.equal(rowText(t, 0), 'primary');
  });

  test('DECSET 1049 saves cursor on enter, DECRST 1049 restores', () => {
    const t = new Terminal(10, 3);
    t.write('hello');  // cursor at (5, 0)
    t.write('\x1b[?1049h');  // save + alt
    t.write('\x1b[5;5H');    // move cursor in alt
    t.write('\x1b[?1049l');  // restore
    assert.equal(t.cursor.x, 5);
    assert.equal(t.cursor.y, 0);
  });
});

// ────────────────────────────────────────────────────────────────────
// DEC private modes
// ────────────────────────────────────────────────────────────────────

describe('Terminal DEC private modes', () => {
  test('DECSET 25 toggles cursor visibility', () => {
    const t = new Terminal(10, 3);
    assert.equal(t.modes.cursorVisible, true);
    t.write('\x1b[?25l');
    assert.equal(t.modes.cursorVisible, false);
    t.write('\x1b[?25h');
    assert.equal(t.modes.cursorVisible, true);
  });

  test('DECSET 1 toggles application cursor mode', () => {
    const t = new Terminal(10, 3);
    assert.equal(t.modes.appCursor, false);
    t.write('\x1b[?1h');
    assert.equal(t.modes.appCursor, true);
  });

  test('mouse tracking 1000 sets mouseProto = 1000', () => {
    const t = new Terminal(10, 3);
    t.write('\x1b[?1000h');
    assert.equal(t.modes.mouseProto, 1000);
    t.write('\x1b[?1000l');
    assert.equal(t.modes.mouseProto, 0);
  });

  test('hard reset preserves integer typing on mouseProto', () => {
    const t = new Terminal(10, 3);
    t.write('\x1b[?1000h');
    assert.equal(t.modes.mouseProto, 1000);
    t.write('\x1bc');  // RIS
    assert.equal(t.modes.mouseProto, 0);
    assert.equal(typeof t.modes.mouseProto, 'number');
    assert.equal(t.modes.wrap, true);            // default true survives reset
    assert.equal(t.modes.cursorVisible, true);   // default true survives reset
  });
});

// ────────────────────────────────────────────────────────────────────
// onData / onText / onBell / onTitleChange
// ────────────────────────────────────────────────────────────────────

describe('Terminal listeners', () => {
  test('onData receives Uint8Array bytes', () => {
    const t = new Terminal(10, 3);
    let bytes = null;
    t.onData(b => { bytes = b; });
    t._send('hi');
    assert.ok(bytes instanceof Uint8Array);
    assert.equal(bytes.length, 2);
  });

  test('onText receives the decoded string', () => {
    const t = new Terminal(10, 3);
    let text = null;
    t.onText(s => { text = s; });
    t._send('hello');
    assert.equal(text, 'hello');
  });

  test('multiple listeners fire in subscription order', () => {
    const t = new Terminal(10, 3);
    const order = [];
    t.onData(() => order.push('a'));
    t.onData(() => order.push('b'));
    t._send('x');
    assert.deepEqual(order, ['a', 'b']);
  });

  test('listener exceptions are caught, not propagated', () => {
    const t = new Terminal(10, 3);
    let secondFired = false;
    t.onData(() => { throw new Error('intentional'); });
    t.onData(() => { secondFired = true; });
    // Should not throw
    t._send('x');
    assert.ok(secondFired);
  });

  test('unsubscribe stops further fires', () => {
    const t = new Terminal(10, 3);
    let count = 0;
    const off = t.onData(() => count++);
    t._send('x');
    off();
    t._send('y');
    assert.equal(count, 1);
  });

  test('onBell fires per BEL (0x07)', () => {
    const t = new Terminal(10, 3);
    let bells = 0;
    t.onBell(() => bells++);
    t.write('a\x07b\x07c\x07');
    assert.equal(bells, 3);
  });

  test('onTitleChange receives title string from OSC 0/1/2', () => {
    const t = new Terminal(10, 3);
    const titles = [];
    t.onTitleChange(s => titles.push(s));
    t.write('\x1b]0;first\x07');
    t.write('\x1b]2;second\x07');
    assert.deepEqual(titles, ['first', 'second']);
    assert.equal(t.title, 'second');
  });

  test('OSC does NOT mutate document.title (no implicit side effect)', () => {
    const t = new Terminal(10, 3);
    const before = (typeof document !== 'undefined') ? document.title : null;
    t.write('\x1b]0;changed\x07');
    if (typeof document !== 'undefined') {
      assert.equal(document.title, before);
    }
    assert.equal(t.title, 'changed');
  });
});

// ────────────────────────────────────────────────────────────────────
// dispose
// ────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────
// scrollback
// ────────────────────────────────────────────────────────────────────

describe('Terminal scrollback', () => {
  test('default maxScrollback is 1000', () => {
    const t = new Terminal(10, 3);
    assert.equal(t.maxScrollback, 1000);
    assert.deepEqual(t.scrollback, []);
  });

  test('rows scrolling off the primary buffer push to scrollback', () => {
    const t = new Terminal(10, 3);
    // Fill 3 rows then add 2 more — top 2 should land in scrollback
    t.write('a\r\nb\r\nc\r\nd\r\ne');
    assert.equal(t.scrollback.length, 2);
    assert.equal(rowText(t, 0), 'c');
    assert.equal(rowText(t, 1), 'd');
    assert.equal(rowText(t, 2), 'e');
    // Oldest scrollback row is 'a'
    assert.equal(String.fromCodePoint(t.scrollback[0][0].ch), 'a');
    assert.equal(String.fromCodePoint(t.scrollback[1][0].ch), 'b');
  });

  test('alt-screen does not feed scrollback', () => {
    const t = new Terminal(10, 3);
    t.write('\x1b[?1049h');     // enter alt
    t.write('a\r\nb\r\nc\r\nd');  // scrolls in alt; should NOT push to scrollback
    assert.equal(t.scrollback.length, 0);
    t.write('\x1b[?1049l');     // back to primary
    assert.equal(t.scrollback.length, 0);
  });

  test('scrollback respects maxScrollback', () => {
    const t = new Terminal(10, 3, { maxScrollback: 4 });
    let s = '';
    for (let i = 0; i < 10; i++) s += 'r' + i + '\r\n';
    t.write(s);
    // 10 rows written, 3 visible → 7 should have scrolled off, but
    // capped to 4
    assert.equal(t.scrollback.length, 4);
  });

  test('hard reset clears scrollback', () => {
    const t = new Terminal(10, 3);
    t.write('a\r\nb\r\nc\r\nd\r\ne');
    assert.equal(t.scrollback.length, 2);
    t.write('\x1bc');  // RIS
    assert.equal(t.scrollback.length, 0);
  });

  test('partial-region scroll (DECSTBM) does NOT push to scrollback', () => {
    // A status-bar-style app sets a scroll region within the screen and
    // scrolls there. Those scroll-offs are app-driven, not user output —
    // capturing them as history would be confusing.
    const t = new Terminal(10, 5);
    t.write('\x1b[2;4r');  // scroll region rows 2-4
    t.write('\x1b[2;1Ha\r\nb\r\nc\r\nd\r\ne');
    // No row from outside the region scrolled off the primary screen;
    // scrollback stays empty.
    assert.equal(t.scrollback.length, 0);
  });
});

// ────────────────────────────────────────────────────────────────────
// resize
// ────────────────────────────────────────────────────────────────────

describe('Terminal resize', () => {
  test('width grows: rows pad with empty cells', () => {
    const t = new Terminal(10, 3);
    t.write('hi');
    t.resize(20, 3);
    assert.equal(t.cols, 20);
    assert.equal(t.buffer[0].length, 20);
    // First two cells unchanged
    assert.equal(String.fromCodePoint(t.buffer[0][0].ch), 'h');
    assert.equal(String.fromCodePoint(t.buffer[0][1].ch), 'i');
    // Padded cells are spaces
    assert.equal(t.buffer[0][19].ch, 0x20);
  });

  test('width shrinks: rows truncate', () => {
    const t = new Terminal(10, 3);
    t.write('helloworld');
    t.resize(5, 3);
    assert.equal(t.cols, 5);
    assert.equal(t.buffer[0].length, 5);
    assert.equal(rowText(t, 0), 'hello');
  });

  test('height grows: empty rows added at the bottom', () => {
    const t = new Terminal(10, 2);
    t.write('a');
    t.resize(10, 5);
    assert.equal(t.rows, 5);
    assert.equal(t.buffer.length, 5);
    assert.equal(rowText(t, 0), 'a');
    assert.equal(rowText(t, 4), '');
  });

  test('height shrinks on primary buffer: top rows go to scrollback', () => {
    const t = new Terminal(10, 5);
    t.write('a\r\nb\r\nc\r\nd\r\ne');
    t.resize(10, 3);
    assert.equal(t.rows, 3);
    assert.equal(t.scrollback.length, 2);
    assert.equal(String.fromCodePoint(t.scrollback[0][0].ch), 'a');
    assert.equal(String.fromCodePoint(t.scrollback[1][0].ch), 'b');
  });

  test('height shrinks on alt buffer: top rows are discarded (not scrollback)', () => {
    const t = new Terminal(10, 5);
    t.write('\x1b[?1049h');
    t.write('a\r\nb\r\nc\r\nd\r\ne');
    assert.equal(t.scrollback.length, 0);
    t.resize(10, 3);
    assert.equal(t.scrollback.length, 0);  // still empty
    assert.equal(t.altBuffer.length, 3);
  });

  test('cursor clamps into the new bounds', () => {
    const t = new Terminal(10, 5);
    t.write('aaaaaaaaaa\r\nbbbbb');  // cursor lands somewhere far right
    t.resize(3, 2);
    assert.ok(t.cursor.x < 3);
    assert.ok(t.cursor.y < 2);
  });

  test('scroll region resets to full screen', () => {
    const t = new Terminal(10, 5);
    t.write('\x1b[2;4r');  // region rows 2-4
    t.resize(10, 8);
    assert.equal(t.scrollTop, 0);
    assert.equal(t.scrollBottom, 7);
  });

  test('1×1 minimum dimensions', () => {
    const t = new Terminal(10, 5);
    assert.doesNotThrow(() => t.resize(1, 1));
    assert.equal(t.cols, 1);
    assert.equal(t.rows, 1);
  });

  test('zero / negative dims throw RangeError', () => {
    const t = new Terminal(10, 5);
    assert.throws(() => t.resize(0, 5), RangeError);
    assert.throws(() => t.resize(10, -1), RangeError);
  });
});

// ────────────────────────────────────────────────────────────────────
// DEC line-drawing charset (G0/G1 + SO/SI + ESC ( 0 / ESC ( B)
// ────────────────────────────────────────────────────────────────────

describe('Terminal DEC line-drawing charset', () => {
  test('default G0/G1 are USASCII; printable text passes through', () => {
    const t = new Terminal(20, 3);
    assert.equal(t.charsets.g0, 'B');
    assert.equal(t.charsets.g1, 'B');
    assert.equal(t.glSlot, 'g0');
    t.write('lqk');
    assert.equal(rowText(t, 0), 'lqk');
  });

  test('ESC ( 0 designates G0 = DEC special; "lqk" → corner row', () => {
    const t = new Terminal(20, 3);
    t.write('\x1b(0lqk');
    // l=┌ (U+250C), q=─ (U+2500), k=┐ (U+2510)
    assert.equal(t.buffer[0][0].ch, 0x250C);
    assert.equal(t.buffer[0][1].ch, 0x2500);
    assert.equal(t.buffer[0][2].ch, 0x2510);
  });

  test('ESC ( B switches G0 back to USASCII', () => {
    const t = new Terminal(20, 3);
    t.write('\x1b(0l\x1b(Bl');
    assert.equal(t.buffer[0][0].ch, 0x250C);  // first l → ┌
    assert.equal(t.buffer[0][1].ch, 0x6C);    // second l → 'l' literal
  });

  test('SO (0x0E) selects G1; SI (0x0F) selects G0', () => {
    const t = new Terminal(20, 3);
    // Designate G1 = DEC special; G0 stays USASCII
    t.write('\x1b)0');
    t.write('A');           // G0 active → 'A'
    t.write('\x0E');        // SO → switch to G1
    t.write('q');           // G1 active = DEC special → ─
    t.write('\x0F');        // SI → switch back to G0
    t.write('B');           // G0 active → 'B'
    assert.equal(t.buffer[0][0].ch, 0x41);
    assert.equal(t.buffer[0][1].ch, 0x2500);
    assert.equal(t.buffer[0][2].ch, 0x42);
  });

  test('codepoints outside 0x60-0x7E pass through unchanged in DEC charset', () => {
    const t = new Terminal(20, 3);
    t.write('\x1b(0A1');  // 0x41 and 0x31 — not in the table
    assert.equal(t.buffer[0][0].ch, 0x41);
    assert.equal(t.buffer[0][1].ch, 0x31);
  });

  test('hard reset returns charsets to USASCII / G0 active', () => {
    const t = new Terminal(20, 3);
    t.write('\x1b(0\x0E');   // G0 = DEC, GL = G1
    t.write('\x1bc');        // RIS
    assert.equal(t.charsets.g0, 'B');
    assert.equal(t.charsets.g1, 'B');
    assert.equal(t.glSlot, 'g0');
  });

  test('a small mc-shaped box renders correctly', () => {
    // ┌──┐
    // │  │
    // └──┘
    const t = new Terminal(10, 5);
    t.write('\x1b(0lqqk\r\nx  x\r\nmqqj');
    const row0 = t.buffer[0].slice(0, 4).map(c => String.fromCodePoint(c.ch)).join('');
    const row1 = t.buffer[1].slice(0, 4).map(c => String.fromCodePoint(c.ch)).join('');
    const row2 = t.buffer[2].slice(0, 4).map(c => String.fromCodePoint(c.ch)).join('');
    assert.equal(row0, '┌──┐');
    assert.equal(row1, '│  │');
    assert.equal(row2, '└──┘');
  });
});

// ────────────────────────────────────────────────────────────────────
// DomRenderer color resolution (no DOM — mock _cssVars directly)
// ────────────────────────────────────────────────────────────────────

import { DomRenderer, PAL256 } from '../ext/term/src/index.js';

// Build a barebones renderer that skips the DOM-touching ctor steps.
// Just enough to exercise _color / _defaultColor.
function makeBareRenderer(theme = null, cssVars = null) {
  const term = new Terminal(10, 3);
  const r = Object.create(DomRenderer.prototype);
  r.term = term;
  r.theme = theme;
  r._cssVars = cssVars;
  return r;
}

describe('DomRenderer.scrollBy semantics', () => {
  test('negative delta scrolls UP into history (offset increases)', () => {
    const term = new Terminal(10, 3);
    // Generate scrollback
    for (let i = 0; i < 5; i++) term.write(`row ${i}\r\n`);
    assert.ok(term.scrollback.length >= 1);
    const r = Object.create(DomRenderer.prototype);
    r.term = term;
    r.scrollOffset = 0;
    r.scrollBy(-3);
    assert.ok(r.scrollOffset > 0, 'wheel-up (negative delta) should increase offset');
  });

  test('positive delta scrolls DOWN toward live (offset decreases)', () => {
    const term = new Terminal(10, 3);
    for (let i = 0; i < 5; i++) term.write(`row ${i}\r\n`);
    const r = Object.create(DomRenderer.prototype);
    r.term = term;
    r.scrollOffset = term.scrollback.length;  // fully up
    r.scrollBy(3);
    assert.ok(r.scrollOffset < term.scrollback.length);
  });

  test('clamped at 0 (live) and at scrollback.length (top)', () => {
    const term = new Terminal(10, 3);
    for (let i = 0; i < 5; i++) term.write(`row ${i}\r\n`);
    const max = term.scrollback.length;
    const r = Object.create(DomRenderer.prototype);
    r.term = term;
    r.scrollOffset = 0;
    r.scrollBy(99);             // try to scroll down past live
    assert.equal(r.scrollOffset, 0);
    r.scrollBy(-9999);          // try to scroll up past top
    assert.equal(r.scrollOffset, max);
  });
});

describe('DomRenderer color resolution', () => {
  test('default cell with no theme → null (inherit from CSS)', () => {
    const r = makeBareRenderer();
    assert.equal(r._color({ t: 'd' }, 'fg'), null);
  });

  test('default cell with constructor theme defaultFg', () => {
    const r = makeBareRenderer({ defaultFg: '#abc', defaultBg: '#def' });
    assert.equal(r._color({ t: 'd' }, 'fg'), '#abc');
    assert.equal(r._color({ t: 'd' }, 'bg'), '#def');
  });

  test('palette index uses constructor theme palette array first', () => {
    const r = makeBareRenderer({ palette: ['#000','#100','#200','#300','#400','#500','#600','#700','#800','#900','#a00','#b00','#c00','#d00','#e00','#f00'] });
    assert.equal(r._color({ t: 'p', i: 3 }, 'fg'), '#300');
    // Index outside the array falls back to PAL256
    assert.equal(r._color({ t: 'p', i: 200 }, 'fg'), PAL256[200]);
  });

  test('palette function gets called with (idx, layer)', () => {
    const calls = [];
    const r = makeBareRenderer({
      palette: (idx, layer) => { calls.push([idx, layer]); return idx === 3 ? '#xyz' : null; },
    });
    assert.equal(r._color({ t: 'p', i: 3 }, 'bg'), '#xyz');
    assert.deepEqual(calls.at(-1), [3, 'bg']);
    // Returning null falls through to CSS vars / PAL256
    assert.equal(r._color({ t: 'p', i: 100 }, 'fg'), PAL256[100]);
  });

  test('CSS vars are consulted for indices 0-15 when no constructor theme', () => {
    const palette = new Array(16).fill(null);
    palette[5] = 'rebeccapurple';
    const r = makeBareRenderer(null, { fg: '#ff0', bg: null, palette });
    assert.equal(r._color({ t: 'p', i: 5 }, 'fg'), 'rebeccapurple');
    // Default cell picks up CSS-var fg
    assert.equal(r._color({ t: 'd' }, 'fg'), '#ff0');
    // Bg unset → falls through to null
    assert.equal(r._color({ t: 'd' }, 'bg'), null);
  });

  test('constructor theme wins over CSS vars', () => {
    const palette = new Array(16).fill(null);
    palette[2] = '#cssvar';
    const r = makeBareRenderer(
      { palette: ['c0','c1','#thwins','c3','c4','c5','c6','c7','c8','c9','ca','cb','cc','cd','ce','cf'] },
      { fg: null, bg: null, palette },
    );
    assert.equal(r._color({ t: 'p', i: 2 }, 'fg'), '#thwins');
  });

  test('truecolor passes through always', () => {
    const r = makeBareRenderer({ palette: ['z'] }, { palette: new Array(16).fill('z') });
    assert.equal(r._color({ t: 'r', r: 10, g: 20, b: 30 }, 'fg'), 'rgb(10,20,30)');
  });

  test('CSS vars index >=16 falls back to PAL256', () => {
    const palette = new Array(16).fill('overridden');
    const r = makeBareRenderer(null, { fg: null, bg: null, palette });
    assert.equal(r._color({ t: 'p', i: 200 }, 'fg'), PAL256[200]);
  });
});

// ────────────────────────────────────────────────────────────────────
// LineBuffer
// ────────────────────────────────────────────────────────────────────

import { LineBuffer } from '../ext/term/src/index.js';

function makeRepl() {
  // Capture all writes to the term for inspection. We don't run the
  // renderer — LineBuffer talks via term.onText(...) which fires from
  // term._send() (driven by our manual sends below).
  const t = new Terminal(80, 24);
  const writes = [];
  const origWrite = t.write.bind(t);
  t.write = (s) => { writes.push(s); origWrite(s); };
  let submitted = null;
  const lb = new LineBuffer(t, {
    prompt: '> ',
    onSubmit: (line) => { submitted = line; },
  });
  lb.start();
  return {
    t, lb, writes,
    submitted: () => submitted,
    type: (s) => { t._send(s); },
    lastWrite: () => writes[writes.length - 1],
  };
}

describe('LineBuffer line discipline', () => {
  test('start prints the prompt', () => {
    const r = makeRepl();
    assert.equal(r.writes[0], '> ');
  });

  test('printable chars accumulate into value and redraw', () => {
    const r = makeRepl();
    r.type('h'); r.type('i');
    assert.equal(r.lb.value, 'hi');
    assert.equal(r.lb.cursor, 2);
  });

  test('Backspace deletes left of cursor', () => {
    const r = makeRepl();
    r.type('hello');
    r.type('\x7f\x7f');
    assert.equal(r.lb.value, 'hel');
    assert.equal(r.lb.cursor, 3);
  });

  test('Enter calls onSubmit with the line and clears value', () => {
    const r = makeRepl();
    r.type('print(42)\r');
    assert.equal(r.submitted(), 'print(42)');
    assert.equal(r.lb.value, '');
    assert.equal(r.lb.cursor, 0);
  });

  test('^A jumps to start, ^E to end', () => {
    const r = makeRepl();
    r.type('hello');
    r.type('\x01');  // ^A
    assert.equal(r.lb.cursor, 0);
    r.type('\x05');  // ^E
    assert.equal(r.lb.cursor, 5);
  });

  test('arrows: left and right move cursor', () => {
    const r = makeRepl();
    r.type('hello');
    r.type('\x1b[D');  // Left
    r.type('\x1b[D');
    assert.equal(r.lb.cursor, 3);
    r.type('\x1b[C');  // Right
    assert.equal(r.lb.cursor, 4);
  });

  test('insert at cursor (not at end)', () => {
    const r = makeRepl();
    r.type('hllo');
    r.type('\x01');     // ^A — start
    r.type('\x1b[C');   // Right — between h and l
    r.type('e');
    assert.equal(r.lb.value, 'hello');
  });

  test('^U kills the whole line', () => {
    const r = makeRepl();
    r.type('something');
    r.type('\x15');  // ^U
    assert.equal(r.lb.value, '');
    assert.equal(r.lb.cursor, 0);
  });

  test('^W kills the previous word', () => {
    const r = makeRepl();
    r.type('foo bar baz');
    r.type('\x17');  // ^W
    assert.equal(r.lb.value, 'foo bar ');
  });

  test('^P / ^N navigate history (after a submit)', () => {
    const r = makeRepl();
    r.type('first\r');
    r.type('second\r');
    r.type('\x10');  // ^P — most recent ('second')
    assert.equal(r.lb.value, 'second');
    r.type('\x10');  // ^P — older ('first')
    assert.equal(r.lb.value, 'first');
    r.type('\x0E');  // ^N — back toward live
    assert.equal(r.lb.value, 'second');
    r.type('\x0E');  // ^N — back to live (empty)
    assert.equal(r.lb.value, '');
  });

  test('^C cancels the line and reprompts', () => {
    const r = makeRepl();
    r.type('working on this');
    r.type('\x03');  // ^C
    assert.equal(r.lb.value, '');
    assert.equal(r.lb.cursor, 0);
  });

  test('bracketed paste inserts verbatim', () => {
    const r = makeRepl();
    r.type('\x1b[200~hello\nworld\x1b[201~');
    assert.equal(r.lb.value, 'hello\nworld');
  });

  test('dispose stops further input handling', () => {
    const r = makeRepl();
    r.type('a');
    r.lb.dispose();
    r.type('b');
    assert.equal(r.lb.value, 'a');  // 'b' ignored
  });

  test('history dedupes consecutive identical submits', () => {
    const r = makeRepl();
    r.type('same\r');
    r.type('same\r');
    assert.equal(r.lb.history.length, 1);
  });
});

describe('Terminal dispose', () => {
  test('write after dispose is a no-op', () => {
    const t = new Terminal(10, 3);
    t.write('hello');
    t.dispose();
    // Buffer is dropped; further write must not throw
    t.write('more');
    assert.equal(t.buffer, null);
  });

  test('_send after dispose is a no-op (no listener fires)', () => {
    const t = new Terminal(10, 3);
    let count = 0;
    t.onData(() => count++);
    t.dispose();
    t._send('x');
    assert.equal(count, 0);
  });

  test('double dispose is safe', () => {
    const t = new Terminal(10, 3);
    t.dispose();
    t.dispose();  // should not throw
    assert.equal(t._disposed, true);
  });
});
