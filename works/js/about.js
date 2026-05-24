// Help → About Auditable Works — a real modal (the menubar's `help:about`
// previously fell through to a setStatus stub).
//
// Build-time injection: the constants below are placeholders that
// build.js's works branch rewrites to the real values. Source of truth
// lives in package.json + the build environment; runtime never edits.

import { Dialog } from '#dialog';

const __AUDITABLE_VERSION__ = '0.0.0';
const __AUDITABLE_BUILD_DATE__ = 'dev';
const __AUDITABLE_RELEASE__ = 'dev';
const __AUDITABLE_PUBLIC_KEY__ = '';
const __AUDITABLE_REPO__ = 'endarthur/auditable';

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
