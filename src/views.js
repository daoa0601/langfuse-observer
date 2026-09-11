import { RECENT_WINDOWS } from "./trace-model.js";

const DATE_FORMATTER = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "medium",
});

const NUMBER_FORMATTER = new Intl.NumberFormat("en", {
  maximumFractionDigits: 2,
});

const USD_FORMATTER = new Intl.NumberFormat("en", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 6,
});

export function renderRecentPage(result) {
  const windowLabel = RECENT_WINDOWS[result.window].label;
  const isLegacy = result.apiVersion === "v3";
  const traces = result.traces.length === 0
    ? renderEmptyState(windowLabel, isLegacy)
    : `<ol class="trace-list" data-testid="trace-list">${result.traces.map((trace) => renderTraceCard(trace, result.window)).join("")}</ol>`;

  return renderLayout({
    title: "Recent traces",
    body: `
      <main class="page-shell">
        ${renderTopBar("traces")}
        <section class="hero compact-hero">
          <div>
            <p class="eyebrow">Read-only local viewer</p>
            <h1>See what your agent did.</h1>
            <p class="hero-copy">Trace data comes straight from Langfuse. Your credentials stay in this process.</p>
          </div>
          ${renderLookupForm(result.window)}
        </section>
        <section class="workspace">
          <aside class="control-panel" aria-label="Trace controls">
            <div>
              <p class="section-label">Recent window</p>
              <form class="window-form" method="get" action="/">
                <label class="sr-only" for="window">Recent window</label>
                <select id="window" name="window">${renderWindowOptions(result.window)}</select>
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
              <p class="section-label">Known trace?</p>
              <p>${isLegacy
                ? "Paste its ID above. The v3 API retrieves that trace directly."
                : "Paste its ID above. Direct lookup searches the last 90 days, even when the trace is outside this window."}</p>
            </div>
          </aside>
          <section class="trace-panel" aria-labelledby="recent-heading">
            <div class="panel-heading">
              <div>
                <p class="section-label">${isLegacy ? "Legacy trace records" : "Observation roots"}</p>
                <h2 id="recent-heading">Recent traces</h2>
              </div>
              <span class="count-pill">${result.traces.length} shown</span>
            </div>
            ${traces}
          </section>
        </section>
      </main>`,
  });
}

