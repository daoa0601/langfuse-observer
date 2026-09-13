import {
  isPromptMessage,
  type AgentMessage,
  type AgentPayloadReport,
  type AgentTurn,
  type ContentPart,
  type ExtractionIssue,
  type FieldAnalysis,
  type PromptOccurrence,
  type SourceAnalysis,
  type TextExcerpt,
  type ToolDeclaration,
} from "./agent-payloads.ts";
import type { ObservationRow } from "./observer-types.ts";
import { escapeHtml, NUMBER_FORMATTER } from "./view-helpers.ts";

export function renderAgentSidebar(
  agent: AgentPayloadReport,
  rows: readonly ObservationRow[],
): string {
  const targetByObservationId = new Map(
    rows.map((row, index) => [row.observation.id, `observation-${index + 1}`]),
  );

  const turns = agent.turns
    .map((turn) =>
      renderAgentTurn(
        turn,
        targetByObservationId.get(turn.observationId) ?? "observations-heading",
      ),
    )
    .join("");

  return `
    <aside class="agent-sidebar" aria-labelledby="agent-context-heading">
      <div class="agent-sidebar-card">
        <div class="agent-sidebar-heading">
          <div>
            <p class="section-label">Parsed payloads</p>
            <h2 id="agent-context-heading">Agent context</h2>
          </div>
          <span class="parser-coverage ${escapeHtml(agent.coverage)}">${escapeHtml(agent.coverage)}</span>
        </div>
        <p class="agent-sidebar-intro">Prompts, available tools, and replies grouped by model turn.</p>
        <div class="agent-turn-list">
          ${turns}
          ${renderOtherAgentContext(agent.contextSources)}
          ${renderParserNotes(agent)}
        </div>
      </div>
    </aside>`;
}

export function renderTurnBadges(turn: AgentTurn): string {
  const badges = [`Turn ${turn.number}`];

  if (turn.kind === "unrecognized") {
    badges.push("Payload unparsed");
  } else {
    if (turn.prompts.some((prompt) => prompt.role === "system")) {
      badges.push("System context");
    }

    if (turn.prompts.some((prompt) => prompt.role === "developer")) {
      badges.push("Developer context");
    }

    if (turn.inputContext.some((message) => message.role === "user")) {
      badges.push("User context");
    }

    if (turn.inputContext.some((message) => message.role === "assistant")) {
      badges.push("Assistant history");
    }

    if (turn.replies.length > 0) {
      badges.push("Assistant reply");
    }

    if (turn.tools.length > 0) {
      badges.push(`${turn.tools.length} ${turn.tools.length === 1 ? "tool" : "tools"}`);
    }

    if (turnContainsPart(turn, "tool-call")) {
      badges.push("Tool call");
    }

    if (turnContainsPart(turn, "tool-result")) {
      badges.push("Tool result");
    }

    if (turn.kind === "partial") {
      badges.push("Partial parse");
    }
  }

  return `<span class="turn-badges">${badges
    .map(
      (badge, index) =>
        `<span class="turn-badge${index === 0 ? " primary" : ""}">${escapeHtml(badge)}</span>`,
    )
    .join("")}</span>`;
}

function renderAgentTurn(turn: AgentTurn, targetId: string): string {
  const model = turn.model ?? "Model not recorded";
  const partialClass = turn.kind === "partial" ? " partial" : "";

  const body =
    turn.kind === "unrecognized"
      ? `<p class="agent-empty">${escapeHtml(unrecognizedTurnMessage(turn.reason))}</p>`
      : [
          renderPromptGroup(turn.prompts),
          renderToolGroup(turn.tools),
          renderMessageGroup("Input context", turn.inputContext),
          renderMessageGroup("Reply and tool calls", turn.replies),
          turn.kind === "partial" ? renderIssueList(turn.issues) : "",
        ].join("");

  return `
    <details class="agent-turn${partialClass}"${turn.number === 1 ? " open" : ""}>
      <summary>
        <span class="agent-turn-title">Turn ${turn.number}</span>
        <span class="agent-turn-model">${escapeHtml(model)}</span>
      </summary>
      <div class="agent-turn-body">
        <a class="agent-jump" href="#${escapeHtml(targetId)}">Show observation</a>
        ${body}
      </div>
    </details>`;
}

