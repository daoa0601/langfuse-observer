import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { loadConfig } from "../src/config.ts";
import { createLangfuseObserver, ObserverError } from "../src/langfuse.ts";
import type { ApiVersionChoice, FullObservation } from "../src/observer-types.ts";
import { createRequestHandler } from "../src/server.ts";
import { describeTrace } from "../src/trace-model.ts";

const NOW = new Date("2026-09-10T12:00:00.000Z");

const PUBLIC_KEY = "pk-test-public";

const SECRET_KEY = "sk-test-secret";

const AUTHORIZATION = `Basic ${Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString("base64")}`;

test("the recent page calls Langfuse and renders a healthy empty state", async (t) => {
  const requests: RequestSnapshot[] = [];

  const app = await startTestApp(t, (request, response) => {
    requests.push(requestSnapshot(request));
    sendJson(response, 200, { data: [], meta: {} });
  });

  const response = await fetch(`${app.origin}/?window=6h`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /No traces in the last 6 hours/);
  assert.match(body, /Langfuse connected/);
  assert.match(body, /href="\/sessions\?window=6h"/);
  assert.doesNotMatch(body, new RegExp(PUBLIC_KEY));
  assert.doesNotMatch(body, new RegExp(SECRET_KEY));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-security-policy") ?? "", /script-src 'none'/);

  assert.equal(requests.length, 1);
  const request = itemAt(requests, 0);
  assert.equal(request.authorization, AUTHORIZATION);
  assert.equal(request.url.pathname, "/api/public/v2/observations");
  assert.equal(request.url.searchParams.get("fields"), "core,basic,trace_context");
  assert.equal(request.url.searchParams.get("isRootObservation"), "true");
  assert.equal(request.url.searchParams.get("fromStartTime"), "2026-09-10T06:00:00.000Z");
  assert.equal(request.url.searchParams.get("toStartTime"), NOW.toISOString());
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
  const requests: RequestSnapshot[] = [];

  const app = await startTestApp(t, (request, response) => {
    const snapshot = requestSnapshot(request);
    requests.push(snapshot);

    if (snapshot.url.searchParams.get("cursor") === "next-page") {
      sendJson(response, 200, {
        data: [
          fullObservation({
            id: "child",
            parentObservationId: "root",
            name: "tool output",
            startTime: "2026-09-10T11:59:01.000Z",
            endTime: "2026-09-10T11:59:01.250Z",
            output: "<img src=x onerror=alert(1)>",
          }),
        ],
        meta: {},
      });

      return;
    }

    sendJson(response, 200, {
      data: [
        fullObservation({
          id: "root",
          name: "agent run",
          isRootObservation: true,
          traceName: "Checkout agent",
          startTime: "2026-09-10T11:59:00.000Z",
          endTime: "2026-09-10T11:59:02.000Z",
          input: '{"prompt":"buy milk"}',
          output: JSON.stringify("line one\nline two"),
          usageDetails: { input: 10, output: 5, total: 15 },
          costDetails: { total: 0.00025 },
          totalCost: 0.00025,
        }),
      ],
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
  assert.match(body, /This detail is limited to observations started between/);
  assert.match(
    body,
    new RegExp(`datetime="${new Date(NOW.getTime() - 90 * 24 * 60 * 60 * 1_000).toISOString()}"`),
  );
  assert.match(body, /Totals and parent relationships may be partial/);
  assert.match(body, /<dl class="detail-grid">/);
  assert.doesNotMatch(body, /<section class="detail-grid">/);
  assert.match(body, /class="observation depth-1/);
  assert.equal(requests.length, 2);
  assert.equal(itemAt(requests, 1).url.searchParams.get("cursor"), "next-page");

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

test("trace detail lists agent prompts and tools and marks each model turn", async (t) => {
  const app = await startTestApp(t, (_request, response) => {
    sendJson(response, 200, {
      data: [
        fullObservation({
          id: "generation-1",
          type: "GENERATION",
          name: "plan purchase",
          model: "gpt-test",
          input: {
            messages: [
              { role: "system", content: "Keep purchases under <50> euros." },
              { role: "user", content: "Buy milk." },
            ],
            tools: [
              {
                type: "function",
                function: {
                  name: "search_catalog",
                  description: "Find products",
                  parameters: { type: "object", properties: { query: { type: "string" } } },
                },
              },
            ],
          },
          output: {
            role: "assistant",
            content: "I will search <script>alert(1)</script>",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "search_catalog", arguments: '{"query":"milk"}' },
              },
            ],
          },
        }),
        fullObservation({
          id: "generation-2",
          type: "GENERATION",
          name: "answer user",
          model: "gpt-test",
          startTime: "2026-09-10T11:59:03.000Z",
          input: "The catalog returned milk.",
          output: "Milk is available.",
        }),
      ],
      meta: {},
    });
  });

  const response = await fetch(`${app.origin}/traces/trace-1`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /id="agent-context-heading">Agent context/);
  assert.match(body, /System prompt/);
  assert.match(body, /Keep purchases under &lt;50&gt; euros/);
  assert.match(body, /Tools \(1\)/);
  assert.match(body, /search_catalog/);
  assert.match(body, /Reply and tool calls/);
  assert.match(body, /Tool call/);
  assert.match(body, /Turn 1/);
  assert.match(body, /Turn 2/);
  assert.match(body, /id="observation-1"/);
  assert.match(body, /id="observation-2"/);
  assert.match(body, /href="#observation-1"/);
  assert.match(body, /href="#observation-2"/);
  assert.match(body, /I will search &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(body, /<script>alert\(1\)<\/script>/);
  assert.match(response.headers.get("content-security-policy") ?? "", /script-src 'none'/);
});

test("trace detail shows parsing notes when no agent shape is recognized", async (t) => {
  const app = await startTestApp(t, (_request, response) => {
    sendJson(response, 200, {
      data: [
        fullObservation({
          type: "TOOL",
          input: { metadata: { messages: [{ role: "system", content: "Not a prompt" }] } },
        }),
      ],
      meta: {},
    });
  });

  const response = await fetch(`${app.origin}/traces/trace-1`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /id="agent-context-heading">Agent context/);
  assert.match(body, /JSON shape was not recognized/);
});

test("trace detail distinguishes zero usage and cost from missing metrics", async (t) => {
  const app = await startTestApp(t, (_request, response) => {
    sendJson(response, 200, {
      data: [
        fullObservation({
          usageDetails: { total: 0 },
          totalCost: 0,
        }),
      ],
      meta: {},
    });
  });

  const response = await fetch(`${app.origin}/traces/trace-1`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /<dt>Tokens<\/dt><dd>0<\/dd>/);
  assert.match(body, /<dt>Cost<\/dt><dd>\$0\.00<\/dd>/);
});

test("trace trees support the full observation budget without overflowing the stack", () => {
  const observations = Array.from({ length: 10_000 }, (_, index) =>
    parsedObservation({
      id: `observation-${index}`,
      traceId: "deep-trace",
      parentId: index === 0 ? null : `observation-${index - 1}`,
      name: `Step ${index}`,
      startTime: new Date(NOW.getTime() + index).toISOString(),
      endTime: new Date(NOW.getTime() + index + 1).toISOString(),
      isLogicalRoot: index === 0,
      traceName: "Deep trace",
    }),
  );

  const trace = describeTrace("deep-trace", observations);

  if (trace === null) {
    throw new Error("Expected a described trace");
  }

  assert.equal(trace.rows.length, 10_000);
  assert.equal(itemAt(trace.rows, trace.rows.length - 1).depth, 9_999);
});

test("the lookup form redirects to a validated trace page", async (t) => {
  const app = await startTestApp(t, (_request, response) => {
    sendJson(response, 200, { data: [], meta: {} });
  });

  const response = await fetch(`${app.origin}/lookup?traceId=trace%2Fwith%20space&window=7d`, {
    redirect: "manual",
  });

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/traces/trace%2Fwith%20space?window=7d");
});

test("detail pages reject an invalid navigation window", async (t) => {
  let requests = 0;

  const app = await startTestApp(t, (_request, response) => {
    requests += 1;
    sendJson(response, 200, { data: [], meta: {} });
  });

  const response = await fetch(`${app.origin}/traces/trace-1?window=forever`);
  const body = await response.text();

  assert.equal(response.status, 400);
  assert.match(body, /Invalid recent window/);
  assert.equal(requests, 0);
});

test("trace pages ignore an unverified session backlink", async (t) => {
  const app = await startTestApp(t, (_request, response) => {
    sendJson(response, 200, {
      data: [fullObservation({ sessionId: "actual-session" })],
      meta: {},
    });
  });

  const response = await fetch(`${app.origin}/traces/trace-1?window=24h&session=unrelated-session`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /href="\/\?window=24h">Recent traces<\/a>/);
  assert.doesNotMatch(body, /\/sessions\/unrelated-session/);
});

test("the sessions page exhausts cursors and groups observations by session and trace", async (t) => {
  const requests: RequestSnapshot[] = [];

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
      data: [
        lightObservation({
          id: "trace-1-root",
          traceId: "trace-1",
          sessionId: "session-a",
          traceName: "First turn",
        }),
      ],
      meta: { cursor: "session-page-2" },
    });
  });

  const response = await fetch(`${app.origin}/sessions?window=7d`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /session-a/);
  assert.match(body, /2 traces/);
  assert.match(body, /2 observations/);
  assert.match(body, /href="\/\?window=7d"/);
  assert.equal(requests.length, 2);
  assert.equal(itemAt(requests, 0).url.searchParams.get("isRootObservation"), null);
  assert.equal(itemAt(requests, 0).url.searchParams.get("fields"), "core,basic,trace_context");
  assert.equal(itemAt(requests, 1).url.searchParams.get("cursor"), "session-page-2");
});

test("session detail uses the current v2 filter and links every discovered trace", async (t) => {
  const requests: RequestSnapshot[] = [];

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
  assert.match(body, /This detail is limited to observations started between/);
  assert.equal((body.match(/1 observation<\/span>/g) ?? []).length, 2);
  assert.doesNotMatch(body, /1 observations/);
  assert.match(body, /href="\/traces\/trace-1\?window=30d&amp;session=session%2Fwith%20space"/);
  assert.match(body, /href="\/traces\/trace-2\?window=30d&amp;session=session%2Fwith%20space"/);
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(itemAt(requests, 0).url.searchParams.get("filter") ?? ""), [
    { type: "string", column: "sessionId", operator: "=", value: "session/with space" },
  ]);
  assert.equal(itemAt(requests, 0).url.pathname, "/api/public/v2/observations");
  assert.equal(itemAt(requests, 0).url.searchParams.get("isRootObservation"), null);
  assert.equal(itemAt(requests, 0).url.searchParams.get("toStartTime"), NOW.toISOString());
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
    const data = Array.from({ length: 51 }, (_, index) =>
      lightObservation({
        id: `root-${index}`,
        traceId: `trace-${index}`,
        traceName: `Visible trace ${index}`,
      }),
    );

    sendJson(response, 200, { data, meta: {} });
  });

  const response = await fetch(`${app.origin}/?window=24h`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /51 shown/);
  assert.match(body, /Visible trace 50/);
});

