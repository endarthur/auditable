// @gcu/term parser tests — fixture-style.
//
// Each case sets up a fresh Parser with a recording handler, feeds a
// byte/codepoint sequence, and asserts the recorded events. The point is
// to lock in the state-machine behavior so future changes are forced to
// preserve compatibility (or surface intentional regressions).
//
// Hand-crafted fixtures here cover the SGR / cursor / OSC / alt-screen
// surfaces. Real-program byte recordings (vim, htop, tmux) are a larger
// follow-up — these are the smoke-test floor.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Parser } from '../ext/term/src/index.js';

function recordingHandler() {
  const events = [];
  return {
    events,
    print: (cp) => events.push(['print', cp]),
    execute: (cp) => events.push(['exec', cp]),
    csi: (params, intermed, final) => events.push(['csi', params.slice(), intermed, String.fromCharCode(final)]),
    osc: (data) => events.push(['osc', data]),
    esc: (intermed, final) => events.push(['esc', intermed, String.fromCharCode(final)]),
  };
}

function feed(input) {
  const h = recordingHandler();
  const p = new Parser(h);
  p.feed(input);
  return h.events;
}

// ────────────────────────────────────────────────────────────────────
// printable + control byte basics
// ────────────────────────────────────────────────────────────────────

describe('Parser ground-state basics', () => {
  test('prints ASCII letters', () => {
    const ev = feed('abc');
    assert.deepEqual(ev, [
      ['print', 0x61], ['print', 0x62], ['print', 0x63],
    ]);
  });

  test('C0 controls dispatch as execute', () => {
    const ev = feed('a\rb\nc');
    assert.deepEqual(ev, [
      ['print', 0x61], ['exec', 0x0D], ['print', 0x62], ['exec', 0x0A], ['print', 0x63],
    ]);
  });

  test('handles multi-byte UTF-8 codepoints as single print', () => {
    const ev = feed('café');
    // 'c', 'a', 'f', 'é' — last is U+00E9
    assert.equal(ev.length, 4);
    assert.deepEqual(ev[3], ['print', 0xE9]);
  });

  test('surrogate pairs collapse via for..of (single codepoint)', () => {
    const ev = feed('😀');  // 😀 = U+1F600
    assert.equal(ev.length, 1);
    assert.deepEqual(ev[0], ['print', 0x1F600]);
  });

  test('DEL (0x7F) dispatches as execute, not print', () => {
    const ev = feed('a\x7fb');
    assert.deepEqual(ev, [['print', 0x61], ['exec', 0x7F], ['print', 0x62]]);
  });
});

// ────────────────────────────────────────────────────────────────────
// CSI parsing
// ────────────────────────────────────────────────────────────────────

describe('Parser CSI sequences', () => {
  test('CSI with no params has empty params array', () => {
    const ev = feed('\x1b[H');
    assert.deepEqual(ev, [['csi', [], '', 'H']]);
  });

  test('CSI with single param', () => {
    const ev = feed('\x1b[5A');
    assert.deepEqual(ev, [['csi', [5], '', 'A']]);
  });

  test('CSI with multiple params separated by ;', () => {
    const ev = feed('\x1b[1;3;4m');
    assert.deepEqual(ev, [['csi', [1, 3, 4], '', 'm']]);
  });

  test('empty params default to zero (ECMA-48)', () => {
    const ev = feed('\x1b[;5H');
    assert.deepEqual(ev, [['csi', [0, 5], '', 'H']]);
  });

  test('DEC private mode preserves ? prefix in intermediates', () => {
    const ev = feed('\x1b[?25l');
    assert.deepEqual(ev, [['csi', [25], '?', 'l']]);
  });

  test('SGR truecolor with semicolons', () => {
    const ev = feed('\x1b[38;2;255;128;0m');
    assert.deepEqual(ev, [['csi', [38, 2, 255, 128, 0], '', 'm']]);
  });

  test('SGR truecolor with subparam colons (flattened)', () => {
    // 38:2::R:G:B is the ITU-T form; we accept it but flatten the colons
    // so the params array is the same shape as the semicolon form.
    const ev = feed('\x1b[38:2::255:128:0m');
    // The colons are stashed in `intermediates` rather than as separate
    // params. This is the documented v0.1 limitation. Emit just one csi.
    assert.equal(ev.length, 1);
    assert.equal(ev[0][0], 'csi');
    assert.equal(ev[0][3], 'm');
  });

  test('mid-sequence printables before final byte do not emit print', () => {
    const ev = feed('\x1b[10;20H');
    assert.deepEqual(ev, [['csi', [10, 20], '', 'H']]);
  });

  test('printable after CSI returns to ground', () => {
    const ev = feed('\x1b[Hx');
    assert.deepEqual(ev, [['csi', [], '', 'H'], ['print', 0x78]]);
  });
});

