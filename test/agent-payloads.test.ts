import assert from "node:assert/strict";
import test from "node:test";
import {
  type AgentPayloadSource,
  type ContentPart,
  inspectAgentPayloads,
  isPromptMessage,
  type PayloadSourceRole,
} from "../src/agent-payloads.ts";
import type { JsonValue } from "../src/observer-types.ts";

test("extracts prompts, tools, input context, and the reply from one model turn", () => {
  const report = inspectAgentPayloads([
    modelTurn({
      input: JSON.stringify({
        model: "gpt-test",
        messages: [
          { role: "system", content: "Follow the store policy." },
          { role: "developer", content: "Return concise answers." },
          { role: "user", content: "Buy milk." },
          { role: "assistant", content: "I will check the catalog." },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "search_catalog",
              description: "Search the store catalog",
              parameters: { type: "object", properties: { query: { type: "string" } } },
            },
          },
        ],
      }),
      output: "Milk is available.",
    }),
  ]);

  assert.equal(report.coverage, "complete");
  assert.equal(report.turns.length, 1);
  const turn = itemAt(report.turns, 0);

  if (turn.kind === "unrecognized") {
    throw new Error("Expected parsed turn findings");
  }

  assert.equal(turn.kind, "recognized");
  assert.deepEqual(
    turn.prompts.map((prompt) => [prompt.role, textOf(prompt.parts)]),
    [
      ["system", "Follow the store policy."],
      ["developer", "Return concise answers."],
    ],
  );
  assert.deepEqual(
    turn.inputContext.map((message) => message.role),
    ["user", "assistant"],
  );
  assert.equal(turn.tools.length, 1);
  assert.equal(itemAt(turn.tools, 0).name.text, "search_catalog");
  assert.match(itemAt(turn.tools, 0).parameters?.text ?? "", /"query"/);
  assert.equal(turn.replies.length, 1);
  assert.equal(textOf(itemAt(turn.replies, 0).parts), "Milk is available.");
  assert.equal(itemAt(turn.prompts, 0).evidence.pointer, "/messages/0");
});

test("parses structured JSON without serializing it through a string contract", () => {
  const report = inspectAgentPayloads([
    modelTurn({
      input: {
        messages: [
          { role: "system", content: "Keep the original JSON shape." },
          { role: "user", content: "Continue." },
        ],
      },
    }),
  ]);

  const turn = itemAt(report.turns, 0);
  assert.notEqual(turn.kind, "unrecognized");

  if (turn.kind === "unrecognized") {
    throw new Error("Expected structured JSON to parse");
  }

  assert.equal(itemAt(turn.prompts, 0).evidence.decodedLayers, 0);
  assert.equal(textOf(itemAt(turn.inputContext, 0).parts), "Continue.");
});

test("keeps completion choices as alternatives in one turn", () => {
  const report = inspectAgentPayloads([
    modelTurn({
      input: JSON.stringify([{ role: "user", content: "Choose." }]),
      output: JSON.stringify({
        choices: [
          { message: { role: "assistant", content: "First answer" } },
          { message: { role: "assistant", content: "Second answer" } },
        ],
      }),
    }),
  ]);

  assert.equal(report.turns.length, 1);
  const turn = itemAt(report.turns, 0);
  assert.notEqual(turn.kind, "unrecognized");

  if (turn.kind === "unrecognized") {
    throw new Error("Expected parsed choices");
  }

  assert.deepEqual(
    turn.replies.map((message) => [message.alternative, textOf(message.parts)]),
    [
      [1, "First answer"],
      [2, "Second answer"],
    ],
  );
});

