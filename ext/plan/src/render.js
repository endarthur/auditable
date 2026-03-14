// SVG renderers — all produce SVG strings

import { _fmtDate, _parseDate, getBlockedDays } from './calendar.js';
import { effectiveDuration } from './pert.js';

// ── SVG helpers ──

function _esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function _svg(w, h, content) { return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="font-family:monospace;font-size:11px">${content}</svg>`; }
function _rect(x, y, w, h, fill, extra = '') { return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" ${extra}/>`; }
function _line(x1, y1, x2, y2, stroke, extra = '') { return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" ${extra}/>`; }
function _text(x, y, str, fill = '#bbb', extra = '') { return `<text x="${x}" y="${y}" fill="${fill}" ${extra}>${_esc(str)}</text>`; }
function _path(d, stroke, fill = 'none', extra = '') { return `<path d="${d}" stroke="${stroke}" fill="${fill}" ${extra}/>`; }

// ── Default theme ──

const GCU = {
  bg: '#111',
  grid: '#222',
  text: '#bbb',
  textDim: '#666',
  normal: '#4A90D9',
  critical: '#B87333',
  milestone: '#2D8B6F',
  complete: '#6BBF6B',
  planned: '#4A90D9',
  actual: '#B87333',
  forecast: '#B87333',
  baseline: '#888',
  pending: '#333',
  active: '#B87333',
  blocked: '#D94040',
};

// ── Gantt Chart ──

function gantt(scheduleResult, options = {}) {
  const {
    width = 1200,
    rowHeight = 28,
    showCritical = true,
    showFloat = false,
    showDependencies = true,
    showProgress = true,
    showToday = true,
    showResources = true,
    showGroups = true,
    labelWidth = 200,
  } = options;
  const colors = { ...GCU, ...(options.barColors || {}) };

  const tasks = scheduleResult.scheduled;
  if (tasks.length === 0) return _svg(width, 40, _text(10, 25, 'No tasks', colors.textDim));

  // Group tasks
  let rows = [];
  if (showGroups) {
    const groups = new Map();
    for (const t of tasks) {
      const g = t.group || '';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(t);
    }
    for (const [group, groupTasks] of groups) {
      if (group) rows.push({ type: 'group', label: group });
      for (const t of groupTasks) rows.push({ type: 'task', task: t });
    }
  } else {
    rows = tasks.map(t => ({ type: 'task', task: t }));
  }

  // Date range
  let minDate = tasks[0].earlyStart, maxDate = tasks[0].earlyFinish;
  for (const t of tasks) {
    if (t.earlyStart < minDate) minDate = t.earlyStart;
    if (t.earlyFinish > maxDate) maxDate = t.earlyFinish;
    if (showFloat && t.lateFinish > maxDate) maxDate = t.lateFinish;
  }

  const headerHeight = 30;
  const height = headerHeight + rows.length * rowHeight + 10;
  const chartWidth = width - labelWidth - 20;
  const chartLeft = labelWidth + 10;

  const timeSpan = maxDate - minDate || 1;
  const dateToX = (d) => chartLeft + ((d - minDate) / timeSpan) * chartWidth;

  let svg = '';

  // Background
  svg += _rect(0, 0, width, height, colors.bg);

  // Timeline header — month labels
  const d = new Date(minDate);
  d.setDate(1);
  while (d <= maxDate) {
    const x = dateToX(d);
    const label = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()] + ' ' + d.getFullYear();
    if (x >= chartLeft) {
      svg += _line(x, headerHeight, x, height, colors.grid, 'stroke-dasharray="2,4"');
      svg += _text(x + 4, 20, label, colors.textDim, 'font-size="10"');
    }
    d.setMonth(d.getMonth() + 1);
  }

  // Today line
  if (showToday) {
    const todayX = dateToX(new Date());
    if (todayX >= chartLeft && todayX <= chartLeft + chartWidth) {
      svg += _line(todayX, headerHeight, todayX, height, '#c89b3c', 'stroke-width="1" stroke-dasharray="4,2"');
    }
  }

  // Rows
  for (let i = 0; i < rows.length; i++) {
    const y = headerHeight + i * rowHeight;
    const row = rows[i];

    if (row.type === 'group') {
      svg += _rect(0, y, width, rowHeight, '#181818');
      svg += _text(8, y + rowHeight * 0.7, row.label, colors.textDim, 'font-weight="bold" font-size="11"');
      continue;
    }

    const t = row.task;
    const isMilestone = t.milestone || effectiveDuration(t) === 0;

    // Alternating row bg
    if (i % 2 === 0) svg += _rect(0, y, width, rowHeight, '#151515');

    // Label
    const label = t.name || t.id;
    svg += _text(8, y + rowHeight * 0.7, label.length > 28 ? label.substring(0, 26) + '\u2026' : label, colors.text, 'font-size="11"');

    // Resource
    if (showResources && t.resource) {
      svg += _text(labelWidth - 4, y + rowHeight * 0.7, t.resource, colors.textDim, 'font-size="10" text-anchor="end"');
    }

    if (isMilestone) {
      // Diamond
      const mx = dateToX(t.earlyStart);
      const my = y + rowHeight / 2;
      const s = 6;
      svg += _path(`M${mx} ${my-s} L${mx+s} ${my} L${mx} ${my+s} L${mx-s} ${my} Z`, 'none', colors.milestone);
    } else {
      // Bar
      const x1 = dateToX(t.earlyStart);
      const x2 = dateToX(t.earlyFinish);
      const barH = rowHeight * 0.55;
      const barY = y + (rowHeight - barH) / 2;
      const barW = Math.max(2, x2 - x1);
      const barColor = (showCritical && t.isCritical) ? colors.critical : colors.normal;

      svg += _rect(x1, barY, barW, barH, barColor, 'rx="2"');

      // Progress fill
      if (showProgress && t.progress > 0) {
        const pw = barW * Math.min(1, t.progress);
        svg += _rect(x1, barY, pw, barH, colors.complete, 'rx="2" opacity="0.6"');
      }

      // Float line
      if (showFloat && t.lateFinish && t.lateFinish > t.earlyFinish) {
        const fx = dateToX(t.lateFinish);
        const floatY = y + rowHeight / 2;
        svg += _line(x2, floatY, fx, floatY, colors.textDim, 'stroke-width="1" stroke-dasharray="2,2"');
      }
    }
  }

  // Dependency arrows
  if (showDependencies) {
    const rowIdx = new Map();
    let ri = 0;
    for (const row of rows) {
      if (row.type === 'task') rowIdx.set(row.task.id, ri);
      ri++;
    }

    for (const row of rows) {
      if (row.type !== 'task' || !row.task.depends) continue;
      const t = row.task;
      for (const dep of t.depends) {
        const fromRow = rowIdx.get(dep);
        const toRow = rowIdx.get(t.id);
        if (fromRow == null || toRow == null) continue;

        const fromTask = tasks.find(tt => tt.id === dep);
        if (!fromTask) continue;

        const x1 = dateToX(fromTask.earlyFinish);
        const y1 = headerHeight + fromRow * rowHeight + rowHeight / 2;
        const x2 = dateToX(t.earlyStart);
        const y2 = headerHeight + toRow * rowHeight + rowHeight / 2;

        const stub = 6;
        let d;
        if (x2 - x1 > stub * 2) {
          // Gap available — L-elbow with vertical in the gap
          const mx = x1 + stub;
          d = `M${x1} ${y1} L${mx} ${y1} L${mx} ${y2} L${x2} ${y2}`;
        } else {
          // Tight — vertical drop from finish, short horizontal to start
          d = `M${x1} ${y1} L${x1} ${y2} L${x2} ${y2}`;
        }
        svg += _path(d, colors.textDim, 'none', 'stroke-width="1" opacity="0.5"');
        // Arrowhead at bar start
        svg += _path(
          `M${x2 - 5} ${y2 - 3} L${x2} ${y2} L${x2 - 5} ${y2 + 3}`,
          colors.textDim, 'none', 'stroke-width="1" opacity="0.5"'
        );
      }
    }
  }

  return _svg(width, height, svg);
}

