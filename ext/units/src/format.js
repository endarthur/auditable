// Format values with unit labels and auto-scaling

import { UNITS, convert } from './convert.js';

const UNICODE = {
  um: 'µm', m2: 'm²', cm2: 'cm²', mm2: 'mm²', km2: 'km²',
  m3: 'm³', cm3: 'cm³', 'g/cm3': 'g/cm³', 'kg/m3': 'kg/m³',
  't/m3': 't/m³', 'lb/ft3': 'lb/ft³',
};

// Auto-scale chains: try each target in order, pick the first that gives a "nice" value
const SCALE_CHAINS = {
  length: [
    { unit: 'km', min: 1, max: Infinity },
    { unit: 'm',  min: 1, max: 1000 },
    { unit: 'cm', min: 1, max: 100 },
    { unit: 'mm', min: 1, max: 10 },
    { unit: 'um', min: 0, max: Infinity },
  ],
  mass: [
    { unit: 'Mt', min: 1, max: Infinity },
    { unit: 'kt', min: 1, max: 1000 },
    { unit: 't',  min: 1, max: 1000 },
    { unit: 'kg', min: 1, max: 1000 },
    { unit: 'g',  min: 1, max: 1000 },
    { unit: 'mg', min: 0, max: Infinity },
  ],
  density: [
    { unit: 'g/cm3', min: 0, max: Infinity },
  ],
  grade: [
    { unit: 'pct', min: 1, max: Infinity },
    { unit: 'g/t', min: 0.001, max: 10000 },
    { unit: 'ppm', min: 0, max: Infinity },
  ],
};

function format(value, unit, opts) {
  const dec = opts?.decimals;
  let displayUnit = unit;
  let displayValue = value;

  if (opts?.auto) {
    const entry = UNITS[unit];
    if (entry) {
      const chain = SCALE_CHAINS[entry.dim];
      if (chain) {
        for (const step of chain) {
          const v = convert(value, unit, step.unit);
          const abs = Math.abs(v);
          if (abs >= step.min && abs < step.max) {
            displayValue = v;
            displayUnit = step.unit;
            break;
          }
        }
      }
    }
  }

  const numStr = dec !== undefined ? displayValue.toFixed(dec) : String(displayValue);
  const label = UNICODE[displayUnit] || displayUnit;

  if (displayUnit === 'pct') return numStr + '%';
  return numStr + ' ' + label;
}

export { format };
