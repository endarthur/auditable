import { S, JS_KEYWORDS, JS_BUILTINS } from './state.js';
import { autocompletion, CompletionContext, setEditorAutocomplete, setOnEditorCreated } from './cm6.js';

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
        'unique','zip','cross','file','download','el','copy','fmt','include',
        'color','colorScale','viridis','magma','inferno','plasma','turbo','palette10'],
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
      // look back for a tag name: identifier immediately before the backtick,
      // or curried form: identifier(...) before the backtick
      let tagName = null;
      if (i > 0 && typeof window !== 'undefined' && window._taggedLanguages) {
        let te = i;
        let ts = te;
        // direct form: ident`
        while (ts > 0 && /\w/.test(code[ts - 1])) ts--;
        if (ts < te) {
          const candidate = code.slice(ts, te);
          if (window._taggedLanguages[candidate]) tagName = candidate;
        }
        // curried form: ident(...)`
        if (!tagName && code[i - 1] === ')') {
          let p = i - 2, depth = 1;
          while (p >= 0 && depth > 0) {
            if (code[p] === ')') depth++;
            else if (code[p] === '(') depth--;
            p--;
          }
          // p now points one before the (
          let ne = p + 1;
          let ns = ne;
          while (ns > 0 && /\w/.test(code[ns - 1])) ns--;
          if (ns < ne) {
            const candidate = code.slice(ns, ne);
            if (window._taggedLanguages[candidate]) tagName = candidate;
          }
        }
      }

      i++;
      const contentStart = i; // position right after opening backtick
      while (i < code.length) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === '$' && code[i + 1] === '{') {
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
        if (i >= cursor) return tagName ? { type: 'tagged', lang: tagName, start: contentStart } : 'string';
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
  let start = cursor;
  while (start > 0 && /[a-zA-Z0-9_$]/.test(code[start - 1])) start--;
  return { prefix: code.slice(start, cursor), start };
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
      const { prefix } = extractPrefix(code, cursor);
      if (!prefix) return { prefix: '', items: [] };
      const tagCode = code.slice(ctx.start);
      const tagCursor = cursor - ctx.start;
      const extItems = lang.completions(tagCode, tagCursor, prefix);
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
  const { prefix } = extractPrefix(code, cursor);
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

// ── CM6 COMPLETION SOURCE ADAPTER ──

const KIND_MAP = { var: 'variable', fn: 'function', kw: 'keyword', const: 'constant', prop: 'property', def: 'variable' };

function audCompletionSource(context) {
  const code = context.state.doc.toString();
  const cursor = context.pos;

  // For implicit (typing) activation, require at least 1 identifier char before cursor.
  // Use matchBefore to tell CM6 this source is applicable — without this, CM6 may
  // skip calling us inside template literals or other non-code syntax tree nodes.
  if (!context.explicit) {
    const word = context.matchBefore(/[a-zA-Z_$]\w*/);
    if (!word) return null;
  }

  // extract cellId from editor container
  const cmEl = context.view.dom.closest('[data-cm-cell-id]');
  const cellId = cmEl ? parseInt(cmEl.dataset.cmCellId) : null;

  const result = getCompletions(code, cursor, cellId);
  if (!result || !result.items.length) return null;

  return {
    from: cursor - result.prefix.length,
    filter: false, // we do our own fuzzy matching — don't let CM6 re-filter
    options: result.items.map(item => ({
      label: item.text,
      type: KIND_MAP[item.kind] || 'text',
      boost: item.score,
      detail: item.detail || undefined,
    })),
  };
}

// ── SIGNATURE HINTS via CM6 TOOLTIP ──

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
  let pdepth = 0;
  let start = 0;
  for (let i = 0; i < params.length; i++) {
    if (params[i] === '{' || params[i] === '(' || params[i] === '[') pdepth++;
    else if (params[i] === '}' || params[i] === ')' || params[i] === ']') pdepth--;
    else if (params[i] === ',' && pdepth === 0) {
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

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// signature hint — simple positioned div approach
let _sigHint = null;

function showSigHintAt(view, parenPos, sig, desc, paramIdx) {
  const coords = view.coordsAtPos(parenPos);
  if (!coords) { dismissSigHint(); return; }

  if (!_sigHint) {
    _sigHint = document.createElement('div');
    _sigHint.className = 'ac-sig-hint';
    document.body.appendChild(_sigHint);
  }

  const sigHtml = highlightParam(sig, paramIdx);
  _sigHint.innerHTML = `<span class="ac-sig-fn">${sigHtml}</span><span class="ac-sig-desc">${esc(desc)}</span>`;
  _sigHint.style.display = '';

  const hintH = _sigHint.offsetHeight || 20;
  _sigHint.style.position = 'fixed';
  _sigHint.style.left = coords.left + 'px';
  _sigHint.style.top = (coords.top - hintH - 4) + 'px';

  if (coords.top - hintH - 4 < 0) {
    _sigHint.style.top = coords.bottom + 4 + 'px';
  }
}

function updateSigHint(view) {
  const code = view.state.doc.toString();
  const sel = view.state.selection.main;
  if (!sel.empty) { dismissSigHint(); return; }

  const ctx = cursorContext(code, sel.head);

  // tagged template — delegate to extension sig hint
  if (ctx && typeof ctx === 'object' && ctx.type === 'tagged') {
    const lang = window._taggedLanguages?.[ctx.lang];
    if (lang?.sigHint) {
      const tagCode = code.slice(ctx.start);
      const tagCursor = sel.head - ctx.start;
      const hint = lang.sigHint(tagCode, tagCursor);
      if (hint) {
        showSigHintAt(view, hint.parenPos + ctx.start, hint.sig, hint.desc || '', hint.paramIdx);
      } else {
        dismissSigHint();
      }
    } else {
      dismissSigHint();
    }
    return;
  }

  if (ctx !== 'code') { dismissSigHint(); return; }

  const call = detectCallContext(code, sel.head);
  if (!call) { dismissSigHint(); return; }

  const help = BUILTIN_HELP[call.fnName];
  if (!help) { dismissSigHint(); return; }

  showSigHintAt(view, call.parenPos, help.sig, help.desc, call.paramIdx);
}

function dismissSigHint() {
  if (_sigHint) { _sigHint.style.display = 'none'; }
}

const sigHintPlugin = window.CM6.ViewPlugin.define(() => ({
  update(update) {
    if (update.selectionSet || update.docChanged) {
      // delay slightly to let autocomplete menu show first
      Promise.resolve().then(() => {
        // only show sig hint when autocomplete tooltip is not visible
        const hasTooltip = update.view.dom.querySelector('.cm-tooltip-autocomplete');
        if (hasTooltip) dismissSigHint();
        else updateSigHint(update.view);
      });
    }
  },
  destroy() { dismissSigHint(); },
}));

// ── CONFIGURE AUTOCOMPLETE FOR A CELL ──

export function configureAutocomplete(cellId) {
  setEditorAutocomplete(cellId, [
    autocompletion({
      override: [audCompletionSource],
      icons: false,
      activateOnTyping: true,
      maxRenderedOptions: 30,
    }),
    sigHintPlugin,
  ]);
}

// configure autocomplete for all existing cells on init
export function configureAllAutocomplete() {
  for (const cell of S.cells) {
    if (cell.type === 'code') {
      configureAutocomplete(cell.id);
    }
  }
  // register callback so new code cells get autocomplete
  setOnEditorCreated((cellId, cellType) => {
    if (cellType === 'code') configureAutocomplete(cellId);
  });
}
