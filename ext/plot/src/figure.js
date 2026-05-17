// Figure — canvas management, subplot grid, DPI handling

import { Axes } from './axes.js';

export class Figure {
  constructor(nrows, ncols, opts) {
    this.nrows = nrows || 1;
    this.ncols = ncols || 1;
    const o = opts || {};
    // matplotlib's figsize is in INCHES; the canvas pixel size is
    // figsize * dpi. Default dpi 100. Notebooks like Pyrcz's pass
    // figsize=(7, 7) expecting a 700×700 canvas — without this scale
    // we'd produce a 7×7 px (effectively invisible) canvas.
    //
    // Heuristic: if both dims are ≤ 50, assume inches and scale by
    // dpi. If either is > 50, assume already-pixels (back-compat with
    // JS-side callers that pass pixel values directly).
    const rawSize = o.figsize || [4, 3];
    const dpi = o.dpi || 100;
    const inchesShape = rawSize[0] <= 50 && rawSize[1] <= 50;
    this.width = inchesShape ? rawSize[0] * dpi : rawSize[0];
    this.height = inchesShape ? rawSize[1] * dpi : rawSize[1];
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

  // matplotlib's Figure.subplots_adjust(left, right, top, bottom,
  // wspace, hspace) — adjusts margins between subplots. We don't
  // currently honor these (our subplot layout uses fixed gaps); accept
  // and discard so notebooks that call `fig.subplots_adjust(wspace=0.7)`
  // proceed instead of erroring with no-attribute.
  subplots_adjust(_opts) { return this; }
  tight_layout(_opts) { return this; }

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
