// gcu-press — typesetting engine
// Knuth-Plass line breaking, page layout, canvas rendering.

// -- metrics.js --

// Font metrics via Canvas measureText

const _metricsCanvas = document.createElement('canvas');
const _metricsCtx = _metricsCanvas.getContext('2d');

function createMetrics(family, size, style) {
  const font = (style ? style + ' ' : '') + size + 'pt ' + family;
  _metricsCtx.font = font;

  const spaceWidth = _metricsCtx.measureText(' ').width;
  const emWidth = _metricsCtx.measureText('M').width;

  return {
    font,
    family,
    size,
    style: style || '',
    spaceWidth,
    emWidth,
    measure(text) {
      _metricsCtx.font = font;
      return _metricsCtx.measureText(text).width;
    },
  };
}

// -- linebreak.js --

// Knuth-Plass line breaking algorithm

function box(width, content) {
  return { type: 'box', width, content };
}

function glue(width, stretch, shrink) {
  return { type: 'glue', width, stretch, shrink };
}

function penalty(width, p, flagged) {
  return { type: 'penalty', width, penalty: p, flagged: flagged || false };
}

const INF_PENALTY = 10000;
const NEG_INF_PENALTY = -10000;
const TOLERANCE = 2;

function lineBreak(items, lineWidths) {
  const getWidth = typeof lineWidths === 'number'
    ? () => lineWidths
    : (i) => lineWidths[Math.min(i, lineWidths.length - 1)];

  // Two-pass like TeX: try normal, retry with emergencystretch if last line overflows
  const lines = lineBreakPass(items, getWidth, TOLERANCE, 0);
  if (lines.length > 0) {
    const last = lines[lines.length - 1];
    const lastTarget = getWidth(lines.length - 1);
    if (last.width > lastTarget + 0.5) {
      // Add emergencystretch: ~2em of extra stretch per line
      const emergency = 20;
      const retry = lineBreakPass(items, getWidth, TOLERANCE, emergency);
      if (retry.length > 0) return retry;
    }
  }
  return lines;
}

