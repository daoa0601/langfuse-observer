# Design

## Problem

Langfuse Observer is a local, read-only trace and session viewer. It reads credentials from `.env` and renders activity without the Langfuse CLI. Langfuse v4 returns observation rows rather than complete traces or sessions. The app groups logical roots for the trace list, groups matching observations for the session list, and rebuilds the physical parent tree for trace detail. Langfuse v3 returns complete legacy trace and session records, so a separate adapter converts those records to the same view model.

## Usage

```sh
bun run start
```

The server listens on `http://127.0.0.1:3000`. `GET /` shows recent traces. `GET /sessions` shows recent sessions. Detail pages live at `/traces/:traceId` and `/sessions/:sessionId`. Credentials stay in the server process and never enter HTML or URLs. `LANGFUSE_API_VERSION` accepts `auto`, `v3`, or `v4`.

## Shape

The app has one main domain interface:

```ts
observer.listRecentTraces(window, { signal });
observer.listRecentSessions(window, { signal });
observer.getTrace(traceId, { signal });
observer.getSession(sessionId, { signal });
```

`src/langfuse.ts` selects an API version and exposes the observer interface. `src/langfuse-v4.ts` reads `/api/public/v2/observations`. `src/langfuse-v3.ts` reads the legacy trace and session endpoints. `src/langfuse-api.ts` owns Basic authentication and validates values shared by both adapters. `src/json.ts` converts untyped response data to the recursive `JsonValue` domain type. `src/server.ts` owns HTTP routing and safe error pages. `src/views.ts` renders trace and session lists. `src/trace-view.ts` renders trace details and raw payloads. `src/view-helpers.ts` holds shared HTML escaping, date formatting, and page layout.

The agent parser has separate jobs. `src/agent-payload-recognizers.ts` selects a supported provider format. `src/agent-message-parser.ts` reads messages, content blocks, tool calls, and declarations. `src/agent-payloads.ts` assembles model turns. `src/agent-payload-types.ts` defines the result. `src/agent-sidebar.ts` renders it.

Each `GENERATION` observation defines one model turn. Input messages provide context for that turn. Output messages provide replies only when the parser recognizes a direct assistant response or a provider response envelope. Conversation history and completion alternatives do not create extra turns.

Observation input and output stay as structured `JsonValue` data after the HTTP boundary. The parser only decodes JSON text when Langfuse stored the field as a string. It accepts complete top-level shapes instead of searching nested objects for keys such as `role` or `tools`. Each extracted prompt, tool, message, and reply records its source field and JSON Pointer. Fixed limits bound the source size, depth, node count, message count, tool count, content count, and extracted text. A failed or partial parse does not hide the raw observation.

Recent views accept `1h`, `6h`, `24h`, `7d`, `30d`, or `90d`. Direct v4 lookup uses a fixed 90-day range and carries those bounds into the rendered result. V4 lists follow cursors. V3 lists follow numbered pages. The viewer returns an explicit error if a query crosses its row or page budget rather than presenting partial results as complete.

The HTTP boundary gives each viewer request one 30-second deadline and cancels the upstream read when the browser disconnects. The requester also caps each Langfuse page request at 10 seconds. Both constraints use the same signal passed through the observer interface.

## Toolchain

Bun runs the TypeScript source and the behavior tests. Vite+ provides Oxfmt, Oxlint, and type checks. The repository vendors anti-slop and pins `@oxlint/plugins` to the Oxlint version that Vite+ uses. `bun run check` checks formatting, rejects lint warnings, checks types, and then runs `bun test`.

Only `JSON.parse`, `Response.json`, and caught exceptions enter the code as `unknown`. `src/json.ts` validates JSON once. Provider and Langfuse parsers then receive `JsonValue` or a typed JSON object. Discriminated result types keep the v3 and v4 differences visible. V3 list counts remain `null`, v3 detail scope is complete, and v4 detail scope carries its exact time bounds. `ObserverError` uses a closed code union, and the HTTP layer handles every code explicitly.

The project has no production dependencies or emitted JavaScript tree. Bun executes the same `.ts` files that the tests import. There is no browser bundle, so the project does not configure a build task.

## Tradeoffs

- The app accepts full-page refreshes in exchange for no client runtime.
- The agent sidebar favors strict recognition over extracting every custom provider payload. Unrecognized JSON stays visible in the observation and appears in the parser notes.
- Recent browsing only includes traces with a logical root in the selected window. Direct lookup still finds a known trace ID.
- V4 trace and session lookup only search 90 days. Detail pages state that range and warn that totals and parent relationships can be partial.
- Each browser request may spend at most 30 seconds reading Langfuse. Slow or oversized pagination fails instead of continuing after the user leaves.
- Session pages show complete membership and link each trace to its complete tree. They do not embed every trace payload into one large page.
- Automatic selection falls back to v3 only when the v4 endpoint returns `404` or `405`. Authentication and server errors remain visible.
- V3 session list records do not contain trace or observation counts. Session detail lists every trace, and trace detail loads every observation.
- V3 support depends on deprecated read endpoints that self-hosted Langfuse v3 still provides.
