// Theme bootstrap for Works surfaces. Inlined into each surface's <script>
// block at build time (build.js replaces /* @theme-init */ with this file).
//
// The surface's existing welcome handler is responsible for calling
// installThemeSubscription(bus) AFTER the bus is connected. That sets
// <html data-theme> from the workspace's current setting and subscribes
// to Shell.SettingsChanged for live updates.
//
// First-paint correctness: each surface's <html> tag has data-theme="dark"
// baked in, so the initial render before the welcome message arrives is
// always dark. If the user has light selected, the post-welcome subscription
// flips it within a frame.

function _applyTheme(theme) {
  const r = document.documentElement;
  if (!theme || theme === 'system') {
    r.removeAttribute('data-theme');
  } else {
    r.setAttribute('data-theme', theme);
  }
}

async function installThemeSubscription(bus) {
  if (!bus) return;
  try {
    const settings = await bus.call(
      { to: 'works', path: '/', interface: 'Settings', member: 'Get' }, []);
    _applyTheme(settings && settings.appearance && settings.appearance.theme);
  } catch { /* settings interface unavailable — keep dark default */ }
  try {
    bus.subscribe(
      { interface: 'Shell', member: 'SettingsChanged', from: 'works' },
      (msg) => {
        const next = msg && msg.args && msg.args[0];
        _applyTheme(next && next.appearance && next.appearance.theme);
      });
  } catch { /* */ }
}
