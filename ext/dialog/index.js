// ⚠ GENERATED FILE — DO NOT EDIT. Source: src/  Build: @gcu/build src/main.js
// @gcu/dialog — Modal dialogs: confirm, prompt, alert, custom forms. Promise-resolving show(), focus trap, stacking, ARIA. CSS-variable themed. Zero dependencies.

// ── src/helpers.js ──

// @gcu/dialog — pure helpers. Zero DOM, exported for tests.

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

// Selector used by getFocusable; exported so consumers can extend if needed.
function focusableSelector() { return FOCUSABLE_SELECTOR; }

// Z-index arithmetic for the dialog stack. base + N*2 gives:
//   stackIdx 0 → backdrop=base+0, dialog=base+1
//   stackIdx 1 → backdrop=base+2, dialog=base+3
// Each new dialog covers the previous because its backdrop's z is above the
// previous dialog's z. Closing the top reveals the next one.
function backdropZ(base, stackIdx) { return base + stackIdx * 2; }
function dialogZ(base, stackIdx)   { return base + stackIdx * 2 + 1; }

// Validation helper for the prompt convenience API. Wraps a consumer-provided
// validator with the empty-allowed rule:
//   - validator returns string | null (error message or no error)
//   - empty string is valid iff validator("") returns null
// Returns { valid, error } where error is null when valid.
function validateValue(value, validator) {
  if (typeof validator === 'function') {
    const result = validator(value);
    if (typeof result === 'string') {
      return { valid: false, error: result };
    }
    return { valid: true, error: null };
  }
  // No validator: empty is invalid by default to mirror native prompt() UX.
  if (!value || !value.trim || !value.trim()) {
    return { valid: false, error: null };
  }
  return { valid: true, error: null };
}

// ── src/dialog.js ──

// @gcu/dialog — modal dialog primitive.
// Centered modal with backdrop, focus trap, stacking, animation, ARIA.
// See SPEC.md (or spec_inbox/dialog-spec.md) for full design.


const Z_BASE_DEFAULT = 9100;
const ANIMATION_FALLBACK_MS = 300;   // safety timer if transitionend never fires

// Module-level stack of open dialogs. Top is index length-1.
// Each entry: { instance, hostEl, backdropEl, dialogEl, opener, onKey, originallyInert }
const _stack = [];

let _idCounter = 0;
function freshId(prefix) { return `${prefix}-${++_idCounter}`; }

function topEntry() { return _stack.length ? _stack[_stack.length - 1] : null; }

function getFocusable(container) {
  return Array.from(container.querySelectorAll(focusableSelector()))
    .filter(el => el.offsetParent !== null || el === document.activeElement);
}

// ── Dialog class ──────────────────────────────────────────────────────────

class Dialog {
  constructor(config = {}) {
    this.config = {
      title:    config.title ?? null,
      parent:   config.parent ?? null,        // null → viewport
      width:    config.width ?? null,
      closable: config.closable ?? true,
      backdrop: config.backdrop ?? true,
      render:   config.render ?? null,
      zBase:    config.zBase ?? Z_BASE_DEFAULT,
    };
    this._resolve = null;
    this._entry = null;            // stack entry once mounted
    this._closing = false;         // true while fade-out is running
  }

  show() {
    return new Promise(resolve => {
      this._resolve = resolve;
      this._mount();
    });
  }

  // Programmatic close (instance method — same effect as ctx.close inside render).
  close(value) {
    this._close(value !== undefined ? value : null);
  }

  // ── private ─────────────────────────────────────────────────────────────

