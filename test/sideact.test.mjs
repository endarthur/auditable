import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── DOM shim ──

class _Node {
  constructor(type) {
    this.nodeType = type;
    this.childNodes = [];
    this.parentNode = null;
    this.textContent = '';
    this._disposers = null;
  }
  get firstChild() { return this.childNodes[0] || null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[i + 1] || null;
  }
  appendChild(child) {
    if (child.nodeType === 11) { // DocumentFragment
      const kids = [...child.childNodes];
      for (const k of kids) this.appendChild(k);
      return child;
    }
    if (child.parentNode) child.remove();
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  insertBefore(child, ref) {
    if (child.nodeType === 11) {
      const kids = [...child.childNodes];
      for (const k of kids) this.insertBefore(k, ref);
      return child;
    }
    if (child.parentNode) child.remove();
    child.parentNode = this;
    if (!ref) { this.childNodes.push(child); return child; }
    const i = this.childNodes.indexOf(ref);
    if (i < 0) this.childNodes.push(child);
    else this.childNodes.splice(i, 0, child);
    return child;
  }
  replaceChild(newChild, oldChild) {
    const i = this.childNodes.indexOf(oldChild);
    if (i < 0) return oldChild;
    oldChild.parentNode = null;
    newChild.parentNode = this;
    this.childNodes[i] = newChild;
    return oldChild;
  }
  remove() {
    if (!this.parentNode) return;
    const i = this.parentNode.childNodes.indexOf(this);
    if (i >= 0) this.parentNode.childNodes.splice(i, 1);
    this.parentNode = null;
  }
  cloneNode(deep) {
    const clone = new this.constructor(this.nodeType);
    // for non-element nodes, copy textContent directly
    if (this.nodeType !== 1 && this.nodeType !== 11) clone.textContent = this.textContent;
    if (this._tag) clone._tag = this._tag;
    if (this._attrs) clone._attrs = new Map(this._attrs);
    if (this.className !== undefined) clone.className = this.className;
    if (this.style) clone.style = { ...this.style };
    if (deep) {
      for (const child of this.childNodes) {
        clone.appendChild(child.cloneNode(true));
      }
    }
    return clone;
  }
}

class _Element extends _Node {
  constructor(tag) {
    super(1);
    this._tag = tag;
    this._attrs = new Map();
    this._listeners = {};
    this.className = '';
    this.style = {};
  }
  get attributes() {
    return [...this._attrs.entries()].map(([name, value]) => ({ name, value }));
  }
  setAttribute(name, value) { this._attrs.set(name, String(value)); }
  getAttribute(name) { return this._attrs.get(name) ?? null; }
  removeAttribute(name) { this._attrs.delete(name); }
  addEventListener(type, fn) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(fn);
  }
  _dispatch(type, event) {
    for (const fn of (this._listeners[type] || [])) fn(event);
  }
  get innerHTML() { return ''; }
  set innerHTML(html) {
    this.childNodes = [];
    // minimal HTML parser for test purposes
    _parseMinimalHTML(html, this);
  }
  set textContent(v) {
    this.childNodes = [];
    if (v) this.appendChild(new _Text(String(v)));
  }
  get textContent() {
    return this.childNodes.map(c => c.textContent).join('');
  }
}

class _Text extends _Node {
  constructor(text) {
    super(3);
    this.textContent = text || '';
  }
  cloneNode() { return new _Text(this.textContent); }
}

class _Comment extends _Node {
  constructor(text) {
    super(8);
    this.textContent = text || '';
  }
  cloneNode() { return new _Comment(this.textContent); }
}

class _Fragment extends _Node {
  constructor() { super(11); }
  cloneNode(deep) {
    const f = new _Fragment();
    if (deep) for (const c of this.childNodes) f.appendChild(c.cloneNode(true));
    return f;
  }
}

class _Template extends _Element {
  constructor() {
    super('template');
    this.content = new _Fragment();
  }
  set innerHTML(html) {
    this.content = new _Fragment();
    _parseMinimalHTML(html, this.content);
  }
}

