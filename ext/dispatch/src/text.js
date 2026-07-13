// @gcu/dispatch — text primitives: tokenizer, token shapes, gazetteer spans.
export const tokenize = (q) => (q.toLowerCase().match(/[a-z0-9][a-z0-9.\-]*|[^\sa-z0-9]/gi) || []).map((t) => t.replace(/[.,;!?]+$/, '') || t);

export const NUM_RE = /^[0-9]+(\.[0-9]+)?$/;
export const ID_RE = /^[a-z]+-?[0-9]+$/;
export const shape = (t) => (NUM_RE.test(t) ? (t.includes('.') ? 'dec' : 'int') : ID_RE.test(t) ? 'id' : /[0-9]/.test(t) ? 'alnum' : 'alpha');
export const num = (t) => (String(t).includes('.') ? +t : parseInt(t, 10));
export const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// build a phrase→value map (multiword synonyms as token-joined keys)
export function gazMap(entries) {
  const m = new Map();
  for (const [phrase, val] of entries) m.set(tokenize(phrase).join(' '), val);
  return m;
}
// longest-match spans of a gazetteer map over tokens → [{i, len, val}]
export function gazSpans(toks, map) {
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    for (let len = Math.min(4, toks.length - i); len >= 1; len--) {
      const key = toks.slice(i, i + len).join(' ');
      if (map.has(key)) { out.push({ i, len, val: map.get(key) }); i += len - 1; break; }
    }
  }
  return out;
}
// seeded rng (no Date.now/Math.random — everything reproducible)
export function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function shuffled(arr, seed) { const r = mulberry32(seed), out = [...arr]; for (let i = out.length - 1; i > 0; i--) { const j = (r() * (i + 1)) | 0; [out[i], out[j]] = [out[j], out[i]]; } return out; }
export const normText = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
