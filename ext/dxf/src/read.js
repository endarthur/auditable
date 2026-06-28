// @gcu/dxf reader — the Document assembler.
//
// Walks a DXF group-code stream into a typed Document: sections → entities → features,
// with the coordinate-provenance contract front and centre. WORLD coordinates are
// CANONICAL and never mutated — the reader computes a RECOMMENDED working offset (an
// @gcu/frame) as metadata and attaches it; consumers derive local coordinates on demand
// (`toLocalCoords(geom, doc.frame)`). The reader is bulletproof: a malformed entity is
// punted to a null-geometry feature (its property bag preserved) plus a `warnings[]`
// entry — never a throw.
//
// Geometry is normalised to 3D world coordinates in flat Float64Array buffers, and the
// curve primitive is the bulge-polyline: LINE, LWPOLYLINE, POLYLINE, and ARC all become
// `{ kind:'polyline', vertices, bulges, closed }` (ARC = a single bulge span) — the
// one-curve-type throughline. CIRCLE and POINT stay distinct (a full circle has no
// endpoints), 3DFACE is a face, INSERT is a block reference resolved by explode().

import { parsePairs } from './tokenize.js';
import { bulgeFromArc } from './arc.js';
import { resolveColor } from './color.js';
import { frameFromBounds, makeFrame } from '../../frame/src/frame.js';

const DEG = Math.PI / 180;
const IMPORTER = '@gcu/dxf@0.1.0';

