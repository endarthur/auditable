// Page canvas management, scroll, zoom

function displayPages(canvases) {
  const container = $('#gp-pages');
  if (!container) return;
  container.innerHTML = '';

  for (const canvas of canvases) {
    const wrapper = document.createElement('div');
    wrapper.className = 'gp-page';
    wrapper.style.transform = `scale(${GP.zoom})`;
    wrapper.style.transformOrigin = 'top center';
    wrapper.appendChild(canvas);
    container.appendChild(wrapper);
  }

  updatePageCount();
}

function clearPages() {
  const container = $('#gp-pages');
  if (container) container.innerHTML = '';
  GP.pages = [];
  updatePageCount();
}

function updatePageCount() {
  const el = $('#gp-status-pages');
  if (el) el.textContent = GP.pages.length + (GP.pages.length === 1 ? ' page' : ' pages');
}

function setZoom(z) {
  GP.zoom = Math.max(0.25, Math.min(3, z));
  const pages = $$('.gp-page');
  for (const p of pages) {
    p.style.transform = `scale(${GP.zoom})`;
  }
  const pct = $('#gp-zoom-pct');
  if (pct) pct.textContent = Math.round(GP.zoom * 100) + '%';
  const slider = $('#gp-zoom-slider');
  if (slider) slider.value = GP.zoom * 100;
}

function initZoom() {
  const slider = $('#gp-zoom-slider');
  if (slider) {
    slider.addEventListener('input', () => setZoom(slider.value / 100));
  }
  const zoomIn = $('#gp-zoom-in');
  if (zoomIn) zoomIn.addEventListener('click', () => setZoom(GP.zoom + 0.1));
  const zoomOut = $('#gp-zoom-out');
  if (zoomOut) zoomOut.addEventListener('click', () => setZoom(GP.zoom - 0.1));
  const pct = $('#gp-zoom-pct');
  if (pct) pct.addEventListener('click', () => setZoom(1));
}
