import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings } from "./config.ts";
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
});
