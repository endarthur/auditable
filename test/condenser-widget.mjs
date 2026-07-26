// @gcu/condenser anywidget — the CROSS-LANGUAGE guard. The Python packer
// really runs (subprocess), its bytes really cross into a real browser, and
// the real built widget ESM really renders them. That is the only test that
// can catch a wire-format drift between the two halves, which is the whole
// risk surface of a widget.
//
//   node test/condenser-widget.mjs        (needs: playwright, python + numpy + anywidget)
import { chromium } from 'playwright';
import http from 'http';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { execFileSync } from 'child_process';
import { extname, join } from 'path';

const TMP = join(process.env.CLAUDE_JOB_DIR || '.', 'tmp');
await mkdir(TMP, { recursive: true });

// ── 1. the Python half: pack a block model and a cloud with the real API ──
const PY = `
import sys, json, numpy as np
sys.path.insert(0, r"ext/condenser/anywidget")
import gcu_condenser as cd

xs, ys, zs, vs, cs = [], [], [], [], []
for k in range(4):
    for j in range(12):
        for i in range(12):
            xs.append(612000 + i * 10); ys.append(8200000 + j * 10); zs.append(900 + k * 10)
            vs.append(10.0 + i * 2 + k * 3); cs.append("ore" if i > 5 else "waste")
x = np.array(xs, float); y = np.array(ys, float); z = np.array(zs, float)
v = np.array(vs, float); c = np.array(cs)

b = cd.blocks(x, y, z, value=v, category=c)
open(r"${TMP.replace(/\\/g, '\\\\')}/blocks.bin", "wb").write(b._payload)

rng = np.random.default_rng(7)
n = 40000
px = 611000 + rng.random(n) * 200; py = 8200000 + rng.random(n) * 200; pz = 900 + rng.random(n) * 60
p = cd.points(px, py, pz, value=pz)
open(r"${TMP.replace(/\\/g, '\\\\')}/points.bin", "wb").write(p._payload)

print(json.dumps({"blocks": len(b._payload), "points": len(p._payload),
                  "blockColor": b.color, "cats": b.categories, "n": int(x.size)}))
`;
let meta;
try {
  const out = execFileSync('python', ['-c', PY], { encoding: 'utf8', cwd: process.cwd() });
  meta = JSON.parse(out.trim().split('\n').pop());
} catch (e) {
  console.log('FAIL: the Python half did not run —', (e.stderr || e.message || '').toString().trim().split('\n').slice(-3).join('\n'));
  process.exit(1);
}
console.log(`ok   python packed: ${meta.n} blocks (${meta.blocks} B, color=${meta.blockColor}, cats=${meta.cats.join('/')}) + a 40k cloud (${meta.points} B)`);

// ── 2. serve the repo + the payloads ──
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.bin': 'application/octet-stream' };
const server = http.createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.startsWith('/tmp/') ? join(TMP, path.slice(5)) : '.' + path;
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
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

