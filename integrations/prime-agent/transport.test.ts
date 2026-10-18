import { afterEach, expect, spyOn, test } from "bun:test";
import { LangfuseExporter, type Observation, type TraceConfig } from "./transport.ts";

interface CapturedRequest {
  body: string;
  path: string;
  authorization: string | null;
  contentType: string | null;
  version: string | null;
}

const servers: Bun.Server<undefined>[] = [];

const clockMocks: ReturnType<typeof spyOn<typeof Date, "now">>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);

  for (const clock of clockMocks.splice(0)) clock.mockRestore();
});

function fakeServer(
  reply: (index: number) => Response | Promise<Response> = () => Response.json({}),
) {
  const requests: CapturedRequest[] = [];
  const received = Promise.withResolvers<void>();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({
        body: await request.text(),
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
        contentType: request.headers.get("content-type"),
        version: request.headers.get("x-langfuse-ingestion-version"),
      });
      received.resolve();

      return reply(requests.length);
    },
  });

  servers.push(server);

  const config: TraceConfig = {
    baseUrl: server.url.href,
    publicKey: "public-test-key",
    secretKey: "secret-test-key",
    environment: "test",
  };

  return { config, requests, received: received.promise };
}

function observation(index = 1): Observation {
  return {
    traceId: "abcdef0123456789abcdef0123456789",
    id: index.toString(16).padStart(16, "0"),
    sessionId: "session-test",
    traceName: "prime-agent session",
    name: "agent run",
    type: "AGENT",
    startTime: 1_700_000_000_123,
    endTime: 1_700_000_001_456,
  };
}

function advanceRetryClock(): void {
  clockMocks.push(spyOn(Date, "now").mockReturnValue(Date.now() + 86_400_001));
}

function firstRequest(requests: CapturedRequest[]): CapturedRequest {
  const first = requests[0];

  if (!first) throw new Error("Expected captured request");

  return first;
}

function attr(key: string, stringValue: string) {
  return { key, value: { stringValue } };
}

