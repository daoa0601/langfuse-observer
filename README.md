# Langfuse Observer

A tiny local viewer for Langfuse traces. It calls the current Observations API v2 with the credentials in `.env`, groups recent root observations into traces, and renders one trace as a parent-child tree.

There is no Langfuse CLI, SDK, frontend framework, build step, or database. The server uses Node's built-in HTTP client. Your Langfuse secret stays in the local server process.

## Run it

Requirements: Node.js 20.6 or newer and a Langfuse Cloud project or self-hosted Langfuse v4 or newer.

```sh
cp .env.example .env
```

Fill in the three values:

```dotenv
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com
```

Then start the viewer:

```sh
npm start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000).

## What it shows

- Recent traces from the last 1 hour, 6 hours, 24 hours, or 7 days
- Direct lookup for a known trace ID within the last 90 days
- Physical parent-child order using `parentObservationId`
- Input, output, metadata, model, token usage, cost, and timing for each observation
- Clear empty, authentication, rate-limit, timeout, and malformed-response pages

The recent list asks Langfuse for logical root observations. A distributed trace with no logical root in this project may not appear there, but direct lookup still works when you know its ID.

## Test it

```sh
npm test
```

The tests run the real viewer against a local fake Langfuse HTTP server. They exercise the public pages, Basic authentication, time bounds, pagination, tree order, HTML escaping, redirects, and empty states.

## API choice

Langfuse deprecated `GET /api/public/traces`. This app uses `GET /api/public/v2/observations`, which returns observations that the viewer groups by `traceId`. See the [Observations API documentation](https://langfuse.com/docs/api-and-data-platform/features/observations-api) and [Public API authentication](https://langfuse.com/docs/api-and-data-platform/features/public-api).
