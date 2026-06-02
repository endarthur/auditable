// Reinstall executor — the consume side of the lean-export story.
//
// When a workspace is exported with re-installable content set to "reinstall
// on open" (export-dialog.js), the bulk is dropped but a recipe travels:
// /home/.works/reinstall.json plus the kept manifests (.gcu-lock.json for
// extensions, .installed.json + reading state for library packs). On open this
// detects what's actually missing, prompts once (it fetches from the network
// and extensions are code), and restores via the same installers Browse
// Library uses — installByName for library/gcupkg entries, a fetch +
// installGcupkgBytes for extensions pinned to a direct .gcupkg URL.

import { WKS, setStatus } from './state.js';
import { confirm as dlgConfirm } from '#dialog';
import { installByName, addSourceSilent } from './registry.js';
import { installGcupkgBytes } from './file-ops.js';
import { getInstalled } from './gcudat-install.js';
import { destFor } from './paths.js';

const RECIPE_PATH = '/home/.works/reinstall.json';

/** Read /home/.works/reinstall.json, or null when absent/garbage. */
export async function readRecipe(vfs = WKS.vfs) {
  try { return JSON.parse(await vfs.readFile(RECIPE_PATH, 'utf8')); }
  catch { return null; }
}

/** Narrow a recipe to what's actually missing on disk — a content pack is
 *  missing when its install dir is gone, an extension when its /lib dir is.
 *  The pack's dir comes from the kept ledger (its recorded `dest`/`datKind`),
 *  not a hardcoded books path, so data packs are handled too. */
export async function planReinstall(vfs, recipe) {
  const ledger = await getInstalled().catch(() => ({}));
  const library = [];
  for (const b of (recipe.library || [])) {
    if (!b || !b.id) continue;
    const rec = ledger[b.id] || {};
    const dir = rec.dest || destFor(b.datKind || rec.datKind, b.id);
    if (!(await vfs.exists(dir))) library.push(b);
  }
  const extensions = [];
  for (const e of (recipe.extensions || [])) {
    if (e && e.alias && !(await vfs.exists('/lib/' + e.alias))) extensions.push(e);
  }
  return { library, extensions };
}

async function _installExtFromUrl(e) {
  if (!e.url) throw new Error('no url for ' + (e.alias || 'extension'));
  const res = await fetch(e.url, { cache: 'no-cache' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  await installGcupkgBytes(new Uint8Array(await res.arrayBuffer()), (e.alias || 'ext') + '.gcupkg');
}

/**
 * Restore a plan. Installers are injectable for testing; defaults reuse the
 * proven Browse-Library / drag-drop paths. Returns { ok:[names], failed:[{name,err}] }.
 */
export async function runReinstall(plan, opts = {}) {
  const installLibrary = opts.installLibrary || (async (b) => {
    if (b.source) await addSourceSilent(b.source, b.source).catch(() => {});
    return installByName(b.source, b.id);
  });
  const installExtension = opts.installExtension || _installExtFromUrl;
  const ok = [], failed = [];
  for (const b of plan.library) {
    try {
      const dest = await installLibrary(b);
      if (dest === null) failed.push({ name: b.id, err: 'cancelled' });
      else ok.push(b.id);
    } catch (e) { failed.push({ name: b.id, err: (e && e.message) || String(e) }); }
  }
  for (const e of plan.extensions) {
    try { await installExtension(e); ok.push(e.alias); }
    catch (err) { failed.push({ name: e.alias, err: (err && err.message) || String(err) }); }
  }
  return { ok, failed };
}

async function _clearRecipe(vfs) {
  try { await vfs.unlink(RECIPE_PATH); } catch { /* already gone */ }
}

/**
 * Boot hook (fire-and-forget after the shell is ready). If the recipe lists
 * content that's missing, prompt + restore. On full success the recipe is
 * dropped so we don't ask again; on partial/declined it's kept for next open.
 */
export async function maybePromptReinstall() {
  const vfs = WKS.vfs;
  const recipe = await readRecipe(vfs);
  if (!recipe) return;
  const plan = await planReinstall(vfs, recipe);
  if (plan.library.length + plan.extensions.length === 0) { await _clearRecipe(vfs); return; }

  const libList = plan.library.map((b) => '  • ' + b.id + (b.version ? ' ' + b.version : '')).join('\n');
  const extList = plan.extensions.map((e) => '  • ' + e.alias + (e.version ? ' ' + e.version : '')).join('\n');
  const sources = [...new Set([
    ...plan.library.map((b) => b.source),
    ...plan.extensions.map((e) => e.url),
  ].filter(Boolean))];
  const body = 'This workspace was exported lean — some content travels as a recipe '
    + 'instead of being bundled:\n\n'
    + (libList ? 'Library packs:\n' + libList + '\n\n' : '')
    + (extList ? 'Extensions (code — run in your workspace):\n' + extList + '\n\n' : '')
    + 'Reinstall now? Fetches from:\n' + sources.map((s) => '  ' + s).join('\n');
  const ok = await dlgConfirm(body, {
    title: 'Reinstall workspace content',
    danger: plan.extensions.length > 0,
  });
  if (!ok) { setStatus('reinstall skipped — recipe kept'); return; }

  setStatus('reinstalling…');
  const res = await runReinstall(plan, { vfs });
  if (res.failed.length === 0) {
    await _clearRecipe(vfs);
    setStatus('reinstalled ' + res.ok.length + ' item' + (res.ok.length === 1 ? '' : 's'));
  } else {
    setStatus('reinstalled ' + res.ok.length + ', ' + res.failed.length + ' failed — recipe kept');
    console.warn('[works] reinstall failures:', res.failed);
  }
  if (res.ok.length && typeof WKS.refreshTree === 'function') await WKS.refreshTree().catch(() => {});
}
