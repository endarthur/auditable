// @gcu/sideact — DOM: template/hyperscript element creation and binding.
// Requires `document` — browser/JSDOM environments only.

import { effect } from './signals.js';

// ── h: dual-mode element creator ──

const _templateCache = new WeakMap();

export function h(first, ...rest) {
  if (Array.isArray(first) && first.raw) return _templateMode(first, rest);
  return _hyperscriptMode(first, rest[0], rest.slice(1));
}

// ── tagged template mode ──

// Sentinel marker for interpolation points — works in both text and attribute contexts.
// Uses a prefix unlikely to appear in real content.
const _MARKER = '\x01sr:';

function _templateMode(strings, values) {
  let cached = _templateCache.get(strings);
  if (!cached) {
    cached = _parseTemplate(strings);
    _templateCache.set(strings, cached);
  }
  return _instantiate(cached, values);
}

function _parseTemplate(strings) {
  // join with markers
  let html = '';
  for (let i = 0; i < strings.length; i++) {
    html += strings[i];
    if (i < strings.length - 1) html += `${_MARKER}${i}\x01`;
  }

  // detect SVG/MathML root
  const trimmed = html.trimStart();
  let ns = null;
  if (trimmed.startsWith('<svg')) ns = 'http://www.w3.org/2000/svg';
  else if (trimmed.startsWith('<math')) ns = 'http://www.w3.org/1998/Math/MathML';

  // parse with native HTML parser
  const tpl = document.createElement('template');
  if (ns) {
    const wrapper = document.createElementNS(ns, ns === 'http://www.w3.org/2000/svg' ? 'svg' : 'math');
    wrapper.innerHTML = html;
    while (wrapper.firstChild) tpl.content.appendChild(wrapper.firstChild);
  } else {
    tpl.innerHTML = html;
  }

  // find binding locations by walking the parsed tree
  const bindings = [];
  _findBindings(tpl.content, bindings);

  return { tpl, bindings };
}

const _MARKER_RE = /\x01sr:(\d+)\x01/;
const _MARKER_RE_G = /\x01sr:(\d+)\x01/g;

function _findBindings(node, bindings) {
  if (node.nodeType === 1) { // Element
    // scan attributes for markers
    const attrs = [...node.attributes];
    for (const attr of attrs) {
      const m = attr.value.match(_MARKER_RE);
      if (m) {
        const idx = parseInt(m[1]);
        node.removeAttribute(attr.name);
        bindings.push({ type: 'attr', path: _nodePath(node), name: attr.name, idx });
      }
    }
  }
  if (node.nodeType === 3) { // Text
    const m = node.textContent.match(_MARKER_RE);
    if (m) {
      // split text node around markers: before | anchor | ... | after
      const parts = node.textContent.split(_MARKER_RE_G);
      const parent = node.parentNode;
      const ref = node.nextSibling;
      parent.removeChild(node);
      for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 0) {
          // static text
          if (parts[i]) parent.insertBefore(document.createTextNode(parts[i]), ref);
        } else {
          // marker index — insert anchor text node
          const anchor = document.createTextNode('');
          parent.insertBefore(anchor, ref);
          bindings.push({ type: 'text', path: _nodePath(anchor), idx: parseInt(parts[i]) });
        }
      }
      return; // children already processed via split
    }
  }
  // recurse children (copy array since we may modify)
  const children = [...node.childNodes];
  for (const child of children) _findBindings(child, bindings);
}

function _nodePath(target) {
  const path = [];
  let node = target;
  while (node.parentNode) {
    const parent = node.parentNode;
    let idx = 0;
    for (let c = parent.firstChild; c; c = c.nextSibling, idx++) {
      if (c === node) break;
    }
    path.unshift(idx);
    node = parent;
  }
  return path;
}

function _resolve(root, path) {
  let node = root;
  for (const idx of path) {
    node = node.childNodes[idx];
    if (!node) return null;
  }
  return node;
}

