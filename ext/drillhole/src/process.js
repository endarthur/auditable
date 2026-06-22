// @gcu/drillhole — process: the one-call pipeline (validate → desurvey → composite).
// What BMA's ingestion calls; everything else is exposed for tests and reuse.

import { dhValidate } from './validate.js';
import { dhDefaultLength, dhComposite } from './composite.js';

// Returns { header, rows, report }.
export function dhProcess(tables, opts) {
  opts = opts || {};
  let validated = dhValidate(tables, opts);
  let length = (typeof opts.compositeLength === 'number' && opts.compositeLength > 0)
    ? opts.compositeLength
    : dhDefaultLength(validated.intervals);
  let result = dhComposite(validated, {
    length: length,
    method: opts.method || 'minimumCurvature',
    domainColName: opts.domainCol || null,
    splitColNames: opts.splitCols || null,
    densityColName: opts.densityCol || null,
    combine: opts.combine || null,
    minCoverage: opts.minCoverage || null,
  });
  let checkList = [];
  for (let k in validated.checks) checkList.push(validated.checks[k]);
  return {
    header: result.header,
    rows: result.rows,
    report: {
      checks: checkList,
      nHoles: validated.holes.length,
      nComposites: result.rows.length,
      dipConvention: validated.dipConvention,
      compositeLength: length,
    },
  };
}
