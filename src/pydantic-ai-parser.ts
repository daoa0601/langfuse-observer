import { MAX_MESSAGES, parseMessage, type ParsedMessages } from "./agent-message-parser.ts";
import {
  boundedCount,
  joinPointer,
  malformedIssue,
  type ParseContext,
} from "./agent-payload-parser.ts";
import type { MessagePlacement } from "./agent-payload-types.ts";
import { isJsonObject, isJsonString, type JsonObject, type JsonValue } from "./json.ts";

export type PydanticAiMessage = JsonObject & {
  readonly kind: "request" | "response";
  readonly parts: readonly JsonValue[];
};

export function isPydanticAiMessage(value: JsonValue | undefined): value is PydanticAiMessage {
  return (
    isJsonObject(value) &&
    (value["kind"] === "request" || value["kind"] === "response") &&
    Array.isArray(value["parts"])
  );
}

export function isPydanticAiMessageArray(
  value: readonly JsonValue[],
): value is readonly PydanticAiMessage[] {
  return value.length > 0 && value.every(isPydanticAiMessage);
}

export function parsePydanticAiMessages(
  value: readonly PydanticAiMessage[],
  pointer: string,
  placement: MessagePlacement,
  context: ParseContext,
): ParsedMessages {
  const messages: ParsedMessages["messages"] = [];
  const issues: ParsedMessages["issues"] = [];
  const count = boundedCount(value.length, MAX_MESSAGES, pointer, "Pydantic AI messages", issues);

  for (let messageIndex = 0; messageIndex < count; messageIndex += 1) {
    const message = value[messageIndex];

    if (message === undefined) {
      continue;
    }

    const messagePointer = joinPointer(pointer, String(messageIndex));

    parsePydanticAiMessageInto(message, messagePointer, placement, context, messages, issues);
  }

  return { messages, issues };
}

export function parsePydanticAiMessage(
  value: PydanticAiMessage,
  pointer: string,
  placement: MessagePlacement,
  context: ParseContext,
): ParsedMessages {
  const messages: ParsedMessages["messages"] = [];
  const issues: ParsedMessages["issues"] = [];

  parsePydanticAiMessageInto(value, pointer, placement, context, messages, issues);

  return { messages, issues };
}

function parsePydanticAiMessageInto(
  message: PydanticAiMessage,
  messagePointer: string,
  placement: MessagePlacement,
  context: ParseContext,
  messages: ParsedMessages["messages"],
  issues: ParsedMessages["issues"],
): void {
  if (message.kind === "request" && message["instructions"] !== undefined) {
    appendNormalizedMessage(
      { role: "developer", content: message["instructions"] ?? null },
      joinPointer(messagePointer, "instructions"),
      placement,
      context,
      messages,
      issues,
    );
  }

  for (let partIndex = 0; partIndex < message.parts.length; partIndex += 1) {
    const part = message.parts[partIndex];
    const partPointer = joinPointer(joinPointer(messagePointer, "parts"), String(partIndex));

    if (!isJsonObject(part)) {
      issues.push(malformedIssue(partPointer, "Pydantic AI message part must be an object."));
      continue;
    }

    const partKind = part["part_kind"];

    switch (partKind) {
      case "system-prompt":
        appendNormalizedMessage(
          { role: "system", content: part["content"] ?? null },
          partPointer,
          placement,
          context,
          messages,
          issues,
        );
        break;
      case "user-prompt":
      case "retry-prompt":
        appendNormalizedMessage(
          { role: "user", content: part["content"] ?? null },
          partPointer,
          placement,
          context,
          messages,
          issues,
        );
        break;
      case "text":
        appendNormalizedMessage(
          { role: "assistant", content: part["content"] ?? null },
          partPointer,
          placement,
          context,
          messages,
          issues,
        );
        break;
      case "tool-call":
        appendNormalizedMessage(
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: part["tool_call_id"] ?? null,
                name: part["tool_name"] ?? null,
                arguments: part["args"] ?? null,
              },
            ],
          },
          partPointer,
          placement,
          context,
          messages,
          issues,
        );
        break;
      case "tool-return":
        appendNormalizedMessage(
          {
            role: "tool",
            content: part["content"] ?? null,
            tool_call_id: part["tool_call_id"] ?? null,
          },
          partPointer,
          placement,
          context,
          messages,
          issues,
        );
        break;
      default:
        issues.push(
          malformedIssue(
            partPointer,
            `Unsupported Pydantic AI part kind: ${isJsonString(partKind) ? partKind : "missing"}.`,
          ),
        );
    }
  }
}

function appendNormalizedMessage(
  value: JsonObject,
  pointer: string,
  placement: MessagePlacement,
  context: ParseContext,
  messages: ParsedMessages["messages"],
  issues: ParsedMessages["issues"],
): void {
  const parsed = parseMessage(value, pointer, placement, context, null);

  if (parsed.kind === "message") {
    messages.push(parsed.message);
    issues.push(...parsed.issues);
  } else if (parsed.kind === "issue") {
    issues.push(parsed.issue);
  }
}
