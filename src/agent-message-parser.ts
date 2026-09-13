import {
  booleanValue,
  boundedCount,
  excerpt,
  excerptValue,
  joinPointer,
  makeEvidence,
  MAX_CONTENT_PARTS,
  malformedIssue,
  type ParseContext,
  parseRole,
  stringValue,
} from "./agent-payload-parser.ts";
import type {
  AgentMessage,
  AgentRole,
  ContentPart,
  ExtractionIssue,
  MessagePlacement,
  ToolDeclaration,
} from "./agent-payload-types.ts";
import { isJsonObject, isJsonString, type JsonObject } from "./json.ts";
import type { JsonValue } from "./observer-types.ts";

export const MAX_MESSAGES = 500;

const MAX_TOOLS = 100;

type ContentBlockKind = "text" | "tool-call" | "tool-result" | "image" | "audio" | "document";

export interface ParsedMessages {
  readonly messages: AgentMessage[];
  readonly issues: ExtractionIssue[];
}

export interface ParsedTools {
  readonly tools: ToolDeclaration[];
  readonly issues: ExtractionIssue[];
}

export function parseMessages(
  value: JsonValue | undefined,
  pointer: string,
  placement: MessagePlacement,
  context: ParseContext,
): ParsedMessages {
  const messages: AgentMessage[] = [];
  const issues: ExtractionIssue[] = [];

  if (!Array.isArray(value)) {
    return { messages, issues: [malformedIssue(pointer, "Messages must be an array.")] };
  }

  const count = boundedCount(value.length, MAX_MESSAGES, pointer, "messages", issues);

  for (let index = 0; index < count; index += 1) {
    const item = value[index];
    const itemPointer = joinPointer(pointer, String(index));

    const parsed = parseMessage(item, itemPointer, placement, context, null);

    if (parsed.kind === "message") {
      messages.push(parsed.message);
      issues.push(...parsed.issues);
    } else if (parsed.kind === "issue") {
      issues.push(parsed.issue);
    }
  }

  return { messages, issues };
}

export function parseResponsesItems(
  value: JsonValue | undefined,
  pointer: string,
  placement: MessagePlacement,
  context: ParseContext,
): ParsedMessages {
  const messages: AgentMessage[] = [];
  const issues: ExtractionIssue[] = [];

  if (!Array.isArray(value)) {
    return { messages, issues: [malformedIssue(pointer, "Responses items must be an array.")] };
  }

  const count = boundedCount(value.length, MAX_MESSAGES, pointer, "response items", issues);

  for (let index = 0; index < count; index += 1) {
    const item = value[index];
    const itemPointer = joinPointer(pointer, String(index));

    if (!isJsonObject(item)) {
      issues.push(malformedIssue(itemPointer, "Response item must be an object."));
      continue;
    }

    const type = stringValue(item["type"]);
    const role = parseRole(item["role"]);

    if (role !== null) {
      const parsed = parseMessage(item, itemPointer, placement, context, null);

      if (parsed.kind === "message") {
        messages.push(parsed.message);
        issues.push(...parsed.issues);
      } else if (parsed.kind === "issue") {
        issues.push(parsed.issue);
      }

      continue;
    }

    if (type === "function_call_output" || type === "tool_result") {
      const part = parseContentBlock(item, itemPointer, context, issues);

      if (part !== null) {
        messages.push(createMessage("tool", placement, [part], context, itemPointer));
      }

      continue;
    }

    if (isSupportedContentBlock(item)) {
      const part = parseContentBlock(item, itemPointer, context, issues);

      if (part !== null) {
        messages.push(createMessage("assistant", placement, [part], context, itemPointer));
      }

      continue;
    }

    issues.push(
      malformedIssue(itemPointer, `Unsupported response item type: ${type ?? "missing"}.`),
    );
  }

  return { messages, issues };
}

