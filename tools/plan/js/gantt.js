// Interactive Gantt chart — frozen labels + scrollable timeline

const GANTT = {
  pxPerDay: 18,
  rowH: 28,
  headerH: 44,
  labelW: parseInt(localStorage.getItem('pp-gantt-labelW')) || 220,
  minPx: 4,
  maxPx: 60,
  bufferDays: 30,
  groupH: 22,
};

// Group color palette — muted tones that work on dark background
const GROUP_COLORS = [
  '#4A90D9', '#2D8B6F', '#B87333', '#8E6BBF',
  '#6BBF6B', '#D9A534', '#D94070', '#1ABC9C',
  '#E67E22', '#7B68EE',
];

function buildGroupColorMap(rows) {
  const map = {};
  let ci = 0;
  for (const r of rows) {
    if (r.type !== 'task' || !r.group) continue;
    const top = r.group.split('/')[0].trim();
    if (top && !(top in map)) {
      map[top] = GROUP_COLORS[ci % GROUP_COLORS.length];
      ci++;
    }
  }
  return map;
}

// ── Build display rows from schedule result ──

function ganttRows(result) {
  const scheduled = result.scheduled;
  const collapsed = PP.ui.collapsedGroups;

  // Group tasks by their group field, preserving first-seen order
  const groupOrder = [];
  const groupMap = {};
  for (const s of scheduled) {
    const g = s.group || '';
    if (!(g in groupMap)) {
      groupMap[g] = [];
      groupOrder.push(g);
    }
    groupMap[g].push(s);
  }

  // Sort groups so that shared prefixes are adjacent
  // (e.g. "Deposit A/Exploration" before "Deposit A/Estimation")
  groupOrder.sort();

  // Build rows with hierarchical group headers
  const rows = [];
  let activePath = [];

  for (const g of groupOrder) {
    const newPath = g ? g.split('/').map(p => p.trim()) : [];

    // Emit group headers for new path segments
    if (g !== activePath.join('/')) {
      let common = 0;
      while (common < activePath.length && common < newPath.length && activePath[common] === newPath[common]) {
        common++;
      }

      for (let d = common; d < newPath.length; d++) {
        const fullPath = newPath.slice(0, d + 1).join('/');
        const parentPath = d > 0 ? newPath.slice(0, d).join('/') : null;
        if (parentPath && isGroupHidden(parentPath, collapsed)) continue;
        rows.push({
          type: 'group',
          label: newPath[d],
          path: fullPath,
          depth: d,
          collapsed: collapsed.has(fullPath),
        });
      }
      activePath = newPath;
    }

    // Skip tasks if any ancestor group is collapsed
    if (g && isGroupHidden(g, collapsed)) continue;

    for (const s of groupMap[g]) {
      const srcTask = PP.tasks.find(t => t.id === s.id);
      rows.push({
        type: 'task',
        id: s.id,
        label: s.name || s.id,
        start: s.earlyStart,
        end: s.earlyFinish,
        lateEnd: s.lateFinish,
        isCritical: s.isCritical,
        totalFloat: s.totalFloat || 0,
        progress: s.progress || 0,
        resource: s.resource,
        depends: s.depends || [],
        milestone: s.milestone,
        group: s.group,
        linked: srcTask ? isLinkedTask(srcTask) : false,
      });
    }
  }
  return rows;
}

// Check if a group path (or any of its ancestors) is collapsed
function collapseAllGroups() {
  if (!PP.scheduleResult) return;
  const rows = ganttRows(PP.scheduleResult);
  for (const r of rows) {
    if (r.type === 'group') PP.ui.collapsedGroups.add(r.path);
  }
  showGanttPanel();
}

function expandAllGroups() {
  PP.ui.collapsedGroups.clear();
  showGanttPanel();
}

function isGroupHidden(groupPath, collapsed) {
  if (!groupPath) return false;
  const parts = groupPath.split('/');
  for (let i = 1; i <= parts.length; i++) {
    if (collapsed.has(parts.slice(0, i).join('/'))) return true;
  }
  return false;
}

// ── Date helpers ──

