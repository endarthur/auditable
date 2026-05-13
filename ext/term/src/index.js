/* @gcu/term — browser-native terminal emulator
 *
 * A self-contained VT/ANSI terminal emulator with a generic byte-stream
 * interface.  Built around Paul Williams' state machine parser and a
 * DOM-based renderer.  Designed for embedded consoles, REPLs, and log
 * viewers in the Auditable Works ecosystem; not a replacement for
 * xterm.js at full TUI scale.
 *
 * Public exports:
 *   Parser              — VT/ANSI state-machine parser (codepoint-fed)
 *   Terminal            — terminal state model + byte-stream API
 *   DomRenderer         — canonical renderer (rows of <span> runs)
 *   Input               — keyboard + mouse + paste + selection handler
 *   PALETTE, PAL256     — 16- and 256-color palettes
 *   FLAG_*              — SGR attribute bit-flags
 *   DEFAULT_FG, DEFAULT_BG — sentinels for "use the theme default"
 *
 * License: MIT
 * See SPEC.md for the specification.
 */

/* ============================================================
 * 1.  WILLIAMS VT/ANSI PARSER
 *     A faithful (lite) translation of Paul Williams' state
 *     machine.  We feed it Unicode codepoints, not bytes:
 *     UTF-8 decoding happens upstream via TextDecoder, so any
 *     codepoint >= 0x20 (and != 0x7F) is treated as printable
 *     in GROUND.  Control bytes (0x00-0x1F, 0x7F) drive state
 *     transitions exactly as in the canonical chart.
 * ============================================================ */

const S_GROUND       = 0;
const S_ESCAPE       = 1;
const S_ESC_INT      = 2;
const S_CSI_ENTRY    = 3;
const S_CSI_PARAM    = 4;
const S_CSI_INT      = 5;
const S_CSI_IGNORE   = 6;
const S_OSC_STRING   = 7;
const S_DCS_ENTRY    = 8;
const S_DCS_IGNORE   = 9;
const S_SOSPMAPC     = 10;

// Shared listener-array subscribe pattern: pushes the cb, returns an
// unsubscribe function. Defensive against the cb being unsubscribed
// during fanout (the listeners array is filtered, not spliced in place).
function _subscribe(arr, cb) {
  arr.push(cb);
  return () => {
    const i = arr.indexOf(cb);
    if (i >= 0) arr.splice(i, 1);
  };
}

function _logListenerError(err) {
  try { console.error('[@gcu/term] listener threw:', err); }
  catch (_) { /* host has no console — swallow */ }
}

export class Parser {
  constructor(handler) {
    this.h = handler;
    this.state = S_GROUND;
    this.params = [];
    this.collected = ""; // intermediates collected via CSI/ESC
    this.osc = "";
  }
  reset() {
    this.state = S_GROUND;
    this.params = [];
    this.collected = "";
    this.osc = "";
  }
  feed(str) {
    // str is a JS string (codepoints).  Iterate via for..of so
    // surrogate pairs collapse to single codepoints.
    for (const ch of str) this.step(ch.codePointAt(0));
  }
  // --- helpers ---
  _csiParam(cp) {
    // gather parameter bytes 0x30..0x3F (digits, ';', ':', '<','=','>','?')
    // We keep params as a flat int array; ';' opens a new slot.
    if (cp === 0x3B) {
      // Ensure the leading slot exists (so ';5' parses as [0, 5], not [5]),
      // then open a new empty slot for the upcoming param. ECMA-48 default-
      // to-zero applies per slot.
      if (this.params.length === 0) this.params.push(0);
      this.params.push(0);
      return;
    }
    if (cp >= 0x30 && cp <= 0x39) {
      if (this.params.length === 0) this.params.push(0);
      const i = this.params.length - 1;
      this.params[i] = (this.params[i] * 10 + (cp - 0x30)) | 0;
      return;
    }
    // ':' (subparam), '<','=','>','?' - stash in collected as prefix-byte
    this.collected += String.fromCharCode(cp);
  }
  step(cp) {
    // -------- "anywhere" transitions (apply in every state) --------
    if (cp === 0x18 || cp === 0x1A) {           // CAN / SUB
      this.h.execute(cp); this.state = S_GROUND; return;
    }
    if (cp === 0x1B) {                          // ESC
      // ST = ESC \ when in OSC: fire the OSC handler before transitioning
      // so the payload isn't dropped. The trailing \ then arrives in
      // S_ESCAPE and dispatches as esc('','\\') — hosts ignore it
      // because '\\' isn't a recognized final byte.
      if (this.state === S_OSC_STRING) this.h.osc(this.osc);
      this.params = []; this.collected = "";
      this.state = S_ESCAPE; return;
    }
    // C1 (8-bit) shortcuts - we don't see these via TextDecoder but cheap to support
    if (cp === 0x9B) { this.params = []; this.collected = ""; this.state = S_CSI_ENTRY; return; }
    if (cp === 0x9D) { this.osc = ""; this.state = S_OSC_STRING; return; }
    if (cp === 0x90) { this.params = []; this.collected = ""; this.state = S_DCS_ENTRY; return; }
    if (cp === 0x9C) { this.state = S_GROUND; return; }

    switch (this.state) {
    case S_GROUND:
      if (cp < 0x20 || cp === 0x7F) { this.h.execute(cp); return; }
      this.h.print(cp); return;

    case S_ESCAPE:
      if (cp < 0x20) { this.h.execute(cp); return; }
      if (cp === 0x7F) return;
      if (cp >= 0x20 && cp <= 0x2F) {           // intermediate
        this.collected += String.fromCharCode(cp);
        this.state = S_ESC_INT; return;
      }
      if (cp === 0x5B /* [ */) { this.params = []; this.collected = ""; this.state = S_CSI_ENTRY; return; }
      if (cp === 0x5D /* ] */) { this.osc = ""; this.state = S_OSC_STRING; return; }
      if (cp === 0x50 /* P */) { this.params = []; this.collected = ""; this.state = S_DCS_ENTRY; return; }
      if (cp === 0x58 || cp === 0x5E || cp === 0x5F) { this.state = S_SOSPMAPC; return; }
      // final byte
      this.h.esc(this.collected, cp);
      this.state = S_GROUND; return;

    case S_ESC_INT:
      if (cp < 0x20) { this.h.execute(cp); return; }
      if (cp === 0x7F) return;
      if (cp >= 0x20 && cp <= 0x2F) { this.collected += String.fromCharCode(cp); return; }
      this.h.esc(this.collected, cp);
      this.state = S_GROUND; return;

    case S_CSI_ENTRY:
      if (cp < 0x20) { this.h.execute(cp); return; }
      if (cp === 0x7F) return;
      if (cp >= 0x40 && cp <= 0x7E) {           // final
        this.h.csi(this.params, this.collected, cp);
        this.state = S_GROUND; return;
      }
      if (cp >= 0x30 && cp <= 0x3F) { this._csiParam(cp); this.state = S_CSI_PARAM; return; }
      if (cp >= 0x20 && cp <= 0x2F) { this.collected += String.fromCharCode(cp); this.state = S_CSI_INT; return; }
      this.state = S_CSI_IGNORE; return;

    case S_CSI_PARAM:
      if (cp < 0x20) { this.h.execute(cp); return; }
      if (cp === 0x7F) return;
      if (cp >= 0x30 && cp <= 0x3F) { this._csiParam(cp); return; }
      if (cp >= 0x20 && cp <= 0x2F) { this.collected += String.fromCharCode(cp); this.state = S_CSI_INT; return; }
      if (cp >= 0x40 && cp <= 0x7E) {
        this.h.csi(this.params, this.collected, cp);
        this.state = S_GROUND; return;
      }
      this.state = S_CSI_IGNORE; return;

    case S_CSI_INT:
      if (cp < 0x20) { this.h.execute(cp); return; }
      if (cp === 0x7F) return;
      if (cp >= 0x20 && cp <= 0x2F) { this.collected += String.fromCharCode(cp); return; }
      if (cp >= 0x40 && cp <= 0x7E) {
        this.h.csi(this.params, this.collected, cp);
        this.state = S_GROUND; return;
      }
      this.state = S_CSI_IGNORE; return;

    case S_CSI_IGNORE:
      if (cp >= 0x40 && cp <= 0x7E) { this.state = S_GROUND; }
      return;

    case S_OSC_STRING:
      if (cp === 0x07) { this.h.osc(this.osc); this.state = S_GROUND; return; }   // BEL terminator
      if (cp === 0x9C) { this.h.osc(this.osc); this.state = S_GROUND; return; }
      // ST = ESC \  — handled by the ESC anywhere transition above
      if (cp >= 0x20) this.osc += String.fromCharCode(cp);
      return;

    case S_DCS_ENTRY:
      // we don't really care - just consume until ST
      if (cp === 0x9C || cp === 0x07) { this.state = S_GROUND; return; }
      return;
    case S_DCS_IGNORE:
      if (cp === 0x9C) { this.state = S_GROUND; }
      return;
    case S_SOSPMAPC:
      if (cp === 0x9C || cp === 0x07) { this.state = S_GROUND; }
      return;
    }
  }
}