// $INSUNITS → a units string (the common subset; default metres for a geo stack).
const INSUNITS = { 1: 'in', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm', 9: 'mm', 10: 'm', 14: 'dm' };

// ── small helpers ──────────────────────────────────────────────────────────────

// First value for a group code in an entity's pairs (simple entities are last-wins-safe
// because their codes don't repeat; vertex streams are iterated in order instead).
function val(pairs, code, dflt) {
  for (const p of pairs) if (p.code === code) return p.value;
  return dflt;
}

const mkFeature = (type, geometry, properties) => ({ type, geometry, properties });

// The shared attribute bag — hoard everything the format carries that means something.
function readCommon(pairs) {
  const props = {};
  let aci = null, trueColor = null, xApp = null, xdata = null, ext = null;
  for (const { code, value } of pairs) {
    switch (code) {
      case 5: props.handle = value; break;
      case 8: props.layer = value; break;
      case 6: props.linetype = value; break;
      case 62: aci = value; break;
      case 420: trueColor = value; break;
      case 370: props.lineweight = value; break;
      case 38: props.elevation = value; break;
      case 39: props.thickness = value; break;
      case 210: (ext ??= [0, 0, 1])[0] = value; break;
      case 220: (ext ??= [0, 0, 1])[1] = value; break;
      case 230: (ext ??= [0, 0, 1])[2] = value; break;
      default:
        if (code === 1001) { xApp = value; (xdata ??= {})[xApp] = []; }
        else if (code >= 1000 && code <= 1071 && xApp) xdata[xApp].push({ code, value });
    }
  }
  props.color = resolveColor({ aci, trueColor });
  if (ext) props.extrusion = ext;
  if (xdata) props.xdata = xdata;
  return props;
}

// Pack an array of [x,y,z] points into a flat Float64Array.
function packPts(pts) {
  const out = new Float64Array(pts.length * 3);
  for (let i = 0; i < pts.length; i++) { out[i * 3] = pts[i][0]; out[i * 3 + 1] = pts[i][1]; out[i * 3 + 2] = pts[i][2] || 0; }
  return out;
}

// ── per-entity parsers ───────────────────────────────────────────────────────────

function parseLine(rec) {
  const p = rec.pairs;
  const v = packPts([[val(p, 10, 0), val(p, 20, 0), val(p, 30, 0)], [val(p, 11, 0), val(p, 21, 0), val(p, 31, 0)]]);
  return mkFeature('line', { kind: 'polyline', vertices: v, bulges: null, closed: false }, readCommon(p));
}

function parseLwpolyline(rec) {
  const p = rec.pairs;
  const closed = (val(p, 70, 0) & 1) === 1, elev = val(p, 38, 0);
  const xs = [], ys = [], bs = [];
  let x = null, y = 0, b = 0, open = false;
  const flush = () => { if (open) { xs.push(x); ys.push(y); bs.push(b); } x = null; y = 0; b = 0; open = false; };
  for (const { code, value } of p) {
    if (code === 10) { flush(); x = value; open = true; }
    else if (code === 20 && open) y = value;
    else if (code === 42 && open) b = value;
  }
  flush();
  const vertices = new Float64Array(xs.length * 3);
  for (let i = 0; i < xs.length; i++) { vertices[i * 3] = xs[i]; vertices[i * 3 + 1] = ys[i]; vertices[i * 3 + 2] = elev; }
  const bulges = bs.some((v) => v !== 0) ? Float64Array.from(bs) : null;
  return mkFeature('polyline', { kind: 'polyline', vertices, bulges, closed }, readCommon(p));
}

// Old-style POLYLINE: a header + a VERTEX stream + SEQEND. Returns the feature and the
// index just past SEQEND. Polyface/polygon-mesh variants (flags 64/16) are punted (v0.2).
function parsePolyline(rec, recs, i, warnings) {
  const flags = val(rec.pairs, 70, 0);
  let j = i + 1;
  const pts = [], bs = [];
  while (j < recs.length && recs[j].type === 'VERTEX') {
    const vp = recs[j].pairs;
    pts.push([val(vp, 10, 0), val(vp, 20, 0), val(vp, 30, 0)]);
    bs.push(val(vp, 42, 0));
    j++;
  }
  if (j < recs.length && recs[j].type === 'SEQEND') j++;
  if (flags & 64 || flags & 16) {                          // polyface / polygon mesh — punt
    warnings.push({ handle: val(rec.pairs, 5, null), entity: 'POLYLINE(mesh)', reason: 'mesh POLYLINE not supported in v0.1 (metadata kept)' });
    return { feature: nullFeature(rec), next: j };
  }
  const vertices = packPts(pts);
  const bulges = bs.some((v) => v !== 0) ? Float64Array.from(bs) : null;
  return { feature: mkFeature('polyline', { kind: 'polyline', vertices, bulges, closed: (flags & 1) === 1 }, readCommon(rec.pairs)), next: j };
}

function parseCircle(rec) {
  const p = rec.pairs;
  return mkFeature('circle', { kind: 'circle', center: [val(p, 10, 0), val(p, 20, 0), val(p, 30, 0)], radius: val(p, 40, 0) }, readCommon(p));
}

// ARC enters the bulge-native model: center-form (CCW, degrees) → endpoint + bulge.
function parseArc(rec) {
  const p = rec.pairs;
  const center = [val(p, 10, 0), val(p, 20, 0), val(p, 30, 0)], radius = val(p, 40, 0), z = center[2];
  const { start, end, bulge } = bulgeFromArc(center, radius, val(p, 50, 0) * DEG, val(p, 51, 0) * DEG);
  const vertices = packPts([[start[0], start[1], z], [end[0], end[1], z]]);
  return mkFeature('arc', { kind: 'polyline', vertices, bulges: Float64Array.from([bulge]), closed: false }, readCommon(p));
}

function parsePoint(rec) {
  const p = rec.pairs;
  return mkFeature('point', { kind: 'point', position: [val(p, 10, 0), val(p, 20, 0), val(p, 30, 0)] }, readCommon(p));
}

// TEXT: insertion point (10/20/30), height (40), the string (1), rotation degrees (50).
// MTEXT and the alignment codes (11/21/72/73) are v0.2 — single-line left-baseline for now.
function parseText(rec) {
  const p = rec.pairs;
  let str = '';
  for (const { code, value } of p) if (code === 1) str = value;
  return mkFeature('text', { kind: 'text', position: [val(p, 10, 0), val(p, 20, 0), val(p, 30, 0)], height: val(p, 40, 1), rotation: val(p, 50, 0), value: str }, readCommon(p));
}

// ATTDEF: an attribute-definition template inside a block — TEXT plus tag (2), prompt (3)
// and a default value (1). The per-instance value is an ATTRIB on the INSERT (parseInsert).
function parseAttdef(rec) {
  const p = rec.pairs;
  let value = '', tag = '', prompt = '';
  for (const { code, value: v } of p) { if (code === 1) value = v; else if (code === 2) tag = v; else if (code === 3) prompt = v; }
  return mkFeature('attdef', { kind: 'attdef', position: [val(p, 10, 0), val(p, 20, 0), val(p, 30, 0)], height: val(p, 40, 1), rotation: val(p, 50, 0), tag, prompt, value }, readCommon(p));
}

function parse3dface(rec) {
  const p = rec.pairs;
  const c = [[val(p, 10, 0), val(p, 20, 0), val(p, 30, 0)], [val(p, 11, 0), val(p, 21, 0), val(p, 31, 0)],
    [val(p, 12, 0), val(p, 22, 0), val(p, 32, 0)], [val(p, 13, 0), val(p, 23, 0), val(p, 33, 0)]];
  const tri = c[3][0] === c[2][0] && c[3][1] === c[2][1] && c[3][2] === c[2][2];   // 4th==3rd → triangle
  return mkFeature('face', { kind: 'face', vertices: packPts(tri ? c.slice(0, 3) : c) }, readCommon(p));
}

// INSERT: a placed block + (when flag 66=1) an ATTRIB stream folded into the bag. The
// block geometry is referenced, not exploded — explode() resolves it on demand.
function parseInsert(rec, recs, i) {
  const p = rec.pairs;
  const props = readCommon(p);
  const geometry = {
    kind: 'insert', block: val(p, 2, ''),
    transform: { position: [val(p, 10, 0), val(p, 20, 0), val(p, 30, 0)], scale: [val(p, 41, 1), val(p, 42, 1), val(p, 43, 1)], rotation: val(p, 50, 0) },
  };
  let j = i + 1;
  if (val(p, 66, 0) === 1) {
    const attribs = [];
    while (j < recs.length && recs[j].type === 'ATTRIB') {
      const ap = recs[j].pairs;
      attribs.push({ tag: val(ap, 2, ''), value: val(ap, 1, ''), position: [val(ap, 10, 0), val(ap, 20, 0), val(ap, 30, 0)] });
      j++;
    }
    if (j < recs.length && recs[j].type === 'SEQEND') j++;
    if (attribs.length) props.attribs = attribs;
  }
  return { feature: mkFeature('insert', geometry, props), next: j };
}

// An unsupported/unrecognised entity: geometry dropped, property bag (handle/layer/
// XDATA) preserved so it round-trips as metadata and the gap is a logged decision.
function nullFeature(rec) {
  const props = readCommon(rec.pairs);
  props.dropped = rec.type;
  return mkFeature(null, null, props);
}

// ── structure ────────────────────────────────────────────────────────────────────

// Split a flat pair list into entity records at each code-0 boundary.
function splitRecords(pairs) {
  const recs = [];
  let cur = null;
  for (const p of pairs) {
    if (p.code === 0) recs.push((cur = { type: p.value, pairs: [] }));
    else if (cur) cur.pairs.push(p);
  }
  return recs;
}

// Partition into named sections → arrays of entity records (HEADER body is empty here;
// its variables are read directly via headerVar over the raw pairs).
function partitionSections(pairs) {
  const recs = splitRecords(pairs), sections = {};
  for (let i = 0; i < recs.length; i++) {
    if (recs[i].type !== 'SECTION') continue;
    const name = val(recs[i].pairs, 2, '');
    const body = [];
    for (i++; i < recs.length && recs[i].type !== 'ENDSEC'; i++) body.push(recs[i]);
    sections[name] = body;
  }
  return sections;
}

// A header variable: code 9 names it, the next pair carries the value.
function headerVar(pairs, name) {
  for (let i = 0; i < pairs.length - 1; i++) if (pairs[i].code === 9 && pairs[i].value === name) return pairs[i + 1].value;
  return undefined;
}

function parseLayers(records) {
  const layers = {};
  for (const r of records) {
    if (r.type !== 'LAYER') continue;
    const name = val(r.pairs, 2, '');
    layers[name] = { name, color: resolveColor({ aci: val(r.pairs, 62, null) }), linetype: val(r.pairs, 6, undefined) };
  }
  return layers;
}

function parseBlocks(records, warnings) {
  const blocks = {};
  for (let i = 0; i < records.length; i++) {
    if (records[i].type !== 'BLOCK') continue;
    const name = val(records[i].pairs, 2, '');
    const base = [val(records[i].pairs, 10, 0), val(records[i].pairs, 20, 0), val(records[i].pairs, 30, 0)];
    const body = [];
    for (i++; i < records.length && records[i].type !== 'ENDBLK'; i++) body.push(records[i]);
    blocks[name] = { name, base, features: assembleEntities(body, warnings) };
  }
  return blocks;
}

// Walk entity records → features, resolving the compound entities (POLYLINE vertex
// streams, INSERT attribute streams) and isolating per-entity parse errors.
function assembleEntities(records, warnings) {
  const features = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    try {
      switch (rec.type) {
        case 'LINE': features.push(parseLine(rec)); break;
        case 'LWPOLYLINE': features.push(parseLwpolyline(rec)); break;
        case 'CIRCLE': features.push(parseCircle(rec)); break;
        case 'ARC': features.push(parseArc(rec)); break;
        case 'POINT': features.push(parsePoint(rec)); break;
        case 'TEXT': features.push(parseText(rec)); break;
        case 'ATTDEF': features.push(parseAttdef(rec)); break;
        case '3DFACE': features.push(parse3dface(rec)); break;
        case 'POLYLINE': { const r = parsePolyline(rec, records, i, warnings); features.push(r.feature); i = r.next - 1; break; }
        case 'INSERT': { const r = parseInsert(rec, records, i); features.push(r.feature); i = r.next - 1; break; }
        case 'VERTEX': case 'SEQEND': case 'ATTRIB': break;        // consumed by their parent; stray → skip
        default:
          warnings.push({ handle: val(rec.pairs, 5, null), entity: rec.type, reason: 'unsupported entity (metadata kept)' });
          features.push(nullFeature(rec));
      }
    } catch (e) {
      warnings.push({ handle: val(rec.pairs, 5, null), entity: rec.type, reason: `parse error: ${e.message}` });
      features.push(nullFeature(rec));
    }
  }
  return features;
}