  _mount() {
    const { parent } = this.config;
    const host = parent ?? document.body;

    // Suspend the previous top dialog's keyboard handling.
    const prev = topEntry();
    if (prev) {
      document.removeEventListener('keydown', prev.onKey, true);
    }

    const backdropEl = this._buildBackdrop();
    const dialogEl = this._buildDialog();

    // Inert the host's other children (skip the elements we just added) so
    // screen readers and tab flow ignore the page beneath.
    const originallyInert = [];
    if (parent === null && document.body) {
      for (const child of [...document.body.children]) {
        if (child === backdropEl || child === dialogEl) continue;
        if (!child.hasAttribute('inert')) {
          child.setAttribute('inert', '');
          originallyInert.push(child);
        }
      }
    }

    if (backdropEl) host.appendChild(backdropEl);
    host.appendChild(dialogEl);

    const opener = document.activeElement;
    const stackIdx = _stack.length;
    const entry = {
      instance: this,
      hostEl: host,
      backdropEl,
      dialogEl,
      opener,
      onKey: (e) => this._onKey(e),
      originallyInert,
      stackIdx,
    };
    this._entry = entry;
    _stack.push(entry);

    // Attach the new top dialog's keyboard handler.
    document.addEventListener('keydown', entry.onKey, true);

    // Apply z-index based on stack position.
    if (backdropEl) backdropEl.style.zIndex = String(backdropZ(this.config.zBase, stackIdx));
    dialogEl.style.zIndex = String(dialogZ(this.config.zBase, stackIdx));

    // Run consumer render or default render.
    const body = dialogEl.querySelector('.gcu-dialog-body');
    if (this.config.render) {
      const ctx = this._makeRenderCtx(body, dialogEl);
      try {
        this.config.render(body, ctx);
      } catch (e) {
        console.error('Dialog render threw', e);
      }
    }

    // Initial focus: [autofocus] → first focusable input → first button → dialog.
    const auto = body.querySelector('[autofocus]');
    if (auto) {
      try { auto.focus(); } catch {}
    } else {
      const focusables = getFocusable(dialogEl);
      const firstInput = focusables.find(el =>
        ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName));
      const firstBtn = focusables.find(el => el.tagName === 'BUTTON');
      const target = firstInput || firstBtn || dialogEl;
      try { target.focus(); } catch {}
    }

