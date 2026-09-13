import {
  checkRowLimit,
  endTimeFromLatency,
  firstNumber,
  ObserverError,
  optionalNumber,
  optionalString,
  parseObservationCore,
  parseObservationFields,
  QUERY_LIMITS,
  requiredDate,
  requiredNonNegativeInteger,
  requiredPositiveInteger,
  requiredString,
  stringArray,
} from "./langfuse-api.ts";
import { isJsonObject } from "./json.ts";
import { describeTrace, startOfWindow } from "./trace-model.ts";
import type {
  FullObservation,
  LangfuseObserver,
  LegacySessionDetail,
  LegacyTraceDetail,
  JsonValue,
  ObserverContext,
  QueryScope,
  RecentWindow,
  RequestJson,
} from "./observer-types.ts";

const PAGE_LIMIT = 100;

const COMPLETE_QUERY_SCOPE: Extract<QueryScope, { kind: "complete" }> = Object.freeze({
  kind: "complete",
});

interface LegacyTrace {
  readonly id: string;
  readonly name: string | null;
  readonly timestamp: string;
  readonly sessionId: string | null;
  readonly userId: string | null;
  readonly environment: string | null;
  readonly tags: readonly string[];
}

interface LegacySession {
  readonly id: string;
  readonly createdAt: string;
  readonly environment: string | null;
}

interface LegacyPage {
  readonly data: JsonValue[];
  readonly totalItems: number;
  readonly totalPages: number;
}

export function createLegacyObserver({
  now,
  requestJson,
}: Readonly<{
  now: () => Date;
  requestJson: RequestJson;
}>): Readonly<LangfuseObserver> {
  return Object.freeze({
    async listRecentTraces(window: RecentWindow, { signal }: ObserverContext = {}) {
      const to = now();
      const from = startOfWindow(window, to);

      const traces = await readLegacyPages({
        path: "/api/public/traces",
        query: {
          fields: "core",
          fromTimestamp: from.toISOString(),
          toTimestamp: to.toISOString(),
        },
        parseRow: parseLegacyTrace,
        rowLimit: QUERY_LIMITS.recent,
        signal,
      });

      return Object.freeze({
        apiVersion: "v3",
        window,
        queriedAt: to.toISOString(),
        traces: traces
          .map(summarizeLegacyTrace)
          .sort((left, right) => right.latestRootAt.localeCompare(left.latestRootAt)),
      });
    },

    async listRecentSessions(window: RecentWindow, { signal }: ObserverContext = {}) {
      const to = now();
      const from = startOfWindow(window, to);

      const sessions = await readLegacyPages({
        path: "/api/public/sessions",
        query: {
          fromTimestamp: from.toISOString(),
          toTimestamp: to.toISOString(),
        },
        parseRow: parseLegacySession,
        rowLimit: QUERY_LIMITS.recent,
        signal,
      });

      return Object.freeze({
        apiVersion: "v3",
        window,
        queriedAt: to.toISOString(),
        sessions: sessions
          .map(summarizeLegacySession)
          .sort((left, right) => right.latestAt.localeCompare(left.latestAt)),
      });
    },

    async getSession(sessionId: string, { signal }: ObserverContext = {}) {
      const payload = await readLegacyRecord(
        `/api/public/sessions/${encodeURIComponent(sessionId)}`,
        {},
        signal,
      );

      return payload === null ? null : describeLegacySession(sessionId, payload);
    },

    async getTrace(traceId: string, { signal }: ObserverContext = {}) {
      const payload = await readLegacyRecord(
        `/api/public/traces/${encodeURIComponent(traceId)}`,
        { fields: "core,io,observations,metrics" },
        signal,
      );

      return payload === null ? null : describeLegacyTrace(traceId, payload);
    },
  });

  async function readLegacyRecord(
    path: string,
    query: Readonly<Record<string, string>>,
    signal: AbortSignal | undefined,
  ): Promise<JsonValue | null> {
    try {
      return await requestJson({
        path,
        query,
        signal,
        notFoundAsMissingRecord: true,
      });
    } catch (error) {
      if (error instanceof ObserverError && error.code === "NOT_FOUND") {
        return null;
      }

      throw error;
    }
  }

  async function readLegacyPages<Row>({
    path,
    query,
    parseRow,
    rowLimit,
    signal,
  }: Readonly<{
    path: string;
    query: Readonly<Record<string, string>>;
    parseRow: (value: JsonValue) => Row;
    rowLimit: number;
    signal: AbortSignal | undefined;
  }>): Promise<Row[]> {
    const rows: Row[] = [];
    let pageNumber = 1;

    while (true) {
      const payload = await requestJson({
        path,
        signal,
        query: {
          ...query,
          limit: String(PAGE_LIMIT),
          page: String(pageNumber),
        },
      });

      const page = parseLegacyPage(payload, pageNumber);
      checkRowLimit(page.totalItems, rowLimit);
      checkPageBudget(page.totalPages, rowLimit);

      const parsedRows = page.data.map(parseRow);
      checkRowLimit(rows.length + parsedRows.length, rowLimit);
      rows.push(...parsedRows);

      if (pageNumber >= page.totalPages) {
        return rows;
      }

      pageNumber += 1;
    }
  }
}