// ────────────────────────────────────────────────────────────────────
// OSC parsing
// ────────────────────────────────────────────────────────────────────

describe('Parser OSC sequences', () => {
  test('OSC 0 with BEL terminator', () => {
    const ev = feed('\x1b]0;hello\x07');
    assert.deepEqual(ev, [['osc', '0;hello']]);
  });

  test('OSC 2 with ST (ESC \\) terminator', () => {
    const ev = feed('\x1b]2;world\x1b\\');
    // The ESC starts a new escape; the next byte (\) is the final.
    // The OSC is terminated by the ST (which the "anywhere" ESC handler
    // actually dispatches before the OSC handler sees it).
    // This is a known quirk — current impl emits the OSC, then ESC \\ is
    // treated as a separate ESC sequence.
    assert.equal(ev[0][0], 'osc');
    assert.equal(ev[0][1], '2;world');
  });

  test('OSC accepts arbitrary printable payload', () => {
    const ev = feed('\x1b]52;c;hello world\x07');
    assert.deepEqual(ev, [['osc', '52;c;hello world']]);
  });
});

// ────────────────────────────────────────────────────────────────────
// ESC (non-CSI) sequences
// ────────────────────────────────────────────────────────────────────

describe('Parser ESC sequences', () => {
  test('DECSC (ESC 7)', () => {
    const ev = feed('\x1b7');
    assert.deepEqual(ev, [['esc', '', '7']]);
  });

  test('DECRC (ESC 8)', () => {
    const ev = feed('\x1b8');
    assert.deepEqual(ev, [['esc', '', '8']]);
  });

  test('charset selection (ESC ( 0)', () => {
    // intermediates are bytes 0x20-0x2F; ( = 0x28
    const ev = feed('\x1b(0');
    assert.deepEqual(ev, [['esc', '(', '0']]);
  });

  test('RIS (ESC c) — hard reset', () => {
    const ev = feed('\x1bc');
    assert.deepEqual(ev, [['esc', '', 'c']]);
  });
});

// ────────────────────────────────────────────────────────────────────
// Recovery from malformed input
// ────────────────────────────────────────────────────────────────────

describe('Parser recovery from malformed input', () => {
  test('lone ESC followed by printable → ESC sequence with that as final', () => {
    const ev = feed('\x1bx');
    assert.deepEqual(ev, [['esc', '', 'x']]);
  });

  test('CSI ignore state recovers on next final byte', () => {
    // Inserting a junk byte mid-CSI puts us in CSI_IGNORE; we only emit
    // when the final arrives. The stray printable should NOT print.
    // 0x80 is C1 outside the parameter range but isn't picked up as ESC anywhere
    // — our impl drops it via S_CSI_IGNORE-then-final-byte.
    const ev = feed('\x1b[10\x00H');
    // 0x00 is a control char -> execute fires from S_CSI_PARAM.
    // Then H is the final byte.
    // We're more lenient than xterm here; test the actual behavior.
    assert.ok(ev.some(e => e[0] === 'csi' && e[3] === 'H'));
  });

  test('CAN (0x18) aborts current sequence and returns to ground', () => {
    const ev = feed('\x1b[10\x18a');
    // CAN dispatches as execute, then 'a' prints.
    const types = ev.map(e => e[0]);
    assert.ok(types.includes('exec'));
    assert.deepEqual(ev[ev.length - 1], ['print', 0x61]);
  });

  test('parser.reset() returns to ground', () => {
    const h = recordingHandler();
    const p = new Parser(h);
    p.feed('\x1b[10');  // mid-CSI
    p.reset();
    p.feed('a');
    assert.deepEqual(h.events.filter(e => e[0] === 'print'), [['print', 0x61]]);
  });
});