// ── S-Curve Plot ──

function scurvePlot(scurveData, options = {}) {
  const {
    width = 800,
    height = 400,
    showBaseline = true,
    showForecast = true,
    showToday = true,
    showGrid = true,
  } = options;
  const colors = { ...GCU, ...(options.lineColors || {}) };

  const { labels, planned, actual, total, forecast, baseline } = scurveData;
  if (!labels || labels.length === 0) return _svg(width, height, _text(10, 25, 'No data', colors.textDim));

  const pad = { top: 30, right: 40, bottom: 60, left: 60 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const maxY = total || Math.max(...planned, ...(actual || []), ...(baseline || []), ...(forecast || []));

  const xScale = (i) => pad.left + (i / (labels.length - 1 || 1)) * plotW;
  const yScale = (v) => pad.top + plotH - (v / (maxY || 1)) * plotH;

  let svg = '';
  svg += _rect(0, 0, width, height, colors.bg);

  // Grid
  if (showGrid) {
    for (let i = 0; i <= 4; i++) {
      const y = yScale(maxY * i / 4);
      svg += _line(pad.left, y, pad.left + plotW, y, colors.grid);
      svg += _text(pad.left - 8, y + 4, String(Math.round(maxY * i / 4)), colors.textDim, 'text-anchor="end" font-size="10"');
    }
  }

  // X-axis labels
  const step = Math.max(1, Math.floor(labels.length / 8));
  for (let i = 0; i < labels.length; i += step) {
    const x = xScale(i);
    svg += _text(x, height - pad.bottom + 20, labels[i], colors.textDim, 'text-anchor="middle" font-size="10"');
  }

  // Lines
  function polyline(data, color, dash = '') {
    if (!data || data.length === 0) return '';
    const points = data.map((v, i) => `${xScale(i)},${yScale(v || 0)}`).join(' ');
    return `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" ${dash}/>`;
  }

  if (showBaseline && baseline) svg += polyline(baseline, colors.baseline, 'stroke-dasharray="4,4"');
  svg += polyline(planned, colors.planned);
  svg += polyline(actual, colors.actual);
  if (showForecast && forecast) svg += polyline(forecast, colors.forecast, 'stroke-dasharray="6,3"');

  // Legend
  const legendY = 15;
  svg += _rect(pad.left + 10, legendY - 8, 12, 3, colors.planned);
  svg += _text(pad.left + 26, legendY, 'planned', colors.textDim, 'font-size="10"');
  svg += _rect(pad.left + 90, legendY - 8, 12, 3, colors.actual);
  svg += _text(pad.left + 106, legendY, 'actual', colors.textDim, 'font-size="10"');
  if (showBaseline && baseline) {
    svg += _rect(pad.left + 160, legendY - 8, 12, 3, colors.baseline);
    svg += _text(pad.left + 176, legendY, 'baseline', colors.textDim, 'font-size="10"');
  }

  // Axes
  svg += _line(pad.left, pad.top, pad.left, pad.top + plotH, colors.text);
  svg += _line(pad.left, pad.top + plotH, pad.left + plotW, pad.top + plotH, colors.text);

  return _svg(width, height, svg);
}

// ── Resource Histogram ──

function resourceHistogram(scheduledTasks, options = {}) {
  const {
    width = 800,
    height = 300,
    bucket = 'week',
  } = options;
  const colors = { ...GCU };

  // Group tasks by resource and bucket
  const tasks = scheduledTasks.filter(t => t.resource);
  if (tasks.length === 0) return _svg(width, height, _text(10, 25, 'No resource data', colors.textDim));

  let minDate = tasks[0].earlyStart, maxDate = tasks[0].earlyFinish;
  for (const t of tasks) {
    if (t.earlyStart < minDate) minDate = t.earlyStart;
    if (t.earlyFinish > maxDate) maxDate = t.earlyFinish;
  }

  // Generate weekly buckets
  const buckets = [];
  const d = new Date(minDate);
  const bucketDays = bucket === 'month' ? 30 : bucket === 'day' ? 1 : 7;
  while (d <= maxDate) {
    buckets.push(new Date(d));
    d.setDate(d.getDate() + bucketDays);
  }
  if (buckets.length === 0) return _svg(width, height, _text(10, 25, 'No data', colors.textDim));

  // Count tasks per resource per bucket
  const resources = [...new Set(tasks.map(t => t.resource))].sort();
  const resColors = {};
  const palette = ['#4A90D9', '#B87333', '#2D8B6F', '#D9534F', '#8E6BBF', '#6BBF6B', '#D9A534'];
  resources.forEach((r, i) => resColors[r] = palette[i % palette.length]);

  const data = buckets.map(() => ({}));
  for (const t of tasks) {
    for (let bi = 0; bi < buckets.length; bi++) {
      const bStart = buckets[bi];
      const bEnd = new Date(bStart.getTime() + bucketDays * 86400000);
      if (t.earlyStart < bEnd && t.earlyFinish > bStart) {
        if (!data[bi][t.resource]) data[bi][t.resource] = 0;
        data[bi][t.resource]++;
      }
    }
  }

  const maxCount = Math.max(1, ...data.map(d => Object.values(d).reduce((s, v) => s + v, 0)));

  const pad = { top: 30, right: 20, bottom: 50, left: 40 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const barW = Math.max(2, plotW / buckets.length - 2);

  let svg = '';
  svg += _rect(0, 0, width, height, colors.bg);

  // Bars
  for (let bi = 0; bi < buckets.length; bi++) {
    const x = pad.left + (bi / buckets.length) * plotW;
    let yOff = 0;
    for (const res of resources) {
      const count = data[bi][res] || 0;
      if (count > 0) {
        const barH = (count / maxCount) * plotH;
        svg += _rect(x, pad.top + plotH - yOff - barH, barW, barH, resColors[res], 'opacity="0.8"');
        yOff += barH;
      }
    }
  }

  // X-axis labels
  const step = Math.max(1, Math.floor(buckets.length / 8));
  for (let i = 0; i < buckets.length; i += step) {
    const x = pad.left + (i / buckets.length) * plotW;
    svg += _text(x, height - pad.bottom + 15, _fmtDate(buckets[i]), colors.textDim, 'font-size="9" text-anchor="middle"');
  }

  // Y-axis
  svg += _line(pad.left, pad.top, pad.left, pad.top + plotH, colors.text);
  svg += _line(pad.left, pad.top + plotH, pad.left + plotW, pad.top + plotH, colors.text);

  // Legend
  let lx = pad.left + 10;
  for (const res of resources) {
    svg += _rect(lx, 12, 10, 10, resColors[res]);
    svg += _text(lx + 14, 21, res, colors.textDim, 'font-size="10"');
    lx += res.length * 7 + 24;
  }

  return _svg(width, height, svg);
}

// ── Stage-Gate Matrix ──

function stageGateView(stageGateData, options = {}) {
  const {
    width = 1000,
    cellSize = 32,
    showProgress = true,
  } = options;
  const statusColors = {
    complete: '#6BBF6B',
    active: '#B87333',
    pending: '#333',
    blocked: '#D94040',
    ...((options.colors) || {}),
  };

  const { stages, instances, bottleneck } = stageGateData;
  const labelW = 160;
  const headerH = 40;
  const h = headerH + instances.length * (cellSize + 4) + 10;

  let svg = '';
  svg += _rect(0, 0, width, h, GCU.bg);

  // Column headers
  for (let si = 0; si < stages.length; si++) {
    const x = labelW + si * (cellSize + 4);
    const isBottleneck = bottleneck && bottleneck.stage === stages[si];
    svg += _text(x + cellSize / 2, 15, stages[si], isBottleneck ? '#c89b3c' : GCU.textDim,
      'text-anchor="middle" font-size="9" transform="rotate(-30,' + (x + cellSize/2) + ',15)"');
  }

  // Rows
  for (let ri = 0; ri < instances.length; ri++) {
    const inst = instances[ri];
    const y = headerH + ri * (cellSize + 4);

    // Label
    svg += _text(4, y + cellSize * 0.65, inst.name.length > 20 ? inst.name.substring(0, 18) + '\u2026' : inst.name,
      GCU.text, 'font-size="11"');

    // Stage cells
    for (let si = 0; si < stages.length; si++) {
      const x = labelW + si * (cellSize + 4);
      const s = inst.stages[stages[si]];
      if (!s) continue;

      svg += _rect(x, y, cellSize, cellSize, statusColors[s.status] || statusColors.pending, 'rx="3" opacity="0.7"');

      // Progress fill overlay
      if (showProgress && s.progress > 0 && s.progress < 1) {
        svg += _rect(x, y + cellSize * (1 - s.progress), cellSize, cellSize * s.progress,
          statusColors[s.status], 'rx="3" opacity="0.4"');
      }
    }
  }

  return _svg(width, h, svg);
}

// ── Workflow Flowchart ──

function workflowDiagram(workflow, options = {}) {
  const {
    direction = 'LR',
    showProbabilities = true,
    showDurations = true,
  } = options;

  const stages = workflow.stages;
  const nodeW = 120, nodeH = 40, gap = 60;
  const isLR = direction === 'LR';
  const totalW = isLR ? stages.length * (nodeW + gap) - gap + 40 : nodeW + 80;
  const totalH = isLR ? nodeH + 120 : stages.length * (nodeH + gap) - gap + 40;

  let svg = '';
  svg += _rect(0, 0, totalW, totalH, GCU.bg);

  const positions = {};

  // Nodes
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i];
    const x = isLR ? 20 + i * (nodeW + gap) : 40;
    const y = isLR ? 40 : 20 + i * (nodeH + gap);
    positions[s.id] = { x: x + nodeW / 2, y: y + nodeH / 2 };

    svg += _rect(x, y, nodeW, nodeH, '#222', 'rx="6" stroke="#444" stroke-width="1"');
    svg += _text(x + nodeW / 2, y + nodeH / 2 + 4, s.name || s.id, GCU.text, 'text-anchor="middle" font-size="10"');

    if (showDurations && s.duration) {
      svg += _text(x + nodeW / 2, y + nodeH + 14, `${s.duration}d`, GCU.textDim, 'text-anchor="middle" font-size="9"');
    }
  }

  // Transitions
  for (const tr of workflow.transitions) {
    const from = positions[tr.from];
    const to = positions[tr.to];
    if (!from || !to) continue;

    const isRework = tr.probability != null;
    const stroke = isRework ? '#D94040' : GCU.textDim;
    const dash = isRework ? 'stroke-dasharray="4,3"' : '';

    if (isLR) {
      if (isRework && to.x < from.x) {
        // Backward arc (rework)
        const arcY = Math.max(from.y, to.y) + 40;
        svg += _path(`M${from.x} ${from.y + nodeH/2} L${from.x} ${arcY} L${to.x} ${arcY} L${to.x} ${to.y + nodeH/2}`,
          stroke, 'none', `stroke-width="1" ${dash}`);
      } else {
        svg += _line(from.x + nodeW/2, from.y, to.x - nodeW/2, to.y, stroke, `stroke-width="1" ${dash}`);
      }
    } else {
      svg += _line(from.x, from.y + nodeH/2, to.x, to.y - nodeH/2, stroke, `stroke-width="1" ${dash}`);
    }

    if (showProbabilities && tr.probability != null) {
      const mx = (from.x + to.x) / 2;
      const my = isRework && isLR ? Math.max(from.y, to.y) + 50 : (from.y + to.y) / 2 - 8;
      svg += _text(mx, my, `${(tr.probability * 100).toFixed(0)}%`, '#D94040', 'text-anchor="middle" font-size="9"');
      if (tr.label) {
        svg += _text(mx, my + 12, tr.label, '#D94040', 'text-anchor="middle" font-size="8"');
      }
    }
  }

  return _svg(totalW, totalH, svg);
}

