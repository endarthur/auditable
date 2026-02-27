import { S, $ } from './state.js';
import { autoResize } from './cell-dom.js';
import { renderHtmlCell } from './exec.js';
import { renderMd } from './markdown.js';
import { getEditor, setEditorSearchDecorations, clearEditorSearchDecorations, clearAllSearchDecorations } from './cm6.js';

// ── FIND / REPLACE ──

export function openFind(showReplace) {
  const bar = $('#findBar');
  bar.style.display = 'flex';
  S.findActive = true;
  if (showReplace) bar.classList.add('show-replace');
  else bar.classList.remove('show-replace');
  const inp = $('#findInput');
  // pre-fill from selection
  const active = document.activeElement;
  if (active && active.tagName === 'TEXTAREA') {
    // md cell textarea
    const sel = active.value.substring(active.selectionStart, active.selectionEnd);
    if (sel && sel.indexOf('\n') === -1) inp.value = sel;
  } else if (active && active.closest('.cm-editor')) {
    // CM6 editor — read selection
    const cellEl = active.closest('[data-cm-cell-id]');
    if (cellEl) {
      const cellId = parseInt(cellEl.dataset.cmCellId);
      const editor = getEditor(cellId);
      if (editor) {
        const sel = editor.view.state.selection.main;
        if (!sel.empty) {
          const text = editor.view.state.doc.sliceString(sel.from, sel.to);
          if (text && text.indexOf('\n') === -1) inp.value = text;
        }
      }
    }
  }
  inp.focus();
  inp.select();
  if (inp.value) findComputeMatches();
}

export function closeFind() {
  const bar = $('#findBar');
  bar.style.display = '';
  bar.classList.remove('show-replace');
  S.findActive = false;
  S.findQuery = '';
  S.findMatches = [];
  S.findCurrent = -1;
  $('#findCount').textContent = '';
  // remove CM6 search decorations
  clearAllSearchDecorations();
  // remove md overlays
  document.querySelectorAll('.search-overlay').forEach(el => el.remove());
  document.querySelectorAll('.md-search-wrap').forEach(wrap => {
    const ta = wrap.querySelector('textarea');
    if (ta) wrap.parentNode.insertBefore(ta, wrap);
    wrap.remove();
  });
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function findComputeMatches() {
  const query = $('#findInput').value;
  S.findQuery = query;
  S.findMatches = [];
  if (!query) {
    S.findCurrent = -1;
    findUpdateCount();
    clearAllSearchDecorations();
    document.querySelectorAll('.search-overlay').forEach(el => el.remove());
    document.querySelectorAll('.md-search-wrap').forEach(wrap => {
      const ta = wrap.querySelector('textarea');
      if (ta) wrap.parentNode.insertBefore(ta, wrap);
      wrap.remove();
    });
    return;
  }
  const flags = S.findCase ? 'g' : 'gi';
  const pattern = S.findRegex ? query : escapeRegex(query);
  let re;
  try { re = new RegExp(pattern, flags); }
  catch (e) {
    S.findCurrent = -1;
    $('#findCount').textContent = 'bad regex';
    return;
  }

  for (const cell of S.cells) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(cell.code)) !== null) {
      S.findMatches.push({ cellId: cell.id, index: m.index, length: m[0].length });
      if (m[0].length === 0) re.lastIndex++;  // prevent infinite loop on zero-length match
    }
  }
  // keep findCurrent in range
  if (S.findMatches.length === 0) S.findCurrent = -1;
  else if (S.findCurrent < 0 || S.findCurrent >= S.findMatches.length) S.findCurrent = 0;
  findUpdateOverlays();
  findUpdateCount();
}

export function findNext() {
  if (!S.findMatches.length) return;
  S.findCurrent = (S.findCurrent + 1) % S.findMatches.length;
  findUpdateOverlays();
  findUpdateCount();
  findScrollToMatch();
}

export function findPrev() {
  if (!S.findMatches.length) return;
  S.findCurrent = (S.findCurrent - 1 + S.findMatches.length) % S.findMatches.length;
  findUpdateOverlays();
  findUpdateCount();
  findScrollToMatch();
}

