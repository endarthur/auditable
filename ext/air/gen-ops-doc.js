#!/usr/bin/env node
// Schema → Markdown ops-table generator (v0.3 §3.5).
//
// Reads ext/air/src/schema.js's OP_SCHEMA and emits/updates a Markdown
// table inside ext/air/SPEC.md, between two delimiter lines. Lets the
// public op contract stay in sync with the source-of-truth schema.
//
// Run with:  node ext/air/gen-ops-doc.js
// Or via:    npm run gen-ops-doc  (if wired to package.json)

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load schema directly — it's a pure ESM module with no DOM deps.
// pathToFileURL is required on Windows where absolute paths begin with
// a drive letter (`c:\...`) and Node's ESM loader rejects raw paths.
const { OP_SCHEMA } = await import(pathToFileURL(path.join(__dirname, 'src/schema.js')).href);

const BEGIN = '<!-- BEGIN: AUTO-GENERATED OPS TABLE — `node ext/air/gen-ops-doc.js` -->';
const END = '<!-- END: AUTO-GENERATED OPS TABLE -->';

function categorize(name, schema) {
  // Group ops by intent for the Markdown table.
  if (['const', 'null', 'load', 'store', 'meta', 'slot_alloc', 'slot_load', 'slot_store'].includes(name))
    return 'Constants & loads';
  if (['add', 'sub', 'mul', 'div', 'mod', 'exp'].includes(name))
    return 'Arithmetic';
  if (['eq', 'neq', 'lt', 'lte', 'gt', 'gte'].includes(name))
    return 'Comparison';
  if (['bitwise_or', 'bitwise_and', 'bitwise_xor', 'shift_left', 'shift_right', 'ushift_right', 'bitwise_not'].includes(name))
    return 'Bitwise';
  if (['logical_and', 'logical_or', 'nullish_coalesce', 'logical_not'].includes(name))
    return 'Logical';
  if (['in', 'instanceof'].includes(name))
    return 'Membership';
  if (['neg', 'unary_plus', 'typeof', 'void', 'delete'].includes(name))
    return 'Unary';
  if (['object_get', 'object_set', 'array_get', 'array_set'].includes(name))
    return 'Member access';
  if (['array_new', 'object_new', 'ta_new', 'new'].includes(name))
    return 'Construction';
  if (['call', 'call_method', 'await', 'spread', 'import'].includes(name))
    return 'Calls';
  if (['throw', 'debugger', 'return', 'break', 'continue', 'yield', 'yield_delegate'].includes(name))
    return 'Statements';
  if (schema.regions || schema.extras?.cases || schema.extras?.members)
    return 'Region ops';
  return 'Special';
}

function renderArgsShape(schema) {
  if (schema.arity === 'fixed') {
    return schema.args.length === 0 ? '`[]`' : '`[' + schema.args.join(', ') + ']`';
  }
  return '`' + schema.args + '`';
}

function renderRegions(schema) {
  if (!schema.regions) return '—';
  return Object.entries(schema.regions)
    .map(([name, info]) => `${name}${info.optional ? '?' : ''}: ${info.scope}`)
    .join(', ');
}

function renderExtras(schema) {
  if (!schema.extras) return '—';
  const required = [], optional = [];
  for (const [k, spec] of Object.entries(schema.extras)) {
    if (typeof spec === 'string' && !spec.endsWith('?')) required.push(`**${k}**`);
    else optional.push(k);
  }
  const parts = [];
  if (required.length) parts.push(required.join(', '));
  if (optional.length) parts.push('_' + optional.join(', ') + '_');
  return parts.join(' · ') || '—';
}

function generateTable() {
  const groups = new Map();
  for (const [name, schema] of Object.entries(OP_SCHEMA)) {
    const cat = categorize(name, schema);
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push([name, schema]);
  }

  // Stable ordering for output
  const ORDER = [
    'Constants & loads', 'Arithmetic', 'Comparison', 'Bitwise', 'Logical',
    'Membership', 'Unary', 'Member access', 'Construction', 'Calls',
    'Statements', 'Region ops', 'Special',
  ];

  const lines = [];
  lines.push(BEGIN);
  lines.push('');
  lines.push('## 17. Op shape catalogue');
  lines.push('');
  lines.push('Auto-generated from `ext/air/src/schema.js#OP_SCHEMA`. Run `node ext/air/gen-ops-doc.js` to regenerate.');
  lines.push('');
  lines.push(`Total: ${Object.keys(OP_SCHEMA).length} op types.`);
  lines.push('');

  for (const cat of ORDER) {
    const entries = groups.get(cat);
    if (!entries) continue;
    lines.push(`### ${cat}`);
    lines.push('');
    lines.push('| op | arity / args | result | side fx | async | regions | extras (**req** · _opt_) |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const [name, schema] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push([
        '`' + name + '`',
        `${schema.arity} ${renderArgsShape(schema)}`,
        '`' + schema.result + '`',
        schema.side_effecting ? 'yes' : '—',
        schema.can_be_async ? 'yes' : '—',
        renderRegions(schema),
        renderExtras(schema),
      ].map(s => ' ' + s + ' ').join('|').replace(/^/, '|').replace(/$/, '|'));
    }
    lines.push('');
  }

  lines.push(END);
  return lines.join('\n');
}

const specPath = path.join(__dirname, 'SPEC.md');
const spec = fs.readFileSync(specPath, 'utf8');

const generated = generateTable();
let updated;
if (spec.includes(BEGIN) && spec.includes(END)) {
  // Replace existing block
  updated = spec.replace(
    new RegExp(BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    generated
  );
} else {
  // Append at end
  updated = spec.trimEnd() + '\n\n' + generated + '\n';
}

if (updated !== spec) {
  fs.writeFileSync(specPath, updated);
  console.log(`Updated ext/air/SPEC.md (${Object.keys(OP_SCHEMA).length} op rows)`);
} else {
  console.log('ext/air/SPEC.md already up to date');
}
