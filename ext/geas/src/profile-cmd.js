// profile — the geas-side of distribution profiles (gcu-distributions-spec).
// Lives alongside pkg-cmd.js; same shape: a worker-hosted builtin that
// delegates the shell-coupled work to Auditable Works over the host-RPC
// bridge (ctx.host → works Shell.Profile* methods). Absent host bridge →
// "Works only", like pkg's registry subcommands.
//
// Subcommands (v1):
//   profile list                 — baked distribution profiles (+ which is current)
//   profile current              — the workspace's provisioned marker
//   profile export [path]       — snapshot installed packages + settings as a
//                                  .gcuprofile; write to a VFS path or stdout
//   profile provision <name>    — provision a baked profile by name
//   profile provision <file|url> — provision a .gcuprofile from the VFS or a URL
//   profile help                 — usage
//
// Trust model: provisioning installs without per-package prompts (the user
// authorized the profile by invoking the command — same contract as the setup
// screen); any NEW registry source a profile declares still gets the shell's
// trust dialog before it's added.

async function _requireHost(ctx, sub) {
  if (typeof ctx.host === 'function') return true;
  await ctx.stderr(`profile ${sub}: distribution profiles are only available in Auditable Works\n`);
  return false;
}

async function _profileList(ctx) {
  if (!(await _requireHost(ctx, 'list'))) return 1;
  let profiles, marker;
  try {
    profiles = await ctx.host('ProfileList');
    marker = await ctx.host('ProfileProvisioned');
  } catch (e) { await ctx.stderr(`profile list: ${e.message}\n`); return 1; }
  if (!profiles || !profiles.length) {
    await ctx.stdout('(no baked profiles — this is a monolith build; profiles ship with works-core)\n');
    return 0;
  }
  for (const p of profiles) {
    const cur = marker && marker.profile === p.name ? '*' : ' ';
    const pkgs = (p.packages || []).length;
    await ctx.stdout(`${cur} ${String(p.name).padEnd(20)} ${String(pkgs + ' pkg' + (pkgs === 1 ? '' : 's')).padEnd(8)} ${p.title || ''}${p.description ? ' — ' + p.description : ''}\n`);
  }
  return 0;
}

async function _profileCurrent(ctx) {
  if (!(await _requireHost(ctx, 'current'))) return 1;
  let marker;
  try { marker = await ctx.host('ProfileProvisioned'); }
  catch (e) { await ctx.stderr(`profile current: ${e.message}\n`); return 1; }
  if (!marker) { await ctx.stdout('(not provisioned)\n'); return 0; }
  await ctx.stdout(`profile:   ${marker.profile}\n`);
  if (marker.at) await ctx.stdout(`when:      ${new Date(marker.at).toISOString()}\n`);
  if (marker.installed && marker.installed.length) await ctx.stdout(`installed: ${marker.installed.join(', ')}\n`);
  if (marker.failed && marker.failed.length) await ctx.stdout(`failed:    ${marker.failed.join(', ')}\n`);
  return 0;
}

// profile export [path] — no path prints the .gcuprofile JSON to stdout
// (redirectable: `profile export > my.gcuprofile`); with a path, writes the
// file and derives the profile name from its basename.
async function _profileExport(ctx, path) {
  if (!(await _requireHost(ctx, 'export'))) return 1;
  const opts = {};
  if (path) {
    const base = path.split('/').filter(Boolean).pop() || '';
    const name = base.replace(/\.gcuprofile$/i, '').trim();
    if (name) opts.name = name;
  }
  let spec;
  try { spec = await ctx.host('ProfileExport', [opts]); }
  catch (e) { await ctx.stderr(`profile export: ${e.message}\n`); return 1; }
  const json = JSON.stringify(spec, null, 2) + '\n';
  if (!path) { await ctx.stdout(json); return 0; }
  if (!ctx.vfs) { await ctx.stderr('profile export: no VFS in this context\n'); return 1; }
  try { await ctx.vfs.writeFile(path, json); }
  catch (e) { await ctx.stderr(`profile export: cannot write ${path}: ${e.message}\n`); return 1; }
  await ctx.stdout(`exported ${spec.name} → ${path} (${(spec.packages || []).length} packages)\n`);
  return 0;
}

// profile provision <name | vfs-path | url> — a baked profile by name, or a
// raw .gcuprofile read from the VFS / fetched from a URL.
async function _profileProvision(ctx, target) {
  if (!(await _requireHost(ctx, 'provision'))) return 1;
  if (!target) { await ctx.stderr('profile provision: needs a profile name, .gcuprofile path, or URL\n'); return 1; }

  const isUrl = /^https?:\/\//.test(target);
  const isPath = !isUrl && (target.includes('/') || /\.gcuprofile$/i.test(target));
  let report;
  try {
    if (isUrl || isPath) {
      let text;
      if (isUrl) {
        const resp = await fetch(target);
        if (!resp.ok) { await ctx.stderr(`profile provision: fetch ${target} failed (${resp.status})\n`); return 1; }
        text = await resp.text();
      } else {
        if (!ctx.vfs) { await ctx.stderr('profile provision: no VFS in this context\n'); return 1; }
        text = await ctx.vfs.readFile(target, 'utf8');
      }
      let spec;
      try { spec = JSON.parse(text); }
      catch { await ctx.stderr(`profile provision: ${target} is not valid .gcuprofile JSON\n`); return 1; }
      await ctx.stdout(`provisioning ${spec.title || spec.name || 'custom'}…\n`);
      report = await ctx.host('ProfileProvisionSpec', [spec]);
    } else {
      await ctx.stdout(`provisioning ${target}…\n`);
      report = await ctx.host('ProfileProvision', [target]);
    }
  } catch (e) { await ctx.stderr(`profile provision: ${e.message}\n`); return 1; }

  const inst = (report && report.installed) || [];
  const fail = (report && report.failed) || [];
  if (inst.length) await ctx.stdout(`installed: ${inst.join(', ')}\n`);
  if (!inst.length && !fail.length) await ctx.stdout('nothing to install (shell-only profile)\n');
  if (fail.length) {
    await ctx.stderr(`failed: ${fail.join(', ')} (offline? declined source? — re-run to retry)\n`);
    return 1;
  }
  return 0;
}

async function _profileHelp(ctx) {
  await ctx.stdout([
    'usage: profile <subcommand> [args...]',
    '',
    'subcommands:',
    '  list                       baked distribution profiles (* = current)',
    '  current                    this workspace\'s provisioned marker',
    '  export [path]              snapshot installed packages + settings as a',
    '                             .gcuprofile (no path → stdout)',
    '  provision <name>           provision a baked profile by name',
    '  provision <file|url>       provision a .gcuprofile from the VFS or a URL',
    '  help                       show this message',
    '',
    'Auditable Works only — profiles are a works-core (lean shell) feature;',
    'export also works in monolith builds (the snapshot is host-agnostic).',
    '',
  ].join('\n'));
  return 0;
}

export async function _profile(argv, ctx) {
  const sub = argv[1];
  switch (sub) {
    case undefined:
    case 'help':
    case '-h':
    case '--help':    return _profileHelp(ctx);
    case 'list':      return _profileList(ctx);
    case 'current':
    case 'status':    return _profileCurrent(ctx);
    case 'export':    return _profileExport(ctx, argv[2]);
    case 'provision': return _profileProvision(ctx, argv[2]);
    default:          await ctx.stderr(`profile: unknown subcommand "${sub}" (try 'profile help')\n`);
                      return 1;
  }
}
