// First-run setup — the modal that turns a lean works-core into a configured
// workstation (distributions phase 3). Pick a distribution profile (or a custom
// .gcuprofile), pick a theme, and provision: the profile's packages + their lib
// closure install from the catalog. Dual-use — shown once on first boot of an
// unprovisioned works-core, and re-openable from Tools / Help ("change profile").
//
// The invariant: provisioning is the NETWORK-named feature. The profile LIST is
// baked (works offline / file://); only the install reaches the network. We probe
// the catalog (reachability, not protocol — a file:// page CAN fetch a CORS-open
// catalog). Offline collapses to Minimal (no packages) + a "get a full edition"
// pointer; never a dead-end.

import { Dialog } from '#dialog';
import { WKS } from './state.js';
import { listProfiles, isProvisioned, provisionProfile, provisionProfileSpec } from './provision.js';
import { metaGet } from './meta.js';
import { readSettings, writeSettings, applyWorkspaceSettings } from './settings-store.js';

// Build-injected (works build): the package catalog URL — the first-party code
// source a provisioned shell installs from. Hosted SAME-ORIGIN as the Works PWA
// (gentropic.org/works/packages/) so provisioning needs no CORS and the SW
// runtime-caches the .gcupkgs for offline re-provision. Overridable per-workspace
// via the `registry.catalogUrl` meta key (tests + custom deployments) or
// showSetupDialog({ catalogUrl }).
const __GCU_CATALOG_URL__ = 'https://gentropic.org/works/packages/registry.json';

// Sync — the works-core build carries the profiles payload; monoliths don't. Used
// to gate the menu entries (which build synchronously).
export function hasProfilesPayload() {
  return !!document.getElementById('profiles-payload');
}

async function getCatalogUrl() {
  const override = await metaGet('registry.catalogUrl').catch(() => null);
  return override || __GCU_CATALOG_URL__;
}

async function probeCatalog(url) {
  try { const r = await fetch(url, { cache: 'no-cache' }); return !!(r && r.ok); }
  catch { return false; }
}

// Show the setup at first boot of an unprovisioned works-core. No-op for a
// monolith (no profiles) or an already-provisioned workspace.
export async function maybeShowFirstRunSetup() {
  try {
    if (typeof window !== 'undefined' && window.__NO_AUTO_SETUP__) return;   // test/embed opt-out
    if (!hasProfilesPayload()) return;
    if ((await listProfiles()).length === 0) return;
    if (await isProvisioned()) return;
    await showSetupDialog({ firstRun: true });
  } catch (e) { console.warn('[works] first-run setup:', e); }
}

const _btn = (label, primary) => {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText = 'font:inherit; font-size:12px; padding:6px 16px; border-radius:5px; cursor:pointer; '
    + (primary
      ? 'border:1px solid var(--au-action); background:var(--au-action); color:var(--au-surface-deep); font-weight:600;'
      : 'border:1px solid var(--au-border); background:var(--au-surface-raised); color:var(--au-fg);');
  return b;
};

