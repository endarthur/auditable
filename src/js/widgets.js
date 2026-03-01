// ── CUSTOM ELEMENT WIDGETS ──
//
// Light DOM custom elements for interactive controls. Each element:
// - renders internal DOM in connectedCallback (once)
// - exposes .value getter/setter
// - dispatches standard 'input' and 'change' events
// - works in both code cells (via ui.slider()) and HTML cells (via markup)

class AuditWidget extends HTMLElement {
  connectedCallback() {
    if (!this._built) { this._render(); this._built = true; }
  }
  get name() { return this.getAttribute('name'); }
  get label() { return this.getAttribute('label'); }
  _mkLabel() {
    const l = this.getAttribute('label');
    if (!l) return null;
    const span = document.createElement('span');
    span.className = 'audit-widget-label';
    span.textContent = l;
    return span;
  }
  _dispatch(type) {
    this.dispatchEvent(new Event(type, { bubbles: true }));
  }
}

class AuditSlider extends AuditWidget {
  static observedAttributes = ['min', 'max', 'step', 'value', 'label'];

  _render() {
    const lbl = this._mkLabel();
    if (lbl) this.appendChild(lbl);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = this.getAttribute('min') ?? 0;
    input.max = this.getAttribute('max') ?? 100;
    input.step = this.getAttribute('step') ?? 1;
    input.value = this.getAttribute('value') ?? 50;
    this._input = input;

    const val = document.createElement('span');
    val.className = 'audit-widget-val';
    val.textContent = input.value;
    this._valSpan = val;

    input.oninput = () => {
      val.textContent = input.value;
      this._dispatch('input');
    };
    input.onchange = () => this._dispatch('change');

    this.appendChild(input);
    this.appendChild(val);
  }

  attributeChangedCallback(name, old, val) {
    if (!this._built) return;
    if (name === 'label') {
      const lbl = this.querySelector('.audit-widget-label');
      if (lbl) lbl.textContent = val;
    } else if (this._input) {
      this._input[name] = val;
      if (name === 'value') this._valSpan.textContent = val;
    }
  }

  get value() { return this._input ? parseFloat(this._input.value) : parseFloat(this.getAttribute('value') ?? 50); }
  set value(v) {
    if (this._input) {
      this._input.value = v;
      this._valSpan.textContent = v;
    } else {
      this.setAttribute('value', v);
    }
  }
}

class AuditDropdown extends AuditWidget {
  static observedAttributes = ['options', 'value', 'label'];

  _render() {
    const lbl = this._mkLabel();
    if (lbl) this.appendChild(lbl);

    const select = document.createElement('select');
    this._select = select;
    this._buildOptions();

    const v = this.getAttribute('value');
    if (v) select.value = v;

    select.onchange = () => {
      this._dispatch('input');
      this._dispatch('change');
    };

    this.appendChild(select);
  }

  _buildOptions() {
    const s = this._select;
    s.innerHTML = '';
    const opts = (this.getAttribute('options') || '').split(',').filter(Boolean);
    for (const o of opts) {
      const opt = document.createElement('option');
      opt.value = o.trim();
      opt.textContent = o.trim();
      s.appendChild(opt);
    }
  }

  attributeChangedCallback(name, old, val) {
    if (!this._built) return;
    if (name === 'label') {
      const lbl = this.querySelector('.audit-widget-label');
      if (lbl) lbl.textContent = val;
    } else if (name === 'options') {
      const prev = this._select.value;
      this._buildOptions();
      this._select.value = prev;
    } else if (name === 'value') {
      this._select.value = val;
    }
  }

  get value() { return this._select ? this._select.value : (this.getAttribute('value') || ''); }
  set value(v) {
    if (this._select) this._select.value = v;
    else this.setAttribute('value', v);
  }
}

class AuditCheckbox extends AuditWidget {
  static observedAttributes = ['checked', 'label'];

  _render() {
    const lbl = this._mkLabel();
    if (lbl) this.appendChild(lbl);

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = this.hasAttribute('checked');
    this._input = input;

    input.onchange = () => {
      this._dispatch('input');
      this._dispatch('change');
    };

    this.appendChild(input);
  }

  attributeChangedCallback(name, old, val) {
    if (!this._built) return;
    if (name === 'label') {
      const lbl = this.querySelector('.audit-widget-label');
      if (lbl) lbl.textContent = val;
    } else if (name === 'checked') {
      if (this._input) this._input.checked = val !== null;
    }
  }

  get value() { return this._input ? this._input.checked : this.hasAttribute('checked'); }
  set value(v) {
    if (this._input) this._input.checked = !!v;
    else if (v) this.setAttribute('checked', '');
    else this.removeAttribute('checked');
  }
}

class AuditTextInput extends AuditWidget {
  static observedAttributes = ['value', 'placeholder', 'label'];

  _render() {
    const lbl = this._mkLabel();
    if (lbl) this.appendChild(lbl);

    const input = document.createElement('input');
    input.type = 'text';
    input.value = this.getAttribute('value') || '';
    input.placeholder = this.getAttribute('placeholder') || '';
    this._input = input;

    input.oninput = () => this._dispatch('input');
    input.onchange = () => this._dispatch('change');

    this.appendChild(input);
  }

  attributeChangedCallback(name, old, val) {
    if (!this._built) return;
    if (name === 'label') {
      const lbl = this.querySelector('.audit-widget-label');
      if (lbl) lbl.textContent = val;
    } else if (this._input) {
      if (name === 'value') this._input.value = val || '';
      else if (name === 'placeholder') this._input.placeholder = val || '';
    }
  }

  get value() { return this._input ? this._input.value : (this.getAttribute('value') || ''); }
  set value(v) {
    if (this._input) this._input.value = v;
    else this.setAttribute('value', v);
  }
}

customElements.define('audit-slider', AuditSlider);
customElements.define('audit-dropdown', AuditDropdown);
customElements.define('audit-checkbox', AuditCheckbox);
customElements.define('audit-text-input', AuditTextInput);
