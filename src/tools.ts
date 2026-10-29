import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodObject, type ZodRawShape } from "zod";
import type { ToolDescription, ToolName } from "./brand.js";
import { ConnectorError, errorPrefix } from "./errors.js";
import type { Logger } from "./log.js";
import { redact, redactRecord } from "./redact.js";

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
  idempotentHint?: boolean;
}

export const READ_ONLY_REMOTE: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
};

export const WRITE_IDEMPOTENT: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
  idempotentHint: true,
};

export const WRITE_NON_IDEMPOTENT: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
  idempotentHint: false,
};

export const WRITE_DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
  idempotentHint: true,
};

export interface ToolContext {
  secrets: readonly string[];
  logger: Logger;
}

export interface ToolSpec<Shape extends ZodRawShape> {
  name: ToolName;
  description: ToolDescription;
  inputSchema: ZodObject<Shape>;
  annotations: ToolAnnotations;
  handler: (args: z.output<ZodObject<Shape>>) => Promise<Record<string, unknown>>;
}

export function assertToolSpec(spec: {
  name: string;
  description: string;
  inputSchema: unknown;
}): void {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(spec.name)) {
    throw new ConnectorError("config", "Tool name must match ^[a-z][a-z0-9_]{0,63}$.");
  }
  if (spec.description.trim().length === 0) {
    throw new ConnectorError("config", `Tool ${spec.name} must have a non-empty description.`);
  }
  if (!(spec.inputSchema instanceof z.ZodObject)) {
    throw new ConnectorError("config", `Tool ${spec.name} must declare a Zod object schema.`);
  }
}

export function registerConnectorTool<Shape extends ZodRawShape>(
  server: McpServer,
  spec: ToolSpec<Shape>,
  ctx: ToolContext,
): void {
  assertToolSpec(spec);
  const annotations = toAnnotations(spec.annotations);
  server.registerTool<z.ZodRawShape, typeof spec.inputSchema>(
    spec.name,
    {
      description: spec.description,
      inputSchema: spec.inputSchema,
      annotations,
    },
    async (args): Promise<CallToolResult> => {
      try {
        const parsed = spec.inputSchema.parse(args);
        const result = redactRecord(await spec.handler(parsed), ctx.secrets);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
          isError: false,
        };
      } catch (error) {
        const text = toPublicMessage(error, ctx.secrets);
        ctx.logger.error(`tool ${spec.name} failed: ${text}`);
        return {
          isError: true,
          content: [{ type: "text", text }],
        };
      }
    },
  );
}

export function toPublicMessage(error: unknown, secrets: readonly string[]): string {
  if (error instanceof ConnectorError) {
    return redact(`${errorPrefix(error.code)}${error.message}`, secrets);
  }
  if (error instanceof z.ZodError) {
    const fields = error.issues
      .map((issue) => (issue.path.length === 0 ? issue.code : issue.path.map(String).join(".")))
      .join(", ");
    return redact(`[input] Invalid input (${fields}).`, secrets);
  }
  if (error instanceof Error) {
    return redact(`[upstream] ${error.message}`, secrets);
  }
  return "[upstream] Unexpected error.";
}

function toAnnotations(annotations: ToolAnnotations): ToolAnnotations {
  const out: ToolAnnotations = {
    readOnlyHint: annotations.readOnlyHint,
    destructiveHint: annotations.destructiveHint,
    openWorldHint: annotations.openWorldHint,
  };
  if (annotations.idempotentHint !== undefined) {
    out.idempotentHint = annotations.idempotentHint;
  }
  return out;
}
