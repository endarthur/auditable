// @gcu/drillhole — public surface (the @gcu/build manifest). Clean named exports,
// matching the other GCU packages: `const dh = await load("@gcu/drillhole"); dh.process(...)`.
// The internal `dh*` names (a bma concat-IIFE artifact) and the private hole-join
// helpers (dhJoinHoles / dhNormalizeHoleStations) stay module-scoped — they're still
// bundled (validate/samples import them), just not part of the public API.
//
//   desurvey.js — tangent, detectDipConvention, normalizeSurveys, desurveyHole, positionAt
//   validate.js — validate (join + consistency report)
//   composite.js — defaultLength, composite (fixed-length, length/mass-weighted, split-aware)
//   samples.js   — desurveySamples (point-support locator)
//   merge.js     — mergeIntervals (down-hole union re-segment join)
//   process.js   — process (validate → desurvey → composite, one call)

export {
  dhTangent as tangent,
  dhDetectDipConvention as detectDipConvention,
  dhNormalizeSurveys as normalizeSurveys,
  dhDesurveyHole as desurveyHole,
  dhPositionAt as positionAt,
} from './desurvey.js';
export { dhValidate as validate } from './validate.js';
export { dhDefaultLength as defaultLength, dhComposite as composite } from './composite.js';
export { dhDesurveySamples as desurveySamples } from './samples.js';
export { dhMergeIntervals as mergeIntervals } from './merge.js';
export { dhProcess as process } from './process.js';
