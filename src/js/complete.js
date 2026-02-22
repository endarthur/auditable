import { S, JS_KEYWORDS, JS_BUILTINS } from './state.js';

// ── AUTOCOMPLETE ENGINE ──

// well-known property lists for dot completion on builtins
const KNOWN_PROPS = {
  Math: ['abs','acos','asin','atan','atan2','ceil','cos','exp','floor','hypot',
         'log','log2','log10','max','min','pow','random','round','sign','sin',
         'sqrt','tan','trunc','PI','E','LN2','LN10'],
  Array: ['from','isArray','of'],
  Object: ['keys','values','entries','assign','freeze','create','defineProperty','fromEntries','hasOwn'],
  JSON: ['parse','stringify'],
  console: ['log','warn','error','info','table','time','timeEnd','clear'],
  Promise: ['all','allSettled','any','race','resolve','reject'],
  Number: ['isFinite','isInteger','isNaN','parseFloat','parseInt','MAX_SAFE_INTEGER','MIN_SAFE_INTEGER','EPSILON'],
  String: ['fromCharCode','fromCodePoint','raw'],
  ui: ['display','print','canvas','table','slider','dropdown','checkbox','textInput'],
  std: ['csv','fetchJSON','sum','mean','median','extent','bin','linspace',
        'unique','zip','cross','file','download','el','copy','fmt'],
};

// common prototype methods by type
const PROTO_PROPS = {
  array: ['push','pop','shift','unshift','splice','slice','concat','join','reverse',
          'sort','map','filter','reduce','reduceRight','find','findIndex','indexOf',
          'includes','every','some','flat','flatMap','fill','forEach','at','length'],
  string: ['charAt','charCodeAt','codePointAt','concat','endsWith','includes',
           'indexOf','lastIndexOf','match','matchAll','padEnd','padStart','repeat',
           'replace','replaceAll','search','slice','split','startsWith','substring',
           'toLowerCase','toUpperCase','trim','trimEnd','trimStart','at','length'],
  number: ['toFixed','toPrecision','toString','valueOf'],
};

// ── BUILTIN HELP (injected by build.js from src/builtins.json) ──

const BUILTIN_HELP = '__AUDITABLE_BUILTINS__';

// ── FUZZY MATCHING ──

// returns { score, indices } or null if no match
// indices = positions in `text` that matched characters from `query`
function fuzzyMatch(query, text) {
  const qLen = query.length;
  const tLen = text.length;
  if (qLen === 0) return { score: 0, indices: [] };
  if (qLen > tLen) return null;

  const qLower = query.toLowerCase();
  const tLower = text.toLowerCase();

  // fast check: all query chars exist in text in order
  let qi = 0;
  for (let ti = 0; ti < tLen && qi < qLen; ti++) {
    if (qLower[qi] === tLower[ti]) qi++;
  }
  if (qi < qLen) return null;

  // find best match using a greedy approach that prefers word boundaries
  // word boundaries: start of string, after _ or $, camelCase transitions
  const indices = [];
  qi = 0;

  // first pass: try to match at word boundaries
  const boundaryIndices = [];
  let bqi = 0;
  for (let ti = 0; ti < tLen && bqi < qLen; ti++) {
    if (qLower[bqi] !== tLower[ti]) continue;
    const isBoundary = ti === 0
      || text[ti - 1] === '_' || text[ti - 1] === '$'
      || (text[ti] >= 'A' && text[ti] <= 'Z' && (ti === 0 || text[ti - 1] < 'A' || text[ti - 1] > 'Z'));
    if (isBoundary) {
      boundaryIndices.push(ti);
      bqi++;
    }
  }

  if (bqi === qLen) {
    // all chars matched at boundaries — use those indices
    indices.push(...boundaryIndices);
  } else {
    // fallback: greedy left-to-right match, prefer consecutive runs
    qi = 0;
    for (let ti = 0; ti < tLen && qi < qLen; ti++) {
      if (qLower[qi] === tLower[ti]) {
        indices.push(ti);
        qi++;
      }
    }
  }

  // score the match
  let score = 0;

  // bonus for matching at start of string
  if (indices[0] === 0) score += 10;

  // bonus for consecutive characters
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] === indices[i - 1] + 1) score += 5;
  }

  // bonus for word boundary matches
  for (const idx of indices) {
    if (idx === 0) { score += 3; continue; }
    const prev = text[idx - 1];
    if (prev === '_' || prev === '$') { score += 3; continue; }
    if (text[idx] >= 'A' && text[idx] <= 'Z' && (prev < 'A' || prev > 'Z')) score += 3;
  }

  // bonus for exact case match
  for (let i = 0; i < indices.length; i++) {
    if (query[i] === text[indices[i]]) score += 1;
  }

  // penalty for spread-out matches (large gaps between indices)
  const span = indices[indices.length - 1] - indices[0];
  score -= span * 0.5;

  // slight penalty for longer names (prefer shorter completions)
  score -= tLen * 0.1;

  return { score, indices };
}