// Bounding box over all world geometry — drives the recommended working frame.
function computeBounds(features) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const ext = (x, y, z) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
    if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
    const zz = Number.isFinite(z) ? z : 0;
    if (zz < min[2]) min[2] = zz; if (zz > max[2]) max[2] = zz;
  };
  for (const f of features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.kind === 'polyline' || g.kind === 'face') for (let i = 0; i < g.vertices.length; i += 3) ext(g.vertices[i], g.vertices[i + 1], g.vertices[i + 2]);
    else if (g.kind === 'circle') { ext(g.center[0] - g.radius, g.center[1] - g.radius, g.center[2]); ext(g.center[0] + g.radius, g.center[1] + g.radius, g.center[2]); }
    else if (g.kind === 'point' || g.kind === 'text' || g.kind === 'attdef') ext(...g.position);
    else if (g.kind === 'insert') ext(...g.transform.position);
  }
  return min[0] === Infinity ? null : { min, max };
}

// Read DXF text into a Document. Options: { offsetStrategy:'floor'|'centroid', round,
// crs, units }. Total function — never throws on malformed input.
export function read(text, opts = {}) {
  const warnings = [];
  const pairs = parsePairs(text);
  const sections = partitionSections(pairs);
  const insunits = headerVar(pairs, '$INSUNITS');
  const units = INSUNITS[insunits] ?? opts.units ?? 'm';
  const layers = parseLayers(sections.TABLES || []);
  const blocks = parseBlocks(sections.BLOCKS || [], warnings);
  const features = assembleEntities(sections.ENTITIES || [], warnings);
  const bounds = computeBounds(features);
  const strategy = opts.offsetStrategy || 'floor';
  const frame = bounds
    ? frameFromBounds(bounds, { strategy, round: opts.round ?? 1, crs: opts.crs ?? null, units })
    : makeFrame({ crs: opts.crs ?? null, units });
  const coordinate_provenance = { canonical: 'WCS', bbox_original: bounds, frame, offset_strategy: strategy, importer: IMPORTER };
  return {
    header: { acadver: headerVar(pairs, '$ACADVER'), insunits, units, codepage: headerVar(pairs, '$DWGCODEPAGE'), coordinate_provenance },
    frame, layers, blocks, features, warnings,
  };
}
