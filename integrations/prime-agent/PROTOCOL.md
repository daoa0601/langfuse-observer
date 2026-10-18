# Prime Agent OTLP transport

Checked against public documentation and source on 2026-09-19. No project credentials were read. No requests were sent to a real Langfuse project.

## Wire protocol and evidence

- [Langfuse OpenTelemetry documentation](https://langfuse.com/integrations/native/opentelemetry): POST `/api/public/otel/v1/traces`, `Content-Type: application/json`, and `Authorization: Basic base64(publicKey:secretKey)`. OTLP/HTTP JSON is supported. The endpoint exists from self-hosted v3.22.0; keep v3 deployments current because older minors have mapping differences.
- [v3.225.8 HTTP route](https://github.com/langfuse/langfuse/blob/d143a06c25c6664db1f657b4c6bf515a00268c63/web/src/pages/api/public/otel/v1/traces/index.ts) separately confirms HTTP/JSON decoding, support for ingestion-version 4, and the queue-job acknowledgement on the v3 release line.
- [v4 custom-ingestion migration](https://langfuse.com/integrations/native/opentelemetry/migration-to-v4): send `x-langfuse-ingestion-version: 4` for real-time v4 ingestion. Send each completed observation once. Do not send an unfinished root and later attempt to update it. v4 observations are immutable.
- [OTLP specification](https://opentelemetry.io/docs/specs/otlp/): JSON uses lower-camel-case fields, hexadecimal trace/span IDs, decimal-string nanosecond timestamps, numeric enum values, and KeyValue attribute arrays. This exporter does not use base64 IDs or floating-point nanoseconds.
- [Langfuse attributes, pinned source](https://github.com/langfuse/langfuse/blob/ef0add7b2598200bd44573178d9d1cc5f7cc770b/packages/shared/src/server/otel/attributes.ts) and [ingestion processor](https://github.com/langfuse/langfuse/blob/ef0add7b2598200bd44573178d9d1cc5f7cc770b/packages/shared/src/server/otel/OtelIngestionProcessor.ts) confirm first-class mappings.
- [Root-observation predicate](https://github.com/langfuse/langfuse/blob/ef0add7b2598200bd44573178d9d1cc5f7cc770b/packages/shared/src/eventsTable.ts): `!parentObservationId || isAppRoot === true`. A real root with no parent is therefore visible to the observer's v4 `isRootObservation=true` query. No internal root override is needed.
- [HTTP route](https://github.com/langfuse/langfuse/blob/ef0add7b2598200bd44573178d9d1cc5f7cc770b/web/src/pages/api/public/otel/v1/traces/index.ts) and [request processor](https://github.com/langfuse/langfuse/blob/ef0add7b2598200bd44573178d9d1cc5f7cc770b/web/src/server/otel/processOtelIngestion.ts) confirm that successful Langfuse responses may contain queue-job fields rather than only an empty OTLP object. Unknown JSON response fields are ignored, as OTLP requires. Explicit top-level `error`, `message`, or `code` fields are not accepted as a success acknowledgement.
- [Environment rules](https://langfuse.com/docs/observability/features/environments): 1–40 lowercase letters, digits, hyphens or underscores; the name cannot start with `langfuse`.

## Observation contract

`traceId` must be 32 hexadecimal characters. `id` and optional `parentId` must be 16 hexadecimal characters. IDs must be nonzero. The exporter normalizes hexadecimal letters to lowercase and preserves IDs across retries. A span cannot parent itself. Times are nonnegative, integer Unix milliseconds, converted with `BigInt` to nanosecond strings. End time cannot precede start time.

Every span carries:

| First-class field     | OTLP attribute                                              |
| --------------------- | ----------------------------------------------------------- |
| Session               | `session.id`                                                |
| Trace name            | `langfuse.trace.name`                                       |
| Environment           | `langfuse.environment`                                      |
| Type                  | `langfuse.observation.type` (`agent`, `generation`, `tool`) |
| Level                 | `langfuse.observation.level` (`DEFAULT` or `ERROR`)         |
| Captured input/output | `langfuse.observation.input`, `langfuse.observation.output` |

Session, name and environment are repeated on children because v4 filters observations directly. Error spans also set OTLP status code 2. Successful spans set code 1; kind is INTERNAL (1).

Input/output must already be valid JSON strings. The transport does not capture data itself. A completed root has no `parentSpanId`; it carries its own observation input/output for v4 and also `langfuse.trace.input`/`langfuse.trace.output` for legacy v3 reads. The lifecycle must supply the useful overall input/output, enqueue a completed root, and flush it. Until that happens a v4 root-only recent list may not show the trace.

Only GENERATION spans carry `langfuse.observation.model.name`, `langfuse.observation.usage_details`, and `langfuse.observation.cost_details`. Agent/tool aggregate metrics are not copied, which avoids charging the same generation twice.

Usage contract: `input` includes `cacheRead` and `cacheWrite`; `total` equals `input + output`. Counts must be nonnegative safe integers. The wire JSON contains disjoint `input` (uncached), `input_cached_tokens`, `input_cache_creation_tokens`, and `output`, plus the explicit `total`. Caches must not exceed inclusive input. The lifecycle must normalize provider-specific cache accounting before enqueueing. Cost contains numeric USD `input`, `output`, `total`; the sum is checked with floating-point tolerance. Langfuse treats `total` as the supplied aggregate, not another bucket to add. No parallel `gen_ai.usage.*` counters are emitted.

## Bounds, retries and privacy

- Constructor is inert. No environment reads, file writes, background worker, or scheduled flush exists. The managed plugin calls `enqueue()` and `flush()`.
- Invalid configuration disables export and sets a generic status error. HTTPS is required except for `localhost`, IPv4 loopback, and `::1` HTTP. URL user info, query strings and fragments are rejected. A deployment path prefix is preserved; supply a base URL, not an OTLP endpoint URL.
- Queue: 256 spans and 4 MiB of serialized UTF-8 span bytes. Individual span: 256 KiB. Batch: 64 spans and 1 MiB including the envelope. New spans are dropped when full, preserving bounded retry data already queued. Invalid observations are dropped, never partially sent.
- Enqueue snapshots each observation. Later caller mutation cannot change a retry. Flush drains only its initial snapshot; concurrent flush calls join the same promise. `close()` joins any current flush, then drains the final shutdown tail within one shared five-second deadline. The whole flush has one five-second HTTP deadline, including response bodies. The acknowledgement body is capped at 16 KiB.
- Redirects are forbidden. Errors contain only fixed text or a numeric HTTP status. Response bodies, server error messages, URLs and credentials never enter status output.
- Retryable HTTP 429/502/503/504, network failures, timeouts and malformed acknowledgements retain the bounded batch. Later managed flush calls retry with the same span IDs. Backoff starts at one second, doubles to 60 seconds, and has up to 20% jitter. `Retry-After` seconds or HTTP-date is honored up to 24 hours. No retry timer is created.
- Only HTTP 200 with a valid object acknowledgement counts as success. Empty bodies, arrays, null, invalid partial-success counts, explicit errors and oversized replies are not silently accepted. Other HTTP statuses drop the attempted batch and report an error; this follows OTLP's non-retryable status rules rather than repeatedly sending bad or unauthorized data.
- A valid OTLP `partialSuccess` MUST NOT be retried. The batch is removed, accepted spans increment `sent`, rejected spans increment `dropped`, and a generic partial-success error is recorded. A zero-rejection warning also removes the batch but keeps a generic warning. The protocol supplies a count, not the rejected IDs, so selective replay is impossible.
- `clear()` aborts active work and discards all pending observations, counting them as dropped. An epoch guard prevents an old aborted request from changing new queue entries or scheduling a retry. Use it for both export-off and capture-off. No `stripBodies()` method is needed. Abort cannot retract bytes already accepted by a server.

## Limits of the guarantees

This is bounded in-memory, best-effort delivery, not a durable outbox. A process crash or explicit clear loses pending data. A lost acknowledgement can lead to replay; stable IDs preserve identity but do not guarantee server-side exactly-once handling. `sent` means acknowledged by the HTTP ingestion endpoint, not confirmed query visibility or completion of asynchronous ingestion. No live Langfuse smoke test was run.

Tests use loopback fake HTTP servers. They cover exact wire fields, cache/cost accounting, root shape, bounded batches/bytes, retries, partial success, malformed and oversized replies, redirects, deadlines, concurrent flushes, configuration rejection, and cancellation/privacy boundaries.
