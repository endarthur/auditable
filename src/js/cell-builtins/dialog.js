// Dialog builtins: confirm, prompt, alert, dialog (custom).
// Wraps @gcu/dialog with cell-aware lifecycle: any open dialog spawned by
// a cell is auto-dismissed when the cell re-runs (invalidation fires),
// so a stale "Are you sure?" from the previous slider position doesn't
// linger after a drag.
//
// Pass { persistent: true } to opt out of auto-dismiss — useful for
// information-only modals (alerts) that should outlive the cell that
// spawned them.

import { Dialog, confirm as _confirm, prompt as _prompt, alert as _alert } from '#dialog';

export function makeDialog(cell, ctx) {
  const { invalidation } = ctx;

  // Track open dialog instances spawned by this cell run. On invalidation,
  // each is closed so transient prompts don't survive a re-execution.
  const _open = new Set();
  let _stale = false;
  invalidation.then(() => {
    _stale = true;
    for (const d of _open) {
      try { d.close(null); } catch (_) { /* ignore — already closed */ }
    }
    _open.clear();
  });

  // Wrap a Dialog instance so its open/close lifecycle is tracked, and
  // honour { persistent } to skip the auto-dismiss subscription.
  function track(dialog, opts) {
    if (opts?.persistent) return dialog;
    _open.add(dialog);
    // The Promise from .show() resolves when the dialog closes (via any path);
    // remove from the open set then so we don't try to close it twice.
    return dialog;
  }

  function confirm(message, opts = {}) {
    if (_stale) return Promise.resolve(false);
    // The convenience confirm() returns a Promise<boolean>. To support
    // cell-scoped dismissal we need access to the underlying Dialog; build
    // one ourselves using the same shape as the convenience helper.
    const dlg = new Dialog({
      title: opts.title ?? null,
      width: opts.width,
      closable: opts.closable ?? true,
      backdropDismiss: opts.backdropDismiss ?? true,
      render(body, ctx) {
        const msg = document.createElement('div');
        msg.className = 'gcu-dialog-message';
        msg.textContent = message;

        const buttons = document.createElement('div');
        buttons.className = 'gcu-dialog-buttons';
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'gcu-dialog-button';
        cancelBtn.textContent = opts.cancelLabel ?? 'cancel';
        cancelBtn.onclick = () => ctx.close(false);
        const okBtn = document.createElement('button');
        okBtn.className = 'gcu-dialog-button' + (opts.danger ? ' gcu-dialog-button-danger' : ' accent');
        okBtn.textContent = opts.okLabel ?? 'ok';
        okBtn.dataset.default = 'true';
        okBtn.onclick = () => ctx.close(true);
        buttons.append(cancelBtn, okBtn);

        body.append(msg, buttons);
      },
    });
    track(dlg, opts);
    return dlg.show().then(v => {
      _open.delete(dlg);
      return v === true;  // null (Esc/backdrop) → false
    });
  }

  function prompt(message, opts = {}) {
    if (_stale) return Promise.resolve(null);
    const def = opts.defaultValue ?? '';
    const dlg = new Dialog({
      title: opts.title ?? null,
      width: opts.width,
      closable: opts.closable ?? true,
      backdropDismiss: opts.backdropDismiss ?? true,
      render(body, ctx) {
        const msg = document.createElement('div');
        msg.className = 'gcu-dialog-message';
        msg.textContent = message;

        const input = document.createElement('input');
        input.className = 'gcu-dialog-input';
        input.type = 'text';
        input.value = def;
        if (opts.placeholder) input.placeholder = opts.placeholder;

        const buttons = document.createElement('div');
        buttons.className = 'gcu-dialog-buttons';
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'gcu-dialog-button';
        cancelBtn.textContent = opts.cancelLabel ?? 'cancel';
        cancelBtn.onclick = () => ctx.close(null);
        const okBtn = document.createElement('button');
        okBtn.className = 'gcu-dialog-button accent';
        okBtn.textContent = opts.okLabel ?? 'ok';
        okBtn.dataset.default = 'true';
        okBtn.onclick = () => ctx.close(input.value);
        buttons.append(cancelBtn, okBtn);

        // Enter in the input submits.
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); ctx.close(input.value); }
        });
        body.append(msg, input, buttons);
        // Defer focus so the Dialog's own focus management has run first.
        setTimeout(() => { input.focus(); input.select(); }, 0);
      },
    });
    track(dlg, opts);
    return dlg.show().then(v => {
      _open.delete(dlg);
      return v;
    });
  }

  function alert(message, opts = {}) {
    if (_stale) return Promise.resolve();
    const dlg = new Dialog({
      title: opts.title ?? null,
      width: opts.width,
      closable: opts.closable ?? true,
      backdropDismiss: opts.backdropDismiss ?? true,
      render(body, ctx) {
        const msg = document.createElement('div');
        msg.className = 'gcu-dialog-message';
        msg.textContent = message;

        const buttons = document.createElement('div');
        buttons.className = 'gcu-dialog-buttons';
        const okBtn = document.createElement('button');
        okBtn.className = 'gcu-dialog-button accent';
        okBtn.textContent = opts.okLabel ?? 'ok';
        okBtn.dataset.default = 'true';
        okBtn.onclick = () => ctx.close(true);
        buttons.append(okBtn);

        body.append(msg, buttons);
      },
    });
    track(dlg, opts);
    return dlg.show().then(() => {
      _open.delete(dlg);
    });
  }

  // Custom render — for forms, choosers, anything beyond confirm/prompt/alert.
  // Pass through the @gcu/dialog config; subscribe to invalidation unless
  // { persistent: true }.
  function dialog(config = {}) {
    if (_stale) return Promise.resolve(null);
    const { persistent, ...rest } = config;
    const dlg = new Dialog(rest);
    track(dlg, { persistent });
    return dlg.show().then(v => {
      _open.delete(dlg);
      return v;
    });
  }

  return { confirm, prompt, alert, dialog };
}
