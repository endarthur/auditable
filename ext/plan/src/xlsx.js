// XLSX export adapter — uses @sheet if available

import { _fmtDate } from './calendar.js';
import { effectiveDuration } from './pert.js';

function planToXLSX(scheduleResult, scurveData, options = {}) {
  // Try to get @sheet from the import cache
  const sheet = (typeof window !== 'undefined' && window._importCache && window._importCache['@sheet'])
    || options.sheet;

  if (!sheet || !sheet.writeXLSX) {
    throw new Error('planToXLSX requires @sheet to be loaded. Call load("@sheet") first.');
  }

  const wb = {};

  // Schedule sheet
  wb['Schedule'] = [
    ['ID', 'Name', 'Group', 'Resource', 'Duration', 'Start', 'Finish', 'Float', 'Critical', 'Progress'],
    ...scheduleResult.scheduled.map(t => [
      t.id,
      t.name || t.id,
      t.group || '',
      t.resource || '',
      effectiveDuration(t),
      _fmtDate(t.earlyStart),
      _fmtDate(t.earlyFinish),
      t.totalFloat,
      t.isCritical ? 'Yes' : 'No',
      t.progress != null ? Math.round(t.progress * 100) + '%' : '',
    ]),
  ];

  // S-Curve sheet
  if (scurveData && scurveData.labels) {
    const scRows = [['Period', 'Planned', 'Actual']];
    for (let i = 0; i < scurveData.labels.length; i++) {
      scRows.push([
        scurveData.labels[i],
        Math.round(scurveData.planned[i] * 100) / 100,
        Math.round((scurveData.actual[i] || 0) * 100) / 100,
      ]);
    }
    wb['S-Curve'] = scRows;
  }

  return sheet.writeXLSX(wb);
}

export { planToXLSX };
