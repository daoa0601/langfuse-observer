import {
  createMessage,
  isSupportedContentBlock,
  MAX_MESSAGES,
  parseContent,
  parseMessage,
  parseMessages,
  parseResponsesItems,
  parseToolDeclarations,
} from "./agent-message-parser.ts";
import {
  boundedCount,
  createParseContext,
  type InspectionBudget,
  malformedIssue,
  parseRole,
} from "./agent-payload-parser.ts";
import type {
  AgentMessage,
  AgentPayloadSource,
  ExtractionIssue,
  PayloadOrigin,
  Recognizer,
  ToolDeclaration,
} from "./agent-payload-types.ts";
import { isJsonObject, isJsonString, type JsonObject } from "./json.ts";
import type { JsonValue } from "./observer-types.ts";
import {
  isPydanticAiMessage,
  isPydanticAiMessageArray,
  parsePydanticAiMessage,
  parsePydanticAiMessages,
  type PydanticAiMessage,
} from "./pydantic-ai-parser.ts";

export type RecognizedDocument = Readonly<{
  recognizer: Recognizer;
  messages: readonly AgentMessage[];
  tools: readonly ToolDeclaration[];
  issues: readonly ExtractionIssue[];
}>;

export function recognizeDocument(
  source: AgentPayloadSource,
  field: "input" | "output",
  value: JsonValue,
  decodedLayers: 0 | 1 | 2,
  budget: InspectionBudget,
): RecognizedDocument | null {
  if (Array.isArray(value)) {
    return recognizeArray(source, field, value, decodedLayers, budget);
  }

  if (!isJsonObject(value)) {
    return null;
  }

  if (isPydanticAiMessage(value)) {
    const placement =
      field === "output" && value.kind === "response" ? "output-reply" : "input-context";

    const recognizer = "pydantic-ai-messages";
    const context = createParseContext(source.origin, field, recognizer, decodedLayers, budget);
    const parsed = parsePydanticAiMessage(value, "", placement, context);

    return { recognizer, messages: parsed.messages, tools: [], issues: parsed.issues };
  }

  if (field === "output" && Array.isArray(value["choices"])) {
    return parseOpenAiChoices(source.origin, value["choices"], decodedLayers, budget);
  }

  if (field === "output" && isOpenAiResponsesOutput(value)) {
    return parseResponsesOutput(source.origin, value["output"], decodedLayers, budget);
  }

  if (field === "output" && isAnthropicResponse(value)) {
    return parseAnthropicResponse(source.origin, value, decodedLayers, budget);
  }

  if (field === "input" && isResponsesRequest(value)) {
    return parseResponsesRequest(source.origin, value, decodedLayers, budget);
  }

  if (field === "input" && isMessageEnvelope(value)) {
    return parseMessageRequest(source.origin, value, decodedLayers, budget);
  }

  if (field === "output" && canParseStandaloneAssistant(source, value)) {
    return parseStandaloneAssistant(source.origin, value, decodedLayers, budget);
  }

  return null;
}

function recognizeArray(
  source: AgentPayloadSource,
  field: "input" | "output",
  value: readonly JsonValue[],
  decodedLayers: 0 | 1 | 2,
  budget: InspectionBudget,
): RecognizedDocument | null {
  const first = value[0];

  if (isPydanticAiMessageArray(value)) {
    const placement = field === "input" ? "input-context" : "output-conversation";

    return parsePydanticDocument(source.origin, field, value, placement, decodedLayers, budget);
  }

  if (
    field === "output" &&
    source.origin.kind === "observation" &&
    source.origin.allowStandaloneAssistantOutput &&
    value.length === 1 &&
    isJsonObject(first) &&
    first["role"] === "assistant"
  ) {
    return parseStandaloneAssistant(source.origin, first, decodedLayers, budget, "/0");
  }

  if (field === "output" && canParseStandaloneAssistantArray(source, value)) {
    return parseStandaloneAssistantContent(source.origin, value, decodedLayers, budget);
  }

  if (field === "output" && isResponsesItemArray(value)) {
    return parseResponsesOutput(source.origin, value, decodedLayers, budget, "");
  }

  if (!isMessageArrayCandidate(value)) {
    return null;
  }

  const placement = field === "input" ? "input-context" : "output-conversation";
  const context = createParseContext(source.origin, field, "message-array", decodedLayers, budget);
  const parsed = parseMessages(value, "", placement, context);

  return {
    recognizer: "message-array",
    messages: parsed.messages,
    tools: [],
    issues: parsed.issues,
  };
}

