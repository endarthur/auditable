// @gcu/menu — MenuBar: horizontal strip of triggers, each opens a Menu.

import { Menu } from './menu.js';

export class MenuBar {
  constructor(container, sections) {
    if (!container || !container.nodeType) {
      throw new Error('MenuBar: container must be an HTMLElement');
    }
    this.container = container;
    this._sectionsSrc = sections; // array | factory
    this._handlers = new Map();   // event name → Set<fn>
    this._activeIdx = -1;         // currently-active trigger; -1 = none
    this._barActive = false;      // Alt/F10-activated
    this._sections = [];          // resolved snapshot
    this._buttons = [];           // trigger DOM elements

    this.container.classList.add('gcu-menubar');
    this.container.setAttribute('role', 'menubar');

    this._onDocKey = e => this._handleDocKey(e);
    document.addEventListener('keydown', this._onDocKey, true);

    this.refresh();
  }

  on(event, handler) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(handler);
    return () => this._handlers.get(event)?.delete(handler);
  }

  off(event, handler) {
    this._handlers.get(event)?.delete(handler);
  }

  _emit(event, payload) {
    const subs = this._handlers.get(event);
    if (!subs) return;
    for (const fn of subs) {
      try { fn(payload); } catch (err) { console.error('MenuBar handler threw', err); }
    }
  }

  // Re-evaluate sections (factory form) and re-render triggers.
  refresh() {
    this._sections = typeof this._sectionsSrc === 'function'
      ? this._sectionsSrc()
      : this._sectionsSrc;
    if (!Array.isArray(this._sections)) this._sections = [];
    this._render();
  }

  // Surgically mutate one section's items array. Picks up on next open.
  update(label, mutate) {
    const section = this._sections.find(s => s.label === label);
    if (!section) return;
    if (typeof section.items === 'function') {
      // Factory items — caller probably wants to flip back to a static array.
      const arr = section.items();
      if (Array.isArray(arr)) {
        mutate(arr);
        section.items = arr;
      }
    } else if (Array.isArray(section.items)) {
      mutate(section.items);
    }
  }

  destroy() {
    document.removeEventListener('keydown', this._onDocKey, true);
    this._closeAny();
    this.container.innerHTML = '';
    this.container.classList.remove('gcu-menubar');
    this.container.removeAttribute('role');
    this._handlers.clear();
  }

  // ── private ──────────────────────────────────────────────────────────────

  _render() {
    this.container.innerHTML = '';
    this._buttons = [];
    this._sections.forEach((section, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gcu-menubar-trigger';
      btn.textContent = section.label;
      btn.dataset.idx = i;
      btn.tabIndex = i === 0 ? 0 : -1;
      btn.setAttribute('role', 'menuitem');
      btn.setAttribute('aria-haspopup', 'menu');
      btn.setAttribute('aria-expanded', 'false');

      btn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        this._toggleSection(i);
      });
      btn.addEventListener('mouseenter', () => {
        // If a menu is already open from another trigger, hot-swap to this one.
        if (this._activeIdx >= 0 && this._activeIdx !== i) {
          this._openSection(i);
        }
      });
      btn.addEventListener('focus', () => {
        // When bar is active, mark current focus visually.
        for (const b of this._buttons) b.classList.toggle('gcu-menubar-focused', b === btn);
      });

      this._buttons.push(btn);
      this.container.appendChild(btn);
    });
  }

  _toggleSection(idx) {
    if (this._activeIdx === idx) {
      this._closeAny();
      return;
    }
    this._openSection(idx);
  }

  _openSection(idx) {
    if (this._activeIdx >= 0) {
      // Close any currently-open menu before opening a new one.
      Menu.dismiss();
    }
    this._activeIdx = idx;
    this._barActive = true;
    const btn = this._buttons[idx];
    btn.classList.add('gcu-menubar-active');
    btn.setAttribute('aria-expanded', 'true');

    const section = this._sections[idx];
    Menu.show(section.items, {
      anchor: btn,
      placement: 'bottom-start',
      opener: btn,
    }).then(action => {
      btn.classList.remove('gcu-menubar-active');
      btn.setAttribute('aria-expanded', 'false');
      // Only clear active state if Menu wasn't replaced by a sibling section
      // (hot-swap path doesn't go through this resolve).
      if (this._activeIdx === idx) this._activeIdx = -1;
      if (action != null) {
        // Action selected: emit and fully deactivate the bar — drop focus
        // off the trigger so no lingering :focus-visible outline remains.
        this._emit('action', action);
        this._barActive = false;
        for (const b of this._buttons) b.classList.remove('gcu-menubar-focused');
        try { btn.blur(); } catch {}
      } else {
        // action == null — Esc / click-outside / blur. Drop the visual
        // focus highlight too, otherwise the last-opened trigger looks
        // perma-selected. The trigger keeps DOM focus so Alt + arrow
        // keyboard nav still works (focus-visible will re-light if the
        // user tabs back).
        for (const b of this._buttons) b.classList.remove('gcu-menubar-focused');
      }
    });
  }

  _closeAny() {
    if (this._activeIdx >= 0) {
      Menu.dismiss();
      // resolve handler will clear _activeIdx
    }
    this._barActive = false;
    for (const b of this._buttons) b.classList.remove('gcu-menubar-focused', 'gcu-menubar-active');
  }

  _focusTrigger(idx) {
    if (idx < 0 || idx >= this._buttons.length) return;
    for (const b of this._buttons) b.tabIndex = -1;
    this._buttons[idx].tabIndex = 0;
    try { this._buttons[idx].focus(); } catch {}
  }

  _handleDocKey(e) {
    // Self-heal: if the bar thinks it's active but focus has moved off it
    // (typically after click-outside dismissal of a menu), deactivate and
    // let this key pass through to whatever is actually focused. Without
    // this, space/down/enter from a focused input would re-open the menu.
    if (this._activeIdx < 0 && this._barActive) {
      const focusOnBar = this._buttons.some(b => b === document.activeElement);
      if (!focusOnBar) {
        this._barActive = false;
        for (const b of this._buttons) b.classList.remove('gcu-menubar-focused');
        return;
      }
    }

    // Activate menubar on Alt or F10 (when no menu open and bar inactive).
    if (this._activeIdx < 0 && !this._barActive) {
      if (e.key === 'F10' || (e.key === 'Alt' && !e.repeat)) {
        e.preventDefault();
        this._barActive = true;
        this._focusTrigger(0);
        return;
      }
    }

    // Bar-level navigation when active or open.
    if (this._barActive || this._activeIdx >= 0) {
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        const next = this._activeIdx >= 0
          ? (this._activeIdx + 1) % this._buttons.length
          : (this._currentFocusIdx() + 1) % this._buttons.length;
        if (this._activeIdx >= 0) this._openSection(next);
        else this._focusTrigger(next);
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        const cur = this._activeIdx >= 0 ? this._activeIdx : this._currentFocusIdx();
        const prev = (cur - 1 + this._buttons.length) % this._buttons.length;
        if (this._activeIdx >= 0) this._openSection(prev);
        else this._focusTrigger(prev);
        return;
      }
      if (this._activeIdx < 0 && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        this._openSection(this._currentFocusIdx());
        return;
      }
      if (e.key === 'Escape') {
        if (this._activeIdx < 0 && this._barActive) {
          // Bar active but no menu open — Escape deactivates bar.
          e.preventDefault();
          this._barActive = false;
          for (const b of this._buttons) b.classList.remove('gcu-menubar-focused');
          return;
        }
        // If a menu is open, the Menu's own Esc handler runs first; we won't
        // get here unless that didn't handle it.
      }
      if (e.key === 'Alt') {
        e.preventDefault();
        this._closeAny();
        return;
      }
    }
  }

  _currentFocusIdx() {
    const active = document.activeElement;
    const idx = this._buttons.indexOf(active);
    return idx >= 0 ? idx : 0;
  }
}
