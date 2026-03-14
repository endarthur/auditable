// Dependency graph utilities

// Build id→task map
function _taskMap(tasks) {
  const map = new Map();
  for (const t of tasks) map.set(t.id, t);
  return map;
}

// Build forward and reverse adjacency lists
function _buildAdj(tasks) {
  const fwd = new Map(); // id → [successor ids]
  const rev = new Map(); // id → [predecessor ids]
  for (const t of tasks) {
    if (!fwd.has(t.id)) fwd.set(t.id, []);
    if (!rev.has(t.id)) rev.set(t.id, []);
    if (t.depends) {
      for (const dep of t.depends) {
        if (!fwd.has(dep)) fwd.set(dep, []);
        if (!rev.has(dep)) rev.set(dep, []);
        fwd.get(dep).push(t.id);
        rev.get(t.id).push(dep);
      }
    }
  }
  return { fwd, rev };
}

// Topological sort — Kahn's algorithm. Throws on cycles.
function topoSort(tasks) {
  const { fwd, rev } = _buildAdj(tasks);
  const inDeg = new Map();
  for (const t of tasks) inDeg.set(t.id, (rev.get(t.id) || []).length);

  const queue = [];
  for (const [id, deg] of inDeg) {
    if (deg === 0) queue.push(id);
  }

  const order = [];
  while (queue.length > 0) {
    const id = queue.shift();
    order.push(id);
    for (const succ of (fwd.get(id) || [])) {
      inDeg.set(succ, inDeg.get(succ) - 1);
      if (inDeg.get(succ) === 0) queue.push(succ);
    }
  }

  if (order.length !== tasks.length) {
    // Find a cycle for the error message
    const cycle = detectCycles(tasks);
    throw new Error(`Dependency cycle detected: ${cycle ? cycle.join(' → ') : 'unknown'}`);
  }

  return order;
}

// Detect dependency cycles via DFS. Returns cycle path or null.
function detectCycles(tasks) {
  const { rev } = _buildAdj(tasks); // rev maps id → predecessors (depends)
  const color = new Map();
  const parent = new Map();
  for (const t of tasks) color.set(t.id, 0);

  // Build forward adjacency for DFS
  const adj = new Map();
  for (const t of tasks) {
    if (!adj.has(t.id)) adj.set(t.id, []);
    if (t.depends) {
      for (const dep of t.depends) {
        if (!adj.has(dep)) adj.set(dep, []);
        adj.get(dep).push(t.id);
      }
    }
  }

  for (const t of tasks) {
    if (color.get(t.id) === 0) {
      const cycle = _dfs(t.id, adj, color, parent);
      if (cycle) return cycle;
    }
  }
  return null;
}

function _dfs(u, adj, color, parent) {
  color.set(u, 1); // GRAY
  for (const v of (adj.get(u) || [])) {
    if (color.get(v) === 1) { // GRAY — cycle
      const cycle = [v, u];
      let cur = u;
      while (cur !== v && parent.has(cur)) {
        cur = parent.get(cur);
        cycle.push(cur);
      }
      return cycle.reverse();
    }
    if (color.get(v) === 0) { // WHITE
      parent.set(v, u);
      const cycle = _dfs(v, adj, color, parent);
      if (cycle) return cycle;
    }
  }
  color.set(u, 2); // BLACK
  return null;
}

// Get all transitive predecessors of a task
function predecessors(taskId, tasks) {
  const { rev } = _buildAdj(tasks);
  const visited = new Set();
  const queue = [...(rev.get(taskId) || [])];
  while (queue.length > 0) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    for (const pred of (rev.get(id) || [])) queue.push(pred);
  }
  return [...visited];
}

// Get all transitive successors of a task
function successors(taskId, tasks) {
  const { fwd } = _buildAdj(tasks);
  const visited = new Set();
  const queue = [...(fwd.get(taskId) || [])];
  while (queue.length > 0) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    for (const succ of (fwd.get(id) || [])) queue.push(succ);
  }
  return [...visited];
}

export { topoSort, detectCycles, predecessors, successors, _taskMap, _buildAdj };
