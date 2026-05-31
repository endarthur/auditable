// @gcu/recon — built-in heuristic packs. Each heuristic: { name, pack, detect(ctx) }
// returning Annotation[] = { target, key, value, confidence, source }. target is a
// column name or '$table'. Heuristics are pure functions of the sniff context.

import { guessCoords, detectUnit, detectAnalyte } from './naming.js';

const BOOL_SET = new Set(['0', '1', 'true', 'false', 'yes', 'no', 'y', 'n', 't', 'f']);
const colValues = (ctx, c) => ctx.sampleRows.map((r) => r[c]).filter((v) => v !== undefined && v !== '');

// ── core pack ─────────────────────────────────────────────────────────
const typeH = {
  name: 'type', pack: 'core',
  detect: (ctx) => ctx.header.map((name, c) => ({ target: name, key: 'type', value: ctx.baseTypes[c], confidence: 0.85, source: 'type' })),
};

const constantH = {
  // constant-ness is orthogonal to role (a plan-section Z is constant AND coord-z),
  // so it gets its own key rather than competing for 'role'.
  name: 'constant', pack: 'core',
  detect: (ctx) => ctx.header
    .map((name, c) => (ctx.distinct && ctx.distinct[c] === 1 && ctx.sampleRows.length > 1)
      ? { target: name, key: 'constant', value: true, confidence: 0.9, source: 'constant' } : null)
    .filter(Boolean),
};

const booleanH = {
  name: 'boolean', pack: 'core',
  detect: (ctx) => ctx.header.map((name, c) => {
    const vals = colValues(ctx, c);
    if (vals.length === 0) return null;
    return vals.every((v) => BOOL_SET.has(String(v).toLowerCase()))
      ? { target: name, key: 'role', value: 'flag', confidence: 0.8, source: 'boolean' } : null;
  }).filter(Boolean),
};

const dateH = {
  name: 'date', pack: 'core',
  detect: (ctx) => ctx.header.map((name, c) => {
    const byName = /(^|[_\s])(date|datetime|timestamp|dt)([_\s]|$)/i.test(name);
    const vals = colValues(ctx, c).slice(0, 20);
    const parseable = vals.length > 0 && vals.every((v) => /\d{4}-\d{2}-\d{2}/.test(v) || (isNaN(Number(v)) && !isNaN(Date.parse(v))));
    if (byName && parseable) return { target: name, key: 'role', value: 'date', confidence: 0.85, source: 'date' };
    if (byName) return { target: name, key: 'role', value: 'date', confidence: 0.6, source: 'date' };
    if (parseable && /\d{4}-\d{2}-\d{2}/.test(vals[0] || '')) return { target: name, key: 'role', value: 'date', confidence: 0.6, source: 'date' };
    return null;
  }).filter(Boolean),
};

const idH = {
  name: 'id', pack: 'core',
  detect: (ctx) => ctx.header.map((name, c) => {
    const idName = /(^|[_\s])(id|hole|bhid|dhid|holeid|sampleid|sample_id|key)([_\s]|$)/i.test(name) || /id$/i.test(name);
    const highCard = ctx.distinct && ctx.sampleRows.length >= 8 && ctx.distinct[c] >= ctx.sampleRows.length * 0.98;
    if (ctx.baseTypes[c] === 'id' || (idName && highCard)) {
      return { target: name, key: 'role', value: 'id', confidence: idName && highCard ? 0.9 : 0.6, source: 'id' };
    }
    return null;
  }).filter(Boolean),
};

export const corePack = [typeH, constantH, booleanH, dateH, idH];

// ── geo pack ──────────────────────────────────────────────────────────
const coordsH = {
  name: 'coords', pack: 'geo',
  detect: (ctx) => {
    const { cols, confidence } = guessCoords(ctx.header, ctx.baseTypes);
    const out = [];
    for (const axis of ['x', 'y', 'z']) {
      if (cols[axis]) out.push({ target: cols[axis], key: 'role', value: 'coord-' + axis, confidence: confidence[axis], source: 'coords' });
    }
    for (const axis of ['dx', 'dy', 'dz']) {
      if (cols[axis]) out.push({ target: cols[axis], key: 'role', value: 'size-' + axis, confidence: confidence[axis] || 0.9, source: 'coords' });
    }
    return out;
  },
};

const unitsH = {
  name: 'units', pack: 'geo',
  detect: (ctx) => ctx.header.map((name) => {
    const u = detectUnit(name);
    return u ? { target: name, key: 'unit', value: u.unit, confidence: u.confidence, source: 'units' } : null;
  }).filter(Boolean),
};

const analyteH = {
  name: 'analyte', pack: 'geo',
  // Coord-aware: a column already detected as a coordinate/size axis is NOT an
  // analyte — resolves single-letter element clashes (a "Y" axis vs Yttrium, "V"
  // vs Vanadium, etc.). coordsH runs first in the geo pack, so its role
  // annotations are already in ctx.annotations.
  detect: (ctx) => {
    const coords = new Set(ctx.annotations
      .filter((a) => a.key === 'role' && /^(coord|size)-/.test(a.value))
      .map((a) => a.target));
    return ctx.header.map((name) => {
      if (coords.has(name)) return null;
      const a = detectAnalyte(name);
      return a ? { target: name, key: 'analyte', value: a.analyte, confidence: a.confidence, source: 'analyte' } : null;
    }).filter(Boolean);
  },
};

export const geoPack = [coordsH, unitsH, analyteH];
