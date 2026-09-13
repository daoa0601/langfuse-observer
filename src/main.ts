import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig } from "./config.ts";
import { createLangfuseObserver } from "./langfuse.ts";
import { createRequestHandler } from "./server.ts";

const config = loadConfig(process.env);

const observer = createLangfuseObserver(config);

const server = createServer(createRequestHandler({ observer }));

server.listen(config.port, config.host, () => {
  const address = server.address();

  if (!isTcpAddress(address)) {
    console.error("Langfuse Observer started without a TCP address");
    process.exitCode = 1;
    server.close();

    return;
  }

  console.log(`Langfuse Observer is running at http://${config.host}:${address.port}`);
});

server.on("error", (error) => {
  console.error("Langfuse Observer could not start", error);
  process.exitCode = 1;
});

const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

for (const signal of SHUTDOWN_SIGNALS) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}

function isTcpAddress(address: AddressInfo | string | null): address is AddressInfo {
  return address !== null && typeof address !== "string";
}