function checkPageBudget(totalPages: number, rowLimit: number): void {
  const pageLimit = Math.ceil(rowLimit / PAGE_LIMIT);

  if (totalPages > pageLimit) {
    throw new ObserverError(
      "RESULT_TOO_LARGE",
      `Langfuse returned more than ${pageLimit} result pages for this view`,
    );
  }
}

function parseLegacyPage(payload: JsonValue, expectedPage: number): LegacyPage {
  if (!isJsonObject(payload)) {
    throw new ObserverError(
      "INVALID_RESPONSE",
      "Langfuse returned an unexpected legacy response shape",
    );
  }

  const data = payload["data"];
  const meta = payload["meta"];

  if (!Array.isArray(data) || !isJsonObject(meta)) {
    throw new ObserverError(
      "INVALID_RESPONSE",
      "Langfuse returned an unexpected legacy response shape",
    );
  }

  const page = requiredPositiveInteger(meta["page"], "meta.page");
  const totalPages = requiredNonNegativeInteger(meta["totalPages"], "meta.totalPages");
  const totalItems = requiredNonNegativeInteger(meta["totalItems"], "meta.totalItems");

  if (page !== expectedPage) {
    throw new ObserverError(
      "INVALID_RESPONSE",
      `Langfuse returned page ${page} while page ${expectedPage} was requested`,
    );
  }

  if (totalPages === 0 && data.length > 0) {
    throw new ObserverError("INVALID_RESPONSE", "Langfuse returned rows with zero total pages");
  }

  return { data, totalItems, totalPages };
}

function describeLegacyTrace(
  expectedTraceId: string,
  payload: JsonValue,
): Readonly<LegacyTraceDetail> {
  if (!isJsonObject(payload)) {
    throw new ObserverError("INVALID_RESPONSE", "Langfuse returned a non-object trace");
  }

  const trace = parseLegacyTrace(payload);

  if (trace.id !== expectedTraceId) {
    throw new ObserverError("INVALID_RESPONSE", "Langfuse returned a different trace");
  }

  const observationRows = payload["observations"];

  if (!Array.isArray(observationRows)) {
    throw new ObserverError("INVALID_RESPONSE", "Langfuse trace is missing its observations");
  }

  checkRowLimit(observationRows.length, QUERY_LIMITS.trace);

  const observations = observationRows.map((value) => parseLegacyObservation(value, trace));

  const described =
    describeTrace(trace.id, observations) ??
    Object.freeze({
      id: trace.id,
      name: trace.name ?? trace.id,
      observationCount: 0,
      startedAt: trace.timestamp,
      endedAt: endTimeFromLatency(
        trace.timestamp,
        optionalNumber(payload["latency"], "trace latency"),
      ),
      sessionIds: trace.sessionId ? [trace.sessionId] : [],
      rows: [],
    });

  return Object.freeze({
    ...described,
    apiVersion: "v3",
    queryScope: COMPLETE_QUERY_SCOPE,
    totalCost: optionalNumber(payload["totalCost"], "trace totalCost"),
    traceContext: Object.freeze({
      environment: trace.environment,
      input: payload["input"] ?? null,
      metadata: payload["metadata"] ?? null,
      output: payload["output"] ?? null,
      release: optionalString(payload["release"], "trace release"),
      tags: trace.tags,
      userId: optionalString(payload["userId"], "trace userId"),
      version: optionalString(payload["version"], "trace version"),
    }),
  });
}

