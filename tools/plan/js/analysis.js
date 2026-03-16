// Analysis panels — Monte Carlo, sensitivity, EVM, health, compress

function showMCPanel() {
  const content = $('#pp-sidebar-content');
  if (!content) return;

  let html = '<div class="pp-analysis">'
    + '<h3>Monte Carlo Simulation</h3>'
    + '<div class="pp-analysis-controls">'
    + '<label>Iterations</label>'
    + '<input type="number" id="pp-mc-iter" value="5000" min="100" max="50000" step="1000">'
    + '<button class="pp-run-btn" id="pp-mc-run">Run</button>'
    + '</div>';

  // Deadline inputs
  html += '<div class="pp-calendar-section">Deadlines</div>';
  const deadlines = PP.deadlines || [];
  for (let i = 0; i < deadlines.length; i++) {
    const d = deadlines[i];
    const taskOpts = PP.tasks.filter(t => t.id).map(t =>
      '<option value="' + esc(t.id) + '"' + (d.taskId === t.id ? ' selected' : '') + '>' + esc(t.id) + '</option>'
    ).join('');
    html += '<div class="pp-deadline-row" data-di="' + i + '">'
      + '<input type="text" placeholder="Label" value="' + esc(d.label || '') + '" data-field="label" style="width:80px">'
      + '<select data-field="taskId"><option value="">Project</option>' + taskOpts + '</select>'
      + '<input type="date" value="' + esc(d.date || '') + '" data-field="date">'
      + '<button class="pp-blocked-rm" data-drm="' + i + '">\u00d7</button>'
      + '</div>';
  }
  html += '<button class="pp-btn-small" id="pp-add-deadline">+ add deadline</button>';

  // Results area
  html += '<div id="pp-mc-results"></div></div>';
  content.innerHTML = html;

  // Wire events
  $('#pp-mc-run').addEventListener('click', runMonteCarlo);
  $('#pp-add-deadline').addEventListener('click', () => {
    PP.deadlines.push({ label: '', taskId: '', date: '' });
    PP.dirty = true;
    showMCPanel();
  });

  for (const input of $$('.pp-deadline-row input, .pp-deadline-row select')) {
    input.addEventListener('change', e => {
      const row = e.target.closest('.pp-deadline-row');
      const di = parseInt(row.dataset.di);
      const field = e.target.dataset.field;
      PP.deadlines[di][field] = e.target.value;
      PP.dirty = true;
      updateTitle();
    });
  }

  for (const btn of $$('[data-drm]')) {
    btn.addEventListener('click', e => {
      PP.deadlines.splice(parseInt(e.target.dataset.drm), 1);
      PP.dirty = true;
      showMCPanel();
    });
  }

  // Show previous results if available
  if (PP.mcResult) renderMCResults();
}

function runMonteCarlo() {
  const tasks = buildPlanTasks();
  if (!tasks.length) {
    setStatus('msg', 'no tasks to simulate');
    return;
  }

  const iterInput = $('#pp-mc-iter');
  const iterations = parseInt(iterInput?.value) || 5000;

  _runMC(iterations);
}

// Top-level MC run — works without the sidebar panel open
function runMC(iterations) {
  const tasks = buildPlanTasks();
  if (!tasks.length) {
    setStatus('msg', 'no tasks to simulate');
    return;
  }
  _runMC(iterations || PP.mcIterations || 5000);
}

function _runMC(iterations) {
  const tasks = buildPlanTasks();
  setStatus('msg', 'running Monte Carlo...');
  PP.mcIterations = iterations;

  // Use setTimeout to let the UI update
  setTimeout(() => {
    try {
      PP.mcResult = monteCarlo(tasks, PP.calendar, PP.projectStart, {
        iterations,
        sensitivity: true,
        retainTaskEnds: true,
      });
      // Refresh sidebar results if open
      renderMCResults();
      // Refresh gantt to show percentile bands
      updateGantt();
      // Persist to IndexedDB
      if (PP.projectId) mcSave(PP.projectId, PP.mcResult);
      setStatus('msg', 'Monte Carlo complete (' + iterations + ' iterations)');
    } catch (e) {
      setStatus('msg', 'MC error: ' + e.message);
    }
  }, 10);
}

