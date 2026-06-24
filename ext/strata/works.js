// @gcu/strata — shell-context entry (surface registration). EXTENSION_SPEC §2.5 + §3.8.
//
// The Strata surface — an auditable column-oriented table (.strata documents).
// Self-contained: this package's index.js IS the @gcu/strata table lib
// (→ /lib/@gcu/strata/source). The surface imports the shared strata APP core
// (@gcu/strata-app, sourced from tools/strata), which in turn inlines
// @gcu/strata + loom/over/archive/recon — all pulled via gcu.requires.
//
// `requires` lists strata-app FIRST among the non-baked libs: the inliner
// iterates the lib store in load order, and strata-app must inline first so its
// own @gcu/strata / @gcu/loom / … imports are present for the later libs to fill.

const STRATA_VERSION = '0.1.0';

if (typeof window !== 'undefined') {
  const register = window.auditable?.registerExtension;
  if (register) {
    register({
      name: '@gcu/strata',
      version: STRATA_VERSION,
      description: 'Strata — an auditable reactive column-table (immutable base + value-patch overlay; per-column formulas; sift filter; group-by; native .strata zip).',
      surfaces: [
        {
          kind:       'strata',
          label:      'Strata',
          icon:       '▦',
          file:       'surface.html',
          extensions: ['.strata'],
          requires:   ['abus', 'surface', 'strata-app', 'strata', 'loom', 'over', 'archive', 'recon'],
        },
      ],
    });
  }
}
