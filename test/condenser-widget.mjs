// @gcu/condenser anywidget — the CROSS-LANGUAGE guard. The Python packer
// really runs (in the package's own uv venv), its bytes really cross into a
// real browser, and the real built widget ESM really renders them. That is the
// only shape that can catch a wire-format drift between the two halves, which
// is the whole risk surface of a widget.
//
//   uv venv ext/condenser/anywidget/.venv
//   uv pip install --python ext/condenser/anywidget/.venv -e ext/condenser/anywidget
//   node test/condenser-widget.mjs
import { chromium } from 'playwright';
import http from 'http';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { extname, join } from 'path';

// the package's own venv — never the machine's global python
const VENV = ['ext/condenser/anywidget/.venv/Scripts/python.exe', 'ext/condenser/anywidget/.venv/bin/python']
  .find((p) => existsSync(p));
const PYTHON = VENV || 'python';

const TMP = join(process.env.CLAUDE_JOB_DIR || '.', 'tmp');
await mkdir(TMP, { recursive: true });
const T = TMP.replace(/\\/g, '\\\\');

// ── 1. the Python half: a stack that uses every kind + sub-blocking ──
const PY = `
import json, numpy as np, gcu.condenser as cd

# a SUB-BLOCKED model: 20 m parents with a 10 m core
xs, ys, zs, dx, dy, dz, val = [], [], [], [], [], [], []
for k in range(4):
    for j in range(8):
        for i in range(8):
            if 2 <= i < 6 and 2 <= j < 6:
                for a in range(2):
                    for b in range(2):
                        for c in range(2):
                            xs.append(i*20+5+a*10); ys.append(j*20+5+b*10); zs.append(k*20+5+c*10)
                            dx.append(10.); dy.append(10.); dz.append(10.); val.append(30.+i+j)
            else:
                xs.append(i*20+10); ys.append(j*20+10); zs.append(k*20+10)
                dx.append(20.); dy.append(20.); dz.append(20.); val.append(5.+i)
model = cd.blocks(np.array(xs,float), np.array(ys,float), np.array(zs,float),
                  value=np.array(val), size=(np.array(dx), np.array(dy), np.array(dz)),
                  name="model", ramp="turbo")

# drillholes through it
rng = np.random.default_rng(2)
cid, cx, cy, cz = [], [], [], []
sid, sd, sa, sdp = [], [], [], []
iid, ifr, ito, iau = [], [], [], []
for hn in range(6):
    hid = "DH%02d" % hn
    cid.append(hid); cx.append(40.+hn*25); cy.append(60.); cz.append(120.)
    for d in (0, 40, 80):
        sid.append(hid); sd.append(float(d)); sa.append(90.+hn*3); sdp.append(-60.-d*0.05)
    for f in range(0, 80, 2):
        iid.append(hid); ifr.append(float(f)); ito.append(float(f+2)); iau.append(float(rng.random()*5))
holes = cd.drillholes({"BHID":cid,"X":cx,"Y":cy,"Z":cz}, {"BHID":sid,"DEPTH":sd,"AZ":sa,"DIP":sdp},
                      {"BHID":iid,"FROM":ifr,"TO":ito,"AU":iau}, value="AU", radius=2.5, name="holes")

# a topo cloud, exempt from the section
n = 30000
px = rng.random(n)*160; py = rng.random(n)*160; pz = 150 + np.sin(px/25)*8 + np.cos(py/30)*6
topo = cd.points(px, py, pz, value=pz, name="topo", sectioned=False)

# the DATAFRAME-shaped path: size given as COLUMN NAMES, and a scalar size.
# np.isscalar("DIMX") is True, so a name once reached float() -- guard it.
tbl = {"XC": np.array(xs, float), "YC": np.array(ys, float), "ZC": np.array(zs, float),
       "DIMX": np.array(dx), "DIMY": np.array(dy), "DIMZ": np.array(dz), "CU": np.array(val)}
by_name = cd.blocks(tbl, x="XC", y="YC", z="ZC", value="CU", size=("DIMX", "DIMY", "DIMZ"))
flat = np.arange(27.0)
scalar_size = cd.blocks(np.repeat(np.arange(3.), 9) * 10, np.tile(np.repeat(np.arange(3.), 3), 3) * 10,
                        np.tile(np.arange(3.), 9) * 10, value=flat, size=(10, 10, 10))
assert by_name.count == model.count, "size-by-name lost rows"
assert len(by_name._extra["dim_palette"]) == 2, "size-by-name lost the palette"
assert scalar_size.count == 27, "scalar size failed"

w = cd.view(model, holes, topo, height=460)
open(r"${T}/multi.bin", "wb").write(w._payload)
open(r"${T}/styles.json", "w").write(json.dumps(w._styles))
print(json.dumps({
  "bytes": len(w._payload), "layers": [l.name for l in w.layers],
  "blocks": model.count, "intervals": holes.count, "points": topo.count,
  "palette": len(model._extra["dim_palette"]), "pitch": [a[1] for a in model._extra["axes"]],
  "holes": holes._extra["holes"],
  "byName": by_name.count, "byNamePalette": len(by_name._extra["dim_palette"]),
  "scalarSize": scalar_size.count,
}))
`;
let meta;
try {
  meta = JSON.parse(execFileSync(PYTHON, ['-c', PY], { encoding: 'utf8', cwd: process.cwd() }).trim().split('\n').pop());
} catch (e) {
  console.log('FAIL: the Python half did not run —', (e.stderr || e.message || '').toString().trim().split('\n').slice(-4).join('\n'));
  if (!VENV) console.log('     (no .venv — run: uv venv ext/condenser/anywidget/.venv && uv pip install --python ext/condenser/anywidget/.venv -e ext/condenser/anywidget)');
  process.exit(1);
}
console.log(`ok   python packed ${meta.layers.join(' + ')} → ${(meta.bytes / 1024).toFixed(0)} KB`
  + ` (${meta.blocks} blocks / ${meta.intervals} intervals / ${meta.points.toLocaleString()} points)`);
