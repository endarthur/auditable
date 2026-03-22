const MIME_TABLE = {
  csv: 'text/csv',
  json: 'application/json',
  geojson: 'application/geo+json',
  txt: 'text/plain',
  html: 'text/html',
  htm: 'text/html',
  js: 'text/javascript',
  mjs: 'text/javascript',
  css: 'text/css',
  md: 'text/markdown',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  wasm: 'application/wasm',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  bin: 'application/octet-stream',
  geotiff: 'image/tiff',
  shp: 'application/x-shapefile',
  dbf: 'application/x-dbf',
  prj: 'text/plain',
  yaml: 'text/yaml',
  yml: 'text/yaml',
};

function normalize(p) {
  if (!p || p === '/') return '/';
  // Collapse multiple slashes, resolve . and ..
  const parts = p.split('/');
  const resolved = [];
  const isAbs = parts[0] === '';
  for (let i = isAbs ? 1 : 0; i < parts.length; i++) {
    const seg = parts[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (isAbs) {
        // Root clamp: /../foo -> /foo
        resolved.pop();
      } else if (resolved.length && resolved[resolved.length - 1] !== '..') {
        resolved.pop();
      } else {
        resolved.push('..');
      }
    } else {
      resolved.push(seg);
    }
  }
  const result = (isAbs ? '/' : '') + resolved.join('/');
  return result || (isAbs ? '/' : '.');
}

function join(...parts) {
  return normalize(parts.filter(Boolean).join('/'));
}

function dirname(p) {
  const n = normalize(p);
  if (n === '/') return '/';
  const last = n.lastIndexOf('/');
  if (last <= 0) return '/';
  return n.slice(0, last);
}

function basename(p) {
  const n = normalize(p);
  if (n === '/') return '/';
  const last = n.lastIndexOf('/');
  return last === -1 ? n : n.slice(last + 1);
}

function extname(p) {
  const b = basename(p);
  const dot = b.lastIndexOf('.');
  if (dot <= 0) return '';
  return b.slice(dot);
}

function isAbsolute(p) {
  return typeof p === 'string' && p.length > 0 && p[0] === '/';
}

function resolve(...parts) {
  let result = '';
  for (const p of parts) {
    if (!p) continue;
    if (p[0] === '/') {
      result = p;
    } else {
      result = result ? result + '/' + p : p;
    }
  }
  return normalize(result || '/');
}

function relative(from, to) {
  const f = normalize(from).split('/').filter(Boolean);
  const t = normalize(to).split('/').filter(Boolean);
  let common = 0;
  while (common < f.length && common < t.length && f[common] === t[common]) {
    common++;
  }
  const ups = f.length - common;
  const downs = t.slice(common);
  const parts = [];
  for (let i = 0; i < ups; i++) parts.push('..');
  parts.push(...downs);
  return parts.join('/') || '.';
}

function mime(p) {
  const ext = extname(p).slice(1).toLowerCase();
  return MIME_TABLE[ext] || 'application/octet-stream';
}

const path = { join, dirname, basename, extname, normalize, resolve, isAbsolute, relative, mime };

export { path };