/* ============================================================
 * 2.  TERMINAL STATE MODEL
 *     - cell = {ch, fg, bg, flags}
 *     - fg/bg = {t:'d'} default | {t:'p',i:n} palette | {t:'r',r,g,b} truecolor
 *     - flags = bitfield: BOLD, ITALIC, UNDER, REVERSE, STRIKE, DIM, INVIS
 *     - BLINK is recorded on the cell but the renderer ignores it by
 *       default (no per-frame animation cost). Hosts that want blinking
 *       can subclass DomRenderer or read FLAG_BLINK during render to
 *       drive their own animation.
 * ============================================================ */

export const FLAG_BOLD    = 1 << 0;
export const FLAG_DIM     = 1 << 1;
export const FLAG_ITALIC  = 1 << 2;
export const FLAG_UNDER   = 1 << 3;
export const FLAG_BLINK   = 1 << 4;
export const FLAG_REVERSE = 1 << 5;
export const FLAG_INVIS   = 1 << 6;
export const FLAG_STRIKE  = 1 << 7;

export const DEFAULT_FG = Object.freeze({t:'d'});
export const DEFAULT_BG = Object.freeze({t:'d'});

function makeCell() {
  return { ch: 0x20, fg: DEFAULT_FG, bg: DEFAULT_BG, flags: 0 };
}
function copyCell(dst, src) {
  dst.ch = src.ch; dst.fg = src.fg; dst.bg = src.bg; dst.flags = src.flags;
}
function makeBuffer(cols, rows) {
  const b = new Array(rows);
  for (let y = 0; y < rows; y++) {
    const row = new Array(cols);
    for (let x = 0; x < cols; x++) row[x] = makeCell();
    b[y] = row;
  }
  return b;
}

// Default mode values — kept in one place so _reset() and the constructor
// agree. Booleans for toggles, integers (0) for slot-based selectors like
// mouseProto / mouseEncoding so downstream `if (proto === 1000)` checks stay
// well-typed across resets.
function defaultModes() {
  return {
    wrap: true,
    cursorVisible: true,
    appCursor: false,
    appKeypad: false,
    mouseProto: 0,            // 0 | 1000 | 1002 | 1003
    mouseEncoding: 0,         // 0 (X10) | 1006 (SGR)
    bracketedPaste: false,
    reverseVideo: false,
  };
}

export class Terminal {
  constructor(cols = 80, rows = 24) {
    this.cols = cols;
    this.rows = rows;
    this.buffer = makeBuffer(cols, rows);
    this.altBuffer = null;
    this.usingAlt = false;
    this.cursor = { x: 0, y: 0 };
    this.savedCursor = { x: 0, y: 0, fg: DEFAULT_FG, bg: DEFAULT_BG, flags: 0 };
    this.pendingWrap = false;     // DECAWM "phantom column"
    this.scrollTop = 0;
    this.scrollBottom = rows - 1;
    this.attrs = { fg: DEFAULT_FG, bg: DEFAULT_BG, flags: 0 };
    this.modes = defaultModes();
    this.title = "";
    this.dirty = true;
    this.parser = new Parser(this);
    this.dataListeners = [];
    this.bellListeners = [];
    this.titleListeners = [];
    this._textDecoder = new TextDecoder('utf-8');
    this._textEncoder = new TextEncoder();
    this.bytesIn = 0;
    this.bytesOut = 0;
    this._disposed = false;
  }

