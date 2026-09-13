import type {
  FetchImplementation,
  JsonValue,
  NumberFields,
  ObservationCore,
  ObserverErrorCode,
  ParsedObservationFields,
  RequestJson,
} from "./observer-types.ts";
import {
  isJsonBoolean,
  isJsonNumber,
  isJsonObject,
  isJsonString,
  isJsonValue,
  type JsonObject,
} from "./json.ts";

const PAGE_REQUEST_TIMEOUT_MS = 10_000;

export const QUERY_LIMITS = Object.freeze({
  recent: 20_000,
  session: 20_000,
  trace: 10_000,
});

export const TRACE_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1_000;

export class ObserverError extends Error {
  readonly code: ObserverErrorCode;
  readonly retryAfterSeconds: number | null;

  constructor(
    code: ObserverErrorCode,
    message: string,
    options: ErrorOptions & { retryAfterSeconds?: number | null } = {},
  ) {
    const { retryAfterSeconds = null, ...errorOptions } = options;
    super(message, errorOptions);
    this.name = "ObserverError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function createJsonRequester(
  config: Readonly<{
    baseUrl: URL;
    publicKey: string;
    secretKey: string;
  }>,
  fetchImpl: FetchImplementation,
): RequestJson {
  const authorization = `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`;

  return async function requestJson({
    path,
    query = {},
    unsupportedOnMissing = false,
    notFoundAsMissingRecord = false,
    signal,
  }) {
    const url = new URL(path, config.baseUrl);
    url.search = new URLSearchParams(query).toString();

    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(PAGE_REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(PAGE_REQUEST_TIMEOUT_MS);

    let response;

    try {
      response = await fetchImpl(url, {
        headers: {
          Accept: "application/json",
          Authorization: authorization,
        },
        signal: requestSignal,
      });
    } catch (cause) {
      throw (
        requestFailure(cause, requestSignal) ??
        new ObserverError("UNAVAILABLE", "Could not reach Langfuse", { cause })
      );
    }

    if (!response.ok) {
      if (unsupportedOnMissing && (response.status === 404 || response.status === 405)) {
        throw new ObserverError(
          "UNSUPPORTED_API",
          "This Langfuse deployment does not provide the v4 Observations API",
        );
      }

      if (notFoundAsMissingRecord && response.status === 404) {
        throw new ObserverError("NOT_FOUND", "Langfuse did not find this record");
      }

      throw errorForStatus(response.status, response.headers.get("retry-after"));
    }

    try {
      const value: unknown = await response.json();

      if (!isJsonValue(value)) {
        throw new TypeError("Response body is not JSON data");
      }

      return value;
    } catch (cause) {
      const failure = requestFailure(cause, requestSignal);

      if (failure) {
        throw failure;
      }

      throw new ObserverError("INVALID_RESPONSE", "Langfuse returned invalid JSON", { cause });
    }
  };
}

export function checkRowLimit(count: number, rowLimit: number): void {
  if (count > rowLimit) {
    throw new ObserverError(
      "RESULT_TOO_LARGE",
      `Langfuse returned more than ${rowLimit.toLocaleString()} records for this view`,
    );
  }
}

export function parseObservationFields(
  value: JsonObject,
  core: ObservationCore,
): Readonly<ParsedObservationFields> {
  return {
    ...core,
    statusMessage: optionalString(value["statusMessage"], "observation statusMessage"),
    input: value["input"] ?? null,
    output: value["output"] ?? null,
    metadata: value["metadata"] ?? null,
    model: optionalString(value["model"], "observation model"),
    modelParameters: value["modelParameters"] ?? null,
    usage: numberRecord(value["usageDetails"], "observation usageDetails"),
    cost: numberRecord(value["costDetails"], "observation costDetails"),
    promptName: optionalString(value["promptName"], "observation promptName"),
    promptVersion: optionalNumber(value["promptVersion"], "observation promptVersion"),
    latency: optionalNumber(value["latency"], "observation latency"),
    timeToFirstToken: optionalNumber(value["timeToFirstToken"], "observation timeToFirstToken"),
  };
}

export function parseObservationCore(value: JsonObject): Readonly<ObservationCore> {
  return {
    id: requiredString(value["id"], "observation id"),
    traceId: requiredString(value["traceId"], "observation traceId"),
    parentId: optionalString(value["parentObservationId"], "observation parentObservationId"),
    type: requiredString(value["type"], "observation type"),
    name: optionalString(value["name"], "observation name"),
    sessionId: optionalString(value["sessionId"], "observation sessionId"),
    level: optionalString(value["level"], "observation level") ?? "DEFAULT",
    startTime: requiredDate(value["startTime"], "observation startTime"),
    endTime: optionalDate(value["endTime"], "observation endTime"),
    isLogicalRoot:
      optionalBoolean(value["isRootObservation"], "observation isRootObservation") ?? false,
  };
}

export function requiredString(value: JsonValue | undefined, field: string): string {
  if (!isJsonString(value) || value.length === 0) {
    throw new ObserverError("INVALID_RESPONSE", `Langfuse response is missing ${field}`);
  }

  return value;
}

export function optionalString(value: JsonValue | undefined, field: string): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (!isJsonString(value)) {
    throw new ObserverError("INVALID_RESPONSE", `Langfuse response has an invalid ${field}`);
  }

  return value;
}

export function requiredDate(value: JsonValue | undefined, field: string): string {
  const date = optionalDate(value, field);

  if (date === null) {
    throw new ObserverError("INVALID_RESPONSE", `Langfuse response is missing ${field}`);
  }

  return date;
}

export function optionalDate(value: JsonValue | undefined, field: string): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (!isJsonString(value) || Number.isNaN(Date.parse(value))) {
    throw new ObserverError("INVALID_RESPONSE", `Langfuse response has an invalid ${field}`);
  }

