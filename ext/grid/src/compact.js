// @gcu/grid — compact variables: alignment, reduction, domain operations

// ── alignment ──

export function align(compactVars, opts) {
  const fill = opts?.fill ?? NaN;
  // merge all index sets into a sorted union
  const indices = unionIndices(...compactVars.map(v => v.indices));
  const n = indices.length;
  // build lookup: grid index → position in union
  const lookup = new Map();
  for (let i = 0; i < n; i++) lookup.set(indices[i], i);
  // align each variable
  const aligned = compactVars.map(cv => {
    const out = new Float64Array(n).fill(fill);
    for (let i = 0; i < cv.indices.length; i++) {
      const pos = lookup.get(cv.indices[i]);
      if (pos !== undefined) out[pos] = cv.values[i];
    }
    return out;
  });
  return { aligned, indices };
}

// ── reduction ──

export function reduce(compactVars, fn, opts) {
  const fill = opts?.fill ?? NaN;
  const { aligned, indices } = align(compactVars, { fill });
  const n = indices.length;
  const d = compactVars.length;
  const values = new Float64Array(n);
  const buf = new Array(d);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < d; j++) buf[j] = aligned[j][i];
    values[i] = fn(buf, indices[i]);
  }
  return { values, indices };
}

// ── named fast-path reductions ──

export function dilute(domains) {
  const allIndices = unionIndices(...domains.map(d => d.indices));
  const n = allIndices.length;
  const values = new Float64Array(n);
  // build per-domain lookups
  const lookups = domains.map(d => {
    const m = new Map();
    for (let i = 0; i < d.indices.length; i++) m.set(d.indices[i], i);
    return m;
  });
  for (let i = 0; i < n; i++) {
    const gIdx = allIndices[i];
    let sum = 0;
    for (let d = 0; d < domains.length; d++) {
      const pos = lookups[d].get(gIdx);
      if (pos !== undefined) sum += domains[d].values[pos] * domains[d].proportions[pos];
    }
    values[i] = sum;
  }
  return { values, indices: allIndices };
}

export function sum(compactVars, opts) {
  const fill = opts?.fill ?? 0;
  const { aligned, indices } = align(compactVars, { fill });
  const n = indices.length;
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let d = 0; d < aligned.length; d++) s += aligned[d][i];
    values[i] = s;
  }
  return { values, indices };
}

export function mean(compactVars, opts) {
  const skipNaN = opts?.skipNaN !== false;
  const { aligned, indices } = align(compactVars, { fill: NaN });
  const n = indices.length;
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let d = 0; d < aligned.length; d++) {
      const v = aligned[d][i];
      if (skipNaN && isNaN(v)) continue;
      s += v; c++;
    }
    values[i] = c > 0 ? s / c : NaN;
  }
  return { values, indices };
}

export function min(compactVars, opts) {
  const fill = opts?.fill ?? Infinity;
  const { aligned, indices } = align(compactVars, { fill });
  const n = indices.length;
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let m = Infinity;
    for (let d = 0; d < aligned.length; d++) {
      const v = aligned[d][i];
      if (v < m) m = v;
    }
    values[i] = m;
  }
  return { values, indices };
}

export function max(compactVars, opts) {
  const fill = opts?.fill ?? -Infinity;
  const { aligned, indices } = align(compactVars, { fill });
  const n = indices.length;
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let m = -Infinity;
    for (let d = 0; d < aligned.length; d++) {
      const v = aligned[d][i];
      if (v > m) m = v;
    }
    values[i] = m;
  }
  return { values, indices };
}

export function countPresent(compactVars) {
  const allIndices = unionIndices(...compactVars.map(v => v.indices));
  const n = allIndices.length;
  const values = new Int32Array(n);
  const sets = compactVars.map(v => new Set(Array.from(v.indices)));
  for (let i = 0; i < n; i++) {
    const gIdx = allIndices[i];
    let c = 0;
    for (const s of sets) if (s.has(gIdx)) c++;
    values[i] = c;
  }
  return { values, indices: allIndices };
}

// ── compact set operations ──

export function unionIndices(...indexArrays) {
  const s = new Set();
  for (const arr of indexArrays) for (let i = 0; i < arr.length; i++) s.add(arr[i]);
  const out = new Int32Array(s.size);
  let p = 0;
  for (const v of s) out[p++] = v;
  out.sort();
  return out;
}

export function intersectionIndices(...indexArrays) {
  if (indexArrays.length === 0) return new Int32Array(0);
  const sets = indexArrays.map(arr => new Set(Array.from(arr)));
  const base = sets[0];
  const result = [];
  for (const v of base) {
    if (sets.every(s => s.has(v))) result.push(v);
  }
  result.sort((a, b) => a - b);
  return new Int32Array(result);
}

export function differenceIndices(a, b) {
  const bSet = new Set(Array.from(b));
  const result = [];
  for (let i = 0; i < a.length; i++) if (!bSet.has(a[i])) result.push(a[i]);
  return new Int32Array(result);
}

export function restrict(compactVar, targetIndices) {
  const tSet = new Set(Array.from(targetIndices));
  const vals = [], idxs = [];
  for (let i = 0; i < compactVar.indices.length; i++) {
    if (tSet.has(compactVar.indices[i])) {
      vals.push(compactVar.values[i]);
      idxs.push(compactVar.indices[i]);
    }
  }
  return { values: new Float64Array(vals), indices: new Int32Array(idxs) };
}

// ── domain operations ──

export function dominantDomain(domains, domainCodes) {
  const allIndices = unionIndices(...domains.map(d => d.indices));
  const n = allIndices.length;
  const values = new Int32Array(n);
  const lookups = domains.map(d => {
    const m = new Map();
    for (let i = 0; i < d.indices.length; i++) m.set(d.indices[i], i);
    return m;
  });
  for (let i = 0; i < n; i++) {
    const gIdx = allIndices[i];
    let bestProp = -1, bestCode = 0;
    for (let d = 0; d < domains.length; d++) {
      const pos = lookups[d].get(gIdx);
      if (pos !== undefined && domains[d].proportions[pos] > bestProp) {
        bestProp = domains[d].proportions[pos];
        bestCode = domainCodes[d];
      }
    }
    values[i] = bestCode;
  }
  return { values, indices: allIndices };
}

export function domainFromCategorical(categorical, code) {
  const result = [];
  for (let i = 0; i < categorical.values.length; i++) {
    if (categorical.values[i] === code) result.push(categorical.indices[i]);
  }
  return new Int32Array(result);
}
