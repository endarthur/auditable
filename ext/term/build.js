// @gcu/term build: single-source library, so "build" is just a copy
// from src/index.js to index.js. Kept as an explicit step so consumers
// who want a build artifact (auditable's bundler points at index.js,
// not src/index.js) get it without surprise. If the source ever splits
// into multiple files this script is the place to concat them.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(__dirname, 'src', 'index.js');
const dst = path.join(__dirname, 'index.js');

const content = fs.readFileSync(src, 'utf8');
fs.writeFileSync(dst, content);
console.log(`Built ${path.relative(process.cwd(), dst)} (${(content.length / 1024).toFixed(1)} KB)`);
