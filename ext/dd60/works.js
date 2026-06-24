// @gcu/dd60 — shell-context entry (surface registration). EXTENSION_SPEC §2.5 + §3.8.
//
// The DD-60 "DADA Diskman" — a retro reader skin (de-branded Sony Data Discman
// homage) reading exactly what the Book surface reads. An easter-egg surface;
// Library-installable, not in the default profiles. Same lib deps as book.

const DD60_VERSION = '0.1.0';

if (typeof window !== 'undefined') {
  const register = window.auditable?.registerExtension;
  if (register) {
    register({
      name: '@gcu/dd60',
      version: DD60_VERSION,
      description: 'DADA Diskman — a retro reader skin over the same book.json content as the Book reader.',
      surfaces: [
        {
          kind:     'dd60',
          label:    'DADA Diskman',
          icon:     '▥',
          file:     'surface.html',
          requires: ['abus', 'surface', 'markdown', 'docview', 'katex', 'librarian', 'reader-core'],
        },
      ],
    });
  }
}
