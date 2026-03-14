// S-curve generator — cumulative progress over time

import { workingDays, _parseDate, _fmtDate } from './calendar.js';
import { effectiveDuration } from './pert.js';

function scurve(scheduledTasks, options = {}) {
  const {
    bucket = 'week',
    metric = 'tasks',
    baseline,
    today,
  } = options;

  if (scheduledTasks.length === 0) {
    return { labels: [], planned: [], actual: [], total: 0, percentComplete: 0 };
  }

  // Determine date range
  let rangeStart = options.start ? _parseDate(options.start) : null;
  let rangeEnd = options.end ? _parseDate(options.end) : null;

  if (!rangeStart) {
    rangeStart = scheduledTasks.reduce((m, t) =>
      t.earlyStart < m ? t.earlyStart : m, scheduledTasks[0].earlyStart);
  }
  if (!rangeEnd) {
    rangeEnd = scheduledTasks.reduce((m, t) =>
      t.earlyFinish > m ? t.earlyFinish : m, scheduledTasks[0].earlyFinish);
  }

  // Generate bucket edges
  const buckets = _generateBuckets(rangeStart, rangeEnd, bucket);

  // Weight function
  const weight = (t) => {
    if (metric === 'duration') return effectiveDuration(t);
    if (metric === 'cost') return (t.cost && t.cost.rate) ? t.cost.rate * effectiveDuration(t) : effectiveDuration(t);
    return 1; // tasks
  };

  const total = scheduledTasks.reduce((s, t) => s + weight(t), 0);

  // Planned: cumulative weight by earlyFinish bucket
  const planned = new Array(buckets.length).fill(0);
  for (const t of scheduledTasks) {
    const bi = _bucketIndex(t.earlyFinish, buckets);
    if (bi >= 0 && bi < buckets.length) planned[bi] += weight(t);
  }
  _cumSum(planned);

  // Actual: based on task.progress
  const actual = new Array(buckets.length).fill(0);
  const todayDate = today ? _parseDate(today) : new Date();
  const todayBi = _bucketIndex(todayDate, buckets);

  for (const t of scheduledTasks) {
    const progress = t.progress || 0;
    if (progress <= 0) continue;
    // Distribute actual progress up to the current bucket
    const finishBi = Math.min(_bucketIndex(t.earlyFinish, buckets), todayBi);
    if (finishBi >= 0 && finishBi < buckets.length) {
      actual[finishBi] += weight(t) * progress;
    }
  }
  _cumSum(actual);

  // Baseline (if provided)
  let baselineCurve;
  if (baseline) {
    baselineCurve = new Array(buckets.length).fill(0);
    for (const t of baseline) {
      const bi = _bucketIndex(t.earlyFinish, buckets);
      if (bi >= 0 && bi < buckets.length) baselineCurve[bi] += weight(t);
    }
    _cumSum(baselineCurve);
  }

  // Forecast: linear extrapolation from current rate
  let forecast;
  if (todayBi >= 0 && todayBi < buckets.length && actual[todayBi] > 0 && actual[todayBi] < total) {
    forecast = new Array(buckets.length).fill(null);
    const rate = actual[todayBi] / (todayBi + 1);
    for (let i = 0; i <= todayBi; i++) forecast[i] = actual[i];
    for (let i = todayBi + 1; i < buckets.length; i++) {
      forecast[i] = Math.min(total, actual[todayBi] + rate * (i - todayBi));
    }
  }

  // SPI trend
  const spiTrend = planned.map((p, i) => p > 0 ? actual[i] / p : null);

  const percentComplete = total > 0 ? actual[Math.min(todayBi, buckets.length - 1)] / total : 0;

  const labels = buckets.map(b => _bucketLabel(b, bucket));

  const result = { labels, planned, actual, total, percentComplete };
  if (forecast) result.forecast = forecast;
  if (baselineCurve) result.baseline = baselineCurve;
  result.spiTrend = spiTrend;
  return result;
}

function _generateBuckets(start, end, bucket) {
  const buckets = [];
  const d = new Date(start);

  if (bucket === 'day') {
    while (d <= end) {
      buckets.push(new Date(d));
      d.setDate(d.getDate() + 1);
    }
  } else if (bucket === 'week') {
    // Align to Monday
    const dow = d.getDay();
    if (dow !== 1) d.setDate(d.getDate() + (dow === 0 ? 1 : 8 - dow));
    if (d > end) d.setTime(start.getTime());
    while (d <= end) {
      buckets.push(new Date(d));
      d.setDate(d.getDate() + 7);
    }
    // Ensure we cover the end
    if (buckets.length === 0 || buckets[buckets.length - 1] < end) {
      buckets.push(new Date(end));
    }
  } else if (bucket === 'month') {
    d.setDate(1);
    while (d <= end) {
      buckets.push(new Date(d));
      d.setMonth(d.getMonth() + 1);
    }
    if (buckets[buckets.length - 1] < end) {
      buckets.push(new Date(end));
    }
  }

  return buckets;
}

function _bucketIndex(date, buckets) {
  for (let i = buckets.length - 1; i >= 0; i--) {
    if (date >= buckets[i]) return i;
  }
  return 0;
}

function _cumSum(arr) {
  for (let i = 1; i < arr.length; i++) arr[i] += arr[i - 1];
}

function _bucketLabel(date, bucket) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  if (bucket === 'day') return `${y}-${m}-${d}`;
  if (bucket === 'week') return `${y}-${m}-${d}`;
  if (bucket === 'month') {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[date.getMonth()]} ${y}`;
  }
  return _fmtDate(date);
}

export { scurve };
