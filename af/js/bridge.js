import { AFS, $ } from './state.js';
import { writeEntry } from './fs.js';
import { dehydrate, extractNotebook, storeModuleBlobs, toTxt } from './notebook.js';
import { findTabBySource, markDirty, markClean, renderTabBar, setStatus, updateStatusBar, handleStorageMessage } from './tabs.js';

// ── postMessage BRIDGE ──

const pendingSerialize = new Map(); // tabId → { resolve, timer }

function initBridge() {
  window.addEventListener('message', handleMessage);
}

function handleMessage(event) {
  const msg = event.data;
  if (!msg?.type || !msg.type.startsWith('af:')) return;

  const tab = findTabBySource(event.source);
  if (!tab) return;

  switch (msg.type) {
    case 'af:ready': {
      if (msg.payload?.title) {
        tab.title = msg.payload.title;
        renderTabBar();
      }
      break;
    }

    case 'af:serialized': {
      const pending = pendingSerialize.get(tab.id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingSerialize.delete(tab.id);
        pending.resolve(msg.payload?.html || null);
      }
      break;
    }

    case 'af:dirty': {
      markDirty(tab.id);
      break;
    }

    case 'af:titleChanged': {
      if (msg.payload?.title) {
        tab.title = msg.payload.title;
        renderTabBar();
        updateStatusBar();
      }
      break;
    }

    case 'af:storage': {
      if (msg.payload) handleStorageMessage(tab, msg.payload);
      break;
    }
  }
}

function requestSerialize(tabId) {
  return new Promise((resolve, reject) => {
    const tab = AFS.tabs.find(t => t.id === tabId);
    if (!tab?.iframe?.contentWindow) {
      reject(new Error('no iframe for tab'));
      return;
    }

    const timer = setTimeout(() => {
      pendingSerialize.delete(tabId);
      reject(new Error('serialize timeout'));
    }, 5000);

    pendingSerialize.set(tabId, { resolve, timer });
    tab.iframe.contentWindow.postMessage({ type: 'af:serialize' }, '*');
  });
}

async function saveActiveTab() {
  const tab = AFS.tabs.find(t => t.id === AFS.activeTabId);
  if (!tab) return;

  try {
    const html = await requestSerialize(tab.id);
    if (!html) {
      setStatus('save failed: no content');
      return;
    }

    // choose format based on path extension and storage backend
    const root = AFS.roots[tab.rootIndex];
    let content = html;
    if (tab.path.endsWith('.txt')) {
      const notebook = extractNotebook(html);
      if (notebook) {
        await storeModuleBlobs(notebook);
        content = toTxt(notebook);
      }
    } else if (root && root.type === 'box') {
      const lightweight = await dehydrate(html);
      if (lightweight) content = lightweight;
    }

    await writeEntry(tab.rootIndex, tab.path, content);
    tab.iframe.contentWindow.postMessage({ type: 'af:saved' }, '*');
    markClean(tab.id);
    setStatus('saved ' + tab.title);
  } catch (err) {
    console.error('save error:', err);
    setStatus('save failed: ' + err.message);
  }
}

async function saveAllTabs() {
  for (const tab of AFS.tabs) {
    if (!tab.dirty) continue;
    try {
      const html = await requestSerialize(tab.id);
      if (html) {
        // choose format based on path extension and storage backend
        const root = AFS.roots[tab.rootIndex];
        let content = html;
        if (tab.path.endsWith('.txt')) {
          const notebook = extractNotebook(html);
          if (notebook) {
            await storeModuleBlobs(notebook);
            content = toTxt(notebook);
          }
        } else if (root && root.type === 'box') {
          const lightweight = await dehydrate(html);
          if (lightweight) content = lightweight;
        }
        await writeEntry(tab.rootIndex, tab.path, content);
        tab.iframe.contentWindow.postMessage({ type: 'af:saved' }, '*');
        markClean(tab.id);
      }
    } catch (err) {
      console.error('save error for', tab.path, err);
    }
  }
  setStatus('all saved');
}
