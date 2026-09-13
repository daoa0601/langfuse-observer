import {
  type AgentPayloadSource,
  type AgentTurn,
  inspectAgentPayloads,
  type PayloadSourceRole,
} from "./agent-payloads.ts";
import { renderAgentSidebar, renderTurnBadges } from "./agent-sidebar.ts";
import { isJsonObject, isJsonString, parseJson } from "./json.ts";
import type {
  FullObservation,
  JsonValue,
  ObservationRelation,
  ObservationRow,
  RecentWindow,
  TraceContext,
  TraceDetail,
} from "./observer-types.ts";
import {
  escapeAttribute,
  escapeHtml,
  formatDate,
  formatDuration,
  NUMBER_FORMATTER,
  renderLayout,
  renderQueryScope,
  renderStat,
  renderTopBar,
} from "./view-helpers.ts";

const USD_FORMATTER = new Intl.NumberFormat("en", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 6,
});

export function renderTracePage(
  trace: TraceDetail,
  window: RecentWindow,
  sessionId: string | null = null,
): string {
  const totalTokens = sumPresent(trace.rows.map((row) => row.observation.usage["total"]));

  const observationCost = sumPresent(
    trace.rows.map((row) => row.observation.totalCost ?? row.observation.cost["total"]),
  );

  const totalCost =
    trace.apiVersion === "v3" ? (trace.totalCost ?? observationCost) : observationCost;

  const duration =
    trace.endedAt === null
      ? "In progress"
      : formatDuration(Date.parse(trace.endedAt) - Date.parse(trace.startedAt));

  const backHref = sessionId
    ? `/sessions/${encodeURIComponent(sessionId)}?window=${escapeAttribute(window)}`
    : `/?window=${escapeAttribute(window)}`;

  const backLabel = sessionId ? "Session" : "Recent traces";

  const sessionLinks = trace.sessionIds
    .map(
      (id) =>
        `<a class="session-link mono" href="/sessions/${encodeURIComponent(id)}?window=${escapeAttribute(window)}">Session ${escapeHtml(id)}</a>`,
    )
    .join("");

  const agent = inspectAgentPayloads(collectAgentPayloadSources(trace));
  const turnByObservationId = new Map(agent.turns.map((turn) => [turn.observationId, turn]));

  const hasAgentSidebar =
    agent.turns.length > 0 || agent.contextSources.length > 0 || agent.coverage === "partial";

  return renderLayout({
    title: trace.name,
    body: `
      <main class="page-shell detail-shell trace-page-shell">
        ${renderTopBar("traces", window)}
        <div class="trace-workspace${hasAgentSidebar ? "" : " no-agent-sidebar"}">
          <aside class="trace-summary-sidebar" aria-labelledby="trace-heading">
            <nav class="breadcrumbs trace-breadcrumbs" aria-label="Breadcrumb">
              <a href="${backHref}">${escapeHtml(backLabel)}</a>
              <span aria-hidden="true">/</span>
              <span>Trace</span>
            </nav>
            <section class="trace-summary">
              <p class="eyebrow">Trace</p>
              <h1 id="trace-heading">${escapeHtml(trace.name)}</h1>
              <p class="mono trace-id">${escapeHtml(trace.id)}</p>
              ${sessionLinks ? `<div class="trace-session-links">${sessionLinks}</div>` : ""}
            </section>
            <dl class="trace-stats">
              ${renderStat("Started", formatDate(trace.startedAt))}
              ${renderStat("Duration", duration)}
              ${renderStat("Observations", NUMBER_FORMATTER.format(trace.observationCount))}
              ${renderStat("Tokens", totalTokens === null ? "—" : NUMBER_FORMATTER.format(totalTokens))}
              ${renderStat("Cost", totalCost === null ? "—" : USD_FORMATTER.format(totalCost))}
            </dl>
            ${renderQueryScope(trace.queryScope)}
            <a class="trace-back-link" href="${backHref}">← Back to ${escapeHtml(backLabel.toLowerCase())}</a>
          </aside>
          <div class="trace-main-column">
            ${renderTraceContext(trace.apiVersion === "v3" ? trace.traceContext : null)}
          <section class="observation-section" aria-labelledby="observations-heading">
            <div class="panel-heading">
              <div>
                <p class="section-label">Physical parent tree</p>
                <h2 id="observations-heading">Observations</h2>
              </div>
              <p class="tree-hint">Open a row to inspect input, output, and metadata.</p>
            </div>
            <div class="observation-tree" data-testid="observation-tree">
              ${trace.rows
                .map((row, index) =>
                  renderObservation(
                    row,
                    `observation-${index + 1}`,
                    turnByObservationId.get(row.observation.id) ?? null,
                  ),
                )
                .join("")}
            </div>
          </section>
          </div>
          ${hasAgentSidebar ? renderAgentSidebar(agent, trace.rows) : ""}
        </div>
      </main>`,
  });
}

