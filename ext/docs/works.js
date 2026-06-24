// @gcu/docs — shell-context entry (surface registration). EXTENSION_SPEC §2.5 + §3.8.
//
// The Documentation browser — a path-less surface (Tools/Help menu) over the
// registry's docs. Lib deps docview/librarian via gcu.requires; markdown is a
// baked CORE_LIB.

const DOCS_VERSION = '0.1.0';

if (typeof window !== 'undefined') {
  const register = window.auditable?.registerExtension;
  if (register) {
    register({
      name: '@gcu/docs',
      version: DOCS_VERSION,
      description: 'Documentation browser — full-pane shelf over the content registry with full-text search.',
      surfaces: [
        {
          kind:     'docs',
          label:    'Documentation',
          icon:     '?',
          file:     'surface.html',
          requires: ['abus', 'surface', 'markdown', 'docview', 'librarian'],
        },
      ],
    });
  }
}
