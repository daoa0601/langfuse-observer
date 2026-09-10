import {
  describeTrace,
  startOfWindow,
  summarizeRecentTraces,
} from "./trace-model.js";

const RECENT_ROW_LIMIT = 5_000;
const TRACE_ROW_LIMIT = 10_000;
const TRACE_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 10_000;

export class ObserverError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "ObserverError";
    this.code = code;
  }
}

export function createLangfuseObserver(config, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const now = dependencies.now ?? (() => new Date());

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
      }, parseLightObservation, RECENT_ROW_LIMIT, (rows) => {
        return new Set(rows.map((row) => row.traceId)).size >= 50;
      });

      return Object.freeze({
        window,
        queriedAt: to.toISOString(),
        traces: summarizeRecentTraces(observations),
      });
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

      return describeTrace(traceId, observations);
    },
  });

  async function readObservationPages(query, parseObservation, rowLimit, shouldStop = () => false) {
    const rows = [];
    const seenCursors = new Set();
    let cursor = null;

    while (true) {
      const pageQuery = new URLSearchParams(query);
      if (cursor) {
        pageQuery.set("cursor", cursor);
      }

      const page = await requestPage(pageQuery);
      const parsedRows = page.data.map(parseObservation);
      if (rows.length + parsedRows.length > rowLimit) {
        throw new ObserverError(
          "RESULT_TOO_LARGE",
          `Langfuse returned more than ${rowLimit.toLocaleString()} observations for this view`,
        );
      }
      rows.push(...parsedRows);

      if (!page.cursor || shouldStop(rows)) {
        return rows;
      }
      if (seenCursors.has(page.cursor)) {
        throw new ObserverError("INVALID_RESPONSE", "Langfuse returned a repeated page cursor");
      }
      seenCursors.add(page.cursor);
      cursor = page.cursor;
    }
  }

  async function requestPage(query) {
    const url = new URL("/api/public/v2/observations", config.baseUrl);
    url.search = query.toString();

    let response;
    try {
      response = await fetchImpl(url, {
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`,
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
      throw errorForStatus(response.status);
    }

    let payload;
    try {
      payload = await response.json();
    } catch (cause) {
      throw new ObserverError("INVALID_RESPONSE", "Langfuse returned invalid JSON", { cause });
    }

    if (!isRecord(payload) || !Array.isArray(payload.data)) {
      throw new ObserverError("INVALID_RESPONSE", "Langfuse returned an unexpected response shape");
    }

    const cursor = isRecord(payload.meta) && typeof payload.meta.cursor === "string"
      ? payload.meta.cursor
      : null;
    return { data: payload.data, cursor };
  }
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
    ...core,
    traceName: optionalString(value.traceName),
    environment: optionalString(value.environment),
    tags: stringArray(value.tags),
    statusMessage: optionalString(value.statusMessage),
    userId: optionalString(value.userId),
    sessionId: optionalString(value.sessionId),
    input: displayText(value.input),
    output: displayText(value.output),
    metadata: jsonValue(value.metadata, {}),
    model: optionalString(value.model),
    modelParameters: jsonValue(value.modelParameters, {}),
    usage: numberRecord(value.usageDetails),
    cost: numberRecord(value.costDetails),
    totalCost: optionalNumber(value.totalCost),
    promptName: optionalString(value.promptName),
    promptVersion: optionalNumber(value.promptVersion),
    latency: optionalNumber(value.latency),
    timeToFirstToken: optionalNumber(value.timeToFirstToken),
  });
}

function parseCore(value) {
  if (!isRecord(value)) {
    throw new ObserverError("INVALID_RESPONSE", "Langfuse returned a non-object observation");
  }

  const id = requiredString(value.id, "id");
  const traceId = requiredString(value.traceId, "traceId");
  const startTime = requiredDate(value.startTime, "startTime");

  return {
    id,
    traceId,
    parentId: optionalString(value.parentObservationId),
    type: requiredString(value.type, "type"),
    name: optionalString(value.name),
    level: optionalString(value.level) ?? "DEFAULT",
    startTime,
    endTime: optionalDate(value.endTime, "endTime"),
    isLogicalRoot: value.isRootObservation === true,
  };
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ObserverError("INVALID_RESPONSE", `Langfuse observation is missing ${field}`);
  }
  return value;
}

function optionalString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requiredDate(value, field) {
  const date = optionalDate(value, field);
  if (date === null) {
    throw new ObserverError("INVALID_RESPONSE", `Langfuse observation is missing ${field}`);
  }
  return date;
}

function optionalDate(value, field) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new ObserverError("INVALID_RESPONSE", `Langfuse observation has an invalid ${field}`);
  }
  return new Date(value).toISOString();
}

function optionalNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
