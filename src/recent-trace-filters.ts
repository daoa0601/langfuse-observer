import type {
  CurrentRecentTrace,
  LegacyRecentTrace,
  RecentTracesResult,
  RecentWindow,
} from "./observer-types.ts";
import type { RecentTraceFilters, TraceRunState } from "./recent-trace-filter-query.ts";

export interface TraceFilterOption {
  readonly value: string;
  readonly traceCount: number;
  readonly selected: boolean;
}

export interface TraceRunStateOption {
  readonly value: TraceRunState;
  readonly label: string;
  readonly traceCount: number;
  readonly selected: boolean;
}

interface TraceFilterPanelBase {
  readonly search: string | null;
  readonly environments: readonly TraceFilterOption[];
  readonly tags: readonly TraceFilterOption[];
}

export interface CurrentTraceFilterPanel extends TraceFilterPanelBase {
  readonly kind: "v4";
  readonly levels: readonly TraceFilterOption[];
  readonly runStates: readonly TraceRunStateOption[];
}

export interface LegacyTraceFilterPanel extends TraceFilterPanelBase {
  readonly kind: "v3";
}

interface RecentTracePageBase {
  readonly window: RecentWindow;
  readonly queriedAt: string;
  readonly totalTraceCount: number;
}

export interface CurrentRecentTracePage extends RecentTracePageBase {
  readonly apiVersion: "v4";
  readonly traces: readonly CurrentRecentTrace[];
  readonly filterPanel: CurrentTraceFilterPanel;
}

export interface LegacyRecentTracePage extends RecentTracePageBase {
  readonly apiVersion: "v3";
  readonly traces: readonly LegacyRecentTrace[];
  readonly filterPanel: LegacyTraceFilterPanel;
}

export type RecentTracePage = CurrentRecentTracePage | LegacyRecentTracePage;

export type RecentTracePageResult =
  | Readonly<{ kind: "ready"; page: RecentTracePage }>
  | Readonly<{
      kind: "unsupported";
      fields: readonly ["level"] | readonly ["status"] | readonly ["level", "status"];
    }>;

type RecentTrace = CurrentRecentTrace | LegacyRecentTrace;

export function prepareRecentTracePage(
  result: RecentTracesResult,
  filters: RecentTraceFilters,
): RecentTracePageResult {
  const environments = buildFacetOptions(
    result.traces.map((trace) => (trace.environment === null ? [] : [trace.environment])),
    filters.environments,
  );

  const tags = buildFacetOptions(
    result.traces.map((trace) => trace.tags),
    filters.tags,
  );

  if (result.apiVersion === "v3") {
    const unsupportedFields = unsupportedLegacyFields(filters);

    if (unsupportedFields !== null) {
      return Object.freeze({ kind: "unsupported", fields: unsupportedFields });
    }

    const traces = result.traces.filter((trace) => matchesSharedFilters(trace, filters));

    return Object.freeze({
      kind: "ready",
      page: Object.freeze({
        apiVersion: "v3",
        window: result.window,
        queriedAt: result.queriedAt,
        traces,
        totalTraceCount: result.traces.length,
        filterPanel: Object.freeze({
          kind: "v3",
          search: filters.search,
          environments,
          tags,
        }),
      }),
    });
  }

  const traces = result.traces.filter((trace) => matchesCurrentFilters(trace, filters));

  const levels = buildFacetOptions(
    result.traces.map((trace) => [trace.highestLevel]),
    filters.levels,
  );

  return Object.freeze({
    kind: "ready",
    page: Object.freeze({
      apiVersion: "v4",
      window: result.window,
      queriedAt: result.queriedAt,
      traces,
      totalTraceCount: result.traces.length,
      filterPanel: Object.freeze({
        kind: "v4",
        search: filters.search,
        environments,
        tags,
        levels,
        runStates: buildRunStateOptions(result.traces, filters.runState),
      }),
    }),
  });
}

function unsupportedLegacyFields(
  filters: RecentTraceFilters,
): readonly ["level"] | readonly ["status"] | readonly ["level", "status"] | null {
  const hasLevelFilter = filters.levels.length > 0;
  const hasStatusFilter = filters.runState !== null;

  if (hasLevelFilter && hasStatusFilter) {
    return ["level", "status"];
  }

  if (hasLevelFilter) {
    return ["level"];
  }

  return hasStatusFilter ? ["status"] : null;
}

function matchesCurrentFilters(trace: CurrentRecentTrace, filters: RecentTraceFilters): boolean {
  if (!matchesSharedFilters(trace, filters)) {
    return false;
  }

  if (filters.levels.length > 0 && !filters.levels.includes(trace.highestLevel)) {
    return false;
  }

  if (filters.runState === "running" && !trace.hasOpenRoot) {
    return false;
  }

  return filters.runState !== "ended" || !trace.hasOpenRoot;
}

function matchesSharedFilters(trace: RecentTrace, filters: RecentTraceFilters): boolean {
  if (filters.search !== null) {
    const search = filters.search.toLocaleLowerCase("en");

    if (
      !trace.name.toLocaleLowerCase("en").includes(search) &&
      !trace.id.toLocaleLowerCase("en").includes(search)
    ) {
      return false;
    }
  }

  if (
    filters.environments.length > 0 &&
    (trace.environment === null || !filters.environments.includes(trace.environment))
  ) {
    return false;
  }

  return (
    filters.tags.length === 0 ||
    filters.tags.some((selectedTag) => trace.tags.includes(selectedTag))
  );
}

function buildFacetOptions(
  valuesByTrace: readonly (readonly string[])[],
  selectedValues: readonly string[],
): readonly TraceFilterOption[] {
  const counts = new Map<string, number>();

  for (const traceValues of valuesByTrace) {
    for (const value of new Set(traceValues)) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }

  for (const selectedValue of selectedValues) {
    if (!counts.has(selectedValue)) {
      counts.set(selectedValue, 0);
    }
  }

  return Object.freeze(
    [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([value, traceCount]) =>
        Object.freeze({ value, traceCount, selected: selectedValues.includes(value) }),
      ),
  );
}

function buildRunStateOptions(
  traces: readonly CurrentRecentTrace[],
  selectedState: TraceRunState | null,
): readonly TraceRunStateOption[] {
  const runningCount = traces.filter((trace) => trace.hasOpenRoot).length;
  const endedCount = traces.length - runningCount;

  return Object.freeze([
    Object.freeze({
      value: "running",
      label: "Running",
      traceCount: runningCount,
      selected: selectedState === "running",
    }),
    Object.freeze({
      value: "ended",
      label: "Ended",
      traceCount: endedCount,
      selected: selectedState === "ended",
    }),
  ]);
}
