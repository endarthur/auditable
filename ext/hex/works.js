// @gcu/hex — shell-context entry (surface registration). EXTENSION_SPEC §2.5 + §3.8.
//
// The Works shell evaluates this at install time AND on every boot
// (evaluateAllWorksScripts). It runs in the shell window, registering the Hex
// viewer surface so the tree's "Open as…" (the universal any-bytes fallback)
// and the surface registry can find it.
//
// Hex contributes ONLY a surface (no service) — a self-contained static
// surface.html with no lib inlining beyond the universal @gcu/surface +
// @gcu/abus base. Hand-authored (no src/ build): there's nothing to generate.

const HEX_VERSION = '0.1.0';

if (typeof window !== 'undefined') {
  const register = window.auditable?.registerExtension;
  if (register) {
    register({
      name: '@gcu/hex',
      version: HEX_VERSION,
      description: 'Hex viewer — a universal loose-file surface for raw binary: virtualized hex/ASCII view + a data inspector. The any-bytes floor.',

      // §3.8.1 — the Hex viewer surface. `universal: true` makes it the
      // any-bytes fallback (tree.js orders universal viewers first in
      // "Open as…"); `extensions` claim the common raw-binary suffixes.
      surfaces: [
        {
          kind:       'hex',
          label:      'Hex viewer',
          icon:       '⬡',
          file:       'surface.html',
          universal:  true,
          extensions: ['.bin', '.dat', '.hex', '.wasm', '.img', '.rom'],
          requires:   ['abus', 'surface'],
        },
      ],
    });
  }
}