function renderMCResults() {
  const results = $('#pp-mc-results');
  if (!results || !PP.mcResult) return;

  const mc = PP.mcResult;
  let html = '<div class="pp-calendar-section">Project End Distribution</div>';

  // Percentile table
  html += '<table class="pp-percentile-table"><thead><tr><th>Percentile</th><th>Date</th></tr></thead><tbody>';
  const pe = mc.projectEnd;
  for (const [label, key] of [['P10', 'p10'], ['P50 (median)', 'p50'], ['P75', 'p75'], ['P90', 'p90'], ['Mean', 'mean']]) {
    const val = pe[key];
    const dateStr = val instanceof Date ? formatDate(val) : (typeof val === 'string' ? val.slice(0, 10) : String(val));
    html += '<tr><td>' + label + '</td><td>' + dateStr + '</td></tr>';
  }
  html += '</tbody></table>';

  // MC histogram plot
  try {
    const svg = monteCarloPlot(mc, { width: 400, height: 200, showPercentiles: true });
    html += '<div class="pp-svg-wrap" style="margin-top:12px">' + svg + '</div>';
  } catch (_) { /* ignore render errors */ }

  // Deadline risk
  const activeDeadlines = PP.deadlines.filter(d => d.date);
  if (activeDeadlines.length && mc.taskEndDates) {
    try {
      const deadlineObjs = activeDeadlines.map(d => ({
        label: d.label || d.taskId || 'Project',
        taskId: d.taskId || null,
        deadline: d.date,
      }));
      const svg = deadlineRiskPlot(mc, deadlineObjs, { width: 400, height: 200 });
      html += '<div class="pp-calendar-section">Deadline Risk</div>';
      html += '<div class="pp-svg-wrap">' + svg + '</div>';
    } catch (_) { /* ignore */ }
  }

  results.innerHTML = html;
}

function showSensitivityPanel() {
  const content = $('#pp-sidebar-content');
  if (!content) return;

  if (!PP.mcResult || !PP.mcResult.sensitivity) {
    content.innerHTML = '<div class="pp-analysis"><h3>Sensitivity Analysis</h3>'
      + '<p style="color:var(--fg-dim)">Run Monte Carlo first to see sensitivity data.</p>'
      + '<button class="pp-run-btn" id="pp-sens-run">Run Monte Carlo</button></div>';
    $('#pp-sens-run')?.addEventListener('click', () => {
      showSidebar('mc');
    });
    return;
  }

  let html = '<div class="pp-analysis"><h3>Tornado Plot</h3>';
  try {
    const svg = tornadoPlot(PP.mcResult.sensitivity, {
      width: Math.max($('#pp-sidebar-content').clientWidth - 32, 300),
      barHeight: 20,
      maxBars: 15,
    });
    html += '<div class="pp-svg-wrap">' + svg + '</div>';
  } catch (e) {
    html += '<p style="color:var(--err)">' + esc(e.message) + '</p>';
  }
  html += '</div>';
  content.innerHTML = html;
}

function showEVMPanel() {
  const content = $('#pp-sidebar-content');
  if (!content) return;

  if (!PP.scheduleResult) {
    content.innerHTML = '<div class="pp-analysis"><h3>Earned Value</h3><p style="color:var(--fg-dim)">No schedule available.</p></div>';
    return;
  }

  let html = '<div class="pp-analysis"><h3>Earned Value Management</h3>';

  try {
    const evmData = evm(PP.scheduleResult.scheduled);
    PP.evmResult = evmData;

    const metrics = [
      { label: 'PV', value: fmtNum(evmData.pv) },
      { label: 'EV', value: fmtNum(evmData.ev) },
      { label: 'AC', value: fmtNum(evmData.ac) },
      { label: 'BAC', value: fmtNum(evmData.bac) },
      { label: 'SPI', value: fmtNum(evmData.spi, 2), cls: evmData.spi >= 1 ? 'pp-good' : evmData.spi >= 0.9 ? 'pp-warn' : 'pp-bad' },
      { label: 'CPI', value: fmtNum(evmData.cpi, 2), cls: evmData.cpi >= 1 ? 'pp-good' : evmData.cpi >= 0.9 ? 'pp-warn' : 'pp-bad' },
      { label: 'EAC', value: fmtNum(evmData.eac) },
      { label: 'VAC', value: fmtNum(evmData.vac), cls: evmData.vac >= 0 ? 'pp-good' : 'pp-bad' },
    ];

    html += '<div class="pp-metrics-grid">';
    for (const m of metrics) {
      html += '<div class="pp-metric"><div class="pp-metric-label">' + m.label + '</div>'
        + '<div class="pp-metric-value ' + (m.cls || '') + '">' + m.value + '</div></div>';
    }
    html += '</div>';

    // S-curve
    try {
      const scurveData = scurve(PP.scheduleResult.scheduled, { bucket: 'week' });
      const svg = scurvePlot(scurveData, {
        width: Math.max($('#pp-sidebar-content').clientWidth - 32, 300),
        height: 200,
        showToday: true,
        showGrid: true,
      });
      html += '<div class="pp-calendar-section">S-Curve</div>';
      html += '<div class="pp-svg-wrap">' + svg + '</div>';
    } catch (_) { /* ignore */ }
  } catch (e) {
    html += '<p style="color:var(--err)">' + esc(e.message) + '</p>';
  }

  html += '</div>';
  content.innerHTML = html;
}