// ── Monte Carlo Histogram ──

function monteCarloPlot(monteCarloResult, options = {}) {
  const {
    width = 800,
    height = 400,
    showPercentiles = [10, 50, 75, 90],
    showTarget,
    targetLabel = 'Deadline',
  } = options;

  const { histogram, projectEnd } = monteCarloResult;
  const { bins, counts } = histogram;

  const pad = { top: 30, right: 40, bottom: 50, left: 60 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const maxCount = Math.max(1, ...counts);
  const barW = Math.max(2, plotW / counts.length - 1);

  let svg = '';
  svg += _rect(0, 0, width, height, GCU.bg);

  // Bars
  for (let i = 0; i < counts.length; i++) {
    const x = pad.left + (i / counts.length) * plotW;
    const barH = (counts[i] / maxCount) * plotH;
    svg += _rect(x, pad.top + plotH - barH, barW, barH, GCU.normal, 'opacity="0.7"');
  }

  // Percentile lines
  const pColors = { 10: '#6BBF6B', 50: '#B87333', 75: '#D9A534', 90: '#D94040' };
  for (const p of showPercentiles) {
    const key = `p${p}`;
    const date = projectEnd[key];
    if (!date) continue;
    const x = pad.left + ((date - bins[0]) / (bins[bins.length - 1] - bins[0] || 1)) * plotW;
    const color = pColors[p] || '#888';
    svg += _line(x, pad.top, x, pad.top + plotH, color, 'stroke-width="2" stroke-dasharray="4,3"');
    svg += _text(x, pad.top - 5, `P${p}: ${_fmtDate(date)}`, color, 'text-anchor="middle" font-size="10"');
  }

  // Target deadline
  if (showTarget) {
    const td = _parseDate(showTarget);
    const x = pad.left + ((td - bins[0]) / (bins[bins.length - 1] - bins[0] || 1)) * plotW;
    svg += _line(x, pad.top, x, pad.top + plotH, '#c89b3c', 'stroke-width="2"');
    svg += _text(x, pad.top + plotH + 15, targetLabel, '#c89b3c', 'text-anchor="middle" font-size="10"');
  }

  // X-axis labels
  const step = Math.max(1, Math.floor(bins.length / 6));
  for (let i = 0; i < bins.length; i += step) {
    const x = pad.left + (i / (bins.length - 1)) * plotW;
    svg += _text(x, height - pad.bottom + 15, _fmtDate(bins[i]), GCU.textDim, 'text-anchor="middle" font-size="9"');
  }

  // Axes
  svg += _line(pad.left, pad.top, pad.left, pad.top + plotH, GCU.text);
  svg += _line(pad.left, pad.top + plotH, pad.left + plotW, pad.top + plotH, GCU.text);

  return _svg(width, height, svg);
}

// ── Tornado Plot (Sensitivity) ──

function tornadoPlot(sensitivityData, options = {}) {
  const {
    width = 600,
    barHeight = 22,
    maxBars = 15,
  } = options;

  if (!sensitivityData || sensitivityData.length === 0) {
    return _svg(width, 40, _text(10, 25, 'No sensitivity data', GCU.textDim));
  }

  const data = sensitivityData.slice(0, maxBars);
  const labelW = 140;
  const scaleW = 60;
  const pad = { top: 30, bottom: 20 };
  const chartW = width - labelW - scaleW;
  const centerX = labelW + chartW / 2;
  const height = pad.top + data.length * barHeight + pad.bottom;

  let svg = '';
  svg += _rect(0, 0, width, height, GCU.bg);

  // Scale labels
  svg += _text(labelW, pad.top - 8, '-1.0', GCU.textDim, 'font-size="9" text-anchor="start"');
  svg += _text(centerX, pad.top - 8, '0', GCU.textDim, 'font-size="9" text-anchor="middle"');
  svg += _text(labelW + chartW, pad.top - 8, '1.0', GCU.textDim, 'font-size="9" text-anchor="end"');

  // Center axis
  svg += _line(centerX, pad.top, centerX, pad.top + data.length * barHeight, GCU.grid);

  for (let i = 0; i < data.length; i++) {
    const d = data[i];
    const y = pad.top + i * barHeight;
    const barW = Math.abs(d.correlation) * (chartW / 2);
    const color = d.correlation >= 0 ? GCU.critical : GCU.normal;

    // Label
    const label = (d.name || d.id);
    svg += _text(labelW - 6, y + barHeight * 0.7, label.length > 18 ? label.substring(0, 16) + '\u2026' : label,
      GCU.text, 'text-anchor="end" font-size="10"');

    // Bar
    if (d.correlation >= 0) {
      svg += _rect(centerX, y + 3, barW, barHeight - 6, color, 'opacity="0.8" rx="2"');
    } else {
      svg += _rect(centerX - barW, y + 3, barW, barHeight - 6, color, 'opacity="0.8" rx="2"');
    }

    // Value label
    svg += _text(labelW + chartW + 4, y + barHeight * 0.7, d.correlation.toFixed(2),
      GCU.textDim, 'font-size="9"');
  }

  return _svg(width, height, svg);
}

// ── Burndown Plot ──

function burndownPlot(burndownData, options = {}) {
  const {
    width = 800,
    height = 400,
    showForecast = true,
  } = options;

  const { labels, ideal, actual, forecast, totalWork } = burndownData;
  if (!labels || labels.length === 0) return _svg(width, height, _text(10, 25, 'No data', GCU.textDim));

  const pad = { top: 30, right: 40, bottom: 60, left: 60 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const maxY = totalWork || Math.max(...ideal, ...(actual || []).filter(v => v != null), ...(forecast || []).filter(v => v != null));
  const xScale = (i) => pad.left + (i / (labels.length - 1 || 1)) * plotW;
  const yScale = (v) => pad.top + plotH - (v / (maxY || 1)) * plotH; // 0 at bottom, totalWork at top

  let svg = '';
  svg += _rect(0, 0, width, height, GCU.bg);

  // Grid
  for (let i = 0; i <= 4; i++) {
    const val = maxY * i / 4;
    const y = yScale(val);
    svg += _line(pad.left, y, pad.left + plotW, y, GCU.grid);
    svg += _text(pad.left - 8, y + 4, String(Math.round(val)), GCU.textDim, 'text-anchor="end" font-size="10"');
  }

  // X-axis labels
  const step = Math.max(1, Math.floor(labels.length / 8));
  for (let i = 0; i < labels.length; i += step) {
    svg += _text(xScale(i), height - pad.bottom + 20, labels[i], GCU.textDim, 'text-anchor="middle" font-size="9"');
  }

  // Polyline helper
  function polyline(data, color, dash = '') {
    if (!data || data.length === 0) return '';
    const pts = [];
    for (let i = 0; i < data.length; i++) {
      if (data[i] != null) pts.push(`${xScale(i)},${yScale(data[i])}`);
    }
    if (pts.length === 0) return '';
    return `<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="2" ${dash}/>`;
  }

  // Ideal: dashed gray
  svg += polyline(ideal, GCU.baseline, 'stroke-dasharray="4,4"');
  // Actual: solid amber
  svg += polyline(actual, GCU.actual);
  // Forecast: dashed amber
  if (showForecast && forecast) svg += polyline(forecast, GCU.forecast, 'stroke-dasharray="6,3"');

  // Legend
  const ly = 15;
  svg += _rect(pad.left + 10, ly - 8, 12, 3, GCU.baseline);
  svg += _text(pad.left + 26, ly, 'ideal', GCU.textDim, 'font-size="10"');
  svg += _rect(pad.left + 70, ly - 8, 12, 3, GCU.actual);
  svg += _text(pad.left + 86, ly, 'actual', GCU.textDim, 'font-size="10"');
  if (showForecast) {
    svg += _rect(pad.left + 140, ly - 8, 12, 3, GCU.forecast);
    svg += _text(pad.left + 156, ly, 'forecast', GCU.textDim, 'font-size="10"');
  }

  // Axes
  svg += _line(pad.left, pad.top, pad.left, pad.top + plotH, GCU.text);
  svg += _line(pad.left, pad.top + plotH, pad.left + plotW, pad.top + plotH, GCU.text);

  return _svg(width, height, svg);
}

export {
  gantt, scurvePlot, resourceHistogram, stageGateView, workflowDiagram, monteCarloPlot,
  tornadoPlot, burndownPlot,
};
