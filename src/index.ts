#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { ConnectorError } from "./errors.js";
import { startHttpServer } from "./listen.js";
import { createLogger } from "./log.js";
import { createRuntime, type Runtime } from "./runtime.js";
import { createServer } from "./server.js";

function failStartup(error: unknown): never {
  const logger = createLogger([]);
  logger.error(error instanceof ConnectorError ? error.message : "Startup failed.");
  process.exit(1);
}

let runtime: Runtime;
try {
  runtime = createRuntime(loadConfig(process.env, process.argv));
} catch (error) {
  failStartup(error);
}

if (runtime.config.transport === "http") {
  try {
    await startHttpServer(runtime);
  } catch (error) {
    failStartup(error);
  }
} else {
  await createServer(runtime).connect(new StdioServerTransport());
}
