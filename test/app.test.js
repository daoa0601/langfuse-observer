import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createLangfuseObserver } from "../src/langfuse.js";
import { createRequestHandler } from "../src/server.js";

const NOW = new Date("2026-09-10T12:00:00.000Z");
const PUBLIC_KEY = "pk-test-public";
const SECRET_KEY = "sk-test-secret";
const AUTHORIZATION = `Basic ${Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString("base64")}`;

test("the recent page calls Langfuse and renders a healthy empty state", async (t) => {
  const requests = [];
  const app = await startTestApp(t, (request, response) => {
    requests.push(requestSnapshot(request));
    sendJson(response, 200, { data: [], meta: {} });
  });

  const response = await fetch(`${app.origin}/?window=6h`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /No traces in the last 6 hours/);
  assert.match(body, /Langfuse connected/);
  assert.doesNotMatch(body, new RegExp(PUBLIC_KEY));
  assert.doesNotMatch(body, new RegExp(SECRET_KEY));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-security-policy"), /script-src 'none'/);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].authorization, AUTHORIZATION);
  assert.equal(requests[0].url.pathname, "/api/public/v2/observations");
  assert.equal(requests[0].url.searchParams.get("fields"), "core,basic,trace_context");
  assert.equal(requests[0].url.searchParams.get("isRootObservation"), "true");
  assert.equal(requests[0].url.searchParams.get("fromStartTime"), "2026-09-10T06:00:00.000Z");
  assert.equal(requests[0].url.searchParams.get("toStartTime"), NOW.toISOString());
});

