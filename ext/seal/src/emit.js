// @gcu/seal — emit: the generic, pure half. From the built artifact's bytes + a
// hand-authored capability template, produce the four artifacts the security wing
// wants: a full-file SHA-256, capability.json (dynamic fields filled), csp.txt
// (extracted from the file's OWN <meta> so it can't drift), and a CycloneDX SBOM.
//
// Node-only today (node:crypto). The string ops are environment-agnostic; swap the
// hash for Web Crypto to run this over a @gcu/vfs adapter in-browser later.
import { createHash } from 'node:crypto';

export function sha256(bytes) {
  return createHash('sha256').update(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)).digest('hex');
}

// Pull the Content-Security-Policy from the artifact's own
// <meta http-equiv="Content-Security-Policy" content="…">. Single source of truth →
// csp.txt can never drift from what actually runs. null if the file sets CSP by header.
export function extractCsp(html) {
  // Backref the opening quote so a double-quoted attribute can carry the CSP's own
  // single quotes ('none','self') — [^"'] would stop at the first inner quote.
  const m = String(html).match(/<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*content=(["'])([\s\S]*?)\1/i);
  return m ? m[2].replace(/\s+/g, ' ').trim() : null;
}

export function cspToLines(csp) {
  return csp ? csp.split(';').map((s) => s.trim()).filter(Boolean) : [];
}

// csp.txt body — a short header comment + one directive per line (the wing's shape).
export function cspText(csp, toolName = 'this artifact') {
  const lines = cspToLines(csp);
  if (!lines.length) return '';
  return `# The exact Content-Security-Policy ${toolName} is built and verified to run under.\n`
    + `# Emitted by @gcu/seal from the artifact's own <meta>; tighten further if your environment requires.\n\n`
    + lines.map((l, i) => l + (i < lines.length - 1 ? ';' : ';')).join('\n') + '\n';
}

// CycloneDX 1.5 SBOM. deps = [{ name, version?, license? }]; empty for a zero-dep tool.
export function buildSbom({ name, version, deps = [] }) {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    metadata: { component: { type: 'application', name, version: version || '0.0.0' } },
    components: deps.map((d) => ({
      type: 'library', name: d.name, version: d.version || '0.0.0',
      ...(d.license ? { licenses: [{ license: { id: d.license } }] } : {}),
      ...(d.copyright ? { copyright: d.copyright } : {}),
    })),
  };
}

// Emit the four artifacts. `template` is the per-tool hand-authored capability.json
// with static claims (profile, flags, executes/reach/filesystem/host_needs); emit
// fills the FACTS (version, sha256, the real csp). Returns the objects + csp.txt body;
// the caller writes them (and stages them into the security wing per release).
export function emitArtifacts({ bytes, template, deps = [], version, doi } = {}) {
  if (!bytes) throw new Error('@gcu/seal emit: bytes required');
  if (!template || !template.profile) throw new Error('@gcu/seal emit: template with a profile required');
  const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
  const hash = sha256(bytes);
  const name = template.tool || 'tool';
  const ver = version ?? template.version;
  const csp = extractCsp(text) || (template.host_needs && template.host_needs.csp) || null;

  const capability = {
    ...template,
    version: ver,
    sha256: hash,
    ...(doi ? { doi } : {}),
    host_needs: { ...(template.host_needs || {}), ...(csp ? { csp } : {}) },
  };
  const sbom = buildSbom({ name, version: ver, deps });
  return { sha256: hash, capability, csp, cspText: cspText(csp, name), sbom };
}