// ── 3. drive the REAL widget module with a stub anywidget model ──
const r = await page.evaluate(async (port) => {
  const mod = await import(`http://127.0.0.1:${port}/ext/condenser/anywidget/gcu_condenser/static/widget.js`);
  const render = mod.default && mod.default.render;
  if (!render) return { err: 'no default.render export' };

  // the anywidget model surface the widget actually uses
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
  const grab = async (name) => {
    const buf = await (await fetch(`http://127.0.0.1:${port}/tmp/${name}`)).arrayBuffer();
    return new DataView(buf);                              // anywidget hands Bytes traits over as a DataView
  };
  const settle = () => new Promise((res) => setTimeout(res, 700));
  const lit = () => {                                      // non-background pixels on the widget canvas
    const cv = document.querySelector('#host canvas');
    const gl = cv.getContext('webgl2');
    const px = new Uint8Array(cv.width * cv.height * 4);
    gl.readPixels(0, 0, cv.width, cv.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let n = 0, sum = 0;
    for (let i = 0; i < px.length; i += 4) { if (px[i] > 30 || px[i + 1] > 30 || px[i + 2] > 30) n++; sum += px[i] + px[i + 1] * 2 + px[i + 2] * 3; }
    return { n, sig: sum };
  };

  const out = {};
  const el = document.querySelector('#host');
  const model = makeModel({
    _payload: await grab('blocks.bin'), _fit: 0, color: 'value', ramp: 'viridis', clip: [],
    point_size: 2.5, as_points: false, block_edges: false, edl: true, edl_strength: 1,
    threshold: [], filter_mode: 'isolate', opacity: 1.0,
    background: '#121212', height: 460, budget: 3000000, selected: -1,
  });
  const dispose = render({ model, el });
  await settle();

  const a = lit();
  out.blocksLit = a.n;
  out.hud = (el.querySelector('div') || {}).textContent;

  model.set('ramp', 'magma'); await settle();
  const b = lit();
  out.rampChanged = b.sig !== a.sig && b.n > 0;

  model.set('color', 'category'); await settle();
  const c = lit();
  out.colorChanged = c.sig !== b.sig && c.n > 0;

  model.set('block_edges', true); await settle();
  out.edgesOk = lit().n > 0;
  model.set('block_edges', false); await settle();

  // threshold: the cutoff that makes an ore body visible inside a solid model.
  // A tight window must show STRICTLY FEWER lit pixels than the whole block,
  // and clearing it must restore them — the mask is rebuilt browser-side, so
  // this also proves no re-send is needed.
  model.set('color', 'value'); await settle();
  const full = lit().n;
  model.set('threshold', [30, 999]); await settle();
  out.thrLit = lit().n;
  out.thrShrinks = out.thrLit > 0 && out.thrLit < full * 0.75;
  model.set('threshold', []); await settle();
  out.thrRestores = Math.abs(lit().n - full) < full * 0.05;

  model.set('opacity', 0.3); await settle();
  out.opacityChanges = lit().n < full;                     // screen-door drops pixels
  model.set('opacity', 1.0); await settle();

  // pick: click the middle of the model → a record index comes back
  const cv = document.querySelector('#host canvas');
  const rect = cv.getBoundingClientRect();
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
  cv.dispatchEvent(new PointerEvent('pointerdown', { clientX: cx, clientY: cy, bubbles: true }));
  cv.dispatchEvent(new PointerEvent('pointerup', { clientX: cx, clientY: cy, bubbles: true }));
  await settle();
  out.selected = model._get('selected');

  // teardown must be clean, and a second widget must be constructible after it
  let disposeErr = null;
  try { dispose(); } catch (e) { disposeErr = e.message; }
  out.disposeErr = disposeErr;
  out.emptied = el.children.length === 0;

  // ── the point cloud, in a fresh instance ──
  const model2 = makeModel({
    _payload: await grab('points.bin'), _fit: 0, color: 'value', ramp: 'turbo', clip: [],
    point_size: 3, as_points: false, block_edges: false, edl: true, edl_strength: 1,
    threshold: [], filter_mode: 'isolate', opacity: 1.0,
    background: '#121212', height: 460, budget: 3000000, selected: -1,
  });
  const dispose2 = render({ model: model2, el });
  await settle(); await settle();
  out.pointsLit = lit().n;
  out.pointsHud = (el.querySelector('div') || {}).textContent;
  dispose2();

  // a malformed payload must degrade, not explode
  const model3 = makeModel({ _payload: new DataView(new ArrayBuffer(4)), _fit: 0, color: 'z', ramp: 'viridis', clip: [], height: 200, budget: 1e6, selected: -1, point_size: 2, edl: true, edl_strength: 1, background: '#121212', threshold: [], filter_mode: 'isolate', opacity: 1.0 });
  let badErr = null;
  try { const d3 = render({ model: model3, el }); await settle(); out.badHud = (el.querySelector('div') || {}).textContent; d3(); }
  catch (e) { badErr = e.message; }
  out.badErr = badErr;
  return out;
}, PORT);

if (r.err) { console.log('FAIL:', r.err); process.exit(1); }

chk(`block model renders through the widget (${r.blocksLit.toLocaleString()} lit px, hud "${r.hud}")`,
  r.blocksLit > 5000 && /576/.test(r.hud || ''));
chk('ramp trait repaints (viridis → magma)', r.rampChanged);
chk('color trait repaints (value → category)', r.colorChanged);
chk('block_edges renders', r.edgesOk);
chk(`threshold carves the grade shell out of a solid model (${r.thrLit.toLocaleString()} lit px)`, r.thrShrinks);
chk('clearing threshold restores the full model (no re-send)', r.thrRestores);
chk('opacity dithers the model see-through', r.opacityChanges);
chk(`click → selected is a real record index (${r.selected})`, Number.isInteger(r.selected) && r.selected >= 0 && r.selected < 576);
chk('dispose is clean and empties the host', !r.disposeErr && r.emptied, r.disposeErr || '');
chk(`point cloud renders in a fresh instance (${r.pointsLit.toLocaleString()} lit px, hud "${r.pointsHud}")`,
  r.pointsLit > 5000 && /40,?000/.test(r.pointsHud || ''));
chk(`a malformed payload degrades quietly (hud "${r.badHud}")`, !r.badErr && /no data/.test(r.badHud || ''), r.badErr || '');

console.log(fails ? `\nCONDENSER WIDGET: ${fails} FAILURES` : '\nCONDENSER WIDGET: PASS');
await browser.close();
server.close();
process.exit(fails ? 1 : 0);
