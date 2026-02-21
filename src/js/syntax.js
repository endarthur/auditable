import { JS_KEYWORDS, JS_BUILTINS } from './state.js';

// ── SYNTAX HIGHLIGHTING ──

const CSS_NAMED_COLORS = new Set([
  'black','silver','gray','white','maroon','red','purple','fuchsia',
  'green','lime','olive','yellow','navy','blue','teal','aqua','orange'
]);

export function tokenize(code) {
  const tokens = [];
  let i = 0;
  const len = code.length;

  while (i < len) {
    // line comment
    if (code[i] === '/' && code[i+1] === '/') {
      const start = i;
      while (i < len && code[i] !== '\n') i++;
      tokens.push({ type: 'cmt', text: code.slice(start, i) });
      continue;
    }
    // block comment
    if (code[i] === '/' && code[i+1] === '*') {
      const start = i;
      i += 2;
      while (i < len && !(code[i-1] === '*' && code[i] === '/')) i++;
      if (i < len) i++;
      tokens.push({ type: 'cmt', text: code.slice(start, i) });
      continue;
    }
    // strings
    if (code[i] === '"' || code[i] === "'" || code[i] === '`') {
      const q = code[i];
      const start = i;
      i++;
      while (i < len && code[i] !== q) {
        if (code[i] === '\\') i++;
        i++;
      }
      if (i < len) i++;
      tokens.push({ type: 'str', text: code.slice(start, i) });
      continue;
    }
    // numbers
    if (/\d/.test(code[i]) || (code[i] === '.' && i+1 < len && /\d/.test(code[i+1]))) {
      const start = i;
      if (code[i] === '0' && (code[i+1] === 'x' || code[i+1] === 'X')) {
        i += 2;
        while (i < len && /[0-9a-fA-F_]/.test(code[i])) i++;
      } else {
        while (i < len && /[0-9._eE+-]/.test(code[i])) i++;
      }
      tokens.push({ type: 'num', text: code.slice(start, i) });
      continue;
    }
    // identifiers / keywords
    if (/[a-zA-Z_$]/.test(code[i])) {
      const start = i;
      while (i < len && /\w/.test(code[i])) i++;
      const word = code.slice(start, i);
      if (JS_KEYWORDS.has(word)) {
        tokens.push({ type: 'kw', text: word });
      } else if (JS_BUILTINS.has(word)) {
        tokens.push({ type: 'const', text: word });
      } else if (i < len && code[i] === '(') {
        tokens.push({ type: 'fn', text: word });
      } else {
        tokens.push({ type: 'id', text: word });
      }
      continue;
    }
    // operators
    if ('=+-*/<>!&|^~%?:'.includes(code[i])) {
      tokens.push({ type: 'op', text: code[i] });
      i++;
      continue;
    }
    // punctuation
    if ('(){}[];,.'.includes(code[i])) {
      tokens.push({ type: 'punc', text: code[i] });
      i++;
      continue;
    }
    // whitespace / other — pass through
    tokens.push({ type: '', text: code[i] });
    i++;
  }

  return tokens;
}

export function highlightCode(ta, hl) {
  const code = ta.value;
  if (!code) { hl.innerHTML = '\n'; return; }

  const tokens = tokenize(code);
  let html = '';
  for (const t of tokens) {
    const escaped = t.text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    if (t.type && t.type !== 'id') {
      html += `<span class="hl-${t.type}">${escaped}</span>`;
    } else {
      html += escaped;
    }
  }
  // trailing newline so highlight layer matches textarea height
  hl.innerHTML = html + '\n';
}

// ── CSS SYNTAX HIGHLIGHTING ──

