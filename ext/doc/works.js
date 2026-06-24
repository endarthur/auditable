// @gcu/doc — shell-context entry (surface registration). EXTENSION_SPEC §2.5 + §3.8.
//
// Evaluated by the Works shell at install time AND on every boot, registering
// the Document surface (Markdown editor + live preview). `universal: true` makes
// it an any-file fallback; it claims .md/.markdown.
//
// Lib deps (archive/epub/template/yaml) are declared in package.json
// gcu.requires so the dep-closure installs them into /lib; markdown + menu are
// baked CORE_LIBS. `requires` below lists the full inline set so the spawn path
// resolves each from the lib store before inlining.

const DOC_VERSION = '0.1.0';

if (typeof window !== 'undefined') {
  const register = window.auditable?.registerExtension;
  if (register) {
    register({
      name: '@gcu/doc',
      version: DOC_VERSION,
      description: 'Document editor — Markdown with live preview, frontmatter, {{template}} interpolation, and EPUB export.',
      surfaces: [
        {
          kind:       'doc',
          label:      'Document',
          icon:       '▥',
          file:       'surface.html',
          universal:  true,
          extensions: ['.md', '.markdown'],
          requires:   ['abus', 'surface', 'menu', 'markdown', 'template', 'yaml', 'epub', 'archive', 'cm6'],
        },
      ],
    });
  }
}
