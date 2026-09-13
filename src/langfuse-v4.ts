import {
  checkRowLimit,
  ObserverError,
  optionalNumber,
  optionalString,
  parseObservationCore,
  parseObservationFields,
  QUERY_LIMITS,
  stringArray,
  TRACE_LOOKBACK_MS,
} from "./langfuse-api.ts";
import { isJsonObject, isJsonString } from "./json.ts";
import {
  describeSession,
  describeTrace,
  startOfWindow,
  summarizeRecentSessions,
  summarizeRecentTraces,
} from "./trace-model.ts";
import type {
  FullObservation,
  JsonValue,
  LangfuseObserver,
  LightObservation,
  ObserverContext,
  QueryScope,
  RecentWindow,
  RequestJson,
} from "./observer-types.ts";

const PAGE_SIZE = 1_000;

export function createCurrentObserver({
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

      const observations = await readObservationPages(
        {
          fields: "core,basic,trace_context",
          isRootObservation: "true",
          fromStartTime: from.toISOString(),
          toStartTime: to.toISOString(),
          limit: String(PAGE_SIZE),
        },
        parseLightObservation,
        QUERY_LIMITS.recent,
        signal,
      );

      return Object.freeze({
        apiVersion: "v4",
        window,
        queriedAt: to.toISOString(),
        traces: summarizeRecentTraces(observations),
      });
    },

    async listRecentSessions(window: RecentWindow, { signal }: ObserverContext = {}) {
      const to = now();
      const from = startOfWindow(window, to);

      const observations = await readObservationPages(
        {
          fields: "core,basic,trace_context",
          fromStartTime: from.toISOString(),
          toStartTime: to.toISOString(),
          limit: String(PAGE_SIZE),
        },
        parseLightObservation,
        QUERY_LIMITS.recent,
        signal,
      );

      return Object.freeze({
        apiVersion: "v4",
        window,
        queriedAt: to.toISOString(),
        sessions: summarizeRecentSessions(observations),
      });
    },

    async getSession(sessionId: string, { signal }: ObserverContext = {}) {
      const to = now();
      const from = new Date(to.getTime() - TRACE_LOOKBACK_MS);

      const filter = JSON.stringify([
        { type: "string", column: "sessionId", operator: "=", value: sessionId },
      ]);

      const observations = await readObservationPages(
        {
          fields: "core,basic,trace_context",
          filter,
          fromStartTime: from.toISOString(),
          toStartTime: to.toISOString(),
          limit: String(PAGE_SIZE),
        },
        parseLightObservation,
        QUERY_LIMITS.session,
        signal,
      );

      const session = describeSession(sessionId, observations);

      return session
        ? Object.freeze({
            ...session,
            apiVersion: "v4",
            queryScope: boundedQueryScope(from, to),
          })
        : null;
    },

    async getTrace(traceId: string, { signal }: ObserverContext = {}) {
      const to = now();
      const from = new Date(to.getTime() - TRACE_LOOKBACK_MS);

      const observations = await readObservationPages(
        {
          fields: "core,basic,time,io,metadata,model,usage,prompt,metrics,trace_context",
          traceId,
          fromStartTime: from.toISOString(),
          toStartTime: to.toISOString(),
          limit: String(PAGE_SIZE),
        },
        (value) => parseFullObservation(value, traceId),
        QUERY_LIMITS.trace,
        signal,
      );

      const trace = describeTrace(traceId, observations);

      return trace
        ? Object.freeze({
            ...trace,
            apiVersion: "v4",
            queryScope: boundedQueryScope(from, to),
          })
        : null;
    },
  });

  async function readObservationPages<Observation>(
    query: Readonly<Record<string, string>>,
    parseObservation: (value: JsonValue) => Observation,
    rowLimit: number,
    signal: AbortSignal | undefined,
  ): Promise<Observation[]> {
    const rows: Observation[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    let pageNumber = 0;

    while (true) {
      pageNumber += 1;
      checkPageBudget(pageNumber, rowLimit);

      const pageQuery = { ...query };

      if (cursor) {
        pageQuery["cursor"] = cursor;
      }

      const payload = await requestJson({
        path: "/api/public/v2/observations",
        query: pageQuery,
        signal,
        unsupportedOnMissing: cursor === null,
      });

      const page = parseCurrentPage(payload);
      const parsedRows = page.data.map(parseObservation);
      checkRowLimit(rows.length + parsedRows.length, rowLimit);
      rows.push(...parsedRows);

      if (!page.cursor) {
        return rows;
      }

      if (seenCursors.has(page.cursor)) {
        throw new ObserverError("INVALID_RESPONSE", "Langfuse returned a repeated page cursor");
      }

      seenCursors.add(page.cursor);
      cursor = page.cursor;
    }
  }
}

function boundedQueryScope(from: Date, to: Date): Extract<QueryScope, { kind: "bounded" }> {
  return Object.freeze({
    kind: "bounded",
    from: from.toISOString(),
    to: to.toISOString(),
  });
}

interface CurrentPage {
  readonly data: JsonValue[];
  readonly cursor: string | null;
}

function parseCurrentPage(payload: JsonValue): CurrentPage {
  if (!isJsonObject(payload)) {
    throw new ObserverError("INVALID_RESPONSE", "Langfuse returned an unexpected response shape");
  }

  const data = payload["data"];
  const meta = payload["meta"];

  if (!Array.isArray(data) || !isJsonObject(meta)) {
    throw new ObserverError("INVALID_RESPONSE", "Langfuse returned an unexpected response shape");
  }

  const cursor = meta["cursor"] ?? null;

  if (cursor !== null && (!isJsonString(cursor) || cursor.length === 0)) {
    throw new ObserverError("INVALID_RESPONSE", "Langfuse returned an invalid page cursor");
  }

  return { data, cursor };
}

function checkPageBudget(pageNumber: number, rowLimit: number): void {
  const pageLimit = Math.ceil(rowLimit / PAGE_SIZE);

  if (pageNumber > pageLimit) {
    throw new ObserverError(
      "RESULT_TOO_LARGE",
      `Langfuse returned more than ${pageLimit} result pages for this view`,
    );
  }
}

function parseLightObservation(value: JsonValue): Readonly<LightObservation> {
  if (!isJsonObject(value)) {
    throw new ObserverError("INVALID_RESPONSE", "Langfuse returned a non-object observation");
  }

  const core = parseObservationCore(value);

  return Object.freeze({
    ...core,
    traceName: optionalString(value["traceName"], "observation traceName"),
    environment: optionalString(value["environment"], "observation environment"),
    tags: stringArray(value["tags"], "observation tags"),
  });
}

function parseFullObservation(
  value: JsonValue,
  expectedTraceId: string,
): Readonly<FullObservation> {
  if (!isJsonObject(value)) {
    throw new ObserverError("INVALID_RESPONSE", "Langfuse returned a non-object observation");
  }

  const core = parseObservationCore(value);

  if (core.traceId !== expectedTraceId) {
    throw new ObserverError(
      "INVALID_RESPONSE",
      "Langfuse returned an observation from another trace",
    );
  }

  return Object.freeze({
    ...parseObservationFields(value, core),
    traceName: optionalString(value["traceName"], "observation traceName"),
    environment: optionalString(value["environment"], "observation environment"),
    tags: stringArray(value["tags"], "observation tags"),
    userId: optionalString(value["userId"], "observation userId"),
    sessionId: core.sessionId,
    isLogicalRoot: core.isLogicalRoot,
    totalCost: optionalNumber(value["totalCost"], "observation totalCost"),
  });
}