test("the recent page groups roots and escapes Langfuse text", async (t) => {
  const app = await startTestApp(t, (_request, response) => {
    sendJson(response, 200, {
      data: [
        lightObservation({
          id: "root-2",
          traceId: "trace/with space",
          name: "second root",
          traceName: "<script>bad()</script>",
          startTime: "2026-09-10T11:59:00.000Z",
          tags: ["agent", "review"],
        }),
        lightObservation({
          id: "root-1",
          traceId: "trace/with space",
          name: "first root",
          startTime: "2026-09-10T11:58:00.000Z",
          tags: ["agent"],
        }),
      ],
      meta: {},
    });
  });

  const response = await fetch(`${app.origin}/?window=24h`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(body, /<script>bad\(\)<\/script>/);
  assert.match(body, /2 logical roots/);
  assert.match(body, /href="\/traces\/trace%2Fwith%20space\?window=24h"/);
  assert.equal((body.match(/class="trace-card"/g) ?? []).length, 1);
});

test("trace detail follows cursors and renders physical parent order", async (t) => {
  const requests = [];
  const app = await startTestApp(t, (request, response) => {
    const snapshot = requestSnapshot(request);
    requests.push(snapshot);

    if (snapshot.url.searchParams.get("cursor") === "next-page") {
      sendJson(response, 200, {
        data: [fullObservation({
          id: "child",
          parentObservationId: "root",
          name: "tool output",
          startTime: "2026-09-10T11:59:01.000Z",
          endTime: "2026-09-10T11:59:01.250Z",
          output: "<img src=x onerror=alert(1)>",
        })],
        meta: {},
      });
      return;
    }

    sendJson(response, 200, {
      data: [fullObservation({
        id: "root",
        name: "agent run",
        isRootObservation: true,
        traceName: "Checkout agent",
        startTime: "2026-09-10T11:59:00.000Z",
        endTime: "2026-09-10T11:59:02.000Z",
        input: "{\"prompt\":\"buy milk\"}",
        output: JSON.stringify("line one\nline two"),
        usageDetails: { input: 10, output: 5, total: 15 },
        costDetails: { total: 0.00025 },
        totalCost: 0.00025,
      })],
      meta: { cursor: "next-page" },
    });
  });

  const response = await fetch(`${app.origin}/traces/trace-1?window=6h`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /Checkout agent/);
  assert.ok(body.indexOf("agent run") < body.indexOf("tool output"));
  assert.match(body, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(body, /<img src=x/);
  assert.match(body, /&quot;prompt&quot;: &quot;buy milk&quot;/);
  assert.match(body, /line one\nline two/);
  assert.doesNotMatch(body, /&quot;line one/);
  assert.match(body, /15/);
  assert.match(body, /class="observation depth-1/);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url.searchParams.get("cursor"), "next-page");

  for (const request of requests) {
    assert.equal(request.authorization, AUTHORIZATION);
    assert.equal(request.url.searchParams.get("traceId"), "trace-1");
    assert.equal(request.url.searchParams.get("toStartTime"), NOW.toISOString());
    assert.equal(
      request.url.searchParams.get("fromStartTime"),
      new Date(NOW.getTime() - 90 * 24 * 60 * 60 * 1_000).toISOString(),
    );
  }
});

test("the lookup form redirects to a validated trace page", async (t) => {
  const app = await startTestApp(t, (_request, response) => {
    sendJson(response, 200, { data: [], meta: {} });
  });

  const response = await fetch(
    `${app.origin}/lookup?traceId=trace%2Fwith%20space&window=7d`,
    { redirect: "manual" },
  );

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/traces/trace%2Fwith%20space?window=7d");
});

test("the sessions page exhausts cursors and groups observations by session and trace", async (t) => {
  const requests = [];
  const app = await startTestApp(t, (request, response) => {
    const snapshot = requestSnapshot(request);
    requests.push(snapshot);
    if (snapshot.url.searchParams.get("cursor") === "session-page-2") {
      sendJson(response, 200, {
        data: [
          lightObservation({
            id: "trace-2-child",
            traceId: "trace-2",
            parentObservationId: "trace-2-root",
            isRootObservation: false,
            sessionId: "session-a",
            traceName: "Second turn",
          }),
          lightObservation({
            id: "ungrouped",
            traceId: "trace-3",
            sessionId: null,
          }),
        ],
        meta: {},
      });
      return;
    }

    sendJson(response, 200, {
      data: [lightObservation({
        id: "trace-1-root",
        traceId: "trace-1",
        sessionId: "session-a",
        traceName: "First turn",
      })],
      meta: { cursor: "session-page-2" },
    });
  });

  const response = await fetch(`${app.origin}/sessions?window=7d`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /session-a/);
  assert.match(body, /2 traces/);
  assert.match(body, /2 observations/);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url.searchParams.get("isRootObservation"), null);
  assert.equal(requests[0].url.searchParams.get("fields"), "core,basic,trace_context");
  assert.equal(requests[1].url.searchParams.get("cursor"), "session-page-2");
});

test("session detail uses the current v2 filter and links every discovered trace", async (t) => {
  const requests = [];
  const app = await startTestApp(t, (request, response) => {
    requests.push(requestSnapshot(request));
    sendJson(response, 200, {
      data: [
        lightObservation({
          id: "first-root",
          traceId: "trace-1",
          sessionId: "session/with space",
          traceName: "First turn",
          startTime: "2026-09-10T11:55:00.000Z",
        }),
        lightObservation({
          id: "second-root",
          traceId: "trace-2",
          sessionId: "session/with space",
          traceName: "Second turn",
          startTime: "2026-09-10T11:57:00.000Z",
        }),
      ],
      meta: {},
    });
  });

  const response = await fetch(`${app.origin}/sessions/session%2Fwith%20space?window=30d`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /First turn/);
  assert.match(body, /Second turn/);
  assert.match(body, /href="\/traces\/trace-1\?window=30d&amp;session=session%2Fwith%20space"/);
  assert.match(body, /href="\/traces\/trace-2\?window=30d&amp;session=session%2Fwith%20space"/);
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(requests[0].url.searchParams.get("filter")), [
    { type: "string", column: "sessionId", operator: "=", value: "session/with space" },
  ]);
  assert.equal(requests[0].url.pathname, "/api/public/v2/observations");
  assert.equal(requests[0].url.searchParams.get("isRootObservation"), null);
  assert.equal(requests[0].url.searchParams.get("toStartTime"), NOW.toISOString());
});

test("the session lookup form redirects to a validated session page", async (t) => {
  const app = await startTestApp(t, (_request, response) => {
    sendJson(response, 200, { data: [], meta: {} });
  });

  const response = await fetch(
    `${app.origin}/session-lookup?sessionId=session%2Fwith%20space&window=90d`,
    { redirect: "manual" },
  );

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/sessions/session%2Fwith%20space?window=90d");
});

test("a repeated Langfuse cursor fails instead of rendering a partial session list", async (t) => {
  const app = await startTestApp(t, (_request, response) => {
    sendJson(response, 200, {
      data: [lightObservation({ sessionId: "session-a" })],
      meta: { cursor: "repeated" },
    });
  });

  const response = await fetch(`${app.origin}/sessions?window=24h`);
  const body = await response.text();

  assert.equal(response.status, 502);
  assert.match(body, /repeated page cursor/);
  assert.doesNotMatch(body, /session-card/);
});

test("the recent trace page does not silently stop at fifty traces", async (t) => {
  const app = await startTestApp(t, (_request, response) => {
    const data = Array.from({ length: 51 }, (_, index) => lightObservation({
      id: `root-${index}`,
      traceId: `trace-${index}`,
      traceName: `Visible trace ${index}`,
    }));
    sendJson(response, 200, { data, meta: {} });
  });

  const response = await fetch(`${app.origin}/?window=24h`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /51 shown/);
  assert.match(body, /Visible trace 50/);
});

test("upstream errors never return credentials or response bodies", async (t) => {
  const app = await startTestApp(t, (_request, response) => {
    sendJson(response, 401, { leaked: SECRET_KEY });
  });

  const response = await fetch(`${app.origin}/`);
  const body = await response.text();

  assert.equal(response.status, 502);
  assert.match(body, /Credentials rejected/);
  assert.match(body, /Check LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY/);
  assert.doesNotMatch(body, new RegExp(PUBLIC_KEY));
  assert.doesNotMatch(body, new RegExp(SECRET_KEY));
});

async function startTestApp(t, upstreamHandler) {
  const upstream = await listen(upstreamHandler);
  const observer = createLangfuseObserver({
    baseUrl: new URL(upstream.origin),
    publicKey: PUBLIC_KEY,
    secretKey: SECRET_KEY,
  }, {
    now: () => new Date(NOW),
  });
  const app = await listen(createRequestHandler({
    observer,
    logger: { error() {} },
  }));

  t.after(async () => {
    await close(app.server);
    await close(upstream.server);
  });
  return app;
}

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
  };
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

function requestSnapshot(request) {
  return {
    authorization: request.headers.authorization,
    url: new URL(request.url, "http://langfuse.test"),
  };
}

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function lightObservation(overrides = {}) {
  return {
    id: "root",
    traceId: "trace-1",
    parentObservationId: null,
    type: "SPAN",
    name: "agent",
    level: "DEFAULT",
    startTime: "2026-09-10T11:59:00.000Z",
    endTime: "2026-09-10T11:59:02.000Z",
    isRootObservation: true,
    sessionId: null,
    environment: "default",
    tags: [],
    ...overrides,
  };
}

function fullObservation(overrides = {}) {
  return {
    ...lightObservation(),
    input: null,
    output: null,
    metadata: {},
    modelParameters: {},
    usageDetails: {},
    costDetails: {},
    ...overrides,
  };
}
