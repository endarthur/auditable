#!/usr/bin/env node
// Injects cell data into auditable.html to produce a standalone example notebook.
// Usage: require('./make_example')({ title, cells, settings?, outPath })
//   or:  node make_example.js <example_def.json> <outPath>

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function encodeModules(obj) {
  const b64 = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
  return b64.replace(/.{1,76}/g, '$&\n').trimEnd();
}

// Gzip + base64 the JS runtime, return data element + self-extracting loader.
// Same as compressRuntime() in save.js but using Node zlib (sync).
function compressRuntimeNode(script) {
  const compressed = zlib.gzipSync(Buffer.from(script, 'utf8'));
  const b64 = compressed.toString('base64').replace(/.{1,76}/g, '$&\n');
  const loader =
    '(function(){var me=document.scripts[document.scripts.length-1];(async function(){' +
    "var b=document.getElementById('_rt').textContent.replace(/\\\\s/g,'');" +
    'var d=Uint8Array.from(atob(b),function(c){return c.charCodeAt(0)});' +
    "var s=await new Response(new Blob([d]).stream().pipeThrough(new DecompressionStream('gzip'))).text();" +
    "me.textContent=s;document.getElementById('_rt').remove();" +
    '(0,eval)(s)})()})()';
  return `<script type="text/plain" id="_rt">\n${b64}</script>\n<script>\n${loader}\n</script>`;
}

function makeExample({ title, cells, settings, modules, outPath }) {
  const basePath = path.join(__dirname, 'build', 'auditable.html');
  if (!fs.existsSync(basePath)) {
    throw new Error('build/auditable.html not found — run `node build.js` first');
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
  const dataComment = '<!-- cell data: JSON array of {type, code, collapsed?} -->\n<!--AUDITABLE-DATA\n' + JSON.stringify(cells) + '\nAUDITABLE-DATA-->';
  const modulesComment = modules ? '<!-- installed modules: base64-encoded JSON mapping URLs to {source, cellId, compressed?, binary?, type?} -->\n<!--AUDITABLE-MODULES\n' + encodeModules(modules) + '\nAUDITABLE-MODULES-->' : '';
  const settingsComment = '<!-- notebook settings: JSON {theme, fontSize, width, ...} -->\n<!--AUDITABLE-SETTINGS\n' + JSON.stringify(settings || { theme: 'dark', fontSize: 13, width: '860' }) + '\nAUDITABLE-SETTINGS-->';

  // 4. Compress the runtime (gzip+base64 with self-extracting loader)
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!scriptMatch) throw new Error('Could not find <script> block in auditable.html');
  const scriptContent = scriptMatch[1].trim();
  const compressedBlock = compressRuntimeNode(scriptContent);

  // 5. Replace: insert data before script, replace script with compressed version
  const insertion = '\n' + dataComment + '\n' + (modulesComment ? modulesComment + '\n' : '') + settingsComment + '\n\n';
  html = html.replace(/\n<script>[\s\S]*?<\/script>/, () => insertion + compressedBlock);

  // 6. Write output
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