// Minimal HTML parser — handles elements, text, comments, attributes
function _parseMinimalHTML(html, parent) {
  let pos = 0;
  const len = html.length;

  function parseNodes(container) {
    while (pos < len) {
      if (html[pos] === '<') {
        if (html.startsWith('<!--', pos)) {
          // comment
          pos += 4;
          const end = html.indexOf('-->', pos);
          const text = end >= 0 ? html.slice(pos, end) : html.slice(pos);
          container.appendChild(new _Comment(text));
          pos = end >= 0 ? end + 3 : len;
        } else if (html[pos + 1] === '/') {
          // closing tag — return to parent
          const end = html.indexOf('>', pos);
          pos = end >= 0 ? end + 1 : len;
          return;
        } else {
          // opening tag
          pos++; // skip <
          let tag = '';
          while (pos < len && /[a-zA-Z0-9\-]/.test(html[pos])) tag += html[pos++];
          const el = new _Element(tag);

          // parse attributes
          while (pos < len && html[pos] !== '>' && !(html[pos] === '/' && html[pos + 1] === '>')) {
            while (pos < len && /\s/.test(html[pos])) pos++;
            if (html[pos] === '>' || (html[pos] === '/' && html[pos + 1] === '>')) break;
            let aName = '';
            while (pos < len && /[a-zA-Z0-9\-_]/.test(html[pos])) aName += html[pos++];
            if (html[pos] === '=') {
              pos++; // skip =
              let aVal = '';
              if (html[pos] === '"' || html[pos] === "'") {
                const q = html[pos++];
                while (pos < len && html[pos] !== q) aVal += html[pos++];
                pos++; // skip closing quote
              } else {
                while (pos < len && /[^\s>]/.test(html[pos])) aVal += html[pos++];
              }
              el.setAttribute(aName, aVal);
            } else if (aName) {
              el.setAttribute(aName, '');
            }
          }

          const selfClosing = html[pos] === '/';
          if (selfClosing) pos++;
          if (html[pos] === '>') pos++;

          container.appendChild(el);

          if (!selfClosing && !['br', 'hr', 'img', 'input', 'meta', 'link'].includes(tag)) {
            parseNodes(el);
          }
        }
      } else {
        // text
        let text = '';
        while (pos < len && html[pos] !== '<') text += html[pos++];
        if (text.trim()) container.appendChild(new _Text(text));
      }
    }
  }

  parseNodes(parent);
}

// TreeWalker shim
class _TreeWalker {
  constructor(root, whatToShow) {
    this._nodes = [];
    this.currentNode = null;
    this._idx = -1;
    _collectNodes(root, whatToShow, this._nodes);
  }
  nextNode() {
    this._idx++;
    if (this._idx < this._nodes.length) {
      this.currentNode = this._nodes[this._idx];
      return this.currentNode;
    }
    return null;
  }
}

function _collectNodes(node, whatToShow, out) {
  // whatToShow: 1=Element, 4=Text, 128=Comment
  if (whatToShow & _nodeFilter(node.nodeType)) out.push(node);
  for (const child of node.childNodes) _collectNodes(child, whatToShow, out);
}
function _nodeFilter(type) {
  if (type === 1) return 1;
  if (type === 3) return 4;
  if (type === 8) return 128;
  return 0;
}

// Install shims
globalThis.document = {
  createElement(tag) {
    if (tag === 'template') return new _Template();
    return new _Element(tag);
  },
  createElementNS(ns, tag) { return new _Element(tag); },
  createTextNode(text) { return new _Text(text); },
  createComment(text) { return new _Comment(text); },
  createDocumentFragment() { return new _Fragment(); },
  createTreeWalker(root, whatToShow) { return new _TreeWalker(root, whatToShow); },
  querySelector: () => null,
  querySelectorAll: () => [],
};
globalThis.DocumentFragment = _Fragment;
globalThis.window = globalThis;
globalThis.queueMicrotask = globalThis.queueMicrotask || (fn => Promise.resolve().then(fn));

const { signal, computed, effect, batch, h, each, render } = await import('../ext/sideact/index.js');

// helper: flush microtasks
const tick = () => new Promise(r => setTimeout(r, 0));

// ── signal ──

describe('signal', () => {
  it('read initial value', () => {
    const [count] = signal(0);
    assert.strictEqual(count(), 0);
  });

  it('write and read', () => {
    const [count, setCount] = signal(0);
    setCount(5);
    assert.strictEqual(count(), 5);
  });

  it('functional update', () => {
    const [count, setCount] = signal(10);
    setCount(c => c + 1);
    assert.strictEqual(count(), 11);
  });

  it('same value skips notification', async () => {
    const [val, setVal] = signal(1);
    let runs = 0;
    effect(() => { val(); runs++; });
    await tick();
    const before = runs;
    setVal(1); // same value
    await tick();
    assert.strictEqual(runs, before);
  });
});

