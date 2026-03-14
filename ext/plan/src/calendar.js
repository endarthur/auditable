// Calendar engine — all scheduling flows through these functions

// Parse "YYYY-MM-DD" to Date (local midnight)
function _parseDate(d) {
  if (d instanceof Date) return d;
  const [y, m, day] = d.split('-').map(Number);
  return new Date(y, m - 1, day);
}

// Format Date to "YYYY-MM-DD"
function _fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Check if a date string falls within a range { start, end }
function _inRange(dateStr, range) {
  return dateStr >= range.start && dateStr <= range.end;
}

// Check if a date is a non-working day
function _isOff(date, calendar, resource) {
  const dow = date.getDay();
  const weekends = calendar.weekends || [0, 6];
  if (weekends.includes(dow)) return true;

  const ds = _fmtDate(date);

  // Calendar holidays
  if (calendar.holidays) {
    for (const h of calendar.holidays) {
      if (h.date === ds) return true;
    }
  }

  // Calendar blocked ranges
  if (calendar.blocked) {
    for (const b of calendar.blocked) {
      if (_inRange(ds, b)) return true;
    }
  }

  // Resource overrides (vacation, leave, etc.)
  if (resource && resource.calendarOverrides) {
    for (const ov of resource.calendarOverrides) {
      if (_inRange(ds, ov)) return true;
    }
  }

  return false;
}

// Is a given date a working day?
function isWorkingDay(date, calendar, resource) {
  return !_isOff(_parseDate(date), calendar, resource);
}

// Add N working days to a date (negative N for backward pass)
function addWorkingDays(date, n, calendar, resource) {
  const d = new Date(_parseDate(date));
  if (n === 0) return d;

  const step = n > 0 ? 1 : -1;
  let remaining = Math.abs(n);

  while (remaining > 0) {
    d.setDate(d.getDate() + step);
    if (!_isOff(d, calendar, resource)) remaining--;
  }

  return d;
}

// Count working days between two dates (exclusive of end)
function workingDays(start, end, calendar, resource) {
  const s = _parseDate(start);
  const e = _parseDate(end);
  if (s >= e) return 0;

  let count = 0;
  const d = new Date(s);
  while (d < e) {
    if (!_isOff(d, calendar, resource)) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

// Get the next working day on or after date
function nextWorkingDay(date, calendar, resource) {
  const d = new Date(_parseDate(date));
  while (_isOff(d, calendar, resource)) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

// Get all blocked/off days in a range (for rendering)
function getBlockedDays(start, end, calendar, resource) {
  const s = _parseDate(start);
  const e = _parseDate(end);
  const result = [];
  const d = new Date(s);

  while (d <= e) {
    if (_isOff(d, calendar, resource)) {
      const ds = _fmtDate(d);
      let reason = 'weekend';
      const dow = d.getDay();
      const weekends = calendar.weekends || [0, 6];

      if (!weekends.includes(dow)) {
        // Check holidays
        if (calendar.holidays) {
          const h = calendar.holidays.find(h => h.date === ds);
          if (h) { reason = h.label || 'holiday'; }
        }
        // Check blocked
        if (reason === 'weekend' && calendar.blocked) {
          const b = calendar.blocked.find(b => _inRange(ds, b));
          if (b) { reason = b.label || 'blocked'; }
        }
        // Check resource
        if (reason === 'weekend' && resource && resource.calendarOverrides) {
          const ov = resource.calendarOverrides.find(o => _inRange(ds, o));
          if (ov) { reason = ov.label || ov.type || 'unavailable'; }
        }
      }

      result.push({ date: new Date(d), reason });
    }
    d.setDate(d.getDate() + 1);
  }

  return result;
}

export {
  isWorkingDay, addWorkingDays, workingDays, nextWorkingDay, getBlockedDays,
  _parseDate, _fmtDate,
};