export async function showSetupDialog(opts = {}) {
  const profiles = await listProfiles();
  if (profiles.length === 0) return null;     // monolith — nothing to provision
  const firstRun = !!opts.firstRun;
  const catalogUrl = opts.catalogUrl || await getCatalogUrl();
  const online = await probeCatalog(catalogUrl);

  const cur = await readSettings(WKS.vfs).catch(() => ({}));
  let theme = cur.appearance?.theme || document.documentElement.getAttribute('data-theme') || 'dark';
  // Default selection: a package-bearing profile when online, else Minimal.
  let selected = (online && profiles.find((p) => (p.packages || []).length))
    ? profiles.find((p) => (p.packages || []).length).name
    : (profiles.find((p) => !(p.packages || []).length) || profiles[0]).name;
  let custom = false;
  let customUrl = '';
  let customText = null;   // a .gcuprofile loaded from a local file (takes precedence over the URL)

  const dialog = new Dialog({
    title: firstRun ? 'Welcome to Auditable Works' : 'Set up / change profile',
    closable: !firstRun,   // first run is dismiss-via-Skip, not the X
    backdrop: true,
    render: (body, ctx) => {
      body.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.style.cssText = 'min-width:420px; max-width:520px; display:flex; flex-direction:column; gap:12px;';

      const intro = document.createElement('div');
      intro.style.cssText = 'color:var(--au-fg-soft); font-size:12px; line-height:1.5;';
      intro.textContent = firstRun
        ? 'Pick a starting setup. You can change it any time from Tools → Set up.'
        : 'Re-provision this workspace with a different profile. Already-installed packages are kept.';
      wrap.appendChild(intro);

      // ── profile list ──
      const list = document.createElement('div');
      list.style.cssText = 'display:flex; flex-direction:column; gap:5px;';
      wrap.appendChild(list);

      const rows = [];
      function mkRow(value, title, desc) {
        const row = document.createElement('label');
        row.style.cssText = 'display:flex; gap:9px; align-items:flex-start; padding:8px 10px; '
          + 'border:1px solid var(--au-border); border-radius:6px; cursor:pointer; background:var(--au-surface-raised);';
        const radio = document.createElement('input');
        radio.type = 'radio'; radio.name = 'setup-profile'; radio.value = value;
        radio.style.cssText = 'margin-top:2px; cursor:pointer;';
        radio.addEventListener('change', () => { selected = value; custom = (value === '__custom__'); repaint(); });
        const main = document.createElement('div');
        main.style.cssText = 'flex:1; display:flex; flex-direction:column; gap:2px;';
        const t = document.createElement('div'); t.style.cssText = 'font-weight:600; font-size:13px;'; t.textContent = title;
        const d = document.createElement('div'); d.style.cssText = 'font-size:11px; color:var(--au-fg-soft); line-height:1.4;'; d.textContent = desc;
        main.append(t, d);
        row.append(radio, main);
        list.appendChild(row);
        rows.push({ value, row, radio });
        return { row, main };
      }

      for (const p of profiles) {
        const pkgs = (p.packages || []);
        const desc = (p.description || '') + (pkgs.length ? `  ·  installs: ${pkgs.join(', ')}` : '  ·  shell only, no download');
        mkRow(p.name, p.title || p.name, desc);
      }
      // Custom (Form 1) — a .gcuprofile by URL or a local file. Either way its
      // packages install from the configured sources.
      const cu = mkRow('__custom__', 'Custom…', 'Provision from a .gcuprofile — paste a URL or browse for a file.');
      const customWrap = document.createElement('div');
      customWrap.style.cssText = 'display:none; margin-top:5px;';
      const fileNote = document.createElement('div');
      fileNote.style.cssText = 'display:none; font-size:11px; color:var(--au-info); margin-top:3px;';
      const customRow = document.createElement('div');
      customRow.style.cssText = 'display:flex; gap:6px;';
      const customInput = document.createElement('input');
      customInput.type = 'url'; customInput.placeholder = 'https://…/my.gcuprofile';
      customInput.style.cssText = 'flex:1; box-sizing:border-box; font:inherit; font-size:12px; padding:5px 8px; '
        + 'border:1px solid var(--au-border); border-radius:5px; background:var(--au-surface-bright); color:var(--au-fg);';
      customInput.addEventListener('input', () => { customUrl = customInput.value.trim(); customText = null; fileNote.style.display = 'none'; });
      const browseBtn = _btn('Browse…', false);
      browseBtn.style.padding = '5px 12px';
      const fileInput = document.createElement('input');
      fileInput.type = 'file'; fileInput.accept = '.gcuprofile,application/json'; fileInput.style.display = 'none';
      browseBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', async () => {
        const f = fileInput.files && fileInput.files[0];
        if (!f) return;
        try {
          customText = await f.text(); customUrl = ''; customInput.value = '';
          fileNote.textContent = 'Loaded: ' + f.name; fileNote.style.color = 'var(--au-info)';
        } catch {
          customText = null; fileNote.textContent = 'Could not read ' + f.name; fileNote.style.color = 'var(--au-fault)';
        }
        fileNote.style.display = 'block';
      });
      customRow.append(customInput, browseBtn);
      customWrap.append(customRow, fileInput, fileNote);
      cu.main.appendChild(customWrap);

      // ── theme ──
      const themeRow = document.createElement('div');
      themeRow.style.cssText = 'display:flex; align-items:center; gap:8px; font-size:12px; color:var(--au-fg-soft);';
      const themeLbl = document.createElement('span'); themeLbl.textContent = 'Theme:';
      const themeSel = document.createElement('select');
      themeSel.style.cssText = 'font:inherit; font-size:12px; padding:3px 6px; border-radius:5px; '
        + 'border:1px solid var(--au-border); background:var(--au-surface-bright); color:var(--au-fg);';
      for (const [v, l] of [['dark', 'Dark'], ['light', 'Light']]) {
        const o = document.createElement('option'); o.value = v; o.textContent = l; if (v === theme) o.selected = true; themeSel.appendChild(o);
      }
      themeSel.addEventListener('change', () => {
        theme = themeSel.value;
        document.documentElement.setAttribute('data-theme', theme);   // live preview
      });
      themeRow.append(themeLbl, themeSel);
      wrap.appendChild(themeRow);

      // ── footer ──
      const status = document.createElement('div');
      status.style.cssText = 'font-size:11px; color:var(--au-fg-soft);';
      status.textContent = online ? '● online — packages install from the library'
        : '○ offline — Minimal works now; for more, reconnect or use a full edition';
      wrap.appendChild(status);

      const footer = document.createElement('div');
      footer.style.cssText = 'display:flex; justify-content:flex-end; gap:8px; margin-top:2px;';
      const secondary = _btn(firstRun ? 'Skip (Minimal)' : 'Cancel', false);
      const primary = _btn(firstRun ? 'Set up' : 'Apply', true);
      secondary.addEventListener('click', () => {
        if (firstRun) runSetup(true); else ctx.close(null);
      });
      primary.addEventListener('click', () => runSetup(false));
      footer.append(secondary, primary);
      wrap.appendChild(footer);

      body.appendChild(wrap);

      function repaint() {
        for (const r of rows) {
          const on = r.value === selected;
          r.radio.checked = on;
          r.row.style.borderColor = on ? 'var(--au-action)' : 'var(--au-border)';
          r.row.style.background = on ? 'var(--au-action-soft)' : 'var(--au-surface-raised)';
        }
        customWrap.style.display = custom ? 'block' : 'none';
        if (custom) customInput.focus();
      }
      repaint();

      // Run the provisioning, swap the body to a progress/summary view, close on done.
      async function runSetup(minimal) {
        const useCustom = !minimal && custom;
        if (useCustom && !customUrl && !customText) { customInput.style.borderColor = 'var(--au-fault)'; customInput.focus(); return; }
        // Progress view.
        body.innerHTML = '';
        const prog = document.createElement('div');
        prog.style.cssText = 'min-width:380px; display:flex; flex-direction:column; gap:10px; padding:6px 2px;';
        const head = document.createElement('div'); head.style.cssText = 'font-weight:600; font-size:13px;';
        head.textContent = minimal ? 'Setting up — Minimal' : 'Setting up…';
        const note = document.createElement('div'); note.style.cssText = 'font-size:12px; color:var(--au-fg-soft);';
        note.textContent = 'Installing packages from the library — this can take a moment.';
        prog.append(head, note);
        body.appendChild(prog);

        let report = null, err = null;
        try {
          if (minimal) {
            const mn = profiles.find((p) => !(p.packages || []).length);
            report = await provisionProfile(mn ? mn.name : profiles[0].name, catalogUrl);
          } else if (useCustom) {
            const txt = customText != null ? customText
              : await (await fetch(customUrl, { cache: 'no-cache' })).text();
            const spec = JSON.parse(txt);
            report = await provisionProfileSpec(spec, catalogUrl);
          } else {
            report = await provisionProfile(selected, catalogUrl);
          }
        } catch (e) { err = e.message || String(e); }

        // Persist the chosen theme (the user's pick wins over the profile default).
        // Works settings nest theme under appearance.theme.
        try {
          const s = await readSettings(WKS.vfs);
          s.appearance = { ...(s.appearance || {}), theme };
          await writeSettings(WKS.vfs, s);
          applyWorkspaceSettings(s);
        } catch { /* non-fatal */ }

        // Summary.
        body.innerHTML = '';
        const sum = document.createElement('div');
        sum.style.cssText = 'min-width:360px; display:flex; flex-direction:column; gap:10px; padding:6px 2px;';
        const sh = document.createElement('div'); sh.style.cssText = 'font-weight:600; font-size:13px;';
        const sd = document.createElement('div'); sd.style.cssText = 'font-size:12px; color:var(--au-fg-soft); line-height:1.5;';
        if (err) {
          sh.textContent = 'Setup hit a problem';
          sd.textContent = err + '  — you can retry from Tools → Set up.';
        } else {
          const inst = (report && report.installed) || [];
          const fail = (report && report.failed) || [];
          sh.textContent = fail.length ? 'Set up with some failures' : 'All set';
          sd.textContent = (inst.length ? `Installed: ${inst.join(', ')}. ` : 'Shell ready. ')
            + (fail.length ? `Could not install: ${fail.join(', ')} (offline? retry from Tools → Set up).` : '');
        }
        const done = _btn('Done', true);
        done.style.alignSelf = 'flex-end';
        done.addEventListener('click', () => ctx.close(report));
        sum.append(sh, sd, done);
        body.appendChild(sum);
        done.focus();
      }
    },
  });

  return dialog.show();
}
