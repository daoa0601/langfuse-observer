import type {
  AgentMessage,
  AgentPayloadReport,
  AgentPayloadSource,
  AgentTurn,
  ExtractionIssue,
  FieldAnalysis,
  InputContextMessage,
  PayloadOrigin,
  PromptOccurrence,
  SourceAnalysis,
} from "./agent-payload-types.ts";
import {
  contentLimitIssue,
  createParseContext,
  type InspectionBudget,
  joinPointer,
  limitIssue,
  malformedIssue,
} from "./agent-payload-parser.ts";
import { createMessage, parseContent } from "./agent-message-parser.ts";
import { recognizeDocument } from "./agent-payload-recognizers.ts";
import { isJsonObject, isJsonString, parseJson } from "./json.ts";
import type { JsonValue } from "./observer-types.ts";

export type * from "./agent-payload-types.ts";

const MAX_FIELD_CHARACTERS = 1_000_000;

const MAX_TRACE_CHARACTERS = 3_000_000;

const MAX_CONTAINER_DEPTH = 40;

const MAX_INSPECTED_NODES = 20_000;

interface SourceInspection {
  readonly source: AgentPayloadSource;
  readonly analysis: SourceAnalysis;
}

interface ModelSourceInspection extends SourceInspection {
  readonly source: AgentPayloadSource & {
    readonly origin: Extract<PayloadOrigin, { kind: "observation" }>;
  };
}

type DecodedDocument =
  | Readonly<{ kind: "plain-text"; text: string; decodedLayers: 0 | 1 }>
  | Readonly<{ kind: "invalid-json" }>
  | Readonly<{ kind: "json"; value: JsonValue; decodedLayers: 0 | 1 | 2 }>;

export function inspectAgentPayloads(
  sources: readonly AgentPayloadSource[],
): Readonly<AgentPayloadReport> {
  const budget: InspectionBudget = {
    sourceCharacters: 0,
    textCharacters: 0,
    contentParts: 0,
    contentLimitHits: 0,
  };

  const sourceInspections = sources.map((source) => inspectSource(source, budget));
  const analyses = sourceInspections.map(({ analysis }) => analysis);

  const modelSources = sourceInspections
    .filter(isModelSource)
    .sort(
      (left, right) =>
        left.source.origin.startedAt.localeCompare(right.source.origin.startedAt) ||
        left.source.origin.observationId.localeCompare(right.source.origin.observationId),
    );

  const turns = modelSources.map((source, index) => createTurn(source, index + 1));

  const contextSources = analyses.filter((analysis) => {
    if (analysis.origin.kind === "trace-context") {
      return hasFindings(analysis.input) || hasFindings(analysis.output);
    }

    return (
      analysis.origin.sourceRole !== "model-turn" &&
      (hasFindings(analysis.input) || hasFindings(analysis.output))
    );
  });

  return Object.freeze({
    coverage: analyses.some(hasIncompleteField) ? "partial" : "complete",
    turns,
    contextSources,
    sources: analyses,
  });
}

function inspectSource(source: AgentPayloadSource, budget: InspectionBudget): SourceInspection {
  const input = inspectField(source, "input", budget);
  const output = inspectField(source, "output", budget);

  return {
    source,
    analysis: Object.freeze({
      origin: source.origin,
      input,
      output,
    }),
  };
}

function isModelSource(inspection: SourceInspection): inspection is ModelSourceInspection {
  return (
    inspection.source.origin.kind === "observation" &&
    inspection.source.origin.sourceRole === "model-turn"
  );
}

function inspectField(
  source: AgentPayloadSource,
  field: "input" | "output",
  budget: InspectionBudget,
): FieldAnalysis {
  const raw = source[field];

  if (raw === null || (isJsonString(raw) && raw.trim() === "")) {
    return emptyAnalysis("absent");
  }

  if (isJsonString(raw)) {
    const limit = reserveSourceCharacters(raw.length, budget);

    if (limit !== null) {
      return emptyAnalysis("skipped", [limit]);
    }

    const decoded = decodeDocument(raw);

    if (decoded.kind === "invalid-json") {
      return emptyAnalysis("invalid-json", [
        malformedIssue(`/${field}`, `${capitalize(field)} contains invalid JSON.`),
      ]);
    }

    if (decoded.kind === "plain-text") {
      return inspectPlainText(source, field, decoded.text, decoded.decodedLayers, budget);
    }

    const structuralIssue = inspectStructure(decoded.value);

    return structuralIssue === null
      ? recognizeJsonField(source, field, decoded.value, decoded.decodedLayers, budget)
      : emptyAnalysis("skipped", [structuralIssue]);
  }

  const structuralIssue = inspectStructure(raw);

  if (structuralIssue !== null) {
    return emptyAnalysis("skipped", [structuralIssue]);
  }

  const sourceText = JSON.stringify(raw);
  const limit = reserveSourceCharacters(sourceText.length, budget);

  return limit === null
    ? recognizeJsonField(source, field, raw, 0, budget)
    : emptyAnalysis("skipped", [limit]);
}

