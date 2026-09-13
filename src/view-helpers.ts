import type { QueryScope, RecentWindow } from "./observer-types.ts";

const DATE_FORMATTER = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "medium",
});

export const NUMBER_FORMATTER = new Intl.NumberFormat("en", {
  maximumFractionDigits: 2,
});

export function renderTopBar(
  active: "traces" | "sessions" | null = null,
  window: RecentWindow | null = null,
): string {
  const windowQuery = window === null ? "" : `?window=${escapeAttribute(window)}`;

  return `
    <header class="topbar">
      <a class="brand" href="/${windowQuery}" aria-label="Langfuse Observer home">
        <span class="brand-symbol" aria-hidden="true"><i></i><i></i><i></i></span>
        <span>Langfuse <strong>Observer</strong></span>
      </a>
      <nav class="topbar-nav" aria-label="Primary">
        <a${active === "traces" ? ' aria-current="page"' : ""} href="/${windowQuery}">Traces</a>
        <a${active === "sessions" ? ' aria-current="page"' : ""} href="/sessions${windowQuery}">Sessions</a>
      </nav>
      <span class="read-only-badge">Read only</span>
    </header>`;
}

export function renderQueryScope(scope: QueryScope): string {
  if (scope.kind === "complete") {
    return "";
  }

  return `
    <aside class="scope-notice" aria-label="Data range">
      <strong>Bounded v4 result.</strong>
      This detail is limited to observations started between
      <time datetime="${escapeAttribute(scope.from)}">${escapeHtml(formatDate(scope.from))}</time>
      and
      <time datetime="${escapeAttribute(scope.to)}">${escapeHtml(formatDate(scope.to))}</time>.
      Totals and parent relationships may be partial when activity falls outside that range.
    </aside>`;
}

export function renderStat(label: string, value: string): string {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

export function renderLayout({ title, body }: Readonly<{ title: string; body: string }>): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <title>${escapeHtml(title)} · Langfuse Observer</title>
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body>
    ${body}
  </body>
</html>`;
}

export function formatDate(value: string): string {
  return DATE_FORMATTER.format(new Date(value));
}

export function relativeTime(value: string): string {
  const difference = Date.now() - Date.parse(value);

  if (difference < 60_000) {
    return "Just now";
  }

  if (difference < 60 * 60_000) {
    return `${Math.floor(difference / 60_000)}m ago`;
  }

  if (difference < 24 * 60 * 60_000) {
    return `${Math.floor(difference / (60 * 60_000))}h ago`;
  }

  return formatDate(value);
}

export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return "—";
  }

  if (milliseconds < 1_000) {
    return `${Math.round(milliseconds)}ms`;
  }

  if (milliseconds < 60_000) {
    return `${NUMBER_FORMATTER.format(milliseconds / 1_000)}s`;
  }

  return `${NUMBER_FORMATTER.format(milliseconds / 60_000)}m`;
}

export function escapeHtml(value: string | number): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function escapeAttribute(value: string | number): string {
  return escapeHtml(value);
}