test("parses OpenAI Responses and Anthropic payloads", () => {
  const report = inspectAgentPayloads([
    modelTurn({
      id: "responses-turn",
      input: JSON.stringify({
        model: "gpt-test",
        instructions: "Use the available tools.",
        input: [
          { role: "user", content: [{ type: "input_text", text: "Find a shop." }] },
          { type: "function_call_output", call_id: "call-0", output: { matches: 2 } },
        ],
        tools: [{ type: "function", name: "find_shop", parameters: { type: "object" } }],
      }),
      output: JSON.stringify({
        object: "response",
        output: [
          { type: "function_call", call_id: "call-1", name: "find_shop", arguments: "{}" },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "I found one." }],
          },
        ],
      }),
    }),
    modelTurn({
      id: "anthropic-turn",
      startedAt: "2026-09-10T12:01:00.000Z",
      input: JSON.stringify({
        model: "claude-test",
        system: "Use metric units.",
        messages: [{ role: "user", content: "Measure the route." }],
        tools: [
          { name: "route", description: "Measure a route", input_schema: { type: "object" } },
        ],
      }),
      output: JSON.stringify({
        type: "message",
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-1", name: "route", input: { unit: "km" } }],
      }),
    }),
  ]);

  assert.equal(report.turns.length, 2);
  const responses = itemAt(report.turns, 0);
  const anthropic = itemAt(report.turns, 1);
  assert.notEqual(responses.kind, "unrecognized");
  assert.notEqual(anthropic.kind, "unrecognized");

  if (responses.kind === "unrecognized" || anthropic.kind === "unrecognized") {
    throw new Error("Expected both provider payloads to parse");
  }

  assert.equal(itemAt(responses.prompts, 0).evidence.recognizer, "openai-responses-request");
  assert.equal(itemAt(itemAt(responses.inputContext, 1).parts, 0).kind, "tool-result");
  assert.deepEqual(
    responses.replies.flatMap((message) => message.parts.map((part) => part.kind)),
    ["tool-call", "text"],
  );
  assert.equal(itemAt(anthropic.prompts, 0).evidence.recognizer, "anthropic-request");
  assert.equal(itemAt(anthropic.tools, 0).name.text, "route");
  assert.equal(itemAt(itemAt(anthropic.replies, 0).parts, 0).kind, "tool-call");
});

test("parses Pydantic AI model messages and their system prompt", () => {
  const report = inspectAgentPayloads([
    modelTurn({
      input: [
        {
          kind: "request",
          parts: [
            { part_kind: "system-prompt", content: "Follow the refund policy." },
            { part_kind: "user-prompt", content: "My parcel is broken." },
          ],
        },
        {
          kind: "response",
          parts: [
            {
              part_kind: "tool-call",
              tool_name: "lookup_order",
              args: { order_id: "42" },
              tool_call_id: "call-1",
            },
          ],
        },
        {
          kind: "request",
          parts: [
            {
              part_kind: "tool-return",
              tool_name: "lookup_order",
              content: { status: "damaged" },
              tool_call_id: "call-1",
            },
          ],
        },
      ],
      output: {
        kind: "response",
        parts: [{ part_kind: "text", content: "Please send a photo." }],
      },
    }),
  ]);

  const turn = itemAt(report.turns, 0);
  assert.notEqual(turn.kind, "unrecognized");

  if (turn.kind === "unrecognized") {
    throw new Error("Expected Pydantic AI messages to parse");
  }

  assert.equal(report.coverage, "complete");
  assert.equal(textOf(itemAt(turn.prompts, 0).parts), "Follow the refund policy.");
  assert.deepEqual(
    turn.inputContext.flatMap((message) => message.parts.map((part) => part.kind)),
    ["text", "tool-call", "tool-result"],
  );
  assert.equal(textOf(itemAt(turn.replies, 0).parts), "Please send a photo.");
  assert.equal(itemAt(turn.replies, 0).evidence.pointer, "/parts/0");
  assert.equal(itemAt(turn.prompts, 0).evidence.recognizer, "pydantic-ai-messages");
});

test("parses Pydantic AI role messages whose text is stored in parts", () => {
  const report = inspectAgentPayloads([
    source({
      role: "agent-context",
      input: [
        { role: "system", content: "Use the account policy." },
        { role: "user", parts: [{ type: "text", content: "Cancel my account." }] },
        { role: "assistant", parts: [{ type: "text", content: "I need confirmation." }] },
      ],
    }),
  ]);

  const input = itemAt(report.contextSources, 0).input;
  assert.equal(input.kind, "recognized");
  assert.equal(report.coverage, "complete");
  assert.deepEqual(
    input.messages.map((message) => [message.role, textOf(message.parts)]),
    [
      ["system", "Use the account policy."],
      ["user", "Cancel my account."],
      ["assistant", "I need confirmation."],
    ],
  );
});