export function tokenizeCss(code) {
  const tokens = [];
  let i = 0;
  const len = code.length;
  let ctx = 'sel'; // 'sel' | 'prop' | 'val'
  let depth = 0;

  while (i < len) {
    // block comment
    if (code[i] === '/' && code[i+1] === '*') {
      const start = i;
      i += 2;
      while (i < len && !(code[i-1] === '*' && code[i] === '/')) i++;
      if (i < len) i++;
      tokens.push({ type: 'cmt', text: code.slice(start, i) });
      continue;
    }
    // strings
    if (code[i] === '"' || code[i] === "'") {
      const q = code[i];
      const start = i;
      i++;
      while (i < len && code[i] !== q) {
        if (code[i] === '\\') i++;
        i++;
      }
      if (i < len) i++;
      tokens.push({ type: 'str', text: code.slice(start, i) });
      continue;
    }
    // punctuation with context transitions
    if (code[i] === '{') {
      tokens.push({ type: 'punc', text: '{' });
      depth++;
      ctx = 'prop';
      i++;
      continue;
    }
    if (code[i] === '}') {
      tokens.push({ type: 'punc', text: '}' });
      depth--;
      ctx = depth > 0 ? 'prop' : 'sel';
      i++;
      continue;
    }
    if (code[i] === ':' && ctx === 'prop') {
      tokens.push({ type: 'punc', text: ':' });
      ctx = 'val';
      i++;
      continue;
    }
    if (code[i] === ';') {
      tokens.push({ type: 'punc', text: ';' });
      ctx = 'prop';
      i++;
      continue;
    }
    if ('(),'.includes(code[i])) {
      tokens.push({ type: 'punc', text: code[i] });
      i++;
      continue;
    }
    // @-rules
    if (code[i] === '@') {
      const start = i;
      i++;
      while (i < len && /[a-zA-Z-]/.test(code[i])) i++;
      tokens.push({ type: 'atrule', text: code.slice(start, i) });
      continue;
    }
    // !important
    if (code[i] === '!' && ctx === 'val') {
      const start = i;
      i++;
      while (i < len && /[a-zA-Z]/.test(code[i])) i++;
      tokens.push({ type: 'important', text: code.slice(start, i) });
      continue;
    }
    // # — hex color in val, ID selector in sel
    if (code[i] === '#') {
      if (ctx === 'val') {
        const start = i;
        i++;
        while (i < len && /[0-9a-fA-F]/.test(code[i])) i++;
        tokens.push({ type: 'color', text: code.slice(start, i) });
      } else {
        // ID selector
        const start = i;
        i++;
        while (i < len && /[\w-]/.test(code[i])) i++;
        tokens.push({ type: 'sel', text: code.slice(start, i) });
      }
      continue;
    }
    // : in selector context = pseudo-class
    if (code[i] === ':' && ctx === 'sel') {
      const start = i;
      i++;
      if (i < len && code[i] === ':') i++; // ::
      while (i < len && /[a-zA-Z-]/.test(code[i])) i++;
      // handle pseudo with parens like :nth-child(...)
      if (i < len && code[i] === '(') {
        i++;
        let pdepth = 1;
        while (i < len && pdepth > 0) {
          if (code[i] === '(') pdepth++;
          else if (code[i] === ')') pdepth--;
          if (pdepth > 0) i++;
        }
        if (i < len) i++;
      }
      tokens.push({ type: 'sel', text: code.slice(start, i) });
      continue;
    }
    // . in selector context = class selector
    if (code[i] === '.' && ctx === 'sel') {
      const start = i;
      i++;
      while (i < len && /[\w-]/.test(code[i])) i++;
      tokens.push({ type: 'sel', text: code.slice(start, i) });
      continue;
    }
    // numbers (with units)
    if (ctx === 'val' && (/\d/.test(code[i]) || (code[i] === '.' && i+1 < len && /\d/.test(code[i+1])))) {
      const start = i;
      while (i < len && /[0-9.]/.test(code[i])) i++;
      // units
      while (i < len && /[a-zA-Z%]/.test(code[i])) i++;
      tokens.push({ type: 'num', text: code.slice(start, i) });
      continue;
    }
    // identifiers
    if (/[a-zA-Z_-]/.test(code[i])) {
      const start = i;
      while (i < len && /[\w-]/.test(code[i])) i++;
      const word = code.slice(start, i);
      // function call
      if (i < len && code[i] === '(') {
        tokens.push({ type: 'fn', text: word });
        continue;
      }
      if (ctx === 'val' && CSS_NAMED_COLORS.has(word.toLowerCase())) {
        tokens.push({ type: 'color', text: word });
      } else if (ctx === 'prop') {
        tokens.push({ type: 'prop', text: word });
      } else if (ctx === 'sel') {
        tokens.push({ type: 'sel', text: word });
      } else {
        tokens.push({ type: '', text: word });
      }
      continue;
    }
    // whitespace / other
    tokens.push({ type: '', text: code[i] });
    i++;
  }

  return tokens;
}

function resolveToHex(colorStr) {
  const d = document.createElement('div');
  d.style.color = colorStr;
  document.body.appendChild(d);
  const rgb = getComputedStyle(d).color;
  d.remove();
  const m = rgb.match(/(\d+)/g);
  if (!m || m.length < 3) return colorStr;
  return '#' + m.slice(0, 3).map(n => parseInt(n).toString(16).padStart(2, '0')).join('');
}

let _colorPicker = null;
let _pickerTarget = null; // { ta, offset, len }

function ensureColorPicker() {
  if (_colorPicker) return _colorPicker;
  _colorPicker = document.createElement('input');
  _colorPicker.type = 'color';
  _colorPicker.style.cssText = 'position:absolute;visibility:hidden;width:0;height:0;';
  document.body.appendChild(_colorPicker);
  _colorPicker.addEventListener('input', () => {
    if (!_pickerTarget) return;
    const { ta, offset, len } = _pickerTarget;
    const val = ta.value;
    const newColor = _colorPicker.value;
    ta.value = val.slice(0, offset) + newColor + val.slice(offset + len);
    ta.dispatchEvent(new Event('input'));
    // update offset for new length
    _pickerTarget.len = newColor.length;
  });
  return _colorPicker;
}

export function highlightCss(ta, hl) {
  const code = ta.value;
  if (!code) { hl.innerHTML = '\n'; return; }

  const tokens = tokenizeCss(code);
  let html = '';
  let offset = 0;
  for (const t of tokens) {
    const escaped = t.text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    if (t.type === 'color') {
      const hex = resolveToHex(t.text);
      html += `<span class="hl-color"><span class="hl-swatch" style="background:${hex}" data-offset="${offset}" data-len="${t.text.length}"></span>${escaped}</span>`;
    } else if (t.type && t.type !== 'id') {
      html += `<span class="hl-${t.type}">${escaped}</span>`;
    } else {
      html += escaped;
    }
    offset += t.text.length;
  }
  hl.innerHTML = html + '\n';

  // wire swatch clicks (only add once per highlight layer)
  if (!hl._swatchWired) {
    hl._swatchWired = true;
    hl.addEventListener('click', (e) => {
      const swatch = e.target.closest('.hl-swatch');
      if (!swatch) return;
      const off = parseInt(swatch.dataset.offset);
      const len = parseInt(swatch.dataset.len);
      const picker = ensureColorPicker();
      _pickerTarget = { ta, offset: off, len };
      const hex = resolveToHex(ta.value.slice(off, off + len));
      picker.value = hex;
      picker.click();
    });
  }
}
