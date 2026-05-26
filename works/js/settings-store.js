// Workspace settings persisted at /etc/works.json. Read at boot,
// written by the settings surface, signalled to other surfaces via
// Shell.SettingsChanged (see works-service.js).
//
// Storage home + mounts deliberately live elsewhere — those are
// per-machine state (a FileSystemDirectoryHandle can't roam between
// machines) and belong in the shell meta IndexedDB. /etc/works.json
// only holds settings that should travel with the workspace export.

const SETTINGS_PATH = '/etc/works.json';

const DEFAULTS = Object.freeze({
  version: 1,
  appearance: {
    theme: 'dark',          // 'dark' | 'light' | 'system'
    fontFamily: 'system',   // 'system' | 'embed'  (embed-fonts toggle)
    fontSize: 13,
    embedFonts: false,
  },
  // Text-editor surface preferences. Workspace-scoped (one config for
  // every open text tab) rather than per-file — most users expect
  // consistent behavior across files. Per-file overrides could land
  // as a future textEditor.perPath map.
  textEditor: {
    wrap: false,
    showLineNumbers: true,
    showStatusBar: true,
  },
});

function _merge(base, over) {
  if (over == null || typeof over !== 'object') return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = _merge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export async function readSettings(vfs) {
  try {
    const raw = await vfs.readFile(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return _merge(DEFAULTS, parsed);
  } catch {
    return { ...DEFAULTS };
  }
}

export async function writeSettings(vfs, settings) {
  await vfs.mkdir('/etc', { recursive: true }).catch(() => {});
  await vfs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

// Apply settings to the shell's own DOM so Works's chrome reflects
// the choice immediately (in addition to the SettingsChanged signal
// that notifies surfaces).
export function applyWorkspaceSettings(settings) {
  if (!settings || typeof document === 'undefined') return;
  const root = document.documentElement;
  const theme = settings.appearance?.theme || 'dark';
  if (theme === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
  const fs = settings.appearance?.fontSize;
  if (typeof fs === 'number') root.style.setProperty('--gcu-font-size', fs + 'px');
}
