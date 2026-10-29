export const CONNECTOR_ERROR_CODES = [
  "config",
  "input",
  "auth",
  "not_found",
  "rate_limit",
  "upstream",
  "timeout",
] as const;

export type ConnectorErrorCode = (typeof CONNECTOR_ERROR_CODES)[number];

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  readonly retryAfterSeconds: number | null;

  constructor(code: ConnectorErrorCode, message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "ConnectorError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function errorPrefix(code: ConnectorErrorCode): string {
  switch (code) {
    case "config":
      return "[config] ";
    case "input":
      return "[input] ";
    case "auth":
      return "[auth] ";
    case "not_found":
      return "[not-found] ";
    case "rate_limit":
      return "[rate-limit] ";
    case "upstream":
      return "[upstream] ";
    case "timeout":
      return "[timeout] ";
    default: {
      const neverCode: never = code;
      return neverCode;
    }
  }
}