function showHealthPanel() {
  const content = $('#pp-sidebar-content');
  if (!content) return;

  if (!PP.scheduleResult) {
    content.innerHTML = '<div class="pp-analysis"><h3>Health</h3><p style="color:var(--fg-dim)">No schedule available.</p></div>';
    return;
  }

  let html = '<div class="pp-analysis"><h3>Project Health</h3>';

  try {
    const h = health(PP.scheduleResult, PP.evmResult);

    html += '<div class="pp-health-grid">';
    html += '<div class="pp-health-card pp-health-' + h.overall + '">'
      + '<div class="pp-health-indicator">' + healthIcon(h.overall) + '</div>'
      + '<div class="pp-health-name">Overall</div></div>';

    if (h.indicators) {
      for (const [name, data] of Object.entries(h.indicators)) {
        const color = typeof data === 'string' ? data : (data.status || 'green');
        html += '<div class="pp-health-card pp-health-' + color + '">'
          + '<div class="pp-health-indicator">' + healthIcon(color) + '</div>'
          + '<div class="pp-health-name">' + esc(name) + '</div></div>';
      }
    }
    html += '</div>';

    if (h.summary) {
      html += '<div style="margin-top:12px;color:var(--fg)">' + esc(h.summary) + '</div>';
    }
  } catch (e) {
    html += '<p style="color:var(--err)">' + esc(e.message) + '</p>';
  }

  html += '</div>';
  content.innerHTML = html;
}

function showCompressPanel() {
  const content = $('#pp-sidebar-content');
  if (!content) return;

  const tasks = buildPlanTasks();
  const pertTasks = tasks.filter(t => t.pert);

  if (!pertTasks.length) {
    content.innerHTML = '<div class="pp-analysis"><h3>Compress</h3><p style="color:var(--fg-dim)">Need tasks with PERT estimates (O/M/P).</p></div>';
    return;
  }

  let html = '<div class="pp-analysis"><h3>Schedule Compression</h3>'
    + '<div class="pp-analysis-controls">'
    + '<label>Budget (days)</label>'
    + '<input type="number" id="pp-compress-budget" value="" placeholder="auto">'
    + '<button class="pp-run-btn" id="pp-compress-run">Analyze</button>'
    + '</div>'
    + '<div id="pp-compress-results"></div></div>';

  content.innerHTML = html;

  $('#pp-compress-run').addEventListener('click', () => {
    const budgetInput = $('#pp-compress-budget');
    const budget = parseFloat(budgetInput?.value);

    try {
      const result = compress(pertTasks, isNaN(budget) ? undefined : budget);
      let rhtml = '<table class="pp-percentile-table"><thead><tr><th>Task</th><th>Original</th><th>Compressed</th><th>Surplus</th></tr></thead><tbody>';

      if (result.tasks) {
        for (const t of result.tasks) {
          rhtml += '<tr><td>' + esc(t.id || t.name || '?') + '</td>'
            + '<td class="pp-number">' + fmtNum(t.original, 1) + '</td>'
            + '<td class="pp-number">' + fmtNum(t.compressed, 1) + '</td>'
            + '<td class="pp-number">' + fmtNum(t.surplus, 1) + '</td></tr>';
        }
      }

      rhtml += '</tbody></table>';

      if (result.alpha != null) {
        rhtml += '<div style="margin-top:8px;color:var(--fg-dim)">Alpha: ' + fmtNum(result.alpha, 3)
          + ' | Feasible: ' + (result.feasible ? 'yes' : 'no') + '</div>';
      }

      $('#pp-compress-results').innerHTML = rhtml;
      setStatus('msg', 'compression analysis complete');
    } catch (e) {
      $('#pp-compress-results').innerHTML = '<p style="color:var(--err)">' + esc(e.message) + '</p>';
    }
  });
}

function showBurndownPanel() {
  const content = $('#pp-sidebar-content');
  if (!content) return;

  if (!PP.scheduleResult) {
    content.innerHTML = '<div class="pp-analysis"><h3>Burndown</h3><p style="color:var(--fg-dim)">No schedule available.</p></div>';
    return;
  }

  let html = '<div class="pp-analysis"><h3>Burndown Chart</h3>';

  try {
    const data = burndown(PP.scheduleResult.scheduled, { bucket: 'week' });
    const svg = burndownPlot(data, {
      width: Math.max($('#pp-sidebar-content').clientWidth - 32, 300),
      height: 200,
      showForecast: true,
    });
    html += '<div class="pp-svg-wrap">' + svg + '</div>';
  } catch (e) {
    html += '<p style="color:var(--err)">' + esc(e.message) + '</p>';
  }

  html += '</div>';
  content.innerHTML = html;
}

// Helpers

function healthIcon(color) {
  switch (color) {
    case 'green': return '\u25cf';
    case 'amber': return '\u25cf';
    case 'red': return '\u25cf';
    default: return '\u25cb';
  }
}

function fmtNum(n, decimals) {
  if (n == null || isNaN(n)) return '\u2014';
  return Number(n).toFixed(decimals != null ? decimals : 0);
}