  /* ---------- public byte-stream API ---------- */
  write(input) {
    if (this._disposed) return;
    const s = (typeof input === 'string')
      ? input
      : this._textDecoder.decode(input);
    this.bytesIn += s.length;
    this.parser.feed(s);
    this.dirty = true;
  }
  onData(cb) { return _subscribe(this.dataListeners, cb); }

  /**
   * Convenience: subscribe to outbound bytes already decoded as a string.
   * Equivalent to onData(b => cb(new TextDecoder().decode(b))) but allocates
   * one decoder instead of one per fanout. Returns an unsubscribe function.
   */
  onText(cb) {
    return _subscribe(this.dataListeners, (bytes) => {
      cb(this._textDecoder.decode(bytes));
    });
  }

  /**
   * Subscribe to BEL (0x07). Fires every time the host sends a bell byte.
   * Hosts can ignore, play a sound, flash the screen, or whatever they
   * decide is appropriate. Returns an unsubscribe function.
   */
  onBell(cb) { return _subscribe(this.bellListeners, cb); }

  /**
   * Subscribe to OSC 0/1/2 window-title changes. Receives the new title
   * string. The library does NOT mutate document.title on its own —
   * mirroring to the document title is an opt-in side effect the host
   * decides on, e.g. `term.onTitleChange(t => document.title = t)`.
   * Returns an unsubscribe function.
   */
  onTitleChange(cb) { return _subscribe(this.titleListeners, cb); }

  // Synchronous fan-out. Listener exceptions are caught and logged so a
  // single misbehaving consumer can't take down the rest of the chain or
  // the in-progress CSI handler that triggered the send.
  _send(s) {
    if (this._disposed) return;
    this.bytesOut += s.length;
    const bytes = this._textEncoder.encode(s);
    for (const cb of this.dataListeners) {
      try { cb(bytes); }
      catch (err) { _logListenerError(err); }
    }
  }

  _emit(listeners, value) {
    for (const cb of listeners) {
      try { cb(value); }
      catch (err) { _logListenerError(err); }
    }
  }

  /**
   * Detach all listeners, drop buffers, and mark the terminal inert.
   * Subsequent write() / _send() are no-ops. Idempotent. Hosts should
   * call this when the terminal is no longer needed (cell re-run, tab
   * close) so the cell buffers and listener closures can be collected.
   * Use alongside Input.dispose() and DomRenderer.dispose() — the three
   * layers each own their resources.
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.dataListeners = [];
    this.bellListeners = [];
    this.titleListeners = [];
    this.buffer = null;
    this.altBuffer = null;
  }

  /* ---------- buffer helpers ---------- */
  _curBuf() { return this.usingAlt ? this.altBuffer : this.buffer; }
  _clearCell(c) { c.ch = 0x20; c.fg = DEFAULT_FG; c.bg = this.attrs.bg; c.flags = 0; }
  _newRow() {
    const row = new Array(this.cols);
    for (let x = 0; x < this.cols; x++) {
      row[x] = makeCell();
      row[x].bg = this.attrs.bg;
    }
    return row;
  }
  _scrollUp(n = 1) {
    const buf = this._curBuf();
    for (let i = 0; i < n; i++) {
      buf.splice(this.scrollTop, 1);
      buf.splice(this.scrollBottom, 0, this._newRow());
    }
  }
  _scrollDown(n = 1) {
    const buf = this._curBuf();
    for (let i = 0; i < n; i++) {
      buf.splice(this.scrollBottom, 1);
      buf.splice(this.scrollTop, 0, this._newRow());
    }
  }
  _lineFeed() {
    if (this.cursor.y === this.scrollBottom) this._scrollUp(1);
    else this.cursor.y = Math.min(this.rows - 1, this.cursor.y + 1);
  }
  _carriageReturn() { this.cursor.x = 0; this.pendingWrap = false; }

  /* ============================================================
   *   PARSER HANDLER METHODS
   * ============================================================ */

  print(cp) {
    if (this.pendingWrap && this.modes.wrap) {
      this._carriageReturn();
      this._lineFeed();
    }
    this.pendingWrap = false;
    const buf = this._curBuf();
    const cell = buf[this.cursor.y][this.cursor.x];
    cell.ch = cp;
    cell.fg = this.attrs.fg;
    cell.bg = this.attrs.bg;
    cell.flags = this.attrs.flags;
    if (this.cursor.x === this.cols - 1) {
      this.pendingWrap = true;       // DECAWM phantom column
    } else {
      this.cursor.x++;
    }
  }

  execute(cp) {
    switch (cp) {
    case 0x07: /* BEL */ this._emit(this.bellListeners, undefined); return;
    case 0x08: /* BS  */
      if (this.cursor.x > 0) this.cursor.x--;
      this.pendingWrap = false;
      return;
    case 0x09: /* HT  */ {
      // tab to next 8-column stop
      const next = (Math.floor(this.cursor.x / 8) + 1) * 8;
      this.cursor.x = Math.min(this.cols - 1, next);
      return;
    }
    case 0x0A: /* LF */
    case 0x0B: /* VT */
    case 0x0C: /* FF */
      this._lineFeed();
      this.pendingWrap = false;
      return;
    case 0x0D: /* CR */ this._carriageReturn(); return;
    }
  }

  esc(intermediates, final) {
    switch (final) {
    case 0x37: /* '7' */ this._saveCursor(); return;
    case 0x38: /* '8' */ this._restoreCursor(); return;
    case 0x44: /* 'D' IND */ this._lineFeed(); return;
    case 0x45: /* 'E' NEL */ this._carriageReturn(); this._lineFeed(); return;
    case 0x4D: /* 'M' RI  */
      if (this.cursor.y === this.scrollTop) this._scrollDown(1);
      else this.cursor.y--;
      return;
    case 0x63: /* 'c' RIS - hard reset */ this._reset(); return;
    case 0x3D: /* '=' application keypad */ this.modes.appKeypad = true; return;
    case 0x3E: /* '>' normal keypad      */ this.modes.appKeypad = false; return;
    }
  }

  osc(data) {
    // data is "Ps;Pt"
    const sep = data.indexOf(';');
    if (sep < 0) return;
    const ps = parseInt(data.slice(0, sep), 10);
    const pt = data.slice(sep + 1);
    switch (ps) {
    case 0: case 1: case 2:
      this.title = pt;
      this._emit(this.titleListeners, pt);
      return;
    case 8: /* hyperlink - ignore for prototype */ return;
    }
  }

