// @gcu/capsule — fragment-based content addressing (share-by-URL / QR), the
// GCU capsule transport. Vendored into auditable from the reference
// implementation in ep (`../ep/src/js/capsule.js`); the normative contract is
// the cradle repo (`../cradle/SPEC-capsule.md`, `CAPSULES.md`). Keep this in
// sync with ep — it's the same module, extracted for shared use.
//
// Phase 1 — inline schemes only (inline / i / q). Reference schemes
// (gh / gist / rentry / url / doi / zenodo) resolve to EUNKNOWN, the conforming
// graceful-degradation path (§17); they get a fetch each when a consumer (the
// content registry) needs them. Zero dependencies, browser-native APIs only
// (CompressionStream, atob/btoa, TextEncoder).
//
// Encodes:
//   text → UTF-8 → deflate-raw → base64url → `i:d<payload>`        (share link)
//   text → UTF-8 → deflate-raw → base45    → `q:d<payload>`        (QR / NFC)
// Both round-trip; the same bytes can be expressed in either form (or the long
// `inline:deflate:<base64url>` form), per §17.

// ── base64url (small, sync) ────────────────────────────────────────

function bytesToB64Url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64UrlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── base45 (RFC 9285) ─────────────────────────────────────────────
// 45-char alphabet, 11 bits per encoded character pair. 2 source bytes
// → 3 encoded chars; trailing single byte → 2 encoded chars.

const BASE45_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const BASE45_LOOKUP = (() => {
  const map = new Map();
  for (let i = 0; i < BASE45_ALPHABET.length; i++) map.set(BASE45_ALPHABET[i], i);
  return map;
})();

function bytesToBase45(bytes) {
  let out = '';
  let i = 0;
  for (; i + 1 < bytes.length; i += 2) {
    let v = (bytes[i] << 8) | bytes[i + 1];   // 0..65535
    const c = v % 45; v = (v - c) / 45;
    const d = v % 45; v = (v - d) / 45;
    const e = v;                              // 0..32
    out += BASE45_ALPHABET[c] + BASE45_ALPHABET[d] + BASE45_ALPHABET[e];
  }
  if (i < bytes.length) {
    // trailing single byte → 2 chars
    let v = bytes[i];
    const c = v % 45; v = (v - c) / 45;
    out += BASE45_ALPHABET[c] + BASE45_ALPHABET[v];
  }
  return out;
}

function base45ToBytes(text) {
  const out = [];
  let i = 0;
  for (; i + 2 < text.length; i += 3) {
    const a = BASE45_LOOKUP.get(text[i]);
    const b = BASE45_LOOKUP.get(text[i + 1]);
    const c = BASE45_LOOKUP.get(text[i + 2]);
    if (a === undefined || b === undefined || c === undefined) throw new Error('EDECODE');
    const v = a + b * 45 + c * 45 * 45;
    if (v > 0xFFFF) throw new Error('EDECODE');
    out.push((v >> 8) & 0xFF, v & 0xFF);
  }
  if (i < text.length) {
    if (text.length - i !== 2) throw new Error('EDECODE');
    const a = BASE45_LOOKUP.get(text[i]);
    const b = BASE45_LOOKUP.get(text[i + 1]);
    if (a === undefined || b === undefined) throw new Error('EDECODE');
    const v = a + b * 45;
    if (v > 0xFF) throw new Error('EDECODE');
    out.push(v);
  }
  return new Uint8Array(out);
}

// ── deflate-raw via CompressionStream ─────────────────────────────

