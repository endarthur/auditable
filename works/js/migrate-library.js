// ⚠ TEMPORARY — one-time pre-1.0 layout migration. REMOVE this module + its
// call in init.js once existing workspaces have moved (a few releases out).
// Tracked in the project-works-rebuild memory.
//
// Moves the old books-centric layout to the kind-neutral content library:
//   /home/.books/library/<name>/  →  /home/library/books/<name>/
//   /home/.books/state/<slug>.json →  /home/library/.state/<slug>.json
//   /home/.books/.installed.json   →  /home/library/.installed.json
// then drops /home/.books. Idempotent: a no-op once /home/.books is gone.
// Conservative: if any move fails, the old root is kept (never destroys data).

import { LIBRARY, BOOKS_DIR, STATE_DIR, LEDGER } from './paths.js';

export async function migrateLibraryLayout(vfs) {
  if (!(await vfs.exists('/home/.books'))) return false;   // already migrated / fresh

  await vfs.mkdir(BOOKS_DIR, { recursive: true }).catch(() => {});
  await vfs.mkdir(STATE_DIR, { recursive: true }).catch(() => {});
  let failed = false;

  const moveChildren = async (fromDir, toDir) => {
    if (!(await vfs.exists(fromDir))) return;
    let entries = [];
    try { entries = await vfs.readdir(fromDir, { stat: true }); } catch { failed = true; return; }
    for (const e of entries) {
      const name = typeof e === 'string' ? e : e.name;
      try { await vfs.rename(fromDir + '/' + name, toDir + '/' + name); }
      catch { failed = true; }
    }
  };

  await moveChildren('/home/.books/library', BOOKS_DIR);
  await moveChildren('/home/.books/state', STATE_DIR);

  if (await vfs.exists('/home/.books/.installed.json')) {
    try { await vfs.rename('/home/.books/.installed.json', LEDGER); }
    catch { failed = true; }
  }

  if (!failed) {
    await vfs.rm('/home/.books', { recursive: true }).catch(() => {});
    console.info('[works] migrated /home/.books → ' + LIBRARY);
  } else {
    console.warn('[works] library migration incomplete — kept /home/.books');
  }
  return true;
}