function parsePydanticDocument(
  origin: PayloadOrigin,
  field: "input" | "output",
  value: readonly PydanticAiMessage[],
  placement: "input-context" | "output-conversation" | "output-reply",
  decodedLayers: 0 | 1 | 2,
  budget: InspectionBudget,
): RecognizedDocument {
  const recognizer = "pydantic-ai-messages";
  const context = createParseContext(origin, field, recognizer, decodedLayers, budget);
  const parsed = parsePydanticAiMessages(value, "", placement, context);

  return { recognizer, messages: parsed.messages, tools: [], issues: parsed.issues };
}

function parseMessageRequest(
  origin: PayloadOrigin,
  value: JsonObject,
  decodedLayers: 0 | 1 | 2,
  budget: InspectionBudget,
): RecognizedDocument {
  const recognizer = requestRecognizer(value);
  const context = createParseContext(origin, "input", recognizer, decodedLayers, budget);
  const messages = parseMessages(value["messages"], "/messages", "input-context", context);
  const tools = parseToolDeclarations(value["tools"], "/tools", context);
  const combinedMessages = [...messages.messages];
  const issues = [...messages.issues, ...tools.issues];

  if (recognizer === "anthropic-request" && value["system"] !== undefined) {
    const parts = parseContent(value["system"], "/system", context, issues);
    combinedMessages.unshift(createMessage("system", "input-context", parts, context, "/system"));
  }

  return { recognizer, messages: combinedMessages, tools: tools.tools, issues };
}

function parseResponsesRequest(
  origin: PayloadOrigin,
  value: JsonObject,
  decodedLayers: 0 | 1 | 2,
  budget: InspectionBudget,
): RecognizedDocument {
  const recognizer = "openai-responses-request";
  const context = createParseContext(origin, "input", recognizer, decodedLayers, budget);
  const messages: AgentMessage[] = [];
  const issues: ExtractionIssue[] = [];

  if (value["instructions"] !== undefined) {
    const parts = parseContent(value["instructions"], "/instructions", context, issues);
    messages.push(createMessage("system", "input-context", parts, context, "/instructions"));
  }

  const input = value["input"];

  if (isJsonString(input)) {
    const parts = parseContent(input, "/input", context, issues);
    messages.push(createMessage("user", "input-context", parts, context, "/input"));
  } else if (Array.isArray(input)) {
    const parsed = parseResponsesItems(input, "/input", "input-context", context);
    messages.push(...parsed.messages);
    issues.push(...parsed.issues);
  } else {
    issues.push(malformedIssue("/input", "Responses input must be text or an item array."));
  }

  const tools = parseToolDeclarations(value["tools"], "/tools", context);
  issues.push(...tools.issues);

  return { recognizer, messages, tools: tools.tools, issues };
}

function parseOpenAiChoices(
  origin: PayloadOrigin,
  choices: readonly JsonValue[],
  decodedLayers: 0 | 1 | 2,
  budget: InspectionBudget,
): RecognizedDocument {
  const recognizer = "openai-chat-response";
  const context = createParseContext(origin, "output", recognizer, decodedLayers, budget);
  const messages: AgentMessage[] = [];
  const issues: ExtractionIssue[] = [];

  const count = boundedCount(
    choices.length,
    MAX_MESSAGES,
    "/choices",
    "completion choices",
    issues,
  );

  for (let index = 0; index < count; index += 1) {
    const choice = choices[index];
    const pointer = `/choices/${index}`;

    if (!isJsonObject(choice) || !isJsonObject(choice["message"])) {
      issues.push(malformedIssue(pointer, "Choice does not contain a message."));
      continue;
    }

    const parsed = parseMessage(
      choice["message"],
      `${pointer}/message`,
      "output-reply",
      context,
      index + 1,
    );

    if (parsed.kind === "message") {
      messages.push(parsed.message);
      issues.push(...parsed.issues);
    } else if (parsed.kind === "issue") {
      issues.push(parsed.issue);
    }
  }

  return { recognizer, messages, tools: [], issues };
}

function parseResponsesOutput(
  origin: PayloadOrigin,
  output: JsonValue | undefined,
  decodedLayers: 0 | 1 | 2,
  budget: InspectionBudget,
  rootPointer = "/output",
): RecognizedDocument {
  const recognizer = "openai-responses-response";
  const context = createParseContext(origin, "output", recognizer, decodedLayers, budget);
  const parsed = parseResponsesItems(output, rootPointer, "output-reply", context);

  return { recognizer, messages: parsed.messages, tools: [], issues: parsed.issues };
}

