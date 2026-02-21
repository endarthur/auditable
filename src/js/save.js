import { S, $ } from './state.js';
import { addCell } from './cell-ops.js';
import { getSettings, applySettings } from './settings.js';
import { runAll } from './exec.js';
import { setMsg } from './ui.js';

// ── SAVE / LOAD ──

export function saveNotebook() {
  // serialize current state back to a self-contained HTML file
  const title = $('#docTitle').value || 'untitled';

  // collect cells as data
  const cellData = S.cells.map(c => ({
    type: c.type,
    code: c.code,
    collapsed: c.el.classList.contains('collapsed') || undefined
  }));

  // get the runtime and styles from current document
  const styleEl = document.querySelector('style');
  const styles = styleEl.textContent;

  // get the script
  const scriptEl = document.querySelector('script');
  const script = scriptEl.textContent;

  // read static elements from live DOM
  const helpHTML = $('#helpOverlay').outerHTML;
  const settingsOvHTML = $('#settingsOverlay').outerHTML;
  const settingsPanHTML = $('#settingsPanel').outerHTML.replace(/display:\s*block;?/, '');
  const statusAttr = document.querySelector('.status-attr').outerHTML;
  const actionBar = document.querySelector('.action-bar').outerHTML;

  // build output HTML
  let html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Auditable \u2014 ${esc(title)}</title>
<style>\n${styles}\n</style>
</head>
<body>

${helpHTML}

${settingsOvHTML}
${settingsPanHTML}

<div class="toolbar">
  <span class="toolbar-title">auditable</span>
  <span class="toolbar-sep"></span>
  <span class="toolbar-filename">
    <input type="text" id="docTitle" value="${esc(title)}" spellcheck="false">
  </span>
  <span class="toolbar-status" id="toolbarStatus"></span>
  <button class="toolbar-add" onclick="addCellWithUndo('code','',S.selectedId)">+ code</button>
  <button class="toolbar-add" onclick="addCellWithUndo('md','',S.selectedId)">+ md</button>
  <button class="toolbar-secondary" onclick="addCellWithUndo('css','',S.selectedId)">+ css</button>
  <button class="toolbar-secondary" onclick="addCellWithUndo('html','',S.selectedId)">+ html</button>
  <span class="toolbar-sep"></span>
  <span class="transport">
    <button onclick="runSelectedCell()" title="run cell + advance (Shift+Enter)">\u23f5</button>
    <button id="autorunBtn" class="autorun-on" onclick="toggleAutorun()" title="reactive mode \u2014 cells auto-run on edit">\u25b6</button>
    <button onclick="runAll()" title="run all cells">\u25b6\u25b6</button>
  </span>
  <span class="toolbar-right">
    <button class="accent" onclick="saveNotebook()">save</button>
    <div class="toolbar-overflow">
      <button onclick="toggleToolbarMenu()" title="more">\u22ef</button>
      <div class="toolbar-overflow-tray">
        <button onclick="newNotebook();toggleToolbarMenu()">new</button>
        <button onclick="collapseAll();toggleToolbarMenu()">collapse all</button>
        <button onclick="expandAll();toggleToolbarMenu()">expand all</button>
        <button onclick="$('#helpOverlay').classList.toggle('visible');toggleToolbarMenu()">help (F1)</button>
        <button onclick="toggleSettings();toggleToolbarMenu()">settings</button>
        <button onclick="togglePresent();toggleToolbarMenu()">present</button>
      </div>
    </div>
  </span>
</div>

<button class="present-exit" onclick="togglePresent()">\u2715 exit</button>

<div class="notebook" id="notebook">
</div>

<div class="statusbar">
  <span class="status-cells" id="statusCells">0 cells</span>
  <span class="status-msg" id="statusMsg"></span>
  ${statusAttr}
  ${actionBar}
</div>

${'<!--AUDITABLE-DATA\n' + JSON.stringify(cellData) + '\nAUDITABLE-DATA-->'}
${Object.keys(window._installedModules || {}).length ? '<!--AUDITABLE-MODULES\n' + JSON.stringify(window._installedModules) + '\nAUDITABLE-MODULES-->' : ''}
${'<!--AUDITABLE-SETTINGS\n' + JSON.stringify(getSettings()) + '\nAUDITABLE-SETTINGS-->'}

<script>\n${script}\n<\/script>
</body>
</html>`;

  // download
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = title.replace(/[^a-zA-Z0-9_-]/g, '_') + '.html';
  a.click();
  URL.revokeObjectURL(url);
  setMsg(`saved ${a.download}`, 'ok');
}

export function esc(s) {
  return s.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function loadFromEmbed() {
  // look for embedded cell data in HTML comments
  const raw = document.body.innerHTML;

  // restore installed modules first (before cells run)
  const modMatch = raw.match(/<!--AUDITABLE-MODULES\n([\s\S]*?)\nAUDITABLE-MODULES-->/);
  if (modMatch) {
    try {
      window._installedModules = JSON.parse(modMatch[1]);
    } catch (e) {
      console.error('Failed to parse installed modules:', e);
    }
  }

  // restore settings
  const setMatch = raw.match(/<!--AUDITABLE-SETTINGS\n([\s\S]*?)\nAUDITABLE-SETTINGS-->/);
  if (setMatch) {
    try {
      applySettings(JSON.parse(setMatch[1]));
    } catch (e) {
      console.error('Failed to parse settings:', e);
    }
  }

  const match = raw.match(/<!--AUDITABLE-DATA\n([\s\S]*?)\nAUDITABLE-DATA-->/);
  if (match) {
    try {
      const data = JSON.parse(match[1]);
      for (const c of data) {
        const cell = addCell(c.type, c.code);
        if (c.collapsed) cell.el.classList.add('collapsed');
      }
      // run after load
      if (S.cells.some(c => c.type === 'code')) {
        setTimeout(runAll, 50);
      }
      return true;
    } catch (e) {
      console.error('Failed to parse embedded data:', e);
    }
  }
  return false;
}