function turnContainsPart(
  turn: Exclude<AgentTurn, { kind: "unrecognized" }>,
  kind: ContentPart["kind"],
): boolean {
  return [...turn.inputContext, ...turn.replies].some((message) =>
    message.parts.some((part) => part.kind === kind),
  );
}

function renderPromptGroup(prompts: readonly PromptOccurrence[]): string {
  if (prompts.length === 0) {
    return "";
  }

  return `
    <details class="agent-subsection" open>
      <summary>System prompt${prompts.length === 1 ? "" : `s (${prompts.length})`}</summary>
      <div class="agent-subsection-body">
        ${prompts
          .map(
            (prompt) => `
          <section class="agent-message">
            <p class="agent-message-role">${escapeHtml(prompt.role)}</p>
            ${renderContentParts(prompt.parts)}
          </section>`,
          )
          .join("")}
      </div>
    </details>`;
}

function renderToolGroup(tools: readonly ToolDeclaration[]): string {
  if (tools.length === 0) {
    return "";
  }

  return `
    <details class="agent-subsection">
      <summary>Tools (${tools.length})</summary>
      <div class="agent-subsection-body">
        ${tools
          .map(
            (tool) => `
          <section class="agent-tool">
            <h3>${escapeHtml(tool.name.text)}${renderTruncation(tool.name)}</h3>
            ${tool.description === null ? "" : `<p>${escapeHtml(tool.description.text)}${renderTruncation(tool.description)}</p>`}
            ${tool.parameters === null ? "" : `<pre>${escapeHtml(tool.parameters.text)}</pre>${renderTruncation(tool.parameters)}`}
          </section>`,
          )
          .join("")}
      </div>
    </details>`;
}

function renderMessageGroup(label: string, messages: readonly AgentMessage[]): string {
  if (messages.length === 0) {
    return "";
  }

  return `
    <details class="agent-subsection">
      <summary>${escapeHtml(label)} (${messages.length})</summary>
      <div class="agent-subsection-body">
        ${messages
          .map(
            (message) => `
          <section class="agent-message">
            <p class="agent-message-role">${escapeHtml(message.role)}${message.alternative === null ? "" : ` · alternative ${message.alternative}`}</p>
            ${renderContentParts(message.parts)}
          </section>`,
          )
          .join("")}
      </div>
    </details>`;
}

function renderContentParts(parts: readonly ContentPart[]): string {
  if (parts.length === 0) {
    return `<p class="agent-empty">No readable content.</p>`;
  }

  return parts
    .map((part) => {
      switch (part.kind) {
        case "text":
          return `<pre>${escapeHtml(part.value.text)}</pre>${renderTruncation(part.value)}`;
        case "tool-call":
          return `
            <div class="agent-action">
              <strong>Tool call · ${escapeHtml(part.name.text)}</strong>
              ${part.id === null ? "" : `<span class="mono">${escapeHtml(part.id)}</span>`}
              ${part.arguments === null ? "" : `<pre>${escapeHtml(part.arguments.text)}</pre>${renderTruncation(part.arguments)}`}
            </div>`;
        case "tool-result":
          return `
            <div class="agent-action">
              <strong>Tool result${part.isError === true ? " · error" : ""}</strong>
              ${part.callId === null ? "" : `<span class="mono">${escapeHtml(part.callId)}</span>`}
              <pre>${escapeHtml(part.value.text)}</pre>
              ${renderTruncation(part.value)}
            </div>`;
        case "attachment":
          return `<p class="agent-attachment">${escapeHtml(capitalize(part.media))} attachment</p>`;
        case "unsupported":
          return `<p class="agent-empty">${escapeHtml(part.label)}</p>`;
        default: {
          const exhaustive: never = part;

          return exhaustive;
        }
      }
    })
    .join("");
}

