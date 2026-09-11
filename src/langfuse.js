import {
  describeSession,
  describeTrace,
  startOfWindow,
  summarizeRecentSessions,
  summarizeRecentTraces,
} from "./trace-model.js";

const RECENT_ROW_LIMIT = 20_000;
const SESSION_ROW_LIMIT = 20_000;
const TRACE_ROW_LIMIT = 10_000;
const TRACE_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1_000;
const LEGACY_PAGE_LIMIT = 100;
const REQUEST_TIMEOUT_MS = 10_000;

export class ObserverError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "ObserverError";
    this.code = code;
  }
}

export function createLangfuseObserver(config, dependencies = {}) {
  const now = dependencies.now ?? (() => new Date());
  const requestJson = createJsonRequester(config, dependencies.fetchImpl ?? globalThis.fetch);
  const observers = Object.freeze({
    v3: createLegacyObserver({ now, requestJson }),
    v4: createCurrentObserver({ now, requestJson }),
  });
  let selectedVersion = config.apiVersion ?? "auto";

  return Object.freeze({
    listRecentTraces: (window) => call("listRecentTraces", window),
    listRecentSessions: (window) => call("listRecentSessions", window),
    getSession: (sessionId) => call("getSession", sessionId),
    getTrace: (traceId) => call("getTrace", traceId),
  });

  async function call(method, argument) {
    if (selectedVersion !== "auto") {
      return observers[selectedVersion][method](argument);
    }

    try {
      const result = await observers.v4[method](argument);
      selectedVersion = "v4";
      return result;
    } catch (error) {
      if (!(error instanceof ObserverError) || error.code !== "UNSUPPORTED_API") {
        throw error;
      }
      selectedVersion = "v3";
      return observers.v3[method](argument);
    }
  }
}

