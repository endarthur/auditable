import { S, $ } from './state.js';
import { runAll, runDAG, renderHtmlCell, renderMdCell } from './exec.js';
import { isCollapsed } from './dag.js';
import { addCell } from './cell-ops.js';
import { _ctIsExecutable, _ctHasOutput } from './cell-types.js';
import {
  getEditor, mcpHighlightField, mixedJavascript,
  EditorView, EditorState, Compartment, keymap,
  lineNumbers, highlightActiveLine, highlightSpecialChars, drawSelection,
  ViewPlugin, Decoration,
  indentWithTab, insertNewlineAndIndent, toggleComment,
  history, cm6Undo, cm6Redo,
  bracketMatching, syntaxHighlighting, HighlightStyle, indentOnInput,
  closeBrackets, acceptCompletion,
  tags,
  Language, defineLanguageFacet, parseMixed,
  Parser, NodeType, NodeSet, Tree,
  styleTags,
  javascript, css, html, pythonLang,
  autocompletion, makeStreamLang,
} from './cm6.js';
import { sigHintPlugin } from './complete.js';
import { cssSummary } from './cell-dom.js';
import { applyEditorView } from './settings.js';

// ── TXT FORMAT ──

function trimCell(code) {
  return code.replace(/^\n/, '').replace(/\n$/, '');
}

export function parseTxt(content) {
  const lines = content.split('\n');
  let title = 'untitled';
  let settings = null;
  const cells = [];
  let currentCell = null;

  for (const line of lines) {
    const l = line.endsWith('\r') ? line.slice(0, -1) : line;

    if (l.startsWith('/// ')) {
      if (currentCell) {
        currentCell.code = trimCell(currentCell.code);
        cells.push(currentCell);
        currentCell = null;
      }

      const directive = l.slice(4);

      if (directive === 'auditable') continue;
      else if (directive.startsWith('title: ')) title = directive.slice(7);
      else if (directive.startsWith('settings: ')) {
        try { settings = JSON.parse(directive.slice(10)); } catch {}
      } else if (directive.startsWith('module: ')) {
        // modules are not editable in split view — ignore
      } else {
        const parts = directive.split(' ');
        const type = parts[0];
        const collapsed = parts.includes('collapsed');
        currentCell = { type };
        if (collapsed) currentCell.collapsed = true;
        currentCell.code = '';
      }
    } else if (currentCell) {
      currentCell.code += (currentCell.code ? '\n' : '') + l;
    }
  }

  if (currentCell) {
    currentCell.code = trimCell(currentCell.code);
    cells.push(currentCell);
  }

  return { title, cells, settings };
}

export function toTxt() {
  const title = $('#docTitle').value || 'untitled';
  const lines = ['/// auditable'];

  if (title && title !== 'untitled') {
    lines.push('/// title: ' + title);
  }

  // include module directives so they survive round-trip
  const mods = window._installedModules || {};
  for (const url of Object.keys(mods)) {
    lines.push('/// module: ' + url);
  }

  for (const cell of S.cells) {
    lines.push('');
    const collapsed = cell.collapsed;
    const flags = collapsed ? ' collapsed' : '';
    lines.push('/// ' + cell.type + flags);
    lines.push(cell.code || '');
  }

  return lines.join('\n') + '\n';
}

// Update a cell's code in the split editor (registered as S._splitSetCode when active)
function _updateSplitCell(cellIndex, newCode) {
  const doc = S.splitEditor.state.doc;
  const text = doc.toString();
  const lines = text.split('\n');

  // find the start and end LINE of the cell at cellIndex by scanning /// directives
  let idx = -1;
  let cellStartLine = -1; // line after the /// directive
  let cellEndLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\/\/\/\s+(\w+)/.test(lines[i].trimEnd())) {
      idx++;
      if (idx === cellIndex) {
        cellStartLine = i + 1;
      } else if (idx === cellIndex + 1) {
        cellEndLine = i;
        while (cellEndLine > cellStartLine && lines[cellEndLine - 1].trim() === '') cellEndLine--;
        break;
      }
    }
  }
  if (cellStartLine < 0) return false;
  if (cellEndLine < 0) {
    cellEndLine = lines.length;
    while (cellEndLine > cellStartLine && lines[cellEndLine - 1].trim() === '') cellEndLine--;
  }

  // convert line numbers to character offsets
  let charPos = 0;
  const lineOffsets = [];
  for (let i = 0; i < lines.length; i++) {
    lineOffsets.push(charPos);
    charPos += lines[i].length + 1; // +1 for \n
  }
  const from = lineOffsets[cellStartLine];
  const to = cellEndLine < lines.length ? lineOffsets[cellEndLine] - 1 : text.length; // -1 to not eat the \n before next directive

  S.splitEditor.dispatch({
    changes: { from, to, insert: newCode },
  });
  // sync to cells
  syncFromTxt(S.splitEditor.state.doc.toString());
  return true;
}

