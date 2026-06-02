// works/js/registry.js — content/extension registry: browse + install packs
// from user-addable remote sources. v1 installs .gcudat content via the Browse
// Library dialog. Sources persist in shell meta; one baked-in default
// (gcu-library), removable. New sources prompt a trust warning. See
// spec_inbox/auditable-registry-spec.md.

import { WKS, setStatus } from './state.js';
import { Dialog, confirm as dlgConfirm, prompt as dlgPrompt } from '#dialog';
import { metaGet, metaSet } from './meta.js';
import { installGcudatBytes, getInstalled, patchInstalled } from './gcudat-install.js';
import { installGcupkgBytes } from './file-ops.js';
import { openPath } from './surfaces.js';
import { destFor } from './paths.js';

const DEFAULT_SOURCE = {
  url: 'https://raw.githubusercontent.com/gentropic/gcu-library/main/registry.json',
  name: 'GCU Library',
};

// ── sources (shell meta) ────────────────────────────────────────────
async function getSources() {
  let s = await metaGet('registry.sources').catch(() => null);
  if (!Array.isArray(s) || !s.length) {
    s = [{ url: DEFAULT_SOURCE.url, name: DEFAULT_SOURCE.name, addedAt: 0, acked: true }];
    await metaSet('registry.sources', s).catch(() => {});
  }
  return s;
}
const setSources = (s) => metaSet('registry.sources', s).catch(() => {});