function _instantiate(cached, values) {
  const fragment = cached.tpl.content.cloneNode(true);
  const disposers = [];

  for (const b of cached.bindings) {
    const value = values[b.idx];
    const node = _resolve(fragment, b.path);
    if (!node) continue;
    if (b.type === 'text') {
      _bindText(node, value, disposers);
    } else if (b.type === 'attr') {
      _bindAttr(node, b.name, value, disposers);
    }
  }

  fragment._disposers = disposers;
  // strip leading/trailing whitespace-only text nodes
  while (fragment.firstChild && fragment.firstChild.nodeType === 3 && !fragment.firstChild.textContent.trim()) {
    fragment.removeChild(fragment.firstChild);
  }
  while (fragment.lastChild && fragment.lastChild.nodeType === 3 && !fragment.lastChild.textContent.trim()) {
    fragment.removeChild(fragment.lastChild);
  }
  const children = [...fragment.childNodes];
  if (children.length === 1) {
    children[0]._disposers = disposers;
    return children[0];
  }
  return fragment;
}

// ── binding helpers ──

function _bindText(anchor, value, disposers) {
  if (typeof value === 'function' && !_isNode(value)) {
    // reactive text
    const text = document.createTextNode('');
    anchor.parentNode.replaceChild(text, anchor);
    disposers.push(effect(() => {
      const v = value();
      text.textContent = v == null ? '' : String(v);
    }));
  } else if (_isNode(value)) {
    anchor.parentNode.replaceChild(value, anchor);
  } else if (Array.isArray(value)) {
    const frag = document.createDocumentFragment();
    for (const item of value) {
      if (_isNode(item)) frag.appendChild(item);
      else frag.appendChild(document.createTextNode(item == null ? '' : String(item)));
    }
    anchor.parentNode.replaceChild(frag, anchor);
  } else {
    anchor.textContent = value == null ? '' : String(value);
  }
}

function _bindAttr(el, name, value, disposers) {
  if (name.startsWith('on') && name.length > 2) {
    // event listener
    el.addEventListener(name.slice(2), value);
  } else if (typeof value === 'function') {
    // reactive attribute
    disposers.push(effect(() => {
      const v = value();
      _setAttr(el, name, v);
    }));
  } else {
    _setAttr(el, name, value);
  }
}

function _setAttr(el, name, value) {
  if (name === 'class' || name === 'className') {
    el.className = value || '';
  } else if (name === 'style' && typeof value === 'object') {
    Object.assign(el.style, value);
  } else if (typeof value === 'boolean') {
    if (value) el.setAttribute(name, '');
    else el.removeAttribute(name);
  } else if (value == null) {
    el.removeAttribute(name);
  } else {
    el.setAttribute(name, value);
  }
}

export function _isNode(v) {
  return v && typeof v === 'object' && (v.nodeType || v instanceof DocumentFragment);
}

// ── hyperscript mode ──

function _hyperscriptMode(tag, props, children) {
  if (typeof tag === 'function') {
    // component — just call it
    return tag(props, ...children);
  }

  const el = document.createElement(tag);
  const disposers = [];

  if (props && typeof props === 'object' && !_isNode(props)) {
    for (const [k, v] of Object.entries(props)) {
      _bindAttr(el, k, v, disposers);
    }
  } else if (props != null) {
    // props is actually a child
    children = [props, ...children];
  }

  for (const child of children) {
    _appendHChild(el, child, disposers);
  }

  if (disposers.length) el._disposers = disposers;
  return el;
}

function _appendHChild(parent, child, disposers) {
  if (child == null || child === false) return;
  if (_isNode(child)) {
    parent.appendChild(child);
  } else if (typeof child === 'function') {
    const text = document.createTextNode('');
    parent.appendChild(text);
    disposers.push(effect(() => {
      const v = child();
      text.textContent = v == null ? '' : String(v);
    }));
  } else if (Array.isArray(child)) {
    for (const item of child) _appendHChild(parent, item, disposers);
  } else {
    parent.appendChild(document.createTextNode(String(child)));
  }
}
