// @gcu/stereonet — declarative, interactive, reactive stereonet cells.
//
// EXTENSION_SPEC §3.1 cell type, notebook context. A `/// stereonet` cell's
// SOURCE is structural-geology measurements + a few directives; its OUTPUT is an
// interactive equal-area / equal-angle net (drag to rotate); and it DEFINES a
// scope handle that downstream cells consume reactively — edit a measurement and
// the DAG re-runs the dependents.
//
// The engine is @gcu/bearing, loaded at execute time via the cell context's
// load() (so `install("@gcu/bearing")` once makes it offline; no vendoring).
//
// Cell format (one statement per line; `;` or `//` start a comment):
//   name <var>                 scope name this cell defines (default: stereonet)
//   proj equal-area|equal-angle
//   view <trend> <plunge>      rotate the net to this centre
//   g <group>                  subsequent items join this group
//   plane <dipDir> <dip> [#rgb]
//   pole  <dipDir> <dip> [#rgb]
//   line  <trend>  <plunge> [#rgb]
//   contour                    density-contour all poles/lines (≥3)

const NAME_RE = /^\s*name\s+([A-Za-z_]\w*)/m;
const COLOR_RE = /#[0-9a-fA-F]{3,8}\b/;

function exportName(code) {
  const m = NAME_RE.exec(code);
  return m ? m[1] : 'stereonet';
}

// Parse the mini-format into a render spec. Pure + side-effect free.
function parseCell(code) {
  const spec = { projection: 'equal-area', size: 520, view: null, name: 'stereonet', contour: false, items: [] };
  let group = null;
  for (const raw of code.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('//')) continue;
    const tok = line.split(/\s+/);
    const head = tok[0].toLowerCase();
    const num = (i) => parseFloat(tok[i]);
    const color = (line.match(COLOR_RE) || [])[0];
    switch (head) {
      case 'name': spec.name = tok[1] || spec.name; break;
      case 'proj': case 'projection':
        spec.projection = /angle|wulff/i.test(tok[1] || '') ? 'equal-angle' : 'equal-area'; break;
      case 'view': spec.view = [num(1), num(2)]; break;
      case 'g': case 'group': group = tok.slice(1).join(' ') || null; break;
      case 'contour': spec.contour = true; break;
      case 'plane': case 'pole': case 'line':
        spec.items.push({ kind: head, a: num(1), b: num(2), color, group }); break;
      default: break; // ignore unknown lines (forward-compatible)
    }
  }
  return spec;
}

// Pointer-driven arcball rotation on the live SVG (no cell re-run — DOM only).
function wireArcball(el, sn, mat3) {
  el.style.cursor = 'grab';
  el.style.touchAction = 'none';
  let cur = null;
  const toSvg = (e) => {
    const r = el.getBoundingClientRect();
    const k = sn.size / r.width;
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
  };
  el.addEventListener('pointerdown', (e) => {
    cur = toSvg(e); el.setPointerCapture?.(e.pointerId); el.style.cursor = 'grabbing'; e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    if (!cur) return;
    const n = toSvg(e);
    const arc = sn.arcball(cur.x, cur.y, n.x, n.y);
    const R = sn.rotation ? mat3.multiply(arc, sn.rotation) : arc;
    sn.setRotation(mat3.orthonormalize(R));
    sn.updateContours(); sn.render();
    cur = n;
  });
  const end = () => { cur = null; el.style.cursor = 'grab'; };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

// EXTENSION_SPEC §3.1 — the one name this cell contributes to downstream scope.
export function stereonetParseNames(code) {
  return new Set([exportName(code)]);
}

// Self-contained data (no upstream references in the format) → no DAG in-edges.
export function stereonetFindUses() {
  return new Set();
}

// EXTENSION_SPEC §3.1 — execute(code, upstream, cell). Output via cell._ctx.display;
// scope populated by the returned { defines }.
export async function stereonetExecute(code, _upstream, cell) {
  const ctx = cell?._ctx;
  if (!ctx) throw new Error('stereonet: no cell context');

  let B;
  try {
    B = await ctx.load('@gcu/bearing');
  } catch (e) {
    throw new Error("stereonet: couldn't load @gcu/bearing — run install(\"@gcu/bearing\") once, then re-run.");
  }
  const { Stereonet, mat3, conversions, statistics } = B;

  const spec = parseCell(code);
  const sn = new Stereonet({ projection: spec.projection, size: spec.size, classPrefix: 'sn' });
  if (spec.view) sn.setCenter(spec.view[0], spec.view[1]);

  const groups = {};
  const all = [];
  const add = (g, d) => { (groups[g || 'all'] ||= []).push(d); all.push(d); };

  for (const it of spec.items) {
    const style = it.color ? { stroke: it.color, fill: it.color } : {};
    if (it.kind === 'plane') { sn.plane(it.a, it.b, style); add(it.group, conversions.planeToDcos(it.a, it.b)); }
    else if (it.kind === 'pole') { sn.pole(it.a, it.b, style); add(it.group, conversions.planeToDcos(it.a, it.b)); }
    else if (it.kind === 'line') { sn.line(it.a, it.b, style); add(it.group, conversions.lineToDcos(it.a, it.b)); }
  }
  if (spec.contour && all.length >= 3) sn.contour(all);

  const el = sn.element();
  wireArcball(el, sn, mat3);
  ctx.display(el);

  // The reactive scope handle downstream cells consume.
  const stats = all.length >= 2
    ? { ...statistics.principalAxes(all), fisher: statistics.fisherStats(all) }
    : null;
  const handle = { stereonet: sn, element: el, dcos: all, groups, stats };

  ctx.display(`${spec.name}: ${all.length} measurement${all.length === 1 ? '' : 's'}`
    + `${spec.contour ? ' · contoured' : ''} · ${spec.projection}`);

  return { defines: { [spec.name]: handle } };
}

// EXTENSION_SPEC §2.3 guard — register once per page (dev hot-reload / re-load safe).
if (typeof window !== 'undefined' && !window._cellTypes?.['stereonet']) {
  const register = window.auditable?.registerExtension;
  if (register) {
    register({
      name: '@gcu/stereonet',
      version: '0.1.0',
      description: 'Declarative, interactive, reactive stereonet cells (structural geology).',
      pluginUrl: '@gcu/stereonet',
      cellType: {
        name: 'stereonet',
        label: 'Stereonet',
        color: 'var(--au-info)',
        shortcut: 's',
        editDebounce: 250,
        capabilities: { executable: true, definesScope: true, hasOutput: true, hasEditor: true, builtin: false },
        parseNames: stereonetParseNames,
        findUses: stereonetFindUses,
        execute: stereonetExecute,
      },
    });
  }
}

export { parseCell };
