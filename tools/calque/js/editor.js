// CM6 editor setup for calque language

function initEditor(container) {
  const {
    EditorView, EditorState, Compartment,
    keymap, lineNumbers, highlightActiveLine, highlightSpecialChars,
    drawSelection, history, undo: cm6Undo, redo: cm6Redo,
    bracketMatching, syntaxHighlighting, HighlightStyle,
    autocompletion, closeBrackets, acceptCompletion,
    indentWithTab, insertNewlineAndIndent, toggleComment,
    indentOnInput,
    tags, StreamLanguage,
  } = window.CM6;

  // Token type → lezer Tag mapping
  const cqTokenTable = {
    kw:    tags.keyword,
    num:   tags.number,
    cmt:   tags.comment,
    fn:    tags.function(tags.variableName),
    op:    tags.operator,
    punc:  tags.punctuation,
    str:   tags.string,
    id:    tags.variableName,
    dir:   tags.keyword,
  };

  // Calque stream language from tokenizer
  const calqueLang = StreamLanguage.define({
    token(stream) {
      if (stream.sol()) {
        stream.lineTokens = tokenizeCalque(stream.string);
        stream.lineTokenIdx = 0;
      }
      const toks = stream.lineTokens;
      if (!toks || stream.lineTokenIdx >= toks.length) {
        stream.skipToEnd();
        return null;
      }
      const tok = toks[stream.lineTokenIdx];
      stream.lineTokenIdx++;
      if (tok.text.length > 0) stream.pos += tok.text.length;
      else stream.pos++;
      const type = tok.type;
      return (type && type in cqTokenTable) ? type : null;
    },
    tokenTable: cqTokenTable,
    startState() { return {}; },
    copyState() { return {}; },
  });

  // GCU theme
  const theme = EditorView.theme({
    '&': { backgroundColor: 'var(--bg1)', color: 'var(--fg-bright)',
      fontSize: 'var(--editor-font-size)', fontFamily: 'var(--mono)', height: '100%' },
    '.cm-content': { caretColor: 'var(--fg-bright)', lineHeight: '1.5',
      padding: '8px 10px', fontFamily: 'var(--mono)' },
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
    '.cm-nonmatchingBracket': { backgroundColor: 'rgba(170,50,50,0.3)' },
    '.cm-tooltip': { backgroundColor: 'var(--bg2)', border: '1px solid var(--border-hi)', color: 'var(--fg)' },
    '.cm-tooltip.cm-tooltip-autocomplete': {
      '& > ul': { fontFamily: 'var(--mono)', fontSize: 'var(--editor-font-size)' },
      '& > ul > li': { padding: '2px 8px' },
      '& > ul > li[aria-selected]': { backgroundColor: 'rgba(200,155,60,0.2)', color: 'var(--fg-bright)' },
    },
    '.cm-completionLabel': { color: 'var(--fg-bright)' },
    '.cm-completionDetail': { color: 'var(--fg-dim)', fontStyle: 'italic', marginLeft: '8px' },
    '.cm-completionMatchedText': { textDecoration: 'none', color: 'var(--accent)' },
  }, { dark: true });

  // Highlight style
  const highlightStyle = HighlightStyle.define([
    { tag: tags.keyword, color: '#7a9ec7' },
    { tag: tags.string, color: 'var(--accent)' },
    { tag: tags.number, color: '#8cb878' },
    { tag: tags.comment, color: '#555', fontStyle: 'italic' },
    { tag: tags.function(tags.variableName), color: '#c4a6d0' },
    { tag: tags.operator, color: '#888' },
    { tag: tags.punctuation, color: '#666' },
    { tag: tags.variableName, color: 'var(--fg-bright)' },
  ]);

  // Calque autocomplete
  function calqueComplete(context) {
    const word = context.matchBefore(/[\w@]*/);
    if (!word || word.from === word.to && !context.explicit) return null;
    const prefix = word.text;
    const items = calqueCompletions(context.state.doc.toString(), word.to, prefix);
    if (!items || items.length === 0) return null;
    return {
      from: word.from,
      options: items.map(it => ({
        label: it.text,
        type: it.kind === 'fn' ? 'function' : it.kind === 'kw' ? 'keyword' :
              it.kind === 'dir' ? 'keyword' : 'variable',
        detail: it.kind === 'fn' ? '()' : undefined,
      })),
    };
  }

  // Signature hint tooltip
  const sigHintPlugin = EditorView.updateListener.of(update => {
    if (!update.selectionSet && !update.docChanged) return;
    const cursor = update.view.state.selection.main.head;
    const doc = update.view.state.doc.toString();
    const hint = calqueSigHint(doc, cursor);
    const el = $('#cq-sig-hint');
    if (hint) {
      el.textContent = hint.sig + ' \u2014 ' + hint.desc;
      el.classList.add('visible');
    } else {
      el.classList.remove('visible');
    }
  });

  const extensions = [
    theme,
    syntaxHighlighting(highlightStyle),
    calqueLang,
    lineNumbers(),
    history(),
    bracketMatching(),
    closeBrackets(),
    indentOnInput(),
    highlightActiveLine(),
    highlightSpecialChars(),
    drawSelection(),
    EditorView.lineWrapping,
    autocompletion({ override: [calqueComplete] }),
    keymap.of([
      { key: 'Tab', run: acceptCompletion },
      indentWithTab,
    ]),
    keymap.of([{ key: 'Enter', run: insertNewlineAndIndent }]),
    keymap.of([{ key: 'Mod-/', run: toggleComment }]),
    keymap.of([{ key: 'Mod-z', run: cm6Undo }, { key: 'Mod-Shift-z', run: cm6Redo }]),
    keymap.of([{ key: 'Mod-s', run: () => { saveFile(); return true; } }]),
    sigHintPlugin,
    EditorView.updateListener.of(update => {
      if (update.docChanged) {
        const src = update.view.state.doc.toString();
        onSourceChange(src);
        // Update cursor pos in status bar
        const pos = update.view.state.selection.main.head;
        const line = update.view.state.doc.lineAt(pos);
        setStatus('cursor', `${line.number}:${pos - line.from + 1}`);
      }
    }),
    EditorView.updateListener.of(update => {
      if (update.selectionSet) {
        const pos = update.view.state.selection.main.head;
        const line = update.view.state.doc.lineAt(pos);
        setStatus('cursor', `${line.number}:${pos - line.from + 1}`);
      }
    }),
  ];

  const state = EditorState.create({ doc: CQ.source, extensions });
  const view = new EditorView({ state, parent: container });
  CQ.editorView = view;
  CQ.undo = () => cm6Undo(view);
  CQ.redo = () => cm6Redo(view);

  return view;
}

function setEditorSource(source) {
  if (!CQ.editorView) return;
  CQ.editorView.dispatch({
    changes: { from: 0, to: CQ.editorView.state.doc.length, insert: source },
  });
}