// ── SPLIT VIEW ──

// ── AUDITABLE FORMAT PARSER ──
// Custom Parser subclass for the /// notebook format. Segments the document
// into Directive / CodeCell / CssCell / HtmlCell / MdCell nodes. parseMixed
// delegates each cell region to the appropriate sub-parser (JS, CSS, HTML).

const _auditableNodeTypes = [
  NodeType.define({ id: 0, name: 'Document', top: true }),
  NodeType.define({ id: 1, name: 'Directive' }),
  NodeType.define({ id: 2, name: 'CodeCell' }),
  NodeType.define({ id: 3, name: 'CssCell' }),
  NodeType.define({ id: 4, name: 'HtmlCell' }),
  NodeType.define({ id: 5, name: 'MdCell' }),
  NodeType.define({ id: 6, name: 'PythonCell' }),
  NodeType.define({ id: 7, name: 'PluginCell' }),
];

// Built-in cell-type → parser-region node id. Plugin types (soft, soft-ptbr,
// and anything registered via window._cellTypes) share the generic PluginCell
// node, which carries no nested parser but at least establishes the region
// so directives are recognized and the body renders as a distinct cell.
const _BUILTIN_CELL_TYPE_IDS = { code: 2, css: 3, html: 4, md: 5, adder: 6 };
const _PLUGIN_CELL_TYPE_ID = 7;

const _auditableNodeSet = new NodeSet(_auditableNodeTypes).extend(
  styleTags({ Directive: tags.comment })
);

const _jsParser = mixedJavascript().language.parser;
const _cssParser = css().language.parser;
const _htmlParser = html().language.parser;
const _pythonParser = pythonLang().language.parser;

// For PluginCell regions, walk backwards from node.from to find the preceding
// /// <type> directive line, then look up the plugin's tokenizer in
// window._taggedLanguages. Returns the StreamLanguage parser, or null if the
// plugin doesn't ship a tokenizer (cell renders as plain text like md).
function _pluginCellParser(node, input) {
  const lookbackStart = Math.max(0, node.from - 300);
  const prefix = input.read(lookbackStart, node.from);
  const lines = prefix.split('\n');
  let directiveType = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('/// ')) {
      directiveType = lines[i].slice(4).split(' ')[0];
      break;
    }
  }
  if (!directiveType) return null;
  const lang = (typeof window !== 'undefined' && window._taggedLanguages) ? window._taggedLanguages[directiveType] : null;
  if (!lang || !lang.tokenize) return null;
  return makeStreamLang(lang).parser;
}

const _nestLanguages = parseMixed((node, input) => {
  if (node.name === 'CodeCell') return { parser: _jsParser };
  if (node.name === 'CssCell') return { parser: _cssParser };
  if (node.name === 'HtmlCell') return { parser: _htmlParser };
  if (node.name === 'PythonCell') return { parser: _pythonParser };
  if (node.name === 'PluginCell') {
    const parser = _pluginCellParser(node, input);
    return parser ? { parser } : null;
  }
  return null;
});

