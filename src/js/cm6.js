import { S } from './state.js';

// ── CODEMIRROR 6 INTEGRATION ──

const {
  EditorView, EditorState, Compartment, StateEffect, StateField,
  keymap, lineNumbers, highlightActiveLine, highlightSpecialChars,
  ViewPlugin, Decoration, WidgetType, drawSelection,
  minimalSetup, javascript, css, html,
  indentWithTab, insertNewlineAndIndent, toggleComment, history, undo: cm6Undo, redo: cm6Redo,
  bracketMatching, syntaxHighlighting, HighlightStyle, syntaxTree, indentOnInput, indentService,
  autocompletion, CompletionContext, closeBrackets, acceptCompletion,
  tags,
  StreamLanguage, LanguageSupport, Language, defineLanguageFacet, parseMixed,
  Parser, NodeType, NodeSet, NodeProp, Tree,
  styleTags,
} = window.CM6;

// ── GCU THEME ──

const gcuDark = EditorView.theme({
  '&': {
    backgroundColor: 'var(--bg1)',
    color: 'var(--fg-bright)',
    fontSize: 'var(--editor-font-size)',
    fontFamily: 'var(--mono)',
  },
  '.cm-content': {
    caretColor: 'var(--fg-bright)',
    lineHeight: '1.5',
    padding: '8px 10px',
    fontFamily: 'var(--mono)',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg-bright)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'rgba(200,155,60,0.25)',
  },
  '.cm-activeLine': { backgroundColor: 'rgba(200,155,60,0.05)' },
  '.cm-gutters': {
    backgroundColor: 'var(--bg1)',
    color: 'var(--fg-dim)',
    borderRight: '1px solid var(--border)',
    fontFamily: 'var(--mono)',
    fontSize: 'var(--editor-font-size)',
  },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(200,155,60,0.08)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 4px 0 8px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { overflow: 'auto' },
  '.cm-line': { padding: '0' },
  // match highlight
  '.cm-selectionMatch': { backgroundColor: 'rgba(200,155,60,0.15)' },
  // bracket matching
  '.cm-matchingBracket': { backgroundColor: 'rgba(200,155,60,0.3)', color: 'var(--accent) !important' },
  '.cm-nonmatchingBracket': { backgroundColor: 'rgba(170,50,50,0.3)' },
  // autocomplete
  '.cm-tooltip': {
    backgroundColor: 'var(--bg2)',
    border: '1px solid var(--border-hi)',
    color: 'var(--fg)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete': {
    '& > ul': {
      fontFamily: 'var(--mono)',
      fontSize: 'var(--editor-font-size)',
    },
    '& > ul > li': { padding: '2px 8px' },
    '& > ul > li[aria-selected]': {
      backgroundColor: 'rgba(200,155,60,0.2)',
      color: 'var(--fg-bright)',
    },
  },
  '.cm-completionLabel': { color: 'var(--fg-bright)' },
  '.cm-completionDetail': { color: 'var(--fg-dim)', fontStyle: 'italic', marginLeft: '8px' },
  '.cm-completionMatchedText': { textDecoration: 'none', color: 'var(--accent)' },
}, { dark: true });

