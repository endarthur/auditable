// ── XML builder ──

export function tag(name, attrs, ...children) {
  let s = '<' + name;
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v !== undefined && v !== null) s += ` ${k}="${escape(String(v))}"`;
    }
  }
  if (children.length === 0) return s + '/>';
  s += '>';
  for (const child of children) {
    if (child !== undefined && child !== null) s += String(child);
  }
  return s + `</${name}>`;
}

export function escape(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function unescape(str) {
  return str.replace(/&apos;/g, "'").replace(/&quot;/g, '"')
            .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

// Strip namespace prefix: "x:row" → "row"
function stripNS(name) {
  const i = name.indexOf(':');
  return i === -1 ? name : name.substring(i + 1);
}

// ── Minimal XML parser ──
// Handles the subset xlsx uses: elements, attributes, text. No CDATA, no DTD.

export function parseXml(str) {
  const root = { tag: '', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;

  while (i < str.length) {
    if (str[i] === '<') {
      // processing instruction
      if (str[i + 1] === '?') {
        i = str.indexOf('?>', i) + 2;
        continue;
      }
      // closing tag
      if (str[i + 1] === '/') {
        i = str.indexOf('>', i) + 1;
        stack.pop();
        continue;
      }
      const end = str.indexOf('>', i);
      const selfClose = str[end - 1] === '/';
      const raw = str.substring(i + 1, selfClose ? end - 1 : end);

      // split tag name from attributes
      const sp = raw.search(/[\s]/);
      const tagName = stripNS(sp === -1 ? raw : raw.substring(0, sp));
      const attrs = {};

      if (sp !== -1) {
        const attrStr = raw.substring(sp);
        const re = /([\w:.+-]+)="([^"]*)"/g;
        let m;
        while ((m = re.exec(attrStr)) !== null) {
          attrs[stripNS(m[1])] = unescape(m[2]);
        }
      }

      const node = { tag: tagName, attrs, children: [], text: '' };
      stack[stack.length - 1].children.push(node);
      if (!selfClose) stack.push(node);
      i = end + 1;
    } else {
      const next = str.indexOf('<', i);
      const text = next === -1 ? str.substring(i) : str.substring(i, next);
      if (text) stack[stack.length - 1].text += text;
      i = next === -1 ? str.length : next;
    }
  }

  return root.children[0] || root;
}

// ── Tree navigation ──

export function find(node, tagName) {
  if (node.tag === tagName) return node;
  for (const child of node.children) {
    const found = find(child, tagName);
    if (found) return found;
  }
  return null;
}

export function findAll(node, tagName) {
  const results = [];
  if (node.tag === tagName) results.push(node);
  for (const child of node.children) {
    findAll(child, tagName).forEach(n => results.push(n));
  }
  return results;
}