class AuditableParser extends Parser {
  createParse(input, fragments, ranges) {
    // Full reparse on every edit — ranges parameter is ignored.
    // Incremental parsing could use fragments to reuse unchanged cell
    // subtrees, but notebooks are small enough that this is fine.
    const baseParse = {
      parsedPos: 0,
      stopAt() {},
      stoppedAt: null,
      advance() {
        const text = input.read(0, input.length);
        const children = [];
        const positions = [];
        const lines = text.split('\n');
        let pos = 0;
        let cellTypeId = 0;
        let cellStart = -1;

        const flushCell = (end) => {
          if (cellTypeId && cellStart >= 0 && end > cellStart) {
            children.push(new Tree(_auditableNodeSet.types[cellTypeId], [], [], end - cellStart));
            positions.push(cellStart);
          }
          cellTypeId = 0;
          cellStart = -1;
        };

        const _pluginTypes = (typeof window !== 'undefined' && window._cellTypes) || null;

        for (let i = 0; i < lines.length; i++) {
          const lineStart = pos;
          const lineLen = lines[i].length;

          if (lines[i].startsWith('/// ')) {
            flushCell(lineStart);
            children.push(new Tree(_auditableNodeSet.types[1], [], [], lineLen));
            positions.push(lineStart);
            const t = lines[i].slice(4).split(' ')[0];
            let nextId = 0;
            if (t in _BUILTIN_CELL_TYPE_IDS) nextId = _BUILTIN_CELL_TYPE_IDS[t];
            else if (_pluginTypes && _pluginTypes[t]) nextId = _PLUGIN_CELL_TYPE_ID;
            if (nextId) {
              cellTypeId = nextId;
              cellStart = Math.min(lineStart + lineLen + 1, text.length);
            }
          }

          pos += lineLen + 1;
        }

        flushCell(text.length);

        return new Tree(
          _auditableNodeSet.types[0],
          children,
          positions,
          text.length
        );
      }
    };
    return _nestLanguages(baseParse, input, fragments, ranges);
  }
}

const _auditableParser = new AuditableParser();
const auditableLang = new Language(defineLanguageFacet(), _auditableParser, [], 'auditable');

// ── MARKDOWN HEADING DECORATION ──
// Bold decoration for markdown headings (visual, not syntax highlighting)

const mdHeadingLineDeco = Decoration.line({ class: 'cm-md-heading-line' });

const mdHeadingPlugin = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = this.buildDecorations(view);
  }

  update(update) {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = this.buildDecorations(update.view);
    }
  }

  buildDecorations(view) {
    const decorations = [];
    const doc = view.state.doc;
    let cellType = null;

    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i);

      if (line.text.startsWith('/// ')) {
        const type = line.text.slice(4).split(' ')[0];
        if (['code', 'md', 'css', 'html'].includes(type)) cellType = type;
        continue;
      }

      if (cellType === 'md' && /^#{1,6}\s/.test(line.text)) {
        decorations.push(mdHeadingLineDeco.range(line.from));
      }
    }

    return Decoration.set(decorations, true);
  }
}, {
  decorations: v => v.decorations,
});

const splitThemeDark = EditorView.theme({
  '&': {
    backgroundColor: 'var(--au-surface-raised)',
    color: 'var(--au-fg)',
    fontSize: 'var(--editor-font-size)',
    fontFamily: 'var(--au-font-mono)',
  },
  '.cm-content': {
    caretColor: 'var(--au-fg)',
    lineHeight: '1.5',
    padding: '8px 10px',
    fontFamily: 'var(--au-font-mono)',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--au-fg)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'rgba(200,155,60,0.25)',
  },
  '.cm-activeLine': { backgroundColor: 'rgba(200,155,60,0.05)' },
  '.cm-gutters': {
    backgroundColor: 'var(--au-surface-raised)',
    color: 'var(--au-fg-soft)',
    borderRight: '1px solid var(--au-border)',
    fontFamily: 'var(--au-font-mono)',
    fontSize: 'var(--editor-font-size)',
  },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(200,155,60,0.08)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 4px 0 8px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { overflow: 'auto' },
  '.cm-line': { padding: '0' },
  '.cm-selectionMatch': { backgroundColor: 'rgba(200,155,60,0.15)' },
  '.cm-matchingBracket': { backgroundColor: 'rgba(200,155,60,0.3)', color: 'var(--au-action) !important' },
  '.cm-nonmatchingBracket': { backgroundColor: 'rgba(170,50,50,0.3)' },
}, { dark: true });

