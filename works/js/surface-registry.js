// The surface registry — every surface kind Works can host
// (auditable-works-spec §6). A project's project.json `kind` names an entry
// directly; a loose file dispatches by extension.

const KINDS = new Map();   // kind → { url, label, icon, extensions }

export function registerKind(kind, def) {
  KINDS.set(kind, {
    url:        def.url,
    label:      def.label || kind,
    icon:       def.icon || '■',
    extensions: def.extensions || [],
  });
}

export function kindDef(kind) {
  return KINDS.get(kind) || null;
}

// The surface kind that handles a loose file, by extension — or null.
export function kindForExtension(filename) {
  const i = filename.lastIndexOf('.');
  const ext = i >= 0 ? filename.slice(i).toLowerCase() : '';
  if (!ext) return null;
  for (const [kind, def] of KINDS) {
    if (def.extensions.includes(ext)) return kind;
  }
  return null;
}

// Built-in kinds.

// The Auditable notebook — a project directory (project.json kind:'notebook'
// + notebook.txt + data siblings). The same auditable.html that runs
// standalone; it detects the Works iframe and boots as a surface.
registerKind('notebook', {
  url:        'auditable.html',
  label:      'Notebook',
  icon:       '▦',
  extensions: [],
});

registerKind('stub', {
  url:        'works/surfaces/stub.html',
  label:      'Stub project',
  icon:       '◈',
  extensions: [],
});

// The text editor — the loose-file surface. Opens any plain-text file.
registerKind('text', {
  url:        'works/surfaces/text.html',
  label:      'Text file',
  icon:       '▤',
  extensions: ['.txt', '.md', '.json', '.js', '.css', '.html',
               '.csv', '.log', '.xml', '.yaml', '.yml'],
});

// The A-Bus inspector — a diagnostic surface, spawned from the Debug menu
// (not tied to a VFS path).
registerKind('inspector', {
  url:        'works/surfaces/inspector.html',
  label:      'A-Bus Inspector',
  icon:       '◉',
  extensions: [],
});
