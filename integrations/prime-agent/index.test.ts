import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { parseJson, isJsonObject, type JsonObject, type JsonValue } from "../../src/json.ts";
import { registerTracing } from "./index.ts";
import { readTracingEnabled } from "./config.ts";
import { assistantOutput, capture, toolOutput } from "./privacy.ts";
import type { PrimeContext, PrimeEvents, PrimeExtensionAPI } from "./prime-contract.ts";

type Handlers = {
  [K in keyof PrimeEvents]: (event: PrimeEvents[K], ctx: PrimeContext) => void | Promise<void>;
};

class Host implements PrimeExtensionAPI {
  handlers: Partial<Handlers> = {};
  command: ((args: string, ctx: PrimeContext) => Promise<void>) | undefined;
  timer: (() => void | Promise<void>) | undefined;
  notices: string[] = [];
  ctx: PrimeContext = {
    sessionManager: { getSessionId: () => "synthetic-session" },
    model: { id: "synthetic-model", provider: "test" },
    ui: {
      notify: (message) => {
        this.notices.push(message);
      },
    },
    setInterval: (callback) => {
      this.timer = callback;

      return 1;
    },
  };
  on<K extends keyof PrimeEvents>(event: K, handler: Handlers[K]): void {
    this.handlers[event] = handler;
  }
  registerCommand(
    _name: string,
    options: { description: string; handler: (args: string, ctx: PrimeContext) => Promise<void> },
  ): void {
    this.command = options.handler;
  }
  async emit<K extends keyof PrimeEvents>(name: K, event: PrimeEvents[K]): Promise<void> {
    await this.handlers[name]?.(event, this.ctx);
  }
}