const splitThemeLight = EditorView.theme({
  '&': {
    backgroundColor: 'var(--au-surface-raised)',
    color: 'var(--au-fg)',
    fontSize: 'var(--editor-font-size)',
    fontFamily: 'var(--au-font-mono)',
  },
  '.cm-content': {
    caretColor: 'var(--au-fg)',
    lineHeight: '1.5',
    padding: '8px 10px',
    fontFamily: 'var(--au-font-mono)',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--au-fg)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'rgba(150,110,30,0.2)',
  },
  '.cm-activeLine': { backgroundColor: 'rgba(150,110,30,0.06)' },
  '.cm-gutters': {
    backgroundColor: 'var(--au-surface-raised)',
    color: 'var(--au-fg-soft)',
    borderRight: '1px solid var(--au-border)',
    fontFamily: 'var(--au-font-mono)',
    fontSize: 'var(--editor-font-size)',
  },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(150,110,30,0.1)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 4px 0 8px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { overflow: 'auto' },
  '.cm-line': { padding: '0' },
  '.cm-selectionMatch': { backgroundColor: 'rgba(150,110,30,0.15)' },
  '.cm-matchingBracket': { backgroundColor: 'rgba(150,110,30,0.3)', color: 'var(--au-action) !important' },
  '.cm-nonmatchingBracket': { backgroundColor: 'rgba(200,50,50,0.2)' },
}, { dark: false });

const splitHighlightDark = HighlightStyle.define([
  { tag: tags.keyword, color: '#7a9ec7' },
  { tag: tags.string, color: 'var(--au-action)' },
  { tag: tags.number, color: '#8cb878' },
  { tag: tags.bool, color: '#8cb878' },
  { tag: tags.null, color: '#8cb878' },
  { tag: tags.comment, color: '#555', fontStyle: 'italic' },
  { tag: tags.function(tags.variableName), color: '#c4a6d0' },
  { tag: tags.function(tags.propertyName), color: '#c4a6d0' },
  { tag: tags.definition(tags.variableName), color: 'var(--au-fg)' },
  { tag: tags.constant(tags.variableName), color: '#d09870' },
  { tag: tags.operator, color: '#888' },
  { tag: tags.punctuation, color: '#666' },
  { tag: tags.separator, color: '#666' },
  { tag: tags.paren, color: '#666' },
  { tag: tags.brace, color: '#666' },
  { tag: tags.squareBracket, color: '#666' },
  { tag: tags.propertyName, color: '#7aabcf' },
  { tag: tags.variableName, color: 'var(--au-fg)' },
  { tag: tags.typeName, color: '#6dbfb8' },
  { tag: tags.className, color: '#6dbfb8' },
  { tag: tags.tagName, color: '#6dbfb8' },
  { tag: tags.attributeName, color: '#7aabcf' },
  { tag: tags.attributeValue, color: 'var(--au-action)' },
  { tag: tags.angleBracket, color: '#6dbfb8' },
  { tag: tags.color, color: 'var(--au-action)' },
  { tag: tags.special(tags.string), color: 'var(--au-action)' },
  { tag: tags.self, color: '#d09870' },
  { tag: tags.regexp, color: '#d09870' },
]);

const splitHighlightLight = HighlightStyle.define([
  { tag: tags.keyword, color: '#4a6f8e' },
  { tag: tags.string, color: 'var(--au-action)' },
  { tag: tags.number, color: '#5a8a4a' },
  { tag: tags.bool, color: '#5a8a4a' },
  { tag: tags.null, color: '#5a8a4a' },
  { tag: tags.comment, color: '#999', fontStyle: 'italic' },
  { tag: tags.function(tags.variableName), color: '#8a6aaa' },
  { tag: tags.function(tags.propertyName), color: '#8a6aaa' },
  { tag: tags.definition(tags.variableName), color: 'var(--au-fg)' },
  { tag: tags.constant(tags.variableName), color: '#b07840' },
  { tag: tags.operator, color: '#666' },
  { tag: tags.punctuation, color: '#888' },
  { tag: tags.separator, color: '#888' },
  { tag: tags.paren, color: '#888' },
  { tag: tags.brace, color: '#888' },
  { tag: tags.squareBracket, color: '#888' },
  { tag: tags.propertyName, color: '#4a7a9e' },
  { tag: tags.variableName, color: 'var(--au-fg)' },
  { tag: tags.typeName, color: '#3d8a83' },
  { tag: tags.className, color: '#3d8a83' },
  { tag: tags.tagName, color: '#3d8a83' },
  { tag: tags.attributeName, color: '#4a7a9e' },
  { tag: tags.attributeValue, color: 'var(--au-action)' },
  { tag: tags.angleBracket, color: '#3d8a83' },
  { tag: tags.color, color: 'var(--au-action)' },
  { tag: tags.special(tags.string), color: 'var(--au-action)' },
  { tag: tags.self, color: '#b07840' },
  { tag: tags.regexp, color: '#b07840' },
]);

let _syncTimer = null;