function renderTruncation(excerpt: TextExcerpt): string {
  return excerpt.kind === "truncated"
    ? `<span class="agent-truncation">${NUMBER_FORMATTER.format(excerpt.omittedCharacters)} characters omitted</span>`
    : "";
}

function renderOtherAgentContext(sources: readonly SourceAnalysis[]): string {
  if (sources.length === 0) {
    return "";
  }

  return `
    <details class="agent-turn agent-other-context">
      <summary>
        <span class="agent-turn-title">Other agent context</span>
        <span class="agent-turn-model">${sources.length} ${sources.length === 1 ? "source" : "sources"}</span>
      </summary>
      <div class="agent-turn-body">
        ${sources.map(renderContextSource).join("")}
      </div>
    </details>`;
}

function renderContextSource(source: SourceAnalysis): string {
  const fields = [source.input, source.output];
  const parsedMessages = fields.flatMap((field) => field.messages);
  const prompts = parsedMessages.filter(isPromptMessage);
  const tools = fields.flatMap((field) => field.tools);

  const messages = parsedMessages.filter((message) => !isPromptMessage(message));

  return `
    <section class="agent-context-source">
      <h3>${escapeHtml(sourceLabel(source))}</h3>
      ${renderPromptGroup(prompts)}
      ${renderToolGroup(tools)}
      ${renderMessageGroup("Messages", messages)}
    </section>`;
}

function renderParserNotes(agent: AgentPayloadReport): string {
  const notes = agent.sources.flatMap((source) => [
    ...parserNotesForField(source, "Input", source.input),
    ...parserNotesForField(source, "Output", source.output),
  ]);

  if (notes.length === 0) {
    return "";
  }

  const shown = notes.slice(0, 8);
  const remaining = notes.length - shown.length;

  return `
    <details class="agent-turn parser-notes">
      <summary>
        <span class="agent-turn-title">Parsing notes</span>
        <span class="agent-turn-model">${notes.length}</span>
      </summary>
      <div class="agent-turn-body">
        <ul class="parser-note-list">
          ${shown.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}
          ${remaining > 0 ? `<li>${remaining} more notes not shown.</li>` : ""}
        </ul>
      </div>
    </details>`;
}

function parserNotesForField(
  source: SourceAnalysis,
  fieldLabel: "Input" | "Output",
  field: FieldAnalysis,
): string[] {
  const prefix = `${sourceLabel(source)} · ${fieldLabel}`;

  if (field.kind === "invalid-json") {
    return [`${prefix}: invalid JSON; raw value remains available in the observation.`];
  }

  if (field.kind === "unrecognized-json") {
    return [`${prefix}: JSON shape was not recognized.`];
  }

  return field.issues.map((issue) => `${prefix}: ${issue.message}`);
}

function renderIssueList(issues: readonly ExtractionIssue[]): string {
  if (issues.length === 0) {
    return "";
  }

  return `
    <details class="agent-subsection parser-issues">
      <summary>Partial parse (${issues.length})</summary>
      <ul class="parser-note-list">
        ${issues
          .slice(0, 8)
          .map((issue) => `<li>${escapeHtml(issue.message)}</li>`)
          .join("")}
      </ul>
    </details>`;
}

function sourceLabel(source: SourceAnalysis): string {
  return source.origin.kind === "trace-context" ? "Trace context" : source.origin.label;
}

function unrecognizedTurnMessage(
  reason: Extract<AgentTurn, { kind: "unrecognized" }>["reason"],
): string {
  switch (reason) {
    case "empty":
      return "No input or output payload was recorded for this model turn.";
    case "plain-text":
      return "The payload contains plain text without a recognized agent message envelope.";
    case "invalid-json":
      return "The payload contains invalid JSON. Open the observation to inspect the raw value.";
    case "unsupported-json":
      return "The payload is JSON, but its shape is not one this parser recognizes.";
    case "malformed":
      return "The payload matched an agent format but its contents were malformed.";
    case "limit":
      return "The payload exceeded a parser limit. Open the observation to inspect the raw value.";
    default: {
      const exhaustive: never = reason;

      return exhaustive;
    }
  }
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