function lineBreakPass(items, getWidth, tolerance, emergencyStretch) {

  const active = [];
  active.push({
    index: 0, line: 0,
    totalWidth: 0, totalStretch: 0, totalShrink: 0,
    totalDemerits: 0, prev: null,
  });

  let sumWidth = 0, sumStretch = 0, sumShrink = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    if (item.type === 'box') {
      sumWidth += item.width;
    } else if (item.type === 'glue') {
      if (i > 0 && items[i - 1].type === 'box') {
        tryBreak(i);
      }
      sumWidth += item.width;
      sumStretch += item.stretch;
      sumShrink += item.shrink;
    } else if (item.type === 'penalty') {
      if (item.penalty < INF_PENALTY) {
        tryBreak(i);
      }
    }
  }

  function computePostBreakSums(breakIndex) {
    let sw = sumWidth, ss = sumStretch, sh = sumShrink;
    // If breaking at a glue, the glue is consumed by the break
    if (items[breakIndex].type === 'glue') {
      sw += items[breakIndex].width;
      ss += items[breakIndex].stretch;
      sh += items[breakIndex].shrink;
    }
    // Skip glue/penalties before the next box
    for (let k = breakIndex + 1; k < items.length; k++) {
      if (items[k].type === 'box') break;
      if (items[k].type === 'glue') {
        sw += items[k].width;
        ss += items[k].stretch;
        sh += items[k].shrink;
      } else if (items[k].type === 'penalty' && items[k].penalty <= NEG_INF_PENALTY) {
        break;
      }
    }
    return { sw, ss, sh };
  }

  function tryBreak(breakIndex) {
    const item = items[breakIndex];
    const isForcedBreak = item.type === 'penalty' && item.penalty <= NEG_INF_PENALTY;

    const len = active.length;
    const toRemove = [];
    const toAdd = [];

    // Track best deactivated node for emergency breaks
    let bestDeactivated = null;
    let bestDeactivatedR = Infinity;

    for (let j = 0; j < len; j++) {
      const node = active[j];
      const lineNum = node.line;
      const targetWidth = getWidth(lineNum);

      let w = sumWidth - node.totalWidth;
      let str = sumStretch - node.totalStretch + emergencyStretch;
      let shr = sumShrink - node.totalShrink;

      if (item.type === 'penalty') w += item.width;

      const diff = targetWidth - w;
      let r;
      if (diff > 0) {
        r = str > 0 ? diff / str : INF_PENALTY;
      } else if (diff < 0) {
        r = shr > 0 ? diff / shr : -INF_PENALTY;
      } else {
        r = 0;
      }

      // Create break if feasible OR forced
      if (Math.abs(r) <= tolerance || isForcedBreak) {
        const clampedR = Math.max(-1, Math.min(r, tolerance));
        const badness = Math.min(Math.pow(Math.abs(clampedR), 3) * 100, INF_PENALTY);
        const p = item.type === 'penalty' ? item.penalty : 0;
        let demerits;
        if (p >= 0) {
          demerits = Math.pow(1 + badness + p, 2);
        } else if (p > NEG_INF_PENALTY) {
          demerits = Math.pow(1 + badness, 2) - p * p;
        } else {
          demerits = Math.pow(1 + badness, 2);
        }

        // Heavily penalize overfull forced breaks (overfull last lines)
        // so KP prefers rearranging earlier lines to avoid them
        if (isForcedBreak && r < -1) {
          demerits += Math.pow(Math.abs(r), 3) * 100000;
        }

        if (item.flagged && node.index > 0 && items[node.index].type === 'penalty' && items[node.index].flagged) {
          demerits += 3000;
        }

        const totalD = node.totalDemerits + demerits;
        const { sw, ss, sh } = computePostBreakSums(breakIndex);

        let merged = false;
        for (const pending of toAdd) {
          if (pending.index === breakIndex && pending.line === lineNum + 1) {
            if (totalD < pending.totalDemerits) {
              pending.totalDemerits = totalD;
              pending.totalWidth = sw;
              pending.totalStretch = ss;
              pending.totalShrink = sh;
              pending.prev = node;
            }
            merged = true;
            break;
          }
        }

        if (!merged) {
          toAdd.push({
            index: breakIndex,
            line: lineNum + 1,
            totalWidth: sw,
            totalStretch: ss,
            totalShrink: sh,
            totalDemerits: totalD,
            prev: node,
          });
        }
      }

      // Mark for deactivation if too tight or forced
      if (r < -1 || isForcedBreak) {
        toRemove.push(j);
        // Track least-bad deactivated node for emergency
        if (Math.abs(r) < Math.abs(bestDeactivatedR)) {
          bestDeactivatedR = r;
          bestDeactivated = node;
        }
      }
    }

    // Remove deactivated nodes (reverse order)
    for (let k = toRemove.length - 1; k >= 0; k--) {
      active.splice(toRemove[k], 1);
    }

    // Add new nodes
    for (const n of toAdd) {
      active.push(n);
    }

    // Emergency: all nodes deactivated, no new breaks created.
    // Force an overfull break from the least-bad node, maintaining the chain.
    if (active.length === 0) {
      const emergency = bestDeactivated || { index: 0, line: 0,
        totalWidth: 0, totalStretch: 0, totalShrink: 0,
        totalDemerits: 0, prev: null };
      const { sw, ss, sh } = computePostBreakSums(breakIndex);
      active.push({
        index: breakIndex,
        line: emergency.line + 1,
        totalWidth: sw,
        totalStretch: ss,
        totalShrink: sh,
        totalDemerits: emergency.totalDemerits + INF_PENALTY * INF_PENALTY,
        prev: emergency,
      });
    }
  }

  // Find best active node
  if (active.length === 0) return [];

  let best = active[0];
  for (let i = 1; i < active.length; i++) {
    if (active[i].totalDemerits < best.totalDemerits) best = active[i];
  }

  // Backtrack to get breakpoints
  const breakpoints = [];
  let node = best;
  while (node) {
    breakpoints.unshift(node.index);
    node = node.prev;
  }

  return buildLines(items, breakpoints, getWidth, emergencyStretch);
}

function buildLines(items, breakpoints, getWidth, emergencyStretch) {
  const lines = [];
  const isLastLine = (b) => b === breakpoints.length - 2;

  for (let b = 0; b < breakpoints.length - 1; b++) {
    const start = breakpoints[b];
    const end = breakpoints[b + 1];
    const targetWidth = getWidth(b);

    const lineItems = [];
    let lineWidth = 0, lineStretch = 0, lineShrink = 0;
    let firstBox = true;

    for (let i = start; i <= end; i++) {
      const item = items[i];

      if (item.type === 'glue' && firstBox) continue;

      if (item.type === 'box') {
        firstBox = false;
        lineWidth += item.width;
        lineItems.push(item);
      } else if (item.type === 'glue' && i < end) {
        lineWidth += item.width;
        lineStretch += item.stretch;
        lineShrink += item.shrink;
        lineItems.push(item);
      } else if (item.type === 'penalty' && i === end) {
        if (item.width > 0) {
          lineWidth += item.width;
          lineItems.push({ type: 'box', width: item.width, content: '-' });
        }
      }
    }

    // Remove trailing glue
    while (lineItems.length > 0 && lineItems[lineItems.length - 1].type === 'glue') {
      const g = lineItems.pop();
      lineWidth -= g.width;
      lineStretch -= g.stretch;
      lineShrink -= g.shrink;
    }

    // Last line: ragged right, but still shrink if overfull
    const diff = targetWidth - lineWidth;
    let ratio = 0;
    // Count glue items for distributing emergency stretch
    const glueCount = lineItems.filter(it => it.type === 'glue').length;
    const esPerGlue = emergencyStretch > 0 && glueCount > 0 ? emergencyStretch / glueCount : 0;
    const totalStretch = lineStretch + (emergencyStretch || 0);
    if (!isLastLine(b)) {
      if (diff > 0 && totalStretch > 0) ratio = Math.min(diff / totalStretch, TOLERANCE);
      else if (diff < 0 && lineShrink > 0) ratio = Math.max(diff / lineShrink, -1);
    } else if (diff < 0 && lineShrink > 0) {
      ratio = Math.max(diff / lineShrink, -1);
    }

    const positioned = [];
    let x = 0;
    for (const item of lineItems) {
      if (item.type === 'box') {
        positioned.push({ x, text: item.content, font: item.font || null });
        x += item.width;
      } else if (item.type === 'glue') {
        let adjustedWidth = item.width;
        if (ratio > 0) adjustedWidth += ratio * (item.stretch + esPerGlue);
        else if (ratio < 0) adjustedWidth += ratio * item.shrink;
        x += adjustedWidth;
      }
    }

    lines.push({ items: positioned, width: x, ratio, lastLine: isLastLine(b) });
  }

  return lines;
}