const gcuLight = EditorView.theme({
  '&': {
    backgroundColor: 'var(--bg1)',
    color: 'var(--fg-bright)',
    fontSize: 'var(--editor-font-size)',
    fontFamily: 'var(--mono)',
  },
  '.cm-content': {
    caretColor: 'var(--fg-bright)',
    lineHeight: '1.5',
    padding: '8px 10px',
    fontFamily: 'var(--mono)',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg-bright)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'rgba(150,110,30,0.2)',
  },
  '.cm-activeLine': { backgroundColor: 'rgba(150,110,30,0.06)' },
  '.cm-gutters': {
    backgroundColor: 'var(--bg1)',
    color: 'var(--fg-dim)',
    borderRight: '1px solid var(--border)',
    fontFamily: 'var(--mono)',
    fontSize: 'var(--editor-font-size)',
  },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(150,110,30,0.1)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 4px 0 8px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { overflow: 'auto' },
  '.cm-line': { padding: '0' },
  '.cm-selectionMatch': { backgroundColor: 'rgba(150,110,30,0.15)' },
  '.cm-matchingBracket': { backgroundColor: 'rgba(150,110,30,0.3)', color: 'var(--accent) !important' },
  '.cm-nonmatchingBracket': { backgroundColor: 'rgba(200,50,50,0.2)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--bg2)',
    border: '1px solid var(--border-hi)',
    color: 'var(--fg)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete': {
    '& > ul': {
      fontFamily: 'var(--mono)',
      fontSize: 'var(--editor-font-size)',
    },
    '& > ul > li': { padding: '2px 8px' },
    '& > ul > li[aria-selected]': {
      backgroundColor: 'rgba(150,110,30,0.2)',
      color: 'var(--fg-bright)',
    },
  },
  '.cm-completionLabel': { color: 'var(--fg-bright)' },
  '.cm-completionDetail': { color: 'var(--fg-dim)', fontStyle: 'italic', marginLeft: '8px' },
  '.cm-completionMatchedText': { textDecoration: 'none', color: 'var(--accent)' },
}, { dark: false });

// ── HIGHLIGHT STYLE ──

const gcuHighlightDark = HighlightStyle.define([
  { tag: tags.keyword, color: '#7a9ec7' },
  { tag: tags.string, color: 'var(--accent)' },
  { tag: tags.number, color: '#8cb878' },
  { tag: tags.bool, color: '#8cb878' },
  { tag: tags.null, color: '#8cb878' },
  { tag: tags.comment, color: '#555', fontStyle: 'italic' },
  { tag: tags.function(tags.variableName), color: '#c4a6d0' },
  { tag: tags.function(tags.propertyName), color: '#c4a6d0' },
  { tag: tags.definition(tags.variableName), color: 'var(--fg-bright)' },
  { tag: tags.constant(tags.variableName), color: '#d09870' },
  { tag: tags.operator, color: '#888' },
  { tag: tags.punctuation, color: '#666' },
  { tag: tags.separator, color: '#666' },
  { tag: tags.paren, color: '#666' },
  { tag: tags.brace, color: '#666' },
  { tag: tags.squareBracket, color: '#666' },
  { tag: tags.propertyName, color: '#7aabcf' },
  { tag: tags.variableName, color: 'var(--fg-bright)' },
  { tag: tags.typeName, color: '#6dbfb8' },
  { tag: tags.className, color: '#6dbfb8' },
  // CSS tokens
  { tag: tags.tagName, color: '#6dbfb8' },
  { tag: tags.attributeName, color: '#7aabcf' },
  { tag: tags.color, color: 'var(--accent)' },
  { tag: tags.special(tags.string), color: 'var(--accent)' },
  // HTML tokens
  { tag: tags.angleBracket, color: '#6dbfb8' },
  { tag: tags.self, color: '#d09870' },
  { tag: tags.regexp, color: '#d09870' },
]);

const gcuHighlightLight = HighlightStyle.define([
  { tag: tags.keyword, color: '#4a6f8e' },
  { tag: tags.string, color: 'var(--accent)' },
  { tag: tags.number, color: '#5a8a4a' },
  { tag: tags.bool, color: '#5a8a4a' },
  { tag: tags.null, color: '#5a8a4a' },
  { tag: tags.comment, color: '#999', fontStyle: 'italic' },
  { tag: tags.function(tags.variableName), color: '#8a6aaa' },
  { tag: tags.function(tags.propertyName), color: '#8a6aaa' },
  { tag: tags.definition(tags.variableName), color: 'var(--fg-bright)' },
  { tag: tags.constant(tags.variableName), color: '#b07840' },
  { tag: tags.operator, color: '#666' },
  { tag: tags.punctuation, color: '#888' },
  { tag: tags.separator, color: '#888' },
  { tag: tags.paren, color: '#888' },
  { tag: tags.brace, color: '#888' },
  { tag: tags.squareBracket, color: '#888' },
  { tag: tags.propertyName, color: '#4a7a9e' },
  { tag: tags.variableName, color: 'var(--fg-bright)' },
  { tag: tags.typeName, color: '#3d8a83' },
  { tag: tags.className, color: '#3d8a83' },
  { tag: tags.tagName, color: '#3d8a83' },
  { tag: tags.attributeName, color: '#4a7a9e' },
  { tag: tags.color, color: 'var(--accent)' },
  { tag: tags.special(tags.string), color: 'var(--accent)' },
  { tag: tags.angleBracket, color: '#3d8a83' },
  { tag: tags.self, color: '#b07840' },
  { tag: tags.regexp, color: '#b07840' },
]);

