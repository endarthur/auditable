# @gcu/drillhole

Pure drillhole **desurvey + down-hole compositing** — collars, surveys, and assay
intervals in, estimation-ready composites out. Zero DOM, zero deps; the numerical
core behind BMA's ingestion and dee's inline desurvey, and the compositing front
door for [`@gcu/gsjs`](../gsjs).

Reverse-vendored: developed in BMA (the [bma](https://github.com/) workbench) in the
concat-source style, always intended to live here. BMA and dee re-vendor the `src/`
modules from here now.

## What it does

- **Desurvey** — collar + survey stations → the 3D hole trace, with three methods:
  - **`minimumCurvature`** (default) — circular-arc model (RF = (2/θ)·tan(θ/2)); the
    industry standard, *exact* on a circular hole.
  - **`balancedTangential`** — averages the two end tangents per segment (matches
    several legacy packages).
  - **`tangential`** — straight segments along the lower station's attitude (sparse
    or legacy surveys; redoing historical estimates).

  `positionAt(hole, depth)` returns the point at any down-hole depth *consistently
  with the hole's method* (min-curvature interpolates along the arc — mid-segment
  points land on the analytic circle to 1e-14, where a chord would miss by ~0.125 m).
  Dip is the **mining convention** (positive down); `detectDipConvention` infers
  pos/neg-down from the median and `normalizeSurveys` flips, sorts, dedupes (last
  wins), and synthesizes a depth-0 station. The desurveyed hole also carries
  **`dogleg`** (angular change, °) and **`dls`** (dogleg severity, °/30 m) per
  station — survey-geometry QC, the same for every method.

- **Locate point samples** — `desurveySamples({ collars, surveys, samples })` places
  point-support data (single-depth XRF/density readings, pre-composited assays) in 3D
  on the desurveyed trace — one located row per sample, no compositing. Same
  non-silent report style as the interval pipeline.

- **Compositing** — fixed-length down-hole composites, length-weighted (optionally
  **mass**-weighted by a density column), with:
  - **split columns** — composites restart wherever a tuple of columns changes (a
    generalized domain break; never composite across a lithology/zone contact);
  - **per-column combine rules** — numeric `mean` (default) / `sum` / `min` / `max`;
    categorical `majority` (by covered length) / `first` (shallowest);
  - **honest support** — `SUPPORT` = covered length; missing assays shrink only that
    column's weight (never poison the mean); the optional `minCoverage` filter is
    visible and counted; short tail composites keep their true (short) support;
  - XYZ at the **covered-length centroid** on the desurveyed path.

- **Validate** — joins the three tables and **drops nothing silently**: duplicate
  collars, bad coordinates, orphan surveys/intervals, FROM ≥ TO, past-EOH, overlaps,
  no-survey holes (desurveyed straight down) — each lands in the report with a count
  and a BHID list.

- **Merge** — `mergeIntervals(A, B)` joins two down-hole interval tables on a
  **union re-segment** (breaks need not align; columns carried verbatim, gaps and
  overlaps counted) → a table the compositing pipeline runs on.

## Use

```js
import { Drillhole } from '@gcu/drillhole';   // or the named dh* exports

const { header, rows, report } = Drillhole.process({
  collars:  [{ bhid: 'DH1', x: 1000, y: 2000, z: 350, eoh: 120 }, ...],
  surveys:  [{ bhid: 'DH1', depth: 0, az: 45, dip: 60 }, ...],   // dip raw (per file)
  intervals: { bhid: [...], from: [...], to: [...],
               cols: [{ name: 'AU', type: 'num', values: [...] },
                      { name: 'LITO', type: 'cat', values: [...] }] },
}, {
  compositeLength: 2,            // omit → mode of (TO−FROM)
  method: 'minimumCurvature',   // | 'balancedTangential' | 'tangential'
  splitCols: ['LITO'],          // restart composites at each lithology contact
  densityCol: 'RHO',            // optional mass weighting
  minCoverage: 0.5,             // optional visible filter
  combine: { AU: 'mean' },      // per-column rules
});
// header = [BHID, X, Y, Z, FROM, TO, SUPPORT, ...data cols]
// rows[i] = desurveyed midpoint + support + composited values → feed krige()/decluster()
// report.checks = the non-silent consistency report
```

Lower-level pieces are exposed too: `desurveyHole` / `positionAt` / `normalizeSurveys`
/ `detectDipConvention` / `validate` / `composite` / `defaultLength` / `mergeIntervals`.

## Build & test

```
node ext/drillhole/build.js     # @gcu/build bundle → index.js
node --test test/drillhole.test.mjs
```

The test is the oracle harness — analytic arcs (a horizontal circle, a vertical-plane
quarter circle) pinned to closed-form positions at 1e-9, hand-computed composite
fixtures (gaps, overlaps, missing assays, mass weighting, splits, domains), the
validation counts, and the merge join.