// -- hyphenate.js --

// Simple English hyphenation
// Finds possible break points in words using vowel/consonant patterns,
// common prefixes/suffixes, and double consonant rules.
// Not as good as Liang's TeX patterns but dramatically improves KP output.

const VOWELS = 'aeiouy';
const isVowel = ch => VOWELS.includes(ch);
const isCons = ch => /[a-z]/.test(ch) && !isVowel(ch);

const PREFIXES = ['over', 'under', 'counter', 'super', 'anti', 'auto', 'inter', 'intro',
  'extra', 'infra', 'ultra', 'semi', 'trans', 'cross', 'multi', 'fore',
  'dis', 'mis', 'pre', 'pro', 'non', 'out', 'sub', 'un', 're'];

const SUFFIXES = ['tion', 'sion', 'ment', 'ness', 'able', 'ible', 'less', 'ence', 'ance',
  'ling', 'ful', 'ous', 'ive', 'ing', 'ist', 'ism', 'ize', 'ise',
  'ity', 'ery', 'ary', 'ory', 'ate', 'ent', 'ant', 'dom'];

// Consonant clusters that should not be broken
const CLUSTERS = new Set(['ch', 'sh', 'th', 'ph', 'wh', 'ck', 'gh', 'gn', 'kn', 'wr',
  'bl', 'br', 'cl', 'cr', 'dr', 'fl', 'fr', 'gl', 'gr', 'pl', 'pr',
  'sc', 'sk', 'sl', 'sm', 'sn', 'sp', 'st', 'sw', 'tr', 'tw',
  'scr', 'spl', 'spr', 'str', 'squ']);

function findHyphenPoints(word) {
  const min = 5; // don't hyphenate short words
  if (word.length < min) return [];
  const lw = word.toLowerCase();
  if (!/^[a-z]+$/.test(lw)) return []; // only pure alphabetic

  const points = new Set();
  const minBefore = 2; // at least 2 chars before hyphen
  const minAfter = 3;  // at least 3 chars after hyphen

  // 1. Prefix breaks
  for (const pfx of PREFIXES) {
    if (lw.startsWith(pfx) && lw.length - pfx.length >= minAfter) {
      // Only if remainder starts with consonant (avoid "re-elect" style but allow "re-mark")
      const after = lw[pfx.length];
      if (isCons(after) || pfx.length >= 3) {
        points.add(pfx.length);
      }
    }
  }

  // 2. Suffix breaks
  for (const sfx of SUFFIXES) {
    const pos = lw.length - sfx.length;
    if (pos >= minBefore && lw.endsWith(sfx)) {
      points.add(pos);
    }
  }

  // 3. Double consonant break (let-ter, run-ning)
  for (let i = minBefore; i < lw.length - minAfter; i++) {
    if (isCons(lw[i]) && lw[i] === lw[i + 1]) {
      points.add(i + 1);
    }
  }

  // 4. V-CV pattern: break before single consonant between vowels
  for (let i = minBefore; i < lw.length - minAfter; i++) {
    if (isVowel(lw[i - 1]) && isCons(lw[i]) && isVowel(lw[i + 1])) {
      // Check it's not part of a cluster
      const pair = lw.slice(i, i + 2);
      if (!CLUSTERS.has(pair)) {
        points.add(i);
      }
    }
  }

  // 5. VC-CV pattern: between two consonants surrounded by vowels
  for (let i = minBefore; i < lw.length - minAfter; i++) {
    if (i >= 2 && isVowel(lw[i - 2]) && isCons(lw[i - 1]) && isCons(lw[i]) && isVowel(lw[i + 1])) {
      const pair = lw.slice(i - 1, i + 1);
      // Don't break consonant clusters
      if (!CLUSTERS.has(pair)) {
        points.add(i);
      }
    }
  }

  // Filter, sort, and enforce minimum 2-char gap between consecutive points
  const sorted = [...points]
    .filter(p => p >= minBefore && p <= lw.length - minAfter)
    .sort((a, b) => a - b);

  const result = [];
  for (const p of sorted) {
    if (result.length === 0 || p - result[result.length - 1] >= 2) {
      result.push(p);
    }
  }

  return result;
}

