// Render typeset pages to canvases

function renderPage(canvas, page, pageSpec, pageNum, totalPages, defaultFont) {
  const { w, h, margin } = pageSpec;
  const dpr = window.devicePixelRatio || 1;

  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // White page background
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);

  // Render lines
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'top';
  for (const line of page) {
    if (line.type !== 'line') continue;

    const font = line.font || defaultFont;
    ctx.font = font;

    for (const item of line.items) {
      if (item.font) ctx.font = item.font;
      else ctx.font = font;
      ctx.fillText(item.text, line.x + item.x, line.y);
    }
  }

  // Page number in footer
  ctx.textBaseline = 'alphabetic';
  ctx.font = '8pt serif';
  ctx.fillStyle = '#666';
  const numText = String(pageNum);
  const numWidth = ctx.measureText(numText).width;
  ctx.fillText(numText, (w - numWidth) / 2, h - margin.b * 0.4);
}

function renderPages(pages, pageSpec, defaultFont) {
  const canvases = [];
  for (let i = 0; i < pages.length; i++) {
    const canvas = document.createElement('canvas');
    renderPage(canvas, pages[i], pageSpec, i + 1, pages.length, defaultFont);
    canvases.push(canvas);
  }
  return canvases;
}

export { renderPage, renderPages };