  csi(params, prefix, final) {
    // helper: 1-based param with default
    const p = (i, d = 1) => {
      const v = params[i];
      return (v === undefined || v === 0) ? d : v;
    };
    const p0 = (i, d = 0) => (params[i] === undefined ? d : params[i]);

    // DEC private (prefix '?')
    if (prefix === '?') {
      const set = (final === 0x68); // 'h' set, 'l' reset
      if (final !== 0x68 && final !== 0x6C) return;
      for (const m of params) this._decPrivate(m, set);
      return;
    }

    switch (final) {
    case 0x40: /* @ ICH */ this._insertChars(p(0)); return;
    case 0x41: /* A CUU */ this.cursor.y = Math.max(this.scrollTop, this.cursor.y - p(0)); this.pendingWrap=false; return;
    case 0x42: /* B CUD */ this.cursor.y = Math.min(this.scrollBottom, this.cursor.y + p(0)); this.pendingWrap=false; return;
    case 0x43: /* C CUF */ this.cursor.x = Math.min(this.cols - 1, this.cursor.x + p(0)); this.pendingWrap=false; return;
    case 0x44: /* D CUB */ this.cursor.x = Math.max(0, this.cursor.x - p(0)); this.pendingWrap=false; return;
    case 0x45: /* E CNL */ this.cursor.x = 0; this.cursor.y = Math.min(this.scrollBottom, this.cursor.y + p(0)); this.pendingWrap=false; return;
    case 0x46: /* F CPL */ this.cursor.x = 0; this.cursor.y = Math.max(this.scrollTop, this.cursor.y - p(0)); this.pendingWrap=false; return;
    case 0x47: /* G CHA */ this.cursor.x = Math.min(this.cols - 1, p(0) - 1); this.pendingWrap=false; return;
    case 0x48: /* H CUP */
    case 0x66: /* f HVP */ {
      const r = p(0) - 1, c = p(1) - 1;
      this.cursor.y = Math.max(0, Math.min(this.rows - 1, r));
      this.cursor.x = Math.max(0, Math.min(this.cols - 1, c));
      this.pendingWrap = false;
      return;
    }
    case 0x4A: /* J ED */ this._eraseDisplay(p0(0)); return;
    case 0x4B: /* K EL */ this._eraseLine(p0(0)); return;
    case 0x4C: /* L IL */ this._insertLines(p(0)); return;
    case 0x4D: /* M DL */ this._deleteLines(p(0)); return;
    case 0x50: /* P DCH */ this._deleteChars(p(0)); return;
    case 0x53: /* S SU  */ this._scrollUp(p(0)); return;
    case 0x54: /* T SD  */ this._scrollDown(p(0)); return;
    case 0x58: /* X ECH */ this._eraseChars(p(0)); return;
    case 0x63: /* c DA  */ this._send("\x1b[?6c"); return; // "I am a VT102"
    case 0x64: /* d VPA */ this.cursor.y = Math.max(0, Math.min(this.rows - 1, p(0) - 1)); this.pendingWrap=false; return;
    case 0x6D: /* m SGR */ this._sgr(params); return;
    case 0x6E: /* n DSR */ {
      if (p(0) === 6) this._send(`\x1b[${this.cursor.y + 1};${this.cursor.x + 1}R`);
      else if (p(0) === 5) this._send("\x1b[0n");
      return;
    }
    case 0x72: /* r DECSTBM */ {
      const top = p(0) - 1;
      const bot = p(1, this.rows) - 1;
      if (top < bot && bot < this.rows) {
        this.scrollTop = top;
        this.scrollBottom = bot;
        this.cursor.x = 0;
        this.cursor.y = 0;
      }
      return;
    }
    case 0x73: /* s save cursor (ANSI) */ this._saveCursor(); return;
    case 0x75: /* u restore cursor    */ this._restoreCursor(); return;
    }
  }

  /* ---------- erase ops ---------- */
  _eraseDisplay(mode) {
    const buf = this._curBuf();
    if (mode === 0) {
      // cursor → end
      for (let x = this.cursor.x; x < this.cols; x++) this._clearCell(buf[this.cursor.y][x]);
      for (let y = this.cursor.y + 1; y < this.rows; y++)
        for (let x = 0; x < this.cols; x++) this._clearCell(buf[y][x]);
    } else if (mode === 1) {
      for (let y = 0; y < this.cursor.y; y++)
        for (let x = 0; x < this.cols; x++) this._clearCell(buf[y][x]);
      for (let x = 0; x <= this.cursor.x; x++) this._clearCell(buf[this.cursor.y][x]);
    } else {
      for (let y = 0; y < this.rows; y++)
        for (let x = 0; x < this.cols; x++) this._clearCell(buf[y][x]);
    }
  }
  _eraseLine(mode) {
    const buf = this._curBuf();
    const row = buf[this.cursor.y];
    if (mode === 0) { for (let x = this.cursor.x; x < this.cols; x++) this._clearCell(row[x]); }
    else if (mode === 1) { for (let x = 0; x <= this.cursor.x; x++) this._clearCell(row[x]); }
    else { for (let x = 0; x < this.cols; x++) this._clearCell(row[x]); }
  }
  _eraseChars(n) {
    const row = this._curBuf()[this.cursor.y];
    for (let i = 0; i < n && this.cursor.x + i < this.cols; i++)
      this._clearCell(row[this.cursor.x + i]);
  }
  _insertChars(n) {
    const row = this._curBuf()[this.cursor.y];
    for (let i = 0; i < n; i++) {
      row.splice(this.cursor.x, 0, makeCell());
      row.pop();
    }
  }
  _deleteChars(n) {
    const row = this._curBuf()[this.cursor.y];
    for (let i = 0; i < n; i++) {
      row.splice(this.cursor.x, 1);
      const c = makeCell(); c.bg = this.attrs.bg;
      row.push(c);
    }
  }
  _insertLines(n) {
    if (this.cursor.y < this.scrollTop || this.cursor.y > this.scrollBottom) return;
    const buf = this._curBuf();
    for (let i = 0; i < n; i++) {
      buf.splice(this.scrollBottom, 1);
      buf.splice(this.cursor.y, 0, this._newRow());
    }
  }
  _deleteLines(n) {
    if (this.cursor.y < this.scrollTop || this.cursor.y > this.scrollBottom) return;
    const buf = this._curBuf();
    for (let i = 0; i < n; i++) {
      buf.splice(this.cursor.y, 1);
      buf.splice(this.scrollBottom, 0, this._newRow());
    }
  }

