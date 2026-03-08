// Simple English hyphenation
// Finds possible break points in words using vowel/consonant patterns,
// common prefixes/suffixes, and double consonant rules.
// Not as good as Liang's TeX patterns but dramatically improves KP output.

const VOWELS = 'aeiouy';
const isVowel = ch => VOWELS.includes(ch);
const isCons = ch => /[a-z]/.test(ch) && !isVowel(ch);

const PREFIXES = ['over', 'under', 'counter', 'super', 'anti', 'auto', 'inter', 'intro',
  'extra', 'infra', 'ultra', 'semi', 'trans', 'cross', 'multi', 'fore',
  'dis', 'mis', 'pre', 'pro', 'non', 'out', 'sub', 'un', 're'];

const SUFFIXES = ['tion', 'sion', 'ment', 'ness', 'able', 'ible', 'less', 'ence', 'ance',
  'ling', 'ful', 'ous', 'ive', 'ing', 'ist', 'ism', 'ize', 'ise',
  'ity', 'ery', 'ary', 'ory', 'ate', 'ent', 'ant', 'dom'];

// Consonant clusters that should not be broken
const CLUSTERS = new Set(['ch', 'sh', 'th', 'ph', 'wh', 'ck', 'gh', 'gn', 'kn', 'wr',
  'bl', 'br', 'cl', 'cr', 'dr', 'fl', 'fr', 'gl', 'gr', 'pl', 'pr',
  'sc', 'sk', 'sl', 'sm', 'sn', 'sp', 'st', 'sw', 'tr', 'tw',
  'scr', 'spl', 'spr', 'str', 'squ']);

function findHyphenPoints(word) {
  const min = 5; // don't hyphenate short words
  if (word.length < min) return [];
  const lw = word.toLowerCase();
  if (!/^[a-z]+$/.test(lw)) return []; // only pure alphabetic

  const points = new Set();
  const minBefore = 2; // at least 2 chars before hyphen
  const minAfter = 3;  // at least 3 chars after hyphen

  // 1. Prefix breaks
  for (const pfx of PREFIXES) {
    if (lw.startsWith(pfx) && lw.length - pfx.length >= minAfter) {
      // Only if remainder starts with consonant (avoid "re-elect" style but allow "re-mark")
      const after = lw[pfx.length];
      if (isCons(after) || pfx.length >= 3) {
        points.add(pfx.length);
      }
    }
  }

  // 2. Suffix breaks
  for (const sfx of SUFFIXES) {
    const pos = lw.length - sfx.length;
    if (pos >= minBefore && lw.endsWith(sfx)) {
      points.add(pos);
    }
  }

  // 3. Double consonant break (let-ter, run-ning)
  for (let i = minBefore; i < lw.length - minAfter; i++) {
    if (isCons(lw[i]) && lw[i] === lw[i + 1]) {
      points.add(i + 1);
    }
  }

  // 4. V-CV pattern: break before single consonant between vowels
  for (let i = minBefore; i < lw.length - minAfter; i++) {
    if (isVowel(lw[i - 1]) && isCons(lw[i]) && isVowel(lw[i + 1])) {
      // Check it's not part of a cluster
      const pair = lw.slice(i, i + 2);
      if (!CLUSTERS.has(pair)) {
        points.add(i);
      }
    }
  }

  // 5. VC-CV pattern: between two consonants surrounded by vowels
  for (let i = minBefore; i < lw.length - minAfter; i++) {
    if (i >= 2 && isVowel(lw[i - 2]) && isCons(lw[i - 1]) && isCons(lw[i]) && isVowel(lw[i + 1])) {
      const pair = lw.slice(i - 1, i + 1);
      // Don't break consonant clusters
      if (!CLUSTERS.has(pair)) {
        points.add(i);
      }
    }
  }

  // Filter, sort, and enforce minimum 2-char gap between consecutive points
  const sorted = [...points]
    .filter(p => p >= minBefore && p <= lw.length - minAfter)
    .sort((a, b) => a - b);

  const result = [];
  for (const p of sorted) {
    if (result.length === 0 || p - result[result.length - 1] >= 2) {
      result.push(p);
    }
  }

  return result;
}

export { findHyphenPoints };
