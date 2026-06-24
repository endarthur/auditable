// @gcu/encode — shell-context entry (surface registration). EXTENSION_SPEC §2.5 + §3.8.
//
// Evaluated by the Works shell at install time AND on every boot
// (evaluateAllWorksScripts), registering the Encode / Hash surface so the
// Tools menu (spawnSurface('encode')) can find it. A path-less tool — no
// `extensions` (not a file opener). Surface-only, no service; hand-authored
// (no src/ build).

const ENCODE_VERSION = '0.1.0';

if (typeof window !== 'undefined') {
  const register = window.auditable?.registerExtension;
  if (register) {
    register({
      name: '@gcu/encode',
      version: ENCODE_VERSION,
      description: 'Encode / Hash — base64/hex/url/json transforms + SHA-1/256/512 via Web Crypto. A path-less Tools-menu surface.',
      surfaces: [
        {
          kind:     'encode',
          label:    'Encode / Hash',
          icon:     '⇄',
          file:     'surface.html',
          requires: ['abus', 'surface'],
        },
      ],
    });
  }
}
