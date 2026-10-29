import { ConnectorError } from "./errors.js";

declare const secretBrand: unique symbol;
declare const baseUrlBrand: unique symbol;
declare const toolNameBrand: unique symbol;
declare const toolDescriptionBrand: unique symbol;

/** API key or other credential. Construct only after env validation. */
export type Secret = string & { readonly [secretBrand]: "Secret" };

/** Absolute http(s) base URL with no userinfo, query, or hash. */
export type BaseUrl = string & { readonly [baseUrlBrand]: "BaseUrl" };

/** MCP tool name. Lowercase snake case, minted by `toolName`. */
export type ToolName = string & { readonly [toolNameBrand]: "ToolName" };

/** Non-empty tool description, minted by `toolDescription`. */
export type ToolDescription = string & { readonly [toolDescriptionBrand]: "ToolDescription" };

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export function brandSecret(value: string): Secret {
  return value as Secret;
}

export function brandBaseUrl(value: string): BaseUrl {
  return value as BaseUrl;
}

export function toolName(value: string): ToolName {
  if (!TOOL_NAME.test(value)) {
    throw new ConnectorError("config", "Tool name must match ^[a-z][a-z0-9_]{0,63}$.");
  }
  return value as ToolName;
}

export function toolDescription(value: string): ToolDescription {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ConnectorError("config", "Tool description must be a non-empty string.");
  }
  return trimmed as ToolDescription;
}
