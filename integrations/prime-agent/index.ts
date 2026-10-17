import { randomBytes } from "node:crypto";
import {
  isJsonObject,
  isJsonNumber,
  isJsonString,
  type JsonObject,
  type JsonValue,
} from "../../src/json.ts";
import { readSettings, readTracingEnabled, setTracingEnabled, type Settings } from "./config.ts";
import { assistantOutput, capture, conversationInput, finalReply, toolOutput } from "./privacy.ts";
import type { PrimeContext, PrimeExtensionAPI } from "./prime-contract.ts";
import { LangfuseExporter, type Observation } from "./transport.ts";

/** Where a request's later agent loops attach when Prime continues it without a new prompt. */
interface Continuation {
  traceId: string;
  rootId: string;
  traceName: string;
  captureBodies: boolean;
}

interface Run {
  root: Observation;
  generation: Observation | null;
  latestGenerationId: string | null;
  generationInput: string | null;
  /** When Prime assembled the next provider request; message_start waits for response headers. */
  generationStart: number | null;
  tools: Map<string, Observation>;
  captureBodies: boolean;
  failed: boolean;
}

function id(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function positive(value: JsonValue | undefined): number {
  return isJsonNumber(value) && value >= 0 ? value : 0;
}

function usage(message: JsonObject, observation: Observation): void {
  const tokens = message["usage"];

  if (!isJsonObject(tokens)) return;
  // Only the finalized provider message, never Prime's later child aggregates.
  const input = positive(tokens["input"]);
  const output = positive(tokens["output"]);
  const cacheRead = positive(tokens["cacheRead"]);
  const cacheWrite = positive(tokens["cacheWrite"]);
  observation.usage = {
    input: input + cacheRead + cacheWrite,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
  };
  const cost = tokens["cost"];

  if (isJsonObject(cost)) {
    observation.cost = {
      input: positive(cost["input"]) + positive(cost["cacheRead"]) + positive(cost["cacheWrite"]),
      output: positive(cost["output"]),
      total: positive(cost["total"]),
    };
  }
}

/** Register passive host hooks. No provider payload or conversation is modified. */
export function registerTracing(pi: PrimeExtensionAPI, settings: Settings): void {
  const exporter = new LangfuseExporter(settings.transport);
  const secrets = [settings.transport.publicKey, settings.transport.secretKey];
  const runs = new Map<string, Run>();
  const continuations = new Map<string, Continuation>();
  let enabled = settings.enabled;
  let bodies = settings.captureBodies;
  let timerStarted = false;

  function tracingEnabled(): boolean {
    const savedEnabled = readTracingEnabled(settings.configPath);

    if (!savedEnabled && enabled) {
      runs.clear();
      continuations.clear();
      exporter.clear();
    }

    enabled = savedEnabled;

    return enabled;
  }

  function flush(): Promise<void> {
    return tracingEnabled() ? exporter.flush() : Promise.resolve();
  }

  function body(value: JsonValue, run: Run): string | undefined {
    return enabled && bodies && run.captureBodies ? capture(value, secrets) : undefined;
  }

  function finish(observation: Observation, error = false): void {
    if (!tracingEnabled()) return;
    observation.endTime = Math.max(observation.startTime, Date.now());

    if (error) observation.error = true;
    exporter.enqueue(observation);
  }

  function finishRun(sessionId: string, interrupted = false): void {
    const run = runs.get(sessionId);

    if (!run) return;

    if (run.generation) finish(run.generation, true);

    for (const tool of run.tools.values()) finish(tool, true);
    finish(run.root, interrupted || run.failed || run.generation !== null || run.tools.size > 0);
    runs.delete(sessionId);
  }

  function startRun(root: Observation, captureBodies: boolean): Run {
    const run: Run = {
      root,
      generation: null,
      latestGenerationId: null,
      generationInput: null,
      generationStart: null,
      tools: new Map(),
      captureBodies,
      failed: false,
    };

    runs.set(root.sessionId, run);

    return run;
  }

  function newGeneration(run: Run, ctx: PrimeContext): Observation {
    const generation: Observation = {
      traceId: run.root.traceId,
      id: id(8),
      parentId: run.root.id,
      sessionId: run.root.sessionId,
      traceName: run.root.traceName,
      name: "Model call",
      type: "GENERATION",
      startTime: run.generationStart ?? Date.now(),
      endTime: Date.now(),
    };

    run.generationStart = null;

    if (ctx.model) generation.model = ctx.model.id;

    if (run.generationInput !== null) generation.input = run.generationInput;
    run.generation = generation;

    return generation;
  }

  pi.on("session_start", (_event, ctx) => {
    if (!timerStarted) {
      ctx.setInterval(flush, 2_000);
      timerStarted = true;
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (!tracingEnabled()) return;
    const sessionId = ctx.sessionManager.getSessionId();
    finishRun(sessionId, true);
    continuations.delete(sessionId);

    const root: Observation = {
      traceId: id(16),
      id: id(8),
      sessionId,
      traceName: "Prime Agent request",
      name: "Prime Agent",
      type: "AGENT",
      startTime: Date.now(),
      endTime: Date.now(),
    };

    const run = startRun(root, bodies);
    const input = body({ role: "user", content: event.prompt }, run);

    if (input !== undefined) root.input = input;
  });

  // An automatic retry runs a new agent loop with no before_agent_start; trace it under its request.
  pi.on("agent_start", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const continuation = continuations.get(sessionId);

    if (!tracingEnabled() || runs.has(sessionId) || !continuation) return;
    startRun(
      {
        traceId: continuation.traceId,
        id: id(8),
        parentId: continuation.rootId,
        sessionId,
        traceName: continuation.traceName,
        name: "Prime Agent continuation",
        type: "AGENT",
        startTime: Date.now(),
        endTime: Date.now(),
      },
      continuation.captureBodies,
    );
  });

  pi.on("context", (event, ctx) => {
    const run = runs.get(ctx.sessionManager.getSessionId());

    if (!tracingEnabled() || !run) return;
    run.generationInput = body(conversationInput(event.messages), run) ?? null;
    run.generationStart = Date.now();
  });

  // No before_provider_request hook: registering one makes Prime drop idempotency-key reuse on retries.
  pi.on("message_start", (event, ctx) => {
    if (event.message["role"] !== "assistant") return;
    const run = runs.get(ctx.sessionManager.getSessionId());

    if (tracingEnabled() && run && !run.generation) newGeneration(run, ctx);
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message["role"] !== "assistant") return;
    const run = runs.get(ctx.sessionManager.getSessionId());

    if (!tracingEnabled() || !run) return;
    const generation = run.generation ?? newGeneration(run, ctx);
    const model = event.message["model"];

    if (isJsonString(model)) generation.model = model;
    const output = body(assistantOutput(event.message), run);

    if (output !== undefined) generation.output = output;
    usage(event.message, generation);
    const stop = event.message["stopReason"];
    const failed = stop === "error" || stop === "aborted";
    run.failed ||= failed;
    finish(generation, failed);
    run.latestGenerationId = generation.id;
    run.generation = null;
  });

  pi.on("tool_execution_start", (event, ctx) => {
    const run = runs.get(ctx.sessionManager.getSessionId());

    if (!tracingEnabled() || !run || run.tools.size >= 256) return;

    const tool: Observation = {
      traceId: run.root.traceId,
      id: id(8),
      parentId: run.latestGenerationId ?? run.root.id,
      sessionId: run.root.sessionId,
      traceName: run.root.traceName,
      name: event.toolName,
      type: "TOOL",
      startTime: Date.now(),
      endTime: Date.now(),
    };

    const input = body({ name: event.toolName, arguments: event.args }, run);

    if (input !== undefined) tool.input = input;
    run.tools.set(event.toolCallId, tool);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    const run = runs.get(ctx.sessionManager.getSessionId());
    const tool = run?.tools.get(event.toolCallId);

    if (!tracingEnabled() || !run || !tool) return;
    const output = body(toolOutput(event.toolCallId, event.result), run);

    if (output !== undefined) tool.output = output;
    run.failed ||= event.isError;
    finish(tool, event.isError);
    run.tools.delete(event.toolCallId);
  });

  pi.on("agent_end", (event, ctx) => {
    if (!tracingEnabled()) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const run = runs.get(sessionId);
    const reply = finalReply(event.messages);

    if (run && reply !== null) {
      const output = body(reply, run);

      if (output !== undefined) run.root.output = output;
    }

    if (run) {
      continuations.set(sessionId, {
        traceId: run.root.traceId,
        rootId: run.root.parentId ?? run.root.id,
        traceName: run.root.traceName,
        captureBodies: run.captureBodies,
      });
    }

    finishRun(sessionId);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    if (!tracingEnabled()) return;
    finishRun(ctx.sessionManager.getSessionId(), true);
    continuations.delete(ctx.sessionManager.getSessionId());
    await exporter.close();
  });

  pi.registerCommand("langfuse", {
    description:
      "Tracing status | on | off (saved for all sessions) | capture-on | capture-off | flush",
    handler: async (args, ctx) => {
      switch (args.trim() || "status") {
        case "on":
        case "off":
          try {
            setTracingEnabled(settings.configPath, args.trim() === "on");
          } catch {
            ctx.ui.notify(
              "Could not save Langfuse tracing setting. Check config file access.",
              "error",
            );

            return;
          }

          tracingEnabled();
          break;
        case "capture-on":
          bodies = true;
          break;
        case "capture-off":
          bodies = false;
          exporter.clear();

          for (const continuation of continuations.values()) continuation.captureBodies = false;

          for (const run of runs.values()) {
            run.captureBodies = false;
            run.generationInput = null;
            delete run.root.input;
            delete run.root.output;

            if (run.generation) {
              delete run.generation.input;
              delete run.generation.output;
            }

            for (const tool of run.tools.values()) {
              delete tool.input;
              delete tool.output;
            }
          }

          break;
        case "flush":
          await flush();
          break;
        case "status":
          break;
        default:
          ctx.ui.notify("Usage: /langfuse status|on|off|capture-on|capture-off|flush", "warning");

          return;
      }

      tracingEnabled();
      const status = exporter.status();
      ctx.ui.notify(
        `Langfuse ${enabled ? "on" : "off"}; bodies ${bodies ? "on (best-effort redaction)" : "off"}; sent ${status.sent}; pending ${status.pending}; dropped ${status.dropped}; ${status.lastError ?? "no export errors"}; session ${ctx.sessionManager.getSessionId()}`,
        "info",
      );
    },
  });
}

export default function extension(pi: PrimeExtensionAPI): void {
  const settings = readSettings();

  if (!settings) {
    pi.registerCommand("langfuse", {
      description: "Langfuse setup status",
      handler: async (_args, ctx) => {
        ctx.ui.notify(
          "Langfuse not configured. Check ~/.prime/agent/langfuse.json and its envFile.",
          "warning",
        );
      },
    });

    return;
  }

  try {
    registerTracing(pi, settings);
  } catch {
    pi.registerCommand("langfuse", {
      description: "Langfuse setup status",
      handler: async (_args, ctx) => {
        ctx.ui.notify(
          "Langfuse configuration rejected. Use an HTTPS deployment origin (HTTP allowed only on loopback).",
          "warning",
        );
      },
    });
  }
}
