// ── @python COMPAT HELPERS ──
// Python-familiar functions for users transitioning from Python.
// Each has a .help property showing the idiomatic JS equivalent.

function range(a, b, step) {
  let start, stop, s;
  if (b === undefined) { start = 0; stop = a; s = 1; }
  else { start = a; stop = b; s = step || 1; }
  const result = [];
  if (s > 0) { for (let i = start; i < stop; i += s) result.push(i); }
  else if (s < 0) { for (let i = start; i > stop; i += s) result.push(i); }
  return result;
}
range.help = 'JS: Array.from({length: n}, (_, i) => start + i * step)';

function enumerate(arr) {
  return arr.map((v, i) => [i, v]);
}
enumerate.help = 'JS: arr.map((v, i) => [i, v]) or arr.entries()';

function len(x) {
  if (x == null) throw new TypeError('len() of unsized object');
  if (x.size !== undefined) return x.size;
  return x.length;
}
len.help = 'JS: x.length or x.size';

function sorted(arr, key, reverse) {
  const copy = [...arr];
  if (key) copy.sort((a, b) => {
    const ka = key(a), kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  else copy.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  if (reverse) copy.reverse();
  return copy;
}
sorted.help = 'JS: arr.toSorted((a, b) => ...)';

function reversed(arr) {
  return [...arr].reverse();
}
reversed.help = 'JS: arr.toReversed()';

function isinstance(obj, cls) {
  return obj instanceof cls;
}
isinstance.help = 'JS: obj instanceof cls';

function type(x) {
  if (x === null) return 'null';
  if (Array.isArray(x)) return 'array';
  return typeof x;
}
type.help = 'JS: typeof x';

export const python = {
  range, enumerate, len, sorted, reversed,
  isinstance, type,
};

export function zenOfPython() {
  return [
    'The Zen of Python, by Tim Peters',
    '',
    'Beautiful is better than ugly.',
    'Explicit is better than implicit.',
    'Simple is better than complex.',
    'Complex is better than complicated.',
    'Flat is better than nested.',
    'Sparse is better than dense.',
    'Readability counts.',
    "Special cases aren't special enough to break the rules.",
    'Although practicality beats purity.',
    'Errors should never pass silently.',
    'Unless explicitly silenced.',
    'In the face of ambiguity, refuse the temptation to guess.',
    'There should be one-- and preferably only one --obvious way to do it.',
    "Although that way may not be obvious at first unless you're Dutch.",
    'Now is better than never.',
    'Although never is often better than *right* now.',
    "If the implementation is hard to explain, it's a bad idea.",
    'If the implementation is easy to explain, it may be a good idea.',
    "Namespaces are one honking great idea -- let's do more of those!",
  ].join('\n');
}