  /* ---------- SGR (the colors-and-attributes machine) ---------- */
  _sgr(params) {
    if (params.length === 0) params = [0];
    for (let i = 0; i < params.length; i++) {
      const n = params[i];
      if (n === 0)        { this.attrs.fg = DEFAULT_FG; this.attrs.bg = DEFAULT_BG; this.attrs.flags = 0; }
      else if (n === 1)   this.attrs.flags |= FLAG_BOLD;
      else if (n === 2)   this.attrs.flags |= FLAG_DIM;
      else if (n === 3)   this.attrs.flags |= FLAG_ITALIC;
      else if (n === 4)   this.attrs.flags |= FLAG_UNDER;
      else if (n === 5)   this.attrs.flags |= FLAG_BLINK;
      else if (n === 7)   this.attrs.flags |= FLAG_REVERSE;
      else if (n === 8)   this.attrs.flags |= FLAG_INVIS;
      else if (n === 9)   this.attrs.flags |= FLAG_STRIKE;
      else if (n === 22)  this.attrs.flags &= ~(FLAG_BOLD | FLAG_DIM);
      else if (n === 23)  this.attrs.flags &= ~FLAG_ITALIC;
      else if (n === 24)  this.attrs.flags &= ~FLAG_UNDER;
      else if (n === 25)  this.attrs.flags &= ~FLAG_BLINK;
      else if (n === 27)  this.attrs.flags &= ~FLAG_REVERSE;
      else if (n === 28)  this.attrs.flags &= ~FLAG_INVIS;
      else if (n === 29)  this.attrs.flags &= ~FLAG_STRIKE;
      else if (n >= 30 && n <= 37)   this.attrs.fg = {t:'p', i: n - 30};
      else if (n === 38) {
        const m = params[i+1];
        if (m === 5)      { this.attrs.fg = {t:'p', i: params[i+2] || 0}; i += 2; }
        else if (m === 2) { this.attrs.fg = {t:'r', r: params[i+2]||0, g: params[i+3]||0, b: params[i+4]||0}; i += 4; }
      }
      else if (n === 39)            this.attrs.fg = DEFAULT_FG;
      else if (n >= 40 && n <= 47)  this.attrs.bg = {t:'p', i: n - 40};
      else if (n === 48) {
        const m = params[i+1];
        if (m === 5)      { this.attrs.bg = {t:'p', i: params[i+2] || 0}; i += 2; }
        else if (m === 2) { this.attrs.bg = {t:'r', r: params[i+2]||0, g: params[i+3]||0, b: params[i+4]||0}; i += 4; }
      }
      else if (n === 49)            this.attrs.bg = DEFAULT_BG;
      else if (n >= 90 && n <= 97)  this.attrs.fg = {t:'p', i: n - 90 + 8};
      else if (n >= 100 && n <= 107) this.attrs.bg = {t:'p', i: n - 100 + 8};
    }
  }

  /* ---------- DEC private modes ---------- */
  _decPrivate(mode, set) {
    switch (mode) {
    case 1:    this.modes.appCursor = set; return;
    case 5:    this.modes.reverseVideo = set; return;
    case 7:    this.modes.wrap = set; return;
    case 25:   this.modes.cursorVisible = set; return;
    case 1000: this.modes.mouseProto = set ? 1000 : 0; return;
    case 1002: this.modes.mouseProto = set ? 1002 : 0; return;
    case 1003: this.modes.mouseProto = set ? 1003 : 0; return;
    case 1006: this.modes.mouseEncoding = set ? 1006 : 0; return;
    case 2004: this.modes.bracketedPaste = set; return;
    case 47:
    case 1047:
    case 1049: this._switchScreen(set); return;
    case 1048: set ? this._saveCursor() : this._restoreCursor(); return;
    }
  }
  _switchScreen(toAlt) {
    if (toAlt === this.usingAlt) return;
    if (toAlt) {
      this._saveCursor();
      this.altBuffer = makeBuffer(this.cols, this.rows);
      this.usingAlt = true;
      this.cursor.x = 0; this.cursor.y = 0;
      this._eraseDisplay(2);
    } else {
      this.altBuffer = null;
      this.usingAlt = false;
      this._restoreCursor();
    }
  }
  _saveCursor() {
    this.savedCursor = {
      x: this.cursor.x, y: this.cursor.y,
      fg: this.attrs.fg, bg: this.attrs.bg, flags: this.attrs.flags,
    };
  }
  _restoreCursor() {
    this.cursor.x = this.savedCursor.x;
    this.cursor.y = this.savedCursor.y;
    this.attrs.fg = this.savedCursor.fg;
    this.attrs.bg = this.savedCursor.bg;
    this.attrs.flags = this.savedCursor.flags;
  }
  _reset() {
    this.parser.reset();
    this.buffer = makeBuffer(this.cols, this.rows);
    this.altBuffer = null;
    this.usingAlt = false;
    this.cursor = {x:0,y:0};
    this.attrs = { fg: DEFAULT_FG, bg: DEFAULT_BG, flags: 0 };
    this.scrollTop = 0; this.scrollBottom = this.rows - 1;
    this.pendingWrap = false;
    // Reset every mode to its constructor default. Using defaultModes()
    // (rather than `for (k in modes) modes[k] = false`) preserves the
    // boolean / integer typing — mouseProto stays 0, not false.
    this.modes = defaultModes();
  }
}

/* ============================================================
 * 3.  DOM RENDERER
 *     One <div class="row"> per screen line.  Each row's
 *     innerHTML is a series of <span style="...">runs</span>
 *     coalesced by attribute equality.  Rows are diffed by
 *     comparing the generated HTML string before assignment,
 *     so unchanged rows skip the DOM mutation entirely.
 *
 *     Cursor lives as a single absolutely-positioned overlay
 *     so cursor blinks don't invalidate row contents — which
 *     means the browser's native text selection survives.
 *
 *     a11y: container is role=log + aria-live=polite, so new
 *     output is announced by screen readers automatically.
 * ============================================================ */

