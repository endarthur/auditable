// Shared mutable state for the Works shell. One object, like auditable's `S`.

export const WKS = {
  broker:  null,   // the A-Bus broker            (bus.js)
  vfs:     null,   // the workspace VFS           (workspace.js)
  rails:   null,   // the @gcu/rails instance     (layout.js)
  menubar: null,   // the @gcu/menu MenuBar       (menubar.js)
};

export const $ = (sel) => document.querySelector(sel);

// Write a message to the statusbar.
export function setStatus(msg) {
  const el = document.getElementById('works-status');
  if (el) el.textContent = msg;
}
