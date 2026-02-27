import { S } from './state.js';
import { isManual } from './dag.js';
import { renderMd } from './markdown.js';
import { onCodeEdit, onCssEdit, onHtmlEdit } from './editor.js';
import { renderHtmlCell } from './exec.js';
import { createEditor, getEditor } from './cm6.js';

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
    <button class="cell-btn del" onclick="deleteCellWithUndo(${id})" title="delete">\u00d7</button>
  </div>`;
}

export function createCellEl(type, id, initialCode) {
  const div = document.createElement('div');
  div.className = 'cell';
  div.dataset.id = id;
  div.dataset.type = type;

  if (type === 'code') {
    div.innerHTML = `
      ${cellHeaderHTML('code', id)}
      <div class="cell-code">
        <div class="editor-wrap"></div>
      </div>
      <div class="cell-widgets"></div>
      <div class="cell-output"></div>
    `;

    div.querySelector('.cell-type').addEventListener('click', () => div.classList.toggle('collapsed'));
    const editorWrap = div.querySelector('.editor-wrap');
    const editor = createEditor(editorWrap, id, initialCode || '', 'code', (code) => {
      const cell = S.cells.find(c => c.id === id);
      if (cell) cell.code = code;
      onCodeEdit(id);
    });
    // store reference for external access
    div._editor = editor;
  } else if (type === 'css') {
    div.innerHTML = `
      ${cellHeaderHTML('css', id)}
      <div class="cell-css-view"></div>
      <div class="cell-css-edit" style="display:none">
        <div class="editor-wrap"></div>
      </div>
    `;

    const cssView = div.querySelector('.cell-css-view');
    const cssEditWrap = div.querySelector('.cell-css-edit');
    const editorWrap = div.querySelector('.editor-wrap');
    div.querySelector('.cell-type').addEventListener('click', () => div.classList.toggle('collapsed'));

    const editor = createEditor(editorWrap, id, initialCode || '', 'css', (code) => {
      const cell = S.cells.find(c => c.id === id);
      if (cell) cell.code = code;
      onCssEdit(id);
    });
    div._editor = editor;

    cssView.addEventListener('click', () => {
      cssEditWrap.style.display = '';
      cssView.style.display = 'none';
      editor.view.requestMeasure();
      editor.focus();
    });

    // blur handling: use CM6 focuschange
    editor.view.dom.addEventListener('focusout', (e) => {
      // don't close if focus moved within the same editor or to find bar
      if (editor.view.dom.contains(e.relatedTarget)) return;
      if (e.relatedTarget && e.relatedTarget.closest('#findBar')) return;
      if (S.findActive) return;
      const cell = S.cells.find(c => c.id === id);
      if (cell) {
        cssView.textContent = cssSummary(cell.code);
      }
      cssEditWrap.style.display = 'none';
      cssView.style.display = '';
    });
  } else if (type === 'html') {
    div.innerHTML = `
      ${cellHeaderHTML('html', id)}
      <div class="cell-html-view"></div>
      <div class="cell-html-edit" style="display:none">
        <div class="editor-wrap"></div>
      </div>
      <div class="cell-output"></div>
    `;

    const view = div.querySelector('.cell-html-view');
    const editWrap = div.querySelector('.cell-html-edit');
    const editorWrap = div.querySelector('.editor-wrap');
    div.querySelector('.cell-type').addEventListener('click', () => div.classList.toggle('collapsed'));

    const editor = createEditor(editorWrap, id, initialCode || '', 'html', (code) => {
      const cell = S.cells.find(c => c.id === id);
      if (cell) cell.code = code;
      onHtmlEdit(id);
    });
    div._editor = editor;

    view.addEventListener('click', () => {
      editWrap.style.display = '';
      view.style.display = 'none';
      editor.view.requestMeasure();
      editor.focus();
    });

    editor.view.dom.addEventListener('focusout', (e) => {
      if (editor.view.dom.contains(e.relatedTarget)) return;
      if (e.relatedTarget && e.relatedTarget.closest('#findBar')) return;
      if (S.findActive) return;
      const cell = S.cells.find(c => c.id === id);
      if (cell) {
        renderHtmlCell(cell);
      }
      editWrap.style.display = 'none';
      view.style.display = '';
    });
  } else {
    // markdown — stays as textarea
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

// undoable text replacement — uses execCommand so the browser records it in the undo stack
function replaceRange(ta, from, to, text) {
  ta.focus();
  ta.selectionStart = from;
  ta.selectionEnd = to;
  document.execCommand('insertText', false, text);
}

export function handleTab(e) {
  const ta = e.target;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;

  if (e.key === 'Tab') {
    e.preventDefault();

    if (start === end) {
      // no selection — insert 2 spaces
      replaceRange(ta, start, end, '  ');
    } else {
      // selection — indent/unindent lines
      const val = ta.value;
      const lineStart = val.lastIndexOf('\n', start - 1) + 1;
      const lineEnd = val.indexOf('\n', end);
      const blockEnd = lineEnd === -1 ? val.length : lineEnd;
      const block = val.slice(lineStart, blockEnd);
      let newBlock;
      if (e.shiftKey) {
        newBlock = block.replace(/^  /gm, '');
      } else {
        newBlock = block.replace(/^/gm, '  ');
      }
      replaceRange(ta, lineStart, blockEnd, newBlock);
      ta.selectionStart = lineStart;
      ta.selectionEnd = lineStart + newBlock.length;
    }
    ta.dispatchEvent(new Event('input'));
    return;
  }

  // Enter — auto-indent
  if (e.key === 'Enter') {
    e.preventDefault();
    const val = ta.value;
    const before = val.slice(0, start);
    const after = val.slice(end);

    // find current line's leading whitespace
    const lineStart = before.lastIndexOf('\n') + 1;
    const line = before.slice(lineStart);
    const indent = line.match(/^(\s*)/)[1];

    // check if the character before cursor is an opener
    const charBefore = before.trimEnd().slice(-1);
    const extra = '{(['.includes(charBefore) ? '  ' : '';

    // check if the character after cursor is a matching closer
    const charAfter = after.trimStart()[0];
    const pairs = { '{': '}', '(': ')', '[': ']' };
    const needClose = extra && charAfter === pairs[charBefore];

    if (needClose) {
      // cursor between brackets: add indented line + closing line
      const insert = '\n' + indent + extra + '\n' + indent;
      replaceRange(ta, start, end, insert);
      ta.selectionStart = ta.selectionEnd = start + 1 + indent.length + extra.length;
    } else {
      const insert = '\n' + indent + extra;
      replaceRange(ta, start, end, insert);
    }
    ta.dispatchEvent(new Event('input'));
    return;
  }

  // Ctrl+X / Ctrl+C with no selection — whole-line cut/copy
  if ((e.key === 'x' || e.key === 'c') && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && start === end) {
    e.preventDefault();
    const val = ta.value;
    const lineStart = val.lastIndexOf('\n', start - 1) + 1;
    let lineEnd = val.indexOf('\n', start);
    if (lineEnd === -1) lineEnd = val.length;
    else lineEnd++; // include the newline

    const lineText = val.slice(lineStart, lineEnd);
    navigator.clipboard.writeText(lineText);

    if (e.key === 'x') {
      replaceRange(ta, lineStart, lineEnd, '');
      ta.dispatchEvent(new Event('input'));
    }
    return;
  }
}

export function toggleMdComment(ta) {
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
  replaceRange(ta, lineStart, lineEnd, newBlock);
  ta.selectionStart = lineStart;
  ta.selectionEnd = lineStart + newBlock.length;
  ta.dispatchEvent(new Event('input'));
}

export function autoResize(e) {
  const ta = e.target || e;
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}
