import type {
  AgentRole,
  Evidence,
  ExtractionIssue,
  PayloadOrigin,
  Recognizer,
  TextExcerpt,
} from "./agent-payload-types.ts";
import { isJsonBoolean, isJsonString } from "./json.ts";
import type { JsonValue } from "./observer-types.ts";

const MAX_EXCERPT_CHARACTERS = 20_000;

const MAX_TRACE_TEXT_CHARACTERS = 200_000;

export const MAX_CONTENT_PARTS = 1_000;

export interface InspectionBudget {
  sourceCharacters: number;
  textCharacters: number;
  contentParts: number;
  contentLimitHits: number;
}

export interface ParseContext {
  readonly origin: PayloadOrigin;
  readonly field: "input" | "output";
  readonly decodedLayers: 0 | 1 | 2;
  readonly recognizer: Recognizer;
  readonly budget: InspectionBudget;
}

export function createParseContext(
  origin: PayloadOrigin,
  field: "input" | "output",
  recognizer: Recognizer,
  decodedLayers: 0 | 1 | 2,
  budget: InspectionBudget,
): ParseContext {
  return { origin, field, recognizer, decodedLayers, budget };
}

export function makeEvidence(
  origin: PayloadOrigin,
  field: "input" | "output",
  recognizer: Recognizer,
  decodedLayers: 0 | 1 | 2,
  pointer: string,
): Evidence {
  return Object.freeze({ origin, field, recognizer, decodedLayers, pointer });
}

export function excerpt(
  text: string,
  pointer: string,
  budget: InspectionBudget,
  issues: ExtractionIssue[],
): TextExcerpt {
  const available = Math.max(0, MAX_TRACE_TEXT_CHARACTERS - budget.textCharacters);
  const kept = Math.min(text.length, MAX_EXCERPT_CHARACTERS, available);
  budget.textCharacters += kept;

  if (kept === text.length) {
    return Object.freeze({ kind: "complete", text });
  }

  issues.push(limitIssue(pointer, "Extracted text was truncated."));

  return Object.freeze({
    kind: "truncated",
    text: text.slice(0, kept),
    omittedCharacters: text.length - kept,
  });
}

export function excerptValue(
  value: JsonValue | undefined,
  pointer: string,
  budget: InspectionBudget,
  issues: ExtractionIssue[],
): TextExcerpt {
  if (isJsonString(value)) {
    return excerpt(value, pointer, budget, issues);
  }

  const rendered = JSON.stringify(value, null, 2) ?? "null";

  return excerpt(rendered, pointer, budget, issues);
}

export function boundedCount(
  length: number,
  maximum: number,
  pointer: string,
  label: string,
  issues: ExtractionIssue[],
): number {
  if (length > maximum) {
    issues.push(
      limitIssue(
        pointer,
        `Only the first ${maximum.toLocaleString("en")} ${label} were inspected.`,
      ),
    );
  }

  return Math.min(length, maximum);
}

export function malformedIssue(pointer: string, message: string): ExtractionIssue {
  return Object.freeze({ kind: "malformed", pointer, message });
}

export function limitIssue(pointer: string, message: string): ExtractionIssue {
  return Object.freeze({ kind: "limit", pointer, message });
}

export function contentLimitIssue(pointer: string): ExtractionIssue {
  return limitIssue(
    pointer,
    `Trace exceeds the ${MAX_CONTENT_PARTS.toLocaleString("en")} content part limit.`,
  );
}

export function joinPointer(parent: string, segment: string): string {
  const escaped = segment.replaceAll("~", "~0").replaceAll("/", "~1");

  return `${parent}/${escaped}`;
}

export function stringValue(value: JsonValue | undefined): string | null {
  return isJsonString(value) ? value : null;
}

export function booleanValue(value: JsonValue | undefined): boolean | null {
  return isJsonBoolean(value) ? value : null;
}

export function parseRole(value: JsonValue | undefined): AgentRole | null {
  switch (value) {
    case "system":
    case "developer":
    case "user":
    case "assistant":
    case "tool":
      return value;
    case "function":
      return "tool";
    default:
      return null;
  }
}
