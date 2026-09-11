# Design

## Problem

Langfuse Observer is a local, read-only trace and session viewer. It reads credentials from `.env` and renders activity without the Langfuse CLI. Langfuse v4 returns observation rows rather than complete traces or sessions. The app groups logical roots for the trace list, groups matching observations for the session list, and rebuilds the physical parent tree for trace detail. Langfuse v3 returns complete legacy trace and session records, so a separate adapter converts those records to the same view model.

## Usage

```sh
npm start
```

The server listens on `http://127.0.0.1:3000`. `GET /` shows recent traces. `GET /sessions` shows recent sessions. Detail pages live at `/traces/:traceId` and `/sessions/:sessionId`. Credentials stay in the server process and never enter HTML or URLs. `LANGFUSE_API_VERSION` accepts `auto`, `v3`, or `v4`.

## Shape

The app has one main domain interface:

```js
observer.listRecentTraces(window)
observer.listRecentSessions(window)
observer.getTrace(traceId)
observer.getSession(sessionId)
```

`src/langfuse.js` hides API selection, Basic authentication, field selection, time bounds, pagination, response parsing, and session filters behind those calls. Its v4 adapter reads `/api/public/v2/observations`. Its v3 adapter reads the legacy trace and session endpoints. `src/server.js` owns HTTP routing and safe error pages. `src/views.js` owns escaped HTML. `src/trace-model.js` contains the pure grouping and tree decisions.

Recent views accept `1h`, `6h`, `24h`, `7d`, `30d`, or `90d`. Direct v4 lookup uses a fixed 90-day range. V4 lists follow cursors. V3 lists follow numbered pages. The viewer returns an explicit error if a query crosses its row budget rather than presenting partial results as complete.

## Synthesis decision

Two designs were compared. A server-rendered app became the base because it has no browser state or frontend build and its HTTP tests cover the visible pages. The rejected design used a local JSON API and static browser application. Its recent-window selector, direct lookup, and cursor-loop protection were folded into the server-rendered design. The JSON contract, request cancellation, and client-side navigation were dropped because full-page navigation is adequate for this focused tool.

The session addition compared a generic OpenTelemetry session context with Langfuse-specific runtime types. The generic `session.id` design won because Langfuse maps that standard attribute and AgentTrace can stay independent of one backend. The observer keeps the useful part of the other design: session discovery reads all matching observations, while each trace link uses the existing complete tree view. The larger OpenCode event-model and persisted-schema rewrite was not needed for the live proof.

## Tradeoffs

- The app accepts full-page refreshes in exchange for no client runtime.
- Recent browsing only includes traces with a logical root in the selected window. Direct lookup still finds a known trace ID.
- Trace and session lookup only search 90 days in exchange for bounded Langfuse queries.
- Session pages show complete membership and link each trace to its complete tree. They do not embed every trace payload into one large page.
- Automatic selection falls back to v3 only when the v4 endpoint returns `404` or `405`. Authentication and server errors remain visible.
- V3 session list records do not contain trace or observation counts. Session detail lists every trace, and trace detail loads every observation.
- V3 support depends on deprecated read endpoints that self-hosted Langfuse v3 still provides.
