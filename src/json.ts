export type JsonObject = { readonly [key: string]: JsonValue };

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;

export type JsonParseResult =
  | Readonly<{ kind: "valid"; value: JsonValue }>
  | Readonly<{ kind: "invalid" }>;

export function parseJson(text: string): JsonParseResult {
  try {
    const value: unknown = JSON.parse(text);

    return isJsonValue(value) ? { kind: "valid", value } : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

export function isJsonValue(value: unknown): value is JsonValue {
  const pending: unknown[] = [value];

  while (pending.length > 0) {
    const current = pending.pop();

    if (
      current === null ||
      typeof current === "boolean" ||
      typeof current === "string" ||
      (typeof current === "number" && Number.isFinite(current))
    ) {
      continue;
    }

    if (Array.isArray(current)) {
      for (const item of current) {
        pending.push(item);
      }

      continue;
    }

    if (typeof current !== "object") {
      return false;
    }

    const prototype = Object.getPrototypeOf(current);

    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }

    for (const item of Object.values(current)) {
      pending.push(item);
    }
  }

  return true;
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonString(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

export function isJsonNumber(value: JsonValue | undefined): value is number {
  return typeof value === "number";
}

export function isJsonBoolean(value: JsonValue | undefined): value is boolean {
  return typeof value === "boolean";
}
