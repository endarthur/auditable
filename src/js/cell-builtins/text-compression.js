// gzip + base64 round-trip for module source storage.
// Used by modules.js (install / load) to keep _installedModules small
// inside saved notebooks.

function uint8ToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export async function compressText(str) {
  const bytes = new TextEncoder().encode(str);
  const cs = new CompressionStream('gzip');
  const stream = new Blob([bytes]).stream().pipeThrough(cs);
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  return uint8ToBase64(compressed);
}

export async function decompressText(base64) {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Response(stream).text();
}

export { uint8ToBase64 };