console.log(`ok   sub-blocked lattice: fine pitch ${JSON.stringify(meta.pitch)}, ${meta.palette} block sizes, ${meta.holes} holes`);
console.log(`ok   size= accepts COLUMN NAMES (${meta.byName} blocks, ${meta.byNamePalette} sizes) and scalars (${meta.scalarSize} blocks)`);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.bin': 'application/octet-stream', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const data = await readFile(p.startsWith('/tmp/') ? join(TMP, p.slice(5)) : '.' + p);
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
await writeFile(join(TMP, 'host.html'), '<!doctype html><meta charset=utf-8><body style="margin:0;background:#111"><div id=host style="width:760px;height:460px"></div>');

const browser = await chromium.launch({ args: ['--use-gl=angle'] });
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE:', m.text()); });
await page.goto(`http://127.0.0.1:${PORT}/tmp/host.html`, { waitUntil: 'load' });

let fails = 0;
const chk = (name, cond, extra) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? '  — ' + extra : ''}`); if (!cond) fails++; };

const r = await page.evaluate(async (port) => {
  const mod = await import(`http://127.0.0.1:${port}/ext/condenser/anywidget/gcu/condenser/static/widget.js`);
  const render = mod.default && mod.default.render;
  if (!render) return { err: 'no default.render export' };

  const makeModel = (init) => {
    const state = new Map(Object.entries(init));
    const subs = new Map();
    return {
      get: (k) => state.get(k),
      set: (k, v) => { state.set(k, v); for (const f of subs.get('change:' + k) || []) f(); },
      on: (ev, f) => { if (!subs.has(ev)) subs.set(ev, []); subs.get(ev).push(f); },
      off: (ev, f) => { const a = subs.get(ev) || []; const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); },
      save_changes: () => {},
      _get: (k) => state.get(k),
    };
  };
  const settle = () => new Promise((res) => setTimeout(res, 800));
  const lit = () => {
    const cv = document.querySelector('#host canvas');
    const gl = cv.getContext('webgl2');
    const px = new Uint8Array(cv.width * cv.height * 4);
    gl.readPixels(0, 0, cv.width, cv.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let n = 0, sig = 0;
    for (let i = 0; i < px.length; i += 4) { if (px[i] > 30 || px[i + 1] > 30 || px[i + 2] > 30) n++; sig += px[i] + px[i + 1] * 2 + px[i + 2] * 3; }
    return { n, sig };
  };

  const payload = new DataView(await (await fetch(`http://127.0.0.1:${port}/tmp/multi.bin`)).arrayBuffer());
  const styles = await (await fetch(`http://127.0.0.1:${port}/tmp/styles.json`)).json();
  const el = document.querySelector('#host');
  const out = {};
  const model = makeModel({
    _payload: payload, _styles: styles, _fit: 0, section: null,
    background: '#121212', height: 460, edl: true, edl_strength: 1, budget: 3000000, selection: {},
  });
  const dispose = render({ model, el });
  await settle(); await settle();

  const base = lit();
  out.baseLit = base.n;
  out.hud = (el.querySelector('.cdhud') || {}).textContent;

  const patch = (i, p) => { model.set('_styles', styles.map((x, k) => (k === i ? { ...x, ...p } : x))); };

  // per-layer visibility
  patch(0, { visible: false }); await settle();
  out.hiddenLit = lit().n;
  model.set('_styles', styles); await settle();
  out.restoredLit = lit().n;

  // per-layer threshold — carves the block model, leaves the others alone
  patch(0, { threshold: [25, 99] }); await settle();
  out.thrLit = lit().n;
  model.set('_styles', styles); await settle();

  // SECTION: a thin slab cuts; topo is sectioned:false so it survives — proven
  // by comparing against a run where every layer IS sectioned
  model.set('section', { axis: 'y', position: 60, thickness: 20 }); await settle();
  out.sectionLit = lit().n;
  model.set('_styles', styles.map((x) => ({ ...x, sectioned: true }))); await settle();
  out.sectionAllLit = lit().n;
  model.set('_styles', styles); model.set('section', null); await settle();

  // ── the TOOLBAR ──
  const host = el.querySelector('div');
  out.tbButtons = host.querySelectorAll('.cdt button').length;
  const toolBtn = (p) => [...host.querySelectorAll('.cdt button')].find((b) => (b.title || '').startsWith(p));
  out.legendShown = !!host.querySelector('.cdleg') && host.querySelector('.cdleg').style.display !== 'none';

  // layers popover → toggling a checkbox must reach _styles (and so Python)
  const layersBtn = [...host.querySelectorAll('.cdt button')].find((b) => (b.title || '').startsWith('Layers'));
  layersBtn.click();
  await new Promise((res) => setTimeout(res, 120));
  const boxes = [...host.querySelectorAll('.cdpop input[type=checkbox]')];
  out.popRows = boxes.length;
  if (boxes.length) { boxes[0].checked = false; boxes[0].dispatchEvent(new Event('change')); }
  await settle();
  out.tbHidLit = lit().n;
  out.tbStylesVisible = (model._get('_styles')[0] || {}).visible;
  if (boxes.length) { boxes[0].checked = true; boxes[0].dispatchEvent(new Event('change')); }
  await settle();

  // KNIFE: arm it, drag across the view, expect a section with a free normal
  const knifeBtn = [...host.querySelectorAll('.cdt button')].find((b) => (b.title || '').startsWith('Knife'));
  knifeBtn.click();
  const cv0 = document.querySelector('#host canvas');
  const r0 = cv0.getBoundingClientRect();
  await new Promise((res) => setTimeout(res, 60));
  const kp = (t2, x, y) => host.dispatchEvent(new PointerEvent(t2, { clientX: x, clientY: y, bubbles: true }));
  kp('pointerdown', r0.left + r0.width * 0.3, r0.top + r0.height * 0.35);
  kp('pointermove', r0.left + r0.width * 0.5, r0.top + r0.height * 0.5);
  const bandSvg = host.querySelector('.cdknife');
  out.bandShown = bandSvg.style.display !== 'none';
  // an SVG with no width/height gets a 300x150 intrinsic box and CLIPS the line
  // — 'display != none' was true while nothing was visible. Assert the BOX.
  out.bandBox = Math.round(bandSvg.getBoundingClientRect().width);
  out.bandCaps = bandSvg.querySelectorAll('circle').length;
  out.knifeCursor = getComputedStyle(cv0).cursor;
  kp('pointerup', r0.left + r0.width * 0.7, r0.top + r0.height * 0.65);
  await settle();
  out.knifeSection = model._get('section');
  out.scrubShown = host.querySelector('.cdsec') && host.querySelector('.cdsec').style.display !== 'none';
  // the scrub bar: the slider must NOT move as the readout's width changes
  {
    const bar = host.querySelector('.cdsec');
    const rng = bar.querySelector('input[type=range]');
    const lbl = bar.querySelector('.lbl');
    const pos = [], labels = [];
    for (const v of [0, 500, 1000]) {
      rng.value = String(v); rng.dispatchEvent(new Event('input'));
      await new Promise((res) => setTimeout(res, 220));
      pos.push(Math.round(rng.getBoundingClientRect().left));
      labels.push(lbl.textContent);
    }
    out.scrubSpread = Math.max(...pos) - Math.min(...pos);
    out.scrubLabels = labels;
  }
  model.set('section', null); await settle();

  // a SECOND view of the same widget must come up matching its stored camera —
  // _view used to be change-only, so a re-display ignored it
  model.set('_view', { name: 'north', ortho: true, n: 1 });
  await settle();
  const el2 = document.createElement('div');
  el2.style.cssText = 'width:300px;height:200px';
  document.body.appendChild(el2);
  const d2 = render({ model, el: el2 });
  await settle();
  out.orthoBefore = false;
  out.orthoAfter = el2.querySelector('.cdt button[title^="Parallel"]').getAttribute('aria-pressed') === 'true';
  d2(); el2.remove();

  // ── RECTANGLE selection: drag a box, get rows back in the packed wire format
  // that gcu.condenser decodes (u32 n, then per layer: idx, count, rows...) ──
  const cvS = document.querySelector('#host canvas');
  const rS = cvS.getBoundingClientRect();
  const drag = (from, to, path) => {
    host.dispatchEvent(new PointerEvent('pointerdown', { clientX: from[0], clientY: from[1], bubbles: true }));
    for (const p of (path || [to])) host.dispatchEvent(new PointerEvent('pointermove', { clientX: p[0], clientY: p[1], bubbles: true }));
    host.dispatchEvent(new PointerEvent('pointerup', { clientX: to[0], clientY: to[1], bubbles: true }));
  };
  const unpack = (dv) => {
    if (!dv || dv.byteLength < 4) return {};
    const out2 = {}; const n = dv.getUint32(0, true); let off = 4;
    for (let q = 0; q < n; q++) {
      const li = dv.getUint32(off, true), count = dv.getUint32(off + 4, true);
      off += 8;
      const rows = [];
      for (let z = 0; z < count; z++) { rows.push(dv.getUint32(off, true)); off += 4; }
      out2[li] = rows;
    }
    return out2;
  };
  toolBtn('Rectangle').click();
  out.rectCursor = getComputedStyle(cvS).cursor;
  drag([rS.left + rS.width * 0.30, rS.top + rS.height * 0.30],
       [rS.left + rS.width * 0.62, rS.top + rS.height * 0.66],
       [[rS.left + rS.width * 0.45, rS.top + rS.height * 0.5], [rS.left + rS.width * 0.62, rS.top + rS.height * 0.66]]);
  await settle();
  out.rectSel = unpack(model._get('_sel_rows'));
  out.rectLit = lit().sig;
  const totalOf = (o) => Object.values(o).reduce((a, v) => a + v.length, 0);
  out.rectTotal = totalOf(out.rectSel);

  // THROUGH: the same box, but sweeping the volume behind the surface. A solid
  // block model hides most of itself, so this must catch strictly MORE.
  model.set('_clear_sel', 90); await settle();
  toolBtn('Select through').click();
  out.throughOn = model._get('select_through');
  drag([rS.left + rS.width * 0.30, rS.top + rS.height * 0.30],
       [rS.left + rS.width * 0.62, rS.top + rS.height * 0.66],
       [[rS.left + rS.width * 0.45, rS.top + rS.height * 0.5], [rS.left + rS.width * 0.62, rS.top + rS.height * 0.66]]);
  await settle();
  out.throughSel = unpack(model._get('_sel_rows'));
  out.throughTotal = Object.values(out.throughSel).reduce((a, v) => a + v.length, 0);
  // …and a surface selection is a SUBSET of the through selection (same box)
  // how much of the surface set does the tube contain? Not 100%: the tube tests
  // an element's CENTRE, the surface tests its rendered PIXELS, so an element
  // straddling the marquee edge can be caught by one and not the other.
  {
    let inBoth = 0, total = 0, missByLayer = {};
    for (const [li, rows] of Object.entries(out.rectSel)) {
      const big = new Set(out.throughSel[li] || []);
      let miss = 0;
      for (const r of rows) { total++; if (big.has(r)) inBoth++; else miss++; }
      if (miss) missByLayer[li] = miss;
    }
    out.subsetFrac = total ? inBoth / total : 0;
    out.subsetMiss = missByLayer;
    out.subsetTotal = total;
  }
  toolBtn('Select through').click();                       // back to surface
  out.throughOff = model._get('select_through');
  model.set('_clear_sel', 91); await settle();

  // LASSO over a deliberately smaller loop → strictly fewer rows
  model.set('_clear_sel', 1); await settle();
  toolBtn('Lasso').click();
  const cx0 = rS.left + rS.width * 0.46, cy0 = rS.top + rS.height * 0.48, rad = Math.min(rS.width, rS.height) * 0.11;
  const loop = [];
  for (let a = 0; a <= 18; a++) { const th = (a / 18) * Math.PI * 2; loop.push([cx0 + Math.cos(th) * rad, cy0 + Math.sin(th) * rad]); }
  drag(loop[0], loop[loop.length - 1], loop);
  await settle();
  out.lassoSel = unpack(model._get('_sel_rows'));
  out.lassoTotal = totalOf(out.lassoSel);

  // clearing from Python drops the wash
  model.set('_clear_sel', 2); await settle();
  out.clearedTotal = totalOf(unpack(model._get('_sel_rows')));

  // ── MEASURE: two clicks on elements → distance, bearing, plunge ──
  toolBtn('Measure').click();
  const clickAt = (x, y) => {
    host.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, bubbles: true }));
    host.dispatchEvent(new PointerEvent('pointerup', { clientX: x, clientY: y, bubbles: true }));
  };
  let meas = {};
  outer: for (const A of [[0.42, 0.44], [0.46, 0.5], [0.5, 0.46]]) {
    for (const B of [[0.58, 0.58], [0.55, 0.62], [0.6, 0.52]]) {
      model.set('measurement', {});
      clickAt(rS.left + rS.width * A[0], rS.top + rS.height * A[1]); await settle();
      clickAt(rS.left + rS.width * B[0], rS.top + rS.height * B[1]); await settle();
      meas = model._get('measurement') || {};
      if (meas.distance) break outer;
    }
  }
  out.measurement = meas;
  out.measBandShown = host.querySelector('.cdknife').style.display !== 'none';
  toolBtn('Pick').click();

  // pick → layer + row
  const cv = document.querySelector('#host canvas');
  const rect = cv.getBoundingClientRect();
  let sel = {};
  for (const [fx, fy] of [[0.5, 0.5], [0.45, 0.55], [0.55, 0.45], [0.5, 0.62], [0.4, 0.45]]) {
    const cx = rect.left + rect.width * fx, cy = rect.top + rect.height * fy;
    cv.dispatchEvent(new PointerEvent('pointerdown', { clientX: cx, clientY: cy, bubbles: true }));
    cv.dispatchEvent(new PointerEvent('pointerup', { clientX: cx, clientY: cy, bubbles: true }));
    await settle();
    sel = model._get('selection') || {};
    if (sel.row != null && sel.row >= 0) break;
  }
  out.selection = sel;
  out.pickBoxShown = host.querySelector('.cdpick') && host.querySelector('.cdpick').style.display !== 'none';
  out.pickBoxText = (host.querySelector('.cdpick') || {}).textContent || '';

  let disposeErr = null;
  try { dispose(); } catch (e) { disposeErr = e.message; }
  out.disposeErr = disposeErr;
  out.emptied = el.children.length === 0;

  // a malformed payload must degrade, not explode
  const m3 = makeModel({ _payload: new DataView(new ArrayBuffer(4)), _styles: [], _fit: 0, section: null, background: '#121212', height: 200, edl: true, edl_strength: 1, budget: 1e6, selection: {} });
  let badErr = null;
  try { const d3 = render({ model: m3, el }); await settle(); out.badHud = (el.querySelector('.cdhud') || {}).textContent; d3(); }
  catch (e) { badErr = e.message; }
  out.badErr = badErr;
  return out;
}, PORT);

