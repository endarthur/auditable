// CM6 rollup entry — exports all symbols needed by auditable
// bundled as IIFE exposing window.CM6

export {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightSpecialChars,
  ViewPlugin,
  Decoration,
  WidgetType,
  ViewUpdate,
  drawSelection,
} from '@codemirror/view';

export {
  EditorState,
  Compartment,
  StateEffect,
  StateField,
} from '@codemirror/state';

export {
  minimalSetup,
} from 'codemirror';

export {
  javascript,
} from '@codemirror/lang-javascript';

export {
  css,
} from '@codemirror/lang-css';

export {
  html,
} from '@codemirror/lang-html';

export {
  indentWithTab,
  toggleComment,
  history,
  undo,
  redo,
} from '@codemirror/commands';

export {
  bracketMatching,
  syntaxTree,
  syntaxHighlighting,
  HighlightStyle,
  indentOnInput,
} from '@codemirror/language';

export {
  closeBrackets,
} from '@codemirror/autocomplete';

export {
  autocompletion,
  CompletionContext,
} from '@codemirror/autocomplete';

export {
  tags,
} from '@lezer/highlight';
