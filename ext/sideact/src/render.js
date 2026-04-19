// @gcu/sideact — render: list rendering (each) and root mount (render).
// Requires `document`.

import { effect } from './signals.js';
import { _isNode } from './dom.js';

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
