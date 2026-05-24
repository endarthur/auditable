// Tokenizer. Lower-case ASCII split on non-alphanumeric boundaries,
// stopword filter, optional Unicode passthrough so CJK / accented
// terms aren't lost.
//
// Returns positions alongside tokens — `search()` uses them for phrase
// proximity scoring + snippet extraction.

const STOPWORDS = new Set([
  'a','an','and','are','as','at','be','but','by','for','from','has','have',
  'he','her','his','i','if','in','into','is','it','its','of','on','or','our',
  'she','so','than','that','the','their','them','then','there','these','they',
  'this','to','us','was','we','were','what','when','where','which','while',
  'who','will','with','you','your',
]);

// Match runs of ASCII alphanumerics + apostrophes (so "don't" stays one
// token) OR any non-ASCII letter range (covers CJK, accented Latin).
const TOKEN_RE = /[a-z0-9']+|[^\x00-\x7f]+/g;

export function tokenize(text, opts = {}) {
  const stop = opts.keepStopwords ? new Set() : STOPWORDS;
  const minLen = opts.minLen != null ? opts.minLen : 2;
  const lower = String(text || '').toLowerCase();
  const out = [];
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(lower)) != null) {
    let tok = m[0];
    // Strip leading/trailing apostrophes.
    tok = tok.replace(/^'+|'+$/g, '');
    if (!tok) continue;
    if (tok.length < minLen) continue;
    if (stop.has(tok)) continue;
    out.push({ token: tok, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

// Just the token strings, no positions — used when scoring queries.
export function tokenizeStrings(text) {
  return tokenize(text).map((t) => t.token);
}
