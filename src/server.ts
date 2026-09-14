import { readFile } from "node:fs/promises";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { ObserverError } from "./langfuse.ts";
import { parseRecentTraceRequest } from "./recent-trace-filter-query.ts";
import { prepareRecentTracePage } from "./recent-trace-filters.ts";
import { parseRecentWindow, parseSessionId, parseTraceId } from "./trace-model.ts";
import {
  renderProblemPage,
  renderRecentPage,
  renderSessionPage,
  renderSessionsPage,
  renderTracePage,
} from "./views.ts";
import type { LangfuseObserver, ObserverContext, Problem, RecentWindow } from "./observer-types.ts";

const STYLESHEET = await readFile(
  fileURLToPath(new URL("../public/styles.css", import.meta.url)),
  "utf8",
);

const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'self'; style-src 'self'; img-src 'self' data:; script-src 'none'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});

export function createRequestHandler({
  observer,
  logger = console,
  requestTimeoutMs = 30_000,
}: Readonly<{
  observer: LangfuseObserver;
  logger?: Pick<Console, "error">;
  requestTimeoutMs?: number;
}>): RequestListener {
  return (request, response) => {
    const context = createRequestContext(request, response, requestTimeoutMs);
    handleRequest(request, response, observer, context).catch((error) => {
      if (
        error instanceof ObserverError &&
        error.code === "CANCELLED" &&
        context.signal?.aborted === true
      ) {
        return;
      }

      logger.error("Langfuse Observer request failed", error);
      sendProblem(response, problemFor(error));
    });
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  observer: LangfuseObserver,
  context: ObserverContext,
): Promise<void> {
  if (request.method !== "GET") {
    sendProblem(response, {
      status: 405,
      title: "Method not allowed",
      message: "This viewer only accepts read-only GET requests.",
    });

    return;
  }

  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (url.pathname === "/styles.css") {
    send(response, 200, "text/css; charset=utf-8", STYLESHEET);

    return;
  }

  if (url.pathname === "/favicon.ico") {
    send(response, 204, "image/x-icon", "");

    return;
  }

  if (url.pathname === "/") {
    await showRecent(response, observer, url, context);

    return;
  }

  if (url.pathname === "/sessions") {
    await showSessions(response, observer, url, context);

    return;
  }

  if (url.pathname === "/session-lookup") {
    redirectToSession(response, url);

    return;
  }

  if (url.pathname === "/lookup") {
    redirectToTrace(response, url);

    return;
  }

  const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)$/u);
  const encodedSessionId = sessionMatch?.[1];

  if (encodedSessionId) {
    await showSession(response, observer, url, encodedSessionId, context);

    return;
  }

  const match = url.pathname.match(/^\/traces\/([^/]+)$/u);
  const encodedTraceId = match?.[1];

  if (encodedTraceId) {
    await showTrace(response, observer, url, encodedTraceId, context);

    return;
  }

  sendProblem(response, {
    status: 404,
    title: "Page not found",
    message: "There is no trace view at this address.",
  });
}

async function showRecent(
  response: ServerResponse,
  observer: LangfuseObserver,
  url: URL,
  context: ObserverContext,
): Promise<void> {
  const parsed = parseRecentTraceRequest(url.searchParams);

  if (parsed.kind === "invalid") {
    sendProblem(response, {
      status: 400,
      title: "Invalid trace filter",
      message: parsed.message,
    });

    return;
  }

  const result = await observer.listRecentTraces(parsed.request.window, context);
  const prepared = prepareRecentTracePage(result, parsed.request.filters);

  if (prepared.kind === "unsupported") {
    sendProblem(response, {
      status: 400,
      title: "Unsupported trace filter",
      message: unsupportedTraceFilterMessage(prepared.fields),
    });

    return;
  }

  sendHtml(response, 200, renderRecentPage(prepared.page));
}

async function showSessions(
  response: ServerResponse,
  observer: LangfuseObserver,
  url: URL,
  context: ObserverContext,
): Promise<void> {
  const window = readRecentWindow(url);

  if (window === null) {
    sendInvalidWindow(response);

    return;
  }

  const result = await observer.listRecentSessions(window, context);
  sendHtml(response, 200, renderSessionsPage(result));
}

function redirectToTrace(response: ServerResponse, url: URL): void {
  const traceId = parseTraceId(url.searchParams.get("traceId") ?? "");
  const window = readRecentWindow(url);

  if (window === null) {
    sendInvalidWindow(response);

    return;
  }

  if (traceId === null) {
    sendProblem(response, {
      status: 400,
      title: "Invalid trace ID",
      message: "Enter a trace ID from 1 to 256 characters.",
    });

    return;
  }

  response.writeHead(303, {
    ...SECURITY_HEADERS,
    Location: `/traces/${encodeURIComponent(traceId)}?window=${encodeURIComponent(window)}`,
  });
  response.end();
}

function redirectToSession(response: ServerResponse, url: URL): void {
  const sessionId = parseSessionId(url.searchParams.get("sessionId") ?? "");
  const window = readRecentWindow(url);

  if (window === null) {
    sendInvalidWindow(response);

    return;
  }

  if (sessionId === null) {
    sendProblem(response, {
      status: 400,
      title: "Invalid session ID",
      message: "Enter a printable session ID from 1 to 200 characters.",
    });

    return;
  }

  response.writeHead(303, {
    ...SECURITY_HEADERS,
    Location: `/sessions/${encodeURIComponent(sessionId)}?window=${encodeURIComponent(window)}`,
  });
  response.end();
}

