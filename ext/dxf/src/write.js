// @gcu/dxf writer — Document → R2000 (AC1015) ASCII.
//
// The symmetric half of the provenance contract: it restores WORLD coordinates. Features
// from read() are already world (canonical), so the default writes them verbatim; if a
// consumer worked in a local frame, pass { fromLocal:true } and the doc's Frame and the
// writer re-adds the offset via toWorld — the structural fix for the silent-shift bug.
//
// Emits the scaffolding strict readers want (HEADER with $ACADVER/$INSUNITS/$HANDSEED,
// a LTYPE+LAYER TABLES section, unique handles, EOF), round-trips XDATA and blocks, and
// maps the bulge-native model back out (arc → ARC via arcFromBulge, planar polyline →
// LWPOLYLINE, non-planar → 3D POLYLINE). Punted (null-geometry) features are not
// re-emitted — they had no geometry to write. (Subclass 100 markers are a v0.2 hardening.)

import { serializePairs } from './tokenize.js';
import { arcFromBulge } from './arc.js';
import { colorToPairs } from './color.js';
import { toWorld } from '../../frame/src/frame.js';

const DEG = Math.PI / 180;
const UNIT_CODE = { in: 1, ft: 2, mm: 4, cm: 5, m: 6, um: 8, dm: 14 };
const normDeg = (rad) => ((rad / DEG) % 360 + 360) % 360;
const identity = (p) => p;

