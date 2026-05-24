// @gcu/readline tests — focused on the keys parser (where escape-sequence
// edge cases live) and the editor (pure state-machine ops). The api.js
// glue is exercised via works-smoke against the geas terminal.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseKeys } from '../ext/readline/src/keys.js';
import * as ed from '../ext/readline/src/editor.js';

function parse(chunk, state = { pasting: false, pasteBuf: '' }) {
  return parseKeys(chunk, state);
}

describe('keys: printables', () => {
  it('single char', () => {
    const r = parse('a');
    assert.deepEqual(r.events, [{ ch: 'a' }]);
  });
  it('run of chars coalesced into one event', () => {
    const r = parse('hello');
    assert.deepEqual(r.events, [{ ch: 'hello' }]);
  });
});

describe('keys: control chars', () => {
  it('Enter (\\r)', () => {
    assert.deepEqual(parse('\r').events, [{ name: 'Enter' }]);
  });
  it('Enter (\\n)', () => {
    assert.deepEqual(parse('\n').events, [{ name: 'Enter' }]);
  });
  it('Backspace 0x7f', () => {
    assert.deepEqual(parse('\x7f').events, [{ name: 'Backspace' }]);
  });
  it('Backspace 0x08', () => {
    assert.deepEqual(parse('\b').events, [{ name: 'Backspace' }]);
  });
  it('Tab', () => {
    assert.deepEqual(parse('\t').events, [{ name: 'Tab' }]);
  });
  it('Ctrl-A', () => {
    assert.deepEqual(parse('\x01').events, [{ name: 'Ctrl-a' }]);
  });
  it('Ctrl-C', () => {
    assert.deepEqual(parse('\x03').events, [{ name: 'Ctrl-c' }]);
  });
  it('Ctrl-U', () => {
    assert.deepEqual(parse('\x15').events, [{ name: 'Ctrl-u' }]);
  });
});

describe('keys: CSI cursor', () => {
  it('Up', () => {
    assert.deepEqual(parse('\x1b[A').events, [{ name: 'Up' }]);
  });
  it('Down', () => {
    assert.deepEqual(parse('\x1b[B').events, [{ name: 'Down' }]);
  });
  it('Right', () => {
    assert.deepEqual(parse('\x1b[C').events, [{ name: 'Right' }]);
  });
  it('Left', () => {
    assert.deepEqual(parse('\x1b[D').events, [{ name: 'Left' }]);
  });
  it('Home / End', () => {
    assert.deepEqual(parse('\x1b[H').events, [{ name: 'Home' }]);
    assert.deepEqual(parse('\x1b[F').events, [{ name: 'End' }]);
  });
  it('Delete (ESC[3~)', () => {
    assert.deepEqual(parse('\x1b[3~').events, [{ name: 'Delete' }]);
  });
});

describe('keys: modifier-encoded cursor', () => {
  it('Ctrl-Left (ESC[1;5D)', () => {
    assert.deepEqual(parse('\x1b[1;5D').events, [{ name: 'Ctrl-Left' }]);
  });
  it('Ctrl-Right (ESC[1;5C)', () => {
    assert.deepEqual(parse('\x1b[1;5C').events, [{ name: 'Ctrl-Right' }]);
  });
  it('Alt-Left (ESC[1;3D)', () => {
    assert.deepEqual(parse('\x1b[1;3D').events, [{ name: 'Alt-Left' }]);
  });
});

describe('keys: Alt-<char>', () => {
  it('Alt-b', () => {
    assert.deepEqual(parse('\x1bb').events, [{ name: 'Alt-b' }]);
  });
  it('Alt-f', () => {
    assert.deepEqual(parse('\x1bf').events, [{ name: 'Alt-f' }]);
  });
  it('Alt-r (uppercase normalised to lowercase)', () => {
    assert.deepEqual(parse('\x1bR').events, [{ name: 'Alt-r' }]);
  });
  it('Alt-Backspace (ESC + DEL)', () => {
    assert.deepEqual(parse('\x1b\x7f').events, [{ name: 'Alt-Backspace' }]);
  });
});

describe('keys: bracketed paste', () => {
  it('single-chunk paste', () => {
    const r = parse('\x1b[200~hello world\x1b[201~');
    assert.deepEqual(r.events, [{ paste: 'hello world' }]);
  });
  it('paste with newlines stays atomic', () => {
    const r = parse('\x1b[200~line1\nline2\nline3\x1b[201~');
    assert.deepEqual(r.events, [{ paste: 'line1\nline2\nline3' }]);
  });
  it('split paste joined across chunks', () => {
    const state = { pasting: false, pasteBuf: '' };
    const r1 = parseKeys('\x1b[200~hello ', state);
    assert.equal(r1.events.length, 0);   // no events yet
    assert.equal(state.pasting, true);
    const r2 = parseKeys('world\x1b[201~', state);
    assert.deepEqual(r2.events, [{ paste: 'hello world' }]);
    assert.equal(state.pasting, false);
  });
  it('keys after paste continue parsing', () => {
    const r = parse('\x1b[200~hi\x1b[201~\r');
    assert.deepEqual(r.events, [{ paste: 'hi' }, { name: 'Enter' }]);
  });
});

