// @gcu/pdfjs — vendored PDF.js (Mozilla, Apache-2.0), pinned to pdfjs-dist
// 3.11.174 *legacy UMD* build. v3 (not v4) deliberately: it ships a classic
// (UMD) main + a classic worker, which the Works reader needs because
// cross-blob ESM imports are blocked on file:// origins. The UMD, run as a
// classic script via indirect eval, assigns its API to
// globalThis["pdfjs-dist/build/pdf"]; the worker source is appended as a
// string (globalThis.__pdfjsWorkerSrc) so a consumer can spin up a classic
// Worker from a blob URL — no separate file, no ESM, file://-safe.
//
// Run: node ext/pdfjs/build.js   (regenerates index.js from vendor/)
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const stripCR = (s) => s.replace(/\r/g, '');   // CRLF-anchor hazard on Windows
const main = stripCR(fs.readFileSync(path.join(dir, 'vendor', 'pdf.min.js'), 'utf8'));
const worker = stripCR(fs.readFileSync(path.join(dir, 'vendor', 'pdf.worker.min.js'), 'utf8'));

const out = main
  + '\n;globalThis.__pdfjsWorkerSrc = ' + JSON.stringify(worker) + ';\n';

fs.writeFileSync(path.join(dir, 'index.js'), out);
console.log('Built ext/pdfjs/index.js (' + Math.round(out.length / 1024) + ' KB; main + embedded worker)');