function daysBetween(a, b) {
  return (b - a) / 86400000;
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function startOfDay(d) {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

// ── Render ──

function updateGantt() {
  showGanttPanel();
}

function showGanttPanel() {
  const content = $('#pp-main');
  if (!content) return;

  // Clear only gantt-related elements (preserve floating window)
  const old = content.querySelectorAll('.pp-gantt-container, .pp-gantt-zoom, .pp-gantt-empty');
  for (const el of old) el.remove();

  if (!PP.scheduleResult || !PP.scheduleResult.scheduled.length) {
    const msg = document.createElement('div');
    msg.className = 'pp-gantt-empty';
    msg.style.cssText = 'color:var(--fg-dim);padding:20px;text-align:center';
    msg.textContent = 'No schedule to display. Add tasks with IDs and durations.';
    content.appendChild(msg);
    return;
  }

  const result = PP.scheduleResult;
  const rows = ganttRows(result);
  const groupColors = buildGroupColorMap(rows);

  // Compute timeline bounds
  const projStart = startOfDay(new Date(PP.projectStart));
  let earliest = projStart;
  let latest = projStart;
  for (const r of rows) {
    if (r.type !== 'task') continue;
    const s = startOfDay(new Date(r.start));
    const e = startOfDay(new Date(r.end));
    if (s < earliest) earliest = s;
    if (e > latest) latest = e;
    if (r.lateEnd) {
      const le = startOfDay(new Date(r.lateEnd));
      if (le > latest) latest = le;
    }
  }

  // Extend bounds to include MC P90 dates if available
  if (PP.mcResult && PP.mcResult.taskEnd) {
    for (const id in PP.mcResult.taskEnd) {
      const p90 = PP.mcResult.taskEnd[id].p90;
      if (p90) {
        const d = startOfDay(new Date(p90));
        if (d > latest) latest = d;
      }
    }
  }

  // Content span (for "fit" zoom) and generous buffer (for scrolling)
  const timeStart = addDays(earliest, -7);
  const contentDays = Math.ceil(daysBetween(timeStart, latest)) + 14;
  // Buffer: enough extra days that you can't reach the end
  // At any zoom, guarantee 10 screen-widths of scroll past content
  const screenDays = Math.ceil(window.innerWidth / GANTT.pxPerDay);
  const totalDays = contentDays + Math.max(730, screenDays * 10);

  // Build DOM structure

  const container = document.createElement('div');
  container.className = 'pp-gantt-container';

  // ── Labels pane (frozen left) ──
  const labelPane = document.createElement('div');
  labelPane.className = 'pp-gantt-labels';
  labelPane.style.width = GANTT.labelW + 'px';

  // Label header spacer + resize handle
  const labelHeader = document.createElement('div');
  labelHeader.className = 'pp-gantt-label-header';
  labelHeader.style.height = GANTT.headerH + 'px';

  const labelTitle = document.createElement('span');
  labelTitle.textContent = 'Task';
  labelHeader.appendChild(labelTitle);

  const labelResizeHandle = document.createElement('div');
  labelResizeHandle.className = 'pp-gantt-label-resize';
  labelHeader.appendChild(labelResizeHandle);

  // Drag to resize label column
  let lrDragging = false, lrStartX = 0, lrStartW = 0;
  labelResizeHandle.addEventListener('mousedown', e => {
    e.preventDefault();
    e.stopPropagation();
    lrDragging = true;
    lrStartX = e.clientX;
    lrStartW = GANTT.labelW;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', e => {
    if (!lrDragging) return;
    const newW = Math.max(80, lrStartW + e.clientX - lrStartX);
    GANTT.labelW = newW;
    labelPane.style.width = newW + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!lrDragging) return;
    lrDragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem('pp-gantt-labelW', GANTT.labelW);
  });

  // Double-click to auto-fit label width
  labelResizeHandle.addEventListener('dblclick', e => {
    e.preventDefault();
    e.stopPropagation();
    // Measure max text width
    const measurer = document.createElement('span');
    measurer.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font-size:12px;font-family:inherit;padding:0 8px';
    document.body.appendChild(measurer);
    let maxW = 60;
    for (const r of rows) {
      const text = r.type === 'group'
        ? '\u25bc ' + r.label
        : (r.linked ? '\u25cf ' : '') + r.label;
      const indent = r.type === 'group' ? (r.depth || 0) * 12 + 8 : 0;
      measurer.textContent = text;
      const w = measurer.offsetWidth + indent + 16; // padding
      if (w > maxW) maxW = w;
    }
    document.body.removeChild(measurer);
    GANTT.labelW = Math.min(maxW, 500);
    labelPane.style.width = GANTT.labelW + 'px';
    localStorage.setItem('pp-gantt-labelW', GANTT.labelW);
  });

  labelPane.appendChild(labelHeader);

  const labelBody = document.createElement('div');
  labelBody.className = 'pp-gantt-label-body';

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const div = document.createElement('div');
    if (r.type === 'group') {
      div.className = 'pp-gantt-group-label';
      if (r.collapsed) div.classList.add('pp-gantt-group-collapsed');
      div.style.height = GANTT.groupH + 'px';
      div.style.lineHeight = GANTT.groupH + 'px';
      const indent = (r.depth || 0) * 12;
      div.style.paddingLeft = (8 + indent) + 'px';
      div.innerHTML = '<span class="pp-gantt-group-arrow">' + (r.collapsed ? '\u25b6' : '\u25bc') + '</span> ' + esc(r.label);
      // Color top-level group headers
      const topGroup = r.path ? r.path.split('/')[0].trim() : '';
      if (topGroup && groupColors[topGroup]) div.style.color = groupColors[topGroup];
      div.style.cursor = 'pointer';
      const groupPath = r.path;
      div.addEventListener('click', () => {
        if (PP.ui.collapsedGroups.has(groupPath)) PP.ui.collapsedGroups.delete(groupPath);
        else PP.ui.collapsedGroups.add(groupPath);
        showGanttPanel();
      });
    } else {
      div.className = 'pp-gantt-task-label';
      if (r.isCritical) div.classList.add('pp-gantt-critical-label');
      if (r.linked) div.classList.add('pp-gantt-linked-label');
      div.style.height = GANTT.rowH + 'px';
      div.style.lineHeight = GANTT.rowH + 'px';
      if (r.linked) {
        div.innerHTML = '<span class="pp-link-indicator">\u25cf</span>' + esc(r.label);
      } else {
        div.textContent = r.label;
      }
      div.title = r.id + (r.resource ? ' [' + r.resource + ']' : '') + (r.linked ? ' (linked)' : '');
      div.dataset.taskId = r.id;
      div.addEventListener('click', () => selectTaskInGrid(r.id));
    }
    labelBody.appendChild(div);
  }
  labelBody.style.top = GANTT.headerH + 'px';
  labelPane.appendChild(labelBody);

  // ── Timeline pane (scrollable) ──
  const timePane = document.createElement('div');
  timePane.className = 'pp-gantt-timeline';

  const timelineWidth = Math.max(totalDays * GANTT.pxPerDay, 400);

  // Time header — spans full width so it never ends abruptly
  const header = buildTimeHeader(timeStart, totalDays, timelineWidth);
  timePane.appendChild(header);

  // Timeline body
  const body = document.createElement('div');
  body.className = 'pp-gantt-body';
  body.style.width = timelineWidth + 'px';

  // Today line
  const today = startOfDay(new Date());
  if (today >= timeStart && today <= addDays(timeStart, totalDays)) {
    const todayX = daysBetween(timeStart, today) * GANTT.pxPerDay;
    const todayLine = document.createElement('div');
    todayLine.className = 'pp-gantt-today';
    todayLine.style.left = todayX + 'px';
    body.appendChild(todayLine);
  }

  // Deadline lines
  if (PP.deadlines && PP.deadlines.length) {
    for (const dl of PP.deadlines) {
      if (!dl.date) continue;
      const dlDate = startOfDay(new Date(dl.date));
      const dlX = daysBetween(timeStart, dlDate) * GANTT.pxPerDay;
      if (dlX < 0) continue;

      const line = document.createElement('div');
      line.className = 'pp-gantt-deadline';
      line.style.left = dlX + 'px';
      body.appendChild(line);

      const label = document.createElement('div');
      label.className = 'pp-gantt-deadline-label';
      label.style.left = (dlX + 3) + 'px';
      label.textContent = dl.label || formatDate(dlDate);
      body.appendChild(label);
    }
  }

  // Non-working day columns (weekends + holidays + blocked)
  const nonWorkOverlay = buildNonWorkingOverlay(timeStart, totalDays);
  if (nonWorkOverlay) body.appendChild(nonWorkOverlay);

  // Task id→row-index map (for dependency arrows)
  const taskRowMap = {};
  let rowY = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].type === 'group') {
      rowY += GANTT.groupH;
    } else {
      taskRowMap[rows[i].id] = { y: rowY, h: GANTT.rowH, row: rows[i] };
      rowY += GANTT.rowH;
    }
  }

  // Render rows
  let y = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.type === 'group') {
      // Group header row (subtle background)
      const groupRow = document.createElement('div');
      groupRow.className = 'pp-gantt-group-row';
      groupRow.style.top = y + 'px';
      groupRow.style.height = GANTT.groupH + 'px';
      groupRow.style.width = timelineWidth + 'px';
      body.appendChild(groupRow);
      y += GANTT.groupH;
      continue;
    }

    // Task row background (alternating subtle stripe)
    const rowBg = document.createElement('div');
    rowBg.className = 'pp-gantt-row' + (i % 2 === 0 ? ' pp-gantt-row-even' : '');
    rowBg.style.top = y + 'px';
    rowBg.style.height = GANTT.rowH + 'px';
    rowBg.style.width = timelineWidth + 'px';
    rowBg.dataset.taskId = r.id;
    rowBg.addEventListener('click', () => selectTaskInGrid(r.id));
    body.appendChild(rowBg);

    // Baseline ghost bar
    if (PP.baseline) {
      const bl = PP.baseline[r.id];
      if (bl && !r.milestone) {
        const blStart = startOfDay(new Date(bl.start));
        const blEnd = startOfDay(new Date(bl.end));
        const blX = daysBetween(timeStart, blStart) * GANTT.pxPerDay;
        const blW = Math.max(daysBetween(blStart, blEnd) * GANTT.pxPerDay, 3);
        const ghost = document.createElement('div');
        ghost.className = 'pp-gantt-baseline';
        ghost.style.left = blX + 'px';
        ghost.style.top = (y + GANTT.rowH - 6) + 'px';
        ghost.style.width = blW + 'px';
        ghost.style.height = '3px';
        ghost.title = 'Baseline: ' + formatDate(blStart) + ' \u2013 ' + formatDate(blEnd);
        body.appendChild(ghost);
      }
    }

    // Bar
    const startDate = startOfDay(new Date(r.start));
    const endDate = startOfDay(new Date(r.end));
    const barX = daysBetween(timeStart, startDate) * GANTT.pxPerDay;
    const barW = Math.max(daysBetween(startDate, endDate) * GANTT.pxPerDay, 3);

    if (r.milestone) {
      // Diamond marker
      const diamond = document.createElement('div');
      diamond.className = 'pp-gantt-milestone';
      diamond.style.left = (barX - 6) + 'px';
      diamond.style.top = (y + GANTT.rowH / 2 - 6) + 'px';
      body.appendChild(diamond);
    } else {
      const bar = document.createElement('div');
      bar.className = 'pp-gantt-bar' + (r.isCritical ? ' pp-gantt-bar-critical' : '') + (r.linked ? ' pp-gantt-bar-linked' : '');
      // Color by top-level group
      const topGroup = r.group ? r.group.split('/')[0].trim() : '';
      if (topGroup && groupColors[topGroup]) {
        bar.style.background = groupColors[topGroup];
      }
      bar.style.left = barX + 'px';
      bar.style.top = (y + 4) + 'px';
      bar.style.width = barW + 'px';
      bar.style.height = (GANTT.rowH - 8) + 'px';
      bar.title = r.label + ' (' + formatDate(startDate) + ' \u2013 ' + formatDate(endDate) + ')';
      bar.dataset.taskId = r.id;
      bar.addEventListener('click', e => { e.stopPropagation(); selectTaskInGrid(r.id); });
      body.appendChild(bar);

      // Progress fill
      if (r.progress > 0) {
        const prog = document.createElement('div');
        prog.className = 'pp-gantt-progress';
        prog.style.width = Math.min(r.progress * 100, 100) + '%';
        bar.appendChild(prog);
      }

      // Float indicator (dashed extension)
      if (PP.ui.showFloat && r.totalFloat > 0 && !r.isCritical) {
        const floatW = r.totalFloat * GANTT.pxPerDay;
        const floatBar = document.createElement('div');
        floatBar.className = 'pp-gantt-float';
        floatBar.style.left = (barX + barW) + 'px';
        floatBar.style.top = (y + GANTT.rowH / 2 - 1) + 'px';
        floatBar.style.width = floatW + 'px';
        body.appendChild(floatBar);
      }

      // MC percentile tails — use taskEnd summary stats (absolute dates)
      // The deterministic bar uses ceil-rounded PERT expected durations, so
      // it can exceed MC P50/P75. We position tails absolutely on the timeline
      // and only render the portion that extends past the deterministic bar end.
      if (PP.mcResult && PP.mcResult.taskEnd && PP.mcResult.taskEnd[r.id]) {
        const te = PP.mcResult.taskEnd[r.id];
        const barEnd = barX + barW;

        // P90 outer tail
        if (te.p90) {
          const p90d = startOfDay(new Date(te.p90));
          const p90X = daysBetween(timeStart, p90d) * GANTT.pxPerDay;
          const tailStart = Math.max(barEnd, daysBetween(timeStart, endDate) * GANTT.pxPerDay);
          const outerW = p90X - tailStart;
          if (outerW > 2) {
            const outer = document.createElement('div');
            outer.className = 'pp-gantt-mc-tail' + (r.isCritical ? ' pp-gantt-mc-tail-critical' : '');
            outer.style.left = tailStart + 'px';
            outer.style.top = (y + 4) + 'px';
            outer.style.width = outerW + 'px';
            outer.style.height = (GANTT.rowH - 8) + 'px';
            outer.title = 'P90: ' + formatDate(p90d);
            body.appendChild(outer);
          }
        }

        // P75 inner tail
        if (te.p75) {
          const p75d = startOfDay(new Date(te.p75));
          const p75X = daysBetween(timeStart, p75d) * GANTT.pxPerDay;
          const tailStart = Math.max(barEnd, daysBetween(timeStart, endDate) * GANTT.pxPerDay);
          const innerW = p75X - tailStart;
          if (innerW > 2) {
            const inner = document.createElement('div');
            inner.className = 'pp-gantt-mc-tail pp-gantt-mc-tail-inner' + (r.isCritical ? ' pp-gantt-mc-tail-critical' : '');
            inner.style.left = tailStart + 'px';
            inner.style.top = (y + 4) + 'px';
            inner.style.width = innerW + 'px';
            inner.style.height = (GANTT.rowH - 8) + 'px';
            inner.title = 'P75: ' + formatDate(p75d);
            body.appendChild(inner);
          }
        }
      }
    }

    y += GANTT.rowH;
  }

  // Dependency arrows (SVG overlay)
  const arrowSvg = buildDependencyArrows(rows, taskRowMap, timeStart);
  if (arrowSvg) body.appendChild(arrowSvg);

  // Set total body height
  body.style.height = y + 'px';

  timePane.appendChild(body);

  // ── Assemble ──
  container.appendChild(labelPane);
  container.appendChild(timePane);

  // Insert before the task window (if present), so gantt is behind it
  const taskWin = $('#pp-task-window');
  if (taskWin) content.insertBefore(container, taskWin);
  else content.appendChild(container);

  // ── Zoom controls ──
  const zoomBar = document.createElement('div');
  zoomBar.className = 'pp-gantt-zoom';
  zoomBar.innerHTML = '<button class="pp-btn-small" id="pp-gantt-zout">\u2212</button>'
    + '<span id="pp-gantt-zlabel">' + GANTT.pxPerDay + 'px/day</span>'
    + '<button class="pp-btn-small" id="pp-gantt-zin">+</button>'
    + '<button class="pp-btn-small" id="pp-gantt-zfit">fit</button>';
  if (taskWin) content.insertBefore(zoomBar, taskWin);
  else content.appendChild(zoomBar);

  // Wire zoom
  $('#pp-gantt-zin').addEventListener('click', () => { ganttZoom(GANTT.pxPerDay + 4); });
  $('#pp-gantt-zout').addEventListener('click', () => { ganttZoom(GANTT.pxPerDay - 4); });
  $('#pp-gantt-zfit').addEventListener('click', () => {
    const avail = timePane.clientWidth - 20;
    const fitPx = Math.max(GANTT.minPx, Math.floor(avail / contentDays));
    ganttZoom(fitPx);
  });

  // Mouse wheel zoom on timeline
  timePane.addEventListener('wheel', e => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -2 : 2;
      ganttZoom(GANTT.pxPerDay + delta);
    }
  }, { passive: false });

  // Sync vertical scroll
  timePane.addEventListener('scroll', () => {
    labelBody.style.transform = 'translateY(' + (-timePane.scrollTop) + 'px)';
  });
}