function parseAnthropicResponse(
  origin: PayloadOrigin,
  value: JsonObject,
  decodedLayers: 0 | 1 | 2,
  budget: InspectionBudget,
): RecognizedDocument {
  const recognizer = "anthropic-response";
  const context = createParseContext(origin, "output", recognizer, decodedLayers, budget);
  const issues: ExtractionIssue[] = [];
  const parts = parseContent(value["content"], "/content", context, issues);
  const message = createMessage("assistant", "output-reply", parts, context, "");

  return { recognizer, messages: [message], tools: [], issues };
}

function parseStandaloneAssistant(
  origin: PayloadOrigin,
  value: JsonObject,
  decodedLayers: 0 | 1 | 2,
  budget: InspectionBudget,
  pointer = "",
): RecognizedDocument {
  const recognizer = "assistant-output";
  const context = createParseContext(origin, "output", recognizer, decodedLayers, budget);
  const parsed = parseMessage(value, pointer, "output-reply", context, null);

  if (parsed.kind === "message") {
    return { recognizer, messages: [parsed.message], tools: [], issues: parsed.issues };
  }

  return {
    recognizer,
    messages: [],
    tools: [],
    issues: parsed.kind === "issue" ? [parsed.issue] : [],
  };
}

function parseStandaloneAssistantContent(
  origin: PayloadOrigin,
  value: readonly JsonValue[],
  decodedLayers: 0 | 1 | 2,
  budget: InspectionBudget,
): RecognizedDocument {
  const recognizer = "assistant-output";
  const context = createParseContext(origin, "output", recognizer, decodedLayers, budget);
  const issues: ExtractionIssue[] = [];
  const parts = parseContent(value, "", context, issues);
  const message = createMessage("assistant", "output-reply", parts, context, "");

  return { recognizer, messages: [message], tools: [], issues };
}

function isMessageEnvelope(value: JsonObject): boolean {
  return Array.isArray(value["messages"]);
}

function isMessageArrayCandidate(value: readonly JsonValue[]): boolean {
  return value.some(isMessageLike);
}

function isMessageLike(value: JsonValue | undefined): boolean {
  return isJsonObject(value) && parseRole(value["role"]) !== null;
}

function isResponsesRequest(value: JsonObject): boolean {
  const input = value["input"];

  return (
    input !== undefined &&
    value["messages"] === undefined &&
    (value["instructions"] !== undefined ||
      value["object"] === "response.request" ||
      hasResponsesTool(value["tools"]) ||
      (Array.isArray(input) && isResponsesItemArray(input)))
  );
}

function isOpenAiResponsesOutput(value: JsonObject): boolean {
  return (
    Array.isArray(value["output"]) &&
    (value["object"] === "response" || isResponsesItemArray(value["output"]))
  );
}

function isResponsesItemArray(value: readonly JsonValue[]): boolean {
  return value.some(
    (item) => isJsonObject(item) && (item["type"] === "message" || isSupportedContentBlock(item)),
  );
}

function isAnthropicResponse(value: JsonObject): boolean {
  return (
    value["type"] === "message" && value["role"] === "assistant" && Array.isArray(value["content"])
  );
}

function requestRecognizer(value: JsonObject): Recognizer {
  if (value["system"] !== undefined || hasAnthropicTool(value["tools"])) {
    return "anthropic-request";
  }

  if (hasOpenAiTool(value["tools"])) {
    return "openai-chat-request";
  }

  return "messages-envelope";
}

function hasAnthropicTool(value: JsonValue | undefined): boolean {
  return (
    Array.isArray(value) &&
    value.some((tool) => isJsonObject(tool) && tool["input_schema"] !== undefined)
  );
}

function hasOpenAiTool(value: JsonValue | undefined): boolean {
  return (
    Array.isArray(value) &&
    value.some((tool) => isJsonObject(tool) && isJsonObject(tool["function"]))
  );
}

function hasResponsesTool(value: JsonValue | undefined): boolean {
  return (
    Array.isArray(value) &&
    value.some(
      (tool) => isJsonObject(tool) && tool["type"] === "function" && isJsonString(tool["name"]),
    )
  );
}

function canParseStandaloneAssistant(source: AgentPayloadSource, value: JsonObject): boolean {
  return (
    source.origin.kind === "observation" &&
    source.origin.allowStandaloneAssistantOutput &&
    value["role"] === "assistant"
  );
}

function canParseStandaloneAssistantArray(
  source: AgentPayloadSource,
  value: readonly JsonValue[],
): boolean {
  if (
    source.origin.kind !== "observation" ||
    !source.origin.allowStandaloneAssistantOutput ||
    value.length === 0
  ) {
    return false;
  }

  return value.every((part) => isSupportedContentBlock(part) && part["role"] === undefined);
}
