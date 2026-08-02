// @gcu/facet — reading plane sets back out of vertex colors (ply2atti compat).
//
// The established workflow this replaces is: paint the outcrop mesh in MeshLab
// with saturated primary colors, one color per joint set, export .ply, run
// ply2atti. Anyone with that habit has meshes already painted, and they should
// open here and just work.
//
// The rule is the original's: a vertex belongs to a set if every channel is
// exactly 0 or exactly 1 and the color is not black — that is, one of the seven
// saturated corners of the RGB cube. Photogrammetry texture colors are essentially
// never exactly saturated, so this cleanly separates "painted by a human" from
// "photographed", with no threshold to tune.
//
// "Exactly" is relaxed to a tolerance because the round trip through 8-bit .ply
// and back is exact but a round trip through some editors is not. The default is
// half a step of 8-bit quantization, which admits genuine paint and still
// excludes any real photographic color.

/**
 * Group vertices by painted color.
 *
 * @param {ArrayLike<number>} colors  flat rgb, length 3·nv. Values are read as
 *        0-255 if anything exceeds 1, otherwise as 0-1.
 * @param {object} [opts]
 * @param {number} [opts.tolerance=0.002]  in 0-1 units; how far from an exact 0 or
 *        1 a channel may sit and still count as painted
 * @param {boolean} [opts.includeWhite=false]  white is a saturated corner, but it
 *        is also the default color of an unpainted mesh, so it is excluded unless
 *        asked for
 * @returns {Array<{color: number[], key: string, vertices: Uint32Array}>}
 *          one entry per distinct color, ordered by key so the result is stable
 *          across runs. `color` is 0-1 rgb; `key` is like "100" for red.
 */
export function detectSets(colors, opts = {}) {
  const { tolerance = 0.002, includeWhite = false } = opts;
  const nv = Math.floor(colors.length / 3);

  // decide the scale from the data: a byte array has values above 1
  let scale = 1;
  for (let i = 0; i < colors.length; i++) {
    if (colors[i] > 1.0000001) { scale = 1 / 255; break; }
  }

  const groups = new Map();
  for (let v = 0; v < nv; v++) {
    const r = colors[v * 3] * scale;
    const g = colors[v * 3 + 1] * scale;
    const b = colors[v * 3 + 2] * scale;
    const cr = saturate(r, tolerance);
    if (cr < 0) continue;
    const cg = saturate(g, tolerance);
    if (cg < 0) continue;
    const cb = saturate(b, tolerance);
    if (cb < 0) continue;
    if (cr + cg + cb === 0) continue;                          // black: unpainted
    if (!includeWhite && cr + cg + cb === 3) continue;         // white: unpainted
    const key = `${cr}${cg}${cb}`;
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    list.push(v);
  }

  return [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, list]) => ({
      color: [+key[0], +key[1], +key[2]],
      key,
      vertices: Uint32Array.from(list),
    }));
}

// 0, 1, or -1 for "not saturated"
function saturate(x, tol) {
  if (Math.abs(x) <= tol) return 0;
  if (Math.abs(x - 1) <= tol) return 1;
  return -1;
}
