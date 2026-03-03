// ── Cell address helpers ──

export function colLetter(index) {
  let s = '';
  let n = index + 1;
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

export function colIndex(letter) {
  let index = 0;
  for (let i = 0; i < letter.length; i++) {
    index = index * 26 + (letter.charCodeAt(i) - 64);
  }
  return index - 1;
}

export function cellRef(col, row, absolute) {
  const l = colLetter(col);
  const r = row + 1;
  return absolute ? `$${l}$${r}` : `${l}${r}`;
}

export function parseRef(ref) {
  const m = ref.match(/^\$?([A-Z]+)\$?(\d+)$/);
  if (!m) return null;
  return { col: colIndex(m[1]), row: parseInt(m[2]) - 1 };
}

// ── Date conversion ──
// Excel date serial: days since 1899-12-30
// Serial 1 = Jan 1, 1900. Serial 60 = Feb 29, 1900 (doesn't exist — 1900 leap year bug).

const EPOCH = Date.UTC(1899, 11, 31); // Dec 31, 1899 = "serial 0"
const MS_PER_DAY = 86400000;

export function dateToSerial(date) {
  const utc = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((utc - EPOCH) / MS_PER_DAY);
  return days > 59 ? days + 1 : days;
}

export function serialToDate(serial) {
  const adjusted = serial > 59 ? serial - 1 : serial;
  return new Date(EPOCH + adjusted * MS_PER_DAY);
}
