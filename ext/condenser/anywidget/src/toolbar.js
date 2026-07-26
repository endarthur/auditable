// @gcu/condenser anywidget — the in-view toolbar.
//
// Scope rule: a notebook widget must not become micro. What earns a button is
// what is AWKWARD OR IMPOSSIBLE from Python — mouse-driven geometry (the knife),
// things you need while looking (the pick readout, the legend), and the camera
// moves you would otherwise fiddle with by hand. Everything a line of Python
// does well (ramps, clips, thresholds) stays in Python.
//
// Nothing here is decorative: no external CSS, no icon font, inline SVG only,
// and every control round-trips through the model traits so the notebook sees
// what you did — toggling a layer here really does set `w["topo"].visible`.

const ICON = {
  fit: 'M2 5V2h3M12 5V2H9M2 9v3h3M12 9v3H9',
  view: 'M1 7s2.2-3.9 6-3.9S13 7 13 7s-2.2 3.9-6 3.9S1 7 1 7z M7 8.7a1.7 1.7 0 1 0 0-3.4 1.7 1.7 0 0 0 0 3.4z',
  ortho: 'M2.5 3.5h9v7h-9z M2.5 3.5 5 1.5h9v7l-2.5 2',
  pick: 'M3 1.5 11 7l-3.4.7L9 11.8l-1.6.7-1.4-4L3 11z',
  knife: 'M1.5 12.5 8 6l4.5-4.5L11 7l-6 6z M8 6l3 3',
  layers: 'M7 1.5 12.5 4.6 7 7.7 1.5 4.6z M1.5 7.4 7 10.5l5.5-3.1M1.5 10.2 7 13.3l5.5-3.1',
  camera: 'M1.5 4.5h2.5l1-1.5h4l1 1.5h2.5v7h-11z M7 9.8a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z',
  close: 'M3.5 3.5l7 7M10.5 3.5l-7 7',
};

const svg = (d) => `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor"
  stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;

const CSS = `
.cdt { position:absolute; left:6px; top:6px; display:flex; gap:2px; z-index:4;
  background:rgba(22,22,22,.86); border:1px solid #333; border-radius:4px; padding:2px;
  font:11px ui-monospace,Menlo,Consolas,monospace; backdrop-filter:blur(3px); }