test("auto mode falls back to the self-hosted v3 API and remembers it", async (t) => {
  const requests: RequestSnapshot[] = [];

  const app = await startTestApp(t, (request, response) => {
    const snapshot = requestSnapshot(request);
    requests.push(snapshot);

    if (snapshot.url.pathname === "/api/public/v2/observations") {
      sendJson(response, 404, { message: "not found" });

      return;
    }

    if (snapshot.url.pathname === "/api/public/traces") {
      sendJson(
        response,
        200,
        legacyPage([legacyTrace({ id: "legacy-trace", name: "GLM agent run" })]),
      );

      return;
    }

    if (snapshot.url.pathname === "/api/public/sessions") {
      sendJson(response, 200, legacyPage([legacySession({ id: "legacy-session" })]));

      return;
    }

    sendJson(response, 500, { message: "unexpected route" });
  });

  const traceResponse = await fetch(`${app.origin}/?window=6h`);
  const traceBody = await traceResponse.text();
  const sessionResponse = await fetch(`${app.origin}/sessions?window=6h`);
  const sessionBody = await sessionResponse.text();

  assert.equal(traceResponse.status, 200);
  assert.match(traceBody, /GLM agent run/);
  assert.match(traceBody, /Self-hosted v3 API/);
  assert.match(traceBody, /Legacy trace record/);
  assert.equal(sessionResponse.status, 200);
  assert.match(sessionBody, /legacy-session/);
  assert.match(sessionBody, /Open to view traces/);

  assert.deepEqual(
    requests.map((request) => request.url.pathname),
    ["/api/public/v2/observations", "/api/public/traces", "/api/public/sessions"],
  );
  const legacyRequest = itemAt(requests, 1);
  assert.equal(legacyRequest.url.searchParams.get("fields"), "core");
  assert.equal(legacyRequest.url.searchParams.get("page"), "1");
  assert.equal(legacyRequest.url.searchParams.get("limit"), "100");
  assert.equal(legacyRequest.url.searchParams.get("fromTimestamp"), "2026-09-10T06:00:00.000Z");
  assert.equal(legacyRequest.url.searchParams.get("toTimestamp"), NOW.toISOString());

  for (const request of requests) {
    assert.equal(request.authorization, AUTHORIZATION);
  }
});