test("keeps Responses tool calls and results in input context", () => {
  const report = inspectAgentPayloads([
    modelTurn({
      input: {
        model: "gpt-test",
        input: [
          { role: "user", content: "Find a shop." },
          { type: "function_call", call_id: "call-1", name: "find_shop", arguments: "{}" },
          { type: "function_call_output", call_id: "call-1", output: { matches: 2 } },
        ],
      },
    }),
  ]);

  const turn = itemAt(report.turns, 0);
  assert.notEqual(turn.kind, "unrecognized");

  if (turn.kind === "unrecognized") {
    throw new Error("Expected Responses input to parse");
  }

  assert.deepEqual(
    turn.inputContext.flatMap((message) => message.parts.map((part) => part.kind)),
    ["text", "tool-call", "tool-result"],
  );
});

test("marks malformed tool_calls as a partial parse", () => {
  const report = inspectAgentPayloads([
    modelTurn({
      output: {
        role: "assistant",
        content: "Finished.",
        tool_calls: { function: { name: "search", arguments: "{}" } },
      },
    }),
  ]);

  const turn = itemAt(report.turns, 0);
  assert.equal(report.coverage, "partial");
  assert.equal(turn.kind, "partial");
});

test("marks unsupported content blocks as a partial parse", () => {
  const report = inspectAgentPayloads([
    modelTurn({
      output: {
        role: "assistant",
        content: [{ type: "billing_profile", value: "not an attachment" }],
      },
    }),
  ]);

  const turn = itemAt(report.turns, 0);
  assert.equal(report.coverage, "partial");
  assert.equal(turn.kind, "partial");
});

test("keeps the array index in standalone message evidence", () => {
  const report = inspectAgentPayloads([
    modelTurn({ output: [{ role: "assistant", content: "Answer." }] }),
  ]);

  const turn = itemAt(report.turns, 0);
  assert.notEqual(turn.kind, "unrecognized");

  if (turn.kind === "unrecognized") {
    throw new Error("Expected assistant message array to parse");
  }

  assert.equal(itemAt(turn.replies, 0).evidence.pointer, "/0");
});

test("keeps ordinary output message arrays as conversation snapshots", () => {
  const report = inspectAgentPayloads([
    modelTurn({
      output: [
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer" },
      ],
    }),
  ]);

  const output = itemAt(report.sources, 0).output;

  assert.deepEqual(
    output.messages.map((message) => message.placement),
    ["output-conversation", "output-conversation"],
  );
});

test("accepts a nullable tool_calls field", () => {
  const report = inspectAgentPayloads([
    modelTurn({ output: { role: "assistant", content: "Answer.", tool_calls: null } }),
  ]);

  assert.equal(report.coverage, "complete");
  assert.equal(itemAt(report.turns, 0).kind, "recognized");
});

test("reports a recognized malformed envelope as malformed rather than empty", () => {
  const report = inspectAgentPayloads([modelTurn({ input: { messages: [42] } })]);
  const turn = itemAt(report.turns, 0);

  assert.equal(report.coverage, "partial");
  assert.equal(turn.kind, "unrecognized");

  if (turn.kind !== "unrecognized") {
    throw new Error("Expected an unrecognized malformed turn");
  }

  assert.equal(turn.reason, "malformed");
});

test("enforces one trace-wide content part budget", () => {
  const report = inspectAgentPayloads([
    modelTurn({
      id: "first-turn",
      input: {
        messages: [{ role: "assistant", content: Array.from({ length: 1_001 }, () => "part") }],
      },
    }),
    modelTurn({
      id: "second-turn",
      startedAt: "2026-09-10T12:01:00.000Z",
      input: {
        messages: Array.from({ length: 500 }, () => ({ role: "user", content: "later" })),
      },
    }),
  ]);

  const first = itemAt(report.turns, 0);
  const second = itemAt(report.turns, 1);

  assert.equal(report.coverage, "partial");
  assert.equal(first.kind, "partial");
  assert.equal(second.kind, "unrecognized");

  assert.equal(second.reason, "limit");
  assert.ok(first.inputContext.flatMap((message) => message.parts).length <= 1_000);
});

