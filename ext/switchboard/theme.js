// @gcu/switchboard — theme helper (the "1KB JS" of SPEC §9).
//
// A tiny, dependency-free helper for STANDALONE / sibling consumers that want
// light/dark switching with no machinery: first-paint from storage or
// prefers-color-scheme, a persisted toggle, and a change event. Pairs with
// switchboard.css (which defines the tokens for :root = light and
// [data-theme="dark"] = dark on <html>).
//
// Auditable + Works do NOT use this — they have their own richer theme systems
// (settings.js / the workspace Settings surface + /home/nb/theme.css overrides).
// This is the on-ramp for a new tool that just wants the look + a toggle.
//
//   import { initTheme, toggleTheme, onThemeChange } from '@gcu/switchboard/theme';
//   initTheme();                       // call before first paint (in <head>)
//   button.onclick = () => toggleTheme();

const STORAGE_KEY = 'gcu-theme';
const root = () => document.documentElement;

function store(theme) {
  try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* private mode */ }
}
function stored() {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

/** The current theme: 'dark' if <html data-theme="dark">, else 'light'. */
export function getTheme() {
  return root().getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

/** Apply a theme ('light' | 'dark'), persist it, and emit `gcu:themechange`. */
export function applyTheme(theme) {
  const t = theme === 'dark' ? 'dark' : 'light';
  if (t === 'dark') root().setAttribute('data-theme', 'dark');
  else root().removeAttribute('data-theme');         // light is :root default
  store(t);
  try { window.dispatchEvent(new CustomEvent('gcu:themechange', { detail: { theme: t } })); } catch { /* SSR */ }
  return t;
}

/** Flip light ↔ dark. Returns the new theme. */
export function toggleTheme() {
  return applyTheme(getTheme() === 'dark' ? 'light' : 'dark');
}

/**
 * First-paint setup: apply the stored theme, else the OS preference. Call once,
 * as early as possible (ideally inline in <head>) to avoid a flash.
 * @param {object} [opts]
 * @param {'light'|'dark'} [opts.fallback='light'] - when no stored value + no OS signal.
 * @param {boolean} [opts.followSystem=true] - track OS changes until the user picks.
 */
export function initTheme(opts = {}) {
  const fallback = opts.fallback === 'dark' ? 'dark' : 'light';
  const saved = stored();
  let theme;
  if (saved === 'light' || saved === 'dark') {
    theme = saved;
  } else if (typeof window !== 'undefined' && window.matchMedia) {
    theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } else {
    theme = fallback;
  }
  // Apply without persisting an OS-derived choice (so it keeps following the OS
  // until the user explicitly toggles).
  if (theme === 'dark') root().setAttribute('data-theme', 'dark');
  else root().removeAttribute('data-theme');

  if (opts.followSystem !== false && !saved && typeof window !== 'undefined' && window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!stored()) {            // only while the user hasn't chosen
        root().setAttribute('data-theme', e.matches ? 'dark' : 'light');
      }
    });
  }
  return getTheme();
}

/** Subscribe to theme changes; returns an unsubscribe fn. */
export function onThemeChange(cb) {
  const h = (e) => cb(e.detail.theme);
  window.addEventListener('gcu:themechange', h);
  return () => window.removeEventListener('gcu:themechange', h);
}
