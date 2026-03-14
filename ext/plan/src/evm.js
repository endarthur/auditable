// Earned Value Management

import { workingDays, _parseDate } from './calendar.js';
import { effectiveDuration } from './pert.js';

function evm(scheduledTasks, statusDate, calendar) {
  const sd = statusDate ? _parseDate(statusDate) : new Date();

  let pv = 0, ev = 0, ac = 0, bac = 0;

  for (const t of scheduledTasks) {
    const dur = effectiveDuration(t);
    const taskCost = (t.cost && t.cost.rate) ? t.cost.rate * dur : dur;
    bac += taskCost;

    // Planned Value: how much work should be done by status date
    if (t.earlyFinish <= sd) {
      pv += taskCost; // task should be 100% complete
    } else if (t.earlyStart <= sd) {
      // Task is in progress — proportion based on schedule
      const totalDur = dur || 1;
      const elapsed = calendar
        ? workingDays(t.earlyStart, sd, calendar)
        : _calendarDayFraction(t.earlyStart, sd, t.earlyFinish);
      pv += taskCost * Math.min(1, elapsed / totalDur);
    }

    // Earned Value: actual progress × planned value
    const progress = t.progress || 0;
    ev += taskCost * progress;

    // Actual Cost: if provided, use it; otherwise mirror EV
    if (t.actualCost != null) {
      ac += t.actualCost;
    } else {
      ac += taskCost * progress;
    }
  }

  const sv = ev - pv;
  const cv = ev - ac;
  const spi = pv > 0 ? ev / pv : 1;
  const cpi = ac > 0 ? ev / ac : 1;
  const eac = cpi > 0 ? bac / cpi : bac;
  const etc = eac - ac;
  const vac = bac - eac;

  return {
    statusDate: sd,
    pv, ev, ac, bac,
    sv, cv, spi, cpi,
    eac, etc, vac,
  };
}

function _calendarDayFraction(start, current, end) {
  const total = end - start || 1;
  const elapsed = current - start;
  return Math.max(0, elapsed / total);
}

export { evm };