export function findReplace() {
  if (S.findCurrent < 0 || S.findCurrent >= S.findMatches.length) return;
  const match = S.findMatches[S.findCurrent];
  const cell = S.cells.find(c => c.id === match.cellId);
  if (!cell) return;
  const replaceVal = $('#replaceInput').value;
  if (S.findRegex) {
    const flags = S.findCase ? '' : 'i';
    try {
      const re = new RegExp(S.findQuery, flags);
      const matched = cell.code.substring(match.index, match.index + match.length);
      const replaced = matched.replace(re, replaceVal);
      cell.code = cell.code.substring(0, match.index) + replaced + cell.code.substring(match.index + match.length);
    } catch (e) { return; }
  } else {
    cell.code = cell.code.substring(0, match.index) + replaceVal + cell.code.substring(match.index + match.length);
  }
  // update editor
  if (cell.type === 'md') {
    const ta = cell.el.querySelector('textarea');
    if (ta) {
      ta.value = cell.code;
      ta.dispatchEvent(new Event('input'));
    }
  } else {
    const editor = getEditor(cell.id);
    if (editor) editor.setCode(cell.code);
  }
  findComputeMatches();
}

export function findReplaceAll() {
  const query = S.findQuery;
  if (!query) return;
  const replaceVal = $('#replaceInput').value;
  const flags = S.findCase ? 'g' : 'gi';
  const pattern = S.findRegex ? query : escapeRegex(query);
  let re;
  try { re = new RegExp(pattern, flags); }
  catch (e) { return; }
  let count = 0;
  for (const cell of S.cells) {
    const before = cell.code;
    if (S.findRegex) {
      cell.code = cell.code.replace(re, (...args) => { count++; return replaceVal.replace(/\$(\d+)/g, (_, n) => args[+n] != null ? args[+n] : ''); });
    } else {
      cell.code = cell.code.replace(re, () => { count++; return replaceVal; });
    }
    if (cell.code !== before) {
      if (cell.type === 'md') {
        const ta = cell.el.querySelector('textarea');
        if (ta) {
          ta.value = cell.code;
          ta.dispatchEvent(new Event('input'));
        }
      } else {
        const editor = getEditor(cell.id);
        if (editor) editor.setCode(cell.code);
      }
    }
  }
  findComputeMatches();
}

function findUpdateOverlays() {
  // clear all overlays
  clearAllSearchDecorations();
  document.querySelectorAll('.search-overlay').forEach(el => el.remove());
  document.querySelectorAll('.md-search-wrap').forEach(wrap => {
    const ta = wrap.querySelector('textarea');
    if (ta) wrap.parentNode.insertBefore(ta, wrap);
    wrap.remove();
  });

  if (!S.findQuery || !S.findMatches.length) return;

  // group matches by cellId
  const byCell = {};
  S.findMatches.forEach((m, i) => {
    if (!byCell[m.cellId]) byCell[m.cellId] = [];
    byCell[m.cellId].push({ ...m, globalIdx: i });
  });

  for (const cellId of Object.keys(byCell)) {
    const cell = S.cells.find(c => c.id === parseInt(cellId));
    if (!cell) continue;
    const matches = byCell[cellId];

    if (cell.type === 'md') {
      // markdown cells: use overlay approach (textarea-based)
      const code = cell.code;
      let html = '';
      let pos = 0;
      for (const m of matches) {
        html += escHtml(code.substring(pos, m.index));
        const cls = m.globalIdx === S.findCurrent ? 'search-match search-match-current' : 'search-match';
        html += `<mark class="${cls}">${escHtml(code.substring(m.index, m.index + m.length))}</mark>`;
        pos = m.index + m.length;
      }
      html += escHtml(code.substring(pos));

      const overlay = document.createElement('div');
      overlay.className = 'search-overlay search-overlay-md';
      overlay.innerHTML = html;
      const editWrap = cell.el.querySelector('.cell-md-edit');
      const ta = editWrap.querySelector('textarea');
      let wrap = editWrap.querySelector('.md-search-wrap');
      if (!wrap) {
        wrap = document.createElement('div');
        wrap.className = 'md-search-wrap';
        ta.parentNode.insertBefore(wrap, ta);
        wrap.appendChild(ta);
      }
      wrap.appendChild(overlay);
      wireScrollSync(ta, overlay);
    } else {
      // code, css, html cells: use CM6 search decorations
      const ranges = matches.map(m => ({
        from: m.index,
        to: m.index + m.length,
        current: m.globalIdx === S.findCurrent,
      }));
      setEditorSearchDecorations(parseInt(cellId), ranges);
    }
  }
}

function wireScrollSync(ta, overlay) {
  if (ta._searchScrollWired) return;
  ta._searchScrollWired = true;
  ta.addEventListener('scroll', () => {
    const ov = ta.closest('.md-search-wrap');
    if (!ov) return;
    const so = ov.querySelector('.search-overlay');
    if (so) {
      so.scrollTop = ta.scrollTop;
      so.scrollLeft = ta.scrollLeft;
    }
  });
}

