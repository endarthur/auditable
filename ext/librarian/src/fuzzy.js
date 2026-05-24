// Damerau-Levenshtein edit distance, bounded for efficiency: aborts when
// distance exceeds `max`. Used both for the fuzzy-match step at query
// time and for "did you mean?" suggestions when an exact term hits zero
// results.

export function editDistance(a, b, max) {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  if (la === 0) return lb;
  if (lb === 0) return la;

  // Two-row dynamic programming with the Damerau transposition extension.
  // We track three rows for transpositions.
  const prev2 = new Array(lb + 1);
  const prev1 = new Array(lb + 1);
  const curr  = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev1[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let v = Math.min(
        curr[j - 1] + 1,      // insertion
        prev1[j] + 1,         // deletion
        prev1[j - 1] + cost,  // substitution
      );
      // Transposition (Damerau).
      if (i > 1 && j > 1
          && a.charCodeAt(i - 1) === b.charCodeAt(j - 2)
          && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) {
        v = Math.min(v, prev2[j - 2] + cost);
      }
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    // Prune: if the best score in this row already exceeds max, no
    // continuation can recover.
    if (rowMin > max) return max + 1;
    // Slide the rolling window.
    for (let j = 0; j <= lb; j++) { prev2[j] = prev1[j]; prev1[j] = curr[j]; }
  }
  return prev1[lb];
}

// Find every term in `dictionary` within `max` edits of `target`.
// Returns sorted ascending by distance.
export function nearTerms(target, dictionary, max) {
  const hits = [];
  for (const term of dictionary) {
    const d = editDistance(target, term, max);
    if (d <= max) hits.push({ term, distance: d });
  }
  hits.sort((a, b) => a.distance - b.distance);
  return hits;
}