// 16-color palette (muted, not the harsh defaults)
export const PALETTE = [
  "#1d2128", "#c0533d", "#7fa650", "#cba24b",
  "#4a8fb8", "#9b6ea8", "#5fa8a3", "#c8cdd4",
  "#3a4049", "#e26a4f", "#9bc266", "#e6bf66",
  "#6cb1d8", "#bd8ec8", "#7fcec8", "#f0f4fa",
];
function buildPalette256() {
  const p = PALETTE.slice();
  const levels = [0, 95, 135, 175, 215, 255];
  for (let r = 0; r < 6; r++)
    for (let g = 0; g < 6; g++)
      for (let b = 0; b < 6; b++)
        p.push(`rgb(${levels[r]},${levels[g]},${levels[b]})`);
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    p.push(`rgb(${v},${v},${v})`);
  }
  return p;
}
export const PAL256 = buildPalette256();

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

export class DomRenderer {
  /**
   * @param {Terminal} term
   * @param {HTMLElement} container — host element to render into
   * @param {object} [opts]
   * @param {object} [opts.theme] — optional partial theme. Recognized keys:
   *   - `palette`: 16-color array OR a function
   *       `(idx, layer) => string` returning a CSS color for index 0-255
   *       (`layer` is `'fg'` | `'bg'`). Lets the host bridge to its own
   *       token system (e.g. Auditable's `--au-*` swatches).
   *   - `defaultFg` / `defaultBg`: CSS colors used when a cell carries the
   *       DEFAULT sentinel. If omitted, the renderer falls back to the
   *       cell-style "no color emitted" rule and inherits from CSS.
   */
  constructor(term, container, opts = {}) {
    this.term = term;
    this.container = container;
    this.theme = opts.theme || null;
    this.rows = [];          // div elements
    this.rowHTML = [];       // last-rendered HTML per row (for diffing)
    this.cursorOn = true;
    this._buildRows();
    this._measure();

    // cursor overlay
    this.cursorEl = document.createElement('div');
    this.cursorEl.className = 'cur';
    container.appendChild(this.cursorEl);
  }

  /** Hot-swap the theme. Forces a full re-render on next tick. */
  setTheme(theme) {
    this.theme = theme || null;
    // Invalidate the row-diff cache so the next render() repaints every row
    // with the new palette.
    for (let i = 0; i < this.rowHTML.length; i++) this.rowHTML[i] = '';
    this.term.dirty = true;
  }

  _buildRows() {
    const frag = document.createDocumentFragment();
    for (let y = 0; y < this.term.rows; y++) {
      const row = document.createElement('div');
      row.className = 'row';
      this.rows.push(row);
      this.rowHTML.push('');
      frag.appendChild(row);
    }
    this.container.appendChild(frag);
  }

  _measure() {
    // Build a sample row + char in the container so font + line-height match
    const probe = document.createElement('span');
    probe.textContent = 'M';
    probe.style.cssText = 'visibility:hidden;position:absolute';
    this.rows[0].appendChild(probe);
    const r = probe.getBoundingClientRect();
    this.cellW = r.width;
    this.cellH = this.rows[0].getBoundingClientRect().height;
    probe.remove();
    // Lock screen width so wrapping never reflows our grid. Hosts that load
    // web fonts after construction should `await document.fonts.ready`
    // before instantiating — otherwise these measurements will be stale by
    // the time the font swaps and cursor / mouse hit-testing will be off
    // by several pixels across the screen until the next reload.
    this.container.style.width = (this.cellW * this.term.cols) + 'px';
    this.container.style.height = (this.cellH * this.term.rows) + 'px';
  }

  render() {
    const t = this.term;
    const buf = t._curBuf();
    for (let y = 0; y < t.rows; y++) {
      const html = this._renderRow(buf[y]);
      if (this.rowHTML[y] !== html) {
        this.rows[y].innerHTML = html;
        this.rowHTML[y] = html;
      }
    }
    this._updateCursor();
    // Sync app-mouse class so CSS can suppress selection visuals
    const appMouse = !!t.modes.mouseProto;
    this.container.classList.toggle('app-mouse', appMouse);
  }

  _renderRow(row) {
    let html = '';
    let runStyle = null;
    let runText = '';
    const flush = () => {
      if (runText.length === 0) return;
      const txt = escapeHtml(runText);
      html += runStyle
        ? `<span style="${runStyle}">${txt}</span>`
        : `<span>${txt}</span>`;
      runText = '';
    };
    for (let x = 0; x < row.length; x++) {
      const cell = row[x];
      const style = this._cellStyle(cell);
      const ch = String.fromCodePoint(cell.ch);
      if (style === runStyle) {
        runText += ch;
      } else {
        flush();
        runStyle = style;
        runText = ch;
      }
    }
    flush();
    return html;
  }

  _cellStyle(cell) {
    const parts = [];
    let fg = this._color(cell.fg, 'fg');
    let bg = this._color(cell.bg, 'bg');
    const reverse = (cell.flags & FLAG_REVERSE) || this.term.modes.reverseVideo;
    if (reverse) {
      const f = fg || this._defaultColor('fg') || '#c8cdd4';
      const b = bg || this._defaultColor('bg') || '#0a0c10';
      fg = b; bg = f;
    }
    if (fg) parts.push(`color:${fg}`);
    if (bg) parts.push(`background:${bg}`);
    if (cell.flags & FLAG_BOLD)   parts.push('font-weight:bold');
    if (cell.flags & FLAG_DIM)    parts.push('opacity:.6');
    if (cell.flags & FLAG_ITALIC) parts.push('font-style:italic');
    const u = cell.flags & FLAG_UNDER;
    const s = cell.flags & FLAG_STRIKE;
    if (u && s) parts.push('text-decoration:underline line-through');
    else if (u) parts.push('text-decoration:underline');
    else if (s) parts.push('text-decoration:line-through');
    if (cell.flags & FLAG_INVIS)  parts.push('visibility:hidden');
    return parts.join(';');
  }

  _color(c, layer) {
    if (!c || c.t === 'd') return this._defaultColor(layer);
    if (c.t === 'r') return `rgb(${c.r},${c.g},${c.b})`;
    if (c.t === 'p') {
      const theme = this.theme;
      if (theme) {
        if (typeof theme.palette === 'function') {
          return theme.palette(c.i, layer) ?? PAL256[c.i];
        }
        if (Array.isArray(theme.palette) && c.i < theme.palette.length) {
          return theme.palette[c.i];
        }
      }
      return PAL256[c.i];
    }
    return null;
  }