// ── COMPARTMENTS ──

const themeComp = new Compartment();
const highlightComp = new Compartment();
const langComp = new Compartment();
const lineNumbersComp = new Compartment();
const readOnlyComp = new Compartment();
const autocompleteComp = new Compartment();

// ── SEARCH DECORATIONS ──

const setSearchEffect = StateEffect.define();
const clearSearchEffect = StateEffect.define();

const searchField = StateField.define({
  create() { return Decoration.none; },
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setSearchEffect)) return e.value;
      if (e.is(clearSearchEffect)) return Decoration.none;
    }
    // map positions through document changes
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
  provide: f => EditorView.decorations.from(f),
});

// ── TAGGED TEMPLATE NESTED LANGUAGE SUPPORT ──

// Map our tokenizer types to @lezer/highlight tags
const _tokenTable = {
  kw:    tags.keyword,
  num:   tags.number,
  cmt:   tags.comment,
  fn:    tags.function(tags.variableName),
  const: tags.typeName,
  op:    tags.operator,
  punc:  tags.punctuation,
  str:   tags.string,
  id:    tags.variableName,
};

// Convert an auditable tokenizer to a CM6 StreamLanguage
function makeStreamLang(lang) {
  if (lang._streamLang) return lang._streamLang;
  const tokenize = lang.tokenize;
  lang._streamLang = StreamLanguage.define({
    token(stream) {
      if (stream.sol()) {
        stream.lineTokens = tokenize(stream.string);
        stream.lineTokenIdx = 0;
      }
      const toks = stream.lineTokens;
      if (!toks || stream.lineTokenIdx >= toks.length) {
        stream.skipToEnd();
        return null;
      }
      const tok = toks[stream.lineTokenIdx];
      stream.lineTokenIdx++;
      const len = tok.text.length;
      if (len > 0) {
        stream.pos += len;
      } else {
        stream.pos++;
      }
      const type = tok.type;
      return (type && type in _tokenTable) ? type : null;
    },
    tokenTable: _tokenTable,
    indent(state, textAfter, cx) {
      // preserve previous line's indentation
      return cx.lineIndent(cx.pos, -1);
    },
    startState() { return {}; },
    copyState(s) { return {}; },
  });
  return lang._streamLang;
}

// parseMixed nest function for tagged templates
function nestTaggedTemplates(node, input) {
  if (node.name !== 'TemplateString') return null;
  // Must be inside a TaggedTemplateExpression
  const parent = node.node.parent;
  if (!parent || parent.name !== 'TaggedTemplateExpression') return null;

  // Read tag name from the first child of the parent
  const tagNode = parent.firstChild;
  if (!tagNode) return null;

  let tagName = null;
  if (tagNode.name === 'VariableName') {
    tagName = input.read(tagNode.from, tagNode.to);
  } else if (tagNode.name === 'CallExpression') {
    // curried: lang({...})`...`
    const callee = tagNode.firstChild;
    if (callee && callee.name === 'VariableName') {
      tagName = input.read(callee.from, callee.to);
    }
  }

  if (!tagName || !window._taggedLanguages || !window._taggedLanguages[tagName]) return null;
  const lang = window._taggedLanguages[tagName];
  if (!lang.tokenize) return null;

  const streamLang = makeStreamLang(lang);

  // Compute overlay ranges: text between backtick/interpolations
  const contentFrom = node.from + 1; // skip opening backtick
  const contentTo = node.to - 1;     // skip closing backtick
  if (contentFrom >= contentTo) return null;

  const overlay = [];
  let segStart = contentFrom;
  let child = node.node.firstChild;
  while (child) {
    if (child.name === 'Interpolation') {
      if (segStart < child.from) overlay.push({ from: segStart, to: child.from });
      segStart = child.to;
    }
    child = child.nextSibling;
  }
  if (segStart < contentTo) overlay.push({ from: segStart, to: contentTo });

  if (overlay.length === 0) return null;
  return { parser: streamLang.parser, overlay };
}