async function deflateRaw(bytes) {
  if (typeof CompressionStream === 'undefined') return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ── URL-fragment safety for base45 (`q:`) payloads ─────────────────
// The base45 alphabet (RFC 9285) contains two characters that a URL
// fragment cannot carry literally: space and `%`. Every other base45
// char ($ * + - . / : and alnum) is fragment-legal. base64url payloads
// (`i:` / `inline:`) contain neither, so these helpers are a no-op for
// them — safe to apply uniformly to any capsule.
//
// We escape exactly {`%`→`%25`, space→`%20`} — `%` FIRST so the `%` we
// introduce for the space isn't re-escaped — and reverse with a single
// left-to-right pass (NOT sequential global replaces) so a literal `%20`
// in the raw payload, which encodes to `%2520`, round-trips back to `%20`
// rather than collapsing to a space.
export function fragmentEncode(capsule) {
  return capsule.replace(/%/g, '%25').replace(/ /g, '%20');
}

export function fragmentDecode(s) {
  let out = '';
  for (let i = 0; i < s.length; ) {
    if (s[i] === '%' && s[i + 1] === '2' && s[i + 2] === '5') { out += '%'; i += 3; }
    else if (s[i] === '%' && s[i + 1] === '2' && s[i + 2] === '0') { out += ' '; i += 3; }
    else { out += s[i]; i++; }
  }
  return out;
}

// ── Public API ────────────────────────────────────────────────────

// Encode UTF-8 text as a compact-form inline capsule: `i:d<base64url>`.
export async function encodeInlineI(text) {
  const bytes = new TextEncoder().encode(text);
  const compressed = await deflateRaw(bytes);
  return 'i:d' + bytesToB64Url(compressed);
}

// Encode UTF-8 text as a QR-optimized inline capsule: `q:d<base45>`.
export async function encodeInlineQ(text) {
  const bytes = new TextEncoder().encode(text);
  const compressed = await deflateRaw(bytes);
  return 'q:d' + bytesToBase45(compressed);
}

// Resolve any inline-scheme capsule (long form `inline:...`, compact `i:...`,
// QR form `q:...`) back to its original text. Reference schemes fall through to
// EUNKNOWN (conforming graceful-degradation, §17).
export async function resolveCapsule(capsule) {
  if (!capsule) throw new Error('ENOSCHEME');
  let p = capsule.startsWith('#') ? capsule.slice(1) : capsule;
  const colon = p.indexOf(':');
  if (colon < 0) throw new Error('ENOSCHEME');
  const scheme = p.slice(0, colon);
  const body = p.slice(colon + 1);

  if (scheme === 'inline') {
    const colon2 = body.indexOf(':');
    if (colon2 < 0) throw new Error('EDECODE');
    const codec = body.slice(0, colon2);
    const payload = body.slice(colon2 + 1);
    const bytes = await decodePayload(codec, payload, 'b64');
    return new TextDecoder().decode(bytes);
  }
  if (scheme === 'i') {
    const codecChar = body[0];
    const payload = body.slice(1);
    const codec = compactCodec(codecChar);
    const bytes = await decodePayload(codec, payload, 'b64');
    return new TextDecoder().decode(bytes);
  }
  if (scheme === 'q') {
    const codecChar = body[0];
    if (body[1] === '.') throw new Error('EUNSUPPORTEDCODEC');   // dictionary deflate: not yet
    const codec = compactCodec(codecChar);
    const payload = body.slice(1);
    const bytes = await decodePayload(codec, payload, 'b45');
    return new TextDecoder().decode(bytes);
  }
  throw new Error('EUNKNOWN');
}

function compactCodec(ch) {
  if (ch === 'r') return 'raw';
  if (ch === 'd') return 'deflate';
  if (ch === 'b') throw new Error('EUNSUPPORTEDCODEC');  // brotli optional, not implemented
  throw new Error('EUNSUPPORTEDCODEC');
}

async function decodePayload(codec, payload, baseKind) {
  let bytes;
  try {
    bytes = baseKind === 'b45' ? base45ToBytes(payload) : b64UrlToBytes(payload);
  } catch { throw new Error('EDECODE'); }
  if (codec === 'raw') return bytes;
  if (codec === 'deflate') {
    try { return await inflateRaw(bytes); }
    catch { throw new Error('EDECODE'); }
  }
  throw new Error('EUNSUPPORTEDCODEC');
}

// Did the user arrive via a share capsule? (sync, for boot branching)
export function hasCapsuleFragment(loc = location) {
  if (loc.hash && loc.hash.length > 1) return true;
  if (loc.search && new URLSearchParams(loc.search).has('p')) return true;
  return false;
}

// Read the share-capsule from the URL, return its decoded text, and clear the
// URL so a reload doesn't re-trigger. Returns null if absent / undecodable.
export async function consumeCapsule() {
  let capsule = null;
  if (location.hash && location.hash.length > 1) {
    capsule = fragmentDecode(location.hash.slice(1));
  } else if (location.search) {
    const enc = new URLSearchParams(location.search).get('p');
    if (enc) capsule = 'i:d' + enc;   // legacy ?p= shim
  }
  if (!capsule) return null;
  let text = null;
  try { text = await resolveCapsule(capsule); }
  catch (e) { console.warn('capsule resolve failed:', e.message); }
  history.replaceState(null, '', location.pathname);
  return text;
}
