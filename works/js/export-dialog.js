// Export-workspace dialog — pick what travels in the exported HTML, with live
// size estimates. The heavy default is library content (books/datasets from
// gcu-library), so it defaults to "reinstall on open" (the kept manifest +
// recipe travel; the bulk doesn't). Everything else bundles in full.
//
// Phase 2 (this file) does the picking, filtering, and recipe-writing. The
// boot-time executor that consumes /home/.works/reinstall.json is Phase 3.

import { Dialog } from '#dialog';
import { categorizeDump, EXPORT_CATEGORIES } from './persist.js';

// gzip a string → byte length, for the projected-size readout. Mirrors
// persist.js's _gzipBytes; kept local so the dialog owns its estimates.
async function _gzLen(str) {
  if (!str) return 0;
  const cs = new CompressionStream('gzip');
  const w = cs.writable.getWriter();
  w.write(new TextEncoder().encode(str)); w.close();
  const buf = await new Response(cs.readable).arrayBuffer();
  return buf.byteLength;
}

function _fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

// Concatenate the content of every dump path in a category (full) and of just
// its keep-in-reinstall files, so we can show both "bundled" and "reinstall"
// costs without re-walking on every toggle.
function _catContent(dump, cat) {
  let full = '', keep = '';
  for (const [p, e] of Object.entries(dump)) {
    if (!cat.match(p)) continue;
    const c = (e && typeof e.content === 'string') ? e.content : '';
    full += c + '\n';
    if (cat.keepInReinstall && cat.keepInReinstall(p)) keep += c + '\n';
  }
  return { full, keep };
}

/**
 * Open the export dialog. Resolves to { bundled:Set<catId>, emitGeas:bool }
 * or null if cancelled.
 */
