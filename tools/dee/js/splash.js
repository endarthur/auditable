// dee tool — splash screen

function showSplash() {
  let overlay = $('#d3-splash');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'd3-splash';
    overlay.className = 'd3-splash';
    document.body.appendChild(overlay);
  }
  overlay.classList.remove('hidden');
  overlay.innerHTML = `
    <div class="d3-splash-inner">
      <h1 class="d3-splash-title">d e e</h1>
      <p class="d3-splash-sub">3D block model viewer</p>
      <div class="d3-splash-actions">
        <button class="d3-btn" id="d3-splash-open">open CSV\u2026</button>
        <button class="d3-btn" id="d3-splash-small">small (4K)</button>
        <button class="d3-btn" id="d3-splash-medium">medium (50K)</button>
        <button class="d3-btn" id="d3-splash-large">large (300K)</button>
        <button class="d3-btn d3-btn-dim" id="d3-splash-stress">stress (2M)</button>
      </div>
    </div>
  `;

  $('#d3-splash-open').onclick = () => { closeSplash(); openBlockCSV(); };
  $('#d3-splash-small').onclick = () => { closeSplash(); generateAndLoad('small'); };
  $('#d3-splash-medium').onclick = () => { closeSplash(); generateAndLoad('medium'); };
  $('#d3-splash-large').onclick = () => { closeSplash(); generateAndLoad('large'); };
  $('#d3-splash-stress').onclick = () => { closeSplash(); generateAndLoad('stress'); };
}

function closeSplash() {
  const overlay = $('#d3-splash');
  if (overlay) overlay.classList.add('hidden');
}
