// moncad overlay — the Canvas2D layer stacked over the WebGL2 canvas (SPEC §6).
//
// Text, glyphs, the crosshair, snap markers, the rubber-band — the sparse, dynamic,
// 2D-friendly things live here. Dragging the crosshair redraws only this light layer;
// the heavy geometry sits still on the GPU. v0: the crosshair. Snap glyphs and the
// rubber-band slot in here as they arrive.

export class Overlay {
  constructor(ctx) {
    this.ctx = ctx;          // CanvasRenderingContext2D (device-pixel scaled by the caller)
    this.cursor = null;      // [screenX, screenY] in device px, or null when off-canvas
    this.snap = null;        // { screen:[x,y], type } or null
    this.rubber = null;      // { lines:[[a,b],…], points:[p,…] } in SCREEN px, or null
    this.selBox = null;      // [[x0,y0],[x1,y1]] in SCREEN px (window-select drag), or null
    this.highlight = null;   // { warn, ok, dim } each [[a,b],…] SCREEN px — the pick-tool preview
    this.theme = { crosshair: 'rgba(140,140,140,0.45)', cross: 'rgba(200,120,80,0.9)', snap: 'rgba(120,180,230,0.95)', rubber: 'rgba(216,120,59,0.95)', sel: 'rgba(120,180,230,0.9)' };
  }

  setCursor(screenPt) { this.cursor = screenPt; }
  setSnap(screen, type) { this.snap = screen ? { screen, type } : null; }
  // Provisional draw geometry, already projected to screen px by the caller (the app
  // owns the tool's local coords + the viewport, so it does the projection).
  setRubber(screenGeom) { this.rubber = screenGeom; }
  setSelectBox(box) { this.selBox = box; }
  // Hover preview for the click-on-geometry tools: warn (red) = will be removed, ok (green)
  // = will be added, dim (grey) = the candidate under the cursor.
  setHighlight(geom) { this.highlight = geom; }

  draw(view) {
    const ctx = this.ctx, w = view.width, h = view.height;
    ctx.clearRect(0, 0, w, h);
    if (this.highlight) this._highlight(view);
    if (this.rubber) this._rubber(view);
    if (this.selBox) this._selectBox(view);
    if (this.cursor) this._crosshair(view);
    if (this.snap) this._snapGlyph(view);
  }

  // What a Trim/Extend/Offset/Fillet click would do, shown before you commit.
  _highlight(view) {
    const ctx = this.ctx, g = this.highlight, lw = Math.max(2, 2.2 * view.dpr);
    const stroke = (segs, color) => {
      if (!segs || !segs.length) return;
      ctx.lineWidth = lw; ctx.strokeStyle = color; ctx.beginPath();
      for (const [a, b] of segs) { ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
      ctx.stroke();
    };
    stroke(g.dim, 'rgba(150,150,160,0.55)');     // candidate (fillet/chamfer line under cursor)
    stroke(g.pre, 'rgba(120,180,235,0.9)');      // blue = what a click would select (idle hover)
    stroke(g.ok, 'rgba(120,200,120,0.95)');      // green = will be added (extend / offset copy)
    stroke(g.warn, 'rgba(232,90,78,0.95)');      // red = will be removed (trim)
  }

  // The window-select drag rectangle: a faint info-accent fill + dashed border.
  _selectBox(view) {
    const ctx = this.ctx, [a, b] = this.selBox;
    const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]), w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
    ctx.fillStyle = 'rgba(120,180,230,0.08)';
    ctx.fillRect(x, y, w, h);
    ctx.lineWidth = Math.max(1, view.dpr);
    ctx.strokeStyle = this.theme.sel;
    ctx.setLineDash([4 * view.dpr, 3 * view.dpr]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
  }

  // The rubber-band: dashed segments in the action accent + small handles at placed
  // vertices. Redrawn every cursor move — cheap, and the heavy geometry sits still on
  // the GPU underneath (SPEC §6, the better-than-Canvas2D interaction win).
  _rubber(view) {
    const ctx = this.ctx, g = this.rubber, s = 3 * view.dpr;
    ctx.lineWidth = Math.max(1.5, 1.5 * view.dpr);
    ctx.strokeStyle = this.theme.rubber;
    ctx.setLineDash([6 * view.dpr, 4 * view.dpr]);
    ctx.beginPath();
    for (const [a, b] of g.lines || []) { ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
    ctx.stroke();
    ctx.setLineDash([]);
    for (const p of g.points || []) ctx.strokeRect(p[0] - s, p[1] - s, 2 * s, 2 * s);
  }

  // The snap marker, by type — drawn at the snapped point (which may differ from the
  // cursor), in the info accent. □ endpoint · △ midpoint · ○ centre · ✕ node.
  _snapGlyph(view) {
    const ctx = this.ctx, [x, y] = this.snap.screen, t = this.snap.type, s = 6 * view.dpr;
    ctx.lineWidth = Math.max(1.5, 1.5 * view.dpr);
    ctx.strokeStyle = this.theme.snap;
    ctx.beginPath();
    if (t === 'mid') { ctx.moveTo(x, y - s); ctx.lineTo(x + s, y + s); ctx.lineTo(x - s, y + s); ctx.closePath(); }
    else if (t === 'center') ctx.arc(x, y, s, 0, Math.PI * 2);
    else if (t === 'node') { ctx.moveTo(x - s, y - s); ctx.lineTo(x + s, y + s); ctx.moveTo(x + s, y - s); ctx.lineTo(x - s, y + s); }
    else if (t === 'grid') { ctx.moveTo(x - s, y); ctx.lineTo(x + s, y); ctx.moveTo(x, y - s); ctx.lineTo(x, y + s); }   // grid = +
    else ctx.rect(x - s, y - s, 2 * s, 2 * s);   // 'end' (default)
    ctx.stroke();
  }

  // Full-extent crosshair through the cursor + a small accent tick at the exact point.
  _crosshair(view) {
    const ctx = this.ctx, [x, y] = this.cursor;
    ctx.lineWidth = Math.max(1, view.dpr);
    ctx.strokeStyle = this.theme.crosshair;
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5); ctx.lineTo(view.width, y + 0.5);
    ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, view.height);
    ctx.stroke();
    const t = 6 * view.dpr;
    ctx.strokeStyle = this.theme.cross;
    ctx.beginPath();
    ctx.moveTo(x - t, y); ctx.lineTo(x + t, y);
    ctx.moveTo(x, y - t); ctx.lineTo(x, y + t);
    ctx.stroke();
  }
}
