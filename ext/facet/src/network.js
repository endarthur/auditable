// @gcu/facet — fracture-network topology, the Sanderson & Nixon I/Y/X scheme.
//
// Once traces are digitized, the network's connectivity is read off the nodes
// where traces meet, classified by how many branches arrive:
//
//   I   degree 1   a free end — the trace stops in intact rock
//   Y   degree 3   an abutment — one trace terminates against another
//   X   degree 4   a crossing — two traces cut through each other
//
// Degree 2 is not a node at all, just a point along a trace, and is excluded.
// Degrees of 5 and above are geometrically possible but usually mean two nodes
// digitized on top of each other; they are counted and reported rather than
// quietly folded into X, because a silent reclassification would move the
// connectivity numbers without saying so.
//
// CAPIVARAS stopped at the classification — `updateTopology()` literally returned
// the set, and status.txt recorded that the real analysis "tá no jupyter", in a
// notebook outside the repo that never came home. The derived quantities below
// are the rest of it, and they are four lines of arithmetic:
//
//   Sanderson, D.J. & Nixon, C.W. (2015), "The use of topology in fracture
//   network characterization", Journal of Structural Geology 72, 55-66.

/**
 * Classify the nodes of a trace network and derive its connectivity.
 *
 * Nodes are identified by vertex index, so two traces meet only where they share
 * an actual mesh vertex. Snapping nearby endpoints together is the host's job,
 * not this function's — proximity is a display-scale decision and does not belong
 * buried in the topology.
 *
 * @param {Array<ArrayLike<number>>} traces  each a polyline of vertex indices
 * @returns {{
 *   nodes: Array<{vertex: number, degree: number, kind: 'I'|'Y'|'X'|'other'}>,
 *   counts: {I: number, Y: number, X: number, other: number},
 *   branches: number, lines: number,
 *   connectivityPerBranch: number, connectivityPerLine: number
 * }}
 */
export function nodeClasses(traces) {
  // degree = number of DISTINCT neighbors, so a segment digitized twice over the
  // same pair of vertices counts once. Retracing a trace should not invent a node.
  const adj = new Map();
  const touch = (a, b) => {
    let s = adj.get(a);
    if (!s) adj.set(a, (s = new Set()));
    s.add(b);
  };
  for (const t of traces) {
    if (t.length === 1) touch(t[0], -1);             // a lone pinned point is a free end
    for (let i = 1; i < t.length; i++) {
      const u = t[i - 1], v = t[i];
      if (u === v) continue;                         // a repeated click is not a segment
      touch(u, v);
      touch(v, u);
    }
  }

  const nodes = [];
  const counts = { I: 0, Y: 0, X: 0, other: 0 };
  for (const [vertex, set] of adj) {
    const degree = set.has(-1) ? 1 : set.size;
    if (degree === 2) continue;                      // interior point, not a node
    const kind = degree === 1 ? 'I' : degree === 3 ? 'Y' : degree === 4 ? 'X' : 'other';
    counts[kind]++;
    nodes.push({ vertex, degree, kind });
  }
  nodes.sort((a, b) => a.vertex - b.vertex);         // deterministic across runs

  const { I, Y, X } = counts;
  const branches = (I + 3 * Y + 4 * X) / 2;
  const lines = (I + Y) / 2;
  return {
    nodes,
    counts,
    branches,
    lines,
    connectivityPerBranch: branches > 0 ? (3 * Y + 4 * X) / branches : 0,
    connectivityPerLine: lines > 0 ? 2 * (Y + X) / lines : 0,
  };
}
