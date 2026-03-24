const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const htmlPath = path.join(root, 'build', 'auditable.html');

// ── Build output tests ──

describe('auditable.html build output', () => {
  let html;

  before(() => {
    html = fs.readFileSync(htmlPath, 'utf8');
  });

  it('has auditable-app-css style tag', () => {
    assert.ok(html.includes('<style id="auditable-app-css">'));
  });

  it('has auditable-editor-css style tag', () => {
    assert.ok(html.includes('<style id="auditable-editor-css">'));
  });

  it('app-css tag has content', () => {
    const m = html.match(/<style id="auditable-app-css">([\s\S]*?)<\/style>/);
    assert.ok(m, 'app-css style tag not found');
    assert.ok(m[1].trim().length > 100, 'app-css content too short');
  });

  it('editor-css tag has content', () => {
    const m = html.match(/<style id="auditable-editor-css">([\s\S]*?)<\/style>/);
    assert.ok(m, 'editor-css style tag not found');
    assert.ok(m[1].trim().length > 100, 'editor-css content too short');
  });

  it('has non-empty __APP_RUNTIME__', () => {
    // The built output should have __APP_RUNTIME__ = `...actual code...`
    // (not the empty placeholder which would be: const __APP_RUNTIME__ = '';  on its own line)
    assert.match(html, /const __APP_RUNTIME__ = `\/\/ -- state\.js --/, 'APP_RUNTIME should start with state.js module');
  });

  it('app runtime contains expected module markers', () => {
    // The app runtime (embedded as template literal) should contain key modules
    const markers = ['-- state.js --', '-- stubs.js --', '-- dag.js --', '-- exec.js --', '-- init-app.js --'];
    for (const marker of markers) {
      assert.ok(html.includes(marker), `missing module marker: ${marker}`);
    }
  });

  it('has export dialog HTML', () => {
    assert.ok(html.includes('id="exportOverlay"'));
    assert.ok(html.includes('id="exportTitle"'));
    assert.ok(html.includes('id="exportBaseStyles"'));
  });

  it('has export app button in save tray', () => {
    assert.ok(html.includes('export app'));
    assert.ok(html.includes('showExportDialog'));
  });
});

// ── App runtime validity ──

describe('app runtime JS', () => {
  let appRuntime;

  before(() => {
    // Extract app runtime from build.js output
    const buildDir = path.join(root, 'src', 'app');
    const mainPath = path.join(buildDir, 'main.js');
    const mainSrc = fs.readFileSync(mainPath, 'utf8');

    // Collect all import paths from main.js
    const importPaths = [];
    for (const line of mainSrc.split('\n')) {
      const m = line.match(/^import\s+.*['"](\.\.?\/.+?)['"];?\s*(?:\/\/.*)?$/);
      if (m) importPaths.push(m[1]);
    }

    // Read and concatenate (simulating processModules)
    const chunks = [];
    for (const relPath of importPaths) {
      const filePath = path.join(buildDir, relPath);
      let src = fs.readFileSync(filePath, 'utf8');
      const basename = path.basename(relPath);
      src = src.replace(/^import\b[\s\S]*?from\s+['"][^'"]*['"];?\s*$/gm, '');
      src = src.replace(/^import\s+['"][^'"]*['"];?\s*$/gm, '');
      src = src.replace(/^export function /gm, 'function ');
      src = src.replace(/^export async function /gm, 'async function ');
      src = src.replace(/^export const /gm, 'const ');
      src = src.replace(/^export let /gm, 'let ');
      src = src.replace(/^export class /gm, 'class ');
      src = src.replace(/^export\s*\{[\s\S]*?\}\s*;?\s*$/gm, '');
      src = src.replace(/^export\s+default\s+.*$/gm, '');
      src = src.replace(/^\n+/, '').replace(/\n+$/, '');
      chunks.push(`// -- ${basename} --\n\n${src}`);
    }
    appRuntime = chunks.join('\n\n');
  });

  it('is syntactically valid JS', () => {
    // Wrap in a function to test syntax without executing
    // This will throw SyntaxError if the JS is invalid
    assert.doesNotThrow(() => {
      new Function(appRuntime);
    }, 'app runtime JS has syntax errors');
  });

  it('contains required symbols', () => {
    const requiredSymbols = [
      'function loadFromEmbed',
      'function addCell',
      'function createCellEl',
      'function execCell',
      'function runDAG',
      'function runAll',
      'function setMsg',
      'function updateStatus',
      'function applySettings',
      'function refreshTaggedLanguages',
      'function getEditor',
      'function createEditor',
      'function renderMd',
      'function parseNames',
      'function buildDAG',
      'function topoSort',
    ];
    for (const sym of requiredSymbols) {
      assert.ok(appRuntime.includes(sym), `missing required symbol: ${sym}`);
    }
  });

  it('includes all expected module files', () => {
    const expectedModules = [
      'state.js', 'stubs.js', 'stdlib.js', 'python.js', 'dag.js',
      'widgets.js', 'ui-app.js', 'save-app.js', 'cell-dom-app.js',
      'cell-ops-app.js', 'exec.js', 'markdown.js', 'settings-app.js',
      'globals-app.js', 'goto.js', 'init-app.js'
    ];
    for (const mod of expectedModules) {
      assert.ok(appRuntime.includes(`// -- ${mod} --`), `missing module: ${mod}`);
    }
  });

  it('does not include CM6 or editor modules', () => {
    // App runtime should NOT have full editor code
    assert.ok(!appRuntime.includes('// -- cm6.js --'), 'should not include cm6');
    assert.ok(!appRuntime.includes('// -- editor.js --'), 'should not include editor');
    assert.ok(!appRuntime.includes('// -- keyboard.js --'), 'should not include keyboard');
    assert.ok(!appRuntime.includes('// -- find.js --'), 'should not include find');
    assert.ok(!appRuntime.includes('// -- update.js --'), 'should not include update');
  });
});

// ── isBare directive (mirror of dag.js hasDirective logic) ──

describe('isBare', () => {
  // Replicate the hasDirective pattern from dag.js for CJS testing
  const isBare = code => /^\s*\/\/\s*%bare\b/m.test(code);

  it('detects // %bare at start', () => {
    assert.ok(isBare('// %bare\nconst x = 1;'));
  });

  it('detects with leading whitespace', () => {
    assert.ok(isBare('  // %bare'));
  });

  it('rejects without directive', () => {
    assert.ok(!isBare('const x = 1;'));
  });

  it('detects %bare on any line', () => {
    assert.ok(isBare('const x = 1;\n// %bare'));
  });

  it('rejects bare in variable names', () => {
    assert.ok(!isBare('const barefoot = true;'));
  });

  it('rejects bare without % prefix', () => {
    assert.ok(!isBare('// bare'));
  });

  it('isBare is exported from dag.js source', () => {
    const dagSrc = fs.readFileSync(path.join(root, 'src/js/dag.js'), 'utf8');
    // dag.js re-exports from dag-core.js — check it exports isBare
    assert.ok(dagSrc.includes('isBare'), 'isBare not exported from dag.js');
    // verify dag-core.js has the actual implementation
    const coreSrc = fs.readFileSync(path.join(root, 'src/js/dag-core.js'), 'utf8');
    assert.ok(coreSrc.includes("hasDirective(code, 'bare')"), 'isBare should use hasDirective in dag-core.js');
  });
});
