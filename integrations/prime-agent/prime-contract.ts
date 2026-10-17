import type { JsonValue, JsonObject } from "../../src/json.ts";

// The installed standalone CLI supplies these objects. Keep this structural
// subset aligned with Prime Agent 0.9.5 docs/extensions.md; no runtime import
// of the inherited pi npm package is needed.
export interface PrimeContext {
  sessionManager: { getSessionId(): string };
  model?: { id: string; provider: string };
  ui: { notify(message: string, level: "info" | "warning" | "error"): void };
  setInterval(callback: () => void | Promise<void>, milliseconds: number): object | number;
}

export interface PrimeEvents {
  session_start: { reason: string };
  session_shutdown: { reason: string };
  agent_start: { type: string };
  before_agent_start: { prompt: string };
  agent_end: { messages: readonly JsonObject[] };
  context: { messages: readonly JsonObject[] };
  before_provider_request: { payload: JsonValue };
  message_start: { message: JsonObject };
  message_end: { message: JsonObject };
  tool_execution_start: { toolCallId: string; toolName: string; args: JsonValue };
  tool_execution_end: { toolCallId: string; toolName: string; result: JsonValue; isError: boolean };
}

export interface PrimeExtensionAPI {
  on<K extends keyof PrimeEvents>(
    event: K,
    handler: (event: PrimeEvents[K], ctx: PrimeContext) => void | Promise<void>,
  ): void;
  registerCommand(
    name: string,
    options: {
      description: string;
      handler: (args: string, ctx: PrimeContext) => Promise<void>;
    },
  ): void;
}
