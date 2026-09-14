import type {
  CurrentRecentTrace,
  CurrentSessionSummary,
  CurrentSessionTrace,
  LegacyRecentTrace,
  LegacySessionSummary,
  LegacySessionTrace,
  Problem,
  RecentSessionsResult,
  RecentWindow,
  SessionDetail,
} from "./observer-types.ts";
import type { RecentTracePage } from "./recent-trace-filters.ts";
import { RECENT_WINDOWS } from "./trace-model.ts";
import { renderTraceFilterSidebar } from "./trace-filter-view.ts";
import {
  apiLabel,
  escapeAttribute,
  escapeHtml,
  formatDate,
  formatDuration,
  NUMBER_FORMATTER,
  relativeTime,
  renderLayout,
  renderQueryScope,
  renderStat,
  renderTopBar,
  renderWindowOptions,
} from "./view-helpers.ts";

export { renderTracePage } from "./trace-view.ts";

export function renderRecentPage(page: RecentTracePage): string {
  const windowLabel = RECENT_WINDOWS[page.window].label;
  const isLegacy = page.apiVersion === "v3";

  const traces =
    page.totalTraceCount === 0
      ? renderEmptyState(windowLabel, isLegacy)
      : page.traces.length === 0
        ? renderFilteredEmptyState(page.window)
        : `<ol class="trace-list" data-testid="trace-list">${page.traces.map((trace) => renderTraceCard(trace, page.window)).join("")}</ol>`;

  const countLabel =
    page.traces.length === page.totalTraceCount
      ? `${page.totalTraceCount} shown`
      : `${page.traces.length} of ${page.totalTraceCount} shown`;

  return renderLayout({
    title: "Recent traces",
    body: `
      <main class="page-shell">
        ${renderTopBar("traces", page.window)}
        <section class="trace-list-header">
          <div>
            <p class="eyebrow">Recent traces</p>
            <h1>Find the run you need.</h1>
            <p class="hero-copy">Filter the complete result returned for this time window.</p>
          </div>
          ${renderLookupForm(page.window)}
        </section>
        <section class="workspace trace-filter-workspace">
          ${renderTraceFilterSidebar(page)}
          <section class="trace-panel" aria-labelledby="recent-heading">
            <div class="panel-heading">
              <div>
                <p class="section-label">${isLegacy ? "Legacy trace records" : "Observation roots"}</p>
                <h2 id="recent-heading">Recent traces</h2>
              </div>
              <span class="count-pill">${escapeHtml(countLabel)}</span>
            </div>
            ${traces}
          </section>
        </section>
      </main>`,
  });
}

export function renderSessionsPage(result: RecentSessionsResult): string {
  const windowLabel = RECENT_WINDOWS[result.window].label;
  const isLegacy = result.apiVersion === "v3";

  const sessions =
    result.sessions.length === 0
      ? renderSessionEmptyState(windowLabel, isLegacy)
      : `<ol class="session-list" data-testid="session-list">${result.sessions.map((session) => renderSessionCard(session, result.window)).join("")}</ol>`;

  return renderLayout({
    title: "Recent sessions",
    body: `
      <main class="page-shell">
        ${renderTopBar("sessions", result.window)}
        <section class="hero compact-hero">
          <div>
            <p class="eyebrow">Multi-trace activity</p>
            <h1>Follow the whole session.</h1>
            <p class="hero-copy">Sessions group related traces without hiding the observations inside them.</p>
          </div>
          ${renderSessionLookupForm(result.window)}
        </section>
        <section class="workspace">
          <aside class="control-panel" aria-label="Session controls">
            <div>
              <p class="section-label">Recent window</p>
              <form class="window-form" method="get" action="/sessions">
                <label class="sr-only" for="session-window">Recent window</label>
                <select id="session-window" name="window">${renderWindowOptions(result.window)}</select>
                <button class="button secondary" type="submit">Refresh</button>
              </form>
            </div>
            <div class="connection-card">
              <span class="status-dot" aria-hidden="true"></span>
              <div>
                <strong>Langfuse connected</strong>
                <span>${escapeHtml(apiLabel(result.apiVersion))} · Checked ${escapeHtml(formatDate(result.queriedAt))}</span>
              </div>
            </div>
            <div class="tip-card">
              <p class="section-label">Complete results</p>
              <p>${
                isLegacy
                  ? "The viewer follows every Langfuse result page in this window."
                  : "The viewer follows every Langfuse cursor in this window before it groups sessions."
              }</p>
            </div>
          </aside>
          <section class="trace-panel" aria-labelledby="sessions-heading">
            <div class="panel-heading">
              <div>
                <p class="section-label">Shared session IDs</p>
                <h2 id="sessions-heading">Recent sessions</h2>
              </div>
              <span class="count-pill">${result.sessions.length} shown</span>
            </div>
            ${sessions}
          </section>
        </section>
      </main>`,
  });
}