// Base JS language (cached)
const _baseJs = javascript();

function mixedJavascript() {
  const wrapped = _baseJs.language.configure({
    wrap: parseMixed(nestTaggedTemplates),
  });
  return new LanguageSupport(wrapped, _baseJs.support);
}

// indentService for tagged templates — overlay mode doesn't delegate
// indentation to the nested language, so handle it at the editor level
const taggedTemplateIndent = indentService.of((cx, pos) => {
  const tree = syntaxTree(cx.state);
  // resolve() stays in the outer JS tree; resolveInner() enters overlays
  // where the parent chain won't reach TemplateString
  let node = tree.resolve(pos, -1);
  while (node) {
    if (node.name === 'TemplateString') {
      const parent = node.parent;
      if (parent && parent.name === 'TaggedTemplateExpression') {
        const tagNode = parent.firstChild;
        let tagName = null;
        if (tagNode && tagNode.name === 'VariableName') {
          tagName = cx.state.doc.sliceString(tagNode.from, tagNode.to);
        } else if (tagNode && tagNode.name === 'CallExpression') {
          const callee = tagNode.firstChild;
          if (callee && callee.name === 'VariableName') {
            tagName = cx.state.doc.sliceString(callee.from, callee.to);
          }
        }
        if (tagName && window._taggedLanguages && window._taggedLanguages[tagName]) {
          // insertNewlineAndIndent uses simulateBreak — the newline isn't
          // inserted yet, so lineAt(pos) is the CURRENT line being split.
          // We want its indentation, not the previous line's.
          const line = cx.state.doc.lineAt(pos);
          const m = /^\s*/.exec(line.text);
          return m ? m[0].length : 0;
        }
      }
    }
    node = node.parent;
  }
  return undefined; // let language indentation handle it
});

// ── CSS COLOR SWATCH ──

const CSS_NAMED_COLORS = new Set([
  'black','silver','gray','white','maroon','red','purple','fuchsia',
  'green','lime','olive','yellow','navy','blue','teal','aqua','orange'
]);

function resolveToHex(colorStr) {
  const d = document.createElement('div');
  d.style.color = colorStr;
  document.body.appendChild(d);
  const rgb = getComputedStyle(d).color;
  d.remove();
  const m = rgb.match(/(\d+)/g);
  if (!m || m.length < 3) return colorStr;
  return '#' + m.slice(0, 3).map(n => parseInt(n).toString(16).padStart(2, '0')).join('');
}

let _colorPicker = null;
let _pickerTarget = null; // { view, from, to }

function ensureColorPicker() {
  if (_colorPicker) return _colorPicker;
  _colorPicker = document.createElement('input');
  _colorPicker.type = 'color';
  _colorPicker.style.cssText = 'position:absolute;visibility:hidden;width:0;height:0;';
  document.body.appendChild(_colorPicker);
  _colorPicker.addEventListener('input', () => {
    if (!_pickerTarget) return;
    const { view, from, to } = _pickerTarget;
    const newColor = _colorPicker.value;
    view.dispatch({ changes: { from, to, insert: newColor } });
    // update target for next pick
    _pickerTarget.to = from + newColor.length;
  });
  return _colorPicker;
}

class ColorSwatchWidget extends WidgetType {
  constructor(color, from, to) {
    super();
    this.color = color;
    this.from = from;
    this.to = to;
  }
  toDOM(view) {
    const span = document.createElement('span');
    span.className = 'hl-swatch';
    span.style.background = this.color;
    span.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const picker = ensureColorPicker();
      _pickerTarget = { view, from: this.from, to: this.to };
      const hex = resolveToHex(view.state.doc.sliceString(this.from, this.to));
      picker.value = hex;
      picker.click();
    });
    return span;
  }
  eq(other) { return this.color === other.color && this.from === other.from && this.to === other.to; }
}

