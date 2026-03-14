// PERT three-point estimation

// Expected duration: (o + 4m + p) / 6
function pertExpected({ o, m, p }) {
  return (o + 4 * m + p) / 6;
}

// Standard deviation: (p - o) / 6
function pertStdDev({ o, m, p }) {
  return (p - o) / 6;
}

// Variance: ((p - o) / 6)^2
function pertVariance({ o, m, p }) {
  const sd = (p - o) / 6;
  return sd * sd;
}

// Resolve a task's effective duration (PERT expected if available, else raw duration)
function effectiveDuration(task) {
  if (task.milestone) return 0;
  if (task.pert) return pertExpected(task.pert);
  if (task.optimistic != null) return pertExpected({ o: task.optimistic, m: task.mostLikely, p: task.pessimistic });
  return task.duration || 0;
}

export { pertExpected, pertStdDev, pertVariance, effectiveDuration };