function recognizeJsonField(
  source: AgentPayloadSource,
  field: "input" | "output",
  value: JsonValue,
  decodedLayers: 0 | 1 | 2,
  budget: InspectionBudget,
): FieldAnalysis {
  const contentLimitHits = budget.contentLimitHits;
  const document = recognizeDocument(source, field, value, decodedLayers, budget);

  if (document === null) {
    return emptyAnalysis("unrecognized-json", [
      malformedIssue(`/${field}`, `${capitalize(field)} JSON has an unsupported shape.`),
    ]);
  }

  const issues =
    budget.contentLimitHits === contentLimitHits
      ? document.issues
      : [...document.issues, contentLimitIssue(`/${field}`)];

  return Object.freeze({
    kind: "recognized",
    recognizer: document.recognizer,
    messages: document.messages,
    tools: document.tools,
    issues,
  });
}

function inspectPlainText(
  source: AgentPayloadSource,
  field: "input" | "output",
  text: string,
  decodedLayers: 0 | 1,
  budget: InspectionBudget,
): FieldAnalysis {
  if (source.origin.kind !== "observation" || source.origin.sourceRole !== "model-turn") {
    return emptyAnalysis("plain-text");
  }

  const issues: ExtractionIssue[] = [];
  const context = createParseContext(source.origin, field, "plain-text", decodedLayers, budget);
  const contentLimitHits = budget.contentLimitHits;

  const parts = parseContent(text, "", context, issues);

  const messages =
    parts.length === 0
      ? []
      : [
          createMessage(
            field === "input" ? "user" : "assistant",
            field === "input" ? "input-context" : "output-reply",
            parts,
            context,
            "",
          ),
        ];

  return Object.freeze({
    kind: "plain-text",
    messages,
    tools: [],
    issues:
      budget.contentLimitHits === contentLimitHits
        ? issues
        : [...issues, contentLimitIssue(`/${field}`)],
  });
}

function reserveSourceCharacters(length: number, budget: InspectionBudget): ExtractionIssue | null {
  if (length > MAX_FIELD_CHARACTERS) {
    return limitIssue(
      "",
      `Field exceeds the ${MAX_FIELD_CHARACTERS.toLocaleString("en")} character limit.`,
    );
  }

  if (budget.sourceCharacters + length > MAX_TRACE_CHARACTERS) {
    return limitIssue(
      "",
      `Trace payloads exceed the ${MAX_TRACE_CHARACTERS.toLocaleString("en")} character limit.`,
    );
  }

  budget.sourceCharacters += length;

  return null;
}

function decodeDocument(raw: JsonValue): DecodedDocument {
  if (!isJsonString(raw)) {
    return { kind: "json", value: raw, decodedLayers: 0 };
  }

  const first = parseJson(raw);

  if (first.kind === "invalid") {
    return looksLikeJson(raw)
      ? { kind: "invalid-json" }
      : { kind: "plain-text", text: raw, decodedLayers: 0 };
  }

  if (!isJsonString(first.value)) {
    return { kind: "json", value: first.value, decodedLayers: 1 };
  }

  if (!looksLikeJson(first.value)) {
    return { kind: "plain-text", text: first.value, decodedLayers: 1 };
  }

  const second = parseJson(first.value);

  return second.kind === "valid"
    ? { kind: "json", value: second.value, decodedLayers: 2 }
    : { kind: "plain-text", text: first.value, decodedLayers: 1 };
}

function looksLikeJson(value: string): boolean {
  const first = value.trimStart().at(0);

  return first === "{" || first === "[" || first === '"';
}