// extract the code cell body surrounding the cursor in the /// document,
// so getCompletions/cursorContext sees clean JS without markdown apostrophes
// or HTML angle brackets that would confuse the string/comment scanner
function extractCodeCellAtCursor(doc, cursor) {
  const lines = doc.split('\n');
  let pos = 0;
  let cellStart = -1;
  let cellEnd = doc.length;
  let cellType = null;

  for (let i = 0; i < lines.length; i++) {
    const lineStart = pos;
    const lineEnd = pos + lines[i].length;

    if (lines[i].startsWith('/// ')) {
      const directive = lines[i].slice(4).split(' ')[0];
      if (['code', 'md', 'css', 'html'].includes(directive)) {
        if (cellStart !== -1 && cursor >= cellStart && cursor <= lineStart) {
          // cursor was in the previous cell
          cellEnd = lineStart;
          break;
        }
        cellType = directive;
        cellStart = lineEnd + 1; // start after the newline
      } else {
        // header directive (auditable, title, settings, module)
        if (cellStart === -1) {
          // not in a cell yet
        }
      }
    }

    pos = lineEnd + 1; // +1 for newline
  }

  // cursor is past the last /// directive
  if (cellStart === -1) return null;
  if (cursor < cellStart) return null;

  // only provide completions for code cells
  if (cellType !== 'code') return null;

  const cellCode = doc.slice(cellStart, cellEnd);
  const cellCursor = cursor - cellStart;
  return { code: cellCode, cursor: cellCursor };
}

// /// directive completions
const DIRECTIVE_COMPLETIONS = [
  { label: 'code', type: 'keyword', detail: 'code cell' },
  { label: 'md', type: 'keyword', detail: 'markdown cell' },
  { label: 'css', type: 'keyword', detail: 'css cell' },
  { label: 'html', type: 'keyword', detail: 'html template cell' },
  { label: 'code collapsed', type: 'keyword', detail: 'collapsed code cell' },
  { label: 'md collapsed', type: 'keyword', detail: 'collapsed markdown cell' },
  { label: 'css collapsed', type: 'keyword', detail: 'collapsed css cell' },
  { label: 'html collapsed', type: 'keyword', detail: 'collapsed html template cell' },
  { label: 'title: ', type: 'keyword', detail: 'notebook title' },
  { label: 'settings: ', type: 'keyword', detail: 'notebook settings JSON' },
  { label: 'module: ', type: 'keyword', detail: 'installed module URL' },
  { label: 'auditable', type: 'keyword', detail: 'format header' },
];

function directiveCompletions(context) {
  // match "/// " followed by optional partial text
  const line = context.state.doc.lineAt(context.pos);
  const lineText = line.text;
  if (!lineText.startsWith('/// ')) return null;

  const prefix = lineText.slice(4, context.pos - line.from);
  const from = line.from + 4;

  const options = [];
  for (const c of DIRECTIVE_COMPLETIONS) {
    if (!prefix || c.label.startsWith(prefix) || c.label.includes(prefix)) {
      options.push({ ...c, boost: c.label.startsWith(prefix) ? 10 : 0 });
    }
  }
  if (!options.length) return null;
  return { from, filter: false, options };
}

// snippet completions for blank lines between cells — typing "code" expands to "/// code\n"
const SNIPPET_COMPLETIONS = [
  { label: 'code', detail: 'insert code cell', directive: '/// code' },
  { label: 'md', detail: 'insert markdown cell', directive: '/// md' },
  { label: 'css', detail: 'insert css cell', directive: '/// css' },
  { label: 'html', detail: 'insert html cell', directive: '/// html' },
];

function snippetCompletions(context) {
  const line = context.state.doc.lineAt(context.pos);
  const lineText = line.text;

  // only on lines that look like partial cell type keywords, not inside a directive
  if (lineText.startsWith('///')) return null;

  // must be at the start of the line (only whitespace before the word)
  const word = context.matchBefore(/^\s*[a-zA-Z]+/);
  if (!word) return null;

  const typed = word.text.trim();
  if (!typed) return null;

  // check the line is empty except for the typed text (blank line between cells)
  if (lineText.trim() !== typed) return null;

  const options = [];
  for (const s of SNIPPET_COMPLETIONS) {
    if (s.label.startsWith(typed) || s.label.includes(typed)) {
      options.push({
        label: s.label,
        type: 'keyword',
        detail: s.detail,
        boost: s.label.startsWith(typed) ? 10 : 0,
        apply: (view, _completion, from, to) => {
          // replace the typed text with the full directive + trailing newline
          view.dispatch({
            changes: { from: word.from, to, insert: s.directive + '\n' },
            selection: { anchor: word.from + s.directive.length + 1 },
          });
        },
      });
    }
  }
  if (!options.length) return null;
  return { from: word.from, filter: false, options };
}

