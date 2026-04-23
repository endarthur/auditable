// @gcu/rails — state operations
// Pure functions over the State tree. Zero DOM, zero imports.
//
// State shape (informative, see SPEC-rails §3):
//   State  = { rails: Rail[], floats: Float[] }           — floats deferred to next pass
//   Rail   = { id, flex, width?, stacks: Stack[] }
//   Stack  = { id, flex, height?, tabs: Tab[], active, tabPosition? }
//   Tab    = { id, title, closeable?, draggable?, ...consumer }

let _nextIdCounter = 1;

// Bare numeric id — only safe when state is empty or ids don't collide.
// Prefer freshId(state, prefix) for runtime insertions.
export function makeId(prefix) {
  return prefix + (_nextIdCounter++).toString(36);
}

// Collect every id currently in state (rails, stacks, tabs, floats).
function collectIds(state) {
  const used = new Set();
  for (const rail of state.rails || []) {
    if (rail.id) used.add(rail.id);
    for (const stack of rail.stacks || []) {
      if (stack.id) used.add(stack.id);
      for (const tab of stack.tabs || []) {
        if (tab.id) used.add(tab.id);
      }
    }
  }
  for (const float of state.floats || []) {
    if (float.id) used.add(float.id);
    for (const tab of float.stack?.tabs || []) {
      if (tab.id) used.add(tab.id);
    }
  }
  return used;
}

// Generate an id with the given prefix that doesn't collide with anything
// currently in state. Use this for any id created at runtime — seed states
// with user-chosen ids (e.g., 's1', 's2', 'r1') are common and will
// otherwise clash with naive counter-based ids.
export function freshId(state, prefix) {
  const used = collectIds(state);
  while (true) {
    const id = prefix + (_nextIdCounter++).toString(36);
    if (!used.has(id)) return id;
  }
}

export function findTab(state, tabId) {
  for (const rail of state.rails) {
    for (const stack of rail.stacks) {
      const idx = stack.tabs.findIndex(t => t.id === tabId);
      if (idx >= 0) return { rail, stack, tab: stack.tabs[idx], idx, container: 'rail' };
    }
  }
  for (const float of state.floats || []) {
    if (!float.stack) continue;
    const idx = float.stack.tabs.findIndex(t => t.id === tabId);
    if (idx >= 0) return { float, stack: float.stack, tab: float.stack.tabs[idx], idx, container: 'float' };
  }
  return null;
}

export function findFloat(state, floatId) {
  for (const float of state.floats || []) {
    if (float.id === floatId) return float;
  }
  return null;
}

export function findStack(state, stackId) {
  for (const rail of state.rails) {
    for (const stack of rail.stacks) {
      if (stack.id === stackId) return { rail, stack, container: 'rail' };
    }
  }
  for (const float of state.floats || []) {
    if (float.stack && float.stack.id === stackId) {
      return { float, stack: float.stack, container: 'float' };
    }
  }
  return null;
}

export function findRail(state, railId) {
  for (const rail of state.rails) {
    if (rail.id === railId) return rail;
  }
  return null;
}

// Remove a tab from its stack. Returns the removed Tab or null.
// Leaves the stack potentially empty; call cleanup(instance) after.
export function removeTabFromStack(state, tabId) {
  const hit = findTab(state, tabId);
  if (!hit) return null;
  hit.stack.tabs.splice(hit.idx, 1);
  if (hit.stack.active === tabId && hit.stack.tabs.length) {
    const fallback = Math.max(0, hit.idx - 1);
    hit.stack.active = hit.stack.tabs[fallback].id;
  }
  return hit.tab;
}

// Cleanup pass: drop empty stacks, empty rails, empty floats. Reselect active
// when needed.
//
// Caller is responsible for deciding when to evict panels: closeTab evicts,
// moveTab does not. This function handles the structural cleanup of empty
// containers and does NOT touch the panel cache.
export function cleanup(state) {
  for (const rail of state.rails) {
    rail.stacks = rail.stacks.filter(s => s.tabs.length > 0);
    for (const s of rail.stacks) {
      if (!s.tabs.find(t => t.id === s.active)) {
        s.active = s.tabs[0].id;
      }
    }
  }
  state.rails = state.rails.filter(r => r.stacks.length > 0);

  // Empty float's stack → float removed entirely (invariant 3).
  if (Array.isArray(state.floats)) {
    state.floats = state.floats.filter(f => f.stack && f.stack.tabs.length > 0);
    for (const f of state.floats) {
      if (!f.stack.tabs.find(t => t.id === f.stack.active)) {
        f.stack.active = f.stack.tabs[0].id;
      }
    }
  }
}