const colorSwatchPlugin = ViewPlugin.define(view => {
  return {
    decorations: buildColorDecorations(view),
    update(update) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildColorDecorations(update.view);
      }
    },
  };
}, {
  decorations: v => v.decorations,
});

function buildColorDecorations(view) {
  const builder = [];
  const doc = view.state.doc.toString();
  // match hex colors and named colors
  const re = /#(?:[0-9a-fA-F]{3,8})\b|(?<=:\s*)(\b(?:black|silver|gray|white|maroon|red|purple|fuchsia|green|lime|olive|yellow|navy|blue|teal|aqua|orange)\b)/g;
  let m;
  while ((m = re.exec(doc)) !== null) {
    const color = m[0];
    const from = m.index;
    const to = from + color.length;
    const hex = resolveToHex(color);
    builder.push(Decoration.widget({
      widget: new ColorSwatchWidget(hex, from, to),
      side: -1,
    }).range(from));
  }
  return Decoration.set(builder);
}

// ── NOTEBOOK KEYMAP ──

function getCellIdFromView(view) {
  const wrap = view.dom.closest('[data-cm-cell-id]');
  return wrap ? parseInt(wrap.dataset.cmCellId) : null;
}

// these are imported dynamically to avoid circular deps — set up by init
let _exitEdit = null;
let _runSelectedCell = null;
let _runSelectedAndAdvance = null;

export function setCm6Callbacks(exitEdit, runSelectedCell, runSelectedAndAdvance) {
  _exitEdit = exitEdit;
  _runSelectedCell = runSelectedCell;
  _runSelectedAndAdvance = runSelectedAndAdvance;
}

const notebookKeymap = keymap.of([
  { key: 'Escape', run: (view) => {
    if (_exitEdit) _exitEdit(view);
    return true;
  }},
  { key: 'Ctrl-Enter', run: (view) => {
    const cellId = getCellIdFromView(view);
    if (cellId !== null) {
      const cell = S.cells.find(c => c.id === cellId);
      if (cell && cell.type === 'code') {
        // runDAG is called via the callback
        if (_runSelectedCell) _runSelectedCell(cellId);
      }
    }
    return true;
  }},
  { key: 'Shift-Enter', run: (view) => {
    const cellId = getCellIdFromView(view);
    if (cellId !== null) {
      if (_runSelectedAndAdvance) _runSelectedAndAdvance(cellId);
    }
    return true;
  }},
]);

// ── EDITOR FACTORY ──

const _editors = new Map(); // cellId → { view, ... }
let _onEditorCreated = null; // callback: (cellId, cellType) => void

export function setOnEditorCreated(fn) { _onEditorCreated = fn; }

function getLangExtension(cellType) {
  if (cellType === 'code') return mixedJavascript();
  if (cellType === 'css') return css();
  if (cellType === 'html') return html();
  return [];
}

