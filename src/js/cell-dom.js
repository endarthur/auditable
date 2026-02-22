import { S } from './state.js';
import { highlightCode, highlightCss, highlightHtml } from './syntax.js';
import { isManual } from './dag.js';
import { renderMd } from './markdown.js';
import { onCodeEdit, onCssEdit, onHtmlEdit } from './editor.js';
import { renderHtmlCell } from './exec.js';
import { attachAutocomplete } from './complete.js';

// ── CELL DOM ──

export function cssSummary(code) {
  if (!code || !code.trim()) return '';
  const rules = (code.match(/[^{}]+\{/g) || []).length;
  const lines = code.split('\n').length;
  return `${rules} rule${rules !== 1 ? 's' : ''} \u00b7 ${lines} line${lines !== 1 ? 's' : ''}`;
}

function cellHeaderHTML(type, id) {
  return `<div class="cell-header">
    <span class="cell-type">${type}</span>
    <button class="cell-btn cell-convert" onclick="toggleTypePicker(${id})" title="convert type">\u21c4</button>
    <div class="cell-type-picker" data-cell-id="${id}">
      <button onclick="convertCell(${id},'code')">code</button>
      <button onclick="convertCell(${id},'md')">md</button>
      <button onclick="convertCell(${id},'css')">css</button>
      <button onclick="convertCell(${id},'html')">html</button>
    </div>
    <button class="cell-btn cell-insert" onclick="showInsertPicker(${id},'before')" title="insert above">+\u2191</button>
    <button class="cell-btn cell-insert" onclick="showInsertPicker(${id},'after')" title="insert below">+\u2193</button>
    <button class="cell-btn" onclick="moveCell(${id},-1)" title="move up">\u2191</button>
    <button class="cell-btn" onclick="moveCell(${id},1)" title="move down">\u2193</button>
    <button class="cell-btn del" onclick="deleteCell(${id})" title="delete">\u00d7</button>
  </div>`;
}

export function createCellEl(type, id) {
  const div = document.createElement('div');
  div.className = 'cell';
  div.dataset.id = id;
  div.dataset.type = type;

  if (type === 'code') {
    div.innerHTML = `
      ${cellHeaderHTML('code', id)}
      <div class="cell-code">
        <div class="editor-wrap">
          <div class="line-numbers" aria-hidden="true">1</div>
          <textarea rows="3" spellcheck="false" placeholder="// code"></textarea>
          <div class="highlight-layer" aria-hidden="true"></div>
        </div>
      </div>
      <div class="cell-widgets"></div>
      <div class="cell-output"></div>
    `;

    const ta = div.querySelector('textarea');
    const hl = div.querySelector('.highlight-layer');
    div.querySelector('.cell-type').addEventListener('click', () => div.classList.toggle('collapsed'));
    const ln = div.querySelector('.line-numbers');
    ta.addEventListener('input', () => { highlightCode(ta, hl); onCodeEdit(id); });
    ta.addEventListener('scroll', () => { hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft; ln.scrollTop = ta.scrollTop; });
    attachAutocomplete(ta, id);
    ta.addEventListener('keydown', handleTab);
    ta.addEventListener('input', autoResize);
  } else if (type === 'css') {
    div.innerHTML = `
      ${cellHeaderHTML('css', id)}
      <div class="cell-css-view"></div>
      <div class="cell-css-edit" style="display:none">
        <div class="editor-wrap">
          <div class="line-numbers" aria-hidden="true">1</div>
          <textarea rows="3" spellcheck="false" placeholder="/* css */"></textarea>
          <div class="highlight-layer" aria-hidden="true"></div>
        </div>
      </div>
    `;

    const cssView = div.querySelector('.cell-css-view');
    const cssEditWrap = div.querySelector('.cell-css-edit');
    const ta = div.querySelector('textarea');
    const hl = div.querySelector('.highlight-layer');
    div.querySelector('.cell-type').addEventListener('click', () => div.classList.toggle('collapsed'));

    cssView.addEventListener('click', () => {
      cssEditWrap.style.display = '';
      cssView.style.display = 'none';
      ta.focus();
      autoResize({ target: ta });
    });

    ta.addEventListener('blur', () => {
      if (S.findActive) return;
      const cell = S.cells.find(c => c.id === id);
      if (cell) {
        cell.code = ta.value;
        cssView.textContent = cssSummary(ta.value);
      }
      cssEditWrap.style.display = 'none';
      cssView.style.display = '';
    });

    const ln = div.querySelector('.line-numbers');
    ta.addEventListener('input', () => { highlightCss(ta, hl); onCssEdit(id); });
    ta.addEventListener('scroll', () => { hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft; ln.scrollTop = ta.scrollTop; });
    ta.addEventListener('input', autoResize);
    ta.addEventListener('keydown', handleTab);
  } else if (type === 'html') {
    div.innerHTML = `
      ${cellHeaderHTML('html', id)}
      <div class="cell-html-view"></div>
      <div class="cell-html-edit" style="display:none">
        <div class="editor-wrap">
          <div class="line-numbers" aria-hidden="true">1</div>
          <textarea rows="2" spellcheck="false" placeholder="<html template>"></textarea>
          <div class="highlight-layer" aria-hidden="true"></div>
        </div>
      </div>
      <div class="cell-output"></div>
    `;

    const view = div.querySelector('.cell-html-view');
    const editWrap = div.querySelector('.cell-html-edit');
    const ta = div.querySelector('.cell-html-edit textarea');
    const hl = div.querySelector('.highlight-layer');
    div.querySelector('.cell-type').addEventListener('click', () => div.classList.toggle('collapsed'));

    view.addEventListener('click', () => {
      editWrap.style.display = '';
      view.style.display = 'none';
      ta.focus();
      autoResize({ target: ta });
    });

    ta.addEventListener('blur', () => {
      if (S.findActive) return;
      const cell = S.cells.find(c => c.id === id);
      if (cell) {
        cell.code = ta.value;
        renderHtmlCell(cell);
      }
      editWrap.style.display = 'none';
      view.style.display = '';
    });

    const ln = div.querySelector('.line-numbers');
    ta.addEventListener('input', () => { highlightHtml(ta, hl); onHtmlEdit(id); });
    ta.addEventListener('scroll', () => { hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft; ln.scrollTop = ta.scrollTop; });
    ta.addEventListener('input', autoResize);
    ta.addEventListener('keydown', handleTab);
  } else {
    div.innerHTML = `
      ${cellHeaderHTML('md', id)}
      <div class="cell-md-view"></div>
      <div class="cell-md-edit" style="display:none">
        <textarea rows="2" spellcheck="false" placeholder="markdown"></textarea>
      </div>
    `;

    const view = div.querySelector('.cell-md-view');
    const editWrap = div.querySelector('.cell-md-edit');
    const ta = div.querySelector('.cell-md-edit textarea');
    div.querySelector('.cell-type').addEventListener('click', () => div.classList.toggle('collapsed'));

    view.addEventListener('click', () => {
      editWrap.style.display = '';
      view.style.display = 'none';
      ta.focus();
      autoResize({ target: ta });
    });

    ta.addEventListener('blur', () => {
      if (S.findActive) return;
      const cell = S.cells.find(c => c.id === id);
      if (cell) {
        cell.code = ta.value;
        view.innerHTML = renderMd(ta.value);
      }
      editWrap.style.display = 'none';
      view.style.display = '';
    });

    ta.addEventListener('input', autoResize);
    ta.addEventListener('keydown', handleTab);
  }

  return div;
}

export function handleTab(e) {
  if (e.key === 'Tab') {
    e.preventDefault();
    const ta = e.target;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;

    if (start === end) {
      // no selection — insert 2 spaces
      ta.value = ta.value.substring(0, start) + '  ' + ta.value.substring(end);
      ta.selectionStart = ta.selectionEnd = start + 2;
    } else {
      // selection — indent/unindent lines
      const val = ta.value;
      const lineStart = val.lastIndexOf('\n', start - 1) + 1;
      const lineEnd = val.indexOf('\n', end);
      const block = val.slice(lineStart, lineEnd === -1 ? val.length : lineEnd);
      let newBlock;
      if (e.shiftKey) {
        newBlock = block.replace(/^  /gm, '');
      } else {
        newBlock = block.replace(/^/gm, '  ');
      }
      ta.value = val.slice(0, lineStart) + newBlock + val.slice(lineEnd === -1 ? val.length : lineEnd);
      ta.selectionStart = lineStart;
      ta.selectionEnd = lineStart + newBlock.length;
    }
    ta.dispatchEvent(new Event('input'));
  }
}

export function toggleComment(ta) {
  const val = ta.value;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;

  // find affected line range
  const lineStart = val.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = val.indexOf('\n', end);
  if (lineEnd === -1) lineEnd = val.length;

  const block = val.slice(lineStart, lineEnd);
  const lines = block.split('\n');

  // check if all lines are commented
  const allCommented = lines.every(l => /^\s*\/\//.test(l) || l.trim() === '');

  let newLines;
  if (allCommented) {
    // uncomment: remove first // (and one trailing space if present)
    newLines = lines.map(l => l.replace(/^(\s*)\/\/ ?/, '$1'));
  } else {
    // comment: add // at the minimum indent level
    const indents = lines.filter(l => l.trim()).map(l => l.match(/^(\s*)/)[1].length);
    const minIndent = indents.length ? Math.min(...indents) : 0;
    newLines = lines.map(l => {
      if (l.trim() === '') return l;
      return l.slice(0, minIndent) + '// ' + l.slice(minIndent);
    });
  }

  const newBlock = newLines.join('\n');
  ta.value = val.slice(0, lineStart) + newBlock + val.slice(lineEnd);
  ta.selectionStart = lineStart;
  ta.selectionEnd = lineStart + newBlock.length;
  ta.dispatchEvent(new Event('input'));
}

export function updateLineNumbers(ta) {
  const wrap = ta.closest('.editor-wrap');
  if (!wrap) return;
  const gutter = wrap.querySelector('.line-numbers');
  if (!gutter) return;
  const count = ta.value.split('\n').length;
  const lines = [];
  for (let i = 1; i <= count; i++) lines.push(i);
  gutter.textContent = lines.join('\n');
}

export function autoResize(e) {
  const ta = e.target || e;
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
  // sync highlight layer if present
  const hl = ta.parentElement && ta.parentElement.querySelector('.highlight-layer');
  if (hl) { hl.style.height = ta.style.height; }
  updateLineNumbers(ta);
}
