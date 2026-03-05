// SpxLayer class and layer panel UI

export class SpxLayer {
  constructor(olLayer, opts = {}) {
    this.ol = olLayer;
    this.name = opts.name || 'Layer';
    this.type = opts.type || 'unknown';
    this._bounds = opts.bounds || null;
    this.data = opts.data || null;
    this._map = opts.map || null;
  }

  get visible() { return this.ol.getVisible(); }
  set visible(v) { this.ol.setVisible(v); }

  get bounds() {
    if (this._bounds) return this._bounds;
    const src = this.ol.getSource();
    if (src && typeof src.getExtent === 'function') {
      const ext = src.getExtent();
      if (ext && isFinite(ext[0])) {
        const [w, s] = ol.proj.toLonLat([ext[0], ext[1]]);
        const [e, n] = ol.proj.toLonLat([ext[2], ext[3]]);
        return [w, s, e, n];
      }
    }
    return null;
  }

  show() { this.ol.setVisible(true); }
  hide() { this.ol.setVisible(false); }

  remove() {
    if (this._map) {
      this._map.ol.removeLayer(this.ol);
      const idx = this._map._layers.indexOf(this);
      if (idx >= 0) this._map._layers.splice(idx, 1);
      updateLayerPanel(this._map);
    }
  }

  zoomTo() {
    const b = this.bounds;
    if (b && this._map) {
      this._map.fitBounds(b);
    }
  }
}

// Floating layer panel (top-right corner)
const PANEL_STYLE = `
  position: absolute; top: 10px; right: 10px; z-index: 100;
  background: rgba(30, 30, 30, 0.9); border: 1px solid #555;
  border-radius: 4px; padding: 6px 8px; min-width: 140px;
  font: 12px monospace; color: #ccc; max-height: 300px; overflow-y: auto;
`;
const ITEM_STYLE = `
  padding: 3px 4px; cursor: pointer; display: flex; align-items: center; gap: 6px;
  border-radius: 2px;
`;

export function addLayerPanel(map) {
  if (map._layerPanel) return;
  const panel = document.createElement('div');
  panel.style.cssText = PANEL_STYLE;
  panel.innerHTML = '<div style="color:#c89b3c;margin-bottom:4px;font-weight:bold">Layers</div>';
  map.el.style.position = 'relative';
  map.el.appendChild(panel);
  map._layerPanel = panel;
}

export function updateLayerPanel(map) {
  if (!map._layerPanel) return;
  const panel = map._layerPanel;
  // Keep header, rebuild items
  const header = panel.firstElementChild;
  panel.innerHTML = '';
  panel.appendChild(header);

  for (const lyr of map._layers) {
    const item = document.createElement('div');
    item.style.cssText = ITEM_STYLE;
    item.onmouseover = () => item.style.background = 'rgba(200,155,60,0.15)';
    item.onmouseout = () => item.style.background = 'none';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = lyr.visible;
    cb.onchange = () => { lyr.visible = cb.checked; };

    const label = document.createElement('span');
    label.textContent = lyr.name;
    label.style.flex = '1';
    label.ondblclick = () => lyr.zoomTo();

    item.appendChild(cb);
    item.appendChild(label);
    panel.appendChild(item);
  }
}

export function registerLayer(map, layer) {
  map._layers.push(layer);
  if (!map._layerPanel) addLayerPanel(map);
  updateLayerPanel(map);
}
