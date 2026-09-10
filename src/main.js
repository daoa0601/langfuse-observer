import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { createLangfuseObserver } from "./langfuse.js";
import { createRequestHandler } from "./server.js";

const config = loadConfig(process.env);
const observer = createLangfuseObserver(config);
const server = createServer(createRequestHandler({ observer }));

server.listen(config.port, config.host, () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  console.log(`Langfuse Observer is running at http://${config.host}:${port}`);
});

server.on("error", (error) => {
  console.error("Langfuse Observer could not start", error);
  process.exitCode = 1;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}
