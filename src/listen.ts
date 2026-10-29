import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CONNECTOR_NAME } from "./constants.js";
import { ConnectorError } from "./errors.js";
import type { Runtime } from "./runtime.js";
import { createServer } from "./server.js";

const MAX_HTTP_BODY = 1_000_000;

export function timingSafeEqualString(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    void timingSafeEqual(a, Buffer.from(a));
    return false;
  }
  return timingSafeEqual(a, b);
}

export function bearerMatches(header: string | undefined, token: string): boolean {
  if (header === undefined) return false;
  const prefix = "Bearer ";
  if (header.length < prefix.length) return false;
  if (header.slice(0, prefix.length).toLowerCase() !== "bearer ") return false;
  return timingSafeEqualString(header.slice(prefix.length), token);
}

export function startHttpServer(runtime: Runtime): Promise<{ server: Server; port: number }> {
  const http = createHttpServer((req, res) => {
    void handleHttp(runtime, req, res);
  });
  http.on("error", (error: Error) => {
    runtime.logger.error(error.message);
  });
  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(runtime.config.port, runtime.config.httpHost, () => {
      http.off("error", reject);
      const address = http.address();
      const port =
        address !== null && typeof address === "object" ? address.port : runtime.config.port;
      runtime.logger.info(
        `${CONNECTOR_NAME} HTTP on ${runtime.config.httpHost}:${port}/mcp`,
      );
      resolve({ server: http, port });
    });
  });
}

export async function handleHttp(
  active: Runtime,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const path = pathOnly(req.url);
    if (path === "/health") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }
    if (path !== "/mcp") {
      res.writeHead(404);
      res.end();
      return;
    }
    const token = active.config.httpAuthToken;
    if (token !== undefined) {
      const header = headerValue(req.headers.authorization);
      if (!bearerMatches(header, token)) {
        res.writeHead(401, {
          "content-type": "text/plain; charset=utf-8",
          "www-authenticate": "Bearer",
        });
        res.end("unauthorized");
        return;
      }
    }
    const raw = await readRequestBody(req);
    const body = raw.trim().length === 0 ? undefined : parseRequestJson(raw);
    const mcp = createServer(active);
    const transport = new StreamableHTTPServerTransport();
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(asTransport(transport));
    await transport.handleRequest(req, res, body);
  } catch (error) {
    active.logger.error(error instanceof ConnectorError ? error.message : "request failed");
    if (res.headersSent) return;
    const tooLarge = error instanceof ConnectorError && error.message.includes("too large");
    res.writeHead(tooLarge ? 413 : 400, { "content-type": "text/plain; charset=utf-8" });
    res.end(tooLarge ? "payload too large" : "bad request");
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[0];
  return value;
}

function asTransport(transport: StreamableHTTPServerTransport): Transport {
  return transport as Transport;
}

function pathOnly(url: string | undefined): string {
  if (url === undefined || url.length === 0) return "/";
  const query = url.indexOf("?");
  const path = query === -1 ? url : url.slice(0, query);
  if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
  return path.length === 0 ? "/" : path;
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  const stream: AsyncIterable<unknown> = req;
  for await (const chunk of stream) {
    const buffer = toBuffer(chunk);
    size += buffer.length;
    if (size > MAX_HTTP_BODY) {
      throw new ConnectorError("input", "Request body was too large.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function toBuffer(chunk: unknown): Buffer {
  if (typeof chunk === "string") return Buffer.from(chunk);
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  throw new ConnectorError("input", "Request body was not valid.");
}

function parseRequestJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ConnectorError("input", "Request body was not valid JSON.");
  }
}
