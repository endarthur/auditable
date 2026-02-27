const fs = require('fs');
const vm = require('vm');

const sandbox = vm.createContext({
  self: {},
  navigator: { userAgent: '' },
  document: {
    querySelector: () => null, querySelectorAll: () => [],
    createElement: () => ({ style: {}, classList: { add(){}, remove(){} }, appendChild(){}, remove(){}, addEventListener(){}, setAttribute(){}, getAttribute(){ return null; }, getBoundingClientRect(){ return {top:0,left:0,bottom:0,right:0,width:0,height:0}; } }),
    createTextNode: () => ({}),
    body: { appendChild(){}, style: {} },
    documentElement: { style: {} },
    createRange: () => ({ setEnd(){}, setStart(){}, getBoundingClientRect(){ return {top:0,left:0,bottom:0,right:0,width:0,height:0}; }, getClientRects(){ return []; }, commonAncestorContainer: { nodeName: 'BODY', ownerDocument: {} } }),
    activeElement: null, addEventListener(){},
  },
  MutationObserver: class { observe(){} disconnect(){} },
  ResizeObserver: class { observe(){} disconnect(){} },
  IntersectionObserver: class { observe(){} disconnect(){} },
  requestAnimationFrame: (cb) => setTimeout(cb, 0),
  cancelAnimationFrame: () => {},
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  matchMedia: () => ({ matches: false, addEventListener(){} }),
  console, setTimeout, clearTimeout,
  setInterval: () => 0, clearInterval: () => {},
  CustomEvent: class {},
  queueMicrotask: (fn) => Promise.resolve().then(fn),
});
sandbox.self = sandbox;
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const src = fs.readFileSync('ext/cm6/cm6.min.js', 'utf8');
vm.runInContext(src, sandbox);

const CM6 = sandbox.CM6;
const keys = Object.keys(CM6).sort();
console.log('ALL CM6 exports (' + keys.length + '):');
keys.forEach(k => console.log('  ' + k + ':', typeof CM6[k]));
