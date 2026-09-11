import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ObserverError } from "./langfuse.js";
import { parseRecentWindow, parseSessionId, parseTraceId } from "./trace-model.js";
import {
  renderProblemPage,
  renderRecentPage,
  renderSessionPage,
  renderSessionsPage,
  renderTracePage,
} from "./views.js";

const STYLESHEET = await readFile(
  fileURLToPath(new URL("../public/styles.css", import.meta.url)),
  "utf8",
);

const SECURITY_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'; style-src 'self'; img-src 'self' data:; script-src 'none'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});

export function createRequestHandler({ observer, logger = console }) {
  return (request, response) => {
    handleRequest(request, response, observer).catch((error) => {
      logger.error?.("Langfuse Observer request failed", error);
      sendProblem(response, problemFor(error));
    });
  };
}

async function handleRequest(request, response, observer) {
  if (request.method !== "GET") {
    sendProblem(response, {
      status: 405,
      title: "Method not allowed",
      message: "This viewer only accepts read-only GET requests.",
    });
    return;
  }

  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/styles.css") {
    send(response, 200, "text/css; charset=utf-8", STYLESHEET);
    return;
  }
  if (url.pathname === "/favicon.ico") {
    send(response, 204, "image/x-icon", "");
    return;
  }
  if (url.pathname === "/") {
    await showRecent(response, observer, url);
    return;
  }
  if (url.pathname === "/sessions") {
    await showSessions(response, observer, url);
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
  if (sessionMatch) {
    await showSession(response, observer, url, sessionMatch[1]);
    return;
  }

  const match = url.pathname.match(/^\/traces\/([^/]+)$/u);
  if (match) {
    await showTrace(response, observer, url, match[1]);
    return;
  }

  sendProblem(response, {
    status: 404,
    title: "Page not found",
    message: "There is no trace view at this address.",
  });
}

async function showRecent(response, observer, url) {
  const window = parseRecentWindow(url.searchParams.get("window") ?? "24h");
  if (window === null) {
    sendProblem(response, {
      status: 400,
      title: "Invalid recent window",
      message: "Choose 1h, 6h, 24h, 7d, 30d, or 90d.",
    });
    return;
  }

  const result = await observer.listRecentTraces(window);
  sendHtml(response, 200, renderRecentPage(result));
}

async function showSessions(response, observer, url) {
  const window = parseRecentWindow(url.searchParams.get("window") ?? "24h");
  if (window === null) {
    sendProblem(response, {
      status: 400,
      title: "Invalid recent window",
      message: "Choose 1h, 6h, 24h, 7d, 30d, or 90d.",
    });
    return;
  }

  const result = await observer.listRecentSessions(window);
  sendHtml(response, 200, renderSessionsPage(result));
}

function redirectToTrace(response, url) {
  const traceId = parseTraceId(url.searchParams.get("traceId") ?? "");
  const window = parseRecentWindow(url.searchParams.get("window") ?? "24h") ?? "24h";
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

function redirectToSession(response, url) {
  const sessionId = parseSessionId(url.searchParams.get("sessionId") ?? "");
  const window = parseRecentWindow(url.searchParams.get("window") ?? "24h") ?? "24h";
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

async function showSession(response, observer, url, encodedSessionId) {
  const sessionId = decodeIdentifier(encodedSessionId, parseSessionId);
  const window = parseRecentWindow(url.searchParams.get("window") ?? "24h") ?? "24h";
  if (sessionId === null) {
    sendProblem(response, {
      status: 400,
      title: "Invalid session ID",
      message: "The session ID in this address is not valid.",
    });
    return;
  }

  const session = await observer.getSession(sessionId);
  if (session === null) {
    sendProblem(response, {
      status: 404,
      title: "Session not found",
      message: "Langfuse returned no observations for this session in the last 90 days.",
      detail: sessionId,
    });
    return;
  }

  sendHtml(response, 200, renderSessionPage(session, window));
}

async function showTrace(response, observer, url, encodedTraceId) {
  const traceId = decodeIdentifier(encodedTraceId, parseTraceId);
  const window = parseRecentWindow(url.searchParams.get("window") ?? "24h") ?? "24h";
  const sessionId = parseSessionId(url.searchParams.get("session") ?? "");
  if (traceId === null) {
    sendProblem(response, {
      status: 400,
      title: "Invalid trace ID",
      message: "The trace ID in this address is not valid.",
    });
    return;
  }

  const trace = await observer.getTrace(traceId);
  if (trace === null) {
    sendProblem(response, {
      status: 404,
      title: "Trace not found",
      message: "Langfuse returned no observations for this trace in the last 90 days.",
      detail: traceId,
    });
    return;
  }

  sendHtml(response, 200, renderTracePage(trace, window, sessionId));
}

function decodeIdentifier(encoded, parse) {
  try {
    return parse(decodeURIComponent(encoded));
  } catch {
    return null;
  }
}

function problemFor(error) {
  if (!(error instanceof ObserverError)) {
    return {
      status: 500,
      title: "Unexpected server error",
      message: "The local viewer could not complete this request.",
    };
  }

  const problems = {
    AUTH_FAILED: [502, "Credentials rejected", error.message, "Check LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY in .env."],
    RATE_LIMITED: [503, "Langfuse rate limit reached", error.message, "Wait a moment before refreshing."],
    TIMEOUT: [504, "Langfuse timed out", error.message, null],
    UNAVAILABLE: [502, "Langfuse unavailable", error.message, null],
    UNSUPPORTED_API: [502, "Langfuse API version mismatch", error.message, "Set LANGFUSE_API_VERSION=v3 for a self-hosted Langfuse v3 deployment."],
    UPSTREAM_ERROR: [502, "Langfuse request failed", error.message, null],
    INVALID_RESPONSE: [502, "Unexpected Langfuse response", error.message, null],
    RESULT_TOO_LARGE: [413, "Trace is too large", error.message, null],
  };
  const [status, title, message, detail] = problems[error.code] ?? [500, "Unexpected server error", "The local viewer could not complete this request.", null];
  return { status, title, message, detail };
}

function sendProblem(response, problem) {
  if (response.headersSent) {
    response.end();
    return;
  }
  sendHtml(response, problem.status, renderProblemPage(problem));
}

function sendHtml(response, status, body) {
  send(response, status, "text/html; charset=utf-8", body);
}

function send(response, status, contentType, body) {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": contentType,
  });
  response.end(body);
}