test("inert constructor and exact OTLP/HTTP JSON root serialization", async () => {
  const fake = fakeServer();
  const exporter = new LangfuseExporter(fake.config);
  const root = observation();
  root.input = JSON.stringify({ prompt: "hello 🌍" });
  root.output = JSON.stringify({ reply: "world" });
  exporter.enqueue(root);
  expect(fake.requests).toHaveLength(0);
  await exporter.flush();
  const request = firstRequest(fake.requests);
  const payload: unknown = JSON.parse(request.body);
  expect(request.path).toBe("/api/public/otel/v1/traces");
  expect(request.authorization).toBe(
    `Basic ${Buffer.from("public-test-key:secret-test-key").toString("base64")}`,
  );
  expect(request.contentType).toBe("application/json");
  expect(request.version).toBe("4");
  expect(payload).toEqual({
    resourceSpans: [
      {
        resource: { attributes: [attr("service.name", "prime-agent")] },
        scopeSpans: [
          {
            scope: { name: "prime-agent-langfuse", version: "1.0.0" },
            spans: [
              {
                traceId: root.traceId,
                spanId: root.id,
                name: root.name,
                kind: 1,
                startTimeUnixNano: "1700000000123000000",
                endTimeUnixNano: "1700000001456000000",
                attributes: [
                  attr("session.id", root.sessionId),
                  attr("langfuse.trace.name", root.traceName),
                  attr("langfuse.environment", "test"),
                  attr("langfuse.observation.type", "agent"),
                  attr("langfuse.observation.level", "DEFAULT"),
                  attr("langfuse.observation.input", root.input),
                  attr("langfuse.trace.input", root.input),
                  attr("langfuse.observation.output", root.output),
                  attr("langfuse.trace.output", root.output),
                ],
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  });
  expect(exporter.status()).toEqual({ pending: 0, dropped: 0, lastError: null, sent: 1 });
});

test("generation metrics are numeric, disjoint, and never copied to agent/tool spans", async () => {
  const fake = fakeServer();
  const exporter = new LangfuseExporter(fake.config);
  const generation = observation(2);
  generation.parentId = observation().id;
  generation.type = "GENERATION";
  generation.model = "test-model";
  generation.usage = { input: 100, output: 20, total: 120, cacheRead: 30, cacheWrite: 10 };
  generation.cost = { input: 0.1, output: 0.2, total: 0.3 };
  generation.error = true;
  exporter.enqueue(generation);
  exporter.enqueue({ ...generation, id: observation(3).id, type: "AGENT" });
  exporter.enqueue({ ...generation, id: observation(4).id, type: "TOOL" });
  await exporter.flush();
  const body = firstRequest(fake.requests).body;
  expect(body).toContain(
    JSON.stringify(
      attr(
        "langfuse.observation.usage_details",
        JSON.stringify({
          input: 60,
          output: 20,
          total: 120,
          input_cached_tokens: 30,
          input_cache_creation_tokens: 10,
        }),
      ),
    ),
  );
  expect(body).toContain(
    JSON.stringify(attr("langfuse.observation.cost_details", JSON.stringify(generation.cost))),
  );
  expect(body.match(/langfuse.observation.usage_details/g)).toHaveLength(1);
  expect(body.match(/langfuse.observation.model.name/g)).toHaveLength(1);
  expect(body.match(/session.id/g)).toHaveLength(3);
  expect(body).toContain('"parentSpanId":"0000000000000001"');
  expect(body).toContain('"status":{"code":2}');
  expect(body).not.toContain('"langfuse.trace.input"');
});

test("bounded count and batches retain old observations and drop newest", async () => {
  const fake = fakeServer();
  const exporter = new LangfuseExporter(fake.config);

  for (let index = 1; index <= 300; index++) exporter.enqueue(observation(index));
  expect(exporter.status().pending).toBe(256);
  expect(exporter.status().dropped).toBe(44);
  await exporter.flush();
  expect(fake.requests).toHaveLength(4);

  for (const request of fake.requests) expect(request.body.match(/"spanId"/g)).toHaveLength(64);
  expect(exporter.status().sent).toBe(256);
});

test("byte limits bound queue, individual spans, and each batch", async () => {
  const fake = fakeServer();
  const exporter = new LangfuseExporter(fake.config);
  // Escapes and multibyte characters are measured after OTLP serialization.
  const output = JSON.stringify("🌍".repeat(25_000));

  for (let index = 1; index <= 100; index++) exporter.enqueue({ ...observation(index), output });
  const pending = exporter.status().pending;
  expect(pending).toBeGreaterThan(0);
  expect(pending).toBeLessThan(25);
  expect(exporter.status().dropped).toBe(100 - pending);
  exporter.enqueue({ ...observation(101), input: JSON.stringify("x".repeat(256 * 1024)) });
  expect(exporter.status().dropped).toBe(101 - pending);
  await exporter.flush();

  for (const request of fake.requests)
    expect(Buffer.byteLength(request.body)).toBeLessThanOrEqual(1024 * 1024);
  expect(exporter.status().sent).toBe(pending);
});

test("concurrent flushes join, snapshots are immutable, later enqueues wait", async () => {
  const gate = Promise.withResolvers<Response>();
  const fake = fakeServer((index) => (index === 1 ? gate.promise : Response.json({})));
  const exporter = new LangfuseExporter(fake.config);
  const item = observation();
  exporter.enqueue(item);
  item.name = "mutated";
  const first = exporter.flush();
  expect(exporter.flush()).toBe(first);
  await fake.received;
  exporter.enqueue(observation(2));
  gate.resolve(Response.json({}));
  await first;
  expect(fake.requests).toHaveLength(1);
  expect(firstRequest(fake.requests).body).not.toContain("mutated");
  expect(exporter.status().pending).toBe(1);
  await exporter.flush();
  expect(exporter.status().sent).toBe(2);
});

test("429 retry-after retains stable IDs and bytes without a busy retry loop", async () => {
  const fake = fakeServer((index) =>
    index === 1
      ? new Response("SECRET RESPONSE", { status: 429, headers: { "Retry-After": "3600" } })
      : Response.json({}),
  );

  const exporter = new LangfuseExporter(fake.config);
  exporter.enqueue(observation());
  await exporter.flush();
  await exporter.flush();
  expect(fake.requests).toHaveLength(1);
  expect(exporter.status()).toEqual({ pending: 1, dropped: 0, sent: 0, lastError: "HTTP 429" });
  advanceRetryClock();
  await exporter.flush();
  expect(fake.requests).toHaveLength(2);
  expect(fake.requests[1]?.body).toBe(firstRequest(fake.requests).body);
  expect(exporter.status().sent).toBe(1);
});

test.each([502, 503, 504])("retryable HTTP %i retains the bounded batch", async (status) => {
  const fake = fakeServer(() => new Response("private", { status }));
  const exporter = new LangfuseExporter(fake.config);
  exporter.enqueue(observation());
  await exporter.flush();
  expect(exporter.status()).toEqual({
    pending: 1,
    dropped: 0,
    sent: 0,
    lastError: `HTTP ${status}`,
  });
});

test.each([201, 204, 400, 401, 403, 404, 500])(
  "non-OTLP-success HTTP %i never counts as sent",
  async (status) => {
    const fake = fakeServer(() => new Response(null, { status }));
    const exporter = new LangfuseExporter(fake.config);
    exporter.enqueue(observation());
    await exporter.flush();
    expect(exporter.status()).toEqual({
      pending: 0,
      dropped: 1,
      sent: 0,
      lastError: `HTTP ${status}`,
    });
  },
);

test("HTTP 200 partialSuccess counts rejections and MUST NOT retry the batch", async () => {
  const fake = fakeServer(() =>
    Response.json({ partialSuccess: { rejectedSpans: "1", errorMessage: "private body" } }),
  );

  const exporter = new LangfuseExporter(fake.config);
  exporter.enqueue(observation());
  exporter.enqueue(observation(2));
  await exporter.flush();
  advanceRetryClock();
  await exporter.flush();
  expect(fake.requests).toHaveLength(1);
  expect(exporter.status()).toEqual({
    pending: 0,
    dropped: 1,
    sent: 1,
    lastError: "OTLP partial success",
  });
});

test("partialSuccess warnings acknowledge all observations without leaking errorMessage", async () => {
  const fake = fakeServer(() =>
    Response.json({ partialSuccess: { rejectedSpans: 0, errorMessage: "private" } }),
  );

  const exporter = new LangfuseExporter(fake.config);
  exporter.enqueue(observation());
  await exporter.flush();
  expect(exporter.status()).toEqual({
    pending: 0,
    dropped: 0,
    sent: 1,
    lastError: "OTLP partial success",
  });
});

test.each([
  "",
  "not json",
  "null",
  "[]",
  '{"error":"private"}',
  '{"partialSuccess":null}',
  '{"partialSuccess":{"rejectedSpans":"-1"}}',
  '{"partialSuccess":{"rejectedSpans":"2"}}',
  '{"partialSuccess":{"rejectedSpans":0.5}}',
  '{"partialSuccess":{"errorMessage":1}}',
])("malformed acknowledgement is retained, not falsely accepted: %s", async (body) => {
  const fake = fakeServer(() => new Response(body));
  const exporter = new LangfuseExporter(fake.config);
  exporter.enqueue(observation());
  await exporter.flush();
  expect(exporter.status()).toEqual({
    pending: 1,
    dropped: 0,
    sent: 0,
    lastError: "Export failed or invalid acknowledgement",
  });
});

test("oversized acknowledgement is bounded", async () => {
  const fake = fakeServer(() => Response.json({ padding: "private".repeat(10_000) }));
  const exporter = new LangfuseExporter(fake.config);
  exporter.enqueue(observation());
  await exporter.flush();
  expect(exporter.status().pending).toBe(1);
  expect(exporter.status().sent).toBe(0);
});

test("Langfuse queue-job acknowledgement and OTLP empty partial object are accepted", async () => {
  const fake = fakeServer((index) =>
    Response.json(
      index === 1 ? { id: "job-id", name: "otel-ingestion", data: {} } : { partialSuccess: {} },
    ),
  );

  const exporter = new LangfuseExporter(fake.config);
  exporter.enqueue(observation());
  await exporter.flush();
  exporter.enqueue(observation(2));
  await exporter.flush();
  expect(exporter.status().sent).toBe(2);
});

test("redirects never forward Basic credentials", async () => {
  const destination = fakeServer();

  const origin = fakeServer(
    () => new Response(null, { status: 307, headers: { Location: destination.config.baseUrl } }),
  );

  const exporter = new LangfuseExporter(origin.config);
  exporter.enqueue(observation());
  await exporter.flush();
  expect(destination.requests).toHaveLength(0);
  expect(exporter.status().pending).toBe(1);
  expect(exporter.status().lastError).toBe("Export failed or invalid acknowledgement");
});

test("invalid config fails closed without constructor throws or requests", async () => {
  const fake = fakeServer();

  const configs: TraceConfig[] = [
    { ...fake.config, baseUrl: "http://example.com" },
    { ...fake.config, baseUrl: "http://localhost.evil.test" },
    { ...fake.config, baseUrl: "ftp://127.0.0.1" },
    { ...fake.config, baseUrl: "not a URL" },
    { ...fake.config, baseUrl: fake.config.baseUrl + "?secret=private" },
    { ...fake.config, baseUrl: "https://user:pass@example.com" },
    { ...fake.config, publicKey: "" },
    { ...fake.config, publicKey: "bad:key" },
    { ...fake.config, secretKey: "private\nkey" },
    { ...fake.config, environment: "langfuse-reserved" },
  ];

  for (const config of configs) {
    const exporter = new LangfuseExporter(config);
    exporter.enqueue(observation());
    await exporter.flush();
    expect(exporter.status()).toEqual({
      pending: 0,
      dropped: 1,
      sent: 0,
      lastError: "Invalid Langfuse configuration",
    });
  }

  expect(fake.requests).toHaveLength(0);
});

test("base URL deployment prefix is preserved", async () => {
  const fake = fakeServer();

  const exporter = new LangfuseExporter({
    ...fake.config,
    baseUrl: fake.config.baseUrl + "langfuse/",
  });

  exporter.enqueue(observation());
  await exporter.flush();
  expect(firstRequest(fake.requests).path).toBe("/langfuse/api/public/otel/v1/traces");
});

test("invalid IDs, timestamps, JSON and totals never reach the server", async () => {
  const fake = fakeServer();
  const exporter = new LangfuseExporter(fake.config);

  const invalid: Observation[] = [
    { ...observation(), id: "0000000000000000" },
    { ...observation(), traceId: "not-hex" },
    { ...observation(), parentId: observation().id },
    { ...observation(), endTime: 0 },
    { ...observation(), startTime: NaN },
    { ...observation(), endTime: 18_446_744_073_710 },
    { ...observation(), input: "not JSON" },
    { ...observation(), usage: { input: 10, output: 2, total: 50 } },
    { ...observation(), usage: { input: 10, output: 2, total: 12, cacheRead: 11 } },
    { ...observation(), cost: { input: -1, output: 2, total: 1 } },
  ];

  for (const item of invalid) exporter.enqueue(item);
  await exporter.flush();
  expect(exporter.status().dropped).toBe(invalid.length);
  expect(fake.requests).toHaveLength(0);
});

test("clear aborts in-flight work and cannot remove or retry newly queued data", async () => {
  const gate = Promise.withResolvers<Response>();
  const fake = fakeServer((index) => (index === 1 ? gate.promise : Response.json({})));
  const exporter = new LangfuseExporter(fake.config);
  exporter.enqueue({ ...observation(), input: JSON.stringify("private") });
  const oldFlush = exporter.flush();
  await fake.received;
  exporter.clear();
  exporter.enqueue(observation(2));
  await oldFlush;
  expect(exporter.status()).toEqual({ pending: 1, dropped: 1, sent: 0, lastError: null });
  gate.resolve(Response.json({}));
  await exporter.flush();
  expect(exporter.status()).toEqual({ pending: 0, dropped: 1, sent: 1, lastError: null });
  expect(fake.requests[1]?.body).not.toContain("private");
});

test("failed queue can be cleared before any later retry", async () => {
  const fake = fakeServer(() => new Response(null, { status: 503 }));
  const exporter = new LangfuseExporter(fake.config);
  exporter.enqueue(observation());
  await exporter.flush();
  exporter.clear();
  advanceRetryClock();
  await exporter.flush();
  expect(fake.requests).toHaveLength(1);
  expect(exporter.status().pending).toBe(0);
  expect(exporter.status().dropped).toBe(1);
});

test("timeout covers a stalled HTTP response body and never throws", async () => {
  const fake = fakeServer(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
          },
        }),
      ),
  );

  const exporter = new LangfuseExporter(fake.config);
  exporter.enqueue(observation());
  const start = performance.now();
  await exporter.flush();
  expect(performance.now() - start).toBeLessThan(6000);
  expect(exporter.status().pending).toBe(1);
  expect(exporter.status().sent).toBe(0);
}, 7000);

test("connection refusal retains observations and does not leak endpoint or credentials", async () => {
  const fake = fakeServer();
  const exporter = new LangfuseExporter(fake.config);

  for (const server of servers) server.stop(true);
  exporter.enqueue(observation());
  await exporter.flush();
  expect(exporter.status()).toEqual({
    pending: 1,
    dropped: 0,
    sent: 0,
    lastError: "Export failed or invalid acknowledgement",
  });
});

test("HTTP-date Retry-After prevents early retry", async () => {
  const now = Date.now();

  const fake = fakeServer(
    () =>
      new Response(null, {
        status: 503,
        headers: { "Retry-After": new Date(now + 3600_000).toUTCString() },
      }),
  );

  const exporter = new LangfuseExporter(fake.config);
  exporter.enqueue(observation());
  await exporter.flush();
  const clock = spyOn(Date, "now").mockReturnValue(now + 120_000);
  clockMocks.push(clock);
  await exporter.flush();
  expect(fake.requests).toHaveLength(1);
  clock.mockReturnValue(now + 3601_000);
  await exporter.flush();
  expect(fake.requests).toHaveLength(2);
});

test("close drains the final root queued during an existing periodic upload", async () => {
  const gate = Promise.withResolvers<Response>();
  const fake = fakeServer((index) => (index === 1 ? gate.promise : Response.json({})));
  const exporter = new LangfuseExporter(fake.config);
  exporter.enqueue(observation(1));
  const initial = exporter.flush();
  await fake.received;
  exporter.enqueue(observation(2));
  const closing = exporter.close();
  expect(exporter.close()).toBe(closing);
  gate.resolve(Response.json({}));
  await closing;
  await initial;
  expect(fake.requests).toHaveLength(2);
  expect(exporter.status()).toEqual({ pending: 0, dropped: 0, lastError: null, sent: 2 });
});

test("close deadline aborts an already-stalled flush instead of waiting twice", async () => {
  const gate = Promise.withResolvers<Response>();
  const fake = fakeServer(() => gate.promise);
  const exporter = new LangfuseExporter(fake.config);
  exporter.enqueue(observation(1));
  const initial = exporter.flush();
  await fake.received;
  exporter.enqueue(observation(2));
  const start = performance.now();
  await exporter.close();
  expect(performance.now() - start).toBeLessThan(6500);
  expect(fake.requests).toHaveLength(1);
  expect(exporter.status().pending).toBe(2);
  gate.resolve(Response.json({}));
  await initial;
}, 10000);
