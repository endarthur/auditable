// @gcu/filterui — bidirectional AST↔widget editor for @gcu/expr expressions.
// Extracted from micro's filter drawer (the fd* family): the expression text
// stays the single source of truth; widgets are projections of AST clauses
// whose edits surgically rewrite source spans. Host-agnostic — micro and
// lamina drive it with their own metadata providers and apply callbacks.
export { flattenExpr, fmtNum, SpanSet, FLIP_OP, chainOf, leafSpec } from './core.js';
export { opSelect, addConditionRow, renderChain, renderLeaf } from './rows.js';
export { createFilterDrawer, injectStyles, FILTERUI_CSS } from './drawer.js';