function inspectStructure(root: JsonValue): ExtractionIssue | null {
  const pending: Array<Readonly<{ value: JsonValue; depth: number; pointer: string }>> = [
    { value: root, depth: 0, pointer: "" },
  ];

  let nodes = 0;

  while (pending.length > 0) {
    const current = pending.pop();

    if (current === undefined) {
      continue;
    }

    nodes += 1;

    if (nodes > MAX_INSPECTED_NODES) {
      return limitIssue(
        current.pointer,
        `JSON exceeds the ${MAX_INSPECTED_NODES.toLocaleString("en")} node limit.`,
      );
    }

    if (current.depth > MAX_CONTAINER_DEPTH) {
      return limitIssue(
        current.pointer,
        `JSON exceeds the ${MAX_CONTAINER_DEPTH} level depth limit.`,
      );
    }

    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        const value = current.value[index];

        if (value !== undefined) {
          pending.push({
            value,
            depth: current.depth + 1,
            pointer: joinPointer(current.pointer, String(index)),
          });
        }
      }

      continue;
    }

    if (isJsonObject(current.value)) {
      const entries = Object.entries(current.value);

      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];

        if (entry !== undefined) {
          pending.push({
            value: entry[1],
            depth: current.depth + 1,
            pointer: joinPointer(current.pointer, entry[0]),
          });
        }
      }
    }
  }

  return null;
}

function promptsFromMessages(messages: readonly AgentMessage[]): PromptOccurrence[] {
  return messages.filter(isPromptMessage);
}

export function isPromptMessage(message: AgentMessage): message is PromptOccurrence {
  return message.role === "system" || message.role === "developer";
}

function isInputContextMessage(message: AgentMessage): message is InputContextMessage {
  return message.placement === "input-context" && !isPromptMessage(message);
}

function createTurn(extraction: ModelSourceInspection, number: number): AgentTurn {
  const { origin } = extraction.source;
  const { input, output } = extraction.analysis;

  const prompts = promptsFromMessages([...input.messages, ...output.messages]);

  const inputContext = input.messages.filter(isInputContextMessage);

  const replies = output.messages.filter((message) => message.placement === "output-reply");

  const tools = [...input.tools, ...output.tools];
  const issues = [...input.issues, ...output.issues];

  const base = {
    number,
    observationId: origin.observationId,
    startedAt: origin.startedAt,
    model: origin.model,
    inputContext,
    replies,
    prompts,
    tools,
  };

  const found =
    inputContext.length > 0 || replies.length > 0 || prompts.length > 0 || tools.length > 0;

  if (found && issues.length > 0) {
    return Object.freeze({ ...base, kind: "partial", issues });
  }

  if (found) {
    return Object.freeze({ ...base, kind: "recognized" });
  }

  return Object.freeze({
    kind: "unrecognized",
    number,
    observationId: origin.observationId,
    startedAt: origin.startedAt,
    model: origin.model,
    reason: unrecognizedReason(input, output),
  });
}

function unrecognizedReason(
  input: FieldAnalysis,
  output: FieldAnalysis,
): Extract<AgentTurn, { kind: "unrecognized" }>["reason"] {
  const kinds = [input.kind, output.kind];
  const issues = [...input.issues, ...output.issues];

  if (kinds.includes("skipped") || issues.some((issue) => issue.kind === "limit")) {
    return "limit";
  }

  if (kinds.includes("invalid-json")) {
    return "invalid-json";
  }

  if (kinds.includes("unrecognized-json")) {
    return "unsupported-json";
  }

  if (issues.some((issue) => issue.kind === "malformed")) {
    return "malformed";
  }

  if (kinds.includes("plain-text")) {
    return "plain-text";
  }

  return "empty";
}

function hasFindings(analysis: FieldAnalysis): boolean {
  return analysis.messages.length > 0 || analysis.tools.length > 0;
}

function hasIncompleteField(analysis: SourceAnalysis): boolean {
  return isIncomplete(analysis.input) || isIncomplete(analysis.output);
}

function isIncomplete(analysis: FieldAnalysis): boolean {
  return analysis.issues.length > 0;
}

function emptyAnalysis(
  kind: "absent" | "plain-text" | "invalid-json" | "unrecognized-json" | "skipped",
  issues: readonly ExtractionIssue[] = [],
): FieldAnalysis {
  return Object.freeze({ kind, messages: [], tools: [], issues });
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