export function write(doc, opts = {}) {
  const toW = (opts.fromLocal && doc.frame) ? (p) => toWorld(p, doc.frame) : identity;
  const out = [];
  const push = (code, value) => out.push({ code, value });

  // Handle generation: preserve source handles, assign fresh ones (above the max) where absent.
  let max = 0;
  const scan = (props) => { const h = props?.handle; if (h) { const n = parseInt(h, 16); if (Number.isFinite(n) && n > max) max = n; } };
  for (const f of doc.features) scan(f.properties);
  for (const b of Object.values(doc.blocks || {})) for (const f of b.features) scan(f.properties);
  let hc = max;
  const gen = (existing) => existing || (++hc).toString(16).toUpperCase();

  emitHeader();
  emitTables();
  emitBlocks();
  push(0, 'SECTION'); push(2, 'ENTITIES');
  for (const f of doc.features) emitEntity(f, toW);
  push(0, 'ENDSEC');
  push(0, 'EOF');
  return serializePairs(out);

  // ── emit helpers (hoisted; close over out/push/gen/max) ──────────────────────────

  function emitCommon(props) {
    push(5, gen(props.handle));
    push(8, props.layer ?? '0');
    if (props.linetype) push(6, props.linetype);
    for (const cp of colorToPairs(props.color || { mode: 'bylayer' })) out.push(cp);
    if (props.lineweight != null) push(370, props.lineweight);
  }

  function emitXdata(props) {
    if (!props.xdata) return;
    for (const [app, items] of Object.entries(props.xdata)) { push(1001, app); for (const it of items) out.push({ code: it.code, value: it.value }); }
  }

  function emitHeader() {
    push(0, 'SECTION'); push(2, 'HEADER');
    push(9, '$ACADVER'); push(1, doc.header?.acadver || 'AC1015');
    push(9, '$INSUNITS'); push(70, UNIT_CODE[doc.header?.units || doc.frame?.units || 'm'] ?? 0);
    push(9, '$HANDSEED'); push(5, (max + 0x10000).toString(16).toUpperCase());
    push(0, 'ENDSEC');
  }

  function emitTables() {
    const names = new Set(['0']);
    for (const f of doc.features) if (f.properties?.layer) names.add(f.properties.layer);
    for (const n of Object.keys(doc.layers || {})) names.add(n);
    push(0, 'SECTION'); push(2, 'TABLES');
    push(0, 'TABLE'); push(2, 'LTYPE'); push(70, 1);
    push(0, 'LTYPE'); push(5, gen()); push(2, 'CONTINUOUS'); push(70, 0); push(3, 'Solid line'); push(72, 65); push(73, 0); push(40, 0);
    push(0, 'ENDTAB');
    push(0, 'TABLE'); push(2, 'LAYER'); push(70, names.size);
    for (const n of names) {
      const ld = doc.layers?.[n];
      push(0, 'LAYER'); push(5, gen()); push(2, n); push(70, 0);
      push(62, (ld?.color && ld.color.mode === 'aci') ? ld.color.index : 7);
      push(6, ld?.linetype || 'CONTINUOUS');
    }
    push(0, 'ENDTAB');
    push(0, 'ENDSEC');
  }

  function emitBlocks() {
    push(0, 'SECTION'); push(2, 'BLOCKS');
    for (const b of Object.values(doc.blocks || {})) {
      push(0, 'BLOCK'); push(5, gen()); push(8, '0'); push(2, b.name); push(70, 0);
      push(10, b.base?.[0] || 0); push(20, b.base?.[1] || 0); push(30, b.base?.[2] || 0); push(3, b.name);
      for (const f of b.features) emitEntity(f, identity);     // block body stays in block-local coords
      push(0, 'ENDBLK'); push(5, gen());
    }
    push(0, 'ENDSEC');
  }

  function emitEntity(f, tw) {
    if (!f.geometry) return;                                  // punted nulls aren't re-emitted
    const g = f.geometry, props = f.properties || {};
    switch (f.type) {
      case 'line': {
        const v = g.vertices, a = tw([v[0], v[1], v[2]]), b = tw([v[3], v[4], v[5]]);
        push(0, 'LINE'); emitCommon(props);
        push(10, a[0]); push(20, a[1]); push(30, a[2]); push(11, b[0]); push(21, b[1]); push(31, b[2]);
        emitXdata(props); break;
      }
      case 'polyline': emitPolyline(f, tw); break;
      case 'arc': {
        const v = g.vertices, p0 = tw([v[0], v[1], v[2]]), p1 = tw([v[3], v[4], v[5]]), bl = g.bulges ? g.bulges[0] : 0;
        const a = arcFromBulge([p0[0], p0[1]], [p1[0], p1[1]], bl);
        let sa = a.startAngle, ea = a.endAngle; if (bl < 0) [sa, ea] = [ea, sa];   // DXF ARC is CCW
        push(0, 'ARC'); emitCommon(props);
        push(10, a.center[0]); push(20, a.center[1]); push(30, p0[2]); push(40, a.radius);
        push(50, normDeg(sa)); push(51, normDeg(ea)); emitXdata(props); break;
      }
      case 'circle': {
        const c = tw(g.center);
        push(0, 'CIRCLE'); emitCommon(props); push(10, c[0]); push(20, c[1]); push(30, c[2]); push(40, g.radius); emitXdata(props); break;
      }
      case 'point': {
        const p = tw(g.position);
        push(0, 'POINT'); emitCommon(props); push(10, p[0]); push(20, p[1]); push(30, p[2]); emitXdata(props); break;
      }
      case 'text': {
        const p = tw(g.position);
        push(0, 'TEXT'); emitCommon(props);
        push(10, p[0]); push(20, p[1]); push(30, p[2]); push(40, g.height || 1); push(1, g.value || '');
        if (g.rotation) push(50, g.rotation);
        emitXdata(props); break;
      }
      case 'face': {
        const v = g.vertices, n = v.length / 3;
        push(0, '3DFACE'); emitCommon(props);
        for (let k = 0; k < 4; k++) { const i = Math.min(k, n - 1) * 3; const w = tw([v[i], v[i + 1], v[i + 2]]); push(10 + k, w[0]); push(20 + k, w[1]); push(30 + k, w[2]); }
        emitXdata(props); break;
      }
      case 'insert': emitInsert(f, tw); break;
    }
  }

  function emitPolyline(f, tw) {
    const g = f.geometry, props = f.properties || {}, v = g.vertices, n = v.length / 3;
    const z0 = n ? v[2] : 0;
    let planar = true; for (let i = 0; i < n; i++) if (v[i * 3 + 2] !== z0) { planar = false; break; }
    if (planar) {
      push(0, 'LWPOLYLINE'); emitCommon(props); push(90, n); push(70, g.closed ? 1 : 0); if (z0) push(38, z0);
      for (let i = 0; i < n; i++) { const w = tw([v[i * 3], v[i * 3 + 1], v[i * 3 + 2]]); push(10, w[0]); push(20, w[1]); if (g.bulges && g.bulges[i]) push(42, g.bulges[i]); }
      emitXdata(props);
    } else {
      push(0, 'POLYLINE'); emitCommon(props); push(66, 1); push(70, 8 | (g.closed ? 1 : 0));
      push(10, 0); push(20, 0); push(30, 0); emitXdata(props);
      for (let i = 0; i < n; i++) { const w = tw([v[i * 3], v[i * 3 + 1], v[i * 3 + 2]]); push(0, 'VERTEX'); push(5, gen()); push(8, props.layer ?? '0'); push(10, w[0]); push(20, w[1]); push(30, w[2]); push(70, 32); if (g.bulges && g.bulges[i]) push(42, g.bulges[i]); }
      push(0, 'SEQEND'); push(5, gen());
    }
  }

  function emitInsert(f, tw) {
    const g = f.geometry, props = f.properties || {}, t = g.transform, pos = tw(t.position);
    const hasAttr = props.attribs?.length;
    push(0, 'INSERT'); emitCommon(props); if (hasAttr) push(66, 1);
    push(2, g.block); push(10, pos[0]); push(20, pos[1]); push(30, pos[2]);
    push(41, t.scale[0]); push(42, t.scale[1]); push(43, t.scale[2]); push(50, t.rotation);
    emitXdata(props);
    if (hasAttr) {
      for (const at of props.attribs) {
        const ap = tw(at.position || pos);
        push(0, 'ATTRIB'); push(5, gen()); push(8, props.layer ?? '0');
        push(10, ap[0]); push(20, ap[1]); push(30, ap[2]); push(40, 1); push(1, at.value); push(2, at.tag); push(70, 0);
      }
      push(0, 'SEQEND'); push(5, gen());
    }
  }
}
