// @gcu/drillhole — module manifest (the @gcu/build concat order) + the `Drillhole`
// namespace BMA/dee call through. Reverse-vendored home of bma's vendor-drillhole.js.
//
//   desurvey.js — tangent, detectDipConvention, normalizeSurveys, desurveyHole, positionAt
//   validate.js — validate (join + consistency report)
//   composite.js — defaultLength, composite (fixed-length, length/mass-weighted, split-aware)
//   merge.js     — mergeIntervals (down-hole union re-segment join)
//   process.js   — process (validate → desurvey → composite, one call)

export * from './desurvey.js';
export * from './validate.js';
export * from './composite.js';
export * from './merge.js';
export * from './process.js';

import { dhTangent, dhDetectDipConvention, dhNormalizeSurveys, dhDesurveyHole, dhPositionAt } from './desurvey.js';
import { dhValidate } from './validate.js';
import { dhDefaultLength, dhComposite } from './composite.js';
import { dhMergeIntervals } from './merge.js';
import { dhProcess } from './process.js';

// The `Drillhole.*` facade (the surface app code + the BMA re-vendor call through).
export const Drillhole = {
  tangent: dhTangent,
  detectDipConvention: dhDetectDipConvention,
  normalizeSurveys: dhNormalizeSurveys,
  desurveyHole: dhDesurveyHole,
  positionAt: dhPositionAt,
  validate: dhValidate,
  defaultLength: dhDefaultLength,
  composite: dhComposite,
  process: dhProcess,
  mergeIntervals: dhMergeIntervals,
};