function createCurrentObserver({ now, requestJson }) {
  return Object.freeze({
    async listRecentTraces(window) {
      const to = now();
      const from = startOfWindow(window, to);
      const observations = await readObservationPages({
        fields: "core,basic,trace_context",
        isRootObservation: "true",
        fromStartTime: from.toISOString(),
        toStartTime: to.toISOString(),
        limit: "1000",
      }, parseLightObservation, RECENT_ROW_LIMIT);

      return Object.freeze({
        apiVersion: "v4",
        window,
        queriedAt: to.toISOString(),
        traces: summarizeRecentTraces(observations),
      });
    },

    async listRecentSessions(window) {
      const to = now();
      const from = startOfWindow(window, to);
      const observations = await readObservationPages({
        fields: "core,basic,trace_context",
        fromStartTime: from.toISOString(),
        toStartTime: to.toISOString(),
        limit: "1000",
      }, parseLightObservation, RECENT_ROW_LIMIT);

      return Object.freeze({
        apiVersion: "v4",
        window,
        queriedAt: to.toISOString(),
        sessions: summarizeRecentSessions(observations),
      });
    },

    async getSession(sessionId) {
      const to = now();
      const from = new Date(to.getTime() - TRACE_LOOKBACK_MS);
      const filter = JSON.stringify([
        { type: "string", column: "sessionId", operator: "=", value: sessionId },
      ]);
      const observations = await readObservationPages({
        fields: "core,basic,trace_context",
        filter,
        fromStartTime: from.toISOString(),
        toStartTime: to.toISOString(),
        limit: "1000",
      }, parseLightObservation, SESSION_ROW_LIMIT);

      const session = describeSession(sessionId, observations);
      return session ? Object.freeze({ ...session, apiVersion: "v4" }) : null;
    },

    async getTrace(traceId) {
      const to = now();
      const from = new Date(to.getTime() - TRACE_LOOKBACK_MS);
      const observations = await readObservationPages({
        fields: "core,basic,time,io,metadata,model,usage,prompt,metrics,trace_context",
        traceId,
        fromStartTime: from.toISOString(),
        toStartTime: to.toISOString(),
        limit: "1000",
      }, (value) => parseFullObservation(value, traceId), TRACE_ROW_LIMIT);

      const trace = describeTrace(traceId, observations);
      return trace ? Object.freeze({ ...trace, apiVersion: "v4" }) : null;
    },
  });

  async function readObservationPages(query, parseObservation, rowLimit) {
    const rows = [];
    const seenCursors = new Set();
    let cursor = null;

    while (true) {
      const pageQuery = { ...query };
      if (cursor) {
        pageQuery.cursor = cursor;
      }

      const payload = await requestJson({
        path: "/api/public/v2/observations",
        query: pageQuery,
        unsupportedOnMissing: true,
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

function createLegacyObserver({ now, requestJson }) {
  return Object.freeze({
    async listRecentTraces(window) {
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
        rowLimit: RECENT_ROW_LIMIT,
      });

      return Object.freeze({
        apiVersion: "v3",
        window,
        queriedAt: to.toISOString(),
        traces: traces.map(summarizeLegacyTrace)
          .sort((left, right) => right.latestRootAt.localeCompare(left.latestRootAt)),
      });
    },

    async listRecentSessions(window) {
      const to = now();
      const from = startOfWindow(window, to);
      const sessions = await readLegacyPages({
        path: "/api/public/sessions",
        query: {
          fromTimestamp: from.toISOString(),
          toTimestamp: to.toISOString(),
        },
        parseRow: parseLegacySession,
        rowLimit: RECENT_ROW_LIMIT,
      });

      return Object.freeze({
        apiVersion: "v3",
        window,
        queriedAt: to.toISOString(),
        sessions: sessions.map(summarizeLegacySession)
          .sort((left, right) => right.latestAt.localeCompare(left.latestAt)),
      });
    },

    async getSession(sessionId) {
      let payload;
      try {
        payload = await requestJson({
          path: `/api/public/sessions/${encodeURIComponent(sessionId)}`,
          notFoundAsMissingRecord: true,
        });
      } catch (error) {
        if (error instanceof ObserverError && error.code === "NOT_FOUND") {
          return null;
        }
        throw error;
      }

      return describeLegacySession(sessionId, payload);
    },

    async getTrace(traceId) {
      let payload;
      try {
        payload = await requestJson({
          path: `/api/public/traces/${encodeURIComponent(traceId)}`,
          query: { fields: "core,io,observations,metrics" },
          notFoundAsMissingRecord: true,
        });
      } catch (error) {
        if (error instanceof ObserverError && error.code === "NOT_FOUND") {
          return null;
        }
        throw error;
      }

      return describeLegacyTrace(traceId, payload);
    },
  });

  async function readLegacyPages({ path, query, parseRow, rowLimit }) {
    const rows = [];
    let pageNumber = 1;

    while (true) {
      const payload = await requestJson({
        path,
        query: {
          ...query,
          limit: String(LEGACY_PAGE_LIMIT),
          page: String(pageNumber),
        },
      });
      const page = parseLegacyPage(payload, pageNumber);
      checkRowLimit(page.totalItems, rowLimit);

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

function createJsonRequester(config, fetchImpl) {
  const authorization = `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`;

  return async function requestJson({
    path,
    query = {},
    unsupportedOnMissing = false,
    notFoundAsMissingRecord = false,
  }) {
    const url = new URL(path, config.baseUrl);
    url.search = new URLSearchParams(query).toString();

    let response;
    try {
      response = await fetchImpl(url, {
        headers: {
          Accept: "application/json",
          Authorization: authorization,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      const timeout = cause?.name === "TimeoutError" || cause?.name === "AbortError";
      throw new ObserverError(
        timeout ? "TIMEOUT" : "UNAVAILABLE",
        timeout ? "Langfuse did not respond within 10 seconds" : "Could not reach Langfuse",
        { cause },
      );
    }

    if (!response.ok) {
      if (unsupportedOnMissing && (response.status === 404 || response.status === 405)) {
        throw new ObserverError("UNSUPPORTED_API", "This Langfuse deployment does not provide the v4 Observations API");
      }
      if (notFoundAsMissingRecord && response.status === 404) {
        throw new ObserverError("NOT_FOUND", "Langfuse did not find this record");
      }
      throw errorForStatus(response.status);
    }

    try {
      return await response.json();
    } catch (cause) {
      throw new ObserverError("INVALID_RESPONSE", "Langfuse returned invalid JSON", { cause });
    }
  };
}

function parseCurrentPage(payload) {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new ObserverError("INVALID_RESPONSE", "Langfuse returned an unexpected response shape");
  }

  const cursor = isRecord(payload.meta) && typeof payload.meta.cursor === "string"
    ? payload.meta.cursor
    : null;
  return { data: payload.data, cursor };
}

function parseLegacyPage(payload, expectedPage) {
  if (!isRecord(payload) || !Array.isArray(payload.data) || !isRecord(payload.meta)) {
    throw new ObserverError("INVALID_RESPONSE", "Langfuse returned an unexpected legacy response shape");
  }

  const page = requiredPositiveInteger(payload.meta.page, "meta.page");
  const totalPages = requiredNonNegativeInteger(payload.meta.totalPages, "meta.totalPages");
  const totalItems = requiredNonNegativeInteger(payload.meta.totalItems, "meta.totalItems");
  if (page !== expectedPage) {
    throw new ObserverError("INVALID_RESPONSE", `Langfuse returned page ${page} while page ${expectedPage} was requested`);
  }
  if (totalPages === 0 && payload.data.length > 0) {
    throw new ObserverError("INVALID_RESPONSE", "Langfuse returned rows with zero total pages");
  }

  return { data: payload.data, totalItems, totalPages };
}

function describeLegacyTrace(expectedTraceId, payload) {
  const trace = parseLegacyTrace(payload);
  if (trace.id !== expectedTraceId) {
    throw new ObserverError("INVALID_RESPONSE", "Langfuse returned a different trace");
  }
  if (!Array.isArray(payload.observations)) {
    throw new ObserverError("INVALID_RESPONSE", "Langfuse trace is missing its observations");
  }
  checkRowLimit(payload.observations.length, TRACE_ROW_LIMIT);

  const observations = payload.observations.map((value) =>
    parseLegacyObservation(value, trace),
  );
  const described = describeTrace(trace.id, observations) ?? Object.freeze({
    id: trace.id,
    name: trace.name ?? trace.id,
    observationCount: 0,
    startedAt: trace.timestamp,
    endedAt: endTimeFromLatency(trace.timestamp, optionalNumber(payload.latency)),
    sessionIds: trace.sessionId ? [trace.sessionId] : [],
    rows: [],
  });

  return Object.freeze({
    ...described,
    apiVersion: "v3",
    totalCost: optionalNumber(payload.totalCost),
    traceContext: Object.freeze({
      environment: trace.environment,
      input: displayText(payload.input),
      metadata: jsonValue(payload.metadata, {}),
      output: displayText(payload.output),
      release: optionalString(payload.release),
      tags: trace.tags,
      userId: optionalString(payload.userId),
      version: optionalString(payload.version),
    }),
  });
}

function describeLegacySession(expectedSessionId, payload) {
  const session = parseLegacySession(payload);
  if (session.id !== expectedSessionId) {
    throw new ObserverError("INVALID_RESPONSE", "Langfuse returned a different session");
  }
  if (!Array.isArray(payload.traces)) {
    throw new ObserverError("INVALID_RESPONSE", "Langfuse session is missing its traces");
  }
  checkRowLimit(payload.traces.length, SESSION_ROW_LIMIT);

  const traces = payload.traces.map(parseLegacyTrace)
    .map((trace) => Object.freeze({
      environment: trace.environment,
      highestLevel: "DEFAULT",
      id: trace.id,
      latestAt: trace.timestamp,
      name: trace.name ?? trace.id,
      observationCount: null,
      startedAt: trace.timestamp,
      tags: trace.tags,
    }))
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  const timestamps = traces.map((trace) => trace.startedAt);

  return Object.freeze({
    apiVersion: "v3",
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

function parseLegacyTrace(value) {
  if (!isRecord(value)) {
    throw new ObserverError("INVALID_RESPONSE", "Langfuse returned a non-object trace");
  }

  return Object.freeze({
    id: requiredString(value.id, "trace id"),
    name: optionalString(value.name),
    timestamp: requiredDate(value.timestamp, "trace timestamp"),
    sessionId: optionalString(value.sessionId),
    userId: optionalString(value.userId),
    environment: optionalString(value.environment),
    tags: stringArray(value.tags),
  });
}

function parseLegacySession(value) {
  if (!isRecord(value)) {
    throw new ObserverError("INVALID_RESPONSE", "Langfuse returned a non-object session");
  }

  return Object.freeze({
    id: requiredString(value.id, "session id"),
    createdAt: requiredDate(value.createdAt, "session createdAt"),
    environment: optionalString(value.environment),
  });
}

function summarizeLegacyTrace(trace) {
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

function summarizeLegacySession(session) {
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

function parseLegacyObservation(value, trace) {
  const core = parseCore(value);
  if (core.traceId !== trace.id) {
    throw new ObserverError("INVALID_RESPONSE", "Langfuse returned an observation from another trace");
  }

  return Object.freeze({
    ...parseObservationFields(value, core),
    traceName: trace.name,
    environment: trace.environment,
    tags: trace.tags,
    userId: trace.userId,
    sessionId: trace.sessionId,
    isLogicalRoot: core.parentId === null,
    totalCost: firstNumber(value.calculatedTotalCost, value.totalPrice),
  });
}

function parseLightObservation(value) {
  const core = parseCore(value);
  return Object.freeze({
    ...core,
    traceName: optionalString(value.traceName),
    environment: optionalString(value.environment),
    tags: stringArray(value.tags),
  });
}

function parseFullObservation(value, expectedTraceId) {
  const core = parseCore(value);
  if (core.traceId !== expectedTraceId) {
    throw new ObserverError("INVALID_RESPONSE", "Langfuse returned an observation from another trace");
  }

  return Object.freeze({
    ...parseObservationFields(value, core),
    traceName: optionalString(value.traceName),
    environment: optionalString(value.environment),
    tags: stringArray(value.tags),
    userId: optionalString(value.userId),
    sessionId: core.sessionId,
    isLogicalRoot: core.isLogicalRoot,
    totalCost: optionalNumber(value.totalCost),
  });
}

function parseObservationFields(value, core) {
  return {
    ...core,
    statusMessage: optionalString(value.statusMessage),
    input: displayText(value.input),
    output: displayText(value.output),
    metadata: jsonValue(value.metadata, {}),
    model: optionalString(value.model),
    modelParameters: jsonValue(value.modelParameters, {}),
    usage: numberRecord(value.usageDetails),
    cost: numberRecord(value.costDetails),
    promptName: optionalString(value.promptName),
    promptVersion: optionalNumber(value.promptVersion),
    latency: optionalNumber(value.latency),
    timeToFirstToken: optionalNumber(value.timeToFirstToken),
  };
}

function parseCore(value) {
  if (!isRecord(value)) {
    throw new ObserverError("INVALID_RESPONSE", "Langfuse returned a non-object observation");
  }

  return {
    id: requiredString(value.id, "observation id"),
    traceId: requiredString(value.traceId, "observation traceId"),
    parentId: optionalString(value.parentObservationId),
    type: requiredString(value.type, "observation type"),
    name: optionalString(value.name),
    sessionId: optionalString(value.sessionId),
    level: optionalString(value.level) ?? "DEFAULT",
    startTime: requiredDate(value.startTime, "observation startTime"),
    endTime: optionalDate(value.endTime, "observation endTime"),
    isLogicalRoot: value.isRootObservation === true,
  };
}

function errorForStatus(status) {
  if (status === 401 || status === 403) {
    return new ObserverError("AUTH_FAILED", "Langfuse rejected the configured credentials");
  }
  if (status === 429) {
    return new ObserverError("RATE_LIMITED", "Langfuse rate-limited this request");
  }
  return new ObserverError("UPSTREAM_ERROR", `Langfuse returned HTTP ${status}`);
}

function checkRowLimit(count, rowLimit) {
  if (count > rowLimit) {
    throw new ObserverError(
      "RESULT_TOO_LARGE",
      `Langfuse returned more than ${rowLimit.toLocaleString()} records for this view`,
    );
  }
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ObserverError("INVALID_RESPONSE", `Langfuse response is missing ${field}`);
  }
  return value;
}

function optionalString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requiredDate(value, field) {
  const date = optionalDate(value, field);
  if (date === null) {
    throw new ObserverError("INVALID_RESPONSE", `Langfuse response is missing ${field}`);
  }
  return date;
}

function optionalDate(value, field) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new ObserverError("INVALID_RESPONSE", `Langfuse response has an invalid ${field}`);
  }
  return new Date(value).toISOString();
}

function requiredPositiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) {
    throw new ObserverError("INVALID_RESPONSE", `Langfuse response has an invalid ${field}`);
  }
  return value;
}

function requiredNonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new ObserverError("INVALID_RESPONSE", `Langfuse response has an invalid ${field}`);
  }
  return value;
}

function optionalNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function firstNumber(...values) {
  return values.find((value) => typeof value === "number" && Number.isFinite(value)) ?? null;
}

function numberRecord(value) {
  if (!isRecord(value)) {
    return Object.freeze({});
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(value).filter((entry) => typeof entry[1] === "number" && Number.isFinite(entry[1])),
  ));
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function displayText(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function jsonValue(value, fallback) {
  try {
    return value === undefined ? fallback : JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function endTimeFromLatency(startTime, latencySeconds) {
  return latencySeconds === null
    ? null
    : new Date(Date.parse(startTime) + latencySeconds * 1_000).toISOString();
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
