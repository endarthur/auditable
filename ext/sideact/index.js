// @gcu/sideact — signals + templates + DOM binding
// standalone reactive UI library. zero dependencies.

// ── tracking ──

let _tracking = null;
let _batchDepth = 0;
const _pendingEffects = new Set();
let _scheduled = false;

function _flush() {
  _scheduled = false;
  const effects = [..._pendingEffects];
  _pendingEffects.clear();
  for (const e of effects) e._run();
}

function _schedule(e) {
  _pendingEffects.add(e);
  if (!_scheduled) { _scheduled = true; queueMicrotask(_flush); }
}

// ── signal ──

export function signal(initial) {
  let _value = initial;
  const _subs = new Set();

  function read() {
    if (_tracking) _subs.add(_tracking);
    return _value;
  }

  function write(v) {
    const next = typeof v === 'function' ? v(_value) : v;
    if (next === _value) return;
    _value = next;
    for (const s of _subs) {
      if (s._dirty !== undefined) s._dirty = true; // computed
      if (s._effect) _schedule(s); // effect
    }
  }

  return [read, write];
}

// ── computed ──

export function computed(fn) {
  let _value, _dirty = true;
  const _subs = new Set();

  const node = {
    _dirty: true,
    _effect: false,
    _run() {
      const prev = _tracking;
      _tracking = node;
      _value = fn();
      _tracking = prev;
      _dirty = false;
    },
  };

  function read() {
    if (_tracking) _subs.add(_tracking);
    if (_dirty || node._dirty) { node._dirty = false; node._run(); }
    return _value;
  }

  // propagate dirty to downstream
  const origDirty = Object.getOwnPropertyDescriptor(node, '_dirty');
  Object.defineProperty(node, '_dirty', {
    get() { return _dirty; },
    set(v) {
      _dirty = v;
      if (v) for (const s of _subs) {
        if (s._dirty !== undefined) s._dirty = true;
        if (s._effect) _schedule(s);
      }
    },
  });

  // initial computation to register dependencies
  node._run();

  return read;
}

// ── effect ──

export function effect(fn) {
  let _cleanup = null;
  let _disposed = false;
  const _deps = new Set(); // signals/computeds we're subscribed to

  const node = {
    _effect: true,
    _dirty: undefined,
    _run() {
      if (_disposed) return;
      if (typeof _cleanup === 'function') _cleanup();
      const prev = _tracking;
      _tracking = node;
      _cleanup = fn();
      _tracking = prev;
    },
  };

  // initial run
  node._run();

  return function dispose() {
    if (_disposed) return;
    _disposed = true;
    if (typeof _cleanup === 'function') _cleanup();
    _pendingEffects.delete(node);
  };
}

// ── batch ──

export function batch(fn) {
  _batchDepth++;
  try { fn(); } finally {
    _batchDepth--;
    if (_batchDepth === 0 && !_scheduled && _pendingEffects.size > 0) {
      _scheduled = true;
      queueMicrotask(_flush);
    }
  }
}

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
      const idx = parseInt(m[1]);
      // split text node: before | anchor | after
      const parts = node.textContent.split(_MARKER_RE_G);
      const parent = node.parentNode;
      const ref = node.nextSibling;
      parent.childNodes.splice(parent.childNodes.indexOf(node), 1);
      node.parentNode = null;
      for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 0) {
          // static text
          if (parts[i]) {
            const t = document.createTextNode(parts[i]);
            t.parentNode = parent;
            if (ref) parent.childNodes.splice(parent.childNodes.indexOf(ref), 0, t);
            else parent.childNodes.push(t);
          }
        } else {
          // marker index — replace with anchor text node
          const anchor = document.createTextNode('');
          anchor.parentNode = parent;
          if (ref) parent.childNodes.splice(parent.childNodes.indexOf(ref), 0, anchor);
          else parent.childNodes.push(anchor);
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
    path.unshift(parent.childNodes.indexOf(node));
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

function _isNode(v) {
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

// ── each ──

export function each(signalOrFn, mapFn, keyFn) {
  const frag = document.createDocumentFragment();
  const anchor = document.createComment('each');
  frag.appendChild(anchor);
  const disposers = [];

  let prevItems = [];
  let prevNodes = [];
  let prevDisposers = [];

  disposers.push(effect(() => {
    const items = typeof signalOrFn === 'function' ? signalOrFn() : signalOrFn;
    const arr = Array.isArray(items) ? items : [...items];

    if (keyFn) {
      // keyed reconciliation
      const newKeys = arr.map(keyFn);
      const prevKeys = prevItems.map(keyFn);
      const newNodes = [];
      const newDisp = [];
      const parent = anchor.parentNode;

      for (let i = 0; i < arr.length; i++) {
        const oldIdx = prevKeys.indexOf(newKeys[i]);
        if (oldIdx >= 0) {
          newNodes.push(prevNodes[oldIdx]);
          newDisp.push(prevDisposers[oldIdx]);
          prevNodes[oldIdx] = null; // mark as reused
        } else {
          const node = mapFn(arr[i], i);
          newNodes.push(node);
          newDisp.push(node._disposers || []);
        }
      }

      // remove unused old nodes
      for (let i = 0; i < prevNodes.length; i++) {
        if (prevNodes[i]) {
          prevNodes[i].remove();
          if (Array.isArray(prevDisposers[i])) prevDisposers[i].forEach(d => typeof d === 'function' && d());
        }
      }

      // insert in order
      if (parent) {
        let ref = anchor.nextSibling;
        for (const node of newNodes) {
          if (node !== ref) parent.insertBefore(node, ref);
          else ref = ref.nextSibling;
        }
      }

      prevItems = arr;
      prevNodes = newNodes;
      prevDisposers = newDisp;
    } else {
      // simple — rebuild
      const parent = anchor.parentNode;

      // remove old
      for (const node of prevNodes) node.remove();
      for (const d of prevDisposers) if (typeof d === 'function') d(); else if (Array.isArray(d)) d.forEach(dd => typeof dd === 'function' && dd());

      const newNodes = [];
      const newDisp = [];
      for (let i = 0; i < arr.length; i++) {
        const node = mapFn(arr[i], i);
        newNodes.push(node);
        newDisp.push(node._disposers || []);
        if (parent) parent.insertBefore(node, anchor.nextSibling ? null : null);
      }

      // insert after anchor
      if (parent) {
        const ref = anchor.nextSibling;
        for (const node of newNodes) parent.insertBefore(node, ref);
      }

      prevItems = arr;
      prevNodes = newNodes;
      prevDisposers = newDisp;
    }
  }));

  frag._disposers = disposers;
  return frag;
}

// ── render ──

export function render(content, container) {
  container.textContent = '';
  const allDisposers = [];

  if (_isNode(content)) {
    if (content._disposers) allDisposers.push(...content._disposers);
    container.appendChild(content);
  }

  return function dispose() {
    for (const d of allDisposers) {
      if (typeof d === 'function') d();
    }
    container.textContent = '';
  };
}