export function renderSessionsPage(result) {
  const windowLabel = RECENT_WINDOWS[result.window].label;
  const isLegacy = result.apiVersion === "v3";
  const sessions = result.sessions.length === 0
    ? renderSessionEmptyState(windowLabel, isLegacy)
    : `<ol class="session-list" data-testid="session-list">${result.sessions.map((session) => renderSessionCard(session, result.window)).join("")}</ol>`;

  return renderLayout({
    title: "Recent sessions",
    body: `
      <main class="page-shell">
        ${renderTopBar("sessions")}
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
              <p>${isLegacy
                ? "The viewer follows every Langfuse result page in this window."
                : "The viewer follows every Langfuse cursor in this window before it groups sessions."}</p>
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

export function renderSessionPage(session, window) {
  const duration = formatDuration(Date.parse(session.latestAt) - Date.parse(session.startedAt));

  return renderLayout({
    title: session.id,
    body: `
      <main class="page-shell detail-shell">
        ${renderTopBar("sessions")}
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
              <p class="hero-copy">${session.apiVersion === "v3"
                ? "Every trace returned by the v3 session endpoint."
                : "Every trace discovered for this session during the last 90 days."}</p>
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

export function renderTracePage(trace, window, sessionId = null) {
  const totalTokens = trace.rows.reduce(
    (sum, row) => sum + (row.observation.usage.total ?? 0),
    0,
  );
  const observationCost = trace.rows.reduce(
    (sum, row) => sum + (row.observation.totalCost ?? row.observation.cost.total ?? 0),
    0,
  );
  const totalCost = trace.totalCost ?? observationCost;
  const duration = trace.endedAt === null
    ? "In progress"
    : formatDuration(Date.parse(trace.endedAt) - Date.parse(trace.startedAt));
  const backHref = sessionId
    ? `/sessions/${encodeURIComponent(sessionId)}?window=${escapeAttribute(window)}`
    : `/?window=${escapeAttribute(window)}`;
  const backLabel = sessionId ? "Session" : "Recent traces";
  const sessionLinks = trace.sessionIds.map((id) =>
    `<a class="session-link mono" href="/sessions/${encodeURIComponent(id)}?window=${escapeAttribute(window)}">Session ${escapeHtml(id)}</a>`,
  ).join("");

  return renderLayout({
    title: trace.name,
    body: `
      <main class="page-shell detail-shell">
        ${renderTopBar("traces")}
        <nav class="breadcrumbs" aria-label="Breadcrumb">
          <a href="${backHref}">${escapeHtml(backLabel)}</a>
          <span aria-hidden="true">/</span>
          <span>Trace detail</span>
        </nav>
        <section class="trace-hero">
          <div class="trace-heading">
            <div class="trace-mark" aria-hidden="true"></div>
            <div>
              <p class="eyebrow">Trace</p>
              <h1>${escapeHtml(trace.name)}</h1>
              <p class="mono trace-id">${escapeHtml(trace.id)}</p>
              ${sessionLinks}
            </div>
          </div>
          <a class="button secondary" href="${backHref}">Back to ${escapeHtml(backLabel.toLowerCase())}</a>
        </section>
        <dl class="stats-grid">
          ${renderStat("Started", formatDate(trace.startedAt))}
          ${renderStat("Duration", duration)}
          ${renderStat("Observations", NUMBER_FORMATTER.format(trace.observationCount))}
          ${renderStat("Tokens", totalTokens ? NUMBER_FORMATTER.format(totalTokens) : "—")}
          ${renderStat("Cost", totalCost ? USD_FORMATTER.format(totalCost) : "—")}
        </dl>
        ${renderTraceContext(trace.traceContext)}
        <section class="observation-section" aria-labelledby="observations-heading">
          <div class="panel-heading">
            <div>
              <p class="section-label">Physical parent tree</p>
              <h2 id="observations-heading">Observations</h2>
            </div>
            <p class="tree-hint">Open a row to inspect input, output, and metadata.</p>
          </div>
          <div class="observation-tree" data-testid="observation-tree">
            ${trace.rows.map(renderObservation).join("")}
          </div>
        </section>
      </main>`,
  });
}

export function renderProblemPage({ title, message, detail = null }) {
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

function renderTopBar(active = null) {
  return `
    <header class="topbar">
      <a class="brand" href="/" aria-label="Langfuse Observer home">
        <span class="brand-symbol" aria-hidden="true"><i></i><i></i><i></i></span>
        <span>Langfuse <strong>Observer</strong></span>
      </a>
      <nav class="topbar-nav" aria-label="Primary">
        <a${active === "traces" ? ' aria-current="page"' : ""} href="/">Traces</a>
        <a${active === "sessions" ? ' aria-current="page"' : ""} href="/sessions">Sessions</a>
      </nav>
      <span class="read-only-badge">Read only</span>
    </header>`;
}

function renderLookupForm(window) {
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

function renderSessionLookupForm(window) {
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

function renderWindowOptions(selectedWindow) {
  return Object.entries(RECENT_WINDOWS)
    .map(([value, definition]) => {
      const selected = value === selectedWindow ? " selected" : "";
      return `<option value="${escapeAttribute(value)}"${selected}>Last ${escapeHtml(definition.label)}</option>`;
    })
    .join("");
}

function renderEmptyState(windowLabel, isLegacy) {
  return `
    <div class="empty-state" data-testid="empty-state">
      <div class="empty-orbit" aria-hidden="true"><span></span></div>
      <h3>No traces in the last ${escapeHtml(windowLabel)}</h3>
      <p>The connection works. ${isLegacy
        ? "This Langfuse project has no trace records in the selected window."
        : "This Langfuse project has no logical root observations in the selected window."}</p>
    </div>`;
}

function renderSessionEmptyState(windowLabel, isLegacy) {
  return `
    <div class="empty-state" data-testid="session-empty-state">
      <div class="empty-orbit session-orbit" aria-hidden="true"><span></span></div>
      <h3>No sessions in the last ${escapeHtml(windowLabel)}</h3>
      <p>The connection works. ${isLegacy
        ? "This Langfuse project has no sessions created in the selected window."
        : "No observations in this window carry a session ID."}</p>
    </div>`;
}

function renderSessionCard(session, window) {
  const levelClass = session.highestLevel.toLowerCase();
  const tags = session.tags.slice(0, 3).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("");
  const traceNote = session.traceCount === null
    ? "Open to view traces"
    : `${session.traceCount} ${session.traceCount === 1 ? "trace" : "traces"}`;
  const observationNote = session.observationCount === null
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

function renderSessionTrace(trace, session, window, index) {
  const duration = formatDuration(Date.parse(trace.latestAt) - Date.parse(trace.startedAt));
  const href = `/traces/${encodeURIComponent(trace.id)}?window=${escapeAttribute(window)}&amp;session=${encodeURIComponent(session.id)}`;

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
          <span>${trace.observationCount === null ? "Open for observations" : `${trace.observationCount} observations`}</span>
          <span class="level-pill ${escapeAttribute(trace.highestLevel.toLowerCase())}">${escapeHtml(trace.highestLevel)}</span>
        </span>
        <span class="arrow" aria-hidden="true">→</span>
      </a>
    </li>`;
}

function renderTraceCard(trace, window) {
  const levelClass = trace.highestLevel.toLowerCase();
  const tags = trace.tags.slice(0, 3).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("");
  const rootNote = trace.rootCount === null
    ? "Legacy trace record"
    : trace.rootCount > 1 ? `${trace.rootCount} logical roots` : "1 logical root";

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

function renderObservation(row) {
  const observation = row.observation;
  const depth = Math.min(row.depth, 8);
  const duration = observation.endTime === null
    ? "In progress"
    : formatDuration(Date.parse(observation.endTime) - Date.parse(observation.startTime));
  const relation = row.relation === "child" || row.relation === "root"
    ? ""
    : `<span class="relation-warning">${escapeHtml(relationLabel(row.relation))}</span>`;
  const detailSections = [
    renderDataBlock("Input", observation.input),
    renderDataBlock("Output", observation.output),
    renderDataBlock("Metadata", observation.metadata),
    renderKeyValues(observation),
  ].filter(Boolean).join("");

  return `
    <details class="observation depth-${depth} level-${escapeAttribute(observation.level.toLowerCase())}"${depth === 0 ? " open" : ""}>
      <summary>
        <span class="observation-node" aria-hidden="true"></span>
        <span class="observation-type">${escapeHtml(observation.type)}</span>
        <span class="observation-name">${escapeHtml(observation.name || "Unnamed observation")}</span>
        ${relation}
        ${observation.model ? `<span class="model-pill">${escapeHtml(observation.model)}</span>` : ""}
        <span class="observation-time">${escapeHtml(duration)}</span>
        <span class="level-pill ${escapeAttribute(observation.level.toLowerCase())}">${escapeHtml(observation.level)}</span>
      </summary>
      <div class="observation-body">
        <div class="observation-identifiers">
          <span>Started ${escapeHtml(formatDate(observation.startTime))}</span>
          <span class="mono">${escapeHtml(observation.id)}</span>
          ${observation.statusMessage ? `<span class="status-message">${escapeHtml(observation.statusMessage)}</span>` : ""}
        </div>
        ${detailSections || `<p class="muted">No additional fields for this observation.</p>`}
      </div>
    </details>`;
}

function renderTraceContext(context) {
  if (!context) {
    return "";
  }

  const fields = [
    context.userId ? ["User", context.userId] : null,
    context.environment ? ["Environment", context.environment] : null,
    context.release ? ["Release", context.release] : null,
    context.version ? ["Version", context.version] : null,
    context.tags.length > 0 ? ["Tags", context.tags.join(", ")] : null,
  ].filter(Boolean);
  const details = [
    renderDataBlock("Input", context.input),
    renderDataBlock("Output", context.output),
    renderDataBlock("Metadata", context.metadata),
    fields.length > 0 ? `
      <dl class="detail-grid">
        ${fields.map(([label, value]) => `
          <div>
            <dt>${escapeHtml(label)}</dt>
            <dd>${escapeHtml(value)}</dd>
          </div>`).join("")}
      </dl>` : "",
  ].filter(Boolean).join("");

  if (!details) {
    return "";
  }

  return `
    <section class="observation-section trace-context" aria-labelledby="trace-context-heading">
      <div class="panel-heading">
        <div>
          <p class="section-label">Legacy trace fields</p>
          <h2 id="trace-context-heading">Trace input and output</h2>
        </div>
      </div>
      ${details}
    </section>`;
}

function renderDataBlock(label, value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object" && Object.keys(value).length === 0) {
    return "";
  }

  return `
    <section class="data-block">
      <h3>${escapeHtml(label)}</h3>
      <pre>${escapeHtml(prettyValue(value))}</pre>
    </section>`;
}

function renderKeyValues(observation) {
  const values = [
    observation.promptName ? ["Prompt", observation.promptVersion === null ? observation.promptName : `${observation.promptName} v${observation.promptVersion}`] : null,
    observation.userId ? ["User", observation.userId] : null,
    observation.sessionId ? ["Session", observation.sessionId] : null,
    observation.latency !== null ? ["Latency", `${NUMBER_FORMATTER.format(observation.latency)}s`] : null,
    observation.timeToFirstToken !== null ? ["First token", `${NUMBER_FORMATTER.format(observation.timeToFirstToken)}s`] : null,
    Object.keys(observation.usage).length ? ["Usage", prettyValue(observation.usage)] : null,
    Object.keys(observation.cost).length ? ["Cost", prettyValue(observation.cost)] : null,
  ].filter(Boolean);

  if (values.length === 0 && Object.keys(observation.modelParameters).length === 0) {
    return "";
  }

  return `
    <section class="detail-grid">
      ${values.map(([label, value]) => `
        <div>
          <dt>${escapeHtml(label)}</dt>
          <dd>${escapeHtml(value)}</dd>
        </div>`).join("")}
      ${Object.keys(observation.modelParameters).length ? `
        <div>
          <dt>Model parameters</dt>
          <dd><pre>${escapeHtml(prettyValue(observation.modelParameters))}</pre></dd>
        </div>` : ""}
    </section>`;
}

function renderStat(label, value) {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function formatCount(value) {
  return value === null ? "Available per trace" : NUMBER_FORMATTER.format(value);
}

function apiLabel(version) {
  return version === "v3" ? "Self-hosted v3 API" : "v4 Observations API";
}

function renderLayout({ title, body }) {
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

function prettyValue(value) {
  if (typeof value !== "string") {
    return JSON.stringify(value, null, 2);
  }
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2);
  } catch {
    return value;
  }
}

function relationLabel(relation) {
  return relation === "missing-parent" ? "Parent missing" : "Cycle broken";
}

function formatDate(value) {
  return DATE_FORMATTER.format(new Date(value));
}

function relativeTime(value) {
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

function formatDuration(milliseconds) {
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}
