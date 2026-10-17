import { describe, expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJson } from "../../src/json.ts";
import { readSettings, readTracingEnabled, setTracingEnabled } from "./config.ts";
import { install } from "./install.ts";

describe("extension installation and credentials", () => {
  test("installs a secret-free wrapper, keeps bodies off, and refuses overwrite", () => {
    const dir = mkdtempSync(join(tmpdir(), "prime-langfuse-test-"));

    try {
      const envFile = join(dir, ".env");
      writeFileSync(
        envFile,
        'LANGFUSE_BASE_URL="https://example.invalid"\nLANGFUSE_PUBLIC_KEY=pk-test\nLANGFUSE_SECRET_KEY="sk-test-only"\n',
      );
      const home = join(dir, "agent");
      install(home, envFile);
      const configPath = join(home, "langfuse.json");
      expect(readSettings(configPath)).toEqual({
        configPath,
        enabled: true,
        captureBodies: false,
        transport: {
          baseUrl: "https://example.invalid",
          publicKey: "pk-test",
          secretKey: "sk-test-only",
          environment: "prime-agent",
        },
      });
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(configPath, "utf8")).not.toContain("sk-test-only");
      expect(readFileSync(join(home, "extensions/langfuse.ts"), "utf8")).toContain("index.ts");
      expect(() => install(home, envFile)).toThrow("Nothing overwritten");
      expect(readTracingEnabled(configPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failed wrapper install removes its new config and permits a retry", () => {
    const dir = mkdtempSync(join(tmpdir(), "prime-langfuse-test-"));

    try {
      const envFile = join(dir, "credentials.env");
      writeFileSync(envFile, "");
      const home = join(dir, "agent");
      const configPath = join(home, "langfuse.json");
      const extensionPath = join(home, "extensions", "langfuse.ts");
      mkdirSync(join(home, "extensions"), { recursive: true });
      // A dangling link passes the existence check but blocks exclusive creation.
      symlinkSync(join(dir, "missing.ts"), extensionPath);

      expect(() => install(home, envFile)).toThrow("EEXIST");
      expect(existsSync(configPath)).toBe(false);
      expect(lstatSync(extensionPath).isSymbolicLink()).toBe(true);

      rmSync(extensionPath);
      install(home, envFile);

      expect(readTracingEnabled(configPath)).toBe(true);
      expect(statSync(extensionPath).isFile()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("missing, malformed, and relative credential file configurations fail closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "prime-langfuse-test-"));

    try {
      const config = join(dir, "config.json");
      expect(readSettings(config)).toBeNull();
      writeFileSync(config, "not-json");
      expect(readSettings(config)).toBeNull();
      writeFileSync(config, '{"envFile":"relative.env","enabled":true}');
      expect(readSettings(config)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tracing changes preserve complete settings for an already-open reader", () => {
    const dir = mkdtempSync(join(tmpdir(), "prime-langfuse-test-"));

    try {
      const configPath = join(dir, "langfuse.json");
      writeFileSync(configPath, JSON.stringify({ enabled: true, captureBodies: false }), {
        mode: 0o600,
      });
      const reader = openSync(configPath, "r");

      try {
        setTracingEnabled(configPath, false);

        expect(readTracingEnabled(configPath)).toBe(false);
        expect(parseJson(readFileSync(reader, "utf8"))).toMatchObject({
          kind: "valid",
          value: { enabled: true, captureBodies: false },
        });
        expect(parseJson(readFileSync(configPath, "utf8"))).toMatchObject({
          kind: "valid",
          value: { enabled: false, captureBodies: false },
        });
        expect(statSync(configPath).mode & 0o777).toBe(0o600);
      } finally {
        closeSync(reader);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