function renderObservation(row: ObservationRow, targetId: string, turn: AgentTurn | null): string {
  const observation = row.observation;
  const depth = Math.min(row.depth, 8);

  const duration =
    observation.endTime === null
      ? "In progress"
      : formatDuration(Date.parse(observation.endTime) - Date.parse(observation.startTime));

  const relation =
    row.relation === "child" || row.relation === "root"
      ? ""
      : `<span class="relation-warning">${escapeHtml(relationLabel(row.relation))}</span>`;

  const detailSections = [
    renderDataBlock("Input", observation.input),
    renderDataBlock("Output", observation.output),
    renderDataBlock("Metadata", observation.metadata),
    renderKeyValues(observation),
  ]
    .filter(Boolean)
    .join("");

  const turnClasses = turn === null ? "" : " agent-turn-observation";
  const turnBadges = turn === null ? "" : renderTurnBadges(turn);

  return `
    <details id="${escapeAttribute(targetId)}" class="observation depth-${depth} level-${escapeAttribute(observation.level.toLowerCase())}${turnClasses}">
      <summary>
        <span class="observation-node" aria-hidden="true"></span>
        <span class="observation-type">${escapeHtml(observation.type)}</span>
        <span class="observation-summary-main">
          <span class="observation-name">${escapeHtml(observation.name || "Unnamed observation")}</span>
          ${turnBadges}
        </span>
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

function collectAgentPayloadSources(trace: TraceDetail): AgentPayloadSource[] {
  const sources: AgentPayloadSource[] = trace.rows.map(({ observation }) => {
    const sourceRole = payloadSourceRole(observation.type);

    return {
      origin: {
        kind: "observation",
        observationId: observation.id,
        label: observation.name || observation.type,
        sourceRole,
        startedAt: observation.startTime,
        model: observation.model,
        allowStandaloneAssistantOutput: sourceRole === "model-turn",
      },
      input: observation.input,
      output: observation.output,
    };
  });

  if (trace.apiVersion === "v3") {
    sources.unshift({
      origin: { kind: "trace-context" },
      input: trace.traceContext.input,
      output: trace.traceContext.output,
    });
  }

  return sources;
}

function payloadSourceRole(type: string): PayloadSourceRole {
  switch (type.toUpperCase()) {
    case "GENERATION":
      return "model-turn";
    case "AGENT":
      return "agent-context";
    case "TOOL":
      return "tool-execution";
    default:
      return "other";
  }
}

function renderTraceContext(context: TraceContext | null): string {
  if (!context) {
    return "";
  }

  const fields = compactFields([
    context.userId ? detailField("User", context.userId) : null,
    context.environment ? detailField("Environment", context.environment) : null,
    context.release ? detailField("Release", context.release) : null,
    context.version ? detailField("Version", context.version) : null,
    context.tags.length > 0 ? detailField("Tags", context.tags.join(", ")) : null,
  ]);

  const details = [
    renderDataBlock("Input", context.input),
    renderDataBlock("Output", context.output),
    renderDataBlock("Metadata", context.metadata),
    fields.length > 0
      ? `
      <dl class="detail-grid">
        ${fields
          .map(
            ([label, value]) => `
          <div>
            <dt>${escapeHtml(label)}</dt>
            <dd>${escapeHtml(value)}</dd>
          </div>`,
          )
          .join("")}
      </dl>`
      : "",
  ]
    .filter(Boolean)
    .join("");

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

function renderDataBlock(label: string, value: JsonValue | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (
    (Array.isArray(value) && value.length === 0) ||
    (isJsonObject(value) && Object.keys(value).length === 0)
  ) {
    return "";
  }

  return `
    <section class="data-block">
      <h3>${escapeHtml(label)}</h3>
      <pre>${escapeHtml(prettyValue(value))}</pre>
    </section>`;
}

function renderKeyValues(observation: FullObservation): string {
  const values = compactFields([
    observation.promptName
      ? detailField(
          "Prompt",
          observation.promptVersion === null
            ? observation.promptName
            : `${observation.promptName} v${observation.promptVersion}`,
        )
      : null,
    observation.userId ? detailField("User", observation.userId) : null,
    observation.sessionId ? detailField("Session", observation.sessionId) : null,
    observation.latency !== null
      ? detailField("Latency", `${NUMBER_FORMATTER.format(observation.latency)}s`)
      : null,
    observation.timeToFirstToken !== null
      ? detailField("First token", `${NUMBER_FORMATTER.format(observation.timeToFirstToken)}s`)
      : null,
    Object.keys(observation.usage).length
      ? detailField("Usage", prettyValue(observation.usage))
      : null,
    Object.keys(observation.cost).length
      ? detailField("Cost", prettyValue(observation.cost))
      : null,
  ]);

  if (values.length === 0 && !hasKeys(observation.modelParameters)) {
    return "";
  }

  return `
    <dl class="detail-grid">
      ${values
        .map(
          ([label, value]) => `
        <div>
          <dt>${escapeHtml(label)}</dt>
          <dd>${escapeHtml(value)}</dd>
        </div>`,
        )
        .join("")}
      ${
        hasKeys(observation.modelParameters)
          ? `
        <div>
          <dt>Model parameters</dt>
          <dd><pre>${escapeHtml(prettyValue(observation.modelParameters))}</pre></dd>
        </div>`
          : ""
      }
    </dl>`;
}

function sumPresent(values: readonly (number | null | undefined)[]): number | null {
  const numbers: number[] = [];

  for (const value of values) {
    if (value !== null && value !== undefined) {
      numbers.push(value);
    }
  }

  return numbers.length === 0 ? null : numbers.reduce((sum, value) => sum + value, 0);
}

function prettyValue(value: JsonValue): string {
  if (!isJsonString(value)) {
    return JSON.stringify(value, null, 2) ?? "null";
  }

  const parsed = parseJson(value);

  if (parsed.kind === "invalid") {
    return value;
  }

  if (isJsonString(parsed.value)) {
    return parsed.value;
  }

  return JSON.stringify(parsed.value, null, 2) ?? value;
}

function relationLabel(relation: Exclude<ObservationRelation, "child" | "root">): string {
  return relation === "missing-parent" ? "Parent missing" : "Cycle broken";
}

function hasKeys(value: JsonValue): boolean {
  return Array.isArray(value)
    ? value.length > 0
    : isJsonObject(value) && Object.keys(value).length > 0;
}

function detailField(label: string, value: string): readonly [string, string] {
  return [label, value];
}

function compactFields(
  fields: readonly (readonly [string, string] | null)[],
): Array<readonly [string, string]> {
  const present: Array<readonly [string, string]> = [];

  for (const field of fields) {
    if (field !== null) {
      present.push(field);
    }
  }

  return present;
}