describe('keys: split escape sequences', () => {
  it('lone ESC at end of chunk → leftover', () => {
    const r = parse('a\x1b');
    assert.deepEqual(r.events, [{ ch: 'a' }]);
    assert.equal(r.leftover, '\x1b');
  });
  it('split CSI: ESC[ in one chunk, A in the next', () => {
    const state = { pasting: false, pasteBuf: '' };
    const r1 = parseKeys('\x1b[', state);
    assert.equal(r1.leftover, '\x1b[');
    assert.equal(r1.events.length, 0);
    const r2 = parseKeys(r1.leftover + 'A', state);
    assert.deepEqual(r2.events, [{ name: 'Up' }]);
  });
});

describe('editor: cursor motion', () => {
  function make(text, cur) {
    const e = ed.createEditor();
    e.buffer = text;
    e.cursor = cur != null ? cur : text.length;
    return e;
  }
  it('moveLeft / moveRight clamp at ends', () => {
    const e = make('abc', 0);
    ed.moveLeft(e); assert.equal(e.cursor, 0);
    ed.moveRight(e); assert.equal(e.cursor, 1);
    e.cursor = 3;
    ed.moveRight(e); assert.equal(e.cursor, 3);
  });
  it('moveWordLeft skips non-word then word', () => {
    const e = make('foo bar baz', 11);
    ed.moveWordLeft(e); assert.equal(e.cursor, 8);
    ed.moveWordLeft(e); assert.equal(e.cursor, 4);
    ed.moveWordLeft(e); assert.equal(e.cursor, 0);
  });
  it('moveWordRight skips non-word then word', () => {
    const e = make('foo bar baz', 0);
    ed.moveWordRight(e); assert.equal(e.cursor, 3);
    ed.moveWordRight(e); assert.equal(e.cursor, 7);
    ed.moveWordRight(e); assert.equal(e.cursor, 11);
  });
  it('Home / End', () => {
    const e = make('hello world', 5);
    ed.moveHome(e); assert.equal(e.cursor, 0);
    ed.moveEnd(e);  assert.equal(e.cursor, 11);
  });
});

describe('editor: edits', () => {
  function make(text, cur) {
    const e = ed.createEditor();
    e.buffer = text;
    e.cursor = cur != null ? cur : text.length;
    return e;
  }
  it('insertText mid-line', () => {
    const e = make('helo', 2);
    ed.insertText(e, 'l');
    assert.equal(e.buffer, 'hello');
    assert.equal(e.cursor, 3);
  });
  it('deleteLeft removes char before cursor', () => {
    const e = make('hello', 5);
    ed.deleteLeft(e);
    assert.equal(e.buffer, 'hell');
    assert.equal(e.cursor, 4);
  });
  it('deleteRight removes char at cursor', () => {
    const e = make('hello', 0);
    ed.deleteRight(e);
    assert.equal(e.buffer, 'ello');
    assert.equal(e.cursor, 0);
  });
  it('killWordLeft into kill ring', () => {
    const e = make('foo bar', 7);
    ed.killWordLeft(e);
    assert.equal(e.buffer, 'foo ');
    assert.equal(e.killRing[0], 'bar');
  });
  it('killToEnd into kill ring', () => {
    const e = make('foo bar baz', 4);
    ed.killToEnd(e);
    assert.equal(e.buffer, 'foo ');
    assert.equal(e.killRing[0], 'bar baz');
  });
  it('killToStart into kill ring', () => {
    const e = make('foo bar baz', 8);
    ed.killToStart(e);
    assert.equal(e.buffer, 'baz');
    assert.equal(e.killRing[0], 'foo bar ');
  });
  it('yank pastes kill ring head at cursor', () => {
    const e = make('a c', 2);
    e.killRing = ['b'];
    ed.yank(e);
    assert.equal(e.buffer, 'a bc');
    assert.equal(e.cursor, 3);
  });
});

describe('editor: history + autosuggest', () => {
  it('historyUp/Down navigates and restores live buffer', () => {
    const e = ed.createEditor();
    e.history = ['echo one', 'echo two', 'echo three'];
    e.buffer = 'partial';
    e.cursor = 7;
    ed.historyUp(e);
    assert.equal(e.buffer, 'echo three');
    ed.historyUp(e);
    assert.equal(e.buffer, 'echo two');
    ed.historyDown(e);
    assert.equal(e.buffer, 'echo three');
    ed.historyDown(e);
    assert.equal(e.buffer, 'partial');
  });
  it('historyPush dedupes against last entry', () => {
    const e = ed.createEditor();
    e.history = ['ls'];
    ed.historyPush(e, 'ls');
    assert.deepEqual(e.history, ['ls']);
    ed.historyPush(e, 'cd /tmp');
    assert.deepEqual(e.history, ['ls', 'cd /tmp']);
  });
  it('suggestFromHistory picks most-recent matching prefix', () => {
    const e = ed.createEditor();
    e.history = ['echo one', 'cat foo', 'echo two'];
    e.buffer = 'ec';
    e.cursor = 2;
    ed.suggestFromHistory(e);
    assert.equal(e.suggestion, 'ho two');
  });
  it('acceptSuggestion completes the line', () => {
    const e = ed.createEditor();
    e.buffer = 'ec';
    e.cursor = 2;
    e.suggestion = 'ho two';
    ed.acceptSuggestion(e);
    assert.equal(e.buffer, 'echo two');
    assert.equal(e.cursor, 8);
    assert.equal(e.suggestion, '');
  });
});
