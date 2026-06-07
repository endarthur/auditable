// Re-export stub for @gcu/sync — used by presence.js at dev/test time.
// At build time, processModulesAsRegistry rewrites './sync.js' → '#sync',
// and the actual sync bundle (ext/sync/index.js) is loaded via the import map.
export { syncSession, trysteroChannel, roomPresence, contentAddress, bytesToB64Url, b64UrlToBytes } from '../../ext/sync/index.js';
