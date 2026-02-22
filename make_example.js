#!/usr/bin/env node
// Injects cell data into auditable.html to produce a standalone example notebook.
// Usage: require('./make_example')({ title, cells, settings?, outPath })
//   or:  node make_example.js <example_def.json> <outPath>

const fs = require('fs');
const path = require('path');

function makeExample({ title, cells, settings, modules, outPath }) {
  const basePath = path.join(__dirname, 'auditable.html');
  if (!fs.existsSync(basePath)) {
    throw new Error('auditable.html not found — run `node build.js` first');
  }
  let html = fs.readFileSync(basePath, 'utf8');

  // 1. Set <title>
  html = html.replace(
    '<title>Auditable</title>',
    `<title>Auditable \u2014 ${title}</title>`
  );

  // 2. Set docTitle input value
  html = html.replace(
    'id="docTitle" value="untitled"',
    `id="docTitle" value="${title.replace(/"/g, '&quot;')}"`
  );

  // 3. Build data comments
  const dataComment = '<!--AUDITABLE-DATA\n' + JSON.stringify(cells) + '\nAUDITABLE-DATA-->';
  const modulesComment = modules ? '<!--AUDITABLE-MODULES\n' + JSON.stringify(modules).replace(/--/g, '\\u002d\\u002d') + '\nAUDITABLE-MODULES-->' : '';
  const settingsComment = '<!--AUDITABLE-SETTINGS\n' + JSON.stringify(settings || { theme: 'dark', fontSize: 13, width: '860' }) + '\nAUDITABLE-SETTINGS-->';

  // 4. Insert before <script>
  // Use a replacer function to avoid $' $` $& special patterns in module source
  const insertion = '\n' + dataComment + '\n' + (modulesComment ? modulesComment + '\n' : '') + settingsComment + '\n\n<script>';
  html = html.replace('\n<script>', () => insertion);

  // 5. Write output
  fs.writeFileSync(outPath, html);
  const size = fs.statSync(outPath).size;
  console.log(`  ${path.basename(outPath)} (${(size / 1024).toFixed(1)} KB)`);
}

// CLI mode
if (require.main === module) {
  const [defPath, outPath] = process.argv.slice(2);
  if (!defPath || !outPath) {
    console.error('Usage: node make_example.js <def.json> <outPath>');
    process.exit(1);
  }
  const def = JSON.parse(fs.readFileSync(defPath, 'utf8'));
  makeExample({ ...def, outPath });
}

module.exports = makeExample;
