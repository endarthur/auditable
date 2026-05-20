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

// Built-in kinds. The Auditable notebook surface arrives in Chunk 4; until
// then the stub surface stands in for the `stub` kind.
registerKind('stub', {
  url:        'works/surfaces/stub.html',
  label:      'Stub project',
  icon:       '◈',
  extensions: [],
});
