// Lazy dependency loading for optional format parsers
// OL + proj4 are vendored (prepended by build.js), always available.

const PAPA_JS = 'https://cdn.jsdelivr.net/npm/papaparse@5/papaparse.min.js';
const SHP_JS = 'https://cdn.jsdelivr.net/npm/shpjs@6/dist/shp.min.js';

function injectScript(url) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${url}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = url;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Failed to load ${url}`));
    document.head.appendChild(s);
  });
}

export async function ensurePapa() {
  if (window.Papa) return;
  await injectScript(PAPA_JS);
}

export async function ensureShp() {
  if (window.shp) return;
  await injectScript(SHP_JS);
}
