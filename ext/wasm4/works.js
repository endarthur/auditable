// @gcu/wasm4 — shell-context entry (surface registration). EXTENSION_SPEC §2.5 + §3.8.
//
// Evaluated by the Works shell at install time AND on every boot
// (evaluateAllWorksScripts), registering the WASM-4 console surface so a `.w4`
// cart opens here (spawnSurface('wasm4')).
//
// Self-contained: this package's index.js IS the WASM-4 engine, installed to
// /lib/@gcu/wasm4/source. The surface's `requires: ['wasm4']` resolves to that
// own source at spawn (ensureLibSource), so there's no external lib dep / no
// dep-closure to pull. Hand-authored (the engine has its own build; this file
// and surface.html are not generated).

const WASM4_VERSION = '0.1.0';

if (typeof window !== 'undefined') {
  const register = window.auditable?.registerExtension;
  if (register) {
    register({
      name: '@gcu/wasm4',
      version: WASM4_VERSION,
      description: 'WASM-4 fantasy console — runs a conformant .wasm cart over the @gcu/wasm4 engine; spawns with a baked demo cart when path-less.',
      surfaces: [
        {
          kind:       'wasm4',
          label:      'WASM-4',
          icon:       '◰',
          file:       'surface.html',
          extensions: ['.w4'],
          requires:   ['abus', 'surface', 'wasm4'],
        },
      ],
    });
  }
}