export function createEditor(container, cellId, initialCode, cellType, onChange) {
  const isDark = !document.documentElement.classList.contains('light');
  const showLines = !document.documentElement.classList.contains('hide-line-numbers');
  const isPresenting = document.body.classList.contains('presenting');

  // mark the container for cell ID lookup
  container.dataset.cmCellId = cellId;

  const extensions = [
    // theme
    themeComp.of(isDark ? gcuDark : gcuLight),
    highlightComp.of(syntaxHighlighting(isDark ? gcuHighlightDark : gcuHighlightLight)),
    // language
    langComp.of(getLangExtension(cellType)),
    // line numbers
    lineNumbersComp.of(showLines ? lineNumbers() : []),
    // read only
    readOnlyComp.of(EditorState.readOnly.of(isPresenting)),
    // core
    history(),
    bracketMatching(),
    closeBrackets(),
    indentOnInput(),
    highlightActiveLine(),
    highlightSpecialChars(),
    drawSelection(),
    EditorView.lineWrapping,
    // keymaps
    notebookKeymap,
    keymap.of([{ key: 'Enter', run: insertNewlineAndIndent }]),
    keymap.of([{ key: 'Tab', run: acceptCompletion }, indentWithTab]),
    keymap.of([{ key: 'Mod-/', run: toggleComment }]),
    keymap.of([{ key: 'Mod-z', run: cm6Undo }, { key: 'Mod-Shift-z', run: cm6Redo }]),
    // tagged template indentation (code cells only)
    ...(cellType === 'code' ? [taggedTemplateIndent] : []),
    // autocomplete compartment (configured externally)
    autocompleteComp.of([]),
    // search decorations
    searchField,
    // color swatch (CSS cells only)
    ...(cellType === 'css' ? [colorSwatchPlugin] : []),
    // update listener
    EditorView.updateListener.of(update => {
      if (update.docChanged && onChange) {
        onChange(update.view.state.doc.toString());
      }
    }),
  ];

  const state = EditorState.create({
    doc: initialCode || '',
    extensions,
  });

  const view = new EditorView({
    state,
    parent: container,
  });

  // clicks on the wrapper or gutter should focus the editor
  container.addEventListener('mousedown', (e) => {
    if (e.target === container) {
      e.preventDefault();
      view.focus();
    } else if (!view.hasFocus) {
      // gutter clicks don't always activate CM6's input handling —
      // schedule focus after CM6's own mousedown runs
      setTimeout(() => { if (!view.hasFocus) view.focus(); }, 0);
    }
  });

  const editor = {
    view,
    getCode() { return view.state.doc.toString(); },
    setCode(code) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: code },
      });
    },
    focus() { view.focus(); },
    destroy() {
      view.destroy();
      _editors.delete(cellId);
    },
  };

  _editors.set(cellId, editor);
  if (_onEditorCreated) _onEditorCreated(cellId, cellType);
  return editor;
}

export function getEditor(cellId) {
  return _editors.get(cellId) || null;
}

// ── UPDATE ALL EDITORS ──

export function updateAllEditorThemes(isDark) {
  for (const [, editor] of _editors) {
    editor.view.dispatch({
      effects: [
        themeComp.reconfigure(isDark ? gcuDark : gcuLight),
        highlightComp.reconfigure(syntaxHighlighting(isDark ? gcuHighlightDark : gcuHighlightLight)),
      ],
    });
  }
}

export function updateAllEditorLineNumbers(show) {
  for (const [, editor] of _editors) {
    editor.view.dispatch({
      effects: lineNumbersComp.reconfigure(show ? lineNumbers() : []),
    });
  }
}

export function updateAllEditorReadOnly(readOnly) {
  for (const [, editor] of _editors) {
    editor.view.dispatch({
      effects: readOnlyComp.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }
}

export function setEditorAutocomplete(cellId, extensions) {
  const editor = _editors.get(cellId);
  if (!editor) return;
  editor.view.dispatch({
    effects: autocompleteComp.reconfigure(extensions),
  });
}

export function refreshTaggedLanguages() {
  for (const [cellId, editor] of _editors) {
    const cell = S.cells.find(c => c.id === cellId);
    if (cell && cell.type === 'code') {
      editor.view.dispatch({
        effects: langComp.reconfigure(mixedJavascript()),
      });
    }
  }
}

// ── SEARCH DECORATION HELPERS ──

export function setEditorSearchDecorations(cellId, ranges) {
  const editor = _editors.get(cellId);
  if (!editor) return;
  const decos = ranges.map(r =>
    Decoration.mark({ class: r.current ? 'search-match search-match-current' : 'search-match' })
      .range(r.from, r.to)
  );
  editor.view.dispatch({
    effects: setSearchEffect.of(Decoration.set(decos)),
  });
}

export function clearEditorSearchDecorations(cellId) {
  const editor = _editors.get(cellId);
  if (!editor) return;
  editor.view.dispatch({ effects: clearSearchEffect.of(null) });
}

export function clearAllSearchDecorations() {
  for (const [cellId] of _editors) {
    clearEditorSearchDecorations(cellId);
  }
}

// ── RE-EXPORTS FOR AUTOCOMPLETE ──

export { autocompletion, CompletionContext };