// determine cursor context: is it inside a string or comment?
function cursorContext(code, cursor) {
  let i = 0;
  while (i < cursor) {
    const ch = code[i];
    // single-line comment
    if (ch === '/' && code[i + 1] === '/') {
      const nl = code.indexOf('\n', i);
      if (nl === -1 || nl >= cursor) return 'comment';
      i = nl + 1;
      continue;
    }
    // block comment
    if (ch === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      if (end === -1 || end + 2 > cursor) return 'comment';
      i = end + 2;
      continue;
    }
    // single-quoted string
    if (ch === "'") {
      i++;
      while (i < code.length) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === "'") { i++; break; }
        if (i >= cursor) return 'string';
        i++;
      }
      continue;
    }
    // double-quoted string
    if (ch === '"') {
      i++;
      while (i < code.length) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === '"') { i++; break; }
        if (i >= cursor) return 'string';
        i++;
      }
      continue;
    }
    // template literal (possibly tagged)
    if (ch === '`') {
      // look back for a tag name: identifier immediately before the backtick
      let tagName = null;
      if (i > 0) {
        let te = i;
        let ts = te;
        while (ts > 0 && /\w/.test(code[ts - 1])) ts--;
        if (ts < te) {
          const candidate = code.slice(ts, te);
          if (typeof window !== 'undefined' && window._taggedLanguages
              && window._taggedLanguages[candidate]) {
            tagName = candidate;
          }
        }
      }

      i++;
      let depth = 0;
      while (i < code.length) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === '$' && code[i + 1] === '{') {
          depth++;
          i += 2;
          // inside ${...} — this is code context
          let braces = 1;
          while (i < code.length && braces > 0) {
            if (code[i] === '{') braces++;
            else if (code[i] === '}') { braces--; if (braces === 0) break; }
            if (i >= cursor) return 'code'; // inside template expression = code
            i++;
          }
          if (i >= cursor) return 'code';
          i++; // skip closing }
          continue;
        }
        if (code[i] === '`') { i++; break; }
        if (i >= cursor) return tagName ? { type: 'tagged', lang: tagName } : 'string';
        i++;
      }
      continue;
    }
    i++;
  }
  return 'code';
}

// extract the word being typed at cursor position
function extractPrefix(code, cursor) {
  let end = cursor;
  let start = cursor;
  while (start > 0 && /[a-zA-Z0-9_$]/.test(code[start - 1])) start--;
  return { prefix: code.slice(start, end), start };
}

// detect dot access: returns the expression before the dot, or null
function detectDot(code, cursor) {
  // cursor is right after a dot or after dot + partial word
  const before = code.slice(0, cursor);
  // match patterns like "identifier." or "identifier.par" at end
  const m = before.match(/([a-zA-Z_$][\w$]*)\.\s*([a-zA-Z_$][\w$]*)?$/);
  if (m) return { obj: m[1], prefix: m[2] || '' };
  return null;
}