.cdt button { all:unset; box-sizing:border-box; width:24px; height:22px; display:grid; place-items:center;
  color:#b9b9b9; border-radius:3px; cursor:pointer; }
.cdt button:hover { background:#2e2e2e; color:#e8e8e8; }
.cdt button[aria-pressed="true"] { background:#c8781f; color:#141414; }
.cdt .sep { width:1px; background:#3a3a3a; margin:2px 1px; }
.cdpop { position:absolute; left:6px; top:34px; z-index:5; min-width:172px; max-height:220px; overflow:auto;
  background:rgba(22,22,22,.96); border:1px solid #3a3a3a; border-radius:4px; padding:5px 6px;
  font:11px ui-monospace,Menlo,Consolas,monospace; color:#cfcfcf; backdrop-filter:blur(3px); }
.cdpop h4 { margin:0 0 5px; font-size:10px; letter-spacing:.08em; text-transform:uppercase; color:#8a8a8a; font-weight:600; }
.cdpop label { display:flex; align-items:center; gap:6px; padding:2px 0; cursor:pointer; }
.cdpop label:hover { color:#fff; }
.cdpop input[type=checkbox] { accent-color:#c8781f; margin:0; }
.cdpop .k { color:#7d7d7d; }
.cdpop .row { display:flex; justify-content:space-between; gap:8px; padding:1px 0; }
.cdpop button.opt { all:unset; display:block; padding:3px 5px; border-radius:3px; cursor:pointer; color:#cfcfcf; }
.cdpop button.opt:hover { background:#2e2e2e; color:#fff; }
.cdsec { position:absolute; left:6px; bottom:26px; z-index:4; display:flex; align-items:center; gap:6px;
  background:rgba(22,22,22,.88); border:1px solid #333; border-radius:4px; padding:3px 7px;
  font:11px ui-monospace,Menlo,Consolas,monospace; color:#c4c4c4; backdrop-filter:blur(3px); }
.cdsec input[type=range] { width:130px; accent-color:#c8781f; }
.cdsec button { all:unset; cursor:pointer; color:#8a8a8a; padding:0 2px; }
.cdsec button:hover { color:#e0705a; }
.cdpick { position:absolute; right:6px; top:6px; z-index:4; max-width:210px;
  background:rgba(22,22,22,.9); border:1px solid #333; border-radius:4px; padding:5px 7px;
  font:11px ui-monospace,Menlo,Consolas,monospace; color:#d2d2d2; backdrop-filter:blur(3px); }
.cdpick .t { color:#c8781f; margin-bottom:2px; }
.cdpick .row { display:flex; justify-content:space-between; gap:10px; }
.cdpick .k { color:#7d7d7d; }
.cdleg { position:absolute; right:6px; bottom:6px; z-index:3; display:flex; align-items:center; gap:5px;
  font:10px ui-monospace,Menlo,Consolas,monospace; color:#a8a8a8; text-shadow:0 1px 2px #000; }
.cdleg canvas { display:block; width:96px; height:8px; border:1px solid #444; border-radius:1px; }
.cdknife { position:absolute; inset:0; z-index:2; pointer-events:none; }
`;

const fmt = (v) => {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  return a >= 1e5 || (a < 0.01 && a > 0) ? v.toExponential(2) : String(Math.round(v * 100) / 100);
};

/**
 * createToolbar(host, api) — api is the widget's own surface:
 *   layers()      → [{ name, kind, visible, hasValue, range, ramp }]
 *   setStyle(i,p) → patch a layer's style (round-trips to Python)
 *   fit(), setView(name), toggleOrtho() → bool, isOrtho()
 *   getSection() / setSection(s) / sectionRange() → [lo, hi] along the normal
 *   knife(x1,y1,x2,y2) → set a section from a screen-space drag
 *   snapshot()
 *   onToolChange(tool)
 */
export function createToolbar(host, api) {
  const style = document.createElement('style');
  style.textContent = CSS;
  host.appendChild(style);

  const bar = document.createElement('div');
  bar.className = 'cdt';
  host.appendChild(bar);

  let pop = null, tool = 'orbit';
  const closePop = () => { if (pop) { pop.remove(); pop = null; } };
  const mkPop = () => { closePop(); pop = document.createElement('div'); pop.className = 'cdpop'; host.appendChild(pop); return pop; };

  const btn = (icon, title, onClick, toggles) => {
    const b = document.createElement('button');
    b.innerHTML = svg(ICON[icon]);
    b.title = title;
    if (toggles) b.setAttribute('aria-pressed', 'false');
    b.onclick = (e) => { e.stopPropagation(); onClick(b); };
    bar.appendChild(b);
    return b;
  };
  const sep = () => { const s = document.createElement('div'); s.className = 'sep'; bar.appendChild(s); };

  // ── camera ──
  btn('fit', 'Fit the view to the data', () => { closePop(); api.fit(); });

  const viewBtn = btn('view', 'Standard views', () => {
    if (pop && pop.dataset.k === 'view') return closePop();
    const p = mkPop(); p.dataset.k = 'view';
    p.innerHTML = '<h4>view</h4>';
    for (const [k, label] of [['plan', 'Plan (down)'], ['north', 'Looking north'], ['east', 'Looking east'], ['iso', 'Isometric']]) {
      const b = document.createElement('button');
      b.className = 'opt'; b.textContent = label;
      b.onclick = () => { api.setView(k); closePop(); };
      p.appendChild(b);
    }
    const r = viewBtn.getBoundingClientRect(), h = host.getBoundingClientRect();
    p.style.left = `${r.left - h.left}px`;
  });

  const orthoBtn = btn('ortho', 'Parallel projection (for sections)', (b) => {
    closePop();
    const on = api.toggleOrtho();
    b.setAttribute('aria-pressed', String(on));
  }, true);

  sep();

  // ── tools ──
  const setTool = (t) => {
    tool = tool === t ? 'orbit' : t;
    pickBtn.setAttribute('aria-pressed', String(tool === 'pick'));
    knifeBtn.setAttribute('aria-pressed', String(tool === 'knife'));
    api.onToolChange(tool);
  };
  const pickBtn = btn('pick', 'Pick: click an element to inspect it', () => { closePop(); setTool('pick'); }, true);
  const knifeBtn = btn('knife', 'Knife: drag a line to cut a section along it', () => { closePop(); setTool('knife'); }, true);
  pickBtn.setAttribute('aria-pressed', 'true');            // picking is the default posture
  tool = 'pick';

  sep();

  // ── layers ──
  const layersBtn = btn('layers', 'Layers', () => {
    if (pop && pop.dataset.k === 'layers') return closePop();
    const p = mkPop(); p.dataset.k = 'layers';
    p.innerHTML = '<h4>layers</h4>';
    api.layers().forEach((L, i) => {
      const lab = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = L.visible !== false;
      cb.onchange = () => api.setStyle(i, { visible: cb.checked });
      const nm = document.createElement('span');
      nm.textContent = L.name;
      const kd = document.createElement('span');
      kd.className = 'k'; kd.style.marginLeft = 'auto';
      kd.textContent = L.kind === 'drillholes' ? 'holes' : L.kind;
      lab.append(cb, nm, kd);
      p.appendChild(lab);
    });
    const r = layersBtn.getBoundingClientRect(), h = host.getBoundingClientRect();
    p.style.left = `${Math.max(4, r.left - h.left - 60)}px`;
  });

  btn('camera', 'Save a PNG of the view', () => { closePop(); api.snapshot(); });

  host.addEventListener('pointerdown', (e) => { if (pop && !pop.contains(e.target) && !bar.contains(e.target)) closePop(); }, true);

  // ── the section bar (only while a section exists) ──
  const secBar = document.createElement('div');
  secBar.className = 'cdsec';
  secBar.style.display = 'none';
  const secLabel = document.createElement('span');
  const slider = document.createElement('input');
  slider.type = 'range'; slider.min = '0'; slider.max = '1000'; slider.value = '500';
  const thick = document.createElement('input');
  thick.type = 'number'; thick.min = '0.1'; thick.step = '1';
  thick.style.cssText = 'width:48px;background:#232323;color:#ccc;border:1px solid #3a3a3a;border-radius:2px;font:inherit;padding:1px 3px;';
  const clearBtn = document.createElement('button');
  clearBtn.innerHTML = svg(ICON.close); clearBtn.title = 'Clear the section';
  secBar.append(secLabel, slider, thick, clearBtn);
  host.appendChild(secBar);

  let range = [0, 1];
  slider.oninput = () => {
    const s = api.getSection(); if (!s) return;
    const t = +slider.value / 1000;
    api.setSection({ ...s, position: range[0] + t * (range[1] - range[0]) });
  };
  thick.onchange = () => {
    const s = api.getSection(); if (!s) return;
    api.setSection({ ...s, thickness: Math.max(0.1, +thick.value || 10) });
  };
  clearBtn.onclick = () => api.setSection(null);

  // ── the pick readout ──
  const pickBox = document.createElement('div');
  pickBox.className = 'cdpick';
  pickBox.style.display = 'none';
  host.appendChild(pickBox);

  // ── the colour legend ──
  const leg = document.createElement('div');
  leg.className = 'cdleg';
  leg.style.display = 'none';
  const legLo = document.createElement('span'), legHi = document.createElement('span');
  const legCv = document.createElement('canvas'); legCv.width = 96; legCv.height = 8;
  leg.append(legLo, legCv, legHi);
  host.appendChild(leg);

  // ── the knife rubber band ──
  const band = document.createElement('svg');
  const bandEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  bandEl.setAttribute('class', 'cdknife');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('stroke', '#c8781f'); line.setAttribute('stroke-width', '1.5'); line.setAttribute('stroke-dasharray', '5 3');
  bandEl.appendChild(line);
  bandEl.style.display = 'none';
  host.appendChild(bandEl);

  return {
    get tool() { return tool; },
    setBand(a, b) {
      if (!a) { bandEl.style.display = 'none'; return; }
      line.setAttribute('x1', a[0]); line.setAttribute('y1', a[1]);
      line.setAttribute('x2', b[0]); line.setAttribute('y2', b[1]);
      bandEl.style.display = '';
    },
    clearTool() { tool = 'pick'; pickBtn.setAttribute('aria-pressed', 'true'); knifeBtn.setAttribute('aria-pressed', 'false'); api.onToolChange(tool); },
    // pick info → the readout (null hides it)
    showPick(info) {
      if (!info) { pickBox.style.display = 'none'; return; }
      const rows = info.rows.map(([k, v]) => `<div class="row"><span class="k">${k}</span><span>${v}</span></div>`).join('');
      pickBox.innerHTML = `<div class="t">${info.title}</div>${rows}`;
      pickBox.style.display = '';
    },
    // section state → the scrub bar
    syncSection(sec, extent) {
      if (!sec) { secBar.style.display = 'none'; return; }
      range = extent || [0, 1];
      secBar.style.display = '';
      const axis = sec.axis ? sec.axis.toUpperCase() : 'N';
      secLabel.textContent = `${axis} ${fmt(sec.position)}`;
      const span = range[1] - range[0] || 1;
      slider.value = String(Math.round(((sec.position - range[0]) / span) * 1000));
      if (document.activeElement !== thick) thick.value = String(sec.thickness);
    },
    // the ramp + range of the first value-coloured visible layer
    syncLegend(info) {
      if (!info) { leg.style.display = 'none'; return; }
      leg.style.display = '';
      legLo.textContent = fmt(info.range[0]);
      legHi.textContent = fmt(info.range[1]);
      const g = legCv.getContext('2d');
      const img = g.createImageData(96, 1);
      for (let i = 0; i < 96; i++) {
        const t = Math.min(255, Math.round((i / 95) * 255));
        img.data[i * 4] = info.pixels[t * 4];
        img.data[i * 4 + 1] = info.pixels[t * 4 + 1];
        img.data[i * 4 + 2] = info.pixels[t * 4 + 2];
        img.data[i * 4 + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      g.drawImage(legCv, 0, 0, 96, 1, 0, 0, 96, 8);
    },
    syncOrtho(on) { orthoBtn.setAttribute('aria-pressed', String(!!on)); },
    destroy() { closePop(); [style, bar, secBar, pickBox, leg, bandEl].forEach((n) => n.remove()); },
  };
}