async function fixture(captureBodies: boolean) {
  const directory = mkdtempSync(join(tmpdir(), "prime-tracing-"));
  const configPath = join(directory, "langfuse.json");
  writeFileSync(configPath, JSON.stringify({ enabled: true, captureBodies }));
  const requests: JsonObject[] = [];

  const server = createServer(async (request, response) => {
    let body = "";

    for await (const chunk of request) body += String(chunk);
    const parsed = parseJson(body);

    if (parsed.kind === "valid" && isJsonObject(parsed.value)) requests.push(parsed.value);
    response.setHeader("Content-Type", "application/json");
    response.end("{}");
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  // SAFETY: node:http listen on an IP/port returns AddressInfo, never a pipe path.
  const address = server.address() as AddressInfo;
  const host = new Host();

  const settings = {
    configPath,
    enabled: true,
    captureBodies,
    transport: {
      baseUrl: `http://127.0.0.1:${address.port}`,
      publicKey: "pk-test",
      secretKey: "sk-test-known-secret",
      environment: "test",
    },
  };

  registerTracing(host, settings);
  await host.emit("session_start", { reason: "startup" });

  return {
    host,
    settings,
    requests,
    close: () => {
      server.closeAllConnections();
      server.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

const assistant: JsonObject = {
  role: "assistant",
  model: "synthetic-model",
  stopReason: "toolUse",
  content: [
    { type: "text", text: "synthetic response" },
    { type: "toolCall", id: "call1", name: "ipython", arguments: { code: "print(1)" } },
  ],
  usage: {
    input: 10,
    output: 2,
    cacheRead: 3,
    cacheWrite: 0,
    cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
  },
};

async function startRequest(
  host: Host,
  prompt = "private synthetic prompt sk-test-known-secret",
): Promise<void> {
  await host.emit("before_agent_start", {
    prompt,
  });
  await host.emit("agent_start", { type: "agent_start" });
}

async function modelCall(host: Host): Promise<void> {
  await host.emit("context", {
    messages: [{ role: "user", content: "private synthetic prompt sk-test-known-secret" }],
  });
  await host.emit("message_start", { message: { role: "assistant", content: [] } });
  await host.emit("message_end", { message: assistant });
}

function exportedSpans(requests: readonly JsonObject[]): JsonObject[] {
  const spans: JsonObject[] = [];

  for (const request of requests) {
    const resources = request["resourceSpans"];

    if (!Array.isArray(resources)) throw new Error("Missing OTLP resource spans");

    for (const resource of resources) {
      const scopes = isJsonObject(resource) ? resource["scopeSpans"] : undefined;

      if (!Array.isArray(scopes)) throw new Error("Missing OTLP scope spans");

      for (const scope of scopes) {
        const observations = isJsonObject(scope) ? scope["spans"] : undefined;

        if (!Array.isArray(observations)) throw new Error("Missing OTLP observations");

        for (const observation of observations) {
          if (!isJsonObject(observation)) throw new Error("Invalid OTLP observation");
          spans.push(observation);
        }
      }
    }
  }

  return spans;
}

function spanAttribute(span: JsonObject | undefined, key: string): JsonValue | undefined {
  const attributes = span?.["attributes"];

  if (!Array.isArray(attributes)) return undefined;
  const attribute = attributes.find((item) => isJsonObject(item) && item["key"] === key);
  const value = isJsonObject(attribute) ? attribute["value"] : undefined;

  return isJsonObject(value) ? value["stringValue"] : undefined;
}

describe("Prime lifecycle export", () => {
  test("one request has an agent root with its prompt, final reply, model calls, and named tools", async () => {
    const f = await fixture(true);

    try {
      await startRequest(f.host, "Find the configuration sk-test-known-secret");
      await f.host.emit("context", {
        messages: [
          { role: "user", content: "Find the configuration" },
          assistant,
          {
            role: "toolResult",
            toolCallId: "call1",
            content: [{ type: "text", text: "configuration found" }],
          },
        ],
      });
      await f.host.emit("message_start", { message: { role: "assistant", content: [] } });

      const toolRequest: JsonObject = {
        ...assistant,
        content: [
          {
            type: "toolCall",
            id: "read-config",
            name: "read_file",
            arguments: { path: "config.json" },
          },
        ],
      };

      await f.host.emit("message_end", { message: toolRequest });
      await f.host.emit("tool_execution_start", {
        toolCallId: "read-config",
        toolName: "read_file",
        args: { path: "config.json" },
      });
      await f.host.emit("tool_execution_end", {
        toolCallId: "read-config",
        toolName: "read_file",
        result: { content: [{ type: "text", text: "tracing is disabled" }] },
        isError: false,
      });

      const reply: JsonObject = {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "The configuration is correct." }],
      };

      await f.host.emit("context", {
        messages: [{ role: "user", content: "Find the configuration" }],
      });
      await f.host.emit("message_start", { message: { role: "assistant", content: [] } });
      await f.host.emit("message_end", { message: reply });
      await f.host.emit("agent_end", { messages: [toolRequest, reply] });
      await f.host.command?.("flush", f.host.ctx);

      const spans = exportedSpans(f.requests);
      const root = spans.find((span) => span["parentSpanId"] === undefined);

      const generations = spans.filter(
        (span) => spanAttribute(span, "langfuse.observation.type") === "generation",
      );

      const tool = spans.find((span) => span["name"] === "read_file");
      expect(spans.filter((span) => span["parentSpanId"] === undefined)).toHaveLength(1);
      expect(spanAttribute(root, "langfuse.observation.type")).toBe("agent");
      expect(spanAttribute(root, "langfuse.observation.input")).toContain("Find the configuration");
      expect(spanAttribute(root, "langfuse.observation.output")).toContain(
        "The configuration is correct.",
      );
      expect(generations).toHaveLength(2);

      for (const generation of generations) {
        expect(generation["traceId"]).toBe(root?.["traceId"]);
        expect(generation["parentSpanId"]).toBe(root?.["spanId"]);
      }

      expect(tool?.["parentSpanId"]).toBe(generations[0]?.["spanId"]);
      expect(tool?.["traceId"]).toBe(root?.["traceId"]);
      const input = spanAttribute(generations[0], "langfuse.observation.input");
      expect(input).toContain("Find the configuration");
      expect(input).toContain("configuration found");
      expect(input).not.toContain("raw system instructions");
      expect(JSON.stringify(spans)).not.toContain("sk-test-known-secret");
    } finally {
      f.close();
    }
  });
  test("metadata default exports a real parent tree, totals, and no conversation bodies", async () => {
    const f = await fixture(false);

    try {
      await startRequest(f.host);
      await modelCall(f.host);
      await f.host.emit("tool_execution_start", {
        toolCallId: "call1",
        toolName: "ipython",
        args: { code: "secret code" },
      });
      await f.host.emit("tool_execution_end", {
        toolCallId: "call1",
        toolName: "ipython",
        result: { content: [{ type: "text", text: "secret result" }] },
        isError: false,
      });
      await f.host.emit("agent_end", { messages: [] });
      await f.host.command?.("flush", f.host.ctx);
      const wire = JSON.stringify(f.requests);
      expect(wire).toContain("synthetic-session");
      expect(wire).toContain("synthetic-model");
      expect(wire).not.toContain("private synthetic");
      expect(wire).not.toContain("secret code");
      expect(wire).not.toContain("secret result");
      expect(wire).toContain("parentSpanId");
      expect(wire).toContain("generation");
      expect(wire).toContain("tool");
      expect(wire).toContain("agent");
    } finally {
      f.close();
    }
  });
  test("body opt-in normalizes native replies and redacts known credentials", async () => {
    const f = await fixture(true);

    try {
      await startRequest(f.host);
      await modelCall(f.host);
      await f.host.emit("agent_end", { messages: [] });
      await f.host.command?.("flush", f.host.ctx);
      const wire = JSON.stringify(f.requests);
      expect(wire).toContain("private synthetic prompt");
      expect(wire).toContain("synthetic response");
      expect(wire).toContain("tool_calls");
      expect(wire).not.toContain("sk-test-known-secret");
      expect(wire).toContain("REDACTED");
    } finally {
      f.close();
    }
  });
  test("capture-off drops pending bodies and disables capture for the active run", async () => {
    const f = await fixture(true);

    try {
      await startRequest(f.host);
      await modelCall(f.host);
      await f.host.command?.("capture-off", f.host.ctx);
      await modelCall(f.host);
      await f.host.emit("agent_end", { messages: [] });
      await f.host.command?.("flush", f.host.ctx);
      expect(JSON.stringify(f.requests)).not.toContain("private synthetic");
    } finally {
      f.close();
    }
  });
  test("off drops pending exports and prevents new requests", async () => {
    const f = await fixture(true);

    try {
      await startRequest(f.host);
      await modelCall(f.host);
      await f.host.command?.("off", f.host.ctx);
      await f.host.emit("agent_end", { messages: [] });
      await f.host.command?.("flush", f.host.ctx);
      expect(f.requests).toHaveLength(0);
      await startRequest(f.host);
      await modelCall(f.host);
      await f.host.emit("agent_end", { messages: [] });
      await f.host.command?.("flush", f.host.ctx);
      expect(f.requests).toHaveLength(0);
    } finally {
      f.close();
    }
  });
  test("off stops another loaded session and remains off when an extension starts again", async () => {
    const f = await fixture(true);

    try {
      const child = new Host();
      registerTracing(child, f.settings);
      await child.emit("session_start", { reason: "startup" });
      await startRequest(child);
      await modelCall(child);

      await f.host.command?.("off", f.host.ctx);
      expect(readTracingEnabled(f.settings.configPath)).toBe(false);
      await child.timer?.();
      await child.emit("agent_end", { messages: [] });
      await child.emit("session_shutdown", { reason: "reload" });

      const restarted = new Host();
      registerTracing(restarted, f.settings);
      await startRequest(restarted);
      await modelCall(restarted);
      await restarted.emit("agent_end", { messages: [] });
      await restarted.command?.("flush", restarted.ctx);
      expect(f.requests).toHaveLength(0);

      await restarted.command?.("on", restarted.ctx);
      await startRequest(restarted);
      await modelCall(restarted);
      await restarted.emit("agent_end", { messages: [] });
      await restarted.command?.("flush", restarted.ctx);
      expect(f.requests).toHaveLength(1);
    } finally {
      f.close();
    }
  });
  test("editing or removing the saved setting stops queued exports", async () => {
    const f = await fixture(false);

    try {
      await startRequest(f.host);
      await modelCall(f.host);
      writeFileSync(f.settings.configPath, '{"enabled":false}');
      await f.host.timer?.();
      await f.host.emit("agent_end", { messages: [] });
      expect(f.requests).toHaveLength(0);

      await f.host.command?.("on", f.host.ctx);
      await startRequest(f.host);
      await modelCall(f.host);
      rmSync(f.settings.configPath);
      await f.host.emit("session_shutdown", { reason: "shutdown" });
      await f.host.command?.("flush", f.host.ctx);
      expect(f.requests).toHaveLength(0);
    } finally {
      f.close();
    }
  });
  test("shutdown finishes open model/tool work with an error", async () => {
    const f = await fixture(false);

    try {
      await startRequest(f.host);
      await f.host.emit("message_start", { message: { role: "assistant", content: [] } });
      await f.host.emit("session_shutdown", { reason: "reload" });
      expect(JSON.stringify(f.requests)).toContain("ERROR");
      await f.host.command?.("flush", f.host.ctx);
      expect(f.requests).toHaveLength(1);
    } finally {
      f.close();
    }
  });
  test("leaves Prime's provider payload hook unregistered so retries keep idempotency keys", async () => {
    const f = await fixture(true);

    try {
      expect(Object.keys(f.host.handlers)).not.toContain("before_provider_request");
    } finally {
      f.close();
    }
  });
  test("an automatic retry loop is traced under its request instead of being dropped", async () => {
    const f = await fixture(true);

    try {
      const failure: JsonObject = { role: "assistant", stopReason: "error", content: [] };

      const reply: JsonObject = {
        role: "assistant",
        model: "synthetic-model",
        stopReason: "stop",
        content: [{ type: "text", text: "retried answer" }],
        usage: { input: 4, output: 1 },
      };

      await startRequest(f.host);
      await f.host.emit("message_end", { message: failure });
      await f.host.emit("agent_end", { messages: [failure] });
      // Prime's retry calls agent.continue(): agent_start without before_agent_start.
      await f.host.emit("agent_start", { type: "agent_start" });
      await f.host.emit("message_start", { message: { role: "assistant", content: [] } });
      await f.host.emit("message_end", { message: reply });
      await f.host.emit("agent_end", { messages: [reply] });
      await f.host.command?.("flush", f.host.ctx);

      const spans = exportedSpans(f.requests);
      const roots = spans.filter((span) => span["parentSpanId"] === undefined);
      const continuation = spans.find((span) => span["name"] === "Prime Agent continuation");

      const retried = spans.find(
        (span) =>
          spanAttribute(span, "langfuse.observation.type") === "generation" &&
          JSON.stringify(spanAttribute(span, "langfuse.observation.output")).includes(
            "retried answer",
          ),
      );

      expect(roots).toHaveLength(1);
      expect(continuation?.["traceId"]).toBe(roots[0]?.["traceId"]);
      expect(continuation?.["parentSpanId"]).toBe(roots[0]?.["spanId"]);
      expect(spanAttribute(continuation, "langfuse.observation.output")).toContain(
        "retried answer",
      );
      expect(retried?.["parentSpanId"]).toBe(continuation?.["spanId"]);

      // A new prompt starts its own trace rather than continuing the retried one.
      await startRequest(f.host, "next prompt");
      await f.host.emit("agent_end", { messages: [] });
      await f.host.command?.("flush", f.host.ctx);
      expect(
        exportedSpans(f.requests).filter((span) => span["parentSpanId"] === undefined),
      ).toHaveLength(2);
    } finally {
      f.close();
    }
  });
});

describe("capture privacy and payload compatibility", () => {
  test("removes structured secrets, reasoning, images, and common credential strings", () => {
    const captured = capture(
      {
        api_key: "never-send",
        authorization: "other-secret",
        text: "Bearer abcdefghijk sk-abcdefghijk secret=foobar",
        content: [
          { type: "thinking", thinking: "hidden reasoning" },
          { type: "image", data: "base64" },
        ],
      },
      [],
    );

    for (const secret of [
      "never-send",
      "other-secret",
      "abcdefghijk",
      "foobar",
      "hidden reasoning",
      "base64",
    ])
      expect(captured).not.toContain(secret);
    expect(captured).toContain("REDACTED");
  });
  test("omits provider-shaped reasoning fields and Google thought parts", () => {
    const captured = capture(
      {
        contents: [
          {
            parts: [
              { thought: true, text: "google-private", thoughtSignature: "signature-private" },
            ],
          },
        ],
        reasoning_content: "openai-private",
        reasoning_text: "reasoning-private",
        reasoning_details: [{ text: "details-private" }],
      },
      [],
    );

    for (const secret of [
      "google-private",
      "signature-private",
      "openai-private",
      "reasoning-private",
      "details-private",
    ])
      expect(captured).not.toContain(secret);
    expect(captured).toContain("OMITTED");
  });

  test("redacts environment-style and camel-case credential field names", () => {
    const captured = capture(
      {
        AWS_SECRET_ACCESS_KEY: "cloud-private",
        clientSecretKey: "client-private",
        token: "opaque-private",
        headers: { "X-Api-Key": "header-private" },
        max_tokens: 100,
      },
      [],
    );

    for (const secret of ["cloud-private", "client-private", "opaque-private", "header-private"])
      expect(captured).not.toContain(secret);
    expect(captured).toContain("max_tokens");
  });

  test("redacts secret fields in JSON-encoded tool arguments", () => {
    const captured = capture(
      {
        tool_calls: [
          {
            function: {
              name: "synthetic",
              arguments: JSON.stringify({
                password: "very private multi word value",
                access_token: "other-private-token",
              }),
            },
          },
        ],
      },
      [],
    );

    expect(captured).not.toContain("very private");
    expect(captured).not.toContain("other-private-token");
    expect(captured).toContain("REDACTED");
  });

  test("omits oversized encoded JSON instead of leaking its unparsed secret fields", () => {
    const value = capture(
      {
        arguments: JSON.stringify({ password: "very private words", padding: "x".repeat(65_000) }),
      },
      [],
    );

    expect(value).not.toContain("very private");
    expect(value).toContain("TRUNCATED JSON");
  });

  test("caps oversized captures without emitting invalid JSON", () => {
    const value = capture(
      { messages: Array.from({ length: 1000 }, () => ({ content: "x".repeat(100000) })) },
      [],
    );

    expect(value.length).toBeLessThanOrEqual(64000);
    expect(parseJson(value).kind).toBe("valid");
  });
  test("native messages normalize to recognized assistant and tool messages", () => {
    expect(assistantOutput(assistant)).toEqual({
      role: "assistant",
      content: "synthetic response",
      tool_calls: [
        {
          id: "call1",
          type: "function",
          function: { name: "ipython", arguments: '{"code":"print(1)"}' },
        },
      ],
    });
    expect(toolOutput("call1", { content: [{ type: "text", text: "1" }] })).toEqual({
      role: "tool",
      tool_call_id: "call1",
      content: "1",
    });
  });
});