export function renderSessionPage(session: SessionDetail, window: RecentWindow): string {
  const duration = formatDuration(Date.parse(session.latestAt) - Date.parse(session.startedAt));

  return renderLayout({
    title: session.id,
    body: `
      <main class="page-shell detail-shell">
        ${renderTopBar("sessions", window)}
        <nav class="breadcrumbs" aria-label="Breadcrumb">
          <a href="/sessions?window=${escapeAttribute(window)}">Recent sessions</a>
          <span aria-hidden="true">/</span>
          <span>Session detail</span>
        </nav>
        <section class="trace-hero">
          <div class="trace-heading">
            <div class="session-mark" aria-hidden="true"></div>
            <div>
              <p class="eyebrow">Session</p>
              <h1 class="session-title">${escapeHtml(session.id)}</h1>
              <p class="hero-copy">${
                session.apiVersion === "v3"
                  ? "Every trace returned by the v3 session endpoint."
                  : "Every trace discovered for this session during the last 90 days."
              }</p>
            </div>
          </div>
          <a class="button secondary" href="/sessions?window=${escapeAttribute(window)}">Back to sessions</a>
        </section>
        <dl class="stats-grid">
          ${renderStat("Started", formatDate(session.startedAt))}
          ${renderStat("Latest activity", formatDate(session.latestAt))}
          ${renderStat("Duration", duration)}
          ${renderStat("Traces", NUMBER_FORMATTER.format(session.traceCount))}
          ${renderStat("Observations", formatCount(session.observationCount))}
        </dl>
        ${renderQueryScope(session.queryScope)}
        <section class="observation-section" aria-labelledby="session-traces-heading">
          <div class="panel-heading">
            <div>
              <p class="section-label">Chronological replay</p>
              <h2 id="session-traces-heading">Traces in this session</h2>
            </div>
            <p class="tree-hint">Open a trace to inspect its complete parent tree and payloads.</p>
          </div>
          <ol class="session-trace-list">
            ${session.traces.map((trace, index) => renderSessionTrace(trace, session, window, index)).join("")}
          </ol>
        </section>
      </main>`,
  });
}

export function renderProblemPage({
  title,
  message,
  detail,
}: Pick<Problem, "title" | "message" | "detail">): string {
  return renderLayout({
    title,
    body: `
      <main class="page-shell problem-shell">
        ${renderTopBar()}
        <section class="problem-card" role="alert">
          <div class="problem-icon" aria-hidden="true">!</div>
          <p class="eyebrow">Could not load traces</p>
          <h1>${escapeHtml(title)}</h1>
          <p>${escapeHtml(message)}</p>
          ${detail ? `<p class="problem-detail">${escapeHtml(detail)}</p>` : ""}
          <div class="problem-actions">
            <a class="button primary" href="/">Try again</a>
            <a class="button secondary" href="/">Recent traces</a>
          </div>
        </section>
      </main>`,
  });
}

function renderLookupForm(window: RecentWindow): string {
  return `
    <form class="lookup-form" method="get" action="/lookup">
      <input type="hidden" name="window" value="${escapeAttribute(window)}">
      <label for="traceId">Open a trace by ID</label>
      <div class="lookup-row">
        <input id="traceId" name="traceId" type="text" maxlength="256" autocomplete="off" spellcheck="false" placeholder="Paste a trace ID" required>
        <button class="button primary" type="submit">Open trace</button>
      </div>
    </form>`;
}

function renderSessionLookupForm(window: RecentWindow): string {
  return `
    <form class="lookup-form" method="get" action="/session-lookup">
      <input type="hidden" name="window" value="${escapeAttribute(window)}">
      <label for="sessionId">Open a session by ID</label>
      <div class="lookup-row">
        <input id="sessionId" name="sessionId" type="text" maxlength="200" autocomplete="off" spellcheck="false" placeholder="Paste a session ID" required>
        <button class="button primary" type="submit">Open session</button>
      </div>
    </form>`;
}

function renderEmptyState(windowLabel: string, isLegacy: boolean): string {
  return `
    <div class="empty-state" data-testid="empty-state">
      <div class="empty-orbit" aria-hidden="true"><span></span></div>
      <h3>No traces in the last ${escapeHtml(windowLabel)}</h3>
      <p>The connection works. ${
        isLegacy
          ? "This Langfuse project has no trace records in the selected window."
          : "This Langfuse project has no logical root observations in the selected window."
      }</p>
    </div>`;
}

function renderFilteredEmptyState(window: RecentWindow): string {
  return `
    <div class="empty-state filter-empty-state" data-testid="filter-empty-state">
      <h3>No traces match these filters</h3>
      <p>Change a filter or <a href="/?window=${escapeAttribute(window)}">clear all filters</a>.</p>
    </div>`;
}

