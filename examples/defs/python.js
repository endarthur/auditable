const { workshopCell } = require('../workshop-helpers');

module.exports = {
  file: 'example_python.html',
  title: 'python mode',
  cells: [
    workshopCell('Python mode', [
      `{
    title: 'Virtual modules',
    content: md\`\\\`load("@python")\\\` imports a **virtual
module** \\u2014 it\\u2019s not a URL, it\\u2019s a built-in module
bundled with auditable. Virtual modules use the
\\\`@\\\` prefix: \\\`@python\\\`, \\\`@std\\\`, \\\`@python/this\\\`.

The Python module provides \\\`range\\\`, \\\`enumerate\\\`,
\\\`sorted\\\`, \\\`reversed\\\`, \\\`len\\\`, and other Python-like
utilities that work on JavaScript arrays and
iterables.\`
  }`,
      `{
    title: 'Pythonic JavaScript',
    content: md\`The imported functions make JS read like
Python: \\\`for (const [i, x] of enumerate(arr))\\\`,
\\\`sorted(data, key)\\\`, \\\`range(0, 10, 2)\\\`.

Semicolons are optional in JS (the engine inserts
them via ASI). This example omits them for a more
Pythonic feel. \\\`print\\\` is a built-in alias for
\\\`ui.display\\\` \\u2014 no import needed.\`
  }`,
      `{
    title: 'The std library',
    content: md\`Every cell receives \\\`std\\\` as an injected
parameter. It provides statistical functions:
\\\`std.mean\\\`, \\\`std.median\\\`, \\\`std.extent\\\`,
\\\`std.sum\\\`, \\\`std.bin\\\`, \\\`std.linspace\\\`, and more.

You can also \\\`load("@std")\\\` to destructure specific
functions. The \\\`std\\\` object and \\\`@python\\\`
complement each other \\u2014 Python-style iteration
plus statistical aggregation.\`
  }`
    ]),
    { type: 'md', code: "# python mode\n\n`load(\"@python\")` gives you `range`, `enumerate`, `sorted`, `reversed`, `len` and more \u2014 so your JS can read like Python. `print` is a built-in alias for `ui.display`.\n\nnote: semicolons are idiomatic JS but not required \u2014 the browser engine inserts them automatically (ASI). this example skips them for a more pythonic feel." },
    { type: 'code', code: "const { range, enumerate, sorted, reversed, len } = await load(\"@python\")" },
    { type: 'code', code: "// generate some fake sensor data\nconst sensors = []\nfor (const i of range(20)) {\n  sensors.push({\n    id: `sensor-${i}`,\n    temp: 18 + Math.random() * 15,\n    humidity: 30 + Math.random() * 60,\n    active: Math.random() > 0.2\n  })\n}\n\nprint(`generated ${len(sensors)} sensors`)" },
    { type: 'code', code: "// filter & sort \u2014 pythonic style\nconst active = sensors.filter(s => s.active)\nconst by_temp = sorted(active, s => s.temp)\nconst by_temp_desc = reversed(by_temp)\n\nprint(`${len(active)} of ${len(sensors)} sensors active`)\nprint(`coldest: ${by_temp[0].id} at ${by_temp[0].temp.toFixed(1)}\\u00b0C`)\nprint(`hottest: ${by_temp_desc[0].id} at ${by_temp_desc[0].temp.toFixed(1)}\\u00b0C`)" },
    { type: 'code', code: "// enumerate for indexed iteration\nconst top5 = by_temp_desc.slice(0, 5)\n\nprint(\"\\n\\u2014 top 5 hottest sensors \\u2014\")\nfor (const [i, s] of enumerate(top5)) {\n  print(`  ${i + 1}. ${s.id}  ${s.temp.toFixed(1)}\\u00b0C  ${s.humidity.toFixed(0)}% RH`)\n}" },
    { type: 'code', code: "// combine with std for stats\nprint(`\\nmean temp:   ${std.mean(active, s => s.temp).toFixed(1)}\\u00b0C`)\nprint(`median temp: ${std.median(active, s => s.temp).toFixed(1)}\\u00b0C`)\n\nconst [lo, hi] = std.extent(active, s => s.humidity)\nprint(`humidity range: ${lo.toFixed(0)}% \\u2013 ${hi.toFixed(0)}%`)" },
    { type: 'code', code: "// range for quick sequences\nprint(\"range(5):         \" + range(5))\nprint(\"range(2, 8):      \" + range(2, 8))\nprint(\"range(0, 20, 3):  \" + range(0, 20, 3))\nprint(\"range(10, 0, -2): \" + range(10, 0, -2))" },
    { type: 'code', code: "// the easter egg\nawait load(\"@python/this\")" }
  ]
};
