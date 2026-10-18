import { Buffer } from "node:buffer";

export interface TraceConfig {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
  environment: string;
}

export interface Observation {
  traceId: string;
  id: string;
  parentId?: string;
  sessionId: string;
  traceName: string;
  name: string;
  type: "AGENT" | "GENERATION" | "TOOL";
  startTime: number;
  endTime: number;
  input?: string;
  output?: string;
  model?: string;
  /** Input includes the cache buckets. Total equals input + output. */
  usage?: { input: number; output: number; total: number; cacheRead?: number; cacheWrite?: number };
  cost?: { input: number; output: number; total: number };
  error?: boolean;
}

interface ExportStatus {
  pending: number;
  dropped: number;
  lastError: string | null;
  sent: number;
}

interface Attribute {
  key: string;
  value: { stringValue: string };
}

interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attribute[];
  status: { code: number };
}

interface Destination {
  endpoint: string;
  authorization: string;
  environment: string;
}

interface QueuedSpan {
  json: string;
  bytes: number;
}

interface PartialSuccess {
  rejectedSpans?: number | string;
  errorMessage?: string;
}

interface Acknowledgement {
  partialSuccess?: PartialSuccess;
}

const MAX_PENDING = 256;

const MAX_QUEUE_BYTES = 4 * 1024 * 1024;

const MAX_SPAN_BYTES = 256 * 1024;

const MAX_BATCH_BYTES = 1024 * 1024;

const MAX_BATCH_SIZE = 64;

const MAX_RESPONSE_BYTES = 16 * 1024;

const MAX_TIME_MS = 18_446_744_073_709;

const PREFIX =
  '{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"prime-agent"}}]},"scopeSpans":[{"scope":{"name":"prime-agent-langfuse","version":"1.0.0"},"spans":[';

const SUFFIX = "]}]}]}";

function destination(config: TraceConfig): Destination | null {
  try {
    const url = new URL(config.baseUrl);

    const loopback =
      url.hostname === "localhost" ||
      url.hostname === "[::1]" ||
      /^127\.\d+\.\d+\.\d+$/.test(url.hostname);

    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !config.publicKey.trim() ||
      !config.secretKey.trim() ||
      config.publicKey.length > 4096 ||
      config.secretKey.length > 4096 ||
      !/^[!-~]+$/.test(config.publicKey) ||
      config.publicKey.includes(":") ||
      !/^[!-~]+$/.test(config.secretKey) ||
      !/^(?!langfuse)[a-z0-9_-]{1,40}$/.test(config.environment)
    )
      return null;

    url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/public/otel/v1/traces`;

    return {
      endpoint: url.href,
      authorization: `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`, "utf8").toString("base64")}`,
      environment: config.environment,
    };
  } catch {
    return null;
  }
}

function validId(value: string, length: number): boolean {
  return value.length === length && /^[a-fA-F0-9]+$/.test(value) && !/^0+$/.test(value);
}

function validPayload(value: string | undefined): boolean {
  if (value === undefined) return true;

  if (value.length > MAX_SPAN_BYTES) return false;

  try {
    JSON.parse(value);

    return true;
  } catch {
    return false;
  }
}

function nonnegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function validMetrics(observation: Observation): boolean {
  const { usage, cost } = observation;

  if (usage) {
    const counts = [
      usage.input,
      usage.output,
      usage.total,
      usage.cacheRead ?? 0,
      usage.cacheWrite ?? 0,
    ];

    if (
      !counts.every((value) => Number.isSafeInteger(value) && value >= 0) ||
      usage.input + usage.output !== usage.total ||
      (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) > usage.input
    )
      return false;
  }

  if (cost) {
    if (![cost.input, cost.output, cost.total].every(nonnegative)) return false;
    const sum = cost.input + cost.output;

    if (!Number.isFinite(sum) || Math.abs(sum - cost.total) > 1e-9 * Math.max(1, sum)) return false;
  }

  return true;
}