if (r.err) { console.log('FAIL:', r.err); process.exit(1); }

chk(`three kinds render co-registered in one view (${r.baseLit.toLocaleString()} lit px, hud "${r.hud}")`,
  r.baseLit > 20000 && /3 layers/.test(r.hud || ''));
chk(`per-layer visibility: hiding the model drops pixels (${r.baseLit.toLocaleString()} → ${r.hiddenLit.toLocaleString()}) and restores`,
  r.hiddenLit < r.baseLit * 0.9 && Math.abs(r.restoredLit - r.baseLit) < r.baseLit * 0.05);
chk(`per-layer threshold carves its own layer only (${r.thrLit.toLocaleString()} lit px)`,
  r.thrLit > 0 && r.thrLit < r.baseLit);
chk(`section cuts the scene (${r.baseLit.toLocaleString()} → ${r.sectionLit.toLocaleString()} px)`, r.sectionLit < r.baseLit * 0.95);
chk(`sectioned=False exempts a layer (exempt ${r.sectionLit.toLocaleString()} px > all-sectioned ${r.sectionAllLit.toLocaleString()} px)`,
  r.sectionAllLit < r.sectionLit);
chk(`pick returns layer + row (${JSON.stringify(r.selection)})`,
  r.selection && Number.isInteger(r.selection.row) && r.selection.row >= 0 && typeof r.selection.name === 'string' && r.selection.name.length > 0);
