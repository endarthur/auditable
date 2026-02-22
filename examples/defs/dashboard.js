const { workshopCell } = require('../workshop-helpers');

module.exports = {
  file: 'example_dashboard.html',
  title: 'data dashboard',
  cells: [
    workshopCell('Data dashboard', [
      `{
    title: 'CSS cells',
    content: md\`The \\\`css\\\` cell type injects a
\\\`<style>\\\` element into the page. CSS cells don\\u2019t
participate in the DAG \\u2014 they\\u2019re static side
effects that apply globally.

Use CSS variables like \\\`var(--accent)\\\` and
\\\`var(--border)\\\` to stay consistent with the
notebook theme. The dashboard stat cards are styled
entirely via the CSS cell.\`
  }`,
      `{
    title: 'HTML template cells',
    content: md\`The \\\`html\\\` cell type renders its content
as HTML with **reactive interpolation**. Expressions
like \\\`\\\${filtered.length}\\\` are evaluated using
the current scope.

HTML cells are **read-only** in the DAG \\u2014 they
consume variables but don\\u2019t define any. When upstream
values change, the HTML re-renders automatically.
This is how the stat cards update when you type in
the search box.\`
  }`,
      `{
    title: 'Tables & text input',
    content: md\`\\\`ui.table(data, columns)\\\` renders a
sortable table from an array of objects.
\\\`ui.textInput(label, default)\\\` returns the current
string value reactively.

The filter cell computes \\\`filtered\\\`, \\\`totalPop\\\`,
\\\`avgLat\\\`, and \\\`nCountries\\\` from the raw data. Both
the HTML cell and the table cell consume these
computed values \\u2014 change the search text and
everything downstream updates.\`
  }`,
      `{
    title: 'Expression interpolation',
    content: md\`In HTML cells, \\\`\\\${expr}\\\` evaluates
JavaScript against the notebook scope. The expression
can reference any variable defined by upstream
code cells.

The DAG engine uses \\\`findHtmlUses()\\\` to detect
which scope names appear in \\\`\\\${...}\\\` blocks,
ensuring the HTML cell re-renders when its
dependencies change. Only \\\`\\\${...}\\\` expressions are
evaluated \\u2014 plain text and HTML are passed through
as-is.\`
  }`
    ]),
    { type: 'md', code: "# world cities dashboard\n\ndemonstrates **css cells** for custom styling, **html cells** for reactive templates, `ui.table()` for data display, and `ui.textInput()` for filtering." },
    { type: 'css', code: ".dashboard-stat {\n  display: inline-block;\n  padding: 8px 16px;\n  margin: 4px;\n  border: 1px solid var(--border);\n  background: var(--bg2);\n  min-width: 120px;\n  text-align: center;\n}\n.dashboard-stat .value {\n  font-size: 20px;\n  color: var(--accent);\n}\n.dashboard-stat .label {\n  font-size: 9px;\n  letter-spacing: 2px;\n  text-transform: uppercase;\n  color: var(--fg-dim);\n}" },
    { type: 'code', code: "const cities = [\n  { city: \"Tokyo\",         country: \"Japan\",     pop: 37.4,  lat: 35.68,  lon: 139.69 },\n  { city: \"Delhi\",         country: \"India\",     pop: 32.9,  lat: 28.61,  lon: 77.23  },\n  { city: \"Shanghai\",      country: \"China\",     pop: 29.2,  lat: 31.23,  lon: 121.47 },\n  { city: \"S\\u00e3o Paulo\",     country: \"Brazil\",    pop: 22.6,  lat: -23.55, lon: -46.63 },\n  { city: \"Mexico City\",   country: \"Mexico\",    pop: 22.1,  lat: 19.43,  lon: -99.13 },\n  { city: \"Cairo\",         country: \"Egypt\",     pop: 21.8,  lat: 30.04,  lon: 31.24  },\n  { city: \"Dhaka\",         country: \"Bangladesh\",pop: 23.2,  lat: 23.81,  lon: 90.41  },\n  { city: \"Mumbai\",        country: \"India\",     pop: 21.7,  lat: 19.08,  lon: 72.88  },\n  { city: \"Beijing\",       country: \"China\",     pop: 21.5,  lat: 39.90,  lon: 116.41 },\n  { city: \"Osaka\",         country: \"Japan\",     pop: 19.1,  lat: 34.69,  lon: 135.50 },\n  { city: \"New York\",      country: \"USA\",       pop: 18.8,  lat: 40.71,  lon: -74.01 },\n  { city: \"Karachi\",       country: \"Pakistan\",  pop: 16.8,  lat: 24.86,  lon: 67.01  },\n  { city: \"Chongqing\",     country: \"China\",     pop: 16.4,  lat: 29.43,  lon: 106.91 },\n  { city: \"Istanbul\",      country: \"Turkey\",    pop: 15.6,  lat: 41.01,  lon: 28.98  },\n  { city: \"Buenos Aires\",  country: \"Argentina\", pop: 15.4,  lat: -34.60, lon: -58.38 },\n  { city: \"Lagos\",         country: \"Nigeria\",   pop: 15.3,  lat: 6.52,   lon: 3.38   },\n  { city: \"Kolkata\",       country: \"India\",     pop: 15.1,  lat: 22.57,  lon: 88.36  },\n  { city: \"Manila\",        country: \"Philippines\",pop: 14.4, lat: 14.60,  lon: 120.98 },\n  { city: \"Guangzhou\",     country: \"China\",     pop: 13.9,  lat: 23.13,  lon: 113.26 },\n  { city: \"Rio de Janeiro\",country: \"Brazil\",    pop: 13.6,  lat: -22.91, lon: -43.17 }\n];" },
    { type: 'code', code: "// controls\nconst search = ui.textInput(\"search\", \"\");\nconst topN = ui.slider(\"show top\", 20, { min: 5, max: 20, step: 1 });\nconst hemisphere = ui.dropdown(\"hemisphere\", [\"all\", \"northern\", \"southern\"]);" },
    { type: 'code', code: "// filter\nconst term = search.toLowerCase();\nconst filtered = cities\n  .filter(c => {\n    if (term && !c.city.toLowerCase().includes(term) && !c.country.toLowerCase().includes(term)) return false;\n    if (hemisphere === \"northern\" && c.lat < 0) return false;\n    if (hemisphere === \"southern\" && c.lat >= 0) return false;\n    return true;\n  })\n  .slice(0, topN);\nconst totalPop = filtered.reduce((s, c) => s + c.pop, 0);\nconst avgLat = filtered.length ? (filtered.reduce((s, c) => s + c.lat, 0) / filtered.length) : 0;\nconst nCountries = new Set(filtered.map(c => c.country)).size;" },
    { type: 'html', code: "<div style=\"margin:8px 0\">\n  <div class=\"dashboard-stat\"><div class=\"value\">${filtered.length}</div><div class=\"label\">cities</div></div>\n  <div class=\"dashboard-stat\"><div class=\"value\">${nCountries}</div><div class=\"label\">countries</div></div>\n  <div class=\"dashboard-stat\"><div class=\"value\">${totalPop.toFixed(1)}M</div><div class=\"label\">total pop</div></div>\n  <div class=\"dashboard-stat\"><div class=\"value\">${avgLat.toFixed(1)}&deg;</div><div class=\"label\">avg latitude</div></div>\n</div>" },
    { type: 'code', code: "ui.table(filtered, [\"city\", \"country\", \"pop\", \"lat\", \"lon\"]);" }
  ]
};