// A source URL → { base, jsonUrl }. If it's not a .json, treat it as a dir.
function resolveSource(url) {
  const jsonUrl = /\.json($|\?)/.test(url) ? url : url.replace(/\/$/, '') + '/registry.json';
  return { base: jsonUrl.slice(0, jsonUrl.lastIndexOf('/')), jsonUrl };
}
const resolveEntryUrl = (base, u) => (/^https?:\/\//.test(u) ? u : base + '/' + u.replace(/^\//, ''));

export async function fetchRegistry(source) {
  const { base, jsonUrl } = resolveSource(typeof source === 'string' ? source : source.url);
  const res = await fetch(jsonUrl, { cache: 'no-cache' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const reg = await res.json();
  if (!reg || reg.registry == null) throw new Error('not a registry.json');
  return { base, registry: reg };
}

export async function removeSource(url) {
  const s = await getSources();
  const next = s.filter((x) => x.url !== url);
  if (next.length) await setSources(next);
  return next;
}

export const isNC = (license) => /\bNC\b|non-?commercial/i.test(String(license || ''));

async function sriOf(bytes) {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  const v = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < v.length; i++) s += String.fromCharCode(v[i]);
  return 'sha256-' + btoa(s);
}

async function isInstalled(entry) {
  if (entry.kind === 'gcudat')
    return WKS.vfs.exists(destFor(entry.datKind, entry.name)).catch(() => false);
  return false;
}

function semverGt(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return true; if (x < y) return false;
  }
  return false;
}

// 'install' | 'installed' | 'update' for a registry entry. 'update' needs a
// recorded version to compare; a pre-ledger install (dir present, no record)
// reads as 'installed' — the UI offers a reinstall there instead.
export async function entryStatus(entry) {
  if (entry.kind === 'gcupkg') {
    // Code extensions are ledger-authoritative (the /lib path is name-derived,
    // not trivially recomputable here). Installed iff the ledger records it and
    // its lib dir still exists.
    const rec = (await getInstalled())[entry.name];
    const live = rec && rec.dest && await WKS.vfs.exists(rec.dest).catch(() => false);
    if (!live) return 'install';
    return (rec.version && semverGt(entry.version, rec.version)) ? 'update' : 'installed';
  }
  if (!(await isInstalled(entry))) return 'install';
  const rec = (await getInstalled())[entry.name];
  if (rec && rec.version && semverGt(entry.version, rec.version)) return 'update';
  return 'installed';
}
// Batch for the surface: [{name, status}] in one A-Bus round-trip.
export async function entryStatuses(entries) {
  const out = {};
  for (const e of entries || []) out[e.name] = await entryStatus(e);
  return out;
}
// Scan every installed pack's source registry → available updates.
export async function checkUpdates() {
  const map = await getInstalled();
  const bySource = {};
  for (const [name, rec] of Object.entries(map)) { if (rec && rec.source) (bySource[rec.source] ||= []).push([name, rec]); }
  const out = [];
  for (const [src, items] of Object.entries(bySource)) {
    let reg;
    try { reg = (await fetchRegistry(src)).registry; } catch { continue; }
    const byName = Object.fromEntries((reg.entries || []).map((e) => [e.name, e]));
    for (const [name, rec] of items) {
      const e = byName[name];
      if (e && semverGt(e.version, rec.version)) out.push({ name, title: e.title || name, from: rec.version, to: e.version, source: src });
    }
  }
  return out;
}

async function installEntry(entry, base, sourceUrl) {
  const url = resolveEntryUrl(base, Array.isArray(entry.url) ? entry.url[0] : entry.url);
  setStatus('fetching ' + entry.name + '…');
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (entry.integrity) {
    let got = '';
    try { got = await sriOf(bytes); } catch { /* no subtle crypto — skip verify */ }
    if (got && got !== entry.integrity) {
      const ok = await dlgConfirm(
        'Integrity check failed for "' + entry.name + '".\n\nExpected ' + entry.integrity.slice(0, 24)
        + '…\nGot      ' + got.slice(0, 24) + '…\n\nInstall anyway?',
        { title: 'Integrity mismatch', danger: true });
      if (!ok) { setStatus('install cancelled'); return null; }
    }
  }
  if (entry.kind === 'gcudat') {
    const dest = await installGcudatBytes(bytes, entry.name + '.gcudat');
    if (dest) {
      // installGcudatBytes recorded manifest fields; attach where it came from
      // so checkUpdates can re-find this entry, plus the registry's version/SRI.
      await patchInstalled(entry.name, { source: sourceUrl || '', integrity: entry.integrity || '', version: entry.version || '' }).catch(() => {});
      setStatus('installed ' + entry.name);
    }
    return dest;
  }
  if (entry.kind === 'gcupkg') {
    // Code extension — runs in the workspace. Always confirm before install,
    // regardless of source trust (SRI only proves the bytes are intact).
    const ok = await dlgConfirm(
      '"' + (entry.title || entry.name) + '" is a code extension — it runs in your workspace with full access.\n\n'
      + 'Only install extensions you trust.\n\nInstall it?',
      { title: 'Install extension', danger: true });
    if (!ok) { setStatus('install cancelled'); return null; }
    let r;
    try { r = await installGcupkgBytes(bytes, entry.name + '.gcupkg'); }
    catch (e) { setStatus('install failed: ' + (e.message || e)); return null; }
    await patchInstalled(entry.name, {
      version: r.version || entry.version || '', source: sourceUrl || '', integrity: entry.integrity || '',
      kind: 'gcupkg', datKind: '', title: entry.title || entry.name, dest: r.libPath, at: Date.now(),
    }).catch(() => {});
    setStatus('installed ' + entry.name);
    return r.libPath;
  }
  setStatus('entry kind not yet supported: ' + entry.kind);
  return null;
}

// Add a source by URL, with a one-time trust warning. Returns the url or null.
async function addSourceFlow() {
  const url = await dlgPrompt('Registry source URL (its registry.json, or a directory holding one):',
    { title: 'Add source', placeholder: 'https://example.org/registry.json' });
  if (!url || !url.trim()) return null;
  const ok = await dlgConfirm(
    'Sources can serve data packs — and code extensions that run in your workspace.\n\n'
    + 'Only add sources you trust.\n\nAdd "' + url.trim() + '"?',
    { title: 'Add registry source', danger: true });
  if (!ok) return null;
  const sources = await getSources();
  const u = url.trim();
  if (!sources.some((s) => s.url === u)) {
    sources.push({ url: u, name: u, addedAt: Date.now(), acked: true });
    await setSources(sources);
  }
  return u;
}

// Non-UI primitives — used by the dialog, exposable on WKS, and the building
// block for geas `pkg search/install` over the registry.
export async function listEntries(sourceUrl) {
  const { registry } = await fetchRegistry({ url: sourceUrl });
  return registry.entries || [];
}
export async function installByName(sourceUrl, name) {
  const { base, registry } = await fetchRegistry({ url: sourceUrl });
  const entry = (registry.entries || []).find((e) => e.name === name);
  if (!entry) throw new Error('no entry "' + name + '" in this registry');
  return installEntry(entry, base, sourceUrl);
}

// Install an entry referenced by a capsule (QR / share-link → boot #capsule).
// If the source is new, prompt a one-time trust confirm (a source can serve
// code), add it, then install. An already-trusted source (e.g. the default
// gcu-library) installs with no extra friction. Opens books; extensions install
// in place. Returns the dest path or null.
export async function installFromCapsule(source, name) {
  const sources = await getSources();
  if (!sources.some((s) => s.url === source)) {
    const ok = await dlgConfirm(
      'Install "' + name + '" from a new source?\n\n' + source + '\n\n'
      + 'This adds it as a content source — sources can serve data packs and code extensions. Only proceed if you trust it.',
      { title: 'Open in Works', danger: true });
    if (!ok) { setStatus('capsule install cancelled'); return null; }
    await addSourceSilent(source, source);
  }
  const dest = await installByName(source, name);   // gcudat installs; gcupkg adds its own code-confirm
  if (dest && /^\/home\/\.books\/library\//.test(dest)) await openPath(dest);
  return dest;
}
export async function addSourceSilent(url, nm) {
  const sources = await getSources();
  if (!sources.some((s) => s.url === url)) {
    sources.push({ url, name: nm || url, addedAt: Date.now(), acked: true });
    await setSources(sources);
  }
  return url;
}
export { getSources };

const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

const STYLE = `
.reg-wrap { display:flex; flex-direction:column; max-height:72vh; font:13px 'Barlow',system-ui,sans-serif; }
.reg-top { display:flex; gap:8px; align-items:center; padding:10px 14px; border-bottom:1px solid var(--au-border); flex:none; }
.reg-top select, .reg-top input { background:var(--au-surface); color:var(--au-fg); border:1px solid var(--au-border); border-radius:4px; padding:4px 7px; font:inherit; }
.reg-top select { flex:1; min-width:0; }
.reg-btn { background:var(--au-surface-bright); color:var(--au-fg); border:1px solid var(--au-border); border-radius:4px; padding:4px 9px; cursor:pointer; font:inherit; white-space:nowrap; }
.reg-btn:hover { border-color:var(--au-action); }
.reg-search { margin:8px 14px 0; padding:5px 8px; background:var(--au-surface); color:var(--au-fg); border:1px solid var(--au-border); border-radius:4px; font:inherit; }
.reg-list { overflow:auto; padding:6px 8px 10px; }
.reg-empty { padding:18px 14px; color:var(--au-fg-soft); font-style:italic; }
.reg-row { display:flex; gap:10px; align-items:flex-start; padding:9px 8px; border-radius:5px; }
.reg-row:hover { background:var(--au-surface-bright); }
.reg-row .body { flex:1; min-width:0; }
.reg-row .ttl { color:var(--au-fg); font-weight:600; }
.reg-row .badge { font:10px ui-monospace,monospace; text-transform:uppercase; letter-spacing:.5px; color:var(--au-action); border:1px solid var(--au-border); border-radius:3px; padding:0 5px; margin-left:6px; }
.reg-row .badge.nc { color:var(--au-warn); border-color:var(--au-warn); }
.reg-row .meta { color:var(--au-fg-soft); font-size:11px; margin-top:2px; }
.reg-row .desc { color:var(--au-fg-muted); font-size:12px; margin-top:3px; }
.reg-row .tags { color:var(--au-fg-soft); font:10px ui-monospace,monospace; margin-top:3px; }
.reg-row .install { align-self:center; }
.reg-row .install.done { color:var(--au-go); border-color:var(--au-go); }
.reg-row .install.upd { color:var(--au-action); border-color:var(--au-action); }
.reg-credit { padding:8px 14px; border-top:1px solid var(--au-border); color:var(--au-fg-soft); font-size:11px; flex:none; }
`;

export async function openLibraryDialog() {
  const sources = await getSources();
  let current = sources[0];

  const dlg = new Dialog({
    title: 'Browse Library', width: 660, backdrop: true, closable: true,
    render: (body, ctx) => {
      body.style.cssText = 'padding:0;';
      const wrap = document.createElement('div'); wrap.className = 'reg-wrap';
      wrap.innerHTML = '<style>' + STYLE + '</style>';
      const top = document.createElement('div'); top.className = 'reg-top';
      const sel = document.createElement('select');
      const addBtn = document.createElement('button'); addBtn.className = 'reg-btn'; addBtn.textContent = '+ Add source';
      const rmBtn = document.createElement('button'); rmBtn.className = 'reg-btn'; rmBtn.textContent = 'Remove';
      top.append(sel, addBtn, rmBtn);
      const search = document.createElement('input'); search.className = 'reg-search'; search.placeholder = 'Filter…';
      const list = document.createElement('div'); list.className = 'reg-list';
      const credit = document.createElement('div'); credit.className = 'reg-credit';
      wrap.append(top, search, list, credit);
      body.appendChild(wrap);

      let reg = null, base = '';
      function fillSel() {
        sel.innerHTML = '';
        for (const s of sources) {
          const o = document.createElement('option'); o.value = s.url; o.textContent = s.name || s.url;
          if (s === current) o.selected = true;
          sel.appendChild(o);
        }
        rmBtn.disabled = sources.length <= 1;
      }
      async function load() {
        list.innerHTML = '<div class="reg-empty">loading…</div>'; credit.textContent = '';
        try { const r = await fetchRegistry(current); reg = r.registry; base = r.base; render(); credit.textContent = (reg.name || '') + (reg.description ? ' — ' + reg.description : ''); }
        catch (e) { reg = null; list.innerHTML = '<div class="reg-empty">couldn\'t load this source — ' + esc(e.message || e) + '</div>'; }
      }
      async function render() {
        if (!reg) return;
        const q = search.value.toLowerCase().trim();
        const entries = (reg.entries || []).filter((e) =>
          !q || ((e.title || '') + ' ' + (e.description || '') + ' ' + (e.tags || []).join(' ') + ' ' + (e.datKind || '')).toLowerCase().includes(q));
        list.innerHTML = '';
        if (!entries.length) { list.innerHTML = '<div class="reg-empty">' + (reg.entries && reg.entries.length ? 'no matches.' : 'this source has no entries.') + '</div>'; return; }
        for (const e of entries) {
          const row = document.createElement('div'); row.className = 'reg-row';
          row.innerHTML =
            '<div class="body">'
            + '<div class="ttl">' + esc(e.title || e.name) + '<span class="badge">' + esc(e.kind === 'gcupkg' ? 'ext' : (e.datKind || 'data')) + '</span>'
            + (isNC(e.license) ? '<span class="badge nc" title="Non-commercial — free to share, not to sell">NC</span>' : '') + '</div>'
            + '<div class="meta">' + esc(e.license || '') + (e.attribution ? ' · ' + esc(e.attribution) : '') + ' · ' + fmtSize(e.size || 0) + (e.version ? ' · v' + esc(e.version) : '') + '</div>'
            + (e.description ? '<div class="desc">' + esc(e.description) + '</div>' : '')
            + ((e.tags && e.tags.length) ? '<div class="tags">' + e.tags.map(esc).join(' · ') + '</div>' : '')
            + '</div>';
          const status = await entryStatus(e);
          const btn = document.createElement('button');
          const LABEL = { install: 'Install', update: 'Update ↑', installed: 'Reinstall ↻' };
          btn.className = 'reg-btn install' + (status === 'installed' ? ' done' : status === 'update' ? ' upd' : '');
          btn.textContent = LABEL[status];
          btn.title = status === 'installed' ? 'Reinstall (overwrite — reading state is kept)' : '';
          btn.addEventListener('click', async () => {
            const wasReinstall = status === 'installed';
            btn.disabled = true; btn.textContent = '…';
            try {
              const dest = await installEntry(e, base, current.url);
              // A fresh book install/update jumps into the book; a no-reason
              // reinstall (or any extension install) keeps the dialog open.
              if (dest && !wasReinstall && e.kind !== 'gcupkg') { ctx.close(); await openPath(dest); }
              else { setStatus(dest ? (e.kind === 'gcupkg' ? 'installed ' + e.name : 'reinstalled ' + e.name) : 'install cancelled'); render(); }
            } catch (err) { setStatus('install failed: ' + (err.message || err)); render(); }
          });
          row.appendChild(btn);
          list.appendChild(row);
        }
      }
      sel.addEventListener('change', () => { current = sources.find((s) => s.url === sel.value) || sources[0]; load(); });
      addBtn.addEventListener('click', async () => {
        const u = await addSourceFlow();
        if (!u) return;
        const ns = await getSources(); sources.length = 0; sources.push(...ns);
        current = sources.find((s) => s.url === u) || sources[0];
        fillSel(); load();
      });
      rmBtn.addEventListener('click', async () => {
        if (sources.length <= 1) return;
        const i = sources.indexOf(current);
        sources.splice(i, 1); await setSources(sources);
        current = sources[0]; fillSel(); load();
      });
      fillSel(); load();
    },
  });
  await dlg.show();
}
