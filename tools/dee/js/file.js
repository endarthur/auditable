// dee tool — file operations

async function pickFile(accept) {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    if (accept) input.accept = accept;
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });
}

async function openBlockCSV() {
  const file = await pickFile('.csv,.txt');
  if (!file) return;
  const text = await file.text();
  try {
    const result = parseBlockCSV(text);
    D3.columns = result.columns;
    D3.columnNames = result.columnNames;
    D3.fileName = file.name;
    D3.dirty = false;

    if (!D3.scene) initScene();
    loadBlockModel(result.gridDef, result.columns[result.columnNames[0]], result.columnNames[0]);
    startFPSCounter();
    buildSidebar();
  } catch (e) {
    alert('Error parsing CSV: ' + e.message);
  }
}

async function openDrillholeCSV() {
  const collarFile = await pickFile('.csv,.txt');
  if (!collarFile) return;
  const intervalFile = await pickFile('.csv,.txt');
  if (!intervalFile) return;
  try {
    const collarText = await collarFile.text();
    const intervalText = await intervalFile.text();
    const { holes } = parseDrillholeCSV(collarText, intervalText);
    loadDrillholes(holes);
  } catch (e) {
    alert('Error parsing drillhole CSV: ' + e.message);
  }
}

function newProject() {
  teardownScene();
  D3.gridDef = null;
  D3.columns = {};
  D3.columnNames = [];
  D3.activeColumn = null;
  D3.drillholes = [];
  D3.fileName = null;
  D3.cutoff = null;
  showSplash();
}

async function exportScreenshot() {
  if (!D3.scene) return;
  const blob = await D3.scene.screenshot();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (D3.fileName || 'dee') + '.png';
  a.click();
  URL.revokeObjectURL(url);
}
