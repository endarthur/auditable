// File I/O builtins: readFile, guessMime, plus download/upload/drop UI widgets.
// All hang off ui.* in the cell context.

const MIME_MAP = {
  csv: 'text/csv', json: 'application/json', txt: 'text/plain',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  zip: 'application/zip', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', svg: 'image/svg+xml', pdf: 'application/pdf',
  html: 'text/html', xml: 'application/xml', wasm: 'application/wasm',
};

function readFile(file, as) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    if (as === 'arrayBuffer') reader.readAsArrayBuffer(file);
    else if (as === 'dataURL') reader.readAsDataURL(file);
    else reader.readAsText(file);
  });
}

function guessMime(name) {
  const ext = (name || '').split('.').pop().toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

export function makeFileIo(cell, ctx, runDAG) {
  const { invalidation, outputEl, widgetEl, usedWidgets } = ctx;

  // ui.download — output-only download button
  const download = (label, data, filename, opts = {}) => {
    const type = opts.type || guessMime(filename);
    let blob;
    if (data instanceof Blob) blob = data;
    else if (data instanceof ArrayBuffer || data instanceof Uint8Array) blob = new Blob([data], { type });
    else if (typeof data === 'string') blob = new Blob([data], { type });
    else blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    invalidation.then(() => URL.revokeObjectURL(url));

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.textContent = label;
    a.style.cssText = 'display:inline-block;padding:6px 14px;background:var(--au-action);color:#111;border-radius:3px;text-decoration:none;font-weight:600;font-family:var(--au-font-mono);font-size:12px;cursor:pointer;';
    outputEl.appendChild(a);
    return a;
  };

  // ui.upload — file picker input widget
  const upload = (label, opts = {}) => {
    const key = label;
    usedWidgets.add(key);
    cell._callbacks[key] = { onChange: opts.onChange };

    const existing = widgetEl.querySelector(`[data-widget-key="${CSS.escape(key)}"]`);
    if (existing) return cell._inputs[key] ?? null;

    const wrap = document.createElement('span');
    wrap.dataset.widgetKey = key;
    wrap.style.cssText = 'display:flex;align-items:center;gap:8px;padding:2px 0;font-size:12px;color:var(--au-fg-soft);';

    const lbl = document.createElement('span');
    lbl.textContent = label;
    lbl.style.cssText = 'min-width:80px;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--au-fg-soft);';
    wrap.appendChild(lbl);

    const btn = document.createElement('button');
    btn.textContent = 'choose file';
    btn.style.cssText = 'padding:3px 10px;background:var(--au-surface-bright);border:1px solid var(--au-border);color:var(--au-fg);font-family:var(--au-font-mono);font-size:11px;cursor:pointer;border-radius:2px;';
    wrap.appendChild(btn);

    const nameSpan = document.createElement('span');
    nameSpan.style.cssText = 'font-size:11px;color:var(--au-fg-soft);';
    wrap.appendChild(nameSpan);

    const input = document.createElement('input');
    input.type = 'file';
    input.style.display = 'none';
    if (opts.accept) input.accept = opts.accept;
    wrap.appendChild(input);

    btn.onclick = () => input.click();
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      const data = await readFile(file, opts.as || 'text');
      const result = { name: file.name, data, size: file.size, type: file.type };
      cell._inputs[key] = result;
      nameSpan.textContent = file.name;
      btn.textContent = file.name;
      const cb = cell._callbacks[key];
      if (cb?.onChange) cb.onChange(result);
      else runDAG([cell.id]);
    };

    widgetEl.appendChild(wrap);
    cell._inputs[key] = cell._inputs[key] ?? null;
    return cell._inputs[key];
  };

  // ui.drop — drop zone + file picker input widget
  const drop = (label, opts = {}) => {
    const key = label;
    usedWidgets.add(key);
    cell._callbacks[key] = { onChange: opts.onChange };

    const existing = widgetEl.querySelector(`[data-widget-key="${CSS.escape(key)}"]`);
    if (existing) return cell._inputs[key] ?? null;

    const zone = document.createElement('div');
    zone.dataset.widgetKey = key;
    zone.style.cssText = 'display:flex;align-items:center;justify-content:center;padding:12px 16px;border:2px dashed var(--au-rule);border-radius:4px;color:var(--au-fg-soft);font-family:var(--au-font-mono);font-size:11px;cursor:pointer;min-height:48px;transition:border-color 0.15s;';
    zone.textContent = label;

    const input = document.createElement('input');
    input.type = 'file';
    input.style.display = 'none';
    if (opts.accept) input.accept = opts.accept;
    zone.appendChild(input);

    const handleFile = async (file) => {
      const data = await readFile(file, opts.as || 'text');
      const result = { name: file.name, data, size: file.size, type: file.type };
      cell._inputs[key] = result;
      zone.textContent = file.name;
      zone.style.borderColor = 'var(--au-action)';
      zone.appendChild(input);
      const cb = cell._callbacks[key];
      if (cb?.onChange) cb.onChange(result);
      else runDAG([cell.id]);
    };

    zone.onclick = () => input.click();
    input.onchange = () => { if (input.files[0]) handleFile(input.files[0]); };

    zone.ondragover = (e) => { e.preventDefault(); zone.style.borderColor = 'var(--au-action)'; };
    zone.ondragleave = () => { zone.style.borderColor = cell._inputs[key] ? 'var(--au-action)' : 'var(--au-rule)'; };
    zone.ondrop = (e) => {
      e.preventDefault();
      zone.style.borderColor = 'var(--au-rule)';
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    };

    widgetEl.appendChild(zone);
    cell._inputs[key] = cell._inputs[key] ?? null;
    return cell._inputs[key];
  };

  return { download, upload, drop };
}

export { readFile, guessMime };
