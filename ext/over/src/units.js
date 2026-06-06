// @gcu/over — units: compile-time dimensional checking of grade math. A column can
// carry a UNIT (a dimension) beside its vtype; units propagate through arithmetic in
// the schema pass and mismatches WARN (advisory, like AIR hints — never an error,
// never a runtime cost: the emitted JS is unchanged). This catches the silent grade
// disasters — adding a % grade to a g/t grade, compositing in feet against a metre
// model, computing metal with the wrong unit.
//
// Built on @gcu/dimensions (the shared algebra). The KEY domain choice: grade units
// (%, g/t, ppm, oz/t) get DISTINCT axes so they never silently mix — a physics engine
// would reduce all of them to "dimensionless" and miss the headline error. Physical
// units (m, t, m³) share real axes so density·volume→tonnes & grade·tonnes→metal fall
// out. m vs ft are distinct axes too (Tier 1 has no conversion — mixing them warns).

import { dimMul, dimDiv, dimPow, dimEq, dimFormat } from '../../dimensions/src/dimensions.js';

// Atomic unit symbols → dimension. Grade units are their OWN axes (pct/gpt/ppm/ozt);
// physical units get a per-symbol base axis (so m≠ft, t≠g — Tier 1 keeps them apart).
const U = {
  '%': { pct: 1 }, 'pct': { pct: 1 }, 'percent': { pct: 1 },
  'g/t': { gpt: 1 }, 'gpt': { gpt: 1 }, 'gpt_au': { gpt: 1 },
  'ppm': { ppm: 1 }, 'ppb': { ppb: 1 },
  'oz/t': { ozt: 1 }, 'opt': { ozt: 1 },
  'm': { m: 1 }, 'cm': { cm: 1 }, 'mm': { mm: 1 }, 'km': { km: 1 }, 'ft': { ft: 1 },
  't': { t: 1 }, 'kg': { kg: 1 }, 'g': { g: 1 }, 'lb': { lb: 1 }, 'oz': { oz: 1 },
};

// A single factor: `m` | `m3` | `m^3` | `ft2` — base symbol with an optional integer
// exponent. Unknown base → its own axis (lenient: a typo'd unit type-checks as a
// distinct unit, so it mismatches a correct one and surfaces the typo).
function factorDim(sym) {
  const m = sym.match(/^([A-Za-z%]+?)\^?(-?\d+)?$/);
  if (!m) return { [sym]: 1 };
  const base = m[1], exp = m[2] ? parseInt(m[2], 10) : 1;
  const baseDim = (base in U) ? U[base] : { [base]: 1 };
  return dimPow(baseDim, exp);
}

// Parse a unit string → dimension. Atomic symbols (incl. grade compounds like `g/t`)
// resolve directly; anything else is a product/quotient of factors (`t/m3`, `g/cm3`).
export function parseUnit(str) {
  const s = String(str || '').trim();
  if (!s || s === '1' || s === '-') return {};        // dimensionless
  if (s in U) return U[s];                             // atomic (g/t, oz/t, %, …)
  let dim = {}, op = '*';
  const re = /([*/·])|([^*/·\s]+)/g;
  let mm;
  while ((mm = re.exec(s)) !== null) {
    if (mm[1]) op = mm[1] === '/' ? '/' : '*';
    else { const f = factorDim(mm[2]); dim = op === '/' ? dimDiv(dim, f) : dimMul(dim, f); op = '*'; }
  }
  return dim;
}

const UNIT_PRESERVING = new Set(['abs', 'min', 'max', 'minia', 'maxia', 'round', 'int']);
const AGG_PRESERVING = new Set(['mean', 'sum', 'min', 'max', 'std', 'first', 'last', 'prev', 'next']);

// Infer the unit (a dim) of an expression, or null = "no unit info" (polymorphic — a
// bare literal or undeclared column adopts the other operand's unit, so adding a
// constant to a g/t doesn't nag). uctx = { unitOf(name) → dim|null, warn(msg) }.
export function inferUnit(expr, uctx) {
  if (!expr) return null;                  // bare annotation (no value) → no inferred unit
  switch (expr.type) {
    case 'Field': return uctx.unitOf(expr.name);
    case 'Unary': return inferUnit(expr.operand, uctx);
    case 'Binary': return binaryUnit(expr, uctx);
    case 'Call': return UNIT_PRESERVING.has(expr.name) && expr.args[0] ? inferUnit(expr.args[0], uctx) : null;
    case 'Match': return matchUnit(expr, uctx);
    case 'Window': {
      const a = expr.agg;
      return a && a.name && AGG_PRESERVING.has(a.name) && a.args && a.args[0] ? inferUnit(a.args[0], uctx) : null;
    }
    default: return null;       // Num/Str/Bool/Absent → polymorphic; Lookup/JoinAgg/count → unknown
  }
}

function binaryUnit(e, uctx) {
  const op = e.op;
  if (op === 'and' || op === 'or' || op === '??') return null;
  const lu = inferUnit(e.left, uctx), ru = inferUnit(e.right, uctx);
  if (op === '+' || op === '-') {
    if (lu && ru) {
      if (!dimEq(lu, ru)) { uctx.warn(`${op === '+' ? 'adding' : 'subtracting'} incompatible units (${dimFormat(lu)} vs ${dimFormat(ru)})`); return null; }
      return lu;
    }
    return lu || ru;            // one side unitless → adopt the other's unit (no nag)
  }
  if (op === '*') return (!lu && !ru) ? null : dimMul(lu || {}, ru || {});
  if (op === '/') return (!lu && !ru) ? null : dimDiv(lu || {}, ru || {});
  // comparison → bool, no unit; but flag comparing across units
  if (lu && ru && !dimEq(lu, ru)) uctx.warn(`comparing incompatible units (${dimFormat(lu)} vs ${dimFormat(ru)})`);
  return null;
}

function matchUnit(e, uctx) {
  const us = e.arms.map((a) => inferUnit(a.value, uctx));
  if (e.default) us.push(inferUnit(e.default, uctx));
  const known = us.filter(Boolean);
  if (!known.length) return null;
  return known.every((u) => dimEq(u, known[0])) ? known[0] : null;
}

export { dimEq, dimFormat };   // re-exported for the schema pass
