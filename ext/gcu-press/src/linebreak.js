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

export { box, glue, penalty, lineBreak, INF_PENALTY, NEG_INF_PENALTY };
