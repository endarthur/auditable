// Global state for Calque Editor

const $ = (s, p) => (p || document).querySelector(s);
const $$ = (s, p) => [...(p || document).querySelectorAll(s)];

const CQ = {
  source: '',
  result: null,
  error: null,
  dirty: false,
  fileHandle: null,
  fileName: null,
  activeSheet: null,
  sheets: [],
  editorView: null,
  evalTimer: null,
  importData: null,
  menuOpen: null,
};

const STARTER = `Sales {
  name = ["Alice", "Bob", "Carol", "Diana"]
  revenue = [42000, 38000, 55000, 61000]
  tax = revenue * 0.15
  net = revenue - tax
}

Summary {
  total_revenue = sum(Sales.revenue)
  total_tax = sum(Sales.tax)
  total_net = sum(Sales.net)
  headcount = count(Sales.name)
}`;
