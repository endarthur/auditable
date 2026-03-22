// @gcu/vfs service worker — intercepts /_vfs/ URLs
// Standalone file, NOT bundled. Register separately.

const VFS_PREFIX = '/_vfs/';

const MIME_TABLE = {
  csv: 'text/csv', json: 'application/json', txt: 'text/plain',
  html: 'text/html', js: 'text/javascript', mjs: 'text/javascript',
  css: 'text/css', wasm: 'application/wasm', png: 'image/png',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  svg: 'image/svg+xml', pdf: 'application/pdf',
};

function mimeFromPath(p) {
  const dot = p.lastIndexOf('.');
  if (dot <= 0) return 'application/octet-stream';
  const ext = p.slice(dot + 1).toLowerCase();
  return MIME_TABLE[ext] || 'application/octet-stream';
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith(VFS_PREFIX)) return;

  const vfsPath = '/' + url.pathname.slice(VFS_PREFIX.length);

  event.respondWith(
    new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => {
        if (e.data.error) {
          resolve(new Response(e.data.error, { status: 404 }));
        } else {
          const mime = mimeFromPath(vfsPath);
          resolve(new Response(e.data.content, {
            headers: { 'Content-Type': mime },
          }));
        }
      };
      // Ask main thread to read from VFS
      self.clients.matchAll().then(clients => {
        if (clients.length > 0) {
          clients[0].postMessage({ type: 'vfs-read', path: vfsPath }, [ch.port2]);
        } else {
          resolve(new Response('No active client', { status: 503 }));
        }
      });
    })
  );
});
