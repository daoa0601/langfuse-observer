import { closeSync, existsSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
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
  writeNewFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  try {
    writeNewFile(extensionPath, `export { default } from ${JSON.stringify(source)};\n`);
  } catch (cause) {
    rmSync(configPath);
    throw cause;
  }
}

function writeNewFile(path: string, content: string): void {
  const file = openSync(path, "wx", 0o600);

  try {
    try {
      writeFileSync(file, content);
    } finally {
      closeSync(file);
    }
  } catch (cause) {
    rmSync(path);
    throw cause;
  }
}

if (import.meta.main) {
  try {
    install(join(homedir(), ".prime/agent"), fileURLToPath(new URL("../../.env", import.meta.url)));
    console.log(
      "Installed. Run /reload then /langfuse status in Prime Agent. Conversation-body capture is OFF.",
    );
  } catch {
    console.error(
      "Install failed. Check the observer .env, agent directory permissions, and existing Langfuse extension/config files.",
    );
    process.exitCode = 1;
  }
}