test("marks unsupported primitive message content as partial", () => {
  const report = inspectAgentPayloads([modelTurn({ output: { role: "assistant", content: 42 } })]);

  assert.equal(report.coverage, "partial");
  assert.equal(itemAt(report.turns, 0).kind, "partial");
});

test("checks structured depth before serializing the payload", () => {
  let nested: JsonValue = "bottom";

  for (let depth = 0; depth < 100_000; depth += 1) {
    nested = { next: nested };
  }

  const report = inspectAgentPayloads([modelTurn({ input: nested })]);

  assert.equal(report.coverage, "partial");
  assert.equal(itemAt(report.turns, 0).kind, "unrecognized");
});

test("does not claim a provider from an ambiguous model field", () => {
  const messageReport = inspectAgentPayloads([
    modelTurn({
      input: { model: "custom-model", messages: [{ role: "user", content: "Hello" }] },
    }),
  ]);

  const messageInput = itemAt(messageReport.sources, 0).input;
  assert.equal(messageInput.kind, "recognized");

  if (messageInput.kind !== "recognized") {
    throw new Error("Expected the message envelope to parse");
  }

  assert.equal(messageInput.recognizer, "messages-envelope");

  const embeddingReport = inspectAgentPayloads([
    modelTurn({ input: { model: "embedding-model", input: "embed me" } }),
  ]);

  assert.equal(itemAt(embeddingReport.sources, 0).input.kind, "unrecognized-json");
});

test("records decoding when plain text came from a JSON string", () => {
  const report = inspectAgentPayloads([modelTurn({ output: JSON.stringify("hello") })]);
  const turn = itemAt(report.turns, 0);
  assert.notEqual(turn.kind, "unrecognized");

  if (turn.kind === "unrecognized") {
    throw new Error("Expected decoded plain text");
  }

  assert.equal(itemAt(turn.replies, 0).evidence.decodedLayers, 1);
});

test("does not discover message or tool keys below an unknown root", () => {
  const report = inspectAgentPayloads([
    source({
      role: "agent-context",
      input: JSON.stringify({
        metadata: {
          messages: [{ role: "system", content: "This is metadata, not a prompt." }],
        },
        schema: {
          tools: [{ name: "not_a_declared_tool", description: "Example data" }],
        },
      }),
    }),
  ]);

  assert.equal(report.turns.length, 0);
  assert.equal(report.contextSources.length, 0);
  assert.equal(itemAt(report.sources, 0).input.kind, "unrecognized-json");
});

test("preserves valid messages when a sibling is malformed", () => {
  const report = inspectAgentPayloads([
    modelTurn({
      input: JSON.stringify({
        messages: [
          { role: 42, content: "Bad sibling" },
          { role: "system", content: "Keep this prompt." },
          { role: "user", content: "Keep this request." },
        ],
      }),
    }),
  ]);

  const turn = itemAt(report.turns, 0);
  assert.equal(report.coverage, "partial");
  assert.equal(turn.kind, "partial");

  if (turn.kind !== "partial") {
    throw new Error("Expected a partial turn");
  }

  assert.deepEqual(
    turn.inputContext.map((message) => message.role),
    ["user"],
  );
  assert.match(itemAt(turn.issues, 0).message, /unsupported role/);
});

test("decodes one extra JSON document layer but never parses prompt contents", () => {
  const nestedPrompt = JSON.stringify({
    tools: [{ name: "text_only", description: "This must remain prompt text" }],
  });

  const encodedRequest = JSON.stringify(
    JSON.stringify({ messages: [{ role: "system", content: nestedPrompt }] }),
  );

  const report = inspectAgentPayloads([modelTurn({ input: encodedRequest })]);

  const turn = itemAt(report.turns, 0);
  assert.notEqual(turn.kind, "unrecognized");

  if (turn.kind === "unrecognized") {
    throw new Error("Expected the encoded request to parse");
  }

  assert.equal(turn.tools.length, 0);
  assert.equal(textOf(itemAt(turn.prompts, 0).parts), nestedPrompt);
  assert.equal(itemAt(turn.prompts, 0).evidence.decodedLayers, 2);
});

