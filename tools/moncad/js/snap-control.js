// moncad snap-control — the SPEC §7 contract: snapping must never be a fight. Trivially
// toggled off for a free point, constrained to exactly the types you want, with feedback
// so you always know what it's about to grab. Defaults sensible, full control available.
//
// This module is the pure STATE + RESOLUTION layer (no DOM, node-testable). The snap.js
// index is unchanged; here we decide, per pick, which candidates are eligible:
//   - master off            → no snap (a free point is one F3 away)
//   - a one-shot override    → only that type, for the NEXT pick, even if master is off
//     (the AutoLISP osnap-override heritage: `cen` forces a centre snap once)
//   - otherwise              → the running per-type set (end/mid/centre/node, persisted)
// Tab cycles the eligible candidates instead of letting priority auto-pick (cycleIdx).

// The running snap types shipped in slice 3 (later: intersection / perp / tangent / grid).
export const SNAP_TYPES = ['end', 'mid', 'center', 'node'];
export const SNAP_LABELS = { end: 'END', mid: 'MID', center: 'CEN', node: 'NOD' };

// Command-line one-shot override words → snap type (the osnap-override vocabulary). `NONE`
// is the explicit "no snap for the next pick" override (`non`/`none`).
export const OVERRIDE_WORDS = {
  end: 'end', endp: 'end', mid: 'mid', cen: 'center', cent: 'center', centre: 'center',
  center: 'center', nod: 'node', node: 'node', non: 'NONE', none: 'NONE',
};

export class SnapState {
  constructor(init = {}) {
    this.master = init.master !== false;                  // default on
    this.types = new Set(init.types || SNAP_TYPES);       // running set
    this.aperture = init.aperture || 12;                  // pickup radius, CSS px
    this.gridSnap = !!init.gridSnap;                       // grid snap is a SEPARATE mode (§7), off by default
    this.ortho = !!init.ortho;                             // ortho: constrain a pick to H/V from the anchor (F8)
    this.oneShot = null;                                  // next-pick override (a type, 'NONE', or null); not persisted
  }

  toggleMaster() { this.master = !this.master; return this.master; }
  toggleGrid() { this.gridSnap = !this.gridSnap; return this.gridSnap; }
  toggleOrtho() { this.ortho = !this.ortho; return this.ortho; }
  toggleType(t) { if (this.types.has(t)) this.types.delete(t); else this.types.add(t); return this.types.has(t); }
  has(t) { return this.types.has(t); }
  setOneShot(t) { this.oneShot = t; }
  clearOneShot() { this.oneShot = null; }
  setAperture(px) { this.aperture = Math.max(2, Math.min(60, px)); return this.aperture; }

  // Resolve the eligibility for one query: { live, allowed:Set|null }. `live=false` means
  // short-circuit the query entirely (no snap). A one-shot overrides the master toggle.
  resolve() {
    if (this.oneShot !== null) {
      if (this.oneShot === 'NONE') return { live: false, allowed: null };
      return { live: true, allowed: new Set([this.oneShot]) };
    }
    if (!this.master) return { live: false, allowed: null };
    return { live: true, allowed: new Set(this.types) };
  }

  serialize() { return { master: this.master, types: [...this.types], aperture: this.aperture, gridSnap: this.gridSnap, ortho: this.ortho }; }
}

// Pick from snap.js queryAll() candidates: filter by the allowed type set, then take the
// cycleIdx-th (Tab cycling, wrapping). Returns { hit, count } — count is the eligible
// candidate count, which drives the "more under the aperture, press Tab" affordance.
export function pickSnap(candidates, allowed, cycleIdx = 0) {
  const f = allowed ? candidates.filter((c) => allowed.has(c.snap.type)) : candidates;
  if (!f.length) return { hit: null, count: 0 };
  const i = ((cycleIdx % f.length) + f.length) % f.length;
  return { hit: f[i].snap, count: f.length };
}