function getPropsForValue(val) {
  if (val == null) return [];
  const props = new Set();
  // own properties
  const own = Object.getOwnPropertyNames(val);
  for (const p of own) {
    if (/^[a-zA-Z_$]/.test(p)) props.add(p);
  }
  // prototype chain (1 level)
  const proto = Object.getPrototypeOf(val);
  if (proto && proto !== Object.prototype) {
    try {
      const pNames = Object.getOwnPropertyNames(proto);
      for (const p of pNames) {
        if (p !== 'constructor' && /^[a-zA-Z_$]/.test(p)) props.add(p);
      }
    } catch {}
  }
  return [...props];
}

export function getCompletions(code, cursor, cellId) {
  const ctx = cursorContext(code, cursor);

  // tagged template literal — delegate to extension completions
  if (ctx && typeof ctx === 'object' && ctx.type === 'tagged') {
    const lang = typeof window !== 'undefined' && window._taggedLanguages
      && window._taggedLanguages[ctx.lang];
    if (lang && lang.completions) {
      const { prefix, start } = extractPrefix(code, cursor);
      if (!prefix) return { prefix: '', items: [] };
      const extItems = lang.completions(prefix);
      // score and annotate items
      const items = [];
      for (const it of extItems) {
        const m = fuzzyMatch(prefix, it.text);
        if (m) items.push({ text: it.text, kind: it.kind || 'var', score: m.score, indices: m.indices });
      }
      items.sort((a, b) => b.score - a.score || a.text.localeCompare(b.text));
      return { prefix, items: items.slice(0, 30) };
    }
    return { prefix: '', items: [] };
  }

  if (ctx !== 'code') return { prefix: '', items: [] };

  // check for dot completion
  const dot = detectDot(code, cursor);
  if (dot) {
    const items = [];
    const prefix = dot.prefix;
    let propList = [];

    // check known builtins
    if (KNOWN_PROPS[dot.obj]) {
      propList = KNOWN_PROPS[dot.obj];
    } else if (dot.obj in S.scope) {
      // live value inspection
      const val = S.scope[dot.obj];
      if (val != null) {
        propList = getPropsForValue(val);
        // also add type-based suggestions
        if (Array.isArray(val)) propList = [...new Set([...propList, ...PROTO_PROPS.array])];
        else if (typeof val === 'string') propList = [...new Set([...propList, ...PROTO_PROPS.string])];
        else if (typeof val === 'number') propList = [...new Set([...propList, ...PROTO_PROPS.number])];
      }
    }

    for (const p of propList) {
      if (!prefix) {
        items.push({ text: p, kind: 'prop', score: 0, indices: [] });
        continue;
      }
      const m = fuzzyMatch(prefix, p);
      if (m) items.push({ text: p, kind: 'prop', score: m.score, indices: m.indices });
    }

    items.sort((a, b) => b.score - a.score || a.text.localeCompare(b.text));
    return { prefix, items: items.slice(0, 30) };
  }

  // word prefix completion
  const { prefix, start } = extractPrefix(code, cursor);
  if (!prefix) return { prefix: '', items: [] };

  const items = [];
  const seen = new Set();

  // collect candidates from all sources with their kind
  const candidates = [];

  // 1. scope variables
  for (const name of Object.keys(S.scope)) {
    if (!seen.has(name)) { seen.add(name); candidates.push({ text: name, kind: 'var' }); }
  }

  // 2. own cell defines
  const cell = S.cells.find(c => c.id === cellId);
  if (cell && cell.defines) {
    for (const name of cell.defines) {
      if (!seen.has(name)) { seen.add(name); candidates.push({ text: name, kind: 'def' }); }
    }
  }

  // 3. builtin functions (with help detail)
  for (const name of Object.keys(BUILTIN_HELP)) {
    if (!seen.has(name)) {
      seen.add(name);
      const h = BUILTIN_HELP[name];
      candidates.push({ text: name, kind: 'fn', detail: h.sig });
    }
  }

  // 4. JS builtins
  for (const name of JS_BUILTINS) {
    if (!seen.has(name)) { seen.add(name); candidates.push({ text: name, kind: 'const' }); }
  }

  // 5. JS keywords (min 2 chars to avoid noise)
  if (prefix.length >= 2) {
    for (const name of JS_KEYWORDS) {
      if (!seen.has(name)) { seen.add(name); candidates.push({ text: name, kind: 'kw' }); }
    }
  }

  // fuzzy match all candidates
  for (const c of candidates) {
    if (c.text === prefix) continue; // skip exact match (already typed)
    const m = fuzzyMatch(prefix, c.text);
    if (m) {
      const item = { text: c.text, kind: c.kind, score: m.score, indices: m.indices };
      if (c.detail) item.detail = c.detail;
      items.push(item);
    }
  }

  // sort by score descending, then alphabetical
  items.sort((a, b) => b.score - a.score || a.text.localeCompare(b.text));

  return { prefix, items: items.slice(0, 30) };
}

