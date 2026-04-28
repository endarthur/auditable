// @gcu/menu — pure helpers. Zero DOM, zero imports.
// Used internally by menu.js; exported for test access.

// Items can be a static array or a function evaluated at open-time.
export function evaluateItems(items) {
  const arr = typeof items === 'function' ? items() : items;
  if (!Array.isArray(arr)) return [];
  return arr;
}

export function isSeparator(item) { return item === '---'; }
export function isEnabled(item)   { return !isSeparator(item) && !item.disabled; }
export function hasSubmenu(item)  { return !isSeparator(item) && item.children != null; }

export function firstEnabledIdx(items) {
  for (let i = 0; i < items.length; i++) if (isEnabled(items[i])) return i;
  return -1;
}
export function lastEnabledIdx(items) {
  for (let i = items.length - 1; i >= 0; i--) if (isEnabled(items[i])) return i;
  return -1;
}
export function nextEnabledIdx(items, from, dir) {
  const n = items.length;
  if (n === 0) return -1;
  let i = from;
  for (let k = 0; k < n; k++) {
    i = (i + dir + n) % n;
    if (isEnabled(items[i])) return i;
  }
  return from;
}

// Match an item by case-insensitive label prefix; returns next match index
// after `from` (cyclic), or -1 if none. Used by typeahead.
export function findByPrefix(items, prefix, from) {
  const p = prefix.toLowerCase();
  const n = items.length;
  if (n === 0 || !p) return -1;
  for (let k = 1; k <= n; k++) {
    const i = (from + k + n) % n;
    const it = items[i];
    if (!isEnabled(it)) continue;
    if (it.label && it.label.toLowerCase().startsWith(p)) return i;
  }
  return -1;
}