export function parseMessage(
  value: JsonValue | undefined,
  pointer: string,
  placement: MessagePlacement,
  context: ParseContext,
  alternative: number | null,
):
  | Readonly<{ kind: "message"; message: AgentMessage; issues: readonly ExtractionIssue[] }>
  | Readonly<{ kind: "issue"; issue: ExtractionIssue }>
  | Readonly<{ kind: "omitted" }> {
  if (!isJsonObject(value)) {
    return { kind: "issue", issue: malformedIssue(pointer, "Message must be an object.") };
  }

  const role = parseRole(value["role"]);

  if (role === null) {
    return { kind: "issue", issue: malformedIssue(pointer, "Message has an unsupported role.") };
  }

  const issues: ExtractionIssue[] = [];
  const contentLimitHits = context.budget.contentLimitHits;
  let parts: ContentPart[];

  if (role === "tool") {
    const part = recordContentPart(
      {
        kind: "tool-result",
        callId: stringValue(value["tool_call_id"]) ?? stringValue(value["tool_use_id"]),
        value: excerptValue(
          value["content"],
          joinPointer(pointer, "content"),
          context.budget,
          issues,
        ),
        isError: booleanValue(value["is_error"]),
      },
      context,
    );

    parts = part === null ? [] : [part];
  } else {
    parts = parseContent(value["content"], joinPointer(pointer, "content"), context, issues);
  }

  const toolCalls = value["tool_calls"];

  if (toolCalls !== undefined && toolCalls !== null && !Array.isArray(toolCalls)) {
    issues.push(malformedIssue(joinPointer(pointer, "tool_calls"), "tool_calls must be an array."));
  } else if (Array.isArray(toolCalls)) {
    const count = boundedContentCount(toolCalls.length, context);

    for (let index = 0; index < count; index += 1) {
      appendContentPart(
        parts,
        parseToolCall(
          toolCalls[index],
          joinPointer(joinPointer(pointer, "tool_calls"), String(index)),
          context,
          issues,
        ),
      );
    }
  }

  if (value["function_call"] !== undefined) {
    appendContentPart(
      parts,
      parseToolCall(value["function_call"], joinPointer(pointer, "function_call"), context, issues),
    );
  }

  if (parts.length === 0 && context.budget.contentLimitHits > contentLimitHits) {
    return { kind: "omitted" };
  }

  if (parts.length === 0) {
    appendContentPart(
      parts,
      recordContentPart({ kind: "unsupported", label: "Empty message" }, context),
    );
  }

  return {
    kind: "message",
    message: createMessage(role, placement, parts, context, pointer, alternative),
    issues,
  };
}

export function parseContent(
  value: JsonValue | undefined,
  pointer: string,
  context: ParseContext,
  issues: ExtractionIssue[],
): ContentPart[] {
  if (isJsonString(value)) {
    const part = recordContentPart(
      { kind: "text", value: excerpt(value, pointer, context.budget, issues) },
      context,
    );

    return part === null ? [] : [part];
  }

  if (value === null || value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    if (isJsonObject(value)) {
      const part = parseContentBlock(value, pointer, context, issues);

      return part === null ? [] : [part];
    }

    issues.push(malformedIssue(pointer, "Message content must be text, an object, or an array."));

    const part = recordContentPart(
      { kind: "unsupported", label: "Unsupported primitive content" },
      context,
    );

    return part === null ? [] : [part];
  }

  const parts: ContentPart[] = [];
  const count = boundedContentCount(value.length, context);

  for (let index = 0; index < count; index += 1) {
    const item = value[index];
    const itemPointer = joinPointer(pointer, String(index));

    if (isJsonString(item)) {
      appendContentPart(
        parts,
        recordContentPart(
          { kind: "text", value: excerpt(item, itemPointer, context.budget, issues) },
          context,
        ),
      );
    } else if (isJsonObject(item)) {
      appendContentPart(parts, parseContentBlock(item, itemPointer, context, issues));
    } else {
      issues.push(malformedIssue(itemPointer, "Content part must be text or an object."));
    }
  }

  return parts;
}

export function parseContentBlock(
  value: JsonObject,
  pointer: string,
  context: ParseContext,
  issues: ExtractionIssue[],
): ContentPart | null {
  const type = stringValue(value["type"]);
  const blockKind = contentBlockKind(type);

  if (blockKind === "text") {
    const text = stringValue(value["text"]);

    if (text === null) {
      issues.push(malformedIssue(pointer, `${type} block is missing text.`));

      return recordContentPart(
        { kind: "unsupported", label: `${type ?? "text"} without text` },
        context,
      );
    }

    return recordContentPart(
      { kind: "text", value: excerpt(text, pointer, context.budget, issues) },
      context,
    );
  }

  if (blockKind === "tool-call") {
    return parseToolCall(value, pointer, context, issues);
  }

  if (blockKind === "tool-result") {
    const result = value["content"] ?? value["output"] ?? value["result"];

    return recordContentPart(
      {
        kind: "tool-result",
        callId:
          stringValue(value["tool_use_id"]) ??
          stringValue(value["call_id"]) ??
          stringValue(value["id"]),
        value: excerptValue(result, pointer, context.budget, issues),
        isError: booleanValue(value["is_error"]),
      },
      context,
    );
  }

  if (blockKind === "image" || blockKind === "audio" || blockKind === "document") {
    return recordContentPart({ kind: "attachment", media: blockKind }, context);
  }

  if (type === null && isJsonString(value["text"])) {
    return recordContentPart(
      { kind: "text", value: excerpt(value["text"], pointer, context.budget, issues) },
      context,
    );
  }

  const label = type ?? "Unknown content block";
  issues.push(malformedIssue(pointer, `Unsupported content block type: ${label}.`));

  return recordContentPart({ kind: "unsupported", label }, context);
}