// Collect the set of tab ids currently in state. Used to decide panel evictions.
export function liveTabIds(state) {
  const ids = new Set();
  for (const rail of state.rails) {
    for (const stack of rail.stacks) {
      for (const tab of stack.tabs) ids.add(tab.id);
    }
  }
  for (const float of state.floats || []) {
    for (const tab of float.stack?.tabs || []) ids.add(tab.id);
  }
  return ids;
}

// Validate that a minimal state satisfies invariants §2.2. Throws on violation.
// Run after deserialize / programmatic state replacement. Skipped in hot paths.
export function validateState(state) {
  if (!state || !Array.isArray(state.rails)) {
    throw new Error('rails: state.rails must be an array');
  }
  const seenTabIds = new Set();
  const seenStackIds = new Set();
  const seenRailIds = new Set();
  const seenFloatIds = new Set();

  for (const rail of state.rails) {
    if (!rail.id) throw new Error('rails: rail missing id');
    if (seenRailIds.has(rail.id)) throw new Error(`rails: duplicate rail id ${rail.id}`);
    seenRailIds.add(rail.id);
    if (!Array.isArray(rail.stacks) || rail.stacks.length === 0) {
      throw new Error(`rails: rail ${rail.id} must contain at least one stack`);
    }
    for (const stack of rail.stacks) {
      validateStack(stack, seenStackIds, seenTabIds);
    }
  }

  for (const float of state.floats || []) {
    if (!float.id) throw new Error('rails: float missing id');
    if (seenFloatIds.has(float.id)) throw new Error(`rails: duplicate float id ${float.id}`);
    seenFloatIds.add(float.id);
    if (!float.stack) throw new Error(`rails: float ${float.id} missing stack`);
    validateStack(float.stack, seenStackIds, seenTabIds);
    for (const dim of ['x', 'y', 'w', 'h', 'z']) {
      if (typeof float[dim] !== 'number' || !Number.isFinite(float[dim])) {
        throw new Error(`rails: float ${float.id} ${dim} must be a finite number`);
      }
    }
  }
}

function validateStack(stack, seenStackIds, seenTabIds) {
  if (!stack.id) throw new Error('rails: stack missing id');
  if (seenStackIds.has(stack.id)) throw new Error(`rails: duplicate stack id ${stack.id}`);
  seenStackIds.add(stack.id);
  if (!Array.isArray(stack.tabs) || stack.tabs.length === 0) {
    throw new Error(`rails: stack ${stack.id} must contain at least one tab`);
  }
  for (const tab of stack.tabs) {
    if (!tab.id) throw new Error('rails: tab missing id');
    if (seenTabIds.has(tab.id)) throw new Error(`rails: duplicate tab id ${tab.id}`);
    seenTabIds.add(tab.id);
  }
  if (!stack.tabs.find(t => t.id === stack.active)) {
    throw new Error(`rails: stack ${stack.id} active references missing tab ${stack.active}`);
  }
}

// Merge-patch a tab's fields. Returns {changed, chromeVisible} for render routing.
// chromeVisible fields force a structural strip rebuild; others are payload-only.
const CHROME_VISIBLE_FIELDS = new Set(['title', 'closeable', 'draggable', 'badge']);

export function patchTab(state, tabId, patch) {
  const hit = findTab(state, tabId);
  if (!hit) return { changed: false, chromeVisible: false };
  let changed = false;
  let chromeVisible = false;
  for (const key of Object.keys(patch)) {
    if (key === 'id') continue;
    if (hit.tab[key] !== patch[key]) {
      hit.tab[key] = patch[key];
      changed = true;
      if (CHROME_VISIBLE_FIELDS.has(key)) chromeVisible = true;
    }
  }
  return { changed, chromeVisible };
}

// Serialize state to JSON. Consumer passes a replacer for non-JSON tab fields.
export function serializeState(state, replacer) {
  return JSON.stringify(state, replacer);
}

// Default empty state — valid per invariant 7 (empty workspace legal).
export function emptyState() {
  return { rails: [], floats: [] };
}