    // Trigger animation on the next frame.
    requestAnimationFrame(() => {
      dialogEl.classList.add('gcu-dialog-open');
      if (backdropEl) backdropEl.classList.add('gcu-dialog-open');
    });
  }

  _close(value) {
    if (this._closing || !this._entry) return;
    this._closing = true;

    const entry = this._entry;
    const idx = _stack.indexOf(entry);
    if (idx >= 0) _stack.splice(idx, 1);

    // Detach keyboard handler immediately.
    document.removeEventListener('keydown', entry.onKey, true);

    // Restore the previous top dialog's keyboard handler (if any).
    const prev = topEntry();
    if (prev) {
      document.addEventListener('keydown', prev.onKey, true);
    }

    // Resolve immediately — the visual fade-out runs async, but the consumer's
    // promise unblocks at the decision moment.
    if (this._resolve) {
      const r = this._resolve;
      this._resolve = null;
      r(value);
    }

    // Restore focus to the opener (or its closest live ancestor / body).
    if (entry.opener && entry.opener.focus) {
      // If opener is no longer in the DOM (consumer tore it down), fall back.
      if (document.contains(entry.opener)) {
        try { entry.opener.focus(); } catch {}
      } else {
        try { document.body.focus?.(); } catch {}
      }
    }

    // Restore inert on the elements we marked.
    for (const el of entry.originallyInert) {
      el.removeAttribute('inert');
    }

    // Animate out, then unmount. Skip animation under reduced-motion.
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    const finish = () => {
      if (entry.backdropEl?.parentNode) entry.backdropEl.parentNode.removeChild(entry.backdropEl);
      if (entry.dialogEl?.parentNode) entry.dialogEl.parentNode.removeChild(entry.dialogEl);
    };

    if (reduced) {
      finish();
      return;
    }

    entry.dialogEl.classList.remove('gcu-dialog-open');
    entry.dialogEl.classList.add('gcu-dialog-closing');
    if (entry.backdropEl) {
      entry.backdropEl.classList.remove('gcu-dialog-open');
      entry.backdropEl.classList.add('gcu-dialog-closing');
    }

    let done = false;
    const onEnd = () => {
      if (done) return;
      done = true;
      entry.dialogEl.removeEventListener('transitionend', onEnd);
      finish();
    };
    entry.dialogEl.addEventListener('transitionend', onEnd);
    setTimeout(onEnd, ANIMATION_FALLBACK_MS);
  }

  _buildBackdrop() {
    if (this.config.backdrop === false) return null;
    const el = document.createElement('div');
    el.className = 'gcu-dialog-backdrop';
    if (this.config.backdrop === 'static') el.classList.add('gcu-dialog-backdrop-static');
    el.setAttribute('aria-hidden', 'true');
    el.addEventListener('click', () => {
      if (this.config.backdrop === 'static') return;
      this._close(null);
    });
    return el;
  }

  _buildDialog() {
    const el = document.createElement('div');
    el.className = 'gcu-dialog';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.tabIndex = -1;
    if (this.config.width) {
      el.style.width = `${this.config.width}px`;
    }

    // Header (title + optional close ×).
    if (this.config.title || this.config.closable) {
      const header = document.createElement('div');
      header.className = 'gcu-dialog-header';

      const title = document.createElement('div');
      title.className = 'gcu-dialog-title';
      const titleId = freshId('gcu-dialog-title');
      title.id = titleId;
      title.textContent = this.config.title || '';
      el.setAttribute('aria-labelledby', titleId);
      header.appendChild(title);

      if (this.config.closable) {
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'gcu-dialog-close';
        closeBtn.textContent = '\u00d7';
        closeBtn.setAttribute('aria-label', 'Close');
        closeBtn.addEventListener('click', () => this._close(null));
        header.appendChild(closeBtn);
      }

      el.appendChild(header);
    } else {
      // Without a header, fall back to aria-label sourced later by render.
      el.setAttribute('aria-label', 'Dialog');
    }

    // Body — consumer content lands here.
    const body = document.createElement('div');
    body.className = 'gcu-dialog-body';
    el.appendChild(body);

    return el;
  }

  _makeRenderCtx(body, dialogEl) {
    const dialog = this;
    return {
      close(value) { dialog._close(value !== undefined ? value : null); },
      setOk(enabled) {
        const btn = body.querySelector('[data-default="true"]');
        if (btn) btn.disabled = !enabled;
      },
      setTitle(text) {
        const titleEl = dialogEl.querySelector('.gcu-dialog-title');
        if (titleEl) titleEl.textContent = text;
        const labelId = dialogEl.getAttribute('aria-labelledby');
        if (!labelId) dialogEl.setAttribute('aria-label', text);
      },
      dialog,
    };
  }

  _onKey(e) {
    // Only the top dialog responds — but since we reattach handlers on
    // mount/unmount, the active listener IS the top dialog's. Sanity-check.
    if (this._entry !== topEntry()) return;

    if (e.key === 'Escape') {
      if (this.config.backdrop === 'static') return;   // static blocks Esc too
      e.preventDefault();
      e.stopPropagation();
      this._close(null);
      return;
    }

    if (e.key === 'Tab') {
      this._trapFocus(e);
      return;
    }

    if (e.key === 'Enter') {
      // Multiline-aware: Enter inside a <textarea> inserts a newline unless
      // Ctrl/Cmd is held. Otherwise Enter activates the default button.
      const target = e.target;
      if (target?.tagName === 'TEXTAREA' && !e.ctrlKey && !e.metaKey) return;

      // Don't intercept Enter on a button — let the button handle it
      // naturally so its click handler fires once, not twice.
      if (target?.tagName === 'BUTTON') return;

      const def = this._entry.dialogEl.querySelector('[data-default="true"]');
      if (def && !def.disabled) {
        e.preventDefault();
        def.click();
      }
    }
  }

  _trapFocus(e) {
    const focusables = getFocusable(this._entry.dialogEl);
    if (focusables.length === 0) {
      e.preventDefault();
      this._entry.dialogEl.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;

    if (e.shiftKey && (active === first || !this._entry.dialogEl.contains(active))) {
      e.preventDefault();
      try { last.focus(); } catch {}
    } else if (!e.shiftKey && (active === last || !this._entry.dialogEl.contains(active))) {
      e.preventDefault();
      try { first.focus(); } catch {}
    }
  }
}

// ── module-level API ──────────────────────────────────────────────────────

function dismissAll() {
  // Top-down — copy the list because _close mutates _stack.
  for (const entry of [..._stack].reverse()) {
    entry.instance._close(null);
  }
}

// Open dialogs count (test/debug helper).
function openCount() { return _stack.length; }

// ── src/convenience.js ──

// @gcu/dialog — convenience APIs: confirm, prompt, alert.
// Built on the Dialog primitive. Each returns a promise.


// ── confirm ──────────────────────────────────────────────────────────────

function confirm(message, opts = {}) {
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

function prompt(message, opts = {}) {
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

function alert(message, opts = {}) {
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

// ── src/main.js ──

// @gcu/dialog — package entry: build concat manifest + the curated public
// surface (the names the bundle exports; matches the old hand-written footer).

export {
  Dialog,
  dismissAll,
  openCount,
  confirm,
  prompt,
  alert,
};
