# Langfuse Observer

A tiny local viewer for Langfuse traces and sessions. It supports Langfuse Cloud, self-hosted Langfuse v4, and self-hosted Langfuse v3. The viewer selects the available read API, fetches data with the credentials in `.env`, and renders each trace as a parent-child tree.

There is no Langfuse CLI, SDK, frontend framework, build step, or database. The server uses Node's built-in HTTP client. Your Langfuse secret stays in the local server process.

## Run it

Requirements: Node.js 20.6 or newer and a Langfuse Cloud or self-hosted project.

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

Then start the viewer:

```sh
npm start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000).

`LANGFUSE_API_VERSION=auto` tries the v4 Observations API first. If that endpoint does not exist, the process switches to the v3 legacy read API and keeps that choice until restart. Set the value to `v3` or `v4` to skip automatic selection.

## What it shows

- Recent traces and sessions from the last 1 hour, 6 hours, 24 hours, 7 days, 30 days, or 90 days
- Direct lookup for a known trace ID. V4 searches the last 90 days, while v3 retrieves the trace by ID.
- Direct lookup for a known session ID. V4 searches the last 90 days, while v3 returns the complete legacy session record.
- Physical parent-child order using `parentObservationId`
- Input, output, metadata, model, token usage, cost, and timing for each observation
- Clear empty, authentication, rate-limit, timeout, and malformed-response pages
- Trace-level input, output, and metadata returned by the v3 trace API

On v4, the recent trace list asks Langfuse for logical root observations. A distributed trace with no logical root in this project may not appear there, but direct lookup still works when you know its ID. The session list follows every cursor in the selected window before it groups rows by `sessionId` and `traceId`.

On v3, the viewer follows the page-number pagination returned by the legacy trace and session endpoints. The v3 session list does not include trace or observation counts. Open a session to list its traces, then open a trace to load every observation and payload.

## Test it

```sh
npm test
```

The tests run the real viewer against local fake v3 and v4 Langfuse HTTP servers. They exercise API selection, trace and session pages, Basic authentication, time bounds, both pagination styles, grouping, tree order, HTML escaping, redirects, and empty states.

## API choice

Langfuse v4 uses `GET /api/public/v2/observations`. The viewer groups those observation rows by `traceId` and `sessionId`.

Self-hosted Langfuse v3 uses the legacy `GET /api/public/traces` and `GET /api/public/sessions` endpoints. Langfuse v4 removed those endpoints, so the viewer keeps the two adapters separate. See the [Langfuse compatibility matrix](https://langfuse.com/docs/compatibility), [Observations API documentation](https://langfuse.com/docs/api-and-data-platform/features/observations-api), [deprecated API migration guide](https://langfuse.com/faq/all/deprecated-api-migration), and [Public API authentication](https://langfuse.com/docs/api-and-data-platform/features/public-api).