function describeLegacySession(
  expectedSessionId: string,
  payload: JsonValue,
): Readonly<LegacySessionDetail> {
  if (!isJsonObject(payload)) {
    throw new ObserverError("INVALID_RESPONSE", "Langfuse returned a non-object session");
  }

  const session = parseLegacySession(payload);

  if (session.id !== expectedSessionId) {
    throw new ObserverError("INVALID_RESPONSE", "Langfuse returned a different session");
  }

  const traceRows = payload["traces"];

  if (!Array.isArray(traceRows)) {
    throw new ObserverError("INVALID_RESPONSE", "Langfuse session is missing its traces");
  }

  checkRowLimit(traceRows.length, QUERY_LIMITS.session);

  const traces = traceRows
    .map(parseLegacyTrace)
    .map((trace) =>
      Object.freeze({
        environment: trace.environment,
        highestLevel: "DEFAULT",
        id: trace.id,
        latestAt: trace.timestamp,
        name: trace.name ?? trace.id,
        observationCount: null,
        startedAt: trace.timestamp,
        tags: trace.tags,
      }),
    )
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));

  const timestamps = traces.map((trace) => trace.startedAt);

  return Object.freeze({
    apiVersion: "v3",
    queryScope: COMPLETE_QUERY_SCOPE,
    id: session.id,
    startedAt: timestamps.at(0) ?? session.createdAt,
    latestAt: timestamps.at(-1) ?? session.createdAt,
    traceCount: traces.length,
    observationCount: null,
    highestLevel: "DEFAULT",
    environments: session.environment ? [session.environment] : [],
    tags: [...new Set(traces.flatMap((trace) => trace.tags))],
    traces,
  });
}

function parseLegacyTrace(value: JsonValue): Readonly<LegacyTrace> {
  if (!isJsonObject(value)) {
    throw new ObserverError("INVALID_RESPONSE", "Langfuse returned a non-object trace");
  }

  return Object.freeze({
    id: requiredString(value["id"], "trace id"),
    name: optionalString(value["name"], "trace name"),
    timestamp: requiredDate(value["timestamp"], "trace timestamp"),
    sessionId: optionalString(value["sessionId"], "trace sessionId"),
    userId: optionalString(value["userId"], "trace userId"),
    environment: optionalString(value["environment"], "trace environment"),
    tags: stringArray(value["tags"], "trace tags"),
  });
}

function parseLegacySession(value: JsonValue): Readonly<LegacySession> {
  if (!isJsonObject(value)) {
    throw new ObserverError("INVALID_RESPONSE", "Langfuse returned a non-object session");
  }

  return Object.freeze({
    id: requiredString(value["id"], "session id"),
    createdAt: requiredDate(value["createdAt"], "session createdAt"),
    environment: optionalString(value["environment"], "session environment"),
  });
}

function summarizeLegacyTrace(trace: LegacyTrace) {
  return Object.freeze({
    id: trace.id,
    name: trace.name ?? trace.id,
    startedAt: trace.timestamp,
    latestRootAt: trace.timestamp,
    rootCount: null,
    hasOpenRoot: false,
    highestLevel: "DEFAULT",
    environment: trace.environment,
    tags: trace.tags,
  });
}

function summarizeLegacySession(session: LegacySession) {
  return Object.freeze({
    id: session.id,
    startedAt: session.createdAt,
    latestAt: session.createdAt,
    traceCount: null,
    observationCount: null,
    highestLevel: "DEFAULT",
    environments: session.environment ? [session.environment] : [],
    tags: [],
  });
}

function parseLegacyObservation(value: JsonValue, trace: LegacyTrace): Readonly<FullObservation> {
  if (!isJsonObject(value)) {
    throw new ObserverError("INVALID_RESPONSE", "Langfuse returned a non-object observation");
  }

  const core = parseObservationCore(value);

  if (core.traceId !== trace.id) {
    throw new ObserverError(
      "INVALID_RESPONSE",
      "Langfuse returned an observation from another trace",
    );
  }

  return Object.freeze({
    ...parseObservationFields(value, core),
    traceName: trace.name,
    environment: trace.environment,
    tags: trace.tags,
    userId: trace.userId,
    sessionId: trace.sessionId,
    isLogicalRoot: core.parentId === null,
    totalCost: firstNumber(
      optionalNumber(value["calculatedTotalCost"], "observation calculatedTotalCost"),
      optionalNumber(value["totalPrice"], "observation totalPrice"),
    ),
  });
}