// -- parse.js --

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

// -- layout.js --

// Page layout — vertical flow with page breaks

function layoutPages(parsedItems, pageSpec, metrics, headingMetrics) {
  const { w, h, margin } = pageSpec;
  const textWidth = w - margin.l - margin.r;
  const textHeight = h - margin.t - margin.b;
  const lineHeight = metrics.size * 1.5;
  const parSkip = metrics.size * 0.6;
  const indent = metrics.emWidth * 2;

  const pages = [];
  let currentPage = [];
  let y = 0;
  let isFirstPara = true;

  function newPage() {
    pages.push(currentPage);
    currentPage = [];
    y = 0;
  }

  for (const block of parsedItems) {
    if (block.type === 'pagebreak') {
      newPage();
      isFirstPara = true;
      continue;
    }

    if (block.type === 'heading') {
      const level = block.level;
      const hm = block.metrics || headingMetrics[level - 1] || metrics;
      const hLineHeight = hm.size * 1.5;
      const spaceBefore = level === 1 ? hm.size * 1.5 : hm.size;
      const spaceAfter = hm.size * 0.4;

      // Check if heading + at least one line fits
      if (y + spaceBefore + hLineHeight + lineHeight > textHeight && y > 0) {
        newPage();
      }

      y += spaceBefore;

      // Break heading lines
      const hTextWidth = textWidth;
      const hLines = lineBreak(block.items, hTextWidth);

      for (const line of hLines) {
        if (y + hLineHeight > textHeight) {
          newPage();
        }
        currentPage.push({
          type: 'line',
          items: line.items,
          x: margin.l,
          y: margin.t + y,
          font: hm.font,
          size: hm.size,
        });
        y += hLineHeight;
      }

      y += spaceAfter;
      isFirstPara = true;
      continue;
    }

    if (block.type === 'paragraph') {
      // Paragraph spacing
      if (!isFirstPara) {
        y += parSkip;
      }

      // First line of non-first paragraphs gets indent — tell KP about shorter first line
      const hasIndent = !isFirstPara;
      const lineWidths = hasIndent ? [textWidth - indent, textWidth] : textWidth;
      const lines = lineBreak(block.items, lineWidths);

      for (let i = 0; i < lines.length; i++) {
        if (y + lineHeight > textHeight) {
          newPage();
        }

        const xOffset = i === 0 && hasIndent ? indent : 0;

        currentPage.push({
          type: 'line',
          items: lines[i].items,
          x: margin.l + xOffset,
          y: margin.t + y,
          font: metrics.font,
          size: metrics.size,
        });
        y += lineHeight;
      }

      isFirstPara = false;
    }
  }

  // Push final page
  pages.push(currentPage);

  // Remove empty trailing pages
  while (pages.length > 1 && pages[pages.length - 1].length === 0) {
    pages.pop();
  }

  return pages;
}

// -- render.js --

// Render typeset pages to canvases

function renderPage(canvas, page, pageSpec, pageNum, totalPages, defaultFont) {
  const { w, h, margin } = pageSpec;
  const dpr = window.devicePixelRatio || 1;

  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // White page background
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);

  // Render lines
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'top';
  for (const line of page) {
    if (line.type !== 'line') continue;

    const font = line.font || defaultFont;
    ctx.font = font;

    for (const item of line.items) {
      if (item.font) ctx.font = item.font;
      else ctx.font = font;
      ctx.fillText(item.text, line.x + item.x, line.y);
    }
  }

  // Page number in footer
  ctx.textBaseline = 'alphabetic';
  ctx.font = '8pt serif';
  ctx.fillStyle = '#666';
  const numText = String(pageNum);
  const numWidth = ctx.measureText(numText).width;
  ctx.fillText(numText, (w - numWidth) / 2, h - margin.b * 0.4);
}

function renderPages(pages, pageSpec, defaultFont) {
  const canvases = [];
  for (let i = 0; i < pages.length; i++) {
    const canvas = document.createElement('canvas');
    renderPage(canvas, pages[i], pageSpec, i + 1, pages.length, defaultFont);
    canvases.push(canvas);
  }
  return canvases;
}
