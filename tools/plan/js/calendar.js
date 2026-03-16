// Calendar settings panel — holidays, blocked periods, presets

function showCalendarPanel() {
  const content = $('#pp-sidebar-content');
  if (!content) return;

  const municipalities = typeof brazilMunicipalities === 'function' ? brazilMunicipalities() : [];

  let presetOpts = '<option value="">No preset</option>';
  if (municipalities.length) {
    presetOpts += '<option value="brazil-federal">Brazil (federal)</option>';
    for (const m of municipalities) {
      const selected = PP.calendarPreset === m ? ' selected' : '';
      presetOpts += '<option value="' + esc(m) + '"' + selected + '>' + esc(m) + '</option>';
    }
  }

  let holidayHtml = '';
  if (PP.calendar.holidays && PP.calendar.holidays.length) {
    holidayHtml = '<div class="pp-holiday-list">';
    for (const h of PP.calendar.holidays) {
      holidayHtml += '<div class="pp-holiday-item"><span class="pp-holiday-date">' + esc(h.date) + '</span><span class="pp-holiday-label">' + esc(h.label || '') + '</span></div>';
    }
    holidayHtml += '</div>';
  }

  let blockedHtml = '';
  const blocked = PP.calendar.blocked || [];
  blockedHtml += '<table class="pp-blocked-table"><thead><tr><th>Start</th><th>End</th><th>Label</th><th></th></tr></thead><tbody>';
  for (let i = 0; i < blocked.length; i++) {
    const b = blocked[i];
    blockedHtml += '<tr data-bi="' + i + '">'
      + '<td><input type="date" value="' + esc(b.start || '') + '" data-field="start"></td>'
      + '<td><input type="date" value="' + esc(b.end || '') + '" data-field="end"></td>'
      + '<td><input type="text" value="' + esc(b.label || '') + '" data-field="label"></td>'
      + '<td><button class="pp-blocked-rm" data-rm="' + i + '">\u00d7</button></td>'
      + '</tr>';
  }
  blockedHtml += '</tbody></table>';
  blockedHtml += '<button class="pp-btn-small" id="pp-add-blocked">+ add blocked period</button>';

  content.innerHTML = '<div class="pp-calendar-panel">'
    + '<label>Project Start</label>'
    + '<input type="date" id="pp-project-start" value="' + PP.projectStart + '">'
    + '<label>Holiday Preset</label>'
    + '<select id="pp-cal-preset">' + presetOpts + '</select>'
    + '<div class="pp-calendar-section">Holidays (' + (PP.calendar.holidays || []).length + ')</div>'
    + holidayHtml
    + '<div class="pp-calendar-section">Blocked Periods</div>'
    + blockedHtml
    + '</div>';

  // Wire events
  $('#pp-project-start').addEventListener('change', e => {
    PP.projectStart = e.target.value;
    PP.dirty = true;
    updateTitle();
    scheduleEval();
  });

  $('#pp-cal-preset').addEventListener('change', e => {
    const val = e.target.value;
    applyCalendarPreset(val);
    showCalendarPanel(); // re-render
  });

  // Blocked period inputs
  for (const input of $$('.pp-blocked-table input')) {
    input.addEventListener('change', e => {
      const row = e.target.closest('tr');
      const bi = parseInt(row.dataset.bi);
      const field = e.target.dataset.field;
      PP.calendar.blocked[bi][field] = e.target.value;
      PP.dirty = true;
      updateTitle();
      scheduleEval();
    });
  }

  for (const btn of $$('.pp-blocked-rm')) {
    btn.addEventListener('click', e => {
      const i = parseInt(e.target.dataset.rm);
      PP.calendar.blocked.splice(i, 1);
      PP.dirty = true;
      updateTitle();
      showCalendarPanel();
      scheduleEval();
    });
  }

  $('#pp-add-blocked').addEventListener('click', () => {
    PP.calendar.blocked.push({ start: '', end: '', label: '' });
    PP.dirty = true;
    showCalendarPanel();
  });
}

function applyCalendarPreset(preset) {
  PP.calendarPreset = preset || null;
  PP.dirty = true;
  updateTitle();

  if (!preset) {
    PP.calendar.holidays = [];
    scheduleEval();
    return;
  }

  // Determine year range from project start
  const startYear = parseInt(PP.projectStart.slice(0, 4)) || new Date().getFullYear();
  const endYear = startYear + 2;

  try {
    if (preset === 'brazil-federal') {
      const cal = brazilCalendar(startYear, endYear);
      PP.calendar.holidays = cal.holidays || [];
    } else {
      // Municipality preset: "city-uf"
      const parts = preset.split('-');
      const uf = parts[parts.length - 1];
      const municipality = parts.slice(0, -1).join('-');
      const cal = brazilCalendar(startYear, endYear, {
        uf,
        municipality: preset,
        carnival: true,
        corpusChristi: true,
      });
      PP.calendar.holidays = cal.holidays || [];
    }
  } catch (e) {
    setStatus('msg', 'calendar error: ' + e.message);
    PP.calendar.holidays = [];
  }

  scheduleEval();
}