// ── TEXTAREA ADAPTER ──

const KIND_LABELS = { var: 'v', fn: 'f', kw: 'k', const: 'c', prop: 'p', def: 'd' };

let activeMenu = null;
let activeState = null;
let activeSigHint = null;

export function dismissAutocomplete() {
  if (activeMenu) {
    activeMenu.remove();
    activeMenu = null;
    activeState = null;
  }
}

function dismissSigHint() {
  if (activeSigHint) {
    activeSigHint.remove();
    activeSigHint = null;
  }
}

// detect if cursor is inside a function call's arguments for a known builtin
function detectCallContext(code, cursor) {
  // scan backwards from cursor to find an unmatched (
  let depth = 0;
  let i = cursor - 1;
  while (i >= 0) {
    const ch = code[i];
    if (ch === ')') depth++;
    else if (ch === '(') {
      if (depth === 0) {
        // found the opening paren — extract the function name before it (including dot for ui.slider etc.)
        let end = i;
        let start = end - 1;
        while (start >= 0 && /[a-zA-Z0-9_$.]/.test(code[start])) start--;
        start++;
        const fnName = code.slice(start, end);
        if (BUILTIN_HELP[fnName]) {
          // figure out which parameter we're on by counting commas at depth 0
          let paramIdx = 0;
          let d = 0;
          for (let j = i + 1; j < cursor; j++) {
            if (code[j] === '(' || code[j] === '[' || code[j] === '{') d++;
            else if (code[j] === ')' || code[j] === ']' || code[j] === '}') d--;
            else if (code[j] === ',' && d === 0) paramIdx++;
          }
          return { fnName, parenPos: i, paramIdx };
        }
        return null;
      }
      depth--;
    }
    i--;
  }
  return null;
}

function showSigHint(ta) {
  const code = ta.value;
  const cursor = ta.selectionStart;
  if (ta.selectionStart !== ta.selectionEnd) { dismissSigHint(); return; }

  const ctx = cursorContext(code, cursor);
  if (ctx !== 'code') { dismissSigHint(); return; }

  const call = detectCallContext(code, cursor);
  if (!call) { dismissSigHint(); return; }

  const wrap = ta.closest('.editor-wrap');
  if (!wrap) { dismissSigHint(); return; }

  const help = BUILTIN_HELP[call.fnName];
  const pos = measureCursorPos(ta, call.parenPos);

  if (!activeSigHint) {
    activeSigHint = document.createElement('div');
    activeSigHint.className = 'ac-sig-hint';
    wrap.appendChild(activeSigHint);
  } else if (activeSigHint.parentElement !== wrap) {
    activeSigHint.remove();
    wrap.appendChild(activeSigHint);
  }

  // highlight current parameter in the signature
  const sigHtml = highlightParam(help.sig, call.paramIdx);
  activeSigHint.innerHTML = `<span class="ac-sig-fn">${sigHtml}</span><span class="ac-sig-desc">${esc(help.desc)}</span>`;

  const cs = getComputedStyle(ta);
  const padLeft = parseFloat(cs.paddingLeft) || 0;
  const padTop = parseFloat(cs.paddingTop) || 0;
  const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;

  const left = pos.x + padLeft - ta.scrollLeft;

  // place above the current line; pos.y is bottom of the line
  // so subtract lineHeight (to get top of line) then the hint's own height
  activeSigHint.style.left = left + 'px';
  activeSigHint.style.top = '0px'; // render off-screen first to measure
  activeSigHint.style.visibility = 'hidden';
  const hintH = activeSigHint.offsetHeight || lineHeight;
  activeSigHint.style.visibility = '';

  let top = pos.y + padTop - ta.scrollTop - lineHeight - hintH;

  // if it would go above the editor, show below the current line instead
  const wrapRect = wrap.getBoundingClientRect();
  const taRect = ta.getBoundingClientRect();
  const absTop = taRect.top + top;
  if (absTop < wrapRect.top) {
    top = pos.y + padTop - ta.scrollTop;
  }

  activeSigHint.style.top = top + 'px';
}

