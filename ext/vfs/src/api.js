// Public API for @gcu/vfs — plugin registration

if (typeof window !== 'undefined' && window.registerPlugin) {
  window.registerPlugin('@gcu/vfs', {
    description: 'Virtual filesystem with pluggable backends and mount table',
  });
}
