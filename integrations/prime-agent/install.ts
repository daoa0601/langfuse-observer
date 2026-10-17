import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function install(agentDirectory: string, envFile: string): void {
  const extensionPath = join(agentDirectory, "extensions", "langfuse.ts");
  const configPath = join(agentDirectory, "langfuse.json");

  if (!existsSync(envFile)) throw new Error("The observer .env file does not exist.");

  if (existsSync(extensionPath) || existsSync(configPath))
    throw new Error(
      "Langfuse extension/config already exists; inspect it before updating. Nothing overwritten.",
    );
  mkdirSync(dirname(extensionPath), { recursive: true, mode: 0o700 });

  const config = {
    envFile: resolve(envFile),
    enabled: true,
    captureBodies: false,
    environment: "prime-agent",
  };

  const source = fileURLToPath(new URL("./index.ts", import.meta.url));
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  writeFileSync(extensionPath, `export { default } from ${JSON.stringify(source)};\n`, {
    flag: "wx",
    mode: 0o600,
  });
  chmodSync(configPath, 0o600);
}

if (import.meta.main) {
  try {
    install(join(homedir(), ".prime/agent"), fileURLToPath(new URL("../../.env", import.meta.url)));
    console.log(
      "Installed. Run /reload then /langfuse status in Prime Agent. Conversation-body capture is OFF.",
    );
  } catch {
    console.error(
      "Install stopped. Check that .env exists and ~/.prime/agent/langfuse.json and extensions/langfuse.ts do not already exist. No files are overwritten.",
    );
    process.exitCode = 1;
  }
}
