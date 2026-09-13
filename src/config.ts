import type { ApiVersionChoice, LangfuseConfig } from "./observer-types.ts";

const REQUIRED_VARIABLES = ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL"];

export function loadConfig(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<LangfuseConfig> {
  const missing = REQUIRED_VARIABLES.filter((name) => !env[name]?.trim());

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  const publicKey = readRequiredVariable(env, "LANGFUSE_PUBLIC_KEY");
  const secretKey = readRequiredVariable(env, "LANGFUSE_SECRET_KEY");
  const baseUrl = parseBaseUrl(readRequiredVariable(env, "LANGFUSE_BASE_URL"));
  const port = parsePort(env["PORT"]);

  return Object.freeze({
    apiVersion: parseApiVersion(env["LANGFUSE_API_VERSION"]),
    baseUrl,
    publicKey,
    secretKey,
    host: "127.0.0.1",
    port,
  });
}

function readRequiredVariable(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function parseApiVersion(value: string | undefined): ApiVersionChoice {
  const apiVersion = value?.trim().toLowerCase() || "auto";

  switch (apiVersion) {
    case "auto":
    case "v3":
    case "v4":
      return apiVersion;
    default:
      throw new Error("LANGFUSE_API_VERSION must be auto, v3, or v4");
  }
}

function parseBaseUrl(value: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch (cause) {
    throw new Error("LANGFUSE_BASE_URL must be a valid URL", { cause });
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("LANGFUSE_BASE_URL must use http or https");
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new Error("LANGFUSE_BASE_URL must not contain credentials, a query, or a fragment");
  }

  if (url.pathname !== "/") {
    throw new Error("LANGFUSE_BASE_URL must be the deployment origin without an API path");
  }

  return url;
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") {
    return 3000;
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("PORT must be an integer from 0 to 65535");
  }

  return port;
}
