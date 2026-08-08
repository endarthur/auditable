#!/usr/bin/env node
// check-matcols — is a micro project affected by the Store-as-Parquet grade shuffle?
//
//   node tools/micro/check-matcols.mjs <project-folder>
//
// THE BUG (fixed in build 5f6c190, 2026-08-07). "Store as Parquet" — which
// auto-optimize runs on project save — Morton-sorts a model's base columns for the
// spatial index and permutes the per-record state to match. It permuted each paint
// column's `codes` and the selection mask, but NOT `fvalues`, the full-precision
// backing that IS the value of a materialized column. So the values stayed in the
// original file order while the blocks moved: every materialized grade landed on
// the wrong block, and was then written to the `.cols` sidecar.
//
// It is invisible. `codes` are only the 256-level DISPLAY view and they moved
// correctly, so the model renders with the right colours on the right blocks. Only
// export, filter, grade-tonnage and the record panel — which read `fvalues` — see
// the wrong numbers. A reload does not repair it; it faithfully loads the
// misordered sidecar.
//
// WHAT THIS CHECKS. For every materialized column whose manifest op is a `calc`,
// the expression is re-evaluated against the base columns and compared to the
// stored values — exact, no heuristics. For an `estimate` (interpolation) the
// expression is not re-runnable here, so the column is reported as NOT PROVEN and
// the safe action is to re-run the estimate.
//
// Nothing is modified. This only reads.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const REPO = path.resolve(HERE, '../..');
const imp = async (rel) => import(pathToFileURL(path.join(REPO, rel)).href);

const root = process.argv[2];
if (!root || !fs.existsSync(root)) {
  console.error('usage: node tools/micro/check-matcols.mjs <project-folder>');
  process.exit(2);
}

const PQ = await imp('ext/parquet/index.js');
const EX = await imp('ext/expr/index.js');

// walk for every <name>.cols directory anywhere under the project
const colsDirs = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (!e.isDirectory()) continue;
    if (e.name.endsWith('.cols')) colsDirs.push(p); else walk(p);
  }
})(root);

if (!colsDirs.length) {
  console.log('No .cols sidecars in this project — no materialized columns, nothing to check.');
  process.exit(0);
}

const readParquetAll = async (file) => {
  const buf = new Uint8Array(fs.readFileSync(file));
  const info = PQ.parquetInfo(buf);
  const names = (info.columns || []).map((c) => c.name || c);
  const cols = await PQ.readParquetRange(buf, names, 0, info.rowCount, info.meta);   // async
  return { rows: info.rowCount, names, cols };
};

let affected = 0, clean = 0, unproven = 0;

for (const cd of colsDirs) {
  const base = path.basename(cd).replace(/\.cols$/, '');           // "model.parquet" or "model.csv"
  const dir = path.dirname(cd);
  console.log(`\n── ${path.relative(root, cd)}`);

  // the element manifest carries the ops; without it we cannot re-derive anything
  const manPath = path.join(dir, `${base}.element.json`);
  let man = null;
  try { man = JSON.parse(fs.readFileSync(manPath, 'utf8')); } catch { /* none */ }
  if (!man) { console.log('   no .element.json beside it — cannot read the column definitions'); continue; }

  const opById = new Map((man.ops || []).map((o) => [o.id, o]));
  const matCols = (man.columns || []).filter((c) => c.from === 'materialized' && c.type === 'number');
  if (!matCols.length) { console.log('   no materialized NUMERIC columns (paint/category columns are unaffected)'); continue; }

  // the model itself — must be the Parquet the sidecar sits beside
  const modelPath = path.join(dir, base);
  if (!fs.existsSync(modelPath) || !/\.parquet$/i.test(base)) {
    console.log(`   base model "${base}" is not a Parquet file — this sidecar predates an optimize, so it is not affected`);
    continue;
  }
  let model;
  try { model = await readParquetAll(modelPath); } catch (e) { console.log(`   could not read ${base}: ${e.message}`); continue; }

  for (const col of matCols) {
    // col.file is relative to the LAYER's directory ('ord.parquet.cols/EST.parquet')
    const file = path.join(dir, col.file || `${base}.cols/${col.name}.parquet`);
    if (!fs.existsSync(file)) { console.log(`   ${col.name}: sidecar missing`); continue; }
    let side;
    try { side = await readParquetAll(file); } catch (e) { console.log(`   ${col.name}: unreadable — ${e.message}`); continue; }
    const stored = side.cols[side.names[0]];
    if (side.rows !== model.rows) {
      console.log(`   ${col.name}: ROW COUNT MISMATCH (${side.rows} vs ${model.rows}) — stale sidecar, re-run it`);
      unproven++; continue;
    }

    const op = col.def ? opById.get(col.def) : null;
    const expr = op && op.op === 'calc' && op.params && op.params.expr;
    if (!expr) {
      const what = op ? op.op : 'hand-set';
      console.log(`   ${col.name}: NOT PROVEN — produced by "${what}", which cannot be re-evaluated here.`);
      console.log(`      If this project was saved by a build before 5f6c190 AND was ever stored as Parquet, re-run it.`);
      unproven++; continue;
    }

    // re-evaluate the recorded expression against the base columns, row by row
    const schema = model.names.map((n) => ({ name: n, type: typeof model.cols[n][0] === 'string' ? 'string' : 'number' }));
    let fn;
    try { fn = EX.compileValue(expr, schema, { decimal: '.' }); } catch (e) {
      console.log(`   ${col.name}: expression "${expr}" no longer compiles — ${e.message}`);
      unproven++; continue;
    }
    let bad = 0, first = null;
    const row = new Array(model.names.length);
    for (let i = 0; i < model.rows; i++) {
      for (let k = 0; k < model.names.length; k++) row[k] = model.cols[model.names[k]][i];
      let want; try { want = fn(row); } catch { want = null; }
      const got = stored[i];
      const bothBlank = (want == null || Number.isNaN(+want)) && (got == null || Number.isNaN(got));
      if (bothBlank) continue;
      if (want == null || got == null || Math.abs(+want - got) > 1e-3 * Math.max(1, Math.abs(+want))) {
        bad++;
        if (!first) first = { i, want: +want, got };
      }
    }
    if (bad) {
      console.log(`   ${col.name}: ✗ AFFECTED — ${bad} of ${model.rows} values disagree with "${expr}"`);
      console.log(`      e.g. row ${first.i} should be ${first.want}, sidecar has ${first.got}`);
      affected++;
    } else {
      console.log(`   ${col.name}: ✓ clean — all ${model.rows} values match "${expr}"`);
      clean++;
    }
  }
}

console.log(`\n${affected} affected · ${clean} clean · ${unproven} not proven`);
if (affected || unproven) {
  console.log('\nTo repair: open the project in micro (build 5f6c190 or later), delete the affected');
  console.log('column and re-run the calc or estimate that produced it — the manifest records the op');
  console.log('and its parameters, so it regenerates exactly. Then save.');
}
process.exit(affected ? 1 : 0);