function highlightParam(sig, paramIdx) {
  // find the params inside parens
  const openParen = sig.indexOf('(');
  if (openParen === -1) return esc(sig);
  const closeParen = sig.lastIndexOf(')');
  if (closeParen === -1) return esc(sig);

  const before = sig.slice(0, openParen + 1);
  const params = sig.slice(openParen + 1, closeParen);
  const after = sig.slice(closeParen);

  // split on commas (respecting nested braces)
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < params.length; i++) {
    if (params[i] === '{' || params[i] === '(' || params[i] === '[') depth++;
    else if (params[i] === '}' || params[i] === ')' || params[i] === ']') depth--;
    else if (params[i] === ',' && depth === 0) {
      parts.push(params.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(params.slice(start));

  let html = esc(before);
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) html += esc(',');
    if (i === paramIdx) {
      html += '<span class="ac-sig-active">' + esc(parts[i]) + '</span>';
    } else {
      html += esc(parts[i]);
    }
  }
  html += esc(after);
  return html;
}

function measureCursorPos(ta, cursor) {
  const text = ta.value.substring(0, cursor);
  const lines = text.split('\n');
  const lineNum = lines.length - 1;
  const colText = lines[lineNum];

  // measure column offset using a hidden span
  let measurer = ta._acMeasurer;
  if (!measurer) {
    measurer = document.createElement('span');
    measurer.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;pointer-events:none;';
    document.body.appendChild(measurer);
    ta._acMeasurer = measurer;
  }
  const cs = getComputedStyle(ta);
  measurer.style.font = cs.font;
  measurer.style.fontSize = cs.fontSize;
  measurer.style.fontFamily = cs.fontFamily;
  measurer.style.letterSpacing = cs.letterSpacing;
  measurer.style.tabSize = cs.tabSize;
  measurer.textContent = colText;

  const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
  const x = measurer.offsetWidth;
  const y = (lineNum + 1) * lineHeight;

  return { x, y, lineHeight };
}

function highlightMatches(text, indices) {
  if (!indices || !indices.length) return esc(text);
  const set = new Set(indices);
  let html = '';
  let inMatch = false;
  for (let i = 0; i < text.length; i++) {
    if (set.has(i)) {
      if (!inMatch) { html += '<span class="ac-match">'; inMatch = true; }
      html += esc(text[i]);
    } else {
      if (inMatch) { html += '</span>'; inMatch = false; }
      html += esc(text[i]);
    }
  }
  if (inMatch) html += '</span>';
  return html;
}

