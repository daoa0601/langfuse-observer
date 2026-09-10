# Design

## Problem

Langfuse Observer is a local, read-only trace viewer. It reads credentials from `.env`, calls Langfuse's Observations API v2, and renders recent traces without the Langfuse CLI. Langfuse returns observation rows rather than complete traces, so the app groups logical roots for the recent list and rebuilds the physical parent tree for trace detail.

## Usage

```sh
npm start
```

The server listens on `http://127.0.0.1:3000`. `GET /` shows recent traces. `GET /traces/:traceId` shows one trace. The lookup form redirects to that detail page. Credentials stay in the server process and never enter HTML or URLs.

## Shape

The app has one main domain interface:

```js
observer.listRecentTraces(window)
observer.getTrace(traceId)
```

`src/langfuse.js` hides Basic authentication, field selection, time bounds, pagination, response parsing, trace grouping, and tree repair behind those two calls. `src/server.js` owns HTTP routing and safe error pages. `src/views.js` owns escaped HTML. `src/trace-model.js` contains the pure grouping and tree decisions.

The recent view accepts only `1h`, `6h`, `24h`, or `7d`. Direct trace lookup uses a fixed 90-day range. Both calls reject repeated cursors and cap the rows they will load rather than presenting a partial result as complete.

## Synthesis decision

Two designs were compared. A server-rendered app became the base because it has no browser state or frontend build and its HTTP tests cover the visible pages. The rejected design used a local JSON API and static browser application. Its recent-window selector, direct lookup, and cursor-loop protection were folded into the server-rendered design. The JSON contract, request cancellation, and client-side navigation were dropped because full-page navigation is adequate for this focused tool.

## Tradeoffs

- The app accepts full-page refreshes in exchange for no client runtime.
- Recent browsing only includes traces with a logical root in the selected window. Direct lookup still finds a known trace ID.
- Direct lookup only searches 90 days in exchange for a bounded Langfuse query.
- The app targets Langfuse Cloud and self-hosted Langfuse v4 or newer. It does not keep a fallback for deprecated trace endpoints.