// completion source for the split editor — extracts the code cell around
// the cursor so cursorContext sees clean JS (avoids md apostrophes etc.)
function splitCompletionSource(context) {
  const doc = context.state.doc.toString();
  const cursor = context.pos;

  // check for /// directive completion first
  const dir = directiveCompletions(context);
  if (dir) return dir;

  if (!context.explicit) {
    const word = context.matchBefore(/[a-zA-Z_$]\w*/);
    if (!word) return null;
  }

  // snippet expansions — check before code completions because a blank line
  // at the end of a code cell is still "inside" the cell (cells are defined
  // only by their start directive). if the line has only a partial cell-type
  // keyword, offer the snippet regardless of which cell we're in.
  const snippet = snippetCompletions(context);
  if (snippet) return snippet;

  const cell = extractCodeCellAtCursor(doc, cursor);
  if (!cell) return null;

  // getCompletions is from complete.js (available in IIFE scope)
  const result = getCompletions(cell.code, cell.cursor, null);
  if (!result || !result.items.length) return null;

  return {
    from: cursor - result.prefix.length,
    filter: false,
    options: result.items.map(item => ({
      label: item.text,
      type: KIND_MAP[item.kind] || 'text',
      boost: item.score,
      detail: item.detail || undefined,
    })),
  };
}

function createSplitEditor(container, initialCode) {
  const isDark = !document.documentElement.classList.contains('light');

  const extensions = [
    isDark ? splitThemeDark : splitThemeLight,
    syntaxHighlighting(isDark ? splitHighlightDark : splitHighlightLight),
    auditableLang,
    mdHeadingPlugin,
    lineNumbers(),
    history(),
    bracketMatching(),
    closeBrackets(),
    indentOnInput(),
    highlightActiveLine(),
    highlightSpecialChars(),
    drawSelection(),
    EditorView.lineWrapping,
    keymap.of([{ key: 'Enter', run: insertNewlineAndIndent }]),
    keymap.of([{ key: 'Tab', run: acceptCompletion }, indentWithTab]),
    keymap.of([{ key: 'Mod-/', run: toggleComment }]),
    keymap.of([{ key: 'Mod-z', run: cm6Undo }, { key: 'Mod-Shift-z', run: cm6Redo }]),
    // Ctrl+Enter: sync + force-run cell under cursor
    keymap.of([{
      key: 'Ctrl-Enter',
      run: (view) => { immediateSyncAndRun(view); return true; },
    }, {
      key: 'Shift-Enter',
      run: (view) => { immediateSyncAndRun(view); return true; },
    }]),
    // autocompletion — uses splitCompletionSource which extracts the code cell
    // around the cursor before delegating to getCompletions, so cursorContext
    // doesn't get confused by markdown apostrophes or HTML in the /// format
    autocompletion({
      override: [splitCompletionSource],
      icons: false,
      activateOnTyping: true,
      maxRenderedOptions: 30,
    }),
    sigHintPlugin,
    mcpHighlightField,
    // debounced sync on edit
    EditorView.updateListener.of(update => {
      if (update.docChanged) {
        clearTimeout(_syncTimer);
        _syncTimer = setTimeout(() => {
          if (!S.splitEditor) return;
          syncFromTxt(update.view.state.doc.toString());
        }, 800);
      }
    }),
  ];

  const state = EditorState.create({ doc: initialCode || '', extensions });
  return new EditorView({ state, parent: container });
}

function immediateSync() {
  clearTimeout(_syncTimer);
  if (!S.splitEditor) return;
  syncFromTxt(S.splitEditor.state.doc.toString());
}