function renderMenu(items, prefix, selectedIdx) {
  let html = '';
  const max = Math.min(items.length, 30);
  for (let i = 0; i < max; i++) {
    const it = items[i];
    const cls = i === selectedIdx ? 'ac-item active' : 'ac-item';
    const kindCls = 'ac-kind ac-kind-' + it.kind;
    const label = KIND_LABELS[it.kind] || '?';
    const textHtml = highlightMatches(it.text, it.indices);
    const detailHtml = it.detail ? `<span class="ac-detail">${esc(it.detail)}</span>` : '';
    html += `<div class="${cls}" data-index="${i}"><span class="${kindCls}">${label}</span><span class="ac-text">${textHtml}</span>${detailHtml}</div>`;
  }
  return html;
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function showMenu(ta, cellId) {
  const code = ta.value;
  const cursor = ta.selectionStart;
  if (ta.selectionStart !== ta.selectionEnd) { dismissAutocomplete(); return; }

  const result = getCompletions(code, cursor, cellId);
  if (!result.items.length) { dismissAutocomplete(); return; }

  const wrap = ta.closest('.editor-wrap');
  if (!wrap) { dismissAutocomplete(); return; }

  const pos = measureCursorPos(ta, cursor);

  if (!activeMenu) {
    activeMenu = document.createElement('div');
    activeMenu.className = 'ac-menu';
    wrap.appendChild(activeMenu);
  } else if (activeMenu.parentElement !== wrap) {
    activeMenu.remove();
    wrap.appendChild(activeMenu);
  }

  activeState = {
    items: result.items,
    prefix: result.prefix,
    selected: 0,
    ta,
    cellId,
    cursorStart: cursor - result.prefix.length
  };

  activeMenu.innerHTML = renderMenu(result.items, result.prefix, 0);

  // position: account for padding and scroll
  const cs = getComputedStyle(ta);
  const padLeft = parseFloat(cs.paddingLeft) || 0;
  const padTop = parseFloat(cs.paddingTop) || 0;

  const left = pos.x + padLeft - ta.scrollLeft;
  const top = pos.y + padTop - ta.scrollTop;

  activeMenu.style.left = left + 'px';
  activeMenu.style.top = top + 'px';

  // flip above if it would overflow viewport
  const menuRect = activeMenu.getBoundingClientRect();
  if (menuRect.bottom > window.innerHeight - 20) {
    activeMenu.style.top = (top - pos.lineHeight - activeMenu.offsetHeight) + 'px';
  }

  // mouse interaction
  activeMenu.onmousedown = (e) => {
    e.preventDefault(); // don't blur textarea
    const item = e.target.closest('.ac-item');
    if (item) {
      activeState.selected = parseInt(item.dataset.index);
      acceptCompletion();
    }
  };
}

function updateSelection(idx) {
  if (!activeMenu || !activeState) return;
  activeState.selected = idx;
  const items = activeMenu.querySelectorAll('.ac-item');
  items.forEach((el, i) => el.classList.toggle('active', i === idx));
  // scroll into view
  if (items[idx]) items[idx].scrollIntoView({ block: 'nearest' });
}

function acceptCompletion() {
  if (!activeState) return;
  const { items, selected, ta, prefix, cursorStart } = activeState;
  const item = items[selected];
  if (!item) return;

  const before = ta.value.substring(0, cursorStart);
  const after = ta.value.substring(cursorStart + prefix.length);
  ta.value = before + item.text + after;
  const newCursor = cursorStart + item.text.length;
  ta.selectionStart = ta.selectionEnd = newCursor;

  dismissAutocomplete();
  ta.dispatchEvent(new Event('input'));
}

export function attachAutocomplete(textarea, cellId) {
  // keydown handler — must be added BEFORE handleTab so stopImmediatePropagation works
  textarea.addEventListener('keydown', (e) => {
    // Ctrl+Shift+Space — manual signature hint trigger
    if (e.key === ' ' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      dismissAutocomplete();
      showSigHint(textarea);
      return;
    }

    if (!activeMenu || !activeState) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopImmediatePropagation();
      const next = (activeState.selected + 1) % activeState.items.length;
      updateSelection(next);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopImmediatePropagation();
      const prev = (activeState.selected - 1 + activeState.items.length) % activeState.items.length;
      updateSelection(prev);
      return;
    }
    if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault();
      e.stopImmediatePropagation();
      acceptCompletion();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      dismissAutocomplete();
      dismissSigHint();
      return;
    }
  });

  // input handler — show/update completions + signature hints
  textarea.addEventListener('input', () => {
    // use a microtask so the value is settled
    Promise.resolve().then(() => {
      showMenu(textarea, cellId);
      // show sig hint only when autocomplete menu is not visible
      if (!activeMenu) showSigHint(textarea);
      else dismissSigHint();
    });
  });

  // dismiss on blur
  textarea.addEventListener('blur', () => {
    // delay so mousedown on menu can fire first
    setTimeout(() => { dismissAutocomplete(); dismissSigHint(); }, 150);
  });

  // dismiss on scroll (position goes stale)
  textarea.addEventListener('scroll', () => {
    dismissAutocomplete();
    dismissSigHint();
  });
}
