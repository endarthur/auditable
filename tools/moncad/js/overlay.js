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
    this.theme = { crosshair: 'rgba(140,140,140,0.45)', cross: 'rgba(200,120,80,0.9)', snap: 'rgba(120,180,230,0.95)' };
  }

  setCursor(screenPt) { this.cursor = screenPt; }
  setSnap(screen, type) { this.snap = screen ? { screen, type } : null; }

  draw(view) {
    const ctx = this.ctx, w = view.width, h = view.height;
    ctx.clearRect(0, 0, w, h);
    if (this.cursor) this._crosshair(view);
    if (this.snap) this._snapGlyph(view);
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
