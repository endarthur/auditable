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
  const statusbarHTML = document.querySelector('.statusbar').outerHTML;

  // read toolbar from live DOM and patch the title value
  const toolbarEl = document.querySelector('.toolbar').cloneNode(true);
  toolbarEl.querySelector('#docTitle').value = title;
  toolbarEl.querySelector('#toolbarStatus').textContent = '';
  // reset autorun button state
  const autoBtn = toolbarEl.querySelector('#autorunBtn');
  if (autoBtn) { autoBtn.className = 'autorun-on'; autoBtn.textContent = '\u25b6'; }
  // close overflow if open
  const overflow = toolbarEl.querySelector('.toolbar-overflow');
  if (overflow) overflow.classList.remove('open');
  const toolbarHTML = toolbarEl.outerHTML;

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

${toolbarHTML}

<button class="present-exit" onclick="togglePresent()">\u2715 exit</button>

<div class="notebook" id="notebook">
</div>

${statusbarHTML}

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
