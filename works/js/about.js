// Help → About Auditable Works — a real modal (the menubar's `help:about`
// previously fell through to a setStatus stub).
//
// Build-time injection: the constants below are placeholders that
// build.js's works branch rewrites to the real values. Source of truth
// lives in package.json + the build environment; runtime never edits.

import { Dialog } from '#dialog';
import { openPath } from './surfaces.js';
import { WKS } from './state.js';

const __AUDITABLE_VERSION__ = '0.0.0';
const __AUDITABLE_BUILD_DATE__ = 'dev';
const __AUDITABLE_RELEASE__ = 'dev';
const __AUDITABLE_PUBLIC_KEY__ = '';
const __AUDITABLE_REPO__ = 'gentropic/auditable';

// Build-time-injected vendored license manifest. Same placeholder as
// works-service.js — build.js rewrites this single line to the real
// vendor-licenses.json contents. Shape:
//   { <name>: { spdx, version, homepage, description, text } }
const __BUILD_LICENSES__ = {};

function _pubKeyShort(key) {
  if (!key) return null;
  // Ed25519 public keys are 32 bytes (typically base64'd to ~44 chars).
  // Show first + last 6 chars with an ellipsis — same visual as Git short SHAs.
  if (key.length <= 16) return key;
  return key.slice(0, 6) + '…' + key.slice(-6);
}

export async function showAbout() {
  const dialog = new Dialog({
    title: 'About Auditable Works',
    backdrop: true,
    closable: true,
    render: (body) => {
      body.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.className = 'about-modal';
      wrap.style.position = 'relative';

      // Discreet easter-egg toggle (bottom-right corner): the DD-60 "DADA
      // Diskman" retro reader skin. Faint when off, lit when on. When on, a
      // book directory's right-click menu gains "Open in DADA Diskman".
      const egg = document.createElement('button');
      egg.textContent = '▥';
      const paintEgg = () => {
        const on = !!WKS.dd60Enabled;
        egg.title = on ? 'DADA Diskman skin: ON — right-click a book → Open in DADA Diskman' : 'DADA Diskman skin (click to enable)';
        egg.style.cssText = 'position:absolute; right:6px; bottom:6px; width:20px; height:18px; padding:0; '
          + 'border:1px solid var(--au-border); border-radius:3px; background:transparent; cursor:pointer; '
          + 'font-size:11px; line-height:1; transition:opacity .15s,color .15s,border-color .15s; '
          + (on ? 'opacity:1; color:var(--au-go); border-color:var(--au-go);' : 'opacity:.3; color:var(--au-fg-soft);');
      };
      paintEgg();
      egg.addEventListener('click', () => { WKS.setDd60Enabled(!WKS.dd60Enabled); paintEgg(); });
      wrap.appendChild(egg);

      const brand = document.createElement('div');
      brand.className = 'about-brand';
      brand.textContent = 'AUDITABLE';
      wrap.appendChild(brand);

      const tag = document.createElement('div');
      tag.className = 'about-tag';
      tag.textContent = 'a reactive computational workstation in a single HTML file';
      wrap.appendChild(tag);

      const rows = document.createElement('dl');
      rows.className = 'about-rows';
      const addRow = (k, v, isLink) => {
        const dt = document.createElement('dt'); dt.textContent = k;
        const dd = document.createElement('dd');
        if (isLink && typeof v === 'string') {
          const a = document.createElement('a');
          a.href = v; a.target = '_blank'; a.rel = 'noopener';
          a.textContent = v.replace(/^https?:\/\//, '');
          dd.appendChild(a);
        } else if (v instanceof Node) {
          dd.appendChild(v);
        } else {
          dd.textContent = v;
        }
        rows.appendChild(dt); rows.appendChild(dd);
      };
      addRow('Version', __AUDITABLE_VERSION__
        + (__AUDITABLE_RELEASE__ && __AUDITABLE_RELEASE__ !== 'dev'
          ? ` (${__AUDITABLE_RELEASE__})` : ''));
      addRow('Build date', __AUDITABLE_BUILD_DATE__);
      const ks = _pubKeyShort(__AUDITABLE_PUBLIC_KEY__);
      if (ks) {
        const code = document.createElement('code');
        code.textContent = ks;
        code.title = __AUDITABLE_PUBLIC_KEY__;   // hover to see the full key
        addRow('Ed25519 key', code);
      }
      addRow('Source', `https://github.com/${__AUDITABLE_REPO__}`, true);
      addRow('Project', 'https://gentropic.org', true);
      addRow('License', 'MIT');

      wrap.appendChild(rows);

      // Third-party components — every vendored dep baked at build time, with
      // its SPDX identifier and a click-through to the full text mounted at
      // /sys/licenses/<name>/LICENSE.
      const vendored = Object.entries(__BUILD_LICENSES__ || {})
        .filter(([, e]) => e && typeof e === 'object')
        .sort(([a], [b]) => a.localeCompare(b));
      if (vendored.length > 0) {
        const details = document.createElement('details');
        details.className = 'about-vendored';
        const summary = document.createElement('summary');
        summary.textContent = `Third-party components (${vendored.length})`;
        details.appendChild(summary);

        const list = document.createElement('ul');
        for (const [name, entry] of vendored) {
          const li = document.createElement('li');
          const nm = document.createElement('span');
          nm.className = 'about-vendored-name';
          nm.textContent = name;
          li.appendChild(nm);
          if (entry.version) {
            const v = document.createElement('span');
            v.className = 'about-vendored-version';
            v.textContent = ' ' + entry.version;
            li.appendChild(v);
          }
          const sp = document.createElement('span');
          sp.className = 'about-vendored-spdx';
          sp.textContent = entry.spdx || 'UNKNOWN';
          li.appendChild(sp);
          if (typeof entry.text === 'string' && entry.text.length > 0) {
            const a = document.createElement('a');
            a.href = '#';
            a.className = 'about-vendored-link';
            a.textContent = 'LICENSE';
            a.title = `Open /sys/licenses/${name}/LICENSE`;
            a.onclick = (e) => {
              e.preventDefault();
              openPath(`/sys/licenses/${name}/LICENSE`);
              dialog.close();
            };
            li.appendChild(a);
          }
          list.appendChild(li);
        }
        details.appendChild(list);
        wrap.appendChild(details);
      }

      const author = document.createElement('div');
      author.className = 'about-author';
      author.innerHTML = 'Arthur Endlein Correia &middot; '
        + '<a href="https://gentropic.org" target="_blank" rel="noopener">Geoscientific Chaos Union</a>';
      wrap.appendChild(author);

      body.appendChild(wrap);
    },
  });
  await dialog.show();
}