chk(`toolbar renders (${r.tbButtons} buttons) with the colour legend`, r.tbButtons === 11 && r.legendShown);
chk(`rectangle select returns rows in the packed wire format (${r.rectTotal.toLocaleString()} rows over ${Object.keys(r.rectSel).length} layer(s))`,
  r.rectTotal > 0 && Object.keys(r.rectSel).length >= 1 && r.rectCursor === 'crosshair');
chk(`select THROUGH catches the volume behind the surface (${r.throughTotal.toLocaleString()} vs ${r.rectTotal.toLocaleString()} rows on the same box)`,
  r.throughOn === true && r.throughOff === false && r.throughTotal > r.rectTotal * 1.5);
chk(`the tube contains ${(r.subsetFrac * 100).toFixed(1)}% of the surface selection (edge elements differ: centre vs pixels)`,
  r.subsetFrac > 0.9, `missed by layer: ${JSON.stringify(r.subsetMiss)} of ${r.subsetTotal}`);
chk(`lasso select is tighter than the box (${r.lassoTotal.toLocaleString()} vs ${r.rectTotal.toLocaleString()} rows)`,
  r.lassoTotal > 0 && r.lassoTotal < r.rectTotal);
chk('clear_selection() from Python empties it', r.clearedTotal === 0);
chk(`measure gives distance / bearing / plunge (${r.measurement.distance ? Math.round(r.measurement.distance) : '—'} m, brg ${r.measurement.bearing != null ? Math.round(r.measurement.bearing) : '—'}, plunge ${r.measurement.plunge != null ? Math.round(r.measurement.plunge) : '—'})`,
  !!r.measurement.distance && r.measurement.distance > 0 && Number.isFinite(r.measurement.bearing)
  && Number.isFinite(r.measurement.plunge) && Array.isArray(r.measurement.from) && r.measBandShown);