// ── computed ──

describe('computed', () => {
  it('derives from signal', () => {
    const [a] = signal(2);
    const [b] = signal(3);
    const sum = computed(() => a() + b());
    assert.strictEqual(sum(), 5);
  });

  it('recomputes on change', async () => {
    const [a, setA] = signal(2);
    const [b] = signal(3);
    const sum = computed(() => a() + b());
    setA(10);
    assert.strictEqual(sum(), 13);
  });

  it('chains', () => {
    const [x, setX] = signal(1);
    const doubled = computed(() => x() * 2);
    const quadrupled = computed(() => doubled() * 2);
    assert.strictEqual(quadrupled(), 4);
    setX(5);
    assert.strictEqual(quadrupled(), 20);
  });
});

// ── effect ──

describe('effect', () => {
  it('runs immediately', () => {
    let ran = false;
    effect(() => { ran = true; });
    assert.strictEqual(ran, true);
  });

  it('re-runs on signal change', async () => {
    const [val, setVal] = signal(0);
    const log = [];
    effect(() => { log.push(val()); });
    assert.deepStrictEqual(log, [0]);
    setVal(1);
    await tick();
    assert.deepStrictEqual(log, [0, 1]);
  });

  it('cleanup runs before re-run', async () => {
    const [val, setVal] = signal('a');
    const log = [];
    effect(() => {
      const v = val();
      log.push(`run:${v}`);
      return () => log.push(`cleanup:${v}`);
    });
    assert.deepStrictEqual(log, ['run:a']);
    setVal('b');
    await tick();
    assert.deepStrictEqual(log, ['run:a', 'cleanup:a', 'run:b']);
  });

  it('dispose stops execution', async () => {
    const [val, setVal] = signal(0);
    let runs = 0;
    const dispose = effect(() => { val(); runs++; });
    assert.strictEqual(runs, 1);
    dispose();
    setVal(1);
    await tick();
    assert.strictEqual(runs, 1);
  });

  it('dispose runs cleanup', () => {
    let cleaned = false;
    const dispose = effect(() => {
      return () => { cleaned = true; };
    });
    dispose();
    assert.strictEqual(cleaned, true);
  });
});

// ── batch ──

describe('batch', () => {
  it('batches multiple writes', async () => {
    const [a, setA] = signal(0);
    const [b, setB] = signal(0);
    let runs = 0;
    effect(() => { a(); b(); runs++; });
    assert.strictEqual(runs, 1);
    batch(() => { setA(1); setB(2); });
    await tick();
    assert.strictEqual(runs, 2); // only one re-run, not two
  });
});

// ── h: hyperscript mode ──

describe('h — hyperscript', () => {
  it('creates element', () => {
    const el = h('div');
    assert.strictEqual(el._tag, 'div');
  });

  it('sets attributes', () => {
    const el = h('div', { class: 'foo', id: 'bar' });
    assert.strictEqual(el.className, 'foo');
    assert.strictEqual(el.getAttribute('id'), 'bar');
  });

  it('appends text children', () => {
    const el = h('span', null, 'hello');
    assert.strictEqual(el.textContent, 'hello');
  });

  it('appends nested elements', () => {
    const el = h('div', null, h('span', null, 'inner'));
    assert.strictEqual(el.childNodes.length, 1);
    assert.strictEqual(el.childNodes[0]._tag, 'span');
  });

  it('reactive text child', async () => {
    const [val, setVal] = signal('hello');
    const el = h('div', null, () => val());
    assert.strictEqual(el.childNodes[0].textContent, 'hello');
    setVal('world');
    await tick();
    assert.strictEqual(el.childNodes[0].textContent, 'world');
  });

  it('reactive attribute', async () => {
    const [cls, setCls] = signal('active');
    const el = h('div', { class: () => cls() });
    assert.strictEqual(el.className, 'active');
    setCls('inactive');
    await tick();
    assert.strictEqual(el.className, 'inactive');
  });

  it('event handler', () => {
    let clicked = false;
    const el = h('button', { onclick: () => { clicked = true; } });
    el._dispatch('click', {});
    assert.strictEqual(clicked, true);
  });

  it('boolean attribute', () => {
    const el = h('input', { disabled: true });
    assert.strictEqual(el.getAttribute('disabled'), '');
    const el2 = h('input', { disabled: false });
    assert.strictEqual(el2.getAttribute('disabled'), null);
  });

  it('null children are skipped', () => {
    const el = h('div', null, null, 'text', false);
    assert.strictEqual(el.childNodes.length, 1);
  });

  it('array children', () => {
    const items = ['a', 'b', 'c'];
    const el = h('ul', null, items.map(i => h('li', null, i)));
    assert.strictEqual(el.childNodes.length, 3);
  });
});

