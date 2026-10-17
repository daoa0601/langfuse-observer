# Prime Agent → Langfuse

A passive TypeScript extension for Prime Agent 0.9.5. It sends completed model and tool observations to the same Langfuse project that this viewer reads. No new runtime dependencies, model proxy, or provider credential changes are required.

## Install

From the `langfuse-observer` repository:

```sh
bun integrations/prime-agent/install.ts
```

The installer refuses to overwrite existing files. It creates:

- `~/.prime/agent/extensions/langfuse.ts`: imports this checkout's extension.
- `~/.prime/agent/langfuse.json`: references this checkout's `.env`; contains no copied keys.

Keep this checkout at its installed path. Both files use owner-only permissions. The extension reads the referenced `.env` directly on load, so a resident Prime daemon does not need a restart to inherit new shell variables. Credentials stay in the host process, not the Python kernel or browser.

In Prime Agent:

```text
/reload
/langfuse status
```

Tracing is global across sessions that load the extension. Installation enables **metadata-only** tracing: session IDs, model names, model/tool timing, usage, available cost, and error status. It does **not** upload prompts, replies, code, tool output, local paths, or historical transcripts by default.

To show prompts, replies, and tool content in the observer sidebar:

```text
/langfuse capture-on
```

This takes effect for requests started after the command. The agent root captures the submitted prompt and final reply. Model input uses Prime's conversation context with user messages, assistant messages, and tool results; it can contain earlier conversation content. Raw provider request options and system instructions are not captured. Common credential patterns and the configured Langfuse keys are redacted. Known thinking/reasoning fields, image blocks, and signatures are omitted. If a provider has already converted reasoning into ordinary text, the filter cannot distinguish it from other prose. Captures have size/depth limits. **Redaction is best effort, not a guarantee that arbitrary private text or every secret will be removed.**

## Browse agent requests

In Langfuse's Tracing page, select only **True** under **Is Root Observation**. Each row then represents an agent request. Open a row to inspect its model calls and tools. Save that filter as a view if you want to reuse it. Selecting both True and False lists every observation, including model and tool calls, as its own row.

## Controls

```text
/langfuse status
/langfuse flush
/langfuse capture-off
/langfuse off
/langfuse on
```

`on` and `off` save the tracing setting in `~/.prime/agent/langfuse.json` and apply to every session using that file, including child agents. The setting survives reloads and restarts. `off` discards active requests and pending exports, and aborts an in-flight upload. Other loaded instances check the setting before recording or flushing and at least every two seconds. `capture-on` and `capture-off` affect the current extension instance and reset on reload. `capture-off` discards queued observations and strips bodies from active work. Neither control can retract data already accepted by Langfuse.

You can also edit `~/.prime/agent/langfuse.json`. Changes to `enabled` apply without a reload. Other settings require `/reload`:

```json
{
  "envFile": "/absolute/path/to/langfuse-observer/.env",
  "enabled": true,
  "captureBodies": false,
  "environment": "prime-agent"
}
```

`PRIME_AGENT_LANGFUSE_CONFIG` can select another configuration file before startup. The `.env` must supply `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`, and `LANGFUSE_SECRET_KEY`. Use an HTTPS origin; HTTP is accepted only for loopback hosts. Redirects are rejected. `LANGFUSE_API_VERSION` controls the viewer read API, not OTLP writes.

## Observation layout

- A trace per Prime `before_agent_start`/`agent_end` request, with an `AGENT` root carrying the prompt and final reply when body capture is enabled.
- Model calls are children of the agent root; tools are children of the model call that requested them, using their actual tool names.
- A `GENERATION` observation per finalized model response.
- A `TOOL` observation per host tool execution, parented to its generation.
- The Prime session ID is Langfuse's first-class `sessionId`.
- Only generations carry usage/cost. The exporter does not repeat Prime's later aggregate child-usage bookkeeping.
- Native Prime replies/tool calls are converted into payloads the observer recognizes.

The extension observes TypeScript host events. A Python Langfuse decorator alone would not see these model calls. Functions and subprocesses inside a single `ipython` execution do not get separate spans.

Normal CLI/daemon RLM children load their own extension instance and export **separate sessions and traces**. Existing children are not retroactively reloaded when the parent runs `/reload`, but they share the saved tracing switch. Exact parent launch IDs are not exposed by the public hooks, so this version does not invent cross-agent parent links. A parent `ipython` span is not a full nested child trace. The low-level bare SDK inline fallback can share parent hooks; that path is not supported for reliable child tracing.

## Delivery and limits

The host-owned timer flushes every two seconds; `/langfuse flush` requests an immediate attempt. Networking is not awaited by model/tool hooks. Shutdown attempts a bounded flush. The exporter caps queue count/bytes, batches, response size, and each flush deadline, and reports sent/pending/dropped counts without logging response bodies or credentials.

Only completed observations are sent. With v4 ingestion, observations are immutable. The root becomes visible in the recent trace list when the request finishes and ingestion completes. There is no token-by-token live view, disk spool, or history backfill. A crash can lose queued spans or leave child observations without a root. Queue overflow drops new observations; transient failures retry with stable IDs and backoff. OTLP partial success is not retried, per the protocol. See [PROTOCOL.md](PROTOCOL.md).

No raw provider error messages are uploaded. Costs are whatever Prime's provider message reports, not a billing guarantee. Changing model providers or runtime versions may require revalidating the structural host contract in `prime-contract.ts`.

## Validate

```sh
bun test integrations/prime-agent
bun run check
```

`bun run check` requires Node 24, as does the rest of this repository. The extension tests use fake local OTLP servers and synthetic host events. They do not read `.env` or send production telemetry.

Optional **live** smoke test (explicitly uploads only three synthetic observations):

```sh
bun --env-file=.env integrations/prime-agent/smoke.ts send
bun --env-file=.env integrations/prime-agent/smoke.ts read <traceId-from-send>
```

The read command uses the actual observer adapter and renderer to verify parent links, session grouping, prompt, and reply. If ingestion is not visible yet, rerun only `read` later. Open the returned local observer URL with `bun run start` running.

To uninstall, remove only the installed `extensions/langfuse.ts` wrapper and `langfuse.json`, then `/reload`. This does not delete data already uploaded to Langfuse.