function ganttZoom(newPx) {
  GANTT.pxPerDay = Math.max(GANTT.minPx, Math.min(GANTT.maxPx, newPx));
  showGanttPanel();
}

// ── Time header (month + day ticks) ──

function buildTimeHeader(timeStart, totalDays, width) {
  const header = document.createElement('div');
  header.className = 'pp-gantt-header';
  header.style.width = width + 'px';
  header.style.height = GANTT.headerH + 'px';

  // Month row
  const monthRow = document.createElement('div');
  monthRow.className = 'pp-gantt-month-row';

  // Day row
  const dayRow = document.createElement('div');
  dayRow.className = 'pp-gantt-day-row';

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let lastMonth = -1;
  let monthStartX = 0;

  // Determine tick interval based on zoom
  let tickInterval = 1;
  if (GANTT.pxPerDay < 8) tickInterval = 7;
  else if (GANTT.pxPerDay < 14) tickInterval = 7;
  else if (GANTT.pxPerDay < 20) tickInterval = 2;

  for (let d = 0; d < totalDays; d++) {
    const date = addDays(timeStart, d);
    const month = date.getMonth();
    const year = date.getFullYear();

    // Month labels
    if (month !== lastMonth) {
      if (lastMonth !== -1) {
        // Close previous month
        const label = document.createElement('div');
        label.className = 'pp-gantt-month';
        label.style.left = monthStartX + 'px';
        label.style.width = (d * GANTT.pxPerDay - monthStartX) + 'px';
        label.textContent = MONTHS[lastMonth] + ' ' + addDays(timeStart, d - 1).getFullYear();
        monthRow.appendChild(label);
      }
      monthStartX = d * GANTT.pxPerDay;
      lastMonth = month;
    }

    // Day ticks — snap to Mondays when showing weekly ticks
    const showTick = tickInterval >= 7
      ? date.getDay() === 1   // Monday
      : d % tickInterval === 0;
    if (showTick) {
      const tick = document.createElement('div');
      tick.className = 'pp-gantt-day-tick';
      tick.style.left = (d * GANTT.pxPerDay) + 'px';
      tick.style.width = (tickInterval * GANTT.pxPerDay) + 'px';
      tick.textContent = date.getDate();
      dayRow.appendChild(tick);
    }
  }

  // Final month label
  if (lastMonth !== -1) {
    const label = document.createElement('div');
    label.className = 'pp-gantt-month';
    label.style.left = monthStartX + 'px';
    label.style.width = (totalDays * GANTT.pxPerDay - monthStartX) + 'px';
    label.textContent = MONTHS[lastMonth] + ' ' + addDays(timeStart, totalDays - 1).getFullYear();
    monthRow.appendChild(label);
  }

  header.appendChild(monthRow);
  header.appendChild(dayRow);
  return header;
}