  _defaultColor(layer) {
    const theme = this.theme;
    if (!theme) return null;
    return (layer === 'fg' ? theme.defaultFg : theme.defaultBg) ?? null;
  }

  _updateCursor() {
    const t = this.term;
    if (!t.modes.cursorVisible || !this.cursorOn) {
      this.cursorEl.style.display = 'none';
      return;
    }
    this.cursorEl.style.display = '';
    this.cursorEl.style.left   = (t.cursor.x * this.cellW) + 'px';
    this.cursorEl.style.top    = (t.cursor.y * this.cellH) + 'px';
    this.cursorEl.style.width  = this.cellW + 'px';
    this.cursorEl.style.height = this.cellH + 'px';
  }

  /**
   * Remove every DOM node this renderer created (rows + cursor overlay)
   * and drop the references. Idempotent. Hosts call this when the host
   * element is being torn down so the renderer's row arrays can be
   * collected. Use alongside Input.dispose() and Terminal.dispose().
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const row of this.rows) row.remove();
    if (this.cursorEl) this.cursorEl.remove();
    this.rows = [];
    this.rowHTML = [];
    this.cursorEl = null;
  }
}

/* ============================================================
 * 4.  INPUT (keyboard via hidden textarea, mouse on screen)
 *     With DOM rendering the browser gives us native selection
 *     and clipboard for free.  The textarea remains the
 *     keyboard / paste / IME target.
 * ============================================================ */

export class Input {
  constructor(term, screen, hidden, renderer) {
    this.term = term;
    this.screen = screen;
    this.hidden = hidden;
    this.renderer = renderer;
    this.composing = false;
    this.isMac = (typeof navigator !== 'undefined') &&
                 /Mac|iPod|iPhone|iPad/.test(navigator.platform);
    this._disposed = false;

    // Bind handlers once so dispose() can detach them via the same refs.
    this._onKey         = this._onKey.bind(this);
    this._onPaste       = this._onPaste.bind(this);
    this._onCompStart   = () => { this.composing = true; };
    this._onCompEnd     = (e) => {
      this.composing = false;
      if (e.data) this.term._send(e.data);
      this.hidden.value = '';
    };
    this._onHiddenInput = () => { if (!this.composing) this.hidden.value = ''; };
    this._onMouseDown   = this._onMouseDown.bind(this);
    this._onMouseMove   = this._onMouseMove.bind(this);
    this._onMouseUp     = this._onMouseUp.bind(this);
    this._onWheel       = this._onWheel.bind(this);
    this._onContext     = (e) => e.preventDefault();

    hidden.addEventListener('keydown', this._onKey);
    hidden.addEventListener('paste',   this._onPaste);
    hidden.addEventListener('compositionstart', this._onCompStart);
    hidden.addEventListener('compositionend',   this._onCompEnd);
    hidden.addEventListener('input',  this._onHiddenInput);

    screen.addEventListener('mousedown', this._onMouseDown);
    screen.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mouseup',   this._onMouseUp);
    screen.addEventListener('wheel',     this._onWheel, { passive: false });
    screen.addEventListener('contextmenu', this._onContext);

    hidden.focus();
  }

  /**
   * Detach every event listener installed by the constructor — including
   * the global window mouseup. Call this when the host element is removed
   * (cell re-run, tab close) so the Input instance can be garbage-collected
   * and stale terminals stop receiving global mouseup events.
   *
   * Idempotent. After dispose() the instance is inert; further calls are
   * no-ops.
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    const { hidden, screen } = this;
    hidden.removeEventListener('keydown', this._onKey);
    hidden.removeEventListener('paste',   this._onPaste);
    hidden.removeEventListener('compositionstart', this._onCompStart);
    hidden.removeEventListener('compositionend',   this._onCompEnd);
    hidden.removeEventListener('input',  this._onHiddenInput);
    screen.removeEventListener('mousedown', this._onMouseDown);
    screen.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mouseup',   this._onMouseUp);
    screen.removeEventListener('wheel',     this._onWheel);
    screen.removeEventListener('contextmenu', this._onContext);
    this._selecting = false;
    this._selAnchor = null;
  }

  _cellFromEvent(e) {
    const rect = this.screen.getBoundingClientRect();
    const col = Math.max(0, Math.min(this.term.cols - 1,
      Math.floor((e.clientX - rect.left) / this.renderer.cellW)));
    const row = Math.max(0, Math.min(this.term.rows - 1,
      Math.floor((e.clientY - rect.top)  / this.renderer.cellH)));
    return { col, row };
  }

  /* ---------- keyboard ---------- */
  _onKey(e) {
    const t = this.term;
    const ctrl = e.ctrlKey, alt = e.altKey, shift = e.shiftKey, meta = e.metaKey;
    const send = s => { t._send(s); e.preventDefault(); };

    // Copy: if there's a non-empty document selection, let the browser handle it.
    // Otherwise fall through (Ctrl+C will send ETX).
    const copyCombo = (this.isMac && meta && !ctrl && !alt && e.key.toLowerCase() === 'c')
                   || (!this.isMac && ctrl && shift && e.key.toLowerCase() === 'c');
    if (copyCombo) {
      const sel = document.getSelection?.();
      if (sel && sel.toString().length > 0) return;  // browser copies natively
    }
    // Paste: let the browser fire 'paste' on the textarea
    const pasteCombo = (this.isMac && meta && !ctrl && !alt && e.key.toLowerCase() === 'v')
                    || (!this.isMac && ctrl && shift && e.key.toLowerCase() === 'v')
                    || (!this.isMac && ctrl && !shift && !alt && e.key.toLowerCase() === 'v');
    if (pasteCombo) return;

    const arrow = (letter) => (t.modes.appCursor ? "\x1bO" : "\x1b[") + letter;
    switch (e.key) {
    case "Enter":     return send("\r");
    case "Backspace": return send(ctrl ? "\x08" : "\x7f");
    case "Tab":       return send(shift ? "\x1b[Z" : "\t");
    case "Escape":    return send("\x1b");
    case "ArrowUp":    return send(arrow("A"));
    case "ArrowDown":  return send(arrow("B"));
    case "ArrowRight": return send(arrow("C"));
    case "ArrowLeft":  return send(arrow("D"));
    case "Home":     return send("\x1b[H");
    case "End":      return send("\x1b[F");
    case "PageUp":   return send("\x1b[5~");
    case "PageDown": return send("\x1b[6~");
    case "Delete":   return send("\x1b[3~");
    case "Insert":   return send("\x1b[2~");
    case "F1": return send("\x1bOP");
    case "F2": return send("\x1bOQ");
    case "F3": return send("\x1bOR");
    case "F4": return send("\x1bOS");
    case "F5": return send("\x1b[15~");
    case "F6": return send("\x1b[17~");
    case "F7": return send("\x1b[18~");
    case "F8": return send("\x1b[19~");
    case "F9": return send("\x1b[20~");
    case "F10": return send("\x1b[21~");
    case "F11": return send("\x1b[23~");
    case "F12": return send("\x1b[24~");
    }

    if (ctrl && !alt && !meta && e.key.length === 1) {
      const c = e.key.toUpperCase().charCodeAt(0);
      if (c >= 0x40 && c <= 0x5F) return send(String.fromCharCode(c - 0x40));
      if (c >= 0x61 && c <= 0x7A) return send(String.fromCharCode(c - 0x60));
    }

    if (this.composing) return;

    if (e.key.length === 1 && !meta) {
      const out = alt ? "\x1b" + e.key : e.key;
      return send(out);
    }
  }

