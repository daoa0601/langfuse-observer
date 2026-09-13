import type {
  CurrentRecentTrace,
  CurrentSessionDetail,
  CurrentSessionSummary,
  FullObservation,
  LightObservation,
  ObservationRelation,
  ObservationRow,
  RecentWindow,
  TraceDescription,
} from "./observer-types.ts";

export const RECENT_WINDOWS = Object.freeze({
  "1h": { label: "1 hour", milliseconds: 60 * 60 * 1_000 },
  "6h": { label: "6 hours", milliseconds: 6 * 60 * 60 * 1_000 },
  "24h": { label: "24 hours", milliseconds: 24 * 60 * 60 * 1_000 },
  "7d": { label: "7 days", milliseconds: 7 * 24 * 60 * 60 * 1_000 },
  "30d": { label: "30 days", milliseconds: 30 * 24 * 60 * 60 * 1_000 },
  "90d": { label: "90 days", milliseconds: 90 * 24 * 60 * 60 * 1_000 },
} satisfies Record<RecentWindow, Readonly<{ label: string; milliseconds: number }>>);

const LEVEL_WEIGHT: Readonly<Record<string, number>> = Object.freeze({
  DEBUG: 0,
  DEFAULT: 1,
  WARNING: 2,
  ERROR: 3,
});

interface MutableRecentTrace {
  id: string;
  name: string;
  startedAt: string;
  latestRootAt: string;
  rootCount: number;
  hasOpenRoot: boolean;
  highestLevel: string;
  environment: string | null;
  tags: string[];
}

interface MutableSessionTrace {
  id: string;
  name: string;
  startedAt: string;
  latestAt: string;
  observationCount: number;
  highestLevel: string;
  environment: string | null;
  tags: Set<string>;
}

interface SessionActivity {
  id: string;
  startedAt: string;
  latestAt: string;
  observationCount: number;
  highestLevel: string;
  environments: Set<string>;
  tags: Set<string>;
  traces: Map<string, MutableSessionTrace>;
}

export function parseRecentWindow(value: string): RecentWindow | null {
  switch (value) {
    case "1h":
    case "6h":
    case "24h":
    case "7d":
    case "30d":
    case "90d":
      return value;
    default:
      return null;
  }
}

export function parseTraceId(value: string): string | null {
  const traceId = value.trim();

  if (!traceId || traceId.length > 256 || containsControlCharacter(traceId)) {
    return null;
  }

  return traceId;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);

    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }

  return false;
}

export function parseSessionId(value: string): string | null {
  const sessionId = value.trim();

  if (!sessionId || sessionId.length > 200 || !/^[\x20-\x7e]+$/u.test(sessionId)) {
    return null;
  }

  return sessionId;
}

export function startOfWindow(window: RecentWindow, now: Date): Date {
  return new Date(now.getTime() - RECENT_WINDOWS[window].milliseconds);
}

export function summarizeRecentTraces(
  rootObservations: readonly LightObservation[],
): readonly Readonly<CurrentRecentTrace>[] {
  const grouped = new Map<string, MutableRecentTrace>();

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
    .map((summary) => Object.freeze(summary));
}

export function summarizeRecentSessions(
  observations: readonly LightObservation[],
): readonly Readonly<CurrentSessionSummary>[] {
  const sessions = groupSessionActivity(observations);

  return [...sessions.values()]
    .map((session) => freezeSessionSummary(session))
    .sort((left, right) => right.latestAt.localeCompare(left.latestAt));
}

export function describeSession(
  sessionId: string,
  observations: readonly LightObservation[],
): Omit<CurrentSessionDetail, "apiVersion" | "queryScope"> | null {
  const matching = observations.filter((observation) => observation.sessionId === sessionId);

  if (matching.length === 0) {
    return null;
  }

  const session = groupSessionActivity(matching).get(sessionId);

  if (!session) {
    return null;
  }

  const traces = [...session.traces.values()]
    .map((trace) =>
      Object.freeze({
        ...trace,
        tags: [...trace.tags],
      }),
    )
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));

  return Object.freeze({
    ...freezeSessionSummary(session),
    traces,
  });
}

