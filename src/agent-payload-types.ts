import type { JsonValue } from "./json.ts";

export type PayloadSourceRole = "model-turn" | "agent-context" | "tool-execution" | "other";

export type PayloadOrigin =
  | Readonly<{
      kind: "observation";
      observationId: string;
      label: string;
      sourceRole: PayloadSourceRole;
      startedAt: string;
      model: string | null;
      allowStandaloneAssistantOutput: boolean;
    }>
  | Readonly<{ kind: "trace-context" }>;

export interface AgentPayloadSource {
  readonly origin: PayloadOrigin;
  readonly input: JsonValue;
  readonly output: JsonValue;
}

export type Recognizer =
  | "message-array"
  | "messages-envelope"
  | "openai-chat-request"
  | "openai-chat-response"
  | "openai-responses-request"
  | "openai-responses-response"
  | "anthropic-request"
  | "anthropic-response"
  | "assistant-output"
  | "plain-text";

export interface Evidence {
  readonly origin: PayloadOrigin;
  readonly field: "input" | "output";
  readonly pointer: string;
  readonly recognizer: Recognizer;
  readonly decodedLayers: 0 | 1 | 2;
}

export type TextExcerpt =
  | Readonly<{ kind: "complete"; text: string }>
  | Readonly<{ kind: "truncated"; text: string; omittedCharacters: number }>;

export type ContentPart =
  | Readonly<{ kind: "text"; value: TextExcerpt }>
  | Readonly<{
      kind: "tool-call";
      id: string | null;
      name: TextExcerpt;
      arguments: TextExcerpt | null;
    }>
  | Readonly<{
      kind: "tool-result";
      callId: string | null;
      value: TextExcerpt;
      isError: boolean | null;
    }>
  | Readonly<{ kind: "attachment"; media: "image" | "audio" | "document" }>
  | Readonly<{ kind: "unsupported"; label: string }>;

export type AgentRole = "system" | "developer" | "user" | "assistant" | "tool";

export type MessagePlacement = "input-context" | "output-conversation" | "output-reply";

export interface AgentMessage {
  readonly role: AgentRole;
  readonly placement: MessagePlacement;
  readonly parts: readonly ContentPart[];
  readonly alternative: number | null;
  readonly evidence: Evidence;
}

export type PromptOccurrence = AgentMessage & { readonly role: "system" | "developer" };

export type InputContextMessage = AgentMessage & {
  readonly role: "user" | "assistant" | "tool";
  readonly placement: "input-context";
};

export interface ToolDeclaration {
  readonly name: TextExcerpt;
  readonly description: TextExcerpt | null;
  readonly parameters: TextExcerpt | null;
  readonly evidence: Evidence;
}

export type ExtractionIssue = Readonly<{
  kind: "limit" | "malformed";
  pointer: string;
  message: string;
}>;

interface FieldFindings {
  readonly messages: readonly AgentMessage[];
  readonly tools: readonly ToolDeclaration[];
  readonly issues: readonly ExtractionIssue[];
}

export type FieldAnalysis = Readonly<
  FieldFindings &
    (
      | { kind: "absent" }
      | { kind: "plain-text" }
      | { kind: "invalid-json" }
      | { kind: "unrecognized-json" }
      | { kind: "skipped" }
      | { kind: "recognized"; recognizer: Recognizer }
    )
>;

export interface SourceAnalysis {
  readonly origin: PayloadOrigin;
  readonly input: FieldAnalysis;
  readonly output: FieldAnalysis;
}

interface TurnBase {
  readonly number: number;
  readonly observationId: string;
  readonly startedAt: string;
  readonly model: string | null;
}

interface TurnFindings {
  readonly inputContext: readonly InputContextMessage[];
  readonly replies: readonly AgentMessage[];
  readonly prompts: readonly PromptOccurrence[];
  readonly tools: readonly ToolDeclaration[];
}

export type AgentTurn =
  | Readonly<TurnBase & TurnFindings & { kind: "recognized" }>
  | Readonly<TurnBase & TurnFindings & { kind: "partial"; issues: readonly ExtractionIssue[] }>
  | Readonly<{
      kind: "unrecognized";
      number: number;
      observationId: string;
      startedAt: string;
      model: string | null;
      reason: "empty" | "plain-text" | "invalid-json" | "unsupported-json" | "malformed" | "limit";
    }>;

export interface AgentPayloadReport {
  readonly coverage: "complete" | "partial";
  readonly turns: readonly AgentTurn[];
  readonly contextSources: readonly SourceAnalysis[];
  readonly sources: readonly SourceAnalysis[];
}
