// @gcu/sluice — serializable accumulator specs.
//
// A spec is plain JSON describing an accumulator tree; accumulatorFromSpec(spec)
// builds the live accumulator. This is the cross-realm op contract (§7a "ops
// must be serializable, not closures"): a worker receives a SPEC and rebuilds the
// accumulator locally — no closure crosses the boundary. Also how a pipeline node
// persists its analysis config. Column extractors are by NAME (r => r[column]);
// arbitrary per-row calc is a future AIR-compiled extractor, not a closure here.
//
// Grammar:
//   leaf:    { kind: 'count'|'sum'|'extent'|'welford'|'weightedStats' }
//            { kind: 'tdigest', compression? } | { kind: 'topK'|'cardinality', limit? }
//            { kind: 'histogram', min, max, bins }
//   collect: { kind: 'collect', fields: { name: { column?, of: <spec> } }, weight? }
//              — a field with `column` feeds its sub-accumulator r[column]; without
//                `column` it feeds the whole row (for a nested combinator).
//   groupBy: { kind: 'groupBy', column, of: <spec>, maxGroups?, weight? }
//   binned:  { kind: 'binned', column, bins: {min,max,bins}|{binWidth}, of: <spec>, weight? }

import { count, sum, extent, welford, weightedStats } from './accumulator.js';
import { tdigest } from './tdigest.js';
import { topK, cardinality } from './categorical.js';
import { histogram } from './histogram.js';
import { collect, groupBy, binned } from './combinators.js';
import { gradeTonnage } from './gradetonnage.js';

export function accumulatorFromSpec(spec) {
  if (!spec || typeof spec.kind !== 'string') throw new Error('sluice: accumulator spec needs a `kind`');
  switch (spec.kind) {
    case 'count': return count();
    case 'sum': return sum();
    case 'extent': return extent();
    case 'welford': return welford();
    case 'weightedStats': return weightedStats();
    case 'tdigest': return tdigest({ compression: spec.compression });
    case 'topK': return topK({ limit: spec.limit });
    case 'cardinality': return cardinality({ limit: spec.limit });
    case 'histogram': return histogram({ min: spec.min, max: spec.max, bins: spec.bins });
    case 'collect': {
      const fields = {};
      for (const name of Object.keys(spec.fields || {})) {
        const f = spec.fields[name];
        const sub = accumulatorFromSpec(f.of || f);
        fields[name] = [sub, f.column !== undefined ? col(f.column) : identity];
      }
      return collect(fields, weightOpt(spec));
    }
    case 'groupBy':
      return groupBy(col(spec.column), () => accumulatorFromSpec(spec.of), { maxGroups: spec.maxGroups, ...weightOpt(spec) });
    case 'binned':
      return binned(col(spec.column), spec.bins, () => accumulatorFromSpec(spec.of), weightOpt(spec));
    case 'gradeTonnage':
      return gradeTonnage(spec);   // grade/gradeMin/gradeMax/bins/blockVolume/dims/density/weight
    default:
      throw new Error(`sluice: unknown accumulator spec kind "${spec.kind}"`);
  }
}

const identity = (r) => r;
function col(column) {
  if (column === undefined || column === null) throw new Error('sluice: accumulator spec needs a `column`');
  return (r) => r[column];
}
function weightOpt(spec) {
  return spec.weight ? { weight: col(spec.weight) } : {};
}