function renderSessionEmptyState(windowLabel: string, isLegacy: boolean): string {
  return `
    <div class="empty-state" data-testid="session-empty-state">
      <div class="empty-orbit session-orbit" aria-hidden="true"><span></span></div>
      <h3>No sessions in the last ${escapeHtml(windowLabel)}</h3>
      <p>The connection works. ${
        isLegacy
          ? "This Langfuse project has no sessions created in the selected window."
          : "No observations in this window carry a session ID."
      }</p>
    </div>`;
}

function renderSessionCard(
  session: CurrentSessionSummary | LegacySessionSummary,
  window: RecentWindow,
): string {
  const levelClass = session.highestLevel.toLowerCase();

  const tags = session.tags
    .slice(0, 3)
    .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
    .join("");

  const traceNote =
    session.traceCount === null
      ? "Open to view traces"
      : `${session.traceCount} ${session.traceCount === 1 ? "trace" : "traces"}`;

  const observationNote =
    session.observationCount === null
      ? "Counts available per trace"
      : `${session.observationCount} ${session.observationCount === 1 ? "observation" : "observations"}`;

  return `
    <li>
      <a class="session-card" href="/sessions/${encodeURIComponent(session.id)}?window=${escapeAttribute(window)}">
        <span class="session-card-mark ${escapeAttribute(levelClass)}" aria-hidden="true"></span>
        <span class="trace-card-main">
          <span class="session-card-kicker">Session</span>
          <span class="mono session-card-title">${escapeHtml(session.id)}</span>
          <span class="trace-tags">${tags}</span>
        </span>
        <span class="trace-card-meta">
          <span>${escapeHtml(relativeTime(session.latestAt))}</span>
          <span>${escapeHtml(traceNote)}</span>
          <span>${escapeHtml(observationNote)}</span>
        </span>
        <span class="arrow" aria-hidden="true">→</span>
      </a>
    </li>`;
}

function renderSessionTrace(
  trace: CurrentSessionTrace | LegacySessionTrace,
  session: SessionDetail,
  window: RecentWindow,
  index: number,
): string {
  const duration = formatDuration(Date.parse(trace.latestAt) - Date.parse(trace.startedAt));
  const href = `/traces/${encodeURIComponent(trace.id)}?window=${escapeAttribute(window)}&amp;session=${encodeURIComponent(session.id)}`;

  const observationNote =
    trace.observationCount === null
      ? "Open for observations"
      : `${trace.observationCount} ${trace.observationCount === 1 ? "observation" : "observations"}`;

  return `
    <li class="session-trace-item">
      <span class="session-trace-index">${index + 1}</span>
      <a class="session-trace-card" href="${href}">
        <span>
          <span class="session-trace-name">${escapeHtml(trace.name)}</span>
          <span class="mono trace-card-id">${escapeHtml(trace.id)}</span>
        </span>
        <span class="session-trace-meta">
          <span>${escapeHtml(formatDate(trace.startedAt))}</span>
          <span>${escapeHtml(duration)}</span>
          <span>${observationNote}</span>
          <span class="level-pill ${escapeAttribute(trace.highestLevel.toLowerCase())}">${escapeHtml(trace.highestLevel)}</span>
        </span>
        <span class="arrow" aria-hidden="true">→</span>
      </a>
    </li>`;
}

function renderTraceCard(
  trace: CurrentRecentTrace | LegacyRecentTrace,
  window: RecentWindow,
): string {
  const levelClass = trace.highestLevel?.toLowerCase() ?? "unknown";

  const tags = trace.tags
    .slice(0, 3)
    .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
    .join("");

  const rootNote =
    trace.rootCount === null
      ? "Legacy trace record"
      : trace.rootCount > 1
        ? `${trace.rootCount} logical roots`
        : "1 logical root";

  return `
    <li>
      <a class="trace-card" href="/traces/${encodeURIComponent(trace.id)}?window=${escapeAttribute(window)}">
        <span class="level-rail ${escapeAttribute(levelClass)}" aria-hidden="true"></span>
        <span class="trace-card-main">
          <span class="trace-card-title">${escapeHtml(trace.name)}</span>
          <span class="mono trace-card-id">${escapeHtml(trace.id)}</span>
          <span class="trace-tags">${tags}</span>
        </span>
        <span class="trace-card-meta">
          <span>${escapeHtml(relativeTime(trace.latestRootAt))}</span>
          <span>${escapeHtml(rootNote)}</span>
          ${trace.environment ? `<span>${escapeHtml(trace.environment)}</span>` : ""}
        </span>
        <span class="arrow" aria-hidden="true">→</span>
      </a>
    </li>`;
}

function formatCount(value: number | null): string {
  return value === null ? "Available per trace" : NUMBER_FORMATTER.format(value);
}