export function isSupportedContentBlock(value: JsonValue | undefined): value is JsonObject {
  return isJsonObject(value) && contentBlockKind(stringValue(value["type"])) !== null;
}

export function parseToolDeclarations(
  value: JsonValue | undefined,
  pointer: string,
  context: ParseContext,
): ParsedTools {
  const tools: ToolDeclaration[] = [];
  const issues: ExtractionIssue[] = [];

  if (value === undefined) {
    return { tools, issues };
  }

  if (!Array.isArray(value)) {
    return { tools, issues: [malformedIssue(pointer, "Tools must be an array.")] };
  }

  const count = boundedCount(value.length, MAX_TOOLS, pointer, "tool declarations", issues);

  for (let index = 0; index < count; index += 1) {
    const item = value[index];
    const itemPointer = joinPointer(pointer, String(index));

    if (!isJsonObject(item)) {
      issues.push(malformedIssue(itemPointer, "Tool declaration must be an object."));
      continue;
    }

    const definition = isJsonObject(item["function"]) ? item["function"] : item;
    const name = stringValue(definition["name"]);

    if (name === null) {
      issues.push(malformedIssue(itemPointer, "Tool declaration is missing its name."));
      continue;
    }

    const parameters = definition["parameters"] ?? definition["input_schema"];
    tools.push(
      Object.freeze({
        name: excerpt(name, joinPointer(itemPointer, "name"), context.budget, issues),
        description: isJsonString(definition["description"])
          ? excerpt(
              definition["description"],
              joinPointer(itemPointer, "description"),
              context.budget,
              issues,
            )
          : null,
        parameters:
          parameters === undefined
            ? null
            : excerptValue(
                parameters,
                joinPointer(itemPointer, "parameters"),
                context.budget,
                issues,
              ),
        evidence: makeEvidence(
          context.origin,
          context.field,
          context.recognizer,
          context.decodedLayers,
          itemPointer,
        ),
      }),
    );
  }

  return { tools, issues };
}

export function createMessage(
  role: AgentRole,
  placement: MessagePlacement,
  parts: readonly ContentPart[],
  context: ParseContext,
  pointer: string,
  alternative: number | null = null,
): AgentMessage {
  return Object.freeze({
    role,
    placement,
    parts,
    alternative,
    evidence: makeEvidence(
      context.origin,
      context.field,
      context.recognizer,
      context.decodedLayers,
      pointer,
    ),
  });
}

function parseToolCall(
  value: JsonValue | undefined,
  pointer: string,
  context: ParseContext,
  issues: ExtractionIssue[],
): ContentPart | null {
  if (!isJsonObject(value)) {
    issues.push(malformedIssue(pointer, "Tool call must be an object."));

    return recordContentPart({ kind: "unsupported", label: "Malformed tool call" }, context);
  }

  const fn = isJsonObject(value["function"]) ? value["function"] : value;
  const name = stringValue(fn["name"]);

  if (name === null) {
    issues.push(malformedIssue(pointer, "Tool call is missing its name."));
  }

  const argumentsValue = fn["arguments"] ?? fn["input"];

  return recordContentPart(
    {
      kind: "tool-call",
      id: stringValue(value["id"]) ?? stringValue(value["call_id"]),
      name: excerpt(name ?? "Unnamed tool", joinPointer(pointer, "name"), context.budget, issues),
      arguments:
        argumentsValue === undefined
          ? null
          : excerptValue(argumentsValue, joinPointer(pointer, "arguments"), context.budget, issues),
    },
    context,
  );
}

function contentBlockKind(type: string | null): ContentBlockKind | null {
  switch (type) {
    case "text":
    case "input_text":
    case "output_text":
      return "text";
    case "tool_use":
    case "tool_call":
    case "function_call":
      return "tool-call";
    case "tool_result":
    case "function_call_output":
      return "tool-result";
    case "image":
    case "input_image":
    case "output_image":
    case "image_url":
      return "image";
    case "audio":
    case "input_audio":
    case "output_audio":
      return "audio";
    case "document":
    case "file":
    case "input_file":
      return "document";
    default:
      return null;
  }
}

function boundedContentCount(length: number, context: ParseContext): number {
  const available = Math.max(0, MAX_CONTENT_PARTS - context.budget.contentParts);

  if (length > available) {
    recordContentLimit(context);
  }

  return Math.min(length, available);
}

function recordContentPart(part: ContentPart, context: ParseContext): ContentPart | null {
  if (context.budget.contentParts >= MAX_CONTENT_PARTS) {
    recordContentLimit(context);

    return null;
  }

  context.budget.contentParts += 1;

  return Object.freeze(part);
}

function recordContentLimit(context: ParseContext): void {
  context.budget.contentLimitHits += 1;
}

function appendContentPart(parts: ContentPart[], part: ContentPart | null): void {
  if (part !== null) {
    parts.push(part);
  }
}
