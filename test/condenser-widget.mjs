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
import json, numpy as np, gcu_condenser as cd

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
  const mod = await import(`http://127.0.0.1:${port}/ext/condenser/anywidget/gcu_condenser/static/widget.js`);
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
  const kp = (t2, x, y) => host.dispatchEvent(new PointerEvent(t2, { clientX: x, clientY: y, bubbles: true }));
  kp('pointerdown', r0.left + r0.width * 0.3, r0.top + r0.height * 0.35);
  kp('pointermove', r0.left + r0.width * 0.5, r0.top + r0.height * 0.5);
  out.bandShown = host.querySelector('.cdknife').style.display !== 'none';
  kp('pointerup', r0.left + r0.width * 0.7, r0.top + r0.height * 0.65);
  await settle();
  out.knifeSection = model._get('section');
  out.scrubShown = host.querySelector('.cdsec') && host.querySelector('.cdsec').style.display !== 'none';
  model.set('section', null); await settle();

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
chk(`toolbar renders (${r.tbButtons} buttons) with the colour legend`, r.tbButtons === 7 && r.legendShown);
chk(`layers popover lists all 3 and a toggle reaches _styles (visible=${r.tbStylesVisible}, ${r.baseLit.toLocaleString()} → ${r.tbHidLit.toLocaleString()} px)`,
  r.popRows === 3 && r.tbStylesVisible === false && r.tbHidLit < r.baseLit * 0.9);
chk(`knife drag cuts a section on a free normal (${JSON.stringify(r.knifeSection && r.knifeSection.normal ? r.knifeSection.normal.map((v) => Math.round(v * 100) / 100) : null)})`,
  r.bandShown && r.knifeSection && Array.isArray(r.knifeSection.normal) && Number.isFinite(r.knifeSection.position) && r.scrubShown);
chk(`pick readout shows the record (${JSON.stringify((r.pickBoxText || '').slice(0, 42))})`,
  r.pickBoxShown && /row/.test(r.pickBoxText));
chk('dispose is clean and empties the host', !r.disposeErr && r.emptied, r.disposeErr || '');
chk(`a malformed payload degrades quietly (hud "${r.badHud}")`, !r.badErr && /no data/.test(r.badHud || ''), r.badErr || '');

console.log(fails ? `\nCONDENSER WIDGET: ${fails} FAILURES` : '\nCONDENSER WIDGET: PASS');
await browser.close();
server.close();
process.exit(fails ? 1 : 0);
