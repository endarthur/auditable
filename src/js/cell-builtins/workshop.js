// Workshop builtin — slide-out side panel with navigable pages.
// Used by 14 example notebooks (basics/, etc/, extensions/, geology/),
// so it's bundled but lives in its own module rather than inline in
// the cell-context factory (where it didn't belong).

import { S } from '../state.js';
import { TaggedContent } from '../engine.js';
import { renderMd } from '../markdown.js';
import * as hooks from '../hooks.js';

/**
 * Returns a workshop(pages, opts) function bound to this cell + ctx.
 * The function creates singleton DOM (one panel per notebook) reused
 * across cell re-runs. State (current page index) persists via cell._inputs.
 */
export function makeWorkshop(cell, ctx) {
  const { invalidation, usedWidgets } = ctx;

  return function workshop(pages, opts) {
    const key = '__workshop__';
    usedWidgets.add(key);
    const useOverlay = !!(opts && opts.overlay);

    if (cell._inputs[key] === undefined) cell._inputs[key] = 0;
    let currentPage = cell._inputs[key];

    let panel = document.getElementById('workshopPanel');
    let overlay = document.getElementById('workshopOverlay');
    if (!panel) {
      overlay = document.createElement('div');
      overlay.id = 'workshopOverlay';
      overlay.className = 'workshop-overlay';
      overlay.onclick = () => toggleWorkshop(false);
      document.body.appendChild(overlay);

      panel = document.createElement('div');
      panel.id = 'workshopPanel';
      panel.className = 'workshop-panel';
      document.body.appendChild(panel);
    }

    let toggleBtn = document.getElementById('workshopToggle');
    if (!toggleBtn) {
      toggleBtn = document.createElement('button');
      toggleBtn.id = 'workshopToggle';
      toggleBtn.className = 'workshop-tab';
      toggleBtn.title = 'toggle workshop panel';
      toggleBtn.textContent = 'workshop';
      document.body.appendChild(toggleBtn);
      toggleBtn.onclick = () => toggleWorkshop();
    }

    function toggleWorkshop(show) {
      const isOpen = panel.classList.contains('open');
      const shouldOpen = show !== undefined ? show : !isOpen;
      panel.classList.toggle('open', shouldOpen);
      if (useOverlay) overlay.classList.toggle('visible', shouldOpen);
    }

    function renderPage(idx) {
      idx = Math.max(0, Math.min(idx, pages.length - 1));
      currentPage = idx;
      cell._inputs[key] = idx;
      const page = pages[idx];

      panel.innerHTML = '';

      const header = document.createElement('div');
      header.className = 'workshop-header';
      const title = document.createElement('span');
      title.className = 'workshop-title';
      title.textContent = page.title || `Page ${idx + 1}`;
      header.appendChild(title);
      const closeBtn = document.createElement('button');
      closeBtn.className = 'workshop-close';
      closeBtn.textContent = '×';
      closeBtn.onclick = () => toggleWorkshop(false);
      header.appendChild(closeBtn);
      panel.appendChild(header);

      const body = document.createElement('div');
      body.className = 'workshop-body';
      if (page.content instanceof Element) {
        body.appendChild(page.content);
      } else if (page.content instanceof TaggedContent) {
        if (page.content.type === 'md') {
          body.innerHTML = renderMd(page.content.content);
        } else if (page.content.type === 'css') {
          const pre = document.createElement('pre');
          pre.textContent = page.content.content;
          body.appendChild(pre);
        } else {
          body.innerHTML = page.content.content;
        }
      } else {
        body.textContent = String(page.content ?? '');
      }
      panel.appendChild(body);

      const pips = document.createElement('div');
      pips.className = 'workshop-pips';
      for (let i = 0; i < pages.length; i++) {
        const pip = document.createElement('span');
        pip.className = 'workshop-pip' + (i === idx ? ' active' : '') + (i < idx ? ' done' : '');
        pip.onclick = () => navigate(i);
        pips.appendChild(pip);
      }
      panel.appendChild(pips);

      const nav = document.createElement('div');
      nav.className = 'workshop-nav';
      if (idx > 0) {
        const prev = document.createElement('button');
        prev.textContent = '← prev';
        prev.onclick = () => navigate(idx - 1);
        nav.appendChild(prev);
      }
      const spacer = document.createElement('span');
      spacer.style.flex = '1';
      nav.appendChild(spacer);
      const counter = document.createElement('span');
      counter.className = 'workshop-counter';
      counter.textContent = `${idx + 1} / ${pages.length}`;
      nav.appendChild(counter);
      if (idx < pages.length - 1) {
        const next = document.createElement('button');
        next.className = 'workshop-next';
        next.textContent = 'next →';
        if (page.canAdvance && !page.canAdvance()) {
          next.disabled = true;
          next.title = 'complete the task to continue';
        }
        next.onclick = () => navigate(idx + 1);
        nav.appendChild(next);
      }
      panel.appendChild(nav);

      if (page.onEnter) page.onEnter();
    }

    function navigate(idx) {
      const prevPage = pages[currentPage];
      if (prevPage?.onLeave) prevPage.onLeave();
      renderPage(idx);
    }

    cell._workshopRecheck = () => {
      const page = pages[currentPage];
      if (!page?.canAdvance) return;
      const nextBtn = panel.querySelector('.workshop-next');
      if (nextBtn) nextBtn.disabled = !page.canAdvance();
    };

    renderPage(currentPage);

    if (!panel.classList.contains('open') && !cell._workshopShown) {
      toggleWorkshop(true);
      cell._workshopShown = true;
    }

    cell._workshopCleanup = () => {
      panel.remove();
      overlay.remove();
      toggleBtn.remove();
      cell._workshopRecheck = null;
    };
    invalidation.then(() => { cell._workshopRecheck = null; });

    return { goto: navigate, toggle: toggleWorkshop, recheck: cell._workshopRecheck };
  };
}

// Hook: re-check `canAdvance` on every cell that has an active workshop
// after each DAG run. Replaces the inline loop in exec.js.runDAG.
hooks.on('dag:complete', () => {
  for (const c of S.cells) {
    if (c._workshopRecheck) c._workshopRecheck();
  }
});