async function showSession(
  response: ServerResponse,
  observer: LangfuseObserver,
  url: URL,
  encodedSessionId: string,
  context: ObserverContext,
): Promise<void> {
  const sessionId = decodeIdentifier(encodedSessionId, parseSessionId);
  const window = readRecentWindow(url);

  if (window === null) {
    sendInvalidWindow(response);

    return;
  }

  if (sessionId === null) {
    sendProblem(response, {
      status: 400,
      title: "Invalid session ID",
      message: "The session ID in this address is not valid.",
    });

    return;
  }

  const session = await observer.getSession(sessionId, context);

  if (session === null) {
    sendProblem(response, {
      status: 404,
      title: "Session not found",
      message:
        "Langfuse returned no data for this session. V4 lookup is limited to the last 90 days.",
      detail: sessionId,
    });

    return;
  }

  sendHtml(response, 200, renderSessionPage(session, window));
}

async function showTrace(
  response: ServerResponse,
  observer: LangfuseObserver,
  url: URL,
  encodedTraceId: string,
  context: ObserverContext,
): Promise<void> {
  const traceId = decodeIdentifier(encodedTraceId, parseTraceId);
  const window = readRecentWindow(url);
  const sessionId = parseSessionId(url.searchParams.get("session") ?? "");

  if (window === null) {
    sendInvalidWindow(response);

    return;
  }

  if (traceId === null) {
    sendProblem(response, {
      status: 400,
      title: "Invalid trace ID",
      message: "The trace ID in this address is not valid.",
    });

    return;
  }

  const trace = await observer.getTrace(traceId, context);

  if (trace === null) {
    sendProblem(response, {
      status: 404,
      title: "Trace not found",
      message:
        "Langfuse returned no data for this trace. V4 lookup is limited to the last 90 days.",
      detail: traceId,
    });

    return;
  }

  const sourceSessionId = sessionId && trace.sessionIds.includes(sessionId) ? sessionId : null;
  sendHtml(response, 200, renderTracePage(trace, window, sourceSessionId));
}

function decodeIdentifier(encoded: string, parse: (value: string) => string | null): string | null {
  try {
    return parse(decodeURIComponent(encoded));
  } catch {
    return null;
  }
}

function readRecentWindow(url: URL): RecentWindow | null {
  const value = url.searchParams.get("window");

  return value === null ? "24h" : parseRecentWindow(value);
}

function sendInvalidWindow(response: ServerResponse): void {
  sendProblem(response, {
    status: 400,
    title: "Invalid recent window",
    message: "Choose 1h, 6h, 24h, 7d, 30d, or 90d.",
  });
}

function unsupportedTraceFilterMessage(
  fields: readonly ["level"] | readonly ["status"] | readonly ["level", "status"],
): string {
  if (fields.length === 2) {
    return "Highest level and run state filtering require the v4 observations API.";
  }

  return fields[0] === "level"
    ? "Highest level filtering requires the v4 observations API."
    : "Run state filtering requires the v4 observations API.";
}

function createRequestContext(
  request: IncomingMessage,
  response: ServerResponse,
  requestTimeoutMs: number,
): Readonly<ObserverContext> {
  const client = new AbortController();
  request.once("aborted", () => client.abort());
  response.once("close", () => {
    if (!response.writableEnded) {
      client.abort();
    }
  });

  return Object.freeze({
    signal: AbortSignal.any([client.signal, AbortSignal.timeout(requestTimeoutMs)]),
  });
}

function problemFor(cause: unknown): Problem {
  if (!(cause instanceof ObserverError)) {
    return {
      status: 500,
      title: "Unexpected server error",
      message: "The local viewer could not complete this request.",
    };
  }

  switch (cause.code) {
    case "AUTH_FAILED":
      return {
        status: 502,
        title: "Credentials rejected",
        message: cause.message,
        detail: "Check LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY in .env.",
      };
    case "RATE_LIMITED":
      return {
        status: 503,
        title: "Langfuse rate limit reached",
        message: cause.message,
        detail: retryAfterDetail(cause),
      };
    case "TIMEOUT":
      return { status: 504, title: "Langfuse timed out", message: cause.message };
    case "UNAVAILABLE":
      return { status: 502, title: "Langfuse unavailable", message: cause.message };
    case "UNSUPPORTED_API":
      return {
        status: 502,
        title: "Langfuse API version mismatch",
        message: cause.message,
        detail: "Set LANGFUSE_API_VERSION=v3 for a self-hosted Langfuse v3 deployment.",
      };
    case "UPSTREAM_ERROR":
      return { status: 502, title: "Langfuse request failed", message: cause.message };
    case "INVALID_RESPONSE":
      return { status: 502, title: "Unexpected Langfuse response", message: cause.message };
    case "RESULT_TOO_LARGE":
      return { status: 413, title: "Result is too large", message: cause.message };
    case "CANCELLED":
    case "NOT_FOUND":
      return {
        status: 500,
        title: "Unexpected server error",
        message: "The local viewer could not complete this request.",
      };
  }
}

function retryAfterDetail(error: ObserverError): string {
  if (error.retryAfterSeconds === null) {
    return "Wait a moment before refreshing.";
  }

  const unit = error.retryAfterSeconds === 1 ? "second" : "seconds";

  return `Try again in ${error.retryAfterSeconds} ${unit}.`;
}

function sendProblem(response: ServerResponse, problem: Problem): void {
  if (response.headersSent) {
    response.end();

    return;
  }

  sendHtml(response, problem.status, renderProblemPage(problem));
}

function sendHtml(response: ServerResponse, status: number, body: string): void {
  send(response, status, "text/html; charset=utf-8", body);
}

function send(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": contentType,
  });
  response.end(body);
}
