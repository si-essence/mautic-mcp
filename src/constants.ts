export const CONNECTOR_NAME = "mautic-mcp";
export const CONNECTOR_VERSION = "0.1.0";

/** Default page size sent to Mautic when the tool omits `limit`. */
export const DEFAULT_PAGE_LIMIT = 30;

/** Default `MAUTIC_MAX_LIMIT` when the env var is unset. */
export const DEFAULT_MAX_LIMIT = 100;

/** Hard ceiling for `MAUTIC_MAX_LIMIT` and for the Zod `limit` field. */
export const HARD_MAX_LIMIT = 500;

/** Refresh an OAuth access token this many milliseconds before `expires_in`. */
export const TOKEN_REFRESH_SKEW_MS = 30_000;

export const DEFAULT_PER_MINUTE = 60;
export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_CACHE_TTL_SEC = 60;
export const DEFAULT_HTTP_HOST = "127.0.0.1";
export const MIN_HTTP_AUTH_TOKEN_LENGTH = 16;