// ── h: tagged template mode ──

describe('h — tagged template', () => {
  it('creates element from template', () => {
    const el = h`<div></div>`;
    assert.strictEqual(el._tag, 'div');
  });

  it('static text content', () => {
    const el = h`<span>hello</span>`;
    assert.strictEqual(el.textContent, 'hello');
  });

  it('interpolated text', () => {
    const name = 'world';
    const el = h`<span>${name}</span>`;
    assert.strictEqual(el.textContent, 'world');
  });

  it('reactive text', async () => {
    const [val, setVal] = signal('hello');
    const el = h`<span>${() => val()}</span>`;
    assert.strictEqual(el.textContent, 'hello');
    setVal('world');
    await tick();
    assert.strictEqual(el.textContent, 'world');
  });

  it('interpolated attribute', () => {
    const el = h`<div class="${'active'}"></div>`;
    assert.strictEqual(el.className, 'active');
  });

  it('reactive attribute', async () => {
    const [cls, setCls] = signal('on');
    const el = h`<div class="${() => cls()}"></div>`;
    assert.strictEqual(el.className, 'on');
    setCls('off');
    await tick();
    assert.strictEqual(el.className, 'off');
  });

  it('event handler in template', () => {
    let clicked = false;
    const el = h`<button onclick=${() => { clicked = true; }}></button>`;
    el._dispatch('click', {});
    assert.strictEqual(clicked, true);
  });

  it('nested elements', () => {
    const el = h`<div><span>inner</span></div>`;
    assert.strictEqual(el.childNodes.length, 1);
    assert.strictEqual(el.childNodes[0]._tag, 'span');
  });

  it('multiple interpolations', async () => {
    const [a, setA] = signal(1);
    const [b, setB] = signal(2);
    const el = h`<div><span>${() => a()}</span><span>${() => b()}</span></div>`;
    const spans = el.childNodes.filter(c => c._tag === 'span');
    assert.strictEqual(spans[0].textContent, '1');
    assert.strictEqual(spans[1].textContent, '2');
    setA(10);
    await tick();
    assert.strictEqual(spans[0].textContent, '10');
    assert.strictEqual(spans[1].textContent, '2');
  });

  it('mixed static and reactive', async () => {
    const [count, setCount] = signal(0);
    const el = h`<div>count: ${() => count()}</div>`;
    // "count: " is static text, the number is reactive
    assert.ok(el.textContent.includes('0'));
    setCount(42);
    await tick();
    assert.ok(el.textContent.includes('42'));
  });
});

// ── render ──

describe('render', () => {
  it('mounts content', () => {
    const container = new _Element('div');
    render(h('span', null, 'hello'), container);
    assert.strictEqual(container.childNodes.length, 1);
    assert.strictEqual(container.childNodes[0]._tag, 'span');
  });

  it('dispose cleans up', async () => {
    const container = new _Element('div');
    const [val, setVal] = signal('a');
    const dispose = render(h('span', null, () => val()), container);
    assert.strictEqual(container.childNodes[0].childNodes[0].textContent, 'a');
    dispose();
    setVal('b');
    await tick();
    // after dispose, container is cleared
    assert.strictEqual(container.childNodes.length, 0);
  });
});

// ── composability ──

describe('composability', () => {
  it('components are just functions', () => {
    const Badge = (label, value) => h('span', { class: 'badge' }, `${label}: ${value}`);
    const el = Badge('count', 42);
    assert.strictEqual(el._tag, 'span');
    assert.ok(el.textContent.includes('42'));
  });

  it('hyperscript nests in template', () => {
    const inner = h('b', null, 'bold');
    const el = h`<div>${inner}</div>`;
    assert.strictEqual(el.childNodes.length, 1);
    assert.strictEqual(el.childNodes[0]._tag, 'b');
  });
});
