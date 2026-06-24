// @gcu/plate — shell-context entry (surface registration). EXTENSION_SPEC §2.5 + §3.8.
//
// The Plate surface — a figure compositor (a page of linked, live panels).
// Self-contained: this package's index.js IS the @gcu/plate compositor lib
// (→ /lib/@gcu/plate/source). The surface imports @gcu/plate (own source) plus
// the @gcu/strata table lib, @gcu/recon, and @gcu/archive — pulled via
// gcu.requires (strata brings the @gcu/strata package). Opens .strata/.csv/.tsv.

const PLATE_VERSION = '0.1.0';

if (typeof window !== 'undefined') {
  const register = window.auditable?.registerExtension;
  if (register) {
    register({
      name: '@gcu/plate',
      version: PLATE_VERSION,
      description: 'Plate — a figure compositor: a page of linked, live panels (scatter + selection linking) over GCU domain libs.',
      surfaces: [
        {
          kind:       'plate',
          label:      'Plate (figure)',
          icon:       '◫',
          file:       'surface.html',
          // .strata only — a .csv/.tsv opens in the data viewer (preview) by
          // default; reach Plate explicitly (menu / Open as…) for a figure.
          extensions: ['.strata'],
          requires:   ['abus', 'surface', 'plate', 'strata', 'recon', 'archive'],
        },
      ],
    });
  }
}