function validObservation(observation: Observation): boolean {
  return (
    validId(observation.traceId, 32) &&
    validId(observation.id, 16) &&
    (observation.parentId === undefined ||
      (validId(observation.parentId, 16) &&
        observation.parentId.toLowerCase() !== observation.id.toLowerCase())) &&
    [observation.sessionId, observation.traceName, observation.name].every(
      (value) => value.length > 0 && value.length <= 1024,
    ) &&
    (observation.model === undefined || observation.model.length <= 1024) &&
    ["AGENT", "GENERATION", "TOOL"].includes(observation.type) &&
    [observation.startTime, observation.endTime].every(
      (value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIME_MS,
    ) &&
    observation.endTime >= observation.startTime &&
    validPayload(observation.input) &&
    validPayload(observation.output) &&
    validMetrics(observation)
  );
}

function attribute(key: string, value: string): Attribute {
  return { key, value: { stringValue: value } };
}

function serialize(observation: Observation, environment: string): string {
  const attributes = [
    attribute("session.id", observation.sessionId),
    attribute("langfuse.trace.name", observation.traceName),
    attribute("langfuse.environment", environment),
    attribute("langfuse.observation.type", observation.type.toLowerCase()),
    attribute("langfuse.observation.level", observation.error ? "ERROR" : "DEFAULT"),
  ];

  if (observation.input !== undefined) {
    attributes.push(attribute("langfuse.observation.input", observation.input));

    if (!observation.parentId)
      attributes.push(attribute("langfuse.trace.input", observation.input));
  }

  if (observation.output !== undefined) {
    attributes.push(attribute("langfuse.observation.output", observation.output));

    if (!observation.parentId)
      attributes.push(attribute("langfuse.trace.output", observation.output));
  }

  if (observation.type === "GENERATION") {
    if (observation.model)
      attributes.push(attribute("langfuse.observation.model.name", observation.model));

    if (observation.usage) {
      const usage = observation.usage;
      attributes.push(
        attribute(
          "langfuse.observation.usage_details",
          JSON.stringify({
            input: usage.input - (usage.cacheRead ?? 0) - (usage.cacheWrite ?? 0),
            output: usage.output,
            total: usage.total,
            input_cached_tokens: usage.cacheRead ?? 0,
            input_cache_creation_tokens: usage.cacheWrite ?? 0,
          }),
        ),
      );
    }

    if (observation.cost)
      attributes.push(
        attribute("langfuse.observation.cost_details", JSON.stringify(observation.cost)),
      );
  }

  const span: Span = {
    traceId: observation.traceId.toLowerCase(),
    spanId: observation.id.toLowerCase(),
    name: observation.name,
    kind: 1,
    startTimeUnixNano: (BigInt(observation.startTime) * 1_000_000n).toString(),
    endTimeUnixNano: (BigInt(observation.endTime) * 1_000_000n).toString(),
    attributes,
    status: { code: observation.error ? 2 : 1 },
  };

  if (observation.parentId) span.parentSpanId = observation.parentId.toLowerCase();

  return JSON.stringify(span);
}

function isPartialSuccess(value: unknown): value is PartialSuccess {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (!("rejectedSpans" in value) ||
      typeof value.rejectedSpans === "number" ||
      typeof value.rejectedSpans === "string") &&
    (!("errorMessage" in value) || typeof value.errorMessage === "string")
  );
}

function isAcknowledgement(value: unknown): value is Acknowledgement {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !("error" in value) &&
    !("code" in value) &&
    !("message" in value) &&
    (!("partialSuccess" in value) || isPartialSuccess(value.partialSuccess))
  );
}

