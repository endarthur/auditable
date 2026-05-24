// keys.js — parse a stream of input bytes into key events.
//
// The line editor sees one stream: chunks of UTF-8 text from the
// adapter's onInput callback. We split that into key events the
// dispatcher knows about:
//
//   { name: 'Left' | 'Right' | 'Up' | 'Down' | 'Home' | 'End' |
//           'Delete' | 'Backspace' | 'Enter' | 'Tab' | 'Esc' |
//           'PasteStart' | 'PasteEnd' }
//   { name: 'Ctrl-A' .. 'Ctrl-Z', 'Ctrl-?' (Backspace), etc. }
//   { name: 'Alt-<base>' }   — Alt-modified keys: Alt-B, Alt-F, Alt-R,
//                              Alt-Backspace (\x1b\x7f), Alt-Left, ...
//   { ch: '<char>' }         — printable insert
//   { paste: '<text>' }      — bracketed-paste payload, single event
//                              regardless of length
//
// Bracketed paste mode: the terminal wraps pasted text in
//   ESC[200~ ... ESC[201~
// so a multi-line paste lands as one `paste` event the editor can
// insert atomically (no completion/history triggers fire mid-paste).
//
// CSI sequences with `;modifier` suffix (e.g. ESC[1;5D for Ctrl-Left)
// are recognised: 2=Shift, 3=Alt, 5=Ctrl, 6=Ctrl+Shift, etc.

const CSI_FINAL_RE = /[A-Za-z~]/;

// CSI base codes (no modifier) → name
const CSI_BASE = {
  A: 'Up', B: 'Down', C: 'Right', D: 'Left',
  H: 'Home', F: 'End',
  Z: 'Shift-Tab',
};

// CSI 1;<mod> <final> sequences — modifier-encoded cursor keys.
// Modifier byte: 2=Shift, 3=Alt, 4=Shift+Alt, 5=Ctrl, 6=Shift+Ctrl,
// 7=Alt+Ctrl, 8=Shift+Alt+Ctrl. We care about Ctrl + Alt only.
const MOD_PREFIX = {
  3: 'Alt-', 5: 'Ctrl-', 7: 'Ctrl-Alt-',
};

// CSI <num> ~ keys — Delete, PageUp/Down, etc.
const CSI_TILDE = {
  3: 'Delete', 5: 'PageUp', 6: 'PageDown',
  // 200 / 201 → bracketed paste, handled specially in the parser.
};

/**
 * Parse `chunk` into key events. Returns { events, leftover } where
 * `leftover` is a partial sequence that didn't terminate in this chunk
 * (caller prepends it to the next chunk).
 *
 * `state` is { pasting: bool, pasteBuf: string } persisted across calls
 * so a bracketed-paste split across two onInput callbacks survives.
 */
export function parseKeys(chunk, state) {
  const events = [];
  const s = state || (state = { pasting: false, pasteBuf: '' });
  let i = 0;

  while (i < chunk.length) {
    // Mid-paste: accumulate until the end sentinel.
    if (s.pasting) {
      // Look for ESC[201~ in the stream.
      const endIdx = chunk.indexOf('\x1b[201~', i);
      if (endIdx === -1) {
        s.pasteBuf += chunk.slice(i);
        return { events, leftover: '' };
      }
      s.pasteBuf += chunk.slice(i, endIdx);
      events.push({ paste: s.pasteBuf });
      s.pasting = false;
      s.pasteBuf = '';
      i = endIdx + '\x1b[201~'.length;
      continue;
    }

    const ch = chunk[i];

    // ESC starts an escape sequence (CSI or Alt-key).
    if (ch === '\x1b') {
      // Pure ESC at end of chunk — defer to next chunk in case more
      // bytes are coming.
      if (i + 1 >= chunk.length) {
        return { events, leftover: chunk.slice(i) };
      }
      const next = chunk[i + 1];

      // ESC [ ...  — CSI sequence.
      if (next === '[') {
        // Find the final byte (letter or ~). If missing in this chunk,
        // defer.
        let j = i + 2;
        while (j < chunk.length && !CSI_FINAL_RE.test(chunk[j])) j++;
        if (j >= chunk.length) {
          return { events, leftover: chunk.slice(i) };
        }
        const params = chunk.slice(i + 2, j);
        const final = chunk[j];
        i = j + 1;

        // Bracketed-paste start?
        if (final === '~' && params === '200') {
          s.pasting = true;
          s.pasteBuf = '';
          continue;
        }
        if (final === '~' && params === '201') {
          // Stray end marker (we weren't pasting). Drop silently.
          continue;
        }

        // Modifier-encoded cursor key: ESC [ 1 ; <mod> <final>
        if (final !== '~' && params.startsWith('1;')) {
          const mod = parseInt(params.slice(2), 10);
          const base = CSI_BASE[final];
          if (base && MOD_PREFIX[mod]) {
            events.push({ name: MOD_PREFIX[mod] + base });
            continue;
          }
          // Unknown modifier — drop the base unmodified rather than
          // silently swallowing the user's intent.
          if (base) events.push({ name: base });
          continue;
        }

        // Plain cursor / Home / End / etc.
        if (final !== '~' && CSI_BASE[final]) {
          events.push({ name: CSI_BASE[final] });
          continue;
        }

        // ESC [ <num> ~
        if (final === '~') {
          const code = parseInt(params, 10);
          if (CSI_TILDE[code]) {
            events.push({ name: CSI_TILDE[code] });
            continue;
          }
        }

        // Unknown CSI — drop silently. Keeps stray sequences from
        // landing in the buffer as literal text.
        continue;
      }

      // ESC <single char> — Alt-<char> (xterm convention).
      // Special case: ESC followed by DEL (0x7f) is Alt-Backspace.
      if (next === '\x7f') {
        events.push({ name: 'Alt-Backspace' });
        i += 2;
        continue;
      }
      // ESC ESC = lone Escape twice → treat the first as Escape, defer
      // the second (it might still be the start of CSI in the next chunk).
      if (next === '\x1b') {
        events.push({ name: 'Esc' });
        i += 1;
        continue;
      }
      // Printable after ESC — Alt-<char>. Lowercase for normalisation.
      events.push({ name: 'Alt-' + next.toLowerCase() });
      i += 2;
      continue;
    }

    // Control characters (0x00 - 0x1f, plus 0x7f).
    const code = ch.charCodeAt(0);
    if (code === 0x7f || code === 0x08) {
      events.push({ name: 'Backspace' });
      i++;
      continue;
    }
    if (code === 0x0d || code === 0x0a) {
      events.push({ name: 'Enter' });
      i++;
      continue;
    }
    if (code === 0x09) {
      events.push({ name: 'Tab' });
      i++;
      continue;
    }
    if (code < 0x20) {
      // Ctrl-A = 0x01, Ctrl-Z = 0x1a. Ctrl-@ = 0x00. Map to 'Ctrl-<letter>'.
      const letter = code === 0 ? '@' : String.fromCharCode(0x60 + code);
      events.push({ name: 'Ctrl-' + letter });
      i++;
      continue;
    }

    // Printable. Group consecutive printables into one ch-string for
    // efficiency on fast typing (Chrome dispatches IME chunks as runs).
    let j = i;
    while (j < chunk.length) {
      const cc = chunk.charCodeAt(j);
      if (cc < 0x20 || cc === 0x7f || cc === 0x1b) break;
      j++;
    }
    if (j > i) {
      events.push({ ch: chunk.slice(i, j) });
      i = j;
    } else {
      i++;
    }
  }

  return { events, leftover: '' };
}