// ── Non-working day overlay (weekends + holidays + blocked) ──

function buildNonWorkingOverlay(timeStart, totalDays) {
  const cal = PP.calendar;
  const weekends = new Set(cal.weekends || [0, 6]);

  // Build holiday date set
  const holidayMap = {};
  if (cal.holidays) {
    for (const h of cal.holidays) {
      holidayMap[h.date] = h.label || 'Holiday';
    }
  }

  // Build blocked date set
  const blockedMap = {};
  if (cal.blocked) {
    for (const b of cal.blocked) {
      if (!b.start || !b.end) continue;
      const bs = startOfDay(new Date(b.start));
      const be = startOfDay(new Date(b.end));
      for (let d = new Date(bs); d <= be; d.setDate(d.getDate() + 1)) {
        blockedMap[d.toISOString().slice(0, 10)] = b.label || 'Blocked';
      }
    }
  }

  const frag = document.createDocumentFragment();
  let hasAny = false;

  for (let d = 0; d < totalDays; d++) {
    const date = addDays(timeStart, d);
    const dateStr = date.toISOString().slice(0, 10);
    const dow = date.getDay();
    const isWeekend = weekends.has(dow);
    const holiday = holidayMap[dateStr];
    const blocked = blockedMap[dateStr];

    if (isWeekend || holiday || blocked) {
      hasAny = true;
      const col = document.createElement('div');
      col.style.left = (d * GANTT.pxPerDay) + 'px';
      col.style.width = GANTT.pxPerDay + 'px';

      if (holiday) {
        col.className = 'pp-gantt-holiday';
        col.title = holiday;
      } else if (blocked) {
        col.className = 'pp-gantt-blocked';
        col.title = blocked;
      } else {
        col.className = 'pp-gantt-weekend';
      }

      frag.appendChild(col);
    }
  }

  if (!hasAny) return null;
  const wrap = document.createElement('div');
  wrap.className = 'pp-gantt-weekends';
  wrap.appendChild(frag);
  return wrap;
}

