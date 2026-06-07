// @gcu/sync — content addressing for the blob lane. Pure, zero-dep (deliberately
// self-contained — same b64url output as @gcu/capsule, but no dependency, so the
// package stays a leaf). `crypto` is the Web Crypto global (browsers + Node ≥ 20).
//
// Lifted from hopper's records/address.js (the sync-relevant subset).

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// Unpadded, URL-safe base64 of a byte sequence.
export function bytesToB64Url(input) {
  const b = new Uint8Array(input);
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const rem = b.length - i;
    const n = (b[i] << 16) | ((rem > 1 ? b[i + 1] : 0) << 8) | (rem > 2 ? b[i + 2] : 0);
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63];
    if (rem > 1) out += B64URL[(n >> 6) & 63];
    if (rem > 2) out += B64URL[n & 63];
  }
  return out;
}

// Inverse of bytesToB64Url. Tolerates the unpadded URL-safe form.
export function b64UrlToBytes(s) {
  const std = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = std.length % 4 ? '='.repeat(4 - (std.length % 4)) : '';
  const bin = atob(std + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

// `sha256-<b64url>` — the content address of a blob. The hash IS the integrity
// check: the blob lane re-derives this on receipt and drops any mismatch.
export async function contentAddress(bytes) {
  return 'sha256-' + bytesToB64Url(await sha256(bytes));
}
