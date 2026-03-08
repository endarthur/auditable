// CM6 markdown editor for GCU Press

function initEditor(container) {
  const {
    EditorView, EditorState, Compartment, Transaction,
    keymap, lineNumbers, highlightActiveLine, highlightSpecialChars,
    drawSelection, history, undo: cm6Undo, redo: cm6Redo,
    bracketMatching, syntaxHighlighting, HighlightStyle,
    closeBrackets,
    indentWithTab, insertNewlineAndIndent,
    indentOnInput,
    tags,
    search, searchKeymap, highlightSelectionMatches,
  } = window.CM6;

  // GCU dark theme
  const theme = EditorView.theme({
    '&': { backgroundColor: 'var(--bg1)', color: 'var(--fg-bright)',
      fontSize: 'var(--editor-font-size)', fontFamily: 'var(--mono)', height: '100%' },
    '.cm-content': { caretColor: 'var(--fg-bright)', lineHeight: '1.6',
      padding: '12px 16px', fontFamily: 'var(--mono)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg-bright)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'rgba(200,155,60,0.25)' },
    '.cm-activeLine': { backgroundColor: 'rgba(200,155,60,0.05)' },
    '.cm-gutters': { backgroundColor: 'var(--bg1)', color: 'var(--fg-dim)',
      borderRight: '1px solid var(--border)', fontFamily: 'var(--mono)',
      fontSize: 'var(--editor-font-size)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(200,155,60,0.08)' },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 4px 0 8px' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { overflow: 'auto' },
    '.cm-line': { padding: '0' },
    '.cm-selectionMatch': { backgroundColor: 'rgba(200,155,60,0.15)' },
    '.cm-matchingBracket': { backgroundColor: 'rgba(200,155,60,0.3)', color: 'var(--accent) !important' },
  }, { dark: true });

  // Markdown-like highlight style
  const highlightStyle = HighlightStyle.define([
    { tag: tags.heading1, color: 'var(--accent)', fontWeight: 'bold', fontSize: '1.3em' },
    { tag: tags.heading2, color: 'var(--accent)', fontWeight: 'bold', fontSize: '1.15em' },
    { tag: tags.heading3, color: 'var(--accent)', fontWeight: 'bold' },
    { tag: tags.emphasis, fontStyle: 'italic', color: '#b8a080' },
    { tag: tags.strong, fontWeight: 'bold', color: '#ccc' },
    { tag: tags.link, color: '#7a9ec7', textDecoration: 'underline' },
    { tag: tags.url, color: '#7a9ec7' },
    { tag: tags.monospace, color: '#8cb878' },
    { tag: tags.processingInstruction, color: '#666' },
    { tag: tags.content, color: 'var(--fg-bright)' },
  ]);

  const extensions = [
    theme,
    syntaxHighlighting(highlightStyle),
    lineNumbers(),
    history(),
    bracketMatching(),
    closeBrackets(),
    indentOnInput(),
    highlightActiveLine(),
    highlightSpecialChars(),
    drawSelection(),
    EditorView.lineWrapping,
    search(),
    highlightSelectionMatches(),
    keymap.of(searchKeymap),
    keymap.of([indentWithTab]),
    keymap.of([{ key: 'Enter', run: insertNewlineAndIndent }]),
    keymap.of([{ key: 'Mod-z', run: cm6Undo }, { key: 'Mod-Shift-z', run: cm6Redo }]),
    keymap.of([{ key: 'Mod-s', run: () => { saveProject(); return true; } }]),
    EditorView.updateListener.of(update => {
      if (update.docChanged) {
        GP.source = update.view.state.doc.toString();
        GP.dirty = true;
        scheduleTypeset();
        updateStatus();
      }
    }),
    EditorView.updateListener.of(update => {
      if (update.selectionSet || update.docChanged) {
        const pos = update.view.state.selection.main.head;
        const line = update.view.state.doc.lineAt(pos);
        const cursor = $('#gp-status-cursor');
        if (cursor) cursor.textContent = `${line.number}:${pos - line.from + 1}`;
      }
    }),
  ];

  const state = EditorState.create({ doc: GP.source, extensions });
  const view = new EditorView({ state, parent: container });
  GP.editor = view;

  return view;
}

function setEditorSource(source) {
  if (!GP.editor) return;
  const { Transaction } = window.CM6;
  GP.editor.dispatch({
    changes: { from: 0, to: GP.editor.state.doc.length, insert: source },
    annotations: Transaction.addToHistory.of(false),
  });
}
