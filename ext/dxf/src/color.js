// DXF colour resolution — kept UN-FLATTENED (SPEC-dxf §4).
//
// An ACI palette index, a BYLAYER / BYBLOCK reference, and a 24-bit true colour are
// DISTINCT and must not collapse into one RGB triple. Flattening ACI → RGB discards the
// layer-driven colour scheme mining/geology drawings rely on (the colour IS data). So
// the model preserves the mode; aciToRgb is a render-time convenience, never canonical.

const BYLAYER = 256, BYBLOCK = 0;

// Resolve raw colour group codes into the typed colour model. `aci` is group 62 (may be
// null/absent), `trueColor` is group 420 (24-bit packed RGB, may be null). True colour
// wins when present (that's the DXF precedence). A negative ACI marks a layer turned off.
export function resolveColor({ aci = null, trueColor = null } = {}) {
  if (trueColor != null) {
    return { mode: 'rgb', r: (trueColor >> 16) & 0xff, g: (trueColor >> 8) & 0xff, b: trueColor & 0xff };
  }
  if (aci == null || aci === BYLAYER) return { mode: 'bylayer' };
  if (aci === BYBLOCK) return { mode: 'byblock' };
  if (aci < 0) return { mode: 'aci', index: -aci, off: true };
  return { mode: 'aci', index: aci };
}

// Serialize the colour model back to the group-code pairs the writer emits, preserving
// the distinction (rgb → 420, byblock → 62/0, bylayer → 62/256, aci → 62/index).
export function colorToPairs(color) {
  if (!color) return [];
  switch (color.mode) {
    case 'rgb': return [{ code: 420, value: ((color.r & 0xff) << 16) | ((color.g & 0xff) << 8) | (color.b & 0xff) }];
    case 'byblock': return [{ code: 62, value: BYBLOCK }];
    case 'bylayer': return [{ code: 62, value: BYLAYER }];
    case 'aci': return [{ code: 62, value: color.off ? -color.index : color.index }];
    default: return [];
  }
}

// The 7 standard ACI named colours, for renderers that want a quick RGB. The model keeps
// the index; this is a convenience only. The full 256-entry ramp is deferred.
const ACI_RGB = {
  1: [255, 0, 0], 2: [255, 255, 0], 3: [0, 255, 0], 4: [0, 255, 255],
  5: [0, 0, 255], 6: [255, 0, 255], 7: [255, 255, 255],
};

export function aciToRgb(index) { return ACI_RGB[index] || null; }