// Sync text and force-run the cell under the cursor
function immediateSyncAndRun(view) {
  immediateSync();
  // Find which cell the cursor is in by scanning /// directives up to cursor line
  const cursorPos = view.state.selection.main.head;
  const cursorLine = view.state.doc.lineAt(cursorPos).number; // 1-based
  const text = view.state.doc.toString();
  const lines = text.split('\n');

  let cellIdx = -1;
  for (let i = 0; i < lines.length && i < cursorLine; i++) {
    const l = lines[i].trimEnd();
    if (/^\/\/\/\s+(\w+)/.test(l)) cellIdx++;
  }

  if (cellIdx >= 0 && cellIdx < S.cells.length) {
    const cell = S.cells[cellIdx];
    // verify parsed cell type matches — after structural sync, indices may shift
    const expectedType = lines.slice(0, cursorLine).reverse()
      .find(l => /^\/\/\/\s+(\w+)/.test(l.trimEnd()));
    const parsedType = expectedType?.trimEnd().match(/^\/\/\/\s+(\w+)/)?.[1];
    if (parsedType && parsedType !== cell.type) return;
    if (cell.type === 'html') {
      renderHtmlCell(cell);
    } else if (_ctIsExecutable(cell.type)) {
      runDAG([cell.id], true);
    }
  }
}

// create lightweight output element for a cell type
function createOutputEl(type, id) {
  const div = document.createElement('div');
  div.className = 'split-output';
  div.dataset.type = type;
  div.dataset.id = id;

  if (type === 'code') {
    div.innerHTML = '<div class="cell-widgets"></div><div class="cell-output"></div>';
  } else if (type === 'md') {
    div.innerHTML = '<div class="cell-md-view"></div>';
  } else if (type === 'html') {
    div.innerHTML = '<div class="cell-html-view"></div><div class="cell-output"></div>';
  } else if (type !== 'css') {
    // plugin cell types (python, etc.) — need output container
    div.innerHTML = '<div class="cell-widgets"></div><div class="cell-output"></div>';
  }
  // css: no visible output
  return div;
}

function buildOutputPanel(container) {
  container.innerHTML = '';
  for (const cell of S.cells) {
    const outEl = createOutputEl(cell.type, cell.id);
    container.appendChild(outEl);
    // swap cell.el to the lightweight output element
    cell._splitOrigEl = cell.el;

    // splice existing output into new panel element
    const oldOutput = cell.el.querySelector('.cell-output');
    const newOutput = outEl.querySelector('.cell-output');
    if (oldOutput && newOutput && oldOutput.childNodes.length) {
      while (oldOutput.firstChild) newOutput.appendChild(oldOutput.firstChild);
      newOutput.className = oldOutput.className;
    }
    // splice existing widgets
    const oldWidgets = cell.el.querySelector('.cell-widgets');
    const newWidgets = outEl.querySelector('.cell-widgets');
    if (oldWidgets && newWidgets && oldWidgets.childNodes.length) {
      while (oldWidgets.firstChild) newWidgets.appendChild(oldWidgets.firstChild);
    }
    // splice md view
    const oldMd = cell.el.querySelector('.cell-md-view');
    const newMd = outEl.querySelector('.cell-md-view');
    if (oldMd && newMd && oldMd.innerHTML) {
      newMd.innerHTML = oldMd.innerHTML;
    }
    // splice html view
    const oldHtml = cell.el.querySelector('.cell-html-view');
    const newHtml = outEl.querySelector('.cell-html-view');
    if (oldHtml && newHtml && oldHtml.innerHTML) {
      newHtml.innerHTML = oldHtml.innerHTML;
    }

    cell.el = outEl;
  }
}

function restoreCellEls() {
  for (const cell of S.cells) {
    if (cell._splitOrigEl) {
      cell.el = cell._splitOrigEl;
      cell._splitOrigEl = null;
    }
  }
}

function syncFromTxt(txt) {
  const parsed = parseTxt(txt);
  const newCells = parsed.cells;
  const oldCells = S.cells;

  // update title if changed
  if (parsed.title) {
    const titleEl = $('#docTitle');
    if (titleEl && titleEl.value !== parsed.title) titleEl.value = parsed.title;
  }

  // structural change: different count or different types
  const structural = newCells.length !== oldCells.length ||
    newCells.some((c, i) => c.type !== oldCells[i]?.type);

  if (structural) {
    rebuildFromParsed(parsed);
    return;
  }

  // incremental: just update code for changed cells
  const dirtyIds = [];
  for (let i = 0; i < newCells.length; i++) {
    if (newCells[i].code !== oldCells[i].code) {
      oldCells[i].code = newCells[i].code;
      // update CSS <style> elements immediately
      if (oldCells[i].type === 'css' && oldCells[i]._styleEl) {
        oldCells[i]._styleEl.textContent = newCells[i].code;
      }
      dirtyIds.push(oldCells[i].id);
    }
  }
  if (dirtyIds.length) runDAG(dirtyIds);
}

