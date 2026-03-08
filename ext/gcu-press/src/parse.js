// Markdown to box/glue/penalty items (M1: plain text + headings)

function parseToItems(text, metrics, headingMetrics) {
  const paragraphs = [];
  const lines = text.split('\n');
  let current = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') {
      if (current.length > 0) {
        paragraphs.push(current.join(' '));
        current = [];
      }
    } else if (trimmed === '---' || trimmed === '***' || trimmed === '___') {
      if (current.length > 0) {
        paragraphs.push(current.join(' '));
        current = [];
      }
      paragraphs.push({ type: 'pagebreak' });
    } else if (trimmed.startsWith('# ')) {
      if (current.length > 0) {
        paragraphs.push(current.join(' '));
        current = [];
      }
      paragraphs.push({ type: 'heading', level: 1, text: trimmed.slice(2) });
    } else if (trimmed.startsWith('## ')) {
      if (current.length > 0) {
        paragraphs.push(current.join(' '));
        current = [];
      }
      paragraphs.push({ type: 'heading', level: 2, text: trimmed.slice(3) });
    } else if (trimmed.startsWith('### ')) {
      if (current.length > 0) {
        paragraphs.push(current.join(' '));
        current = [];
      }
      paragraphs.push({ type: 'heading', level: 3, text: trimmed.slice(4) });
    } else {
      current.push(trimmed);
    }
  }
  if (current.length > 0) {
    paragraphs.push(current.join(' '));
  }

  const allItems = [];

  for (const para of paragraphs) {
    if (para.type === 'pagebreak') {
      allItems.push({ type: 'pagebreak' });
      continue;
    }

    if (para.type === 'heading') {
      const level = para.level;
      const hm = headingMetrics[level - 1] || metrics;
      allItems.push({
        type: 'heading',
        level,
        items: headingToItems(para.text, hm),
        metrics: hm,
      });
      continue;
    }

    const items = paragraphToItems(para, metrics);
    allItems.push({ type: 'paragraph', items });
  }

  return allItems;
}

function wordToItems(word, metrics) {
  const hyphPts = findHyphenPoints(word);

  if (hyphPts.length === 0) {
    return [box(metrics.measure(word), word)];
  }

  // Split word at hyphenation points, insert discretionary hyphens
  const items = [];
  const hyphenWidth = metrics.measure('-');
  let prev = 0;

  for (const pt of hyphPts) {
    const frag = word.slice(prev, pt);
    items.push(box(metrics.measure(frag), frag));
    // Discretionary hyphen: penalty with width of hyphen character, flagged=true
    items.push(penalty(hyphenWidth, 50, true));
    prev = pt;
  }

  // Last fragment
  const last = word.slice(prev);
  items.push(box(metrics.measure(last), last));

  return items;
}

function paragraphToItems(text, metrics) {
  const words = text.split(/\s+/).filter(w => w.length > 0);
  const items = [];
  const sw = metrics.spaceWidth;

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const wItems = wordToItems(word, metrics);
    items.push(...wItems);

    if (i < words.length - 1) {
      // Inter-word glue: space with stretch and shrink
      // Stretch = 50% of space (allows moderate expansion)
      // Shrink = 33% of space (allows moderate compression)
      items.push(glue(sw, sw * 0.5, sw * 0.33));
    }
  }

  // Paragraph-end: finishing penalty + parfillskip glue + forced break
  items.push(penalty(0, INF_PENALTY, false));
  items.push(glue(0, INF_PENALTY, 0));
  items.push(penalty(0, NEG_INF_PENALTY, false));

  return items;
}

function headingToItems(text, metrics) {
  const words = text.split(/\s+/).filter(w => w.length > 0);
  const items = [];
  const sw = metrics.spaceWidth;

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const w = metrics.measure(word);
    const b = box(w, word);
    b.font = metrics.font;
    items.push(b);

    if (i < words.length - 1) {
      items.push(glue(sw, sw * 0.5, sw * 0.33));
    }
  }

  items.push(penalty(0, INF_PENALTY, false));
  items.push(glue(0, INF_PENALTY, 0));
  items.push(penalty(0, NEG_INF_PENALTY, false));

  return items;
}

export { parseToItems };
