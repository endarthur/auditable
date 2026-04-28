// @gcu/dialog — convenience APIs: confirm, prompt, alert.
// Built on the Dialog primitive. Each returns a promise.

import { Dialog } from './dialog.js';
import { validateValue } from './helpers.js';

// ── confirm ──────────────────────────────────────────────────────────────

export function confirm(message, opts = {}) {
  return new Promise(resolve => {
    const dialog = new Dialog({
      title:    opts.title ?? null,
      parent:   opts.parent ?? null,
      backdrop: opts.backdrop ?? true,
      closable: opts.closable ?? false,   // convenience dialogs default to no ×
      render: (body, ctx) => {
        body.appendChild(makeMessage(message));
        body.appendChild(makeButtonRow([
          { label: opts.cancelLabel || 'Cancel', value: false },
          { label: opts.okLabel     || 'OK',     value: true,  isDefault: true, danger: !!opts.danger },
        ], ctx));
      },
    });
    dialog.show().then(result => resolve(result === true));
  });
}

// ── prompt ──────────────────────────────────────────────────────────────

export function prompt(message, opts = {}) {
  return new Promise(resolve => {
    const dialog = new Dialog({
      title:    opts.title ?? null,
      parent:   opts.parent ?? null,
      backdrop: opts.backdrop ?? true,
      closable: opts.closable ?? false,
      render: (body, ctx) => {
        body.appendChild(makeMessage(message));

        const input = opts.multiline
          ? document.createElement('textarea')
          : document.createElement('input');
        if (!opts.multiline) input.type = 'text';
        if (opts.defaultValue != null) input.value = opts.defaultValue;
        if (opts.placeholder) input.placeholder = opts.placeholder;
        input.className = 'gcu-dialog-input';
        input.setAttribute('autofocus', '');
        body.appendChild(input);

        const errorEl = document.createElement('div');
        errorEl.className = 'gcu-dialog-error';
        errorEl.setAttribute('role', 'alert');
        errorEl.hidden = true;
        body.appendChild(errorEl);

        const okBtn = makeButton({
          label: opts.okLabel || 'OK',
          value: null,
          isDefault: true,
        });
        okBtn.addEventListener('click', () => {
          ctx.close(input.value);
        });

        const cancelBtn = makeButton({
          label: opts.cancelLabel || 'Cancel',
          value: null,
        });
        cancelBtn.addEventListener('click', () => {
          ctx.close(null);
        });

        const row = document.createElement('div');
        row.className = 'gcu-dialog-buttons';
        row.append(cancelBtn, okBtn);
        body.appendChild(row);

        const recheck = () => {
          const { valid, error } = validateValue(input.value, opts.validate);
          okBtn.disabled = !valid;
          if (error) {
            errorEl.textContent = error;
            errorEl.hidden = false;
          } else {
            errorEl.hidden = true;
            errorEl.textContent = '';
          }
        };

        input.addEventListener('input', recheck);
        recheck();   // initial state — may disable OK if defaultValue is empty
        // Select default text so the user can type-replace immediately.
        if (!opts.multiline && opts.defaultValue) {
          requestAnimationFrame(() => { try { input.select(); } catch {} });
        }
      },
    });
    dialog.show().then(result => {
      // result is either input.value (string) on OK, or null on cancel/Esc/backdrop.
      resolve(typeof result === 'string' ? result : null);
    });
  });
}

// ── alert ───────────────────────────────────────────────────────────────

export function alert(message, opts = {}) {
  return new Promise(resolve => {
    const dialog = new Dialog({
      title:    opts.title ?? null,
      parent:   opts.parent ?? null,
      backdrop: true,
      closable: false,
      render: (body, ctx) => {
        body.appendChild(makeMessage(message));
        body.appendChild(makeButtonRow([
          { label: opts.okLabel || 'OK', value: null, isDefault: true },
        ], ctx));
      },
    });
    dialog.show().then(() => resolve());
  });
}

// ── shared builders ─────────────────────────────────────────────────────

function makeMessage(text) {
  const p = document.createElement('p');
  p.className = 'gcu-dialog-message';
  p.textContent = text;
  return p;
}

function makeButton({ label, value, isDefault, danger }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'gcu-dialog-button';
  if (isDefault) {
    btn.dataset.default = 'true';
    btn.classList.add('gcu-dialog-button-default');
  }
  if (danger) btn.classList.add('gcu-dialog-button-danger');
  btn.textContent = label;
  return btn;
}

function makeButtonRow(buttons, ctx) {
  const row = document.createElement('div');
  row.className = 'gcu-dialog-buttons';
  for (const cfg of buttons) {
    const btn = makeButton(cfg);
    btn.addEventListener('click', () => ctx.close(cfg.value));
    row.appendChild(btn);
  }
  return row;
}