function rebuildFromParsed(parsed) {
  // restore original cell els before tearing down
  restoreCellEls();

  // tear down existing cells
  while (S.cells.length) {
    const cell = S.cells[0];
    if (cell._invalidate) { cell._invalidate(); cell._invalidate = null; }
    if (cell._styleEl) { cell._styleEl.remove(); cell._styleEl = null; }
    const editor = getEditor(cell.id);
    if (editor) editor.destroy();
    cell.el.remove();
    S.cells.shift();
  }
  S.scope = {};

  // add new cells (addCell appends to #notebook which is hidden — that's fine)
  for (const c of parsed.cells) {
    const cell = addCell(c.type, c.code);
    if (c.collapsed || isCollapsed(c.code)) { cell.el.classList.add('collapsed'); cell.collapsed = true; }
  }

  // rebuild output panel
  const right = $('#splitRight');
  if (right) buildOutputPanel(right);

  runAll();
}

export function toggleSplitView() {
  if (S.splitView) {
    exitSplitView();
  } else {
    enterSplitView();
  }
}

// ── RESIZE HANDLE ──

function onResizeStart(e) {
  e.preventDefault();
  const container = $('#splitContainer');
  const left = $('#splitLeft');
  if (!container || !left) return;

  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'col-resize';

  const onMove = (e2) => {
    const rect = container.getBoundingClientRect();
    const x = e2.clientX - rect.left;
    const pct = Math.max(15, Math.min(85, (x / rect.width) * 100));
    left.style.flex = 'none';
    left.style.width = pct + '%';
  };

  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function enterSplitView() {
  S.splitView = true;
  S._splitSetCode = _updateSplitCell;
  applyEditorView('yes');
  document.body.classList.add('split-view');

  // serialize current cells to txt
  const txt = toTxt();

  // create split container
  const container = document.createElement('div');
  container.className = 'split-container';
  container.id = 'splitContainer';

  const left = document.createElement('div');
  left.className = 'split-left';
  left.id = 'splitLeft';

  const right = document.createElement('div');
  right.className = 'split-right';
  right.id = 'splitRight';

  // resize handle
  const handle = document.createElement('div');
  handle.className = 'split-handle';
  handle.addEventListener('mousedown', onResizeStart);

  container.appendChild(left);
  container.appendChild(handle);
  container.appendChild(right);

  // insert after toolbar / find bar, before notebook
  const nb = $('#notebook');
  nb.before(container);

  // build output panel (swaps cell.el references)
  buildOutputPanel(right);

  // create CM6 editor
  S.splitEditor = createSplitEditor(left, txt);

  // run cells to populate outputs (not forced — respects %manual)
  const ids = S.cells.filter(c => c.type === 'md' || (_ctIsExecutable(c.type) && !c._fallback)).map(c => c.id);
  if (ids.length) runDAG(ids);
}

function exitSplitView() {
  // final sync from editor
  if (S.splitEditor) {
    clearTimeout(_syncTimer);
    syncFromTxt(S.splitEditor.state.doc.toString());
  }

  // restore original cell els
  restoreCellEls();

  // destroy split editor — null ref first so debounced sync callbacks bail out
  if (S.splitEditor) {
    const ed = S.splitEditor;
    S.splitEditor = null;
    ed.destroy();
  }

  // remove split container
  const container = $('#splitContainer');
  if (container) container.remove();

  S.splitView = false;
  S._splitSetCode = null;
  applyEditorView('no');
  document.body.classList.remove('split-view');

  // sync cell editors with current code
  for (const cell of S.cells) {
    if (cell.type === 'md') {
      const ta = cell.el.querySelector('textarea');
      if (ta) ta.value = cell.code;
      renderMdCell(cell);
    } else if (cell.type === 'css') {
      const cssView = cell.el.querySelector('.cell-css-view');
      if (cssView) cssView.textContent = cssSummary(cell.code);
      if (cell._styleEl) cell._styleEl.textContent = cell.code;
    } else if (cell.type === 'html') {
      renderHtmlCell(cell);
    }
    // code cells: update CM6 editor
    const editor = getEditor(cell.id);
    if (editor) editor.setCode(cell.code);
  }

  // re-run to ensure outputs match
  runAll();
}
