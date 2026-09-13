import assert from "node:assert/strict";
import test from "node:test";
import { isJsonValue, parseJson } from "../src/json.ts";

test("accepts only values that can cross a JSON boundary", () => {
  assert.equal(isJsonValue({ prompt: "Be precise", tools: ["search"] }), true);
  assert.equal(isJsonValue(new Date("2026-09-10T12:00:00.000Z")), false);
  assert.equal(isJsonValue(new Map([["prompt", "hidden"]])), false);
});

test("returns a discriminated failure for invalid JSON text", () => {
  assert.deepEqual(parseJson('{"prompt":'), { kind: "invalid" });
});