  return new Date(value).toISOString();
}

export function requiredPositiveInteger(value: JsonValue | undefined, field: string): number {
  if (!isJsonNumber(value) || !Number.isInteger(value) || value < 1) {
    throw new ObserverError("INVALID_RESPONSE", `Langfuse response has an invalid ${field}`);
  }

  return value;
}

export function requiredNonNegativeInteger(value: JsonValue | undefined, field: string): number {
  if (!isJsonNumber(value) || !Number.isInteger(value) || value < 0) {
    throw new ObserverError("INVALID_RESPONSE", `Langfuse response has an invalid ${field}`);
  }

  return value;
}

export function optionalNumber(value: JsonValue | undefined, field: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (!isJsonNumber(value) || !Number.isFinite(value)) {
    throw new ObserverError("INVALID_RESPONSE", `Langfuse response has an invalid ${field}`);
  }

  return value;
}

export function firstNumber(...values: Array<number | null>): number | null {
  for (const value of values) {
    if (value !== null) {
      return value;
    }
  }

  return null;
}

export function numberRecord(value: JsonValue | undefined, field: string): NumberFields {
  if (value === null || value === undefined) {
    return Object.freeze({});
  }

  if (!isJsonObject(value)) {
    throw new ObserverError("INVALID_RESPONSE", `Langfuse response has an invalid ${field}`);
  }

  const numbers: Record<string, number> = {};

  for (const [key, item] of Object.entries(value)) {
    if (!isJsonNumber(item) || !Number.isFinite(item)) {
      throw new ObserverError(
        "INVALID_RESPONSE",
        `Langfuse response has an invalid ${field}.${key}`,
      );
    }

    numbers[key] = item;
  }

  return Object.freeze(numbers);
}

export function stringArray(value: JsonValue | undefined, field: string): readonly string[] {
  if (value === null || value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || !value.every(isJsonString)) {
    throw new ObserverError("INVALID_RESPONSE", `Langfuse response has an invalid ${field}`);
  }

  return value;
}

function optionalBoolean(value: JsonValue | undefined, field: string): boolean | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (!isJsonBoolean(value)) {
    throw new ObserverError("INVALID_RESPONSE", `Langfuse response has an invalid ${field}`);
  }

  return value;
}

export function endTimeFromLatency(
  startTime: string,
  latencySeconds: number | null,
): string | null {
  return latencySeconds === null
    ? null
    : new Date(Date.parse(startTime) + latencySeconds * 1_000).toISOString();
}

function requestFailure(cause: unknown, signal: AbortSignal): ObserverError | null {
  const reason = signal.aborted ? signal.reason : cause;

  if (errorName(reason) === "TimeoutError" || errorName(cause) === "TimeoutError") {
    return new ObserverError("TIMEOUT", "Langfuse did not respond before the request deadline", {
      cause,
    });
  }

  if (signal.aborted || errorName(reason) === "AbortError") {
    return new ObserverError("CANCELLED", "Viewer request was cancelled", { cause });
  }

  return null;
}

function errorName(cause: unknown): string | null {
  return isNamedCause(cause) ? cause.name : null;
}

function isNamedCause(cause: unknown): cause is Readonly<{ name: string }> {
  return (
    typeof cause === "object" && cause !== null && "name" in cause && typeof cause.name === "string"
  );
}

function errorForStatus(status: number, retryAfter: string | null): ObserverError {
  if (status === 401 || status === 403) {
    return new ObserverError("AUTH_FAILED", "Langfuse rejected the configured credentials");
  }

  if (status === 429) {
    return new ObserverError("RATE_LIMITED", "Langfuse rate-limited this request", {
      retryAfterSeconds: parseRetryAfter(retryAfter),
    });
  }

  return new ObserverError("UPSTREAM_ERROR", `Langfuse returned HTTP ${status}`);
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null) {
    return null;
  }

  const seconds = Number(value);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds);
  }

  const date = Date.parse(value);

  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - Date.now()) / 1_000));
}