function findUpdateCount() {
  const el = $('#findCount');
  if (!S.findQuery) { el.textContent = ''; return; }
  if (S.findMatches.length === 0) { el.textContent = 'no results'; return; }
  el.textContent = `${S.findCurrent + 1}/${S.findMatches.length}`;
}

function findScrollToMatch() {
  if (S.findCurrent < 0) return;
  const match = S.findMatches[S.findCurrent];
  if (!match) return;
  const cell = S.cells.find(c => c.id === match.cellId);
  if (!cell) return;

  // open editor for non-code cells if needed
  if (cell.type === 'css') {
    const editWrap = cell.el.querySelector('.cell-css-edit');
    const view = cell.el.querySelector('.cell-css-view');
    if (editWrap.style.display === 'none') {
      editWrap.style.display = '';
      view.style.display = 'none';
      const editor = getEditor(cell.id);
      if (editor) {
        editor.setCode(cell.code);
        editor.view.requestMeasure();
      }
    }
  } else if (cell.type === 'html') {
    const editWrap = cell.el.querySelector('.cell-html-edit');
    const view = cell.el.querySelector('.cell-html-view');
    if (editWrap.style.display === 'none') {
      editWrap.style.display = '';
      view.style.display = 'none';
      const editor = getEditor(cell.id);
      if (editor) {
        editor.setCode(cell.code);
        editor.view.requestMeasure();
      }
    }
  } else if (cell.type === 'md') {
    const editWrap = cell.el.querySelector('.cell-md-edit');
    const view = cell.el.querySelector('.cell-md-view');
    if (editWrap.style.display === 'none') {
      const ta = editWrap.querySelector('textarea');
      editWrap.style.display = '';
      view.style.display = 'none';
      ta.value = cell.code;
      autoResize({ target: ta });
    }
  }

  // uncollapse if collapsed
  cell.el.classList.remove('collapsed');

  // scroll cell into view
  cell.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  // for CM6 cells, scroll editor to match position
  if (cell.type !== 'md') {
    const editor = getEditor(cell.id);
    if (editor) {
      editor.view.dispatch({
        selection: { anchor: match.index },
        scrollIntoView: true,
      });
    }
  } else {
    // scroll md textarea to match line
    const ta = cell.el.querySelector('.cell-md-edit textarea');
    if (ta) {
      const textBefore = cell.code.substring(0, match.index);
      const lineNum = textBefore.split('\n').length - 1;
      const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 20;
      ta.scrollTop = Math.max(0, lineNum * lineHeight - ta.clientHeight / 2);
    }
  }
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── EVENT WIRING ──
(function () {
  const findInput = $('#findInput');
  const replaceInput = $('#replaceInput');
  if (!findInput) return;

  findInput.addEventListener('input', () => findComputeMatches());

  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); findPrev(); }
    else if (e.key === 'Enter') { e.preventDefault(); findNext(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });

  if (replaceInput) {
    replaceInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); findReplace(); }
      else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
    });
  }

  const nextBtn = $('#findNextBtn');
  const prevBtn = $('#findPrevBtn');
  const replBtn = $('#findReplaceBtn');
  const replAllBtn = $('#findReplaceAllBtn');
  const caseBtn = $('#findCaseBtn');
  const regexBtn = $('#findRegexBtn');
  const closeBtn = $('#findCloseBtn');

  if (nextBtn) nextBtn.addEventListener('click', findNext);
  if (prevBtn) prevBtn.addEventListener('click', findPrev);
  if (replBtn) replBtn.addEventListener('click', findReplace);
  if (replAllBtn) replAllBtn.addEventListener('click', findReplaceAll);
  if (closeBtn) closeBtn.addEventListener('click', closeFind);
  if (caseBtn) caseBtn.addEventListener('click', () => {
    S.findCase = !S.findCase;
    caseBtn.classList.toggle('active', S.findCase);
    findComputeMatches();
  });
  if (regexBtn) regexBtn.addEventListener('click', () => {
    S.findRegex = !S.findRegex;
    regexBtn.classList.toggle('active', S.findRegex);
    findComputeMatches();
  });

  // live recompute on edit — delegation for md textareas only
  // (CM6 cells recompute via onCodeEdit/onCssEdit/onHtmlEdit in editor.js)
  let recomputeTimer = null;
  document.getElementById('notebook').addEventListener('input', (e) => {
    if (!S.findActive) return;
    if (e.target.tagName !== 'TEXTAREA') return;
    clearTimeout(recomputeTimer);
    recomputeTimer = setTimeout(findComputeMatches, 150);
  });
})();