export function describeTrace(
  traceId: string,
  observations: readonly FullObservation[],
): Readonly<TraceDescription> | null {
  if (observations.length === 0) {
    return null;
  }

  const ordered = [...observations].sort(compareObservations);
  const byId = new Map(ordered.map((observation) => [observation.id, observation]));
  const childrenByParent = new Map<string, FullObservation[]>();

  const roots: Array<{
    observation: FullObservation;
    relation: Extract<ObservationRelation, "root" | "missing-parent">;
  }> = [];

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

  const rows: ObservationRow[] = [];
  const visited = new Set<string>();

  for (const root of roots) {
    appendRows(root.observation, 0, root.relation, childrenByParent, visited, rows);
  }

  for (const observation of ordered) {
    if (!visited.has(observation.id)) {
      appendRows(observation, 0, "cycle-break", childrenByParent, visited, rows);
    }
  }

  const first = ordered[0];

  if (!first) {
    return null;
  }

  const startedAt = first.startTime;
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
    endedAt: open || endedTimes.length === 0 ? null : (endedTimes.sort().at(-1) ?? null),
    sessionIds: [
      ...new Set(
        ordered.flatMap((observation) => (observation.sessionId ? [observation.sessionId] : [])),
      ),
    ],
    rows: rows.map((row) => Object.freeze(row)),
  });
}

function groupSessionActivity(
  observations: readonly LightObservation[],
): Map<string, SessionActivity> {
  const sessions = new Map<string, SessionActivity>();

  for (const observation of observations) {
    if (!observation.sessionId) {
      continue;
    }

    let session = sessions.get(observation.sessionId);

    if (!session) {
      session = {
        id: observation.sessionId,
        startedAt: observation.startTime,
        latestAt: observation.endTime ?? observation.startTime,
        observationCount: 0,
        highestLevel: observation.level,
        environments: new Set(),
        tags: new Set(),
        traces: new Map(),
      };
      sessions.set(observation.sessionId, session);
    }

    session.startedAt = earlier(session.startedAt, observation.startTime);
    session.latestAt = later(session.latestAt, observation.endTime ?? observation.startTime);
    session.observationCount += 1;
    session.highestLevel = worseLevel(session.highestLevel, observation.level);

    if (observation.environment) {
      session.environments.add(observation.environment);
    }

    for (const tag of observation.tags) {
      session.tags.add(tag);
    }

    const trace = session.traces.get(observation.traceId);

    if (!trace) {
      session.traces.set(observation.traceId, {
        id: observation.traceId,
        name: observation.traceName || observation.name || observation.traceId,
        startedAt: observation.startTime,
        latestAt: observation.endTime ?? observation.startTime,
        observationCount: 1,
        highestLevel: observation.level,
        environment: observation.environment,
        tags: new Set(observation.tags),
      });
      continue;
    }

    trace.startedAt = earlier(trace.startedAt, observation.startTime);
    trace.latestAt = later(trace.latestAt, observation.endTime ?? observation.startTime);
    trace.observationCount += 1;
    trace.highestLevel = worseLevel(trace.highestLevel, observation.level);
    trace.name = observation.traceName || trace.name;

    for (const tag of observation.tags) {
      trace.tags.add(tag);
    }
  }

  return sessions;
}

function freezeSessionSummary(session: SessionActivity): Readonly<CurrentSessionSummary> {
  return Object.freeze({
    id: session.id,
    startedAt: session.startedAt,
    latestAt: session.latestAt,
    traceCount: session.traces.size,
    observationCount: session.observationCount,
    highestLevel: session.highestLevel,
    environments: [...session.environments],
    tags: [...session.tags],
  });
}

function createSummary(observation: LightObservation): MutableRecentTrace {
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

function appendRows(
  root: FullObservation,
  depth: number,
  relation: ObservationRelation,
  childrenByParent: ReadonlyMap<string, readonly FullObservation[]>,
  visited: Set<string>,
  rows: ObservationRow[],
): void {
  const pending: ObservationRow[] = [{ observation: root, depth, relation }];

  while (pending.length > 0) {
    const current = pending.pop();

    if (!current) {
      continue;
    }

    if (visited.has(current.observation.id)) {
      continue;
    }

    visited.add(current.observation.id);
    rows.push(current);

    const children = childrenByParent.get(current.observation.id) ?? [];

    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];

      if (!child) {
        continue;
      }

      pending.push({
        observation: child,
        depth: current.depth + 1,
        relation: "child",
      });
    }
  }
}

function compareObservations(left: FullObservation, right: FullObservation): number {
  return left.startTime.localeCompare(right.startTime) || left.id.localeCompare(right.id);
}

function earlier(left: string, right: string): string {
  return left.localeCompare(right) <= 0 ? left : right;
}

function later(left: string, right: string): string {
  return left.localeCompare(right) >= 0 ? left : right;
}

function worseLevel(left: string, right: string): string {
  return (LEVEL_WEIGHT[right] ?? 1) > (LEVEL_WEIGHT[left] ?? 1) ? right : left;
}
