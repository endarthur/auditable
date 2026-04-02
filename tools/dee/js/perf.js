// dee tool — performance dashboard

function updatePerf() {
  const el = $('#d3-perf');
  if (!el) return;
  const p = D3.perf;
  el.textContent = `FPS: ${p.fps} | blocks: ${p.blocks.toLocaleString()} | tris: ${p.triangles.toLocaleString()} | mesh: ${p.meshTime.toFixed(0)}ms`;
}

function startFPSCounter() {
  let frames = 0, lastTime = performance.now();
  if (D3.scene) {
    D3.scene.onAfterRender(() => {
      frames++;
      const now = performance.now();
      if (now - lastTime >= 1000) {
        D3.perf.fps = frames;
        frames = 0;
        lastTime = now;
        updatePerf();
      }
    });
  }
}

function updateStatus() {
  const msg = $('#d3-status-msg');
  const blocks = $('#d3-status-blocks');
  const col = $('#d3-status-column');
  if (msg && D3.fileName) msg.textContent = D3.fileName;
  if (blocks && D3.gridDef) {
    const n = _grid.nBlocks(D3.gridDef);
    blocks.textContent = `${D3.gridDef.count.join('×')} = ${n.toLocaleString()} blocks`;
  }
  if (col && D3.activeColumn) col.textContent = D3.activeColumn;
}
