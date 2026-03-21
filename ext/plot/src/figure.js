// Figure — canvas management, subplot grid, DPI handling

import { Axes } from './axes.js';

export class Figure {
  constructor(nrows, ncols, opts) {
    this.nrows = nrows || 1;
    this.ncols = ncols || 1;
    const o = opts || {};
    const figsize = o.figsize || [400, 300];
    this.width = figsize[0];
    this.height = figsize[1];
    this.facecolor = o.facecolor || 'transparent';
    this._suptitle = null;

    // create axes grid
    this.axes = [];
    for (let i = 0; i < this.nrows * this.ncols; i++) {
      this.axes.push(new Axes());
    }
  }

  suptitle(text, opts) {
    this._suptitle = { text, opts };
    return this;
  }

  show() {
    const dpr = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;
    const canvas = (typeof document !== 'undefined') ? document.createElement('canvas') : null;
    if (!canvas) return null;

    canvas.width = this.width * dpr;
    canvas.height = this.height * dpr;
    canvas.style.width = this.width + 'px';
    canvas.style.height = this.height + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // background
    if (this.facecolor !== 'transparent') {
      ctx.fillStyle = this.facecolor;
      ctx.fillRect(0, 0, this.width, this.height);
    }

    // suptitle space
    const supH = this._suptitle ? 24 : 0;

    if (this._suptitle) {
      ctx.fillStyle = '#ccc';
      ctx.font = '14px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(this._suptitle.text, this.width / 2, 4);
    }

    // subplot layout
    const gapX = 10;
    const gapY = 10;
    const cellW = (this.width - gapX * (this.ncols - 1)) / this.ncols;
    const cellH = (this.height - supH - gapY * (this.nrows - 1)) / this.nrows;

    for (let r = 0; r < this.nrows; r++) {
      for (let c = 0; c < this.ncols; c++) {
        const idx = r * this.ncols + c;
        const ax = this.axes[idx];
        const rect = {
          x: c * (cellW + gapX),
          y: supH + r * (cellH + gapY),
          w: cellW,
          h: cellH,
        };
        ax._render(ctx, rect);
      }
    }

    return canvas;
  }

  savefig(filename) {
    const canvas = this.show();
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = filename || 'figure.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
  }
}
