// @gcu/patchbay — shell-context entry (surface registration). EXTENSION_SPEC §2.5 + §3.8.
//
// The Patchbay surface — a punk-SCADA Eurorack rack of sideact-reactive modules
// wired by patch cables (cables = real reactive deps). Self-contained: this
// package's index.js IS the patchbay engine (→ /lib/@gcu/patchbay/source), which
// the surface imports as @gcu/patchbay. @gcu/sideact is pulled via gcu.requires;
// menu is a baked CORE_LIB. Claims `.patchbay` documents.

const PATCHBAY_VERSION = '0.1.0';

if (typeof window !== 'undefined') {
  const register = window.auditable?.registerExtension;
  if (register) {
    register({
      name: '@gcu/patchbay',
      version: PATCHBAY_VERSION,
      description: 'Patchbay — a Eurorack-style reactive dataflow rack; modules with knobs/jacks/displays, patch cables are real reactive dependencies.',
      surfaces: [
        {
          kind:       'patchbay',
          label:      'Patchbay',
          icon:       '⊞',
          file:       'surface.html',
          extensions: ['.patchbay'],
          requires:   ['abus', 'surface', 'menu', 'sideact', 'patchbay'],
        },
      ],
    });
  }
}
