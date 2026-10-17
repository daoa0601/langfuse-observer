import { randomBytes } from "node:crypto";
import { loadConfig } from "../../src/config.ts";
import { createLangfuseObserver } from "../../src/langfuse.ts";
import { renderTracePage } from "../../src/trace-view.ts";
import { LangfuseExporter, type Observation } from "./transport.ts";

// Deliberately uses only synthetic strings. Never reads session files or prompts.
async function smoke(): Promise<void> {
  const config = loadConfig(process.env);
  const action = process.argv[2];

  if (action === "send") {
    const traceId = randomBytes(16).toString("hex");
    const rootId = randomBytes(8).toString("hex");
    const modelId = randomBytes(8).toString("hex");
    const now = Date.now();

    const base = {
      traceId,
      sessionId: `prime-agent-smoke-${traceId}`,
      traceName: "Prime Agent tracing smoke test (synthetic)",
      startTime: now - 1000,
      endTime: now,
    };

    const root: Observation = { ...base, id: rootId, name: "Synthetic Prime Agent", type: "AGENT" };

    const model: Observation = {
      ...base,
      id: modelId,
      parentId: rootId,
      name: "Synthetic model call",
      type: "GENERATION",
      model: "prime-agent-synthetic",
      input: JSON.stringify({ messages: [{ role: "user", content: "Synthetic greeting" }] }),
      output: JSON.stringify({ role: "assistant", content: "Synthetic reply" }),
      usage: { input: 1, output: 1, total: 2 },
      cost: { input: 0, output: 0, total: 0 },
    };

    const tool: Observation = {
      ...base,
      id: randomBytes(8).toString("hex"),
      parentId: modelId,
      name: "Synthetic ipython",
      type: "TOOL",
      input: JSON.stringify({ code: "1 + 1" }),
      output: JSON.stringify({ role: "tool", tool_call_id: "synthetic-call", content: "2" }),
    };

    const exporter = new LangfuseExporter({
      baseUrl: config.baseUrl.origin,
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      environment: "prime-agent-smoke",
    });

    for (const observation of [root, model, tool]) exporter.enqueue(observation);
    await exporter.flush();
    const status = exporter.status();
    console.log(JSON.stringify({ traceId, sessionId: base.sessionId, ...status }));

    if (status.sent !== 3 || status.dropped !== 0 || status.pending !== 0) process.exitCode = 1;

    return;
  }

  const traceId = process.argv[3];

  if (action !== "read" || !traceId || !/^[a-f0-9]{32}$/.test(traceId))
    throw new Error("Invalid smoke command");
  const observer = createLangfuseObserver(config);
  const trace = await observer.getTrace(traceId);

  if (!trace) throw new Error("Synthetic trace not yet visible");
  const html = renderTracePage(trace, "1h");

  const checks = {
    observations: trace.rows.length === 3,
    root: trace.rows.filter((row) => row.relation === "root").length === 1,
    children: trace.rows.filter((row) => row.relation === "child").length === 2,
    session: trace.sessionIds.includes(`prime-agent-smoke-${traceId}`),
    prompt: html.includes("Synthetic greeting"),
    reply: html.includes("Synthetic reply"),
    sidebar: html.includes("agent-sidebar"),
  };

  console.log(
    JSON.stringify({
      traceId,
      apiVersion: trace.apiVersion,
      checks,
      observerUrl: `http://127.0.0.1:3000/traces/${traceId}`,
    }),
  );

  if (Object.values(checks).some((passed) => !passed)) process.exitCode = 1;
}

if (import.meta.main) {
  try {
    await smoke();
  } catch {
    console.error(
      "Synthetic smoke check failed. Check credentials/connectivity or retry read after ingestion completes; no credentials or response bodies logged.",
    );
    process.exitCode = 1;
  }
}
