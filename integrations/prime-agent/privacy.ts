import {
  isJsonObject,
  isJsonString,
  parseJson,
  type JsonValue,
  type JsonObject,
} from "../../src/json.ts";

const sensitiveKey =
  /(?:authorization|cookie|api[-_]?key|secret|password|passwd|credential|token$|private[-_]?key)/i;

const omittedKey =
  /^(?:thinking|reasoning(?:_content|_text|_details)?|encrypted_content|signature|thought_?signature|data|image_url)$/i;

/** Best effort only. Arbitrary private prose is not detectable: bodies default off. */
export function redactText(text: string, secrets: readonly string[]): string {
  let result = text;

  for (const secret of secrets) {
    if (secret.length >= 4) result = result.replaceAll(secret, "[REDACTED]");
  }

  return result
    .replace(/\b(?:sk|pk)-[a-zA-Z0-9_-]{8,}/g, "[REDACTED]")
    .replace(
      /\b(?:gh[pousr]_[a-zA-Z0-9_]{12,}|github_pat_[a-zA-Z0-9_]+|AKIA[A-Z0-9]{16})\b/g,
      "[REDACTED]",
    )
    .replace(/\b(Bearer|Basic)\s+[a-zA-Z0-9+/_=.-]{8,}/gi, "$1 [REDACTED]")
    .replace(
      /((?:api[_-]?key|secret|password|access[_-]?token)["']?\s*[=:]\s*["']?)[^\s"',;]+/gi,
      "$1[REDACTED]",
    );
}

/** Returns valid JSON even when the input is too large; never a cut JSON string. */
export function capture(value: JsonValue, secrets: readonly string[]): string {
  let nodes = 0;
  let textBudget = 48_000;

  function visit(item: JsonValue, depth: number): JsonValue {
    nodes += 1;

    if (nodes > 4_000 || depth > 20 || textBudget <= 0) return "[TRUNCATED]";

    if (isJsonString(item)) {
      // Providers commonly encode function arguments as JSON inside a string.
      // Redact its structured fields too, while preserving the string shape.
      if (/^[\s]*[[{]/.test(item)) {
        if (item.length > 64_000) return "[TRUNCATED JSON]";
        const parsed = parseJson(item);

        if (
          parsed.kind === "valid" &&
          (isJsonObject(parsed.value) || Array.isArray(parsed.value))
        ) {
          return JSON.stringify(visit(parsed.value, depth + 1));
        }
      }

      const clean = redactText(item, secrets);
      const limit = Math.min(12_000, textBudget);
      const short = clean.length > limit ? `${clean.slice(0, limit)}[TRUNCATED]` : clean;
      textBudget -= short.length;

      return short;
    }

    if (Array.isArray(item)) return item.slice(0, 256).map((child) => visit(child, depth + 1));

    if (isJsonObject(item)) {
      const type = item["type"];

      if (item["thought"] === true) return "[OMITTED]";

      if (
        isJsonString(type) &&
        ["thinking", "reasoning", "image", "input_image", "output_image"].includes(type)
      )
        return "[OMITTED]";
      const pairs: [string, JsonValue][] = [];

      for (const [key, child] of Object.entries(item).slice(0, 256)) {
        if (child === undefined) continue;
        pairs.push([
          redactText(key, secrets),
          sensitiveKey.test(key)
            ? "[REDACTED]"
            : omittedKey.test(key)
              ? "[OMITTED]"
              : visit(child, depth + 1),
        ]);
      }

      return Object.fromEntries(pairs);
    }

    return item;
  }

  const encoded = JSON.stringify(visit(value, 0));

  return encoded.length <= 64_000 ? encoded : JSON.stringify("[TRUNCATED: payload exceeds 64 KB]");
}

export function assistantOutput(message: JsonObject): JsonValue {
  const calls: JsonValue[] = [];
  const content = message["content"];

  if (Array.isArray(content)) {
    for (const block of content) {
      if (!isJsonObject(block)) continue;

      if (block["type"] === "toolCall") {
        calls.push({
          id: block["id"] ?? "",
          type: "function",
          function: {
            name: block["name"] ?? "tool",
            arguments: JSON.stringify(block["arguments"] ?? {}),
          },
        });
      }
    }
  }

  return { role: "assistant", content: contentText(content), tool_calls: calls };
}

export function conversationInput(messages: readonly JsonObject[]): JsonValue {
  const conversation: JsonValue[] = [];

  for (const message of messages) {
    switch (message["role"]) {
      case "user":
        conversation.push({ role: "user", content: contentText(message["content"]) });
        break;
      case "assistant":
        conversation.push(assistantOutput(message));
        break;
      case "toolResult": {
        const callId = message["toolCallId"];

        if (isJsonString(callId)) conversation.push(toolOutput(callId, message));
        break;
      }
    }
  }

  return { messages: conversation };
}

export function finalReply(messages: readonly JsonObject[]): JsonValue | null {
  const message = messages.findLast((item) => item["role"] === "assistant");
  const stop = message?.["stopReason"];

  if (!message || (stop !== "stop" && stop !== "length")) return null;

  return { role: "assistant", content: contentText(message["content"]) };
}

export function toolOutput(id: string, result: JsonValue): JsonValue {
  const content = isJsonObject(result) ? result["content"] : result;

  return { role: "tool", tool_call_id: id, content: contentText(content) };
}

function contentText(content: JsonValue | undefined): string {
  const text: string[] = [];

  if (isJsonString(content)) text.push(content);

  if (Array.isArray(content)) {
    for (const block of content) {
      if (isJsonObject(block) && block["type"] === "text" && isJsonString(block["text"]))
        text.push(block["text"]);
    }
  }

  return text.join("\n");
}