  _onPaste(e) {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData)?.getData('text');
    if (!text) return;
    if (this.term.modes.bracketedPaste) {
      this.term._send(`\x1b[200~${text}\x1b[201~`);
    } else {
      this.term._send(text);
    }
    this.hidden.value = '';
  }

  /* ---------- mouse ---------- */
  _caretAt(x, y) {
    // Resolve a viewport point to a (textNode, offset) pair.
    // caretRangeFromPoint is Chromium/Safari; caretPositionFromPoint is Firefox.
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      return r ? { node: r.startContainer, offset: r.startOffset } : null;
    }
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      return p ? { node: p.offsetNode, offset: p.offset } : null;
    }
    return null;
  }

  _onMouseDown(e) {
    const t = this.term;
    // preventDefault on mousedown is required to keep keyboard focus on the
    // hidden textarea (otherwise the browser steals it back to body after the
    // handler runs).  But preventDefault also kills native selection — so we
    // drive selection manually via caretRangeFromPoint.
    e.preventDefault();
    this.hidden.focus({ preventScroll: true });

    // App mouse tracking: shift bypasses (xterm convention) so the user can
    // always escape into native text selection by holding shift while
    // dragging, even when the program enabled mouse tracking.
    if (t.modes.mouseProto && !e.shiftKey) {
      const { col, row } = this._cellFromEvent(e);
      return this._sendMouse(e, 'down', col + 1, row + 1);
    }

    if (e.button !== 0) return;

    // Begin a manual selection at the click point.
    this._selecting = true;
    this._selAnchor = this._caretAt(e.clientX, e.clientY);
    if (!this._selAnchor) return;
    const sel = window.getSelection();
    sel.removeAllRanges();
    const r = document.createRange();
    r.setStart(this._selAnchor.node, this._selAnchor.offset);
    r.setEnd(this._selAnchor.node, this._selAnchor.offset);
    sel.addRange(r);

    // Multi-click: double = word, triple = line — extend selection by
    // word/line granularity using selection.modify where available.
    if (e.detail === 2 && sel.modify) {
      sel.modify('move',   'backward', 'word');
      sel.modify('extend', 'forward',  'word');
      this._selecting = false;     // already complete; no drag needed
    } else if (e.detail >= 3 && sel.modify) {
      sel.modify('move',   'backward', 'lineboundary');
      sel.modify('extend', 'forward',  'lineboundary');
      this._selecting = false;
    }
  }

  _onMouseMove(e) {
    const t = this.term;
    if (this._selecting && this._selAnchor) {
      const focus = this._caretAt(e.clientX, e.clientY);
      if (focus) {
        window.getSelection().setBaseAndExtent(
          this._selAnchor.node, this._selAnchor.offset,
          focus.node, focus.offset);
      }
      return;
    }
    if (!t.modes.mouseProto) return;
    const tracking = t.modes.mouseProto;
    const hasBtn = e.buttons !== 0;
    if (tracking === 1003 || (tracking === 1002 && hasBtn)) {
      const { col, row } = this._cellFromEvent(e);
      this._sendMouse(e, 'move', col + 1, row + 1);
    }
  }

  _onMouseUp(e) {
    if (this._selecting) {
      this._selecting = false;
      return;
    }
    const t = this.term;
    if (t.modes.mouseProto && !e.shiftKey) {
      const { col, row } = this._cellFromEvent(e);
      this._sendMouse(e, 'up', col + 1, row + 1);
    }
  }

  _sendMouse(e, kind, col, row) {
    const t = this.term;
    let btn = 0;
    if (kind === 'down' || kind === 'up') {
      btn = e.button === 0 ? 0 : e.button === 1 ? 1 : e.button === 2 ? 2 : 0;
    } else {
      btn = e.buttons & 1 ? 0 : e.buttons & 4 ? 1 : e.buttons & 2 ? 2 : 3;
      btn += 32;
    }
    if (e.shiftKey) btn += 4;
    if (e.altKey)   btn += 8;
    if (e.ctrlKey)  btn += 16;

    if (t.modes.mouseEncoding === 1006) {
      const final = (kind === 'up') ? 'm' : 'M';
      t._send(`\x1b[<${btn};${col};${row}${final}`);
    } else {
      const code = (kind === 'up') ? 3 : btn;
      t._send(`\x1b[M${String.fromCharCode(32 + code)}${String.fromCharCode(32 + col)}${String.fromCharCode(32 + row)}`);
    }
  }

  _onWheel(e) {
    const t = this.term;
    if (!t.modes.mouseProto) return;
    e.preventDefault();
    const { col, row } = this._cellFromEvent(e);
    const btn = e.deltaY < 0 ? 64 : 65;
    if (t.modes.mouseEncoding === 1006) {
      t._send(`\x1b[<${btn};${col + 1};${row + 1}M`);
    }
  }
}