test("auto mode does not select v3 until the fallback request succeeds", async (t) => {
  const paths: string[] = [];
  let v4Attempts = 0;

  const app = await startTestApp(t, (request, response) => {
    const url = new URL(request.url ?? "/", "http://langfuse.test");
    paths.push(url.pathname);

    if (url.pathname === "/api/public/v2/observations") {
      v4Attempts += 1;
      sendJson(
        response,
        v4Attempts === 1 ? 404 : 200,
        v4Attempts === 1 ? { message: "not found" } : { data: [], meta: {} },
      );

      return;
    }

    sendJson(response, 500, { message: "temporary v3 failure" });
  });

  const firstResponse = await fetch(`${app.origin}/`);
  const secondResponse = await fetch(`${app.origin}/`);

  assert.equal(firstResponse.status, 502);
  assert.equal(secondResponse.status, 200);
  assert.deepEqual(paths, [
    "/api/public/v2/observations",
    "/api/public/traces",
    "/api/public/v2/observations",
  ]);
});

test("concurrent first requests keep their operations independent", async () => {
  const requests: string[] = [];

  let finishFirstRequest: (response: Response) => void = () => {
    throw new Error("The first request did not start");
  };

  const firstResponse = new Promise<Response>((resolve) => {
    finishFirstRequest = resolve;
  });

  const response = (): Response => Response.json({ data: [], meta: {} });

  const observer = createLangfuseObserver(
    {
      baseUrl: new URL("http://langfuse.test"),
      apiVersion: "auto",
      publicKey: PUBLIC_KEY,
      secretKey: SECRET_KEY,
    },
    {
      fetchImpl: async (url) => {
        requests.push(url.pathname);

        return requests.length === 1 ? firstResponse : response();
      },
    },
  );

  const traces = observer.listRecentTraces("24h");
  const sessions = observer.listRecentSessions("24h");
  await Promise.resolve();

  assert.equal(requests.length, 2);
  finishFirstRequest(response());
  await Promise.all([traces, sessions]);
  assert.deepEqual(requests, ["/api/public/v2/observations", "/api/public/v2/observations"]);
});

