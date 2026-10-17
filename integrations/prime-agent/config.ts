import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { parseEnv } from "node:util";
import { isJsonObject, isJsonString, parseJson, type JsonObject } from "../../src/json.ts";
import type { TraceConfig } from "./transport.ts";

export interface Settings {
  configPath: string;
  transport: TraceConfig;
  enabled: boolean;
  captureBodies: boolean;
}

export function readSettings(
  path = process.env["PRIME_AGENT_LANGFUSE_CONFIG"] ??
    join(homedir(), ".prime/agent/langfuse.json"),
): Settings | null {
  try {
    const parsed = parseJson(readFileSync(path, "utf8"));

    if (parsed.kind !== "valid" || !isJsonObject(parsed.value)) return null;
    const config = parsed.value;
    const envFile = config["envFile"];

    if (!isJsonString(envFile) || !isAbsolute(envFile)) return null;
    const env = parseEnv(readFileSync(envFile, "utf8"));
    const baseUrl = env["LANGFUSE_BASE_URL"];
    const publicKey = env["LANGFUSE_PUBLIC_KEY"];
    const secretKey = env["LANGFUSE_SECRET_KEY"];

    if (!baseUrl || !publicKey || !secretKey) return null;
    const environment = config["environment"];

    return {
      configPath: path,
      transport: {
        baseUrl,
        publicKey,
        secretKey,
        environment: isJsonString(environment) ? environment : "prime-agent",
      },
      enabled: config["enabled"] === true,
      captureBodies: config["captureBodies"] === true,
    };
  } catch {
    // Config and credential paths/contents must never enter logs or telemetry.
    return null;
  }
}

export function readTracingEnabled(path: string): boolean {
  try {
    return readConfig(path)["enabled"] === true;
  } catch {
    return false;
  }
}

export function setTracingEnabled(path: string, enabled: boolean): void {
  const config = readConfig(path);
  writeFileSync(path, `${JSON.stringify({ ...config, enabled }, null, 2)}\n`, { mode: 0o600 });
}

function readConfig(path: string): JsonObject {
  const parsed = parseJson(readFileSync(path, "utf8"));

  if (parsed.kind !== "valid" || !isJsonObject(parsed.value))
    throw new Error("Invalid Langfuse settings");

  return parsed.value;
}
