// Format string parser: 'r--o' → { color, linestyle, marker }

const _colorChars = { b: '#4488ff', g: '#44bb44', r: '#ee4444', c: '#44dddd', m: '#dd44dd', y: '#dddd44', k: '#000000', w: '#ffffff' };
const _markerChars = new Set(['o', 's', '^', 'v', '<', '>', 'd', '+', 'x', '.']);

export function parseFormat(fmt) {
  if (!fmt || typeof fmt !== 'string') return {};
  const result = {};
  let i = 0;
  // check for color char
  if (_colorChars[fmt[i]]) {
    result.color = _colorChars[fmt[i]];
    i++;
  }
  // check for linestyle
  if (fmt[i] === '-') {
    if (fmt[i + 1] === '-') { result.linestyle = '--'; i += 2; }
    else if (fmt[i + 1] === '.') { result.linestyle = '-.'; i += 2; }
    else { result.linestyle = '-'; i++; }
  } else if (fmt[i] === ':') {
    result.linestyle = ':';
    i++;
  }
  // check for marker
  if (_markerChars.has(fmt[i])) {
    result.marker = fmt[i];
    i++;
  }
  return result;
}

export function dashArray(linestyle) {
  switch (linestyle) {
    case '--': return [6, 4];
    case '-.': return [6, 2, 2, 2];
    case ':': return [2, 3];
    default: return [];
  }
}
