# Langfuse Observer

A tiny local viewer for Langfuse traces and sessions. It supports Langfuse Cloud, self-hosted Langfuse v4, and self-hosted Langfuse v3. The viewer selects the available read API, fetches data with the credentials in `.env`, and renders each trace as a parent-child tree.

There is no Langfuse CLI, SDK, frontend framework, build step, or database. Bun runs the TypeScript source directly. The server uses the Node-compatible HTTP APIs built into Bun. Your Langfuse secret stays in the local server process.

## Run it

Requirements: Bun 1.3.14 or newer and a Langfuse Cloud or self-hosted project. The quality checks also require Node.js 24 because Vite+ runs its local command with Node.

```sh
cp .env.example .env
```

Fill in the three values:

```dotenv
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com
LANGFUSE_API_VERSION=auto
```

Install the development tools and start the viewer:

```sh
bun install --frozen-lockfile
bun run start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000).

`LANGFUSE_API_VERSION=auto` tries the v4 Observations API first. If that endpoint does not exist, the process switches to the v3 legacy read API and keeps that choice until restart. Set the value to `v3` or `v4` to skip automatic selection.

## What it shows

- Recent traces and sessions from the last 1 hour, 6 hours, 24 hours, 7 days, 30 days, or 90 days
- Trace filters for name or ID, environment, tags, highest level, and running state
- Direct lookup for a known trace ID. V4 searches the last 90 days, while v3 retrieves the trace by ID.
- Direct lookup for a known session ID. V4 searches the last 90 days, while v3 returns the complete legacy session record.
- Physical parent-child order using `parentObservationId`
- A per-turn agent sidebar that extracts system and developer prompts, declared tools, input context, replies, tool calls, and tool results from recognized payloads
- Turn badges and links that highlight the matching `GENERATION` observation
- Input, output, model parameters, model, token usage, cost, and timing for each observation
- Clear empty, authentication, rate-limit, timeout, and malformed-response pages
- Trace-level input and output returned by the v3 trace API

On v4, the recent trace list asks Langfuse for logical root observations. A distributed trace with no logical root in this project may not appear there, but direct lookup still works when you know its ID. The session list follows every cursor in the selected window before it groups rows by `sessionId` and `traceId`. Detail pages show the exact 90-day query bounds because totals and parent relationships can be partial at that boundary.

On v3, the viewer follows the page-number pagination returned by the legacy trace and session endpoints. The v3 session list does not include trace or observation counts. Open a session to list its traces, then open a trace to load every observation and payload.

Trace filters run after the viewer reads every result page in the selected window. Search, environment, and tag filters work with both APIs. Highest-level and running-state filters require v4 because the v3 trace list does not provide those facts.

Each viewer request has a 30-second deadline. Closing the browser request cancels active Langfuse reads. Row and page budgets stop oversized or non-terminating pagination with an explicit error instead of returning a partial page. Rate-limit pages use Langfuse's `Retry-After` header when it is present.

The agent sidebar recognizes top-level OpenAI Chat, OpenAI Responses, Anthropic, and standard message-array payloads. Structured Langfuse input and output remain structured; JSON text is decoded only when the stored field is a string. The parser does not search arbitrary nested keys. Unknown or oversized payloads remain available in the raw observation, and the sidebar reports partial coverage.

## Test it

```sh
bun run check
```

Vite+ runs Oxfmt, Oxlint, type-aware linting, and TypeScript checks. The vendored [anti-slop](https://github.com/dmmulroy/anti-slop) rules reject broad dictionaries, ad hoc runtime narrowing, unsafe assertions, and other low-evidence TypeScript. The command rejects formatting changes, lint warnings, and type errors. Bun then runs the real viewer against local fake v3 and v4 Langfuse HTTP servers. The tests cover API selection, trace and session pages, authentication, cancellation, deadlines, pagination, deep trees, agent payload parsing, HTML escaping, redirects, and empty states. CI runs the same command with Bun 1.3.14 and Node.js 24.

Run `bun run check:fix` to apply formatter and safe lint fixes. The project pins Vite+, `@oxlint/plugins`, and Bun versions and commits `bun.lock`, so local and CI installs resolve the same toolchain. The vendored rules and their upstream revision are recorded in `tools/oxlint/anti-slop/UPSTREAM.md`.

## API choice

Langfuse v4 uses `GET /api/public/v2/observations`. The viewer groups those observation rows by `traceId` and `sessionId`.

Self-hosted Langfuse v3 uses the legacy `GET /api/public/traces` and `GET /api/public/sessions` endpoints. Langfuse v4 removed those endpoints, so the viewer keeps the two adapters separate. See the [Langfuse compatibility matrix](https://langfuse.com/docs/compatibility), [Observations API documentation](https://langfuse.com/docs/api-and-data-platform/features/observations-api), [deprecated API migration guide](https://langfuse.com/faq/all/deprecated-api-migration), and [Public API authentication](https://langfuse.com/docs/api-and-data-platform/features/public-api).