test("concurrent API selection keeps cancellation scoped to its caller", async () => {
  const firstController = new AbortController();
  let requests = 0;

  const observer = createLangfuseObserver(
    {
      baseUrl: new URL("http://langfuse.test"),
      apiVersion: "auto",
      publicKey: PUBLIC_KEY,
      secretKey: SECRET_KEY,
    },
    {
      fetchImpl: (_url, { signal }) => {
        requests += 1;

        if (requests > 1) {
          return Promise.resolve(Response.json({ data: [], meta: {} }));
        }

        return new Promise((_resolve, reject) => {
          if (!signal) {
            throw new Error("Expected an abort signal");
          }

          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    },
  );

  const first = observer.listRecentTraces("24h", { signal: firstController.signal });
  const second = observer.listRecentSessions("24h");
  await Promise.resolve();
  firstController.abort();

  const [firstResult, secondResult] = await Promise.allSettled([first, second]);

  assert.equal(firstResult.status, "rejected");
  assert.equal(
    firstResult.status === "rejected" && firstResult.reason instanceof ObserverError
      ? firstResult.reason.code
      : null,
    "CANCELLED",
  );
  assert.equal(secondResult.status, "fulfilled");
  assert.equal(requests, 2);
});

test("a later v4 page failure does not reclassify the deployment as v3", async (t) => {
  const paths: string[] = [];

  const app = await startTestApp(t, (request, response) => {
    const url = new URL(request.url ?? "/", "http://langfuse.test");
    paths.push(url.pathname);

    if (url.pathname === "/api/public/v2/observations" && !url.searchParams.has("cursor")) {
      sendJson(response, 200, {
        data: [lightObservation()],
        meta: { cursor: "next-page" },
      });

      return;
    }

    if (url.pathname === "/api/public/v2/observations") {
      sendJson(response, 404, { message: "cursor expired" });

      return;
    }

    sendJson(response, 200, legacyPage([]));
  });

  const response = await fetch(`${app.origin}/`);
  const body = await response.text();

  assert.equal(response.status, 502);
  assert.match(body, /HTTP 404/);
  assert.deepEqual(paths, ["/api/public/v2/observations", "/api/public/v2/observations"]);
});

test("v4 pagination rejects malformed cursor metadata", async (t) => {
  const app = await startTestApp(t, (_request, response) => {
    sendJson(response, 200, { data: [], meta: { cursor: 42 } });
  });

  const response = await fetch(`${app.origin}/`);
  const body = await response.text();

  assert.equal(response.status, 502);
  assert.match(body, /invalid page cursor/);
});

test("v4 rejects a malformed semantic observation field", async (t) => {
  const app = await startTestApp(t, (_request, response) => {
    sendJson(response, 200, {
      data: [fullObservation({ parentObservationId: 42 })],
      meta: {},
    });
  });

  const response = await fetch(`${app.origin}/traces/trace-1`);
  const body = await response.text();

  assert.equal(response.status, 502);
  assert.match(body, /invalid observation parentObservationId/);
});

test("v4 preserves arbitrary JSON metadata and model parameters", async (t) => {
  const app = await startTestApp(t, (_request, response) => {
    sendJson(response, 200, {
      data: [
        fullObservation({
          metadata: "captured",
          modelParameters: ["temperature", 0.2],
        }),
      ],
      meta: {},
    });
  });

  const response = await fetch(`${app.origin}/traces/trace-1`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /captured/);
  assert.match(body, /temperature/);
});

test("v4 pagination stops empty cursor chains at the page budget", async (t) => {
  let requests = 0;

  const app = await startTestApp(t, (_request, response) => {
    requests += 1;
    sendJson(response, 200, {
      data: [],
      meta: requests <= 20 ? { cursor: `page-${requests}` } : {},
    });
  });

  const response = await fetch(`${app.origin}/`);
  const body = await response.text();

  assert.equal(response.status, 413);
  assert.match(body, /more than 20 result pages/);
  assert.equal(requests, 20);
});

test("v3 pagination rejects page totals beyond the row budget", async (t) => {
  let requests = 0;

  const app = await startTestApp(
    t,
    (_request, response) => {
      requests += 1;
      sendJson(
        response,
        200,
        legacyPage([], {
          totalItems: 1,
          totalPages: 201,
        }),
      );
    },
    { apiVersion: "v3" },
  );

  const response = await fetch(`${app.origin}/`);
  const body = await response.text();

  assert.equal(response.status, 413);
  assert.match(body, /more than 200 result pages/);
  assert.equal(requests, 1);
});

test("the viewer applies one deadline to the complete upstream operation", async (t) => {
  const app = await startTestApp(
    t,
    (request, response) => {
      const timer = setTimeout(() => {
        sendJson(response, 200, { data: [], meta: {} });
      }, 100);

      request.once("close", () => clearTimeout(timer));
    },
    { requestTimeoutMs: 10 },
  );

  const response = await fetch(`${app.origin}/`);
  const body = await response.text();

  assert.equal(response.status, 504);
  assert.match(body, /Langfuse timed out/);
});

test("observer calls stop when their caller cancels", async () => {
  const controller = new AbortController();

  const observer = createLangfuseObserver(
    {
      baseUrl: new URL("http://langfuse.test"),
      apiVersion: "v4",
      publicKey: PUBLIC_KEY,
      secretKey: SECRET_KEY,
    },
    {
      fetchImpl: (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          if (!signal) {
            throw new Error("Expected an abort signal");
          }

          const fallback = setTimeout(() => reject(new Error("request kept running")), 50);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(fallback);
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    },
  );

  const pending = observer.listRecentTraces("24h", { signal: controller.signal });
  controller.abort();

  await assert.rejects(
    pending,
    (error) => error instanceof ObserverError && error.code === "CANCELLED",
  );
});

test("a timeout while reading JSON remains a timeout", async () => {
  const observer = createLangfuseObserver(
    {
      baseUrl: new URL("http://langfuse.test"),
      apiVersion: "v4",
      publicKey: PUBLIC_KEY,
      secretKey: SECRET_KEY,
    },
    {
      fetchImpl: async () => {
        const body = new ReadableStream({
          start(controller) {
            controller.error(new DOMException("request timed out", "TimeoutError"));
          },
        });

        return new Response(body, { status: 200 });
      },
    },
  );

  await assert.rejects(
    observer.listRecentTraces("24h"),
    (error) => error instanceof ObserverError && error.code === "TIMEOUT",
  );
});

test("rate-limit pages use Langfuse Retry-After guidance", async (t) => {
  const app = await startTestApp(t, (_request, response) => {
    response.writeHead(429, {
      "Content-Type": "application/json",
      "Retry-After": "12",
    });
    response.end("{}");
  });

  const response = await fetch(`${app.origin}/`);
  const body = await response.text();

  assert.equal(response.status, 503);
  assert.match(body, /Try again in 12 seconds/);
});

test("the v3 sessions view follows pages and opens all session traces", async (t) => {
  const requests: RequestSnapshot[] = [];

  const app = await startTestApp(
    t,
    (request, response) => {
      const snapshot = requestSnapshot(request);
      requests.push(snapshot);

      if (snapshot.url.pathname === "/api/public/sessions/session%2Flegacy") {
        sendJson(response, 200, {
          ...legacySession({ id: "session/legacy" }),
          traces: [
            legacyTrace({
              id: "trace-1",
              name: "First turn",
              timestamp: "2026-09-10T11:55:00.000Z",
            }),
            legacyTrace({
              id: "trace-2",
              name: "Second turn",
              timestamp: "2026-09-10T11:57:00.000Z",
            }),
          ],
        });

        return;
      }

      const page = Number(snapshot.url.searchParams.get("page"));
      sendJson(
        response,
        200,
        legacyPage([legacySession({ id: page === 1 ? "session/legacy" : "older-session" })], {
          page,
          totalItems: 2,
          totalPages: 2,
        }),
      );
    },
    { apiVersion: "v3" },
  );

  const listResponse = await fetch(`${app.origin}/sessions?window=24h`);
  const listBody = await listResponse.text();
  const detailResponse = await fetch(`${app.origin}/sessions/session%2Flegacy?window=24h`);
  const detailBody = await detailResponse.text();

  assert.equal(listResponse.status, 200);
  assert.match(listBody, /session\/legacy/);
  assert.match(listBody, /older-session/);
  assert.equal(detailResponse.status, 200);
  assert.match(detailBody, /First turn/);
  assert.match(detailBody, /Second turn/);
  assert.match(detailBody, /2<\/dd>/);
  assert.match(detailBody, /Available per trace/);
  assert.match(detailBody, /Open for observations/);
  assert.match(detailBody, /href="\/traces\/trace-2\?window=24h&amp;session=session%2Flegacy"/);
  assert.deepEqual(
    requests.map((request) => request.url.searchParams.get("page")),
    ["1", "2", null],
  );
});

test("the v3 trace view renders trace fields and its complete observation tree", async (t) => {
  const requests: RequestSnapshot[] = [];

  const app = await startTestApp(
    t,
    (request, response) => {
      requests.push(requestSnapshot(request));
      sendJson(response, 200, {
        ...legacyTrace({
          id: "legacy-trace",
          name: "Legacy checkout agent",
          sessionId: "legacy-session",
          tags: ["agent", "glm"],
        }),
        input: { prompt: "buy milk" },
        output: { answer: "done" },
        metadata: { provider: "GLM" },
        userId: "local-user",
        release: "agenttrace-1",
        version: "3.0",
        totalCost: 0.000321,
        latency: 2,
        observations: [
          fullObservation({
            id: "legacy-root",
            traceId: "legacy-trace",
            name: "agent run",
            isRootObservation: undefined,
            calculatedTotalCost: 0.0002,
          }),
          fullObservation({
            id: "legacy-tool",
            traceId: "legacy-trace",
            parentObservationId: "legacy-root",
            name: "tool output",
            startTime: "2026-09-10T11:59:01.000Z",
            calculatedTotalCost: 0.000121,
          }),
        ],
      });
    },
    { apiVersion: "v3" },
  );

  const response = await fetch(`${app.origin}/traces/legacy-trace?window=24h`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /Legacy checkout agent/);
  assert.match(body, /Trace input and output/);
  assert.match(body, /&quot;prompt&quot;: &quot;buy milk&quot;/);
  assert.match(body, /&quot;answer&quot;: &quot;done&quot;/);
  assert.match(body, /GLM/);
  assert.match(body, /agenttrace-1/);
  assert.match(body, /\$0\.000321/);
  assert.doesNotMatch(body, /This detail is limited to observations started between/);
  assert.ok(body.indexOf("agent run") < body.indexOf("tool output"));
  assert.match(body, /class="observation depth-1/);
  assert.equal(requests.length, 1);
  assert.equal(itemAt(requests, 0).url.pathname, "/api/public/traces/legacy-trace");
  assert.equal(itemAt(requests, 0).url.searchParams.get("fields"), "core,io,observations,metrics");
});

test("config accepts auto, v3, and v4 API selection", () => {
  const required = {
    LANGFUSE_PUBLIC_KEY: PUBLIC_KEY,
    LANGFUSE_SECRET_KEY: SECRET_KEY,
    LANGFUSE_BASE_URL: "http://langfuse.test",
  };

  assert.equal(loadConfig(required).apiVersion, "auto");
  assert.equal(loadConfig({ ...required, LANGFUSE_API_VERSION: "V3" }).apiVersion, "v3");
  assert.equal(loadConfig({ ...required, LANGFUSE_API_VERSION: "v4" }).apiVersion, "v4");
  assert.deepEqual(
    loadConfig({
      ...required,
      LANGFUSE_PUBLIC_KEY: `  ${PUBLIC_KEY} `,
      LANGFUSE_SECRET_KEY: ` ${SECRET_KEY}  `,
    }),
    {
      apiVersion: "auto",
      baseUrl: new URL(required.LANGFUSE_BASE_URL),
      publicKey: PUBLIC_KEY,
      secretKey: SECRET_KEY,
      host: "127.0.0.1",
      port: 3000,
    },
  );
  assert.throws(
    () => loadConfig({ ...required, LANGFUSE_API_VERSION: "v2" }),
    /must be auto, v3, or v4/,
  );
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

interface TestAppOptions {
  readonly apiVersion?: ApiVersionChoice;
  readonly requestTimeoutMs?: number;
}

interface ListeningServer {
  readonly server: Server;
  readonly origin: string;
}

interface RequestSnapshot {
  readonly authorization: string | undefined;
  readonly url: URL;
}

type JsonFixture =
  | null
  | boolean
  | number
  | string
  | undefined
  | readonly JsonFixture[]
  | { readonly [key: string]: JsonFixture };

type RawRecord = { readonly [key: string]: JsonFixture };

async function startTestApp(
  t: TestContext,
  upstreamHandler: RequestListener,
  { apiVersion, requestTimeoutMs }: TestAppOptions = {},
): Promise<ListeningServer> {
  const upstream = await listen(upstreamHandler);

  const observer = createLangfuseObserver(
    {
      baseUrl: new URL(upstream.origin),
      apiVersion: apiVersion ?? "auto",
      publicKey: PUBLIC_KEY,
      secretKey: SECRET_KEY,
    },
    {
      now: () => new Date(NOW),
    },
  );

  const handler =
    requestTimeoutMs === undefined
      ? createRequestHandler({ observer, logger: { error() {} } })
      : createRequestHandler({ observer, logger: { error() {} }, requestTimeoutMs });

  const app = await listen(handler);

  t.after(async () => {
    await close(app.server);
    await close(upstream.server);
  });

  return app;
}

async function listen(handler: RequestListener): Promise<ListeningServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();

  if (!isAddressInfo(address)) {
    throw new Error("The test server did not return a TCP address");
  }

  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
  };
}

function isAddressInfo(address: AddressInfo | string | null): address is AddressInfo {
  return address !== null && typeof address !== "string";
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function requestSnapshot(request: IncomingMessage): RequestSnapshot {
  return {
    authorization: request.headers.authorization,
    url: new URL(request.url ?? "/", "http://langfuse.test"),
  };
}

function sendJson(response: ServerResponse, status: number, body: JsonFixture): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function lightObservation(overrides: RawRecord = {}) {
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

function fullObservation(overrides: RawRecord = {}) {
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

function legacyPage(data: readonly JsonFixture[], overrides: RawRecord = {}) {
  return {
    data,
    meta: {
      page: 1,
      limit: 100,
      totalItems: data.length,
      totalPages: data.length > 0 ? 1 : 0,
      ...overrides,
    },
  };
}

function legacyTrace(overrides: RawRecord = {}) {
  return {
    id: "legacy-trace",
    timestamp: "2026-09-10T11:59:00.000Z",
    name: "Legacy trace",
    sessionId: "legacy-session",
    environment: "default",
    tags: [],
    ...overrides,
  };
}

function legacySession(overrides: RawRecord = {}) {
  return {
    id: "legacy-session",
    createdAt: "2026-09-10T11:50:00.000Z",
    environment: "default",
    ...overrides,
  };
}

function parsedObservation(overrides: Partial<FullObservation> = {}): FullObservation {
  return {
    id: "root",
    traceId: "trace-1",
    parentId: null,
    type: "SPAN",
    name: "agent",
    sessionId: null,
    level: "DEFAULT",
    startTime: "2026-09-10T11:59:00.000Z",
    endTime: "2026-09-10T11:59:02.000Z",
    isLogicalRoot: true,
    traceName: "Test trace",
    environment: "default",
    tags: [],
    userId: null,
    statusMessage: null,
    input: null,
    output: null,
    metadata: {},
    model: null,
    modelParameters: {},
    usage: {},
    cost: {},
    promptName: null,
    promptVersion: null,
    latency: null,
    timeToFirstToken: null,
    totalCost: null,
    ...overrides,
  };
}

function itemAt<Value>(values: readonly Value[], index: number): Value {
  const value = values[index];

  if (value === undefined) {
    throw new Error(`Expected item ${index}, received ${values.length} items`);
  }

  return value;
}