async function responseText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";

  try {
    for (;;) {
      const chunk = await reader.read();

      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;

      if (bytes > MAX_RESPONSE_BYTES) throw new Error("Invalid acknowledgement");
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function retryDelay(header: string | null): number {
  if (!header) return 0;
  const seconds = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();

  return Number.isFinite(seconds) ? Math.max(0, Math.min(seconds, 24 * 60 * 60 * 1000)) : 0;
}

/** An inert, bounded exporter. The managed plugin lifecycle must call flush(). */
export class LangfuseExporter {
  private readonly target: Destination | null;
  private readonly queue: QueuedSpan[] = [];
  private queueBytes = 0;
  private dropped = 0;
  private sent = 0;
  private lastError: string | null = null;
  private flight: Promise<void> | null = null;
  private nextAttemptAt = 0;
  private failures = 0;
  private epoch = 0;
  private abort: AbortController | null = null;
  private closeSignal: AbortSignal | null = null;
  private closing: Promise<void> | null = null;

  constructor(config: TraceConfig) {
    this.target = destination(config);

    if (!this.target) this.lastError = "Invalid Langfuse configuration";
  }

  enqueue(observation: Observation): void {
    if (!this.target) {
      this.dropped++;

      return;
    }

    if (!validObservation(observation)) {
      this.dropped++;
      this.lastError = "Invalid observation";

      return;
    }

    const json = serialize(observation, this.target.environment);
    const bytes = Buffer.byteLength(json, "utf8");

    if (
      bytes > MAX_SPAN_BYTES ||
      this.queue.length >= MAX_PENDING ||
      this.queueBytes + bytes > MAX_QUEUE_BYTES
    ) {
      this.dropped++;
      this.lastError = "Export queue limit reached";

      return;
    }

    this.queue.push({ json, bytes });
    this.queueBytes += bytes;
  }

  flush(): Promise<void> {
    if (this.flight) return this.flight;

    if (!this.target || !this.queue.length || Date.now() < this.nextAttemptAt)
      return Promise.resolve();
    this.flight = this.drain(this.target).finally(() => {
      this.flight = null;
    });

    return this.flight;
  }

  /** Drain a shutdown tail after an existing flush, within one five-second deadline. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const deadline = AbortSignal.timeout(5000);
    this.closeSignal = deadline;

    const abortFlight = () => {
      this.abort?.abort();
    };

    deadline.addEventListener("abort", abortFlight, { once: true });
    this.closing = (async () => {
      // A periodic flush snapshots the queue. It may not include the final root.
      if (this.flight) await this.flight;

      if (!deadline.aborted) await this.flush();
    })().finally(() => {
      deadline.removeEventListener("abort", abortFlight);
    });

    return this.closing;
  }

  /** Privacy boundary: abort the current request and discard all retained spans. */
  clear(): void {
    this.epoch++;
    this.abort?.abort();
    this.dropped += this.queue.length;
    this.queue.length = 0;
    this.queueBytes = 0;
    this.failures = 0;
    this.nextAttemptAt = 0;
  }

  status(): ExportStatus {
    return {
      pending: this.queue.length,
      dropped: this.dropped,
      lastError: this.lastError,
      sent: this.sent,
    };
  }

  private defer(message: string, retryAfter: string | null = null): void {
    this.lastError = message;
    this.failures = Math.min(this.failures + 1, 7);
    const backoff = Math.min(60_000, 1000 * 2 ** (this.failures - 1)) * (1 + Math.random() * 0.2);
    this.nextAttemptAt = Date.now() + Math.max(backoff, retryDelay(retryAfter));
  }

  private remove(count: number): void {
    for (const span of this.queue.splice(0, count)) this.queueBytes -= span.bytes;
  }

  private batch(limit: number): QueuedSpan[] {
    const batch: QueuedSpan[] = [];
    let bytes = PREFIX.length + SUFFIX.length;

    for (const span of this.queue) {
      if (
        batch.length >= Math.min(limit, MAX_BATCH_SIZE) ||
        bytes + span.bytes + 1 > MAX_BATCH_BYTES
      )
        break;
      batch.push(span);
      bytes += span.bytes + 1;
    }

    return batch;
  }

  private async drain(target: Destination): Promise<void> {
    let remaining = this.queue.length;
    const epoch = this.epoch;
    this.abort = new AbortController();

    const signal = AbortSignal.any([
      this.abort.signal,
      this.closeSignal ?? AbortSignal.timeout(5000),
    ]);

    while (remaining > 0) {
      const batch = this.batch(remaining);

      try {
        const response = await fetch(target.endpoint, {
          method: "POST",
          headers: {
            Authorization: target.authorization,
            "Content-Type": "application/json",
            Accept: "application/json",
            "x-langfuse-ingestion-version": "4",
          },
          body: PREFIX + batch.map((span) => span.json).join(",") + SUFFIX,
          redirect: "error",
          signal,
        });

        if (epoch !== this.epoch) {
          void response.body?.cancel().catch(() => undefined);

          return;
        }

        if (response.status !== 200) {
          void response.body?.cancel().catch(() => undefined);

          if ([429, 502, 503, 504].includes(response.status)) {
            this.defer(`HTTP ${response.status}`, response.headers.get("Retry-After"));
          } else {
            this.lastError = `HTTP ${response.status}`;
            this.dropped += batch.length;
            this.remove(batch.length);
          }

          return;
        }

        const text = await responseText(response);

        if (epoch !== this.epoch) return;
        const value: unknown = JSON.parse(text);

        if (!isAcknowledgement(value)) throw new Error("Invalid acknowledgement");
        const rawRejected = value.partialSuccess?.rejectedSpans ?? 0;
        const rejected = Number(rawRejected);

        if (
          !/^(0|[1-9]\d*)$/.test(String(rawRejected)) ||
          !Number.isSafeInteger(rejected) ||
          rejected > batch.length
        ) {
          throw new Error("Invalid acknowledgement");
        }

        this.sent += batch.length - rejected;
        this.dropped += rejected;
        this.remove(batch.length);
        remaining -= batch.length;
        this.failures = 0;
        this.nextAttemptAt = 0;

        if (rejected || value.partialSuccess?.errorMessage) {
          this.lastError = "OTLP partial success";

          return;
        }

        this.lastError = null;
      } catch {
        if (epoch !== this.epoch) return;
        this.defer("Export failed or invalid acknowledgement");

        return;
      }
    }
  }
}
