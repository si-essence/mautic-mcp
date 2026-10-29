import { CONNECTOR_NAME } from "./constants.js";
import type { Config } from "./config.js";
import { secretValues } from "./config.js";
import { TtlCache } from "./cache.js";
import { HttpClient, type AuthProvider } from "./http.js";
import { createLogger, type Logger } from "./log.js";
import { basicAuthProvider, OAuthTokenCache } from "./oauth.js";
import { SlidingWindowLimiter } from "./rate-limit.js";

export interface Runtime {
  config: Config;
  client: HttpClient;
  secrets: string[];
  logger: Logger;
  cacheTtlSec: number;
}

export interface RuntimeOverrides {
  fetchImpl?: typeof fetch;
  now?: () => number;
  logger?: Logger;
}

export function createRuntime(config: Config, overrides: RuntimeOverrides = {}): Runtime {
  const now = overrides.now ?? Date.now;
  const secrets = secretValues(config);
  const logger = overrides.logger ?? createLogger(secrets);
  const fetchImpl = overrides.fetchImpl ?? fetch;
  const auth = createAuthProvider(config, {
    fetchImpl,
    secrets,
    now,
    logger,
    timeoutMs: config.timeoutMs,
    userAgent: config.userAgent,
  });
  const client = new HttpClient({
    baseUrl: config.baseUrl,
    fetchImpl,
    timeoutMs: config.timeoutMs,
    secrets,
    cache: new TtlCache(now),
    limiter: new SlidingWindowLimiter(config.perMinute, 60_000, now),
    userAgent: config.userAgent,
    logger,
    auth,
    label: CONNECTOR_NAME,
  });
  return {
    config,
    client,
    secrets,
    logger,
    cacheTtlSec: config.cacheTtlSec,
  };
}

function createAuthProvider(
  config: Config,
  options: {
    fetchImpl: typeof fetch;
    secrets: string[];
    now: () => number;
    logger: Logger;
    timeoutMs: number;
    userAgent: string;
  },
): AuthProvider {
  if (config.auth.kind === "basic") {
    return basicAuthProvider(config.auth.header);
  }
  return new OAuthTokenCache({
    baseUrl: config.baseUrl,
    clientId: config.auth.clientId,
    clientSecret: config.auth.clientSecret,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    secrets: options.secrets,
    now: options.now,
    userAgent: options.userAgent,
    logger: options.logger,
    label: CONNECTOR_NAME,
  });
}