test("bounds deeply nested payloads without throwing or losing the turn", () => {
  let nested: JsonValue = "bottom";

  for (let depth = 0; depth < 45; depth += 1) {
    nested = { next: nested };
  }

  const report = inspectAgentPayloads([
    modelTurn({ input: JSON.stringify({ messages: [{ role: "user", content: nested }] }) }),
  ]);

  assert.equal(report.coverage, "partial");
  assert.deepEqual(report.turns, [
    {
      kind: "unrecognized",
      number: 1,
      observationId: "turn-1",
      startedAt: "2026-09-10T12:00:00.000Z",
      model: "test-model",
      reason: "limit",
    },
  ]);
  const analysis = itemAt(report.sources, 0).input;
  assert.equal(analysis.kind, "skipped");
});

test("counts multipart tool output once and preserves following messages", () => {
  const largeParts = Array.from({ length: 10 }, () => "x".repeat(20_000));

  const report = inspectAgentPayloads([
    modelTurn({
      input: {
        messages: [
          { role: "tool", tool_call_id: "call-1", content: largeParts },
          { role: "user", content: "Keep this message." },
        ],
      },
    }),
  ]);

  const turn = itemAt(report.turns, 0);
  assert.notEqual(turn.kind, "unrecognized");

  if (turn.kind === "unrecognized") {
    throw new Error("Expected tool context to parse");
  }

  assert.equal(textOf(itemAt(turn.inputContext, 1).parts), "Keep this message.");
});

test("truncated plain text makes report coverage partial", () => {
  const report = inspectAgentPayloads([modelTurn({ output: "x".repeat(20_001) })]);

  assert.equal(report.coverage, "partial");
  assert.equal(itemAt(report.turns, 0).kind, "partial");
});

test("trace-level context can expose a prompt without inventing a turn", () => {
  const report = inspectAgentPayloads([
    {
      origin: { kind: "trace-context" },
      input: JSON.stringify([{ role: "system", content: "Legacy trace prompt" }]),
      output: null,
    },
  ]);

  assert.equal(report.turns.length, 0);
  assert.equal(report.contextSources.length, 1);
  const input = itemAt(report.contextSources, 0).input;
  assert.equal(input.kind, "recognized");

  if (input.kind !== "recognized") {
    throw new Error("Expected recognized trace context");
  }

  assert.equal(
    textOf(itemAt(input.messages.filter(isPromptMessage), 0).parts),
    "Legacy trace prompt",
  );
});

function modelTurn(
  values: Readonly<{
    id?: string;
    startedAt?: string;
    input?: JsonValue;
    output?: JsonValue;
  }> = {},
): AgentPayloadSource {
  return {
    origin: {
      kind: "observation",
      observationId: values.id ?? "turn-1",
      label: "Agent generation",
      sourceRole: "model-turn",
      startedAt: values.startedAt ?? "2026-09-10T12:00:00.000Z",
      model: "test-model",
      allowStandaloneAssistantOutput: true,
    },
    input: values.input ?? null,
    output: values.output ?? null,
  };
}

function source(
  values: Readonly<{ role: PayloadSourceRole; input: JsonValue }>,
): AgentPayloadSource {
  return {
    origin: {
      kind: "observation",
      observationId: "context-1",
      label: "Agent context",
      sourceRole: values.role,
      startedAt: "2026-09-10T12:00:00.000Z",
      model: null,
      allowStandaloneAssistantOutput: false,
    },
    input: values.input,
    output: null,
  };
}

function textOf(parts: readonly ContentPart[]): string {
  return parts.flatMap((part) => (part.kind === "text" ? [part.value.text] : [])).join("\n");
}

function itemAt<Value>(values: readonly Value[], index: number): Value {
  const value = values[index];

  if (value === undefined) {
    throw new Error(`Expected item ${index}, received ${values.length} items`);
  }

  return value;
}