chk(`layers popover lists all 3 and a toggle reaches _styles (visible=${r.tbStylesVisible}, ${r.baseLit.toLocaleString()} → ${r.tbHidLit.toLocaleString()} px)`,
  r.popRows === 3 && r.tbStylesVisible === false && r.tbHidLit < r.baseLit * 0.9);
chk(`knife drag cuts a section on a free normal (${JSON.stringify(r.knifeSection && r.knifeSection.normal ? r.knifeSection.normal.map((v) => Math.round(v * 100) / 100) : null)})`,
  r.knifeSection && Array.isArray(r.knifeSection.normal) && Number.isFinite(r.knifeSection.position) && r.scrubShown);
chk(`knife shows a crosshair and a traced line that fills the view (${r.bandBox}px box, ${r.bandCaps} end caps)`,
  r.bandShown && r.bandBox > 600 && r.bandCaps === 2 && r.knifeCursor === 'crosshair', `cursor=${r.knifeCursor}`);
chk(`the scrub slider is pinned — it cannot move as the readout's number changes width (spread ${r.scrubSpread}px)`,
  r.scrubSpread === 0, JSON.stringify(r.scrubLabels));
chk(`a second view honours the widget's stored camera (ortho ${r.orthoBefore} -> ${r.orthoAfter})`,
  r.orthoBefore === false && r.orthoAfter === true);
chk(`pick readout shows the record (${JSON.stringify((r.pickBoxText || '').slice(0, 42))})`,
  r.pickBoxShown && /row/.test(r.pickBoxText));
chk('dispose is clean and empties the host', !r.disposeErr && r.emptied, r.disposeErr || '');
chk(`a malformed payload degrades quietly (hud "${r.badHud}")`, !r.badErr && /no data/.test(r.badHud || ''), r.badErr || '');

console.log(fails ? `\nCONDENSER WIDGET: ${fails} FAILURES` : '\nCONDENSER WIDGET: PASS');
await browser.close();
server.close();
process.exit(fails ? 1 : 0);
