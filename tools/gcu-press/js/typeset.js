// Bridge: editor text -> engine -> canvases

function typeset() {
  const text = GP.source;
  if (!text.trim()) {
    clearPages();
    return;
  }

  const { family, size } = GP.font;
  const metrics = createMetrics(family, size);
  const h1Metrics = createMetrics(family, size * 2, 'bold');
  const h2Metrics = createMetrics(family, size * 1.5, 'bold');
  const h3Metrics = createMetrics(family, size * 1.2, 'bold');
  const headingMetrics = [h1Metrics, h2Metrics, h3Metrics];

  const parsed = parseToItems(text, metrics, headingMetrics);
  const pages = layoutPages(parsed, GP.pageSpec, metrics, headingMetrics);
  const canvases = renderPages(pages, GP.pageSpec, metrics.font);

  GP.pages = canvases;
  displayPages(canvases);
}

function scheduleTypeset() {
  if (GP.typesetTimer) clearTimeout(GP.typesetTimer);
  GP.typesetTimer = setTimeout(typeset, 300);
}
