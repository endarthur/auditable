// @gcu/qr — QR code generation. The encoder is the vendored, canonical Arase
// `qrcode-generator` (MIT, byte mode + proper UTF-8); this wraps it with a
// matrix accessor and a crisp, theme-aware SVG renderer in the GCU aesthetic.
//
// We only *encode* — scanning is the phone's native camera. Used by the
// in-Works Share action and capsule share-links (QR → install / open).
//
// After concat (build.js), `qrcode` (the Arase factory, UTF-8-patched) is a
// top-level binding in scope; these exports are the public API.
//
// ecc: 'L' | 'M' | 'Q' | 'H'  (error-correction level; higher = more robust to
// print damage, less capacity). typeNumber 0 = auto-fit the smallest version.

// text → boolean[][] module grid (true = dark).
export function toMatrix(text, opts = {}) {
  const ecc = opts.ecc || 'M';
  let qr;
  // Arase supports typeNumber 0 = auto; fall back to a manual fit just in case.
  try { qr = qrcode(opts.typeNumber || 0, ecc); qr.addData(String(text)); qr.make(); }
  catch (e) {
    qr = null;
    for (let v = 1; v <= 40 && !qr; v++) {
      try { const q = qrcode(v, ecc); q.addData(String(text)); q.make(); qr = q; } catch { /* too small — grow */ }
    }
    if (!qr) throw new Error('qr: payload too large for a QR code (' + String(text).length + ' chars)');
  }
  const n = qr.getModuleCount();
  const m = new Array(n);
  for (let r = 0; r < n; r++) { const row = new Array(n); for (let c = 0; c < n; c++) row[c] = qr.isDark(r, c); m[r] = row; }
  return m;
}

// text → SVG string. One <path> for all dark modules (compact + crisp). margin
// is the quiet zone in modules (spec minimum is 4; 4 is the default).
export function toSVG(text, opts = {}) {
  const margin = opts.margin == null ? 4 : opts.margin;
  const scale = opts.scale || 4;
  const dark = opts.dark || '#15191c';
  const light = opts.light || '#ffffff';
  const m = toMatrix(text, opts);
  const n = m.length;
  const dim = (n + margin * 2) * scale;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (m[r][c]) { const x = (c + margin) * scale, y = (r + margin) * scale; d += 'M' + x + ' ' + y + 'h' + scale + 'v' + scale + 'h-' + scale + 'z'; }
    }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + ' ' + dim + '" width="' + dim + '" height="' + dim
    + '" shape-rendering="crispEdges" role="img"><rect width="' + dim + '" height="' + dim + '" fill="' + light
    + '"/><path d="' + d + '" fill="' + dark + '"/></svg>';
}

// text → a data: URL of the SVG (handy for <img src> / download).
export function toDataURL(text, opts = {}) {
  return 'data:image/svg+xml,' + encodeURIComponent(toSVG(text, opts));
}
