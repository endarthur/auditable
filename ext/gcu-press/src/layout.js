// Page layout — vertical flow with page breaks

function layoutPages(parsedItems, pageSpec, metrics, headingMetrics) {
  const { w, h, margin } = pageSpec;
  const textWidth = w - margin.l - margin.r;
  const textHeight = h - margin.t - margin.b;
  const lineHeight = metrics.size * 1.5;
  const parSkip = metrics.size * 0.6;
  const indent = metrics.emWidth * 2;

  const pages = [];
  let currentPage = [];
  let y = 0;
  let isFirstPara = true;

  function newPage() {
    pages.push(currentPage);
    currentPage = [];
    y = 0;
  }

  for (const block of parsedItems) {
    if (block.type === 'pagebreak') {
      newPage();
      isFirstPara = true;
      continue;
    }

    if (block.type === 'heading') {
      const level = block.level;
      const hm = block.metrics || headingMetrics[level - 1] || metrics;
      const hLineHeight = hm.size * 1.5;
      const spaceBefore = level === 1 ? hm.size * 1.5 : hm.size;
      const spaceAfter = hm.size * 0.4;

      // Check if heading + at least one line fits
      if (y + spaceBefore + hLineHeight + lineHeight > textHeight && y > 0) {
        newPage();
      }

      y += spaceBefore;

      // Break heading lines
      const hTextWidth = textWidth;
      const hLines = lineBreak(block.items, hTextWidth);

      for (const line of hLines) {
        if (y + hLineHeight > textHeight) {
          newPage();
        }
        currentPage.push({
          type: 'line',
          items: line.items,
          x: margin.l,
          y: margin.t + y,
          font: hm.font,
          size: hm.size,
        });
        y += hLineHeight;
      }

      y += spaceAfter;
      isFirstPara = true;
      continue;
    }

    if (block.type === 'paragraph') {
      // Paragraph spacing
      if (!isFirstPara) {
        y += parSkip;
      }

      // First line of non-first paragraphs gets indent — tell KP about shorter first line
      const hasIndent = !isFirstPara;
      const lineWidths = hasIndent ? [textWidth - indent, textWidth] : textWidth;
      const lines = lineBreak(block.items, lineWidths);

      for (let i = 0; i < lines.length; i++) {
        if (y + lineHeight > textHeight) {
          newPage();
        }

        const xOffset = i === 0 && hasIndent ? indent : 0;

        currentPage.push({
          type: 'line',
          items: lines[i].items,
          x: margin.l + xOffset,
          y: margin.t + y,
          font: metrics.font,
          size: metrics.size,
        });
        y += lineHeight;
      }

      isFirstPara = false;
    }
  }

  // Push final page
  pages.push(currentPage);

  // Remove empty trailing pages
  while (pages.length > 1 && pages[pages.length - 1].length === 0) {
    pages.pop();
  }

  return pages;
}

export { layoutPages };
