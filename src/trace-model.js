export const RECENT_WINDOWS = Object.freeze({
  "1h": { label: "1 hour", milliseconds: 60 * 60 * 1_000 },
  "6h": { label: "6 hours", milliseconds: 6 * 60 * 60 * 1_000 },
  "24h": { label: "24 hours", milliseconds: 24 * 60 * 60 * 1_000 },
  "7d": { label: "7 days", milliseconds: 7 * 24 * 60 * 60 * 1_000 },
});

const LEVEL_WEIGHT = Object.freeze({
  DEBUG: 0,
  DEFAULT: 1,
  WARNING: 2,
  ERROR: 3,
});

export function parseRecentWindow(value) {
  return Object.hasOwn(RECENT_WINDOWS, value) ? value : null;
}

export function parseTraceId(value) {
  const traceId = value.trim();
  if (!traceId || traceId.length > 256 || /[\u0000-\u001f\u007f]/u.test(traceId)) {
    return null;
  }
  return traceId;
}

export function startOfWindow(window, now) {
  return new Date(now.getTime() - RECENT_WINDOWS[window].milliseconds);
}

export function summarizeRecentTraces(rootObservations, limit = 50) {
  const grouped = new Map();

  for (const observation of rootObservations) {
    const existing = grouped.get(observation.traceId);
    if (!existing) {
      grouped.set(observation.traceId, createSummary(observation));
      continue;
    }

    existing.startedAt = earlier(existing.startedAt, observation.startTime);
    existing.latestRootAt = later(existing.latestRootAt, observation.startTime);
    existing.rootCount += 1;
    existing.hasOpenRoot ||= observation.endTime === null;
    existing.highestLevel = worseLevel(existing.highestLevel, observation.level);
    existing.tags = [...new Set([...existing.tags, ...observation.tags])];

    if (observation.traceName) {
      existing.name = observation.traceName;
    }
  }

  return [...grouped.values()]
    .sort((left, right) => right.latestRootAt.localeCompare(left.latestRootAt))
    .slice(0, limit)
    .map(Object.freeze);
}

export function describeTrace(traceId, observations) {
  if (observations.length === 0) {
    return null;
  }

  const ordered = [...observations].sort(compareObservations);
  const byId = new Map(ordered.map((observation) => [observation.id, observation]));
  const childrenByParent = new Map();
  const roots = [];

  for (const observation of ordered) {
    if (observation.parentId === null) {
      roots.push({ observation, relation: "root" });
      continue;
    }
    if (!byId.has(observation.parentId)) {
      roots.push({ observation, relation: "missing-parent" });
      continue;
    }

    const children = childrenByParent.get(observation.parentId) ?? [];
    children.push(observation);
    childrenByParent.set(observation.parentId, children);
  }

  for (const children of childrenByParent.values()) {
    children.sort(compareObservations);
  }

  const rows = [];
  const visited = new Set();
  for (const root of roots) {
    appendRows(root.observation, 0, root.relation, childrenByParent, visited, rows);
  }
  for (const observation of ordered) {
    if (!visited.has(observation.id)) {
      appendRows(observation, 0, "cycle-break", childrenByParent, visited, rows);
    }
  }

  const startedAt = ordered[0].startTime;
  const open = ordered.some((observation) => observation.endTime === null);
  const endedTimes = ordered.flatMap((observation) =>
    observation.endTime === null ? [] : [observation.endTime],
  );
  const name =
    [...ordered].reverse().find((observation) => observation.traceName)?.traceName ??
    ordered.find((observation) => observation.isLogicalRoot && observation.name)?.name ??
    traceId;

  return Object.freeze({
    id: traceId,
    name,
    observationCount: ordered.length,
    startedAt,
    endedAt: open || endedTimes.length === 0 ? null : endedTimes.sort().at(-1),
    rows: rows.map(Object.freeze),
  });
}

function createSummary(observation) {
  return {
    id: observation.traceId,
    name: observation.traceName || observation.name || observation.traceId,
    startedAt: observation.startTime,
    latestRootAt: observation.startTime,
    rootCount: 1,
    hasOpenRoot: observation.endTime === null,
    highestLevel: observation.level,
    environment: observation.environment,
    tags: [...observation.tags],
  };
}

function appendRows(observation, depth, relation, childrenByParent, visited, rows) {
  if (visited.has(observation.id)) {
    return;
  }

  visited.add(observation.id);
  rows.push({ observation, depth, relation });

  for (const child of childrenByParent.get(observation.id) ?? []) {
    appendRows(child, depth + 1, "child", childrenByParent, visited, rows);
  }
}

function compareObservations(left, right) {
  return left.startTime.localeCompare(right.startTime) || left.id.localeCompare(right.id);
}

function earlier(left, right) {
  return left.localeCompare(right) <= 0 ? left : right;
}

function later(left, right) {
  return left.localeCompare(right) >= 0 ? left : right;
}

function worseLevel(left, right) {
  return (LEVEL_WEIGHT[right] ?? 1) > (LEVEL_WEIGHT[left] ?? 1) ? right : left;
}