export async function chooseExport(dump) {
  const present = categorizeDump(dump);           // [{ id,label,hint,reinstallable,count,rawBytes }]
  if (present.length === 0) return { bundled: new Set(), emitGeas: false };
  const catById = new Map(EXPORT_CATEGORIES.map((c) => [c.id, c]));

  // Pre-compute gzip sizes for full + reinstall-keep per category (one pass).
  const gz = new Map();
  await Promise.all(present.map(async (cat) => {
    const { full, keep } = _catContent(dump, catById.get(cat.id));
    gz.set(cat.id, { full: await _gzLen(full), keep: cat.reinstallable ? await _gzLen(keep) : 0 });
  }));

  // Base runtime ≈ the current page minus any embedded snapshot (there is none
  // while running). base64 inflates gzip by 4/3 in the file.
  const baseBytes = document.documentElement.outerHTML.length;
  const inFile = (gzBytes) => Math.round(gzBytes * 4 / 3);

  // Default: bundle everything except heavy re-installable library content.
  const bundled = new Set(present.map((c) => c.id));
  if (catById.get('library') && present.some((c) => c.id === 'library')) bundled.delete('library');

  let emitGeas = false;
  const state = { bundled, emitGeas };

  const dialog = new Dialog({
    title: 'Export workspace',
    backdrop: true,
    closable: true,
    render: (body, ctx) => {
      body.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.style.cssText = 'min-width:440px; max-width:560px; display:flex; flex-direction:column; gap:10px;';

      const intro = document.createElement('div');
      intro.style.cssText = 'color:var(--au-fg-soft); font-size:12px; line-height:1.5;';
      intro.textContent = 'Choose what travels in the exported HTML. Re-installable content can '
        + 'travel as a small recipe instead of its full bulk.';
      wrap.appendChild(intro);

      const list = document.createElement('div');
      list.style.cssText = 'display:flex; flex-direction:column; gap:2px;';
      wrap.appendChild(list);

      const footer = document.createElement('div');
      const geasRow = document.createElement('label');

      const rows = new Map();
      for (const cat of present) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:flex-start; gap:9px; padding:7px 8px; '
          + 'border:1px solid var(--au-border); border-radius:5px; background:var(--au-surface-raised);';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = bundled.has(cat.id);
        cb.style.cssText = 'margin-top:2px; cursor:pointer;';
        cb.addEventListener('change', () => {
          if (cb.checked) bundled.add(cat.id); else bundled.delete(cat.id);
          repaint();
        });

        const main = document.createElement('div');
        main.style.cssText = 'flex:1; display:flex; flex-direction:column; gap:1px;';
        const top = document.createElement('div');
        top.style.cssText = 'display:flex; justify-content:space-between; gap:8px; align-items:baseline;';
        const name = document.createElement('span');
        name.style.cssText = 'font-weight:600; font-size:13px;';
        name.textContent = cat.label;
        const size = document.createElement('span');
        size.style.cssText = 'font-size:11px; color:var(--au-fg-soft); font-variant-numeric:tabular-nums;';
        top.append(name, size);
        const hint = document.createElement('div');
        hint.style.cssText = 'font-size:11px; color:var(--au-fg-soft);';
        hint.textContent = cat.hint + ' · ' + cat.count + ' file' + (cat.count === 1 ? '' : 's');
        const status = document.createElement('div');
        status.style.cssText = 'font-size:11px; margin-top:1px;';
        main.append(top, hint, status);

        row.append(cb, main);
        list.appendChild(row);
        rows.set(cat.id, { cb, size, status });
      }

      // Optional readable geas recipe — only meaningful when something reinstalls.
      geasRow.style.cssText = 'display:flex; align-items:center; gap:8px; font-size:12px; '
        + 'color:var(--au-fg-soft); cursor:pointer; margin-top:2px;';
      const geasCb = document.createElement('input');
      geasCb.type = 'checkbox';
      geasCb.checked = emitGeas;
      geasCb.addEventListener('change', () => { emitGeas = geasCb.checked; state.emitGeas = emitGeas; });
      const geasLbl = document.createElement('span');
      geasLbl.textContent = 'Also write a readable reinstall.geas alongside the recipe';
      geasRow.append(geasCb, geasLbl);
      wrap.appendChild(geasRow);

      footer.style.cssText = 'display:flex; justify-content:space-between; align-items:baseline; '
        + 'margin-top:4px; padding-top:9px; border-top:1px solid var(--au-border);';
      const sizeReadout = document.createElement('div');
      sizeReadout.style.cssText = 'font-size:12px;';
      const btns = document.createElement('div');
      btns.style.cssText = 'display:flex; gap:8px;';
      const btnBase = 'font:inherit; font-size:12px; padding:5px 14px; border-radius:5px; cursor:pointer;';
      const cancel = document.createElement('button');
      cancel.style.cssText = btnBase + ' border:1px solid var(--au-border); '
        + 'background:var(--au-surface-raised); color:var(--au-fg);';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => ctx.close(null));
      const ok = document.createElement('button');
      ok.style.cssText = btnBase + ' border:1px solid var(--au-action); '
        + 'background:var(--au-action); color:var(--au-surface-deep); font-weight:600;';
      ok.dataset.default = 'true';
      ok.textContent = 'Export';
      ok.addEventListener('click', () => ctx.close({ bundled: new Set(bundled), emitGeas }));
      btns.append(cancel, ok);
      footer.append(sizeReadout, btns);
      wrap.appendChild(footer);

      body.appendChild(wrap);

      function repaint() {
        let blockGz = 0;
        let anyReinstall = false;
        for (const cat of present) {
          const g = gz.get(cat.id);
          const r = rows.get(cat.id);
          const c = catById.get(cat.id);
          if (bundled.has(cat.id)) {
            blockGz += g.full;
            r.status.textContent = 'bundled — ' + _fmtBytes(inFile(g.full)) + ' in file';
            r.status.style.color = 'var(--au-success)';
          } else if (c.reinstallable) {
            blockGz += g.keep;
            anyReinstall = true;
            r.status.textContent = '↻ reinstall on open — keeps recipe (' + _fmtBytes(inFile(g.keep)) + ')';
            r.status.style.color = 'var(--au-info)';
          } else {
            r.status.textContent = '✕ omitted';
            r.status.style.color = 'var(--au-warn)';
          }
          r.size.textContent = _fmtBytes(cat.rawBytes);
        }
        geasRow.style.display = anyReinstall ? 'flex' : 'none';
        const projected = baseBytes + inFile(blockGz);
        sizeReadout.innerHTML = 'Estimated file: <strong>≈ ' + _fmtBytes(projected) + '</strong>';
      }
      repaint();
    },
  });

  const result = await dialog.show();
  return result;   // { bundled, emitGeas } or null
}