// ── Dependency arrows (SVG) ──

function buildDependencyArrows(rows, taskRowMap, timeStart) {
  const taskRows = rows.filter(r => r.type === 'task');
  let hasAny = false;

  let paths = '';
  for (const r of taskRows) {
    if (!r.depends || !r.depends.length) continue;
    const to = taskRowMap[r.id];
    if (!to) continue;

    const toStart = startOfDay(new Date(r.start));
    const toX = daysBetween(timeStart, toStart) * GANTT.pxPerDay;
    const toY = to.y + GANTT.rowH / 2;

    for (const depId of r.depends) {
      const from = taskRowMap[depId];
      if (!from) continue;
      hasAny = true;

      const fromEnd = startOfDay(new Date(from.row.end));
      const fromX = daysBetween(timeStart, fromEnd) * GANTT.pxPerDay;
      const fromY = from.y + GANTT.rowH / 2;

      // L-elbow connector (matches plan library style)
      const stub = 6;
      let d;
      if (toX - fromX > stub * 2) {
        // Gap available — L-elbow with vertical in the gap
        const mx = fromX + stub;
        d = 'M' + fromX + ' ' + fromY + ' L' + mx + ' ' + fromY + ' L' + mx + ' ' + toY + ' L' + toX + ' ' + toY;
      } else {
        // Tight — vertical drop from finish, short horizontal to start
        d = 'M' + fromX + ' ' + fromY + ' L' + fromX + ' ' + toY + ' L' + toX + ' ' + toY;
      }
      paths += '<path d="' + d + '" fill="none" stroke="#555" stroke-width="1" opacity="0.5"/>';
      // Arrowhead
      paths += '<path d="M' + (toX - 5) + ' ' + (toY - 3) + ' L' + toX + ' ' + toY + ' L' + (toX - 5) + ' ' + (toY + 3) + '" fill="none" stroke="#555" stroke-width="1" opacity="0.5"/>';
    }
  }

  if (!hasAny) return null;

  const totalH = rows.reduce((h, r) => h + (r.type === 'group' ? GANTT.groupH : GANTT.rowH), 0);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'pp-gantt-arrows');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', totalH);
  svg.style.position = 'absolute';
  svg.style.top = '0';
  svg.style.left = '0';
  svg.style.pointerEvents = 'none';
  svg.innerHTML = paths;
  return svg;
}

// ── Interaction ──

function selectTaskInGrid(taskId) {
  const idx = PP.tasks.findIndex(t => t.id === taskId);
  if (idx >= 0) {
    selectRow(idx);
    scrollGridToRow(idx);
  }
}

function scrollGanttToTask(taskId) {
  if (!PP.scheduleResult) return;
  const s = PP.scheduleResult.scheduled.find(t => t.id === taskId);
  if (!s || !s.earlyStart) return;

  const timePane = $('.pp-gantt-timeline');
  if (!timePane) return;

  // Compute the x position of this task's bar
  // We need to recalculate timeStart the same way showGanttPanel does
  const projStart = startOfDay(new Date(PP.projectStart));
  let earliest = projStart;
  for (const r of PP.scheduleResult.scheduled) {
    const rs = startOfDay(new Date(r.earlyStart));
    if (rs < earliest) earliest = rs;
  }
  const timeStart = addDays(earliest, -7);
  const taskStart = startOfDay(new Date(s.earlyStart));
  const taskX = daysBetween(timeStart, taskStart) * GANTT.pxPerDay;

  // Scroll so the task bar is roughly centered
  const targetScroll = taskX - timePane.clientWidth / 3;
  timePane.scrollLeft = Math.max(0, targetScroll);
}
